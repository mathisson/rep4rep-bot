# rep4rep-cli

Completes [Rep4Rep](https://rep4rep.com) comment tasks from the terminal, using the
[public API](https://rep4rep.github.io/rep4rep-api-doc/) and the Steam client protocol.

This replaces the manual loop on the *Gain Points* tab — view tasks, copy, open profile,
paste, go back, verify — with one command.

## How it works

| Step | Where |
| --- | --- |
| Find your linked profile and its internal rep4rep id | `GET /pub-api/user/steamprofiles` |
| Fetch available tasks (target profile + required comment text) | `GET /pub-api/tasks` |
| Post the comment on the target's Steam profile | Steam client session |
| Mark the task complete so rep4rep verifies it | `POST /pub-api/tasks/complete` |

The rep4rep API cannot post to Steam for you, so the CLI logs into Steam itself with
`steam-user` and posts through `steamcommunity`. Your password is never written to disk —
only the refresh token Steam issues after a successful login, in
`~/.rep4rep-cli/sessions.json` (mode `600`).

## Setup

```bash
npm install
```

Copy the env template and paste your API token from <https://rep4rep.com/user/settings/>:

```bash
cp .env.example .env
```

Then log into Steam once. You will be prompted for your username, password and Steam Guard
code; afterwards every run is unattended.

```bash
npm start -- login
```

## Usage

Check that everything is wired up:

```bash
npm start -- status
```

See what is waiting, without posting anything:

```bash
npm start -- tasks
```

Do a full day's allowance — 10 comments — in one process, with a random 20–45s pause
between each:

```bash
npm start -- run
```

rep4rep only offers a few targets at a time and never the same target twice, so a single
fetch cannot fill a run of 10. The run takes 3, posts them, then fetches again for the next
set, repeating until it reaches `--count` or rep4rep runs dry:

```
fetch 1: 3 new target(s) offered, taking 3
  someone      76561198...  "gg"
  ...
  ok  [3/10] someone posted and marked complete

fetch 2: 3 new target(s) offered, taking 3
```

Change the per-fetch size with `--batch` if rep4rep ever serves a different number.

If you want it to sit through cooldowns and keep going rather than exiting, add `--wait`:

```bash
npm start -- run --wait
```

Preview a run without logging into Steam or posting:

```bash
npm start -- run --dry-run
```

### Commands

| Command | Purpose |
| --- | --- |
| `login` | Log into Steam and cache the refresh token |
| `logout` | Forget a cached refresh token |
| `sessions` | List cached Steam sessions |
| `status` | Your rep4rep account, points and linked profiles |
| `profiles` | Just the linked profiles |
| `add <steamProfile>` | Link a Steam profile (URL, SteamID64 or custom id) |
| `tasks` | List available tasks |
| `quota` | Show the 24h allowance used per account |
| `run` | Post a batch of comments and mark them complete |

### `run` options

| Flag | Default | Meaning |
| --- | --- | --- |
| `-n, --count <n>` | `10` | Total comments to post this run |
| `-b, --batch <n>` | `3` | How many to take per fetch from rep4rep |
| `-l, --limit <n>` | `10` | Comments allowed per account per 24h |
| `--min <seconds>` | `20` | Minimum pause between comments |
| `--max <seconds>` | `45` | Maximum pause between comments |
| `-a, --account <name>` | — | Which cached Steam account to post from |
| `-w, --wait` | — | Sit through cooldowns and continue instead of exiting |
| `--ignore-quota` | — | Ignore the locally tracked allowance |
| `-d, --dry-run` | — | Show the plan, post nothing, no Steam login |
| `-y, --yes` | — | Skip the confirmation prompt |

Global: `--token <token>` overrides `REP4REP_TOKEN` for a single invocation.

A task is only marked complete after its comment posts successfully, so a failure part-way
through leaves the remaining tasks untouched and available on the next run.

`--count` counts comments that actually landed. If a target refuses the comment (private
profile, comments disabled) it is dropped, never retried, and the run fetches another
target to make up for it.

## Settings

The gear in the title bar opens a page showing where the app keeps its data, with a
button to open that folder, and each stored file listed separately with what removing it
actually costs. There is deliberately no single "clear everything" button: the ledger is
the only thing holding a run under Steam’s own limit, and wiping it alongside a harmless
log would be an easy mistake to make.

Run settings -- comments per run, per-fetch size, pauses and the two toggles -- save
themselves as you change them, so nothing has to be re-entered next launch.

It also links a Steam profile to your rep4rep account (the CLI `add`), sets a per-account
daily limit for accounts Steam treats differently, and lists the unrecognised refusals
described below. An account limit matching the shared default is stored as no override at
all, so changing the default still moves it.

## Running it daily

The allowance is per day, so the natural pattern is one run a day. Double-click
**`schedule.cmd`** to set that up as a Windows task — it runs headless, with the app
closed, using the sign-ins already saved.

```
schedule.cmd          set it up (09:00 by default)
schedule.cmd 21:30    move it
schedule.cmd /status  when it next runs
schedule.cmd /log     what it did
schedule.cmd /remove  stop it
```

Each run appends to `~/.rep4rep-cli/daily.log`. The task runs `run-daily.cmd`, which is
just the CLI with the confirmation prompt skipped.

When a run finishes in the desktop app and its window is not in front, it posts a desktop
notification with the tally. Clicking it brings the window back.

## When comments are refused

Steam's throttling messages are matched against a short list of patterns. Anything outside
it is treated as a permanent refusal and the task is dropped, so a throttle worded in a way
the list does not cover silently burns a task.

Every unrecognised refusal is appended to `~/.rep4rep-cli/steam-errors.log`, with the
timestamp and the target it came from:

```bash
npm start -- errors
```

```
3 refusal(s), 2 distinct

     2  The settings on this account do not allow you to add comments
     1  Some brand new Steam message
```

The first is a genuine refusal. A message that repeats and is not one of those is the
signal that a throttle pattern is missing from the list in `src/steam.js`.

## Tests

```bash
npm test
```

Covers the fetch/post/re-fetch loop and the 24h ledger, both driven with fakes — no Steam
login, no network, and the quota suite runs against a throwaway home directory.

## The 24h allowance

Steam allows roughly 10 profile comments per account per 24 hours. The CLI keeps its own
ledger in `~/.rep4rep-cli/quota.json` so the count survives restarts — one run of 10 and
ten runs of 1 are treated identically.

The window is **rolling, not a midnight reset**. Each comment is stamped and ages out
exactly 24 hours later, so slots come back one at a time rather than all at once.

```bash
npm start -- quota
```

```
  76561198...  10/10 used  next slot Fri 19:33 in 3h 24m 09s
```

Before every comment the run checks the ledger. If the allowance is spent, or Steam has
throttled the account, it either prints when the next slot opens and exits, or — with
`--wait` — shows a live countdown and resumes on its own:

```
       allowance spent (10/10).
       next slot in 3h 24m 09s  (at Fri 19:33)
```

When Steam returns a throttling error mid-run, that is recorded as a cooldown and the same
handling applies. The task being posted is retried rather than skipped, so nothing is lost.

If the ledger ever drifts out of step with reality — you commented from the Steam website,
or moved machines — clear it:

```bash
npm start -- quota --reset
```

`--ignore-quota` bypasses the ledger for a single run without erasing it. Steam's own limit
still applies; you just lose the early warning.

## Notes

- **Steam's Subscriber Agreement prohibits automated account interaction.** Using this puts
  the Steam account at risk of action from Valve. The delays exist to keep the pace
  human-ish, but they are not a guarantee.
- Steam rate-limits profile comments. If you see comments start failing, raise `--min` /
  `--max` and lower `-n`.
- `npm audit` reports issues in `request`, a deprecated transitive dependency of
  `steamcommunity`. It is unmaintained upstream and cannot be resolved without dropping
  that library.

## Desktop app

Double-click **`build.cmd`**. It installs dependencies, packages the app, and tells you
where the `.exe` landed:

```
dist\Rep4Rep-win32-x64\Rep4Rep.exe
```

Make a shortcut to that and you are done. On first launch the app asks for your rep4rep API
token and your Steam sign-in, then remembers both — no terminal needed.

To run it from source instead:

```bash
npm run app
```

An Electron window: profile cards with live allowance rings that drain as the day is spent,
run controls, a countdown while waiting out a cooldown, and an activity feed showing each
batch and comment as it goes out.

The main process is Node, so it drives the same `runTasks` engine as the CLI rather than a
second copy of the logic. The renderer is sandboxed — `contextIsolation` on,
`nodeIntegration` off — and reaches the main process through exactly four calls exposed in
`electron/preload.cjs`.

Your Steam password is sent straight to Steam and never written to disk — only the refresh
token Steam returns is saved, in `~/.rep4rep-cli/sessions.json`. The API token goes to
`~/.rep4rep-cli/.env`, which is also where a packaged `.exe` looks for it.

The CLI remains fully usable on its own — the app is an extra front end, not a replacement,
and `npm start -- login` still works if you prefer the terminal.
