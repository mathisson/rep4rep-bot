import { app, BrowserWindow, ipcMain, shell, dialog, Notification, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    getApiToken, saveApiToken, hasApiToken, readSessions, writeSessions, logSteamError,
    readSettings, writeSettings, listStorage, removeStorage, CONFIG_DIR,
    readErrorLog, limitFor,
} from '../src/config.js';
import { Rep4Rep } from '../src/rep4rep.js';
import { steamLogin, postProfileComment } from '../src/steam.js';
import { runAccounts } from '../src/accounts.js';
import { Cancelled } from '../src/runner.js';
import { getUsage, allAccounts } from '../src/quota.js';
import { isDue, nextRun, dayKey, lastDayWhenSet, parseTime } from '../src/schedule.js';
import { checkForUpdate } from '../src/update.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, '..', 'build', 'icon.ico');

// Started by Windows at sign-in: live in the tray, open no window.
const launchedHidden = process.argv.includes('--hidden');

let win = null;
let tray = null;
let quitting = false;
let toldAboutTray = false;
let update = null;  // { version, url } once GitHub reports a newer release
let current = null; // { cancel } while a run is in flight

const send = payload => win?.webContents.send('event', { ...payload, at: Date.now() });
const log = (kind, text) => send({ type: 'log', kind, text });

/* ------------------------------------------------------------------ */
/* asking the window a question and waiting for the answer             */
/* ------------------------------------------------------------------ */

const pending = new Map();
let askSeq = 0;

/** Matches the `ask` contract steamLogin expects, but routed through the UI. */
function askWindow({ type, message, initial }) {
    const id = ++askSeq;
    send({ type: 'ask', id, kind: type, message, initial });
    return new Promise(resolve => {
        pending.set(id, resolve);
        // A closed window must not leave steamLogin hanging until its timeout.
        win?.once('closed', () => { pending.delete(id); resolve(null); });
    });
}

ipcMain.handle('answer', (_e, { id, value }) => {
    const resolve = pending.get(id);
    if (resolve) { pending.delete(id); resolve(value); }
    return true;
});

/** sleep that rejects the moment the run is cancelled, so Stop is immediate. */
const cancellableSleep = isCancelled => ms => new Promise((resolve, reject) => {
    if (isCancelled()) return reject(new Cancelled());
    const tick = setInterval(() => {
        if (isCancelled()) { clearInterval(tick); clearTimeout(timer); reject(new Cancelled()); }
    }, 250);
    const timer = setTimeout(() => { clearInterval(tick); resolve(); }, ms);
});

/**
 * A full run takes minutes, and longer while waiting out a cooldown, so it is
 * usually finishing while you are looking at something else. Nothing is shown
 * if the window is already in front -- the tally is right there.
 */
function notifyFinished({ done, failed, accounts }) {
    if (!Notification.isSupported() || win?.isFocused()) return;

    const body = [
        `${done} comment${done === 1 ? '' : 's'} posted`,
        failed ? `${failed} failed` : null,
        accounts > 1 ? `across ${accounts} accounts` : null,
    ].filter(Boolean).join(' · ');

    notify('Rep4Rep — run finished', body);
}

function notify(title, body) {
    if (!Notification.isSupported()) return;
    const note = new Notification({ title, body, icon: ICON });
    note.on('click', showWindow);
    note.show();
}

/* ------------------------------------------------------------------ */
/* the run, shared with the CLI                                        */
/* ------------------------------------------------------------------ */

async function startRun(opts) {
    let cancelled = false;
    current = { cancel: () => { cancelled = true; } };
    send({ type: 'status', running: true });
    refreshTray();

    const sleep = cancellableSleep(() => cancelled);

    try {
        const sessions = readSessions();
        const names = (opts.accounts?.length ? opts.accounts : Object.keys(sessions))
            .filter(n => sessions[n]);

        const total = await runAccounts({
            accounts: names,
            login: name => steamLogin({ account: name }),
            post: (session, target, text) => postProfileComment(session.community, target, text),
            r4r: new Rep4Rep(getApiToken()),
            ui: {
                say: m => log('plain', m),
                ok: m => log('ok', m),
                bad: m => log('bad', m),
                note: m => log('note', m),
                account: ({ name, profile }) => profile
                    ? send({ type: 'account', name, persona: profile.personaName, steamId: profile.steamId })
                    : log('note', `Signing in as ${name}…`),
                fetched: (n, offered, taken) => send({
                    type: 'fetch',
                    n,
                    offered,
                    taken: taken.map(t => ({
                        name: t.targetSteamProfileName,
                        steamId: t.targetSteamProfileId,
                        comment: t.requiredCommentText,
                    })),
                }),
                blocked: (why, until) => send({ type: 'blocked', why, until }),
                exhausted: someOffered => log('note', someOffered
                    ? 'rep4rep has no new targets right now.'
                    : 'No tasks available right now.'),
            },
            countdown: async (until, label) => {
                send({ type: 'countdown', until, label });
                await sleep(Math.max(0, until - Date.now()));
                send({ type: 'countdown', until: null });
            },
            sleep,
            count: opts.count,
            batchSize: opts.batch,
            limitFor: steamId => limitFor(readSettings(), steamId),
            minDelay: opts.min,
            maxDelay: opts.max,
            wait: opts.wait,
            tracking: !opts.ignoreQuota,
            onRefusal: (err, task) => logSteamError(err.message, task.targetSteamProfileId),
        });

        send({ type: 'result', ...total });
        notifyFinished(total);
    } catch (err) {
        if (err instanceof Cancelled) log('note', 'Stopped.');
        else log('bad', err.message);
        send({ type: 'result', done: 0, failed: 0, fetches: 0 });
    } finally {
        current = null;
        send({ type: 'status', running: false });
        refreshTray();
    }
}

/* ------------------------------------------------------------------ */
/* runs nobody clicked Start for: the schedule and the tray            */
/* ------------------------------------------------------------------ */

/**
 * A run with the saved run settings across every signed-in account -- the
 * same thing the CLI's daily task does. Returns why it could not start, if so.
 */
function runFromSettings(reason) {
    if (current) return 'A run is already in progress.';
    if (!hasApiToken()) return 'rep4rep is not connected.';
    const accounts = Object.keys(readSessions());
    if (!accounts.length) return 'No Steam account is signed in.';

    const s = readSettings();
    send({ type: 'scheduled', reason });
    startRun({
        accounts,
        count: s.count, batch: s.batch, min: s.min, max: s.max,
        wait: s.wait, ignoreQuota: s.ignoreQuota,
    }).catch(err => log('bad', err.message));
    return null;
}

function tickSchedule() {
    const s = readSettings();
    if (!isDue(s) || current) return;

    // Marked before starting, so a run that fails is not retried every tick.
    writeSettings({ scheduleLastDay: dayKey(Date.now()) });
    const why = runFromSettings(`Scheduled run (${s.scheduleTime})`);
    if (why) notify('Rep4Rep — scheduled run skipped', why);
    refreshTray();
}

const clock = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

function describeNext(s = readSettings()) {
    const at = nextRun(s);
    if (at === null) return null;
    const sameDay = dayKey(at) === dayKey(Date.now());
    return (sameDay ? 'today ' : 'tomorrow ') + clock(at);
}

/* ------------------------------------------------------------------ */
/* tray                                                                */
/* ------------------------------------------------------------------ */

function showWindow() {
    if (!win) createWindow();
    win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
}

function createTray() {
    tray = new Tray(nativeImage.createFromPath(ICON));
    tray.on('click', showWindow);
    refreshTray();
}

function refreshTray() {
    if (!tray) return;
    const next = describeNext();
    tray.setToolTip(current ? 'Rep4Rep — running' : next ? `Rep4Rep — next run ${next}` : 'Rep4Rep');

    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open Rep4Rep', click: showWindow },
        current
            ? { label: 'Stop run', click: () => current?.cancel() }
            : { label: 'Run now', click: () => {
                const why = runFromSettings('Started from the tray');
                if (why) notify('Rep4Rep', why);
            } },
        { type: 'separator' },
        { label: next ? `Next scheduled run: ${next}` : 'No scheduled run', enabled: false },
        ...(update ? [{ label: `Download v${update.version}…`, click: () => shell.openExternal(update.url) }] : []),
        { type: 'separator' },
        { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
}

/* ------------------------------------------------------------------ */
/* updates                                                             */
/* ------------------------------------------------------------------ */

async function lookForUpdate() {
    if (!readSettings().checkUpdates) return;
    try {
        const found = await checkForUpdate(app.getVersion());
        if (found && found.version !== update?.version) {
            update = found;
            send({ type: 'update', ...update });
            refreshTray();
        }
    } catch {
        // Offline, rate limited, GitHub down: try again on the next check.
    }
}

/** Windows' "run at sign-in" entry. Only meaningful for the packaged .exe. */
function applyLoginItem(on) {
    if (!app.isPackaged) return;
    app.setLoginItemSettings({ openAtLogin: Boolean(on), args: ['--hidden'] });
}

/* ------------------------------------------------------------------ */
/* ipc                                                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle('saveToken', async (_e, token) => {
    try {
        // Prove it works before saving it or letting the user past the setup step.
        const clean = String(token || '').trim();
        if (!clean) throw new Error('Empty API key.');
        const user = await new Rep4Rep(clean).getUser();
        saveApiToken(clean);
        return { ok: true, username: user.username, points: user.points };
    } catch (err) {
        return { error: err.message };
    }
});

ipcMain.handle('steamLogin', async (_e, account) => {
    try {
        // fresh: this is the "sign in" button, so always ask -- never silently
        // reuse a cached session and ignore what the user typed.
        const session = await steamLogin({ account, interactive: true, ask: askWindow, fresh: true });
        const name = session.accountName;
        session.logOff();
        return { ok: true, accountName: name, steamId: session.steamId64 };
    } catch (err) {
        return { error: err.message };
    }
});

ipcMain.handle('removeAccount', (_e, name) => {
    const sessions = readSessions();
    if (!sessions[name]) return { error: `No saved sign-in for ${name}.` };
    delete sessions[name];
    writeSessions(sessions);
    return { ok: true };
});

ipcMain.handle('errorLog', () => readErrorLog());

ipcMain.handle('addProfile', async (_e, steamProfile) => {
    try {
        const res = await new Rep4Rep(getApiToken()).addSteamProfile(String(steamProfile || '').trim());
        return { ok: true, message: res.success || 'Added.' };
    } catch (err) {
        return { error: err.message };
    }
});

ipcMain.handle('getSettings', () => readSettings());
ipcMain.handle('setSettings', (_e, patch) => {
    patch = { ...(patch || {}) };
    const before = readSettings();

    if ('scheduleTime' in patch && !parseTime(patch.scheduleTime)) delete patch.scheduleTime;
    const turnedOn = patch.scheduleEnabled === true && !before.scheduleEnabled;
    if (turnedOn || ('scheduleTime' in patch && patch.scheduleTime !== before.scheduleTime)) {
        // Switching it on at 15:00 for 09:00 waits for tomorrow instead of
        // firing now -- unless today's run already happened, which stays done.
        const today = dayKey(Date.now());
        patch.scheduleLastDay = before.scheduleLastDay === today
            ? today
            : lastDayWhenSet(patch.scheduleTime ?? before.scheduleTime);
    }

    const merged = writeSettings(patch);
    if ('theme' in patch) applyWindowTheme(merged.theme);
    if ('startWithWindows' in patch) applyLoginItem(merged.startWithWindows);
    if (patch.checkUpdates === true) lookForUpdate();
    refreshTray();
    return merged;
});

ipcMain.handle('schedule', () => ({
    next: describeNext(),
    packaged: app.isPackaged,
}));

ipcMain.handle('listStorage', () => ({ dir: CONFIG_DIR, items: listStorage() }));

ipcMain.handle('openConfigDir', async () => {
    const err = await shell.openPath(CONFIG_DIR);
    return err ? { error: err } : { ok: true };
});

ipcMain.handle('removeStorage', async (_e, key) => {
    if (current) return { error: 'Stop the run first.' };

    const item = listStorage().find(i => i.key === key);
    if (!item) return { error: 'Unknown item.' };

    // Native confirmation: the high-risk items are not recoverable.
    const { response } = await dialog.showMessageBox(win, {
        type: item.risk === 'high' ? 'warning' : 'question',
        buttons: ['Cancel', 'Remove'],
        defaultId: 0,
        cancelId: 0,
        title: 'Remove ' + item.label,
        message: 'Remove ' + item.label.toLowerCase() + '?',
        detail: item.consequence,
    });
    if (response !== 1) return { cancelled: true };

    try {
        removeStorage(key);
        return { ok: true };
    } catch (err) {
        return { error: err.message };
    }
});

ipcMain.handle('state', async () => {
    const sessions = readSessions();
    // Which cached Steam sign-in belongs to which rep4rep profile.
    const nameBySteamId = Object.fromEntries(
        Object.entries(sessions).map(([name, s]) => [String(s.steamId), name])
    );

    const out = {
        accounts: Object.entries(sessions).map(([name, s]) => ({ name, steamId: s.steamId })),
        needs: { token: !hasApiToken(), steam: Object.keys(sessions).length === 0 },
        version: app.getVersion(),
        update,
        running: Boolean(current),
        quota: allAccounts(),
        profiles: [],
        user: null,
    };

    try {
        const r4r = new Rep4Rep(getApiToken());
        const [user, profiles] = await Promise.all([r4r.getUser(), r4r.getSteamProfiles()]);
        out.user = user;
        out.profiles = profiles.map(p => ({
            id: p.id,
            steamId: String(p.steamId),
            personaName: p.personaName,
            avatar: p.avatar,
            canReceiveComment: p.canReceiveComment,
            accountName: nameBySteamId[String(p.steamId)] || null,
            usage: getUsage(String(p.steamId)),
        }));
    } catch (err) {
        out.error = err.message;
    }
    return out;
});

ipcMain.handle('run', (_e, opts) => {
    if (current) return { error: 'A run is already in progress.' };
    startRun(opts).catch(err => log('bad', err.message));
    return { started: true };
});

ipcMain.handle('stop', () => {
    if (!current) return { error: 'Nothing is running.' };
    current.cancel();
    return { stopping: true };
});

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

// The native min/max/close strip is drawn by the OS, not the page, so it has
// to be recoloured here to match the title bar of each theme in ui/index.html.
const WINDOW_THEMES = {
    dark:   { background: '#131413', overlay: { color: '#131413', symbolColor: '#edefee', height: 44 } },
    bright: { background: '#5b72c3', overlay: { color: '#4f66b4', symbolColor: '#ffffff', height: 44 } },
};
const windowTheme = name => WINDOW_THEMES[name] || WINDOW_THEMES.dark;

function applyWindowTheme(name) {
    if (!win) return;
    const t = windowTheme(name);
    win.setBackgroundColor(t.background);
    try { win.setTitleBarOverlay(t.overlay); } catch { /* not supported on this platform */ }
}

function createWindow() {
    const theme = windowTheme(readSettings().theme);
    win = new BrowserWindow({
        width: 1120,
        height: 780,
        minWidth: 940,
        minHeight: 620,
        backgroundColor: theme.background,
        show: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: theme.overlay,
        icon: ICON,
        webPreferences: {
            preload: path.join(here, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.loadFile(path.join(here, '..', 'ui', 'index.html'));
    win.once('ready-to-show', () => { if (!launchedHidden) win.show(); });

    // With "keep running in the tray" on, the close button only hides the
    // window, so the schedule keeps working. Quit is in the tray menu.
    win.on('close', e => {
        if (quitting || !readSettings().closeToTray) return;
        e.preventDefault();
        win.hide();
        if (!toldAboutTray) {
            toldAboutTray = true;
            notify('Rep4Rep is still running', 'It lives in the tray now. Right-click the icon to quit.');
        }
    });
    win.on('closed', () => { win = null; });

    // Steam profile links open in the real browser, never inside the app.
    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

app.setAppUserModelId('com.rep4rep.app');

// One copy only: two would both run the schedule. Launching it again (or
// Windows starting it while it is already open) brings the window forward.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', showWindow);

    app.whenReady().then(() => {
        createWindow();
        createTray();
        applyLoginItem(readSettings().startWithWindows);

        tickSchedule();
        setInterval(tickSchedule, 30_000);
        setInterval(refreshTray, 60_000); // keeps "today"/"tomorrow" in the menu right

        setTimeout(lookForUpdate, 5_000);
        setInterval(lookForUpdate, 6 * 3600_000);
    });
}

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
    current?.cancel();
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
