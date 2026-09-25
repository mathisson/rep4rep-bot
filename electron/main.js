import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getApiToken, saveApiToken, hasApiToken, readSessions, writeSessions } from '../src/config.js';
import { Rep4Rep } from '../src/rep4rep.js';
import { steamLogin, postProfileComment } from '../src/steam.js';
import { runAccounts, Cancelled } from '../src/accounts.js';
import { getUsage, recordComment, setCooldown, clearCooldown, allAccounts } from '../src/quota.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let win = null;
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

/* ------------------------------------------------------------------ */
/* the run, shared with the CLI                                        */
/* ------------------------------------------------------------------ */

async function startRun(opts) {
    let cancelled = false;
    current = { cancel: () => { cancelled = true; } };
    send({ type: 'status', running: true });

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
            quota: { getUsage, recordComment, setCooldown, clearCooldown },
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
            randBetween: (a, b) => a + Math.random() * (b - a),
            count: opts.count,
            batchSize: opts.batch,
            limit: opts.limit,
            minDelay: opts.min,
            maxDelay: opts.max,
            wait: opts.wait,
            tracking: !opts.ignoreQuota,
        });

        send({ type: 'result', ...total });
    } catch (err) {
        if (err instanceof Cancelled) log('note', 'Stopped.');
        else log('bad', err.message);
        send({ type: 'result', done: 0, failed: 0, fetches: 0 });
    } finally {
        current = null;
        send({ type: 'status', running: false });
    }
}

/* ------------------------------------------------------------------ */
/* ipc                                                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle('saveToken', async (_e, token) => {
    try {
        saveApiToken(token);
        // Prove it works before letting the user past the setup step.
        const user = await new Rep4Rep(getApiToken()).getUser();
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

ipcMain.handle('state', async () => {
    const sessions = readSessions();
    // Which cached Steam sign-in belongs to which rep4rep profile.
    const nameBySteamId = Object.fromEntries(
        Object.entries(sessions).map(([name, s]) => [String(s.steamId), name])
    );

    const out = {
        accounts: Object.entries(sessions).map(([name, s]) => ({ name, steamId: s.steamId })),
        needs: { token: !hasApiToken(), steam: Object.keys(sessions).length === 0 },
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

function createWindow() {
    win = new BrowserWindow({
        width: 1120,
        height: 780,
        minWidth: 940,
        minHeight: 620,
        backgroundColor: '#5b72c3',
        show: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#4f66b4', symbolColor: '#ffffff', height: 44 },
        icon: path.join(here, '..', 'build', 'icon.ico'),
        webPreferences: {
            preload: path.join(here, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.loadFile(path.join(here, '..', 'ui', 'index.html'));
    win.once('ready-to-show', () => win.show());

    // Steam profile links open in the real browser, never inside the app.
    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    current?.cancel();
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
