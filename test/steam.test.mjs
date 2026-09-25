import assert from 'node:assert/strict';
import { pickLogOn, isRateLimit } from '../src/steam.js';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const ONE = { alice: { refreshToken: 'tok-alice', steamId: '1' } };
const TWO = {
    alice: { refreshToken: 'tok-alice', steamId: '1' },
    bob:   { refreshToken: 'tok-bob',   steamId: '2' },
};

/* -------- reusing a cached session -------- */

test('named account reuses its own token', () => {
    const r = pickLogOn(TWO, { account: 'bob' });
    assert.equal(r.accountName, 'bob');
    assert.equal(r.refreshToken, 'tok-bob');
});

test('a lone cached session is adopted when no account is named', () => {
    const r = pickLogOn(ONE, {});
    assert.equal(r.accountName, 'alice');
    assert.equal(r.refreshToken, 'tok-alice');
});

test('several cached sessions and no name means no token', () => {
    const r = pickLogOn(TWO, {});
    assert.equal(r.accountName, null);
    assert.equal(r.refreshToken, null);
});

test('an unknown account name yields no token', () => {
    const r = pickLogOn(TWO, { account: 'carol' });
    assert.equal(r.accountName, 'carol');
    assert.equal(r.refreshToken, null);
});

/* -------- fresh sign-in -------- */

test('fresh never reuses a lone cached session', () => {
    // The regression: adding an account with exactly one session cached used to
    // adopt that session, sign it in again, and ignore the typed credentials.
    const r = pickLogOn(ONE, { fresh: true });
    assert.equal(r.refreshToken, null, 'must not reuse a token');
    assert.equal(r.accountName, null, 'must not assume an account');
});

test('fresh ignores a token even for a named account', () => {
    const r = pickLogOn(TWO, { account: 'bob', fresh: true });
    assert.equal(r.accountName, 'bob');
    assert.equal(r.refreshToken, null);
});

test('fresh works from an empty store', () => {
    const r = pickLogOn({}, { fresh: true });
    assert.equal(r.accountName, null);
    assert.equal(r.refreshToken, null);
});

test('no sessions at all yields no token', () => {
    const r = pickLogOn({}, {});
    assert.equal(r.accountName, null);
    assert.equal(r.refreshToken, null);
});

/* -------- throttle detection -------- */

test('throttling is recognised, real refusals are not', () => {
    const throttles = [
        "You've been posting too frequently, and can't make another post right now",
        'HTTP error 429',
        'Please try again later',
        'You are temporarily blocked',
    ];
    const refusals = [
        'The settings on this account do not allow you to add comments',
        'Not Logged In',
        'There was a problem posting your comment',
    ];
    for (const m of throttles) assert.equal(isRateLimit(new Error(m)), true, m);
    for (const m of refusals) assert.equal(isRateLimit(new Error(m)), false, m);
});

for (const [name, fn] of tests) {
    try {
        await fn();
        passed++;
        console.log('  ok  ' + name);
    } catch (err) {
        console.log(' FAIL ' + name);
        console.log('       ' + err.message);
        process.exitCode = 1;
    }
}
console.log(`\n${passed}/${tests.length} passed`);
