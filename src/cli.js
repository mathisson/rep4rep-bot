#!/usr/bin/env node
import { Command } from 'commander';
import prompts from 'prompts';

import { getApiToken, readSessions, writeSessions, SESSIONS_PATH } from './config.js';
import { Rep4Rep } from './rep4rep.js';
import { steamLogin, postProfileComment } from './steam.js';

/* ------------------------------------------------------------------ */
/* output                                                              */
/* ------------------------------------------------------------------ */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = code => s => (useColor ? `[${code}m${s}[0m` : String(s));
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

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

const program = new Command();

program
    .name('rep4rep')
    .description('Complete Rep4Rep comment tasks from the terminal.')
    .version('1.0.0')
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
        if (!names.length) return note(`No cached sessions. Run: npm start -- login`);
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
                say(`  ${c.bold(p.personaName)}  ${c.dim(p.id)}  ${p.steamId}  comments: ${flag}`);
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
    .command('run')
    .description('Post the required comments for a batch of tasks, then mark them complete')
    .option('-n, --count <n>', 'how many tasks to do', v => parseInt(v, 10), 3)
    .option('--min <seconds>', 'minimum pause between comments', v => parseFloat(v), 20)
    .option('--max <seconds>', 'maximum pause between comments', v => parseFloat(v), 45)
    .option('-a, --account <name>', 'Steam account to post from')
    .option('-d, --dry-run', 'show what would be posted, post nothing')
    .option('-y, --yes', 'skip the confirmation prompt')
    .action(async o => {
        let session = null;
        try {
            const count = Number.isFinite(o.count) && o.count > 0 ? o.count : 3;
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

            const all = await r4r.getTasks(profile.id);
            if (!all.length) return note(`No tasks available for ${profile.personaName} right now.`);

            const batch = all.slice(0, count);
            say('');
            say(c.dim(`${all.length} task(s) available, doing ${batch.length} as ${profile.personaName}:`));
            for (const t of batch) {
                say(`  ${t.targetSteamProfileName} ${c.dim(t.targetSteamProfileId)} ${c.blue('"' + t.requiredCommentText + '"')}`);
            }
            say('');

            if (o.dryRun) {
                note('Dry run -- nothing was posted.');
                return;
            }

            if (!o.yes) {
                const { go } = await prompts({
                    type: 'confirm',
                    name: 'go',
                    message: `Post ${batch.length} comment(s) from ${profile.personaName}?`,
                    initial: true,
                });
                if (!go) return note('Cancelled.');
            }

            let done = 0;
            let failed = 0;

            for (const [i, t] of batch.entries()) {
                const label = `[${i + 1}/${batch.length}] ${t.targetSteamProfileName}`;
                try {
                    await postProfileComment(session.community, t.targetSteamProfileId, t.requiredCommentText);
                    await r4r.completeTask(t.taskId, t.requiredCommentId, profile.id);
                    ok(`${label} posted and marked complete`);
                    done++;
                } catch (err) {
                    bad(`${label} ${err.message}`);
                    failed++;
                }

                if (i < batch.length - 1) {
                    const wait = randBetween(minDelay, maxDelay);
                    note(`waiting ${wait.toFixed(1)}s`);
                    await sleep(wait * 1000);
                }
            }

            say('');
            const after = await r4r.getUser().catch(() => null);
            const points = after ? `  ${c.green(after.points + ' points')}${after.pendingPoints ? c.dim(` (${after.pendingPoints} pending)`) : ''}` : '';
            say(`${c.bold(`${done} completed`)}, ${failed} failed.${points}`);
            if (failed) process.exitCode = 1;
        } catch (err) {
            fail(err.message);
        } finally {
            session?.logOff();
        }
    });

await program.parseAsync(process.argv);
