import { isRateLimit } from './steam.js';

const HOUR_MS = 60 * 60 * 1000;

/** Stops --wait spinning forever if Steam keeps refusing. */
export const MAX_WAITS = 24;
/** How many times to re-poll when rep4rep is still serving tasks we just did. */
export const MAX_STALE_REFETCHES = 3;
export const STALE_REFETCH_WAIT_MS = 30_000;

/**
 * Work through comment tasks until `count` are posted or something stops us.
 *
 * rep4rep offers only a handful of targets at a time and never repeats a target,
 * so a single fetch cannot fill a whole run. `pending` is refilled from a fresh
 * fetch each time it empties.
 *
 * Every collaborator is injected so the loop can be driven by fakes in tests.
 */
export async function runTasks({
    r4r,            // { getTasks, completeTask, }
    post,           // async (targetSteamId64, text) => void
    profile,        // { id, personaName }
    steamId64,      // string | null
    tracking,       // whether to consult and update the local allowance ledger
    quota,          // { getUsage, recordComment, setCooldown, clearCooldown }
    ui,             // { say, ok, bad, note, describeTask, dim, yellow }
    countdown,      // async (untilMs, label) => void
    sleep,          // async (ms) => void
    randBetween,
    now = Date.now,
    count,
    batchSize,
    limit,
    minDelay,
    maxDelay,
    wait = false,
}) {
    let pending = [];
    const seenTasks = new Set();
    const seenTargets = new Set();

    let done = 0;
    let failed = 0;
    let posted = 0;
    let waits = 0;
    let staleRefetches = 0;
    let fetches = 0;
    let stoppedBecause = 'complete';

    while (posted < count) {
        // 1. Allowance gate, checked before every comment and before every fetch.
        if (tracking) {
            const u = quota.getUsage(steamId64, limit);
            const blockedUntil = u.cooldownUntil || (u.remaining === 0 ? u.resetAt : null);

            if (blockedUntil && blockedUntil > now()) {
                const why = u.cooldownUntil ? 'Steam cooldown' : `allowance spent (${u.used}/${limit})`;
                if (!wait || waits >= MAX_WAITS) {
                    ui.blocked(why, blockedUntil, wait);
                    stoppedBecause = u.cooldownUntil ? 'cooldown' : 'quota';
                    break;
                }
                waits++;
                ui.note(`${why}.`);
                await countdown(blockedUntil, 'next slot in');
                quota.clearCooldown(steamId64);
                continue;
            }
        }

        // 2. Refill from rep4rep when the current batch is spent.
        if (!pending.length) {
            let available;
            try {
                fetches++;
                available = await r4r.getTasks(profile.id);
            } catch (err) {
                ui.bad(`Could not fetch tasks: ${err.message}`);
                stoppedBecause = 'fetch-failed';
                break;
            }

            const fresh = available.filter(t =>
                !seenTasks.has(t.taskId) && !seenTargets.has(String(t.targetSteamProfileId)));

            if (!fresh.length) {
                // rep4rep keeps serving the tasks we just did until its own verification
                // catches up, so give it a moment before concluding there is nothing left.
                if (available.length && staleRefetches < MAX_STALE_REFETCHES) {
                    staleRefetches++;
                    ui.note(`rep4rep is still offering the same target(s); re-checking in ` +
                            `${STALE_REFETCH_WAIT_MS / 1000}s (${staleRefetches}/${MAX_STALE_REFETCHES})`);
                    await sleep(STALE_REFETCH_WAIT_MS);
                    continue;
                }
                ui.exhausted(available.length > 0, profile.personaName);
                stoppedBecause = 'no-tasks';
                break;
            }

            staleRefetches = 0;
            const room = tracking
                ? Math.min(batchSize, count - posted, quota.getUsage(steamId64, limit).remaining)
                : Math.min(batchSize, count - posted);
            pending = fresh.slice(0, Math.max(1, room));
            ui.fetched(fetches, fresh.length, pending);
        }

        const task = pending[0];
        const label = `[${posted + 1}/${count}] ${task.targetSteamProfileName}`;

        // 3. Post on Steam. This is what actually consumes the allowance.
        try {
            await post(task.targetSteamProfileId, task.requiredCommentText);
            if (tracking) quota.recordComment(steamId64);
            posted++;
            seenTasks.add(task.taskId);
            seenTargets.add(String(task.targetSteamProfileId));
            pending.shift();
        } catch (err) {
            if (isRateLimit(err)) {
                const u = tracking ? quota.getUsage(steamId64, limit) : { resetAt: null };
                const until = u.resetAt && u.resetAt > now() ? u.resetAt : now() + HOUR_MS;
                if (tracking) quota.setCooldown(steamId64, until);

                ui.bad(`${label} Steam is throttling: ${err.message}`);

                if (!wait || waits >= MAX_WAITS) {
                    ui.blocked('cooling down', until, wait);
                    stoppedBecause = 'cooldown';
                    break;
                }
                waits++;
                await countdown(until, 'cooldown ends in');
                if (tracking) quota.clearCooldown(steamId64);
                continue; // same task is still at the head of `pending`
            }

            // A real refusal (private profile, comments closed). Drop it and move on.
            ui.bad(`${label} ${err.message}`);
            failed++;
            seenTasks.add(task.taskId);
            seenTargets.add(String(task.targetSteamProfileId));
            pending.shift();
            continue;
        }

        // 4. Tell rep4rep. A failure here leaves the comment posted but unpaid, so it is
        //    reported separately rather than silently counted as done.
        try {
            await r4r.completeTask(task.taskId, task.requiredCommentId, profile.id);
            ui.ok(`${label} posted and marked complete`);
            done++;
        } catch (err) {
            ui.bad(`${label} posted on Steam, but rep4rep rejected the completion: ${err.message}`);
            failed++;
        }

        if (posted < count) {
            const pause = randBetween(minDelay, maxDelay);
            ui.note(`waiting ${pause.toFixed(1)}s`);
            await sleep(pause * 1000);
        }
    }

    return { done, failed, posted, fetches, waits, stoppedBecause };
}
