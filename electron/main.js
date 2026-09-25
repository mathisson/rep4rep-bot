import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getApiToken, readSessions } from '../src/config.js';
import { Rep4Rep } from '../src/rep4rep.js';
import { steamLogin, postProfileComment } from '../src/steam.js';
import { runTasks } from '../src/runner.js';
import { getUsage, recordComment, setCooldown, clearCooldown, allAccounts } from '../src/quota.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Raised by the injected sleep/countdown when the user hits Stop. */
class Cancelled extends Error {}

let win = null;
let current = null; // { cancel } while a run is in flight

const send = payload => win?.webContents.send('event', { ...payload, at: Date.now() });
const log = (kind, text) => send({ type: 'log', kind, text });

/** sleep that rejects the moment the run is cancelled, so Stop is immediate. */
const cancellableSleep = isCancelled => ms => new Promise((resolve, reject) => {
    if (isCancelled()) return reject(new Cancelled());
    const tick = setInterval(() => {
        if (isCancelled()) { clearInterval(tick); clearTimeout(timer); reject(new Cancelled()); }
    }, 250);
    const timer = setTimeout(() => { clearInterval(tick); resolve(); }, ms);
});

/* ------------------------------------------------------------------ */
/* the run, driven by the same runner the CLI uses                     */
/* ------------------------------------------------------------------ */

async function startRun(opts) {
    let cancelled = false;
    current = { cancel: () => { cancelled = true; } };
    send({ type: 'status', running: true });

    const sleep = cancellableSleep(() => cancelled);
    let session = null;

    try {
        const r4r = new Rep4Rep(getApiToken());

        log('note', 'Signing in to Steam…');
        session = await steamLogin({ account: opts.account });
        log('ok', `Signed in as ${session.accountName}`);

        const profiles = await r4r.getSteamProfiles();
        const profile = profiles.find(p => String(p.steamId) === session.steamId64);
        if (!profile) throw new Error(`${session.steamId64} is not linked to your rep4rep account.`);

        const result = await runTasks({
            r4r,
            post: (target, text) => postProfileComment(session.community, target, text),
            profile,
            steamId64: session.steamId64,
            tracking: !opts.ignoreQuota,
            quota: { getUsage, recordComment, setCooldown, clearCooldown },
            ui: {
                say: m => log('plain', m),
                ok: m => log('ok', m),
                bad: m => log('bad', m),
                note: m => log('note', m),
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
        });

        send({ type: 'result', ...result });
    } catch (err) {
        if (err instanceof Cancelled) log('note', 'Stopped.');
        else log('bad', err.message);
    } finally {
        session?.logOff();
        current = null;
        send({ type: 'status', running: false });
    }
}

/* ------------------------------------------------------------------ */
/* ipc                                                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle('state', async () => {
    const sessions = readSessions();
    const out = {
        accounts: Object.entries(sessions).map(([name, s]) => ({ name, steamId: s.steamId })),
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
        backgroundColor: '#0d1117',
        show: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#0d1117', symbolColor: '#7d8792', height: 44 },
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
