import assert from 'node:assert/strict';
import { runTasks } from '../src/runner.js';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---------------------------------------------------------------- fakes */

const mkTask = n => ({
    taskId: `t${n}`,
    targetSteamProfileId: `7656119${String(n).padStart(10, '0')}`,
    targetSteamProfileName: `user${n}`,
    requiredCommentId: 1000 + n,
    requiredCommentText: `hello ${n}`,
});

/** Serves 3 brand-new tasks per fetch, like rep4rep's tasks page. */
function pagedApi(perPage = 3, pages = 10) {
    let served = 0;
    const api = {
        fetches: 0,
        completed: [],
        async getTasks() {
            api.fetches++;
            if (api.fetches > pages) return [];
            const batch = [];
            for (let i = 0; i < perPage; i++) batch.push(mkTask(++served));
            return batch;
        },
        async completeTask(taskId) { api.completed.push(taskId); },
    };
    return api;
}

function fakeQuota(limit, { startUsed = 0, resetInMs = 3_600_000 } = {}) {
    let used = startUsed;
    let cooldownUntil = null;
    return {
        getUsage: () => ({
            used, limit,
            remaining: Math.max(0, limit - used),
            resetAt: used > 0 ? Date.now() + resetInMs : null,
            cooldownUntil,
        }),
        recordComment: () => { used++; },
        setCooldown: (_id, until) => { cooldownUntil = until; },
        clearCooldown: () => { cooldownUntil = null; },
        get used() { return used; },
        get cooldownUntil() { return cooldownUntil; },
    };
}

const silentUi = () => {
    const lines = [];
    return {
        lines,
        say: m => lines.push(String(m ?? '')),
        ok: m => lines.push('ok ' + m),
        bad: m => lines.push('bad ' + m),
        note: m => lines.push('note ' + m),
        fetched: (n, offered, taken) => lines.push(`fetch ${n} offered=${offered} took=${taken.length}`),
        blocked: (why, until, waiting) => lines.push(`blocked ${why} waiting=${waiting}`),
        exhausted: someOffered => lines.push(`exhausted someOffered=${someOffered}`),
    };
};

const base = overrides => ({
    profile: { id: 'r4rprofile', personaName: 'me' },
    steamId64: '76561190000000001',
    tracking: true,
    ui: silentUi(),
    countdown: async () => {},
    sleep: async () => {},
    randBetween: () => 0,
    count: 10,
    batchSize: 3,
    limit: 10,
    minDelay: 0,
    maxDelay: 0,
    wait: false,
    ...overrides,
});

/* ---------------------------------------------------------------- tests */

test('does 10 comments across repeated fetches of 3', async () => {
    const api = pagedApi(3);
    const posts = [];
    const r = await runTasks(base({
        r4r: api,
        post: async target => { posts.push(target); },
        quota: fakeQuota(10),
    }));

    assert.equal(r.posted, 10, 'should post 10');
    assert.equal(r.done, 10, 'all 10 marked complete');
    assert.equal(r.failed, 0);
    assert.equal(r.stoppedBecause, 'complete');
    assert.equal(r.fetches, 4, '3 + 3 + 3 + 1 needs four fetches');
    assert.equal(api.completed.length, 10);
});

test('never comments on the same target twice', async () => {
    const api = pagedApi(3);
    const posts = [];
    await runTasks(base({
        r4r: api,
        post: async target => { posts.push(target); },
        quota: fakeQuota(10),
    }));
    assert.equal(new Set(posts).size, posts.length, 'every target unique');
});

test('takes at most batchSize per fetch even when more are offered', async () => {
    const api = {
        fetches: 0,
        completed: [],
        async getTasks() { api.fetches++; return [1, 2, 3, 4, 5, 6].map(n => mkTask(n + api.fetches * 100)); },
        async completeTask(id) { api.completed.push(id); },
    };
    const ui = silentUi();
    await runTasks(base({
        r4r: api, ui,
        post: async () => {},
        quota: fakeQuota(10),
        count: 6,
    }));
    const took = ui.lines.filter(l => l.startsWith('fetch ')).map(l => Number(l.match(/took=(\d+)/)[1]));
    assert.deepEqual(took, [3, 3], 'two fetches of three, not one of six');
});

test('re-polls then stops when rep4rep keeps offering the same targets', async () => {
    const stale = [mkTask(1), mkTask(2), mkTask(3)];
    const api = {
        fetches: 0,
        completed: [],
        async getTasks() { api.fetches++; return stale; },
        async completeTask(id) { api.completed.push(id); },
    };
    const ui = silentUi();
    const r = await runTasks(base({
        r4r: api, ui,
        post: async () => {},
        quota: fakeQuota(10),
    }));

    assert.equal(r.posted, 3, 'does the three it was given');
    assert.equal(r.stoppedBecause, 'no-tasks');
    const recheck = ui.lines.filter(l => l.includes('re-checking')).length;
    assert.equal(recheck, 3, 'retries the stale page three times');
    assert.ok(ui.lines.some(l => l === 'exhausted someOffered=true'));
});

test('stops at the 24h allowance even when more tasks exist', async () => {
    const api = pagedApi(3);
    const ui = silentUi();
    const r = await runTasks(base({
        r4r: api, ui,
        post: async () => {},
        quota: fakeQuota(5),
        limit: 5,
        count: 10,
    }));

    assert.equal(r.posted, 5, 'capped by the allowance, not the count');
    assert.equal(r.stoppedBecause, 'quota');
    assert.ok(ui.lines.some(l => l.startsWith('blocked allowance spent')));
});

test('a throttle without --wait stops and records a cooldown', async () => {
    const api = pagedApi(3);
    const quota = fakeQuota(10);
    const r = await runTasks(base({
        r4r: api,
        quota,
        post: async () => { throw new Error("You've been posting too frequently, and can't make another post right now"); },
    }));

    assert.equal(r.posted, 0);
    assert.equal(r.stoppedBecause, 'cooldown');
    assert.ok(quota.cooldownUntil > Date.now(), 'cooldown persisted');
});

test('a throttle with --wait retries the same task rather than losing it', async () => {
    const api = pagedApi(3);
    const posts = [];
    let thrown = 0;
    const r = await runTasks(base({
        r4r: api,
        quota: fakeQuota(10),
        wait: true,
        count: 3,
        post: async target => {
            if (thrown < 2) { thrown++; throw new Error('HTTP error 429'); }
            posts.push(target);
        },
    }));

    assert.equal(thrown, 2, 'throttled twice');
    assert.equal(r.posted, 3, 'still completes all three');
    assert.equal(new Set(posts).size, 3, 'no target skipped or duplicated');
});

test('a refusal is dropped, does not consume the target, and the run continues', async () => {
    const api = pagedApi(3);
    const attempts = [];
    const r = await runTasks(base({
        r4r: api,
        quota: fakeQuota(10),
        count: 3,
        post: async target => {
            attempts.push(target);
            if (attempts.length === 2) {
                throw new Error('The settings on this account do not allow you to add comments');
            }
        },
    }));

    assert.equal(r.failed, 1, 'the refusal counts as a failure');
    assert.equal(attempts.length, 4, 'it tried a fourth target to make up for the refusal');
    assert.equal(r.posted, 3, '"do 3" means 3 comments that actually landed');
    assert.equal(r.done, 3, 'all three landed ones were marked complete');
    assert.equal(new Set(attempts).size, 4, 'the refused target was not retried');
});

test('a rep4rep completion failure is reported but the comment still counts as posted', async () => {
    const api = pagedApi(3);
    api.completeTask = async () => { throw new Error('rep4rep: task already completed'); };
    const quota = fakeQuota(10);
    const r = await runTasks(base({
        r4r: api,
        quota,
        count: 2,
        post: async () => {},
    }));

    assert.equal(r.posted, 2, 'the Steam comments did go out');
    assert.equal(r.done, 0, 'none counted as completed');
    assert.equal(r.failed, 2);
    assert.equal(quota.used, 2, 'allowance was still consumed');
});

test('an empty first fetch stops cleanly', async () => {
    const api = { fetches: 0, async getTasks() { api.fetches++; return []; }, async completeTask() {} };
    const ui = silentUi();
    const r = await runTasks(base({ r4r: api, ui, post: async () => {}, quota: fakeQuota(10) }));

    assert.equal(r.posted, 0);
    assert.equal(r.fetches, 1, 'does not hammer an empty queue');
    assert.equal(r.stoppedBecause, 'no-tasks');
    assert.ok(ui.lines.some(l => l === 'exhausted someOffered=false'));
});

test('a fetch error stops the run without crashing', async () => {
    const api = { async getTasks() { throw new Error('Could not reach rep4rep'); }, async completeTask() {} };
    const r = await runTasks(base({ r4r: api, post: async () => {}, quota: fakeQuota(10) }));
    assert.equal(r.stoppedBecause, 'fetch-failed');
    assert.equal(r.posted, 0);
});

test('untracked runs ignore the ledger entirely', async () => {
    const api = pagedApi(3);
    const quota = fakeQuota(1); // would block immediately if consulted
    const r = await runTasks(base({
        r4r: api,
        quota,
        tracking: false,
        count: 6,
        post: async () => {},
    }));
    assert.equal(r.posted, 6, '--ignore-quota really does ignore it');
    assert.equal(quota.used, 0, 'and records nothing');
});

/* ---------------------------------------------------------------- run */

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
