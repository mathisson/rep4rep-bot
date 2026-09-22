import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

// Steam refresh tokens live outside the project so they are never picked up by
// a stray `git add .`, and so the CLI works from any working directory.
export const CONFIG_DIR = path.join(os.homedir(), '.rep4rep-cli');
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
