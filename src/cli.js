#!/usr/bin/env node
import { Command } from 'commander';
import prompts from 'prompts';

import { getApiToken, readSessions, writeSessions, SESSIONS_PATH } from './config.js';
import { Rep4Rep } from './rep4rep.js';
import { steamLogin, postProfileComment } from './steam.js';
import { countdown, formatDuration, formatClock } from './countdown.js';
import { runTasks } from './runner.js';
import {
    getUsage, recordComment, setCooldown, clearCooldown, resetQuota,
    allAccounts, DEFAULT_LIMIT, QUOTA_PATH,
} from './quota.js';

/* ------------------------------------------------------------------ */
/* output                                                              */
/* ------------------------------------------------------------------ */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = code => s => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const c = {
    dim: paint('2'),
    bold: paint('1'),
    red: paint('31'),
    green: paint('32'),
    yellow: paint('33'),
    blue: paint('36'),
};

const say = (...a) => console.log(...a);
const ok = m => say(c.green('  ok  ') + m);
const bad = m => say(c.red(' fail ') + m);
const note = m => say(c.dim('       ' + m));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randBetween = (a, b) => a + Math.random() * (b - a);

/** rep4rep hands out tasks a few at a time; this is how many we take per fetch. */
const DEFAULT_BATCH = 3;

function fail(message) {
    bad(message);
    process.exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* shared plumbing                                                     */
/* ------------------------------------------------------------------ */

const api = opts => new Rep4Rep(getApiToken(opts.token));

/** Resolve a rep4rep profile from an internal id, a steamID64, or the only linked one. */
function pickProfile(profiles, wanted) {
    if (!profiles.length) {
        throw new Error('No Steam profiles are linked to your rep4rep account. Add one with: npm start -- add <steamProfile>');
    }
    if (!wanted) {
        if (profiles.length === 1) return profiles[0];
        const list = profiles.map(p => `${p.personaName} (${p.id} / ${p.steamId})`).join('\n         ');
        throw new Error(`Several profiles are linked -- choose one with --profile:\n         ${list}`);
    }
    const match = profiles.find(p => p.id === wanted || String(p.steamId) === String(wanted));
    if (!match) throw new Error(`No linked profile matches "${wanted}".`);
    return match;
}

const describeTask = t =>
    `  ${t.targetSteamProfileName} ${c.dim(t.targetSteamProfileId)} ${c.blue('"' + t.requiredCommentText + '"')}`;

/** How the runner reports progress. Kept here so the loop itself stays presentation-free. */
const runnerUi = {
    say,
    ok,
    bad,
    note,
    fetched(n, offered, taken) {
        say('');
        say(c.dim(`fetch ${n}: ${offered} new target(s) offered, taking ${taken.length}`));
        for (const t of taken) say(describeTask(t));
    },
    blocked(why, until, waiting) {
        say('');
        note(`${why}. Next slot ${formatClock(until)}, in ${formatDuration(until - Date.now())}.`);
        if (!waiting) note('Re-run with --wait to sit it out and continue automatically.');
    },
    exhausted(someOffered, personaName) {
        say('');
        note(someOffered
            ? 'rep4rep has no new targets for this profile right now.'
            : `No tasks available for ${personaName} right now.`);
    },
};

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

const program = new Command();

program
    .name('rep4rep')
    .description('Complete Rep4Rep comment tasks from the terminal.')
    .version('1.2.0')
    .option('--token <token>', 'rep4rep API token (overrides REP4REP_TOKEN in .env)');

program
    .command('login')
    .description('Log into Steam once and cache the refresh token for later runs')
    .option('-a, --account <name>', 'Steam account name')
    .action(async o => {
        try {
            const session = await steamLogin({ account: o.account, interactive: true });
            ok(`Logged in as ${c.bold(session.accountName)} (${session.steamId64})`);
            note(session.savedToken
                ? `Refresh token cached in ${SESSIONS_PATH}`
                : 'Reused the existing cached token.');
            session.logOff();
        } catch (err) {
            fail(err.message);
        }
    });

program
    .command('logout')
    .description('Forget a cached Steam refresh token')
    .option('-a, --account <name>', 'Steam account name')
    .action(o => {
        const sessions = readSessions();
        const names = Object.keys(sessions);
        if (!names.length) return note('No cached sessions.');

        const target = o.account || (names.length === 1 ? names[0] : null);
        if (!target) return fail(`Several accounts are cached (${names.join(', ')}) -- pick one with --account.`);
        if (!sessions[target]) return fail(`No cached session for "${target}".`);

        delete sessions[target];
        writeSessions(sessions);
        ok(`Forgot the cached session for ${target}.`);
    });

program
    .command('sessions')
    .description('List cached Steam sessions')
    .action(() => {
        const sessions = readSessions();
        const names = Object.keys(sessions);
        if (!names.length) return note('No cached sessions. Run: npm start -- login');
        say(c.dim(SESSIONS_PATH));
        for (const name of names) {
            say(`  ${c.bold(name)}  ${sessions[name].steamId}  ${c.dim('saved ' + sessions[name].savedAt)}`);
        }
    });

program
    .command('status')
    .description('Show your rep4rep account, points and linked profiles')
    .action(async () => {
        try {
            const r4r = api(program.opts());
            const [user, profiles] = await Promise.all([r4r.getUser(), r4r.getSteamProfiles()]);

            say(`${c.bold(user.username)}  ${c.green(user.points + ' points')}` +
                (user.pendingPoints ? c.dim(`  (${user.pendingPoints} pending)`) : ''));
            say('');
            say(c.dim('linked steam profiles'));
            for (const p of profiles) {
                const flag = p.canReceiveComment ? c.green('open') : c.yellow('closed');
                const usage = getUsage(String(p.steamId));
                say(`  ${c.bold(p.personaName)}  ${c.dim(p.id)}  ${p.steamId}  comments: ${flag}` +
                    c.dim(`  ${usage.used}/${usage.limit} used today`));
            }
        } catch (err) {
            fail(err.message);
        }
    });

program
    .command('profiles')
    .description('List the Steam profiles linked to your rep4rep account')
    .action(async () => {
        try {
            const profiles = await api(program.opts()).getSteamProfiles();
            for (const p of profiles) say(`${c.dim(p.id)}  ${p.steamId}  ${p.personaName}`);
        } catch (err) {
            fail(err.message);
        }
    });

program
    .command('add')
    .argument('<steamProfile>', 'profile URL, SteamID64 or custom id')
    .description('Link a Steam profile to your rep4rep account')
    .action(async steamProfile => {
        try {
            const res = await api(program.opts()).addSteamProfile(steamProfile);
            ok(res.success || 'Added.');
        } catch (err) {
            fail(err.message);
        }
    });

program
    .command('tasks')
    .description('List the comment tasks currently available')
    .option('-p, --profile <id>', 'rep4rep profile id or SteamID64')
    .action(async o => {
        try {
            const r4r = api(program.opts());
            const profile = pickProfile(await r4r.getSteamProfiles(), o.profile);
            const tasks = await r4r.getTasks(profile.id);

            if (!tasks.length) return note(`No tasks available for ${profile.personaName} right now.`);

            say(c.dim(`${tasks.length} task(s) for ${profile.personaName}`));
            for (const t of tasks) {
                say(`  ${c.bold(t.targetSteamProfileName)}  ${c.dim(t.targetSteamProfileId)}`);
                say(`    ${c.blue('"' + t.requiredCommentText + '"')}`);
            }
        } catch (err) {
            fail(err.message);
        }
    });

program
    .command('quota')
    .description('Show how much of the 24h comment allowance each account has used')
    .option('--reset [steamId]', 'forget recorded usage (all accounts, or just one)')
    .action(o => {
        if (o.reset !== undefined) {
            const one = typeof o.reset === 'string' ? o.reset : undefined;
            resetQuota(one);
            return ok(one ? `Reset usage for ${one}.` : 'Reset usage for all accounts.');
        }

        const accounts = allAccounts();
        if (!accounts.length) return note('No comments recorded yet.');

        say(c.dim(QUOTA_PATH));
        for (const a of accounts) {
            const colour = a.remaining === 0 ? c.red : a.remaining <= 2 ? c.yellow : c.green;
            let line = `  ${a.steamId}  ${colour(`${a.used}/${a.limit}`)} used`;
            if (a.remaining === 0 && a.resetAt) {
                line += c.dim(`  next slot ${formatClock(a.resetAt)} in ${formatDuration(a.resetAt - Date.now())}`);
            }
            if (a.cooldownUntil && a.cooldownUntil > Date.now()) {
                line += c.yellow(`  cooling down ${formatDuration(a.cooldownUntil - Date.now())}`);
            }
            say(line);
        }
    });

program
    .command('ui')
    .description('Serve the browser UI on localhost')
    .option('-p, --port <n>', 'port to listen on', v => parseInt(v, 10), 4666)
    .action(async o => {
        try {
            const { serve } = await import('./server.js');
            await serve(o.port);
            ok(`UI on ${c.bold(`http://127.0.0.1:${o.port}`)}`);
            note('Loopback only. Ctrl-C to stop.');
        } catch (err) {
            fail(err.code === 'EADDRINUSE' ? `Port ${o.port} is already in use.` : err.message);
        }
    });

program
    .command('run')
    .description('Work through comment tasks, re-fetching from rep4rep as each batch is finished')
    .option('-n, --count <n>', 'total comments to post this run', v => parseInt(v, 10), DEFAULT_LIMIT)
    .option('-b, --batch <n>', 'how many to take per fetch', v => parseInt(v, 10), DEFAULT_BATCH)
    .option('-l, --limit <n>', 'comments allowed per account per 24h', v => parseInt(v, 10), DEFAULT_LIMIT)
    .option('--min <seconds>', 'minimum pause between comments', v => parseFloat(v), 20)
    .option('--max <seconds>', 'maximum pause between comments', v => parseFloat(v), 45)
    .option('-a, --account <name>', 'Steam account to post from')
    .option('-w, --wait', 'wait out cooldowns and keep going instead of exiting')
    .option('--ignore-quota', 'ignore the locally tracked 24h allowance')
    .option('-d, --dry-run', 'show what would be posted, post nothing')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(async o => {
        let session = null;
        try {
            const limit = Number.isFinite(o.limit) && o.limit > 0 ? o.limit : DEFAULT_LIMIT;
            const count = Number.isFinite(o.count) && o.count > 0 ? o.count : limit;
            const batchSize = Number.isFinite(o.batch) && o.batch > 0 ? o.batch : DEFAULT_BATCH;
            const minDelay = Math.max(0, o.min);
            const maxDelay = Math.max(minDelay, o.max);

            const r4r = api(program.opts());

            // Dry runs never need Steam, so only log in when we are really posting.
            let steamId64 = null;
            if (!o.dryRun) {
                session = await steamLogin({ account: o.account });
                steamId64 = session.steamId64;
                ok(`Steam: ${c.bold(session.accountName)} (${steamId64})`);
            }

            const profiles = await r4r.getSteamProfiles();
            const profile = steamId64
                ? profiles.find(p => String(p.steamId) === steamId64)
                : pickProfile(profiles, o.account);

            if (!profile) {
                throw new Error(
                    `The Steam account you logged in as (${steamId64}) is not linked to your rep4rep ` +
                    `account. Linked: ${profiles.map(p => p.steamId).join(', ') || 'none'}`
                );
            }

            const tracking = Boolean(steamId64) && !o.ignoreQuota;
            if (tracking) {
                const u = getUsage(steamId64, limit);
                note(`${u.used}/${limit} comments used in the last 24h, ${u.remaining} left.`);
            }

            if (o.dryRun) {
                const available = await r4r.getTasks(profile.id);
                if (!available.length) return note(`No tasks available for ${profile.personaName} right now.`);
                say('');
                say(c.dim(`rep4rep is offering ${available.length} task(s) right now:`));
                for (const t of available) say(describeTask(t));
                say('');
                note(`A real run would do ${batchSize} of these, then re-fetch for the next set, ` +
                     `up to ${count} comment(s) total.`);
                note('Dry run -- nothing was posted.');
                return;
            }

            if (!o.yes) {
                const { go } = await prompts({
                    type: 'confirm',
                    name: 'go',
                    message: `Post up to ${count} comment(s) from ${profile.personaName}, ${batchSize} per fetch?`,
                    initial: true,
                });
                if (!go) return note('Cancelled.');
            }

            const result = await runTasks({
                r4r,
                post: (target, text) => postProfileComment(session.community, target, text),
                profile,
                steamId64,
                tracking,
                quota: { getUsage, recordComment, setCooldown, clearCooldown },
                ui: runnerUi,
                countdown,
                sleep,
                randBetween,
                count,
                batchSize,
                limit,
                minDelay,
                maxDelay,
                wait: o.wait,
            });

            const { done, failed, fetches } = result;
            say('');
            const after = await r4r.getUser().catch(() => null);
            const points = after
                ? `  ${c.green(after.points + ' points')}${after.pendingPoints ? c.dim(` (${after.pendingPoints} pending)`) : ''}`
                : '';
            say(`${c.bold(`${done} completed`)}, ${failed} failed, over ${fetches} fetch(es).${points}`);

            if (tracking) {
                const u = getUsage(steamId64, limit);
                note(`${u.used}/${limit} used in the last 24h` +
                    (u.remaining === 0 && u.resetAt
                        ? `, next slot in ${formatDuration(u.resetAt - Date.now())}`
                        : `, ${u.remaining} left`));
            }

            if (failed) process.exitCode = 1;
        } catch (err) {
            fail(err.message);
        } finally {
            session?.logOff();
        }
    });

await program.parseAsync(process.argv);
