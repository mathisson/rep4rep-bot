import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Steam refresh tokens live outside the project so they are never picked up by
// a stray `git add .`, and so the CLI works from any working directory.
export const CONFIG_DIR = path.join(os.homedir(), '.rep4rep-cli');

// The repo .env wins when running from source. A packaged .exe has no repo, so
// it falls back to the config dir -- the same place sessions and quota live.
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });
dotenv.config({ path: path.join(CONFIG_DIR, '.env'), quiet: true });
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');

function ensureConfigDir() {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

export function readSessions() {
    try {
        return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw new Error(`Could not read ${SESSIONS_FILE}: ${err.message}`);
    }
}

export function writeSessions(sessions) {
    ensureConfigDir();
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), { mode: 0o600 });
}

export const STEAM_ERROR_LOG = path.join(CONFIG_DIR, 'steam-errors.log');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

export const DEFAULT_SETTINGS = {
    count: 10,
    batch: 3,
    limit: 10,
    min: 20,
    max: 45,
    wait: false,
    ignoreQuota: false,
    limits: {},   // per-SteamID override of `limit`, for accounts Steam treats differently
};

/** The 24h allowance for one account: its own override, else the shared default. */
export function limitFor(settings, steamId) {
    const own = Number(settings?.limits?.[String(steamId)]);
    return Number.isFinite(own) && own > 0 ? own : (Number(settings?.limit) || DEFAULT_SETTINGS.limit);
}

/**
 * Refusals grouped by message, most frequent first. A message that repeats is
 * the signal that a throttle pattern is missing.
 */
export function readErrorLog(max = 50) {
    let raw;
    try {
        raw = fs.readFileSync(STEAM_ERROR_LOG, 'utf8').trim();
    } catch {
        return [];
    }
    if (!raw) return [];

    const tally = new Map();
    for (const row of raw.split('\n')) {
        const [when, , ...rest] = row.split('\t');
        const message = rest.join('\t');
        if (!message) continue;
        const entry = tally.get(message) || { message, count: 0, last: when };
        entry.count++;
        entry.last = when;
        tally.set(message, entry);
    }
    return [...tally.values()].sort((a, b) => b.count - a.count).slice(0, max);
}

export function readSettings() {
    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function writeSettings(patch) {
    const merged = { ...readSettings(), ...patch };
    ensureConfigDir();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
    return merged;
}

/**
 * Everything the app keeps on disk.
 *
 * Deliberately itemised rather than offered as one "clear everything" button:
 * these are not interchangeable, and wiping the ledger in particular removes
 * the only thing keeping a run under Steam's own limit.
 */
export const STORAGE_ITEMS = [
    {
        key: 'settings',
        file: SETTINGS_FILE,
        label: 'Run settings',
        detail: 'Comments per run, pauses, toggles.',
        consequence: 'Returns everything to its default.',
        risk: 'low',
    },
    {
        key: 'errors',
        file: STEAM_ERROR_LOG,
        label: 'Refusal log',
        detail: 'Steam messages not recognised as throttling.',
        consequence: 'Only diagnostics. Nothing breaks.',
        risk: 'low',
    },
    {
        key: 'quota',
        file: path.join(CONFIG_DIR, 'quota.json'),
        label: '24-hour ledger',
        detail: 'How many comments each account has posted today.',
        consequence: 'Clearing this removes the only thing holding a run under Steam’s limit.',
        risk: 'high',
    },
    {
        key: 'sessions',
        file: path.join(CONFIG_DIR, 'sessions.json'),
        label: 'Steam sign-ins',
        detail: 'The tokens Steam issued. Never your password.',
        consequence: 'Signs every account out. You will sign in again.',
        risk: 'high',
    },
    {
        key: 'token',
        file: path.join(CONFIG_DIR, '.env'),
        label: 'rep4rep API token',
        detail: 'Connects the app to your rep4rep account.',
        consequence: 'Disconnects rep4rep. The app returns to first-run setup.',
        risk: 'high',
    },
];

export function listStorage() {
    return STORAGE_ITEMS.map(item => {
        let bytes = null;
        try { bytes = fs.statSync(item.file).size; } catch { /* absent */ }
        return { ...item, bytes, exists: bytes !== null };
    });
}

export function removeStorage(key) {
    const item = STORAGE_ITEMS.find(i => i.key === key);
    if (!item) throw new Error(`Unknown item: ${key}`);
    try {
        fs.rmSync(item.file);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    if (key === 'token') delete process.env.REP4REP_TOKEN;
    return true;
}

/**
 * Record a Steam refusal that isRateLimit did not recognise.
 *
 * Those five patterns are guesses. Anything outside them is treated as a
 * permanent refusal and the task is dropped, so the log is how we find out
 * which patterns are actually missing. Best effort -- never fails a run.
 */
export function logSteamError(message, context = '') {
    try {
        ensureConfigDir();
        const line = `${new Date().toISOString()}\t${context}\t${String(message).replace(/\s+/g, ' ')}\n`;
        fs.appendFileSync(STEAM_ERROR_LOG, line, { mode: 0o600 });
    } catch {
        // Logging must never be the reason a run stops.
    }
}

/** Persist the API token to the config dir, where a packaged app can find it. */
export function saveApiToken(token) {
    const clean = String(token || '').trim();
    if (!clean) throw new Error('Empty API token.');

    ensureConfigDir();
    fs.writeFileSync(path.join(CONFIG_DIR, '.env'), `REP4REP_TOKEN=${clean}\n`, { mode: 0o600 });
    process.env.REP4REP_TOKEN = clean; // take effect without a restart
}

export const hasApiToken = () => Boolean((process.env.REP4REP_TOKEN || '').trim());

export function getApiToken(override) {
    const token = (override || process.env.REP4REP_TOKEN || '').trim();
    if (!token) {
        throw new Error(
            'No rep4rep API token. Put REP4REP_TOKEN=... in .env (see .env.example), ' +
            'or pass --token. Generate one at https://rep4rep.com/user/settings/'
        );
    }
    return token;
}

export const SESSIONS_PATH = SESSIONS_FILE;
