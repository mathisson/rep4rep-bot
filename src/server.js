import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getApiToken, readSessions } from './config.js';
import { Rep4Rep } from './rep4rep.js';
import { steamLogin, postProfileComment } from './steam.js';
import { runTasks } from './runner.js';
import { formatDuration, formatClock } from './countdown.js';
import { getUsage, recordComment, setCooldown, clearCooldown, allAccounts } from './quota.js';

const UI_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');

/** Raised by the injected sleep/countdown when the user hits Stop. */
class Cancelled extends Error {}

/* ------------------------------------------------------------------ */
/* live run state                                                      */
/* ------------------------------------------------------------------ */

const clients = new Set();
const history = [];          // last N events, so a late browser sees the run so far
const HISTORY_MAX = 300;

let current = null;          // { cancel, startedAt } while a run is in flight

function emit(event) {
    const payload = { ...event, at: Date.now() };
    history.push(payload);
    if (history.length > HISTORY_MAX) history.shift();
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(frame);
}

const log = (kind, text) => emit({ type: 'log', kind, text });

/** sleep that rejects the moment the run is cancelled, so Stop is immediate. */
function cancellableSleep(isCancelled) {
    return ms => new Promise((resolve, reject) => {
        if (isCancelled()) return reject(new Cancelled());
        const tick = setInterval(() => {
            if (isCancelled()) { clearInterval(tick); clearTimeout(timer); reject(new Cancelled()); }
        }, 250);
        const timer = setTimeout(() => { clearInterval(tick); resolve(); }, ms);
    });
}

/* ------------------------------------------------------------------ */
/* the run, driven by the same runner the CLI uses                     */
/* ------------------------------------------------------------------ */

async function startRun(opts) {
    if (current) throw new Error('A run is already in progress.');

    let cancelled = false;
    const isCancelled = () => cancelled;
    current = { cancel: () => { cancelled = true; }, startedAt: Date.now() };

    history.length = 0;
    emit({ type: 'status', running: true });

    const sleep = cancellableSleep(isCancelled);
    let session = null;

    try {
        const r4r = new Rep4Rep(getApiToken());

        log('note', 'Logging into Steam...');
        session = await steamLogin({ account: opts.account });
        log('ok', `Steam: ${session.accountName} (${session.steamId64})`);

        const profiles = await r4r.getSteamProfiles();
        const profile = profiles.find(p => String(p.steamId) === session.steamId64);
        if (!profile) {
            throw new Error(`${session.steamId64} is not linked to your rep4rep account.`);
        }

        const tracking = !opts.ignoreQuota;

        const result = await runTasks({
            r4r,
            post: (target, text) => postProfileComment(session.community, target, text),
            profile,
            steamId64: session.steamId64,
            tracking,
            quota: { getUsage, recordComment, setCooldown, clearCooldown },
            ui: {
                say: m => log('plain', m),
                ok: m => log('ok', m),
                bad: m => log('bad', m),
                note: m => log('note', m),
                fetched: (n, offered, taken) => emit({
                    type: 'fetch',
                    n,
                    offered,
                    taken: taken.map(t => ({
                        name: t.targetSteamProfileName,
                        steamId: t.targetSteamProfileId,
                        comment: t.requiredCommentText,
                    })),
                }),
                blocked: (why, until) => emit({ type: 'blocked', why, until }),
                exhausted: someOffered => log('note', someOffered
                    ? 'rep4rep has no new targets right now.'
                    : 'No tasks available right now.'),
            },
            countdown: async (until, label) => {
                emit({ type: 'countdown', until, label });
                await sleep(Math.max(0, until - Date.now()));
                emit({ type: 'countdown', until: null });
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

        log('ok', `Finished: ${result.done} completed, ${result.failed} failed, over ${result.fetches} fetch(es).`);
        emit({ type: 'result', ...result });
    } catch (err) {
        if (err instanceof Cancelled) log('note', 'Stopped.');
        else log('bad', err.message);
    } finally {
        session?.logOff();
        current = null;
        emit({ type: 'status', running: false });
    }
}

/* ------------------------------------------------------------------ */
/* http                                                                */
/* ------------------------------------------------------------------ */

const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => {
            raw += chunk;
            if (raw.length > 1e6) reject(new Error('Body too large'));
        });
        req.on('end', () => {
            try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); }
        });
        req.on('error', reject);
    });
}

async function state() {
    const sessions = readSessions();
    const accounts = Object.entries(sessions).map(([name, s]) => ({ name, steamId: s.steamId }));

    const out = { accounts, running: Boolean(current), quota: allAccounts(), profiles: [], user: null };

    try {
        const r4r = new Rep4Rep(getApiToken());
        const [user, profiles] = await Promise.all([r4r.getUser(), r4r.getSteamProfiles()]);
        out.user = user;
        out.profiles = profiles.map(p => ({
            id: p.id,
            steamId: String(p.steamId),
            personaName: p.personaName,
            usage: getUsage(String(p.steamId)),
        }));
    } catch (err) {
        out.error = err.message;
    }
    return out;
}

const routes = {
    'GET /api/state': async (_req, res) => json(res, 200, await state()),

    'GET /api/events': (_req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        for (const past of history) res.write(`data: ${JSON.stringify(past)}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'status', running: Boolean(current) })}\n\n`);
        clients.add(res);
        res.on('close', () => clients.delete(res));
    },

    'POST /api/run': async (req, res) => {
        const body = await readBody(req);
        if (current) return json(res, 409, { error: 'A run is already in progress.' });

        const opts = {
            account: body.account || undefined,
            count: Number(body.count) || 10,
            batch: Number(body.batch) || 3,
            limit: Number(body.limit) || 10,
            min: Number(body.min) ?? 20,
            max: Number(body.max) ?? 45,
            wait: Boolean(body.wait),
            ignoreQuota: Boolean(body.ignoreQuota),
        };

        startRun(opts).catch(err => log('bad', err.message));
        json(res, 202, { started: true });
    },

    'POST /api/stop': (_req, res) => {
        if (!current) return json(res, 409, { error: 'Nothing is running.' });
        current.cancel();
        json(res, 200, { stopping: true });
    },
};

export function serve(port = 4666) {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const key = `${req.method} ${url.pathname}`;

        if (key === 'GET /') {
            return fs.createReadStream(UI_FILE)
                .on('open', () => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }))
                .on('error', () => json(res, 500, { error: 'ui/index.html is missing' }))
                .pipe(res);
        }

        const handler = routes[key];
        if (!handler) return json(res, 404, { error: 'Not found' });

        try {
            await handler(req, res);
        } catch (err) {
            if (!res.headersSent) json(res, 500, { error: err.message });
        }
    });

    // Loopback only. This endpoint can post comments and read your ledger; it has
    // no auth because it is never meant to be reachable from another machine.
    return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export { formatDuration, formatClock };
