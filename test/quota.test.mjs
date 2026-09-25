import assert from 'node:assert/strict';
import {
    getUsage, recordComment, setCooldown, clearCooldown, resetQuota, allAccounts,
    WINDOW_MS, QUOTA_PATH,
} from '../src/quota.js';
import { formatDuration } from '../src/countdown.js';

const ID = '76561190000000001';
const now = Date.UTC(2026, 8, 25, 12, 0, 0);
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

console.log('quota file ->', QUOTA_PATH);
resetQuota();

check('starts empty', () => {
    const u = getUsage(ID, 10, now);
    assert.equal(u.used, 0);
    assert.equal(u.remaining, 10);
    assert.equal(u.resetAt, null);
});

check('counts comments and decrements remaining', () => {
    for (let i = 0; i < 4; i++) recordComment(ID, now - (i * 60_000));
    const u = getUsage(ID, 10, now);
    assert.equal(u.used, 4);
    assert.equal(u.remaining, 6);
});

check('resetAt is the oldest comment plus the 24h window', () => {
    const u = getUsage(ID, 10, now);
    const oldest = Date.parse(u.comments[0]);
    assert.equal(u.resetAt, oldest + WINDOW_MS);
});

check('hitting the limit leaves zero remaining', () => {
    for (let i = 4; i < 10; i++) recordComment(ID, now - (i * 60_000));
    const u = getUsage(ID, 10, now);
    assert.equal(u.used, 10);
    assert.equal(u.remaining, 0);
});

check('an 11th is still recorded but remaining floors at zero', () => {
    recordComment(ID, now);
    const u = getUsage(ID, 10, now);
    assert.equal(u.used, 11);
    assert.equal(u.remaining, 0);
});

check('comments older than 24h age out of the window', () => {
    // Same ledger, read 24h + 1min later: everything recorded above has expired.
    const later = now + WINDOW_MS + 60_000;
    const u = getUsage(ID, 10, later);
    assert.equal(u.used, 0);
    assert.equal(u.remaining, 10);
});

check('one slot frees exactly at resetAt', () => {
    resetQuota(ID);
    for (let i = 0; i < 10; i++) recordComment(ID, now - (i * 60_000));
    const before = getUsage(ID, 10, now);
    assert.equal(before.remaining, 0);
    // The oldest is 9 minutes back, so it ages out 9 minutes after the naive 24h mark.
    const atReset = before.resetAt + 1000;
    assert.equal(getUsage(ID, 10, atReset).remaining, 1);
});

check('cooldown is stored, surfaced, and cleared', () => {
    const until = now + 3 * 60 * 60 * 1000;
    setCooldown(ID, until, now);
    assert.equal(getUsage(ID, 10, now).cooldownUntil, until);
    clearCooldown(ID, now);
    assert.equal(getUsage(ID, 10, now).cooldownUntil, null);
});

check('an expired cooldown is pruned on read', () => {
    setCooldown(ID, now + 1000, now);
    assert.equal(getUsage(ID, 10, now + 5000).cooldownUntil, null);
});

check('accounts are tracked separately', () => {
    const other = '76561190000000002';
    recordComment(other, now);
    assert.equal(getUsage(other, 10, now).used, 1);
    assert.equal(getUsage(ID, 10, now).used, 10);
    assert.equal(allAccounts(now).length, 2);
});

check('resetQuota clears one account only', () => {
    resetQuota(ID);
    assert.equal(getUsage(ID, 10, now).used, 0);
    assert.equal(getUsage('76561190000000002', 10, now).used, 1);
});

check('durations format sensibly', () => {
    assert.equal(formatDuration(9_000), '9s');
    assert.equal(formatDuration(69_000), '1m 09s');
    assert.equal(formatDuration(3 * 3600_000 + 24 * 60_000 + 9_000), '3h 24m 09s');
    assert.equal(formatDuration(-5000), '0s');
});

resetQuota();
console.log(`\n${passed} checks passed`);
