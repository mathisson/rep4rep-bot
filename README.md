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

Do a batch of 3 (the default), with a random 20–45s pause between comments:

```bash
npm start -- run
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
| `run` | Post a batch of comments and mark them complete |

### `run` options

| Flag | Default | Meaning |
| --- | --- | --- |
| `-n, --count <n>` | `3` | How many tasks to do |
| `--min <seconds>` | `20` | Minimum pause between comments |
| `--max <seconds>` | `45` | Maximum pause between comments |
| `-a, --account <name>` | — | Which cached Steam account to post from |
| `-d, --dry-run` | — | Show the plan, post nothing, no Steam login |
| `-y, --yes` | — | Skip the confirmation prompt |

Global: `--token <token>` overrides `REP4REP_TOKEN` for a single invocation.

A task is only marked complete after its comment posts successfully, so a failure part-way
through leaves the remaining tasks untouched and available on the next run.

## Notes

- **Steam's Subscriber Agreement prohibits automated account interaction.** Using this puts
  the Steam account at risk of action from Valve. The delays exist to keep the pace
  human-ish, but they are not a guarantee.
- Steam rate-limits profile comments. If you see comments start failing, raise `--min` /
  `--max` and lower `-n`.
- `npm audit` reports issues in `request`, a deprecated transitive dependency of
  `steamcommunity`. It is unmaintained upstream and cannot be resolved without dropping
  that library.
