import assert from 'node:assert/strict';
import { runAccounts, Cancelled } from '../src/accounts.js';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const mkTask = n => ({
    taskId: `t${n}`,
    targetSteamProfileId: `7656119${String(n).padStart(10, '0')}`,
    targetSteamProfileName: `user${n}`,
    requiredCommentId: 1000 + n,
    requiredCommentText: `hello ${n}`,
});

const PROFILES = [
    { id: 'pA', steamId: '1', personaName: 'Alpha' },
    { id: 'pB', steamId: '2', personaName: 'Beta' },
];

function fakeR4r(perPage = 3) {
    let served = 0;
    return {
        completed: [],
        async getSteamProfiles() { return PROFILES; },
        async getTasks() {
            const out = [];
            for (let i = 0; i < perPage; i++) out.push(mkTask(++served));
            return out;
        },
        async completeTask(id) { this.completed.push(id); },
    };
}

const fakeQuota = () => {
    const used = {};
    return {
        getUsage: id => ({
            used: used[id] || 0, limit: 10,
            remaining: Math.max(0, 10 - (used[id] || 0)),
            resetAt: used[id] ? Date.now() + 3600e3 : null,
            cooldownUntil: null,
        }),
        recordComment: id => { used[id] = (used[id] || 0) + 1; },
        setCooldown: () => {},
        clearCooldown: () => {},
        counts: used,
    };
};

const silentUi = () => {
    const lines = [];
    return {
        lines,
        say: m => lines.push(String(m ?? '')),
        ok: m => lines.push('ok ' + m),
        bad: m => lines.push('bad ' + m),
        note: m => lines.push('note ' + m),
        account: ({ name, profile }) => lines.push(`account ${name}${profile ? ' -> ' + profile.personaName : ''}`),
        fetched: () => {},
        blocked: () => {},
        exhausted: () => {},
    };
};

const base = o => ({
    post: async () => {},
    quota: fakeQuota(),
    ui: silentUi(),
    countdown: async () => {},
    sleep: async () => {},
    randBetween: () => 0,
    count: 3, batchSize: 3, limit: 10, minDelay: 0, maxDelay: 0,
    switchDelayMs: 0,
    ...o,
});

const loginAs = steamId => async name => ({
    accountName: name, steamId64: steamId(name), community: {}, logOff() { this.off = true; },
});

/* ---------------------------------------------------------------- */

test('runs every account given', async () => {
    const r4r = fakeR4r();
    const ui = silentUi();
    const total = await runAccounts(base({
        accounts: ['a', 'b'], r4r, ui,
        login: loginAs(n => (n === 'a' ? '1' : '2')),
    }));

    assert.equal(total.accounts, 2);
    assert.equal(total.done, 6, '3 comments each');
    assert.equal(total.failed, 0);
    assert.ok(ui.lines.includes('account a -> Alpha'));
    assert.ok(ui.lines.includes('account b -> Beta'));
});

test('each account gets its own allowance', async () => {
    const quota = fakeQuota();
    await runAccounts(base({
        accounts: ['a', 'b'], r4r: fakeR4r(), quota,
        login: loginAs(n => (n === 'a' ? '1' : '2')),
    }));
    assert.equal(quota.counts['1'], 3);
    assert.equal(quota.counts['2'], 3);
});

test('a single account still works', async () => {
    const total = await runAccounts(base({
        accounts: ['a'], r4r: fakeR4r(), login: loginAs(() => '1'),
    }));
    assert.equal(total.accounts, 1);
    assert.equal(total.done, 3);
});

test('an account that fails to sign in does not stop the rest', async () => {
    const ui = silentUi();
    const total = await runAccounts(base({
        accounts: ['broken', 'b'], r4r: fakeR4r(), ui,
        login: async name => {
            if (name === 'broken') throw new Error('Steam rejected that username or password.');
            return { accountName: name, steamId64: '2', community: {}, logOff() {} };
        },
    }));

    assert.equal(total.failed, 1);
    assert.equal(total.accounts, 1, 'the good account still ran');
    assert.equal(total.done, 3);
    assert.ok(ui.lines.some(l => l.startsWith('bad broken:')));
});

test('an account not linked to rep4rep is reported, others continue', async () => {
    const ui = silentUi();
    const total = await runAccounts(base({
        accounts: ['stranger', 'b'], r4r: fakeR4r(), ui,
        login: loginAs(n => (n === 'stranger' ? '999' : '2')),
    }));
    assert.equal(total.failed, 1);
    assert.equal(total.accounts, 1);
    assert.ok(ui.lines.some(l => l.includes('not linked')));
});

test('cancelling stops the whole run, not just one account', async () => {
    const ui = silentUi();
    let started = 0;
    await assert.rejects(
        runAccounts(base({
            accounts: ['a', 'b'], r4r: fakeR4r(), ui,
            login: async name => { started++; return { accountName: name, steamId64: '1', community: {}, logOff() {} }; },
            post: async () => { throw new Cancelled(); },
        })),
        e => e instanceof Cancelled
    );
    assert.equal(started, 1, 'never reached the second account');
});

test('every session is logged off, even on failure', async () => {
    const offs = [];
    await runAccounts(base({
        accounts: ['a', 'b'], r4r: fakeR4r(),
        login: async name => ({
            accountName: name, steamId64: name === 'a' ? '1' : '2', community: {},
            logOff() { offs.push(name); },
        }),
        post: async () => { throw new Error('comments disabled'); },
    }));
    assert.deepEqual(offs.sort(), ['a', 'b']);
});

test('no accounts is an error, not a silent no-op', async () => {
    await assert.rejects(
        runAccounts(base({ accounts: [], r4r: fakeR4r(), login: loginAs(() => '1') })),
        /No Steam accounts are signed in/
    );
});

test('it pauses between accounts but not after the last', async () => {
    const waits = [];
    await runAccounts(base({
        accounts: ['a', 'b'], r4r: fakeR4r(),
        login: loginAs(n => (n === 'a' ? '1' : '2')),
        switchDelayMs: 5000,
        sleep: async ms => { if (ms === 5000) waits.push(ms); },
    }));
    assert.equal(waits.length, 1, 'one switch between two accounts');
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
