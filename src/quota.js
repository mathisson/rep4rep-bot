import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_DIR } from './config.js';

const QUOTA_FILE = path.join(CONFIG_DIR, 'quota.json');

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LIMIT = 10;

/**
 * Tracks how many comments each Steam account has posted in the last 24 hours,
 * so the cap survives restarts. Keyed by SteamID64:
 *
 *   { "765611...": { comments: ["2026-09-25T10:00:00.000Z", ...],
 *                    cooldownUntil: "2026-09-25T18:00:00.000Z" } }
 */

function readRaw() {
    try {
        return JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw new Error(`Could not read ${QUOTA_FILE}: ${err.message}`);
    }
}

function writeRaw(data) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/** Drop comment timestamps that have aged out and cooldowns that have expired. */
function prune(entry, now) {
    const cutoff = now - WINDOW_MS;
    const comments = (entry?.comments || [])
        .filter(ts => {
            const t = Date.parse(ts);
            return Number.isFinite(t) && t > cutoff;
        })
        .sort();

    const cooldownAt = entry?.cooldownUntil ? Date.parse(entry.cooldownUntil) : null;
    const cooldownUntil = Number.isFinite(cooldownAt) && cooldownAt > now ? entry.cooldownUntil : undefined;

    return cooldownUntil ? { comments, cooldownUntil } : { comments };
}

/**
 * Current standing for one account.
 * `resetAt` is when the oldest comment in the window ages out, freeing one slot.
 */
export function getUsage(steamId, limit = DEFAULT_LIMIT, now = Date.now()) {
    const entry = prune(readRaw()[steamId], now);
    const used = entry.comments.length;
    const oldest = entry.comments[0] ? Date.parse(entry.comments[0]) : null;

    return {
        used,
        limit,
        remaining: Math.max(0, limit - used),
        resetAt: oldest === null ? null : oldest + WINDOW_MS,
        cooldownUntil: entry.cooldownUntil ? Date.parse(entry.cooldownUntil) : null,
        comments: entry.comments,
    };
}

/** Record one successfully posted comment. */
export function recordComment(steamId, now = Date.now()) {
    const data = readRaw();
    const entry = prune(data[steamId], now);
    entry.comments.push(new Date(now).toISOString());
    data[steamId] = entry;
    writeRaw(data);
}

/** Remember that Steam is refusing posts until `until` (ms epoch). */
export function setCooldown(steamId, until, now = Date.now()) {
    const data = readRaw();
    const entry = prune(data[steamId], now);
    entry.cooldownUntil = new Date(until).toISOString();
    data[steamId] = entry;
    writeRaw(data);
}

export function clearCooldown(steamId, now = Date.now()) {
    const data = readRaw();
    if (!data[steamId]) return;
    const entry = prune(data[steamId], now);
    delete entry.cooldownUntil;
    data[steamId] = entry;
    writeRaw(data);
}

/** Forget everything for one account, or for all of them. */
export function resetQuota(steamId) {
    if (!steamId) return writeRaw({});
    const data = readRaw();
    delete data[steamId];
    writeRaw(data);
}

export function allAccounts(now = Date.now()) {
    const data = readRaw();
    return Object.keys(data).map(steamId => ({ steamId, ...getUsage(steamId, DEFAULT_LIMIT, now) }));
}

export const QUOTA_PATH = QUOTA_FILE;
