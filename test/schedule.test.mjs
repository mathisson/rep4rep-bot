import assert from 'node:assert/strict';
import { parseTime, dayKey, isDue, nextRun, lastDayWhenSet } from '../src/schedule.js';
import { parseVersion, isNewer, checkForUpdate, RELEASES_URL } from '../src/update.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('  ok  ' + name); };

// Local-time fixtures: the schedule is about the user's wall clock.
const at = (h, m = 0, day = 7) => new Date(2026, 10, day, h, m, 0, 0).getTime();
const on = (extra = {}) => ({ scheduleEnabled: true, scheduleTime: '09:00', scheduleLastDay: null, ...extra });

await check('parseTime accepts HH:MM and rejects nonsense', () => {
    assert.deepEqual(parseTime('09:30'), { h: 9, min: 30 });
    assert.deepEqual(parseTime('7:05'), { h: 7, min: 5 });
    assert.equal(parseTime('24:00'), null);
    assert.equal(parseTime('12:60'), null);
    assert.equal(parseTime(''), null);
    assert.equal(parseTime(undefined), null);
});

await check('off is never due and has no next run', () => {
    assert.equal(isDue({ ...on(), scheduleEnabled: false }, at(10)), false);
    assert.equal(nextRun({ ...on(), scheduleEnabled: false }, at(10)), null);
});

await check('not due before its time, due after it', () => {
    assert.equal(isDue(on(), at(8, 59)), false);
    assert.equal(isDue(on(), at(9, 0)), true);
    assert.equal(isDue(on(), at(23, 30)), true);   // late start still gets the day's run
});

await check('runs once per day', () => {
    const done = on({ scheduleLastDay: dayKey(at(9)) });
    assert.equal(isDue(done, at(15)), false);
    assert.equal(isDue(done, at(9, 0, 8)), true);  // next day
});

await check('nextRun: later today, now, or tomorrow', () => {
    assert.equal(nextRun(on(), at(6)), at(9));
    assert.equal(nextRun(on(), at(10)), at(10));
    assert.equal(nextRun(on({ scheduleLastDay: dayKey(at(9)) }), at(10)), at(9, 0, 8));
});

await check('turning it on after today\'s time skips today', () => {
    assert.equal(lastDayWhenSet('09:00', at(15)), dayKey(at(15)));
    assert.equal(lastDayWhenSet('18:00', at(15)), null);
});

await check('version comparison', () => {
    assert.deepEqual(parseVersion('v2.10.1'), [2, 10, 1]);
    assert.equal(isNewer('v2.4.0', '2.3.0'), true);
    assert.equal(isNewer('v2.10.0', '2.9.9'), true);
    assert.equal(isNewer('v2.3.0', '2.3.0'), false);
    assert.equal(isNewer('v2.2.9', '2.3.0'), false);
    assert.equal(isNewer('garbage', '2.3.0'), false);
});

const fakeFetch = body => async () => ({ ok: true, json: async () => body });

await check('checkForUpdate reports only a newer, final release', async () => {
    assert.deepEqual(await checkForUpdate('2.3.0', fakeFetch({ tag_name: 'v2.4.0' })),
        { version: '2.4.0', url: RELEASES_URL });
    assert.equal(await checkForUpdate('2.4.0', fakeFetch({ tag_name: 'v2.4.0' })), null);
    assert.equal(await checkForUpdate('2.3.0', fakeFetch({ tag_name: 'v2.5.0', prerelease: true })), null);
    await assert.rejects(checkForUpdate('2.3.0', async () => ({ ok: false, status: 403 })));
});

console.log(`\n${passed} passed`);
