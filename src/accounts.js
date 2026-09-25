import { runTasks, Cancelled } from './runner.js';

// Re-exported so front ends import the cancel signal from one place.
export { Cancelled };

/** Gap between accounts, so Steam does not see back-to-back logins. */
export const SWITCH_DELAY_MS = 5000;

/**
 * Work through several Steam accounts in turn, running tasks for each.
 *
 * Shared by the CLI and the desktop app so there is one implementation of
 * "run these accounts", not one per front end. Every collaborator is injected,
 * which is also what makes it testable without Steam or the network.
 *
 * A Cancelled from `sleep` aborts the whole run; anything else fails just the
 * account it came from and the next one still gets its turn.
 */
export async function runAccounts({
    accounts,        // account names, in order
    login,           // async (name) => session { community, steamId64, accountName, logOff }
    post,            // async (session, targetSteamId64, text) => void
    r4r,
    quota,
    ui,              // runTasks' ui, plus account({ name, profile })
    countdown,
    sleep,
    randBetween,
    count,
    batchSize,
    limit,
    minDelay,
    maxDelay,
    wait = false,
    tracking = true,
    switchDelayMs = SWITCH_DELAY_MS,
}) {
    if (!accounts.length) throw new Error('No Steam accounts are signed in.');

    const total = { done: 0, failed: 0, fetches: 0, accounts: 0 };

    for (const [i, name] of accounts.entries()) {
        let session = null;

        try {
            ui.account({ name });
            session = await login(name);

            const profiles = await r4r.getSteamProfiles();
            const profile = profiles.find(p => String(p.steamId) === session.steamId64);

            if (!profile) {
                ui.bad(`${name} is not linked to your rep4rep account.`);
                total.failed++;
            } else {
                ui.account({ name, profile });
                total.accounts++;

                const r = await runTasks({
                    r4r,
                    post: (target, text) => post(session, target, text),
                    profile,
                    steamId64: session.steamId64,
                    tracking,
                    quota,
                    ui,
                    countdown,
                    sleep,
                    randBetween,
                    count,
                    batchSize,
                    limit,
                    minDelay,
                    maxDelay,
                    wait,
                });

                total.done += r.done;
                total.failed += r.failed;
                total.fetches += r.fetches;
            }
        } catch (err) {
            if (err instanceof Cancelled) throw err;   // stop everything
            ui.bad(`${name}: ${err.message}`);
            total.failed++;
        } finally {
            session?.logOff();
        }

        if (i < accounts.length - 1) {
            ui.note('Switching account…');
            await sleep(switchDelayMs);
        }
    }

    return total;
}
