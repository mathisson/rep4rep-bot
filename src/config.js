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
