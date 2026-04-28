# reflux

> Per-identity GitHub credential router for Windows. Routes git auth requests to the right `gh` CLI account so a single sign-in covers all your repos for the rest of the day.

If you push code to GitHub on Windows from a Microsoft EMU-managed account, you
have probably noticed that `git-credential-manager` (GCM) re-prompts you every
~12 hours. That alone is annoying; it gets worse if you also have a *personal*
GitHub account, because GCM caches a single token per host and gives you no
clean way to say "use this identity for one org and that one for my
personal forks."

**reflux solves the routing problem and consolidates the prompting.** It maps
remote URL prefixes to named identity profiles, where each profile is bound
to a `gh` CLI account. On every git auth request, reflux looks at the URL,
picks the right profile, and asks `gh auth token --user <login>` for the
live token. One `gh auth login` per identity covers every repo behind that
identity for as long as `gh`'s session lives.

reflux does not store tokens itself — `gh` owns that. reflux is a thin
per-URL router on top of `gh`'s multi-account auth.

## Why this beats raw GCM

| | GCM | reflux |
|---|---|---|
| Per-URL identity routing | ❌ one token per host | ✅ longest-prefix mapping → profile → gh user |
| Multi-remote repos (one repo, personal + work forks) | ❌ both remotes share one token | ✅ each remote routes independently |
| EMU 12h re-prompt | one prompt per repo per 12h | one `gh auth login` per identity per session |
| Falls back to GCM for unmapped hosts (ADO, etc.) | n/a | ✅ transparent passthrough |

## How it works

1. **`reflux profile add <name> --gh-user <login>`** — bind a friendly
   profile name to a GitHub login as it appears in `gh auth status`.
2. **`reflux login <name>`** — delegates to `gh auth login` if the profile's
   gh user isn't signed in yet. This is the only step that opens a browser.
3. **`reflux map add <url-prefix> <name>`** — route URLs starting with the
   prefix to the profile. Longest-prefix wins.
4. **`reflux install`** — register `git-credential-reflux` as a helper for
   `https://github.com` in your global `.gitconfig`, before the existing
   helper chain.

After install, every `git push` against github.com calls reflux first.
Reflux normalises the URL, picks the matching profile, asks `gh` for that
profile's token, and hands it to git. Anything reflux doesn't own (e.g.
`dev.azure.com`, GitHub Enterprise, gitea) passes through to vanilla GCM
unchanged.

## Quick start

```powershell
# Install prerequisites (one-time).
winget install --id GitHub.cli -e   # gh ≥ 2.40, required for multi-account auth

git clone https://github.com/marcusm/reflux ~/repos/reflux
cd ~/repos/reflux
npm install
npm run build
npm link

# Sign into the gh CLI for each identity (one-time, browser-based).
# When prompted, pick "GitHub.com → HTTPS → Login with a web browser".
gh auth login --hostname github.com   # do this once per identity

# Confirm gh sees both accounts:
gh auth status
# github.com
#   ✓ Logged in to github.com account <personal-login> (keyring)
#   - Active account: true
#   ✓ Logged in to github.com account <work-login> (keyring)
#   - Active account: false

# Bind reflux profiles to those gh logins.
reflux profile add personal --gh-user <personal-login>
reflux profile add work     --gh-user <work-login>

# Map remote URLs (longest prefix wins).
reflux map add https://github.com/<work-org>/      work
reflux map add https://github.com/<work-login>/    work
reflux map add https://github.com/                 personal

# Wire reflux into git.
reflux install
```

That's it. `reflux status` shows your profile and mapping state at a glance;
`reflux doctor` diagnoses installation problems.

## Multi-identity repos

Some repos push to both a personal and a work fork. Reflux routes per
**remote URL**, not per repo, so this just works:

```powershell
cd ~/repos/<dual-remote-repo>
git remote -v
# origin  https://github.com/<personal-login>/<repo>.git   (personal)
# work    https://github.com/<work-org>/<repo>.git         (work)

git push origin main   # → routed to personal → gh user <personal-login>
git push work main     # → routed to work     → gh user <work-login>
```

## Commands

| Command | What it does |
|---|---|
| `reflux profile add <name> --gh-user <login>` | Create a profile bound to a gh user |
| `reflux profile list` | List profiles and whether each gh user is signed in |
| `reflux profile remove <name>` | Remove a profile (does not touch gh) |
| `reflux profile show <name>` | Show details for a single profile |
| `reflux map add <prefix> <profile>` | Route URLs starting with `<prefix>` to `<profile>` |
| `reflux map list` | List mappings, sorted by resolution priority |
| `reflux map remove <prefix>` | Remove a mapping |
| `reflux map resolve <url>` | Show which profile a URL would resolve to (debugging) |
| `reflux login <profile>` | Delegate to `gh auth login` for the profile's gh user |
| `reflux logout <profile>` | Delegate to `gh auth logout` for the profile's gh user |
| `reflux status` | Show gh state, profiles, mappings |
| `reflux doctor` | Diagnose installation problems |
| `reflux install` | Register with git config |
| `reflux uninstall` | Reverse `install` |
| `reflux update` | Self-update: `git pull` → `npm install` → `npm run build` |

See [docs/commands.md](docs/commands.md) for full details.

## Documentation

- [docs/quickstart.md](docs/quickstart.md) — End-to-end install + verification walkthrough
- [docs/architecture.md](docs/architecture.md) — How reflux works in detail
- [docs/auth.md](docs/auth.md) — `gh` setup and the EMU 12h-cap reality
- [docs/configuration.md](docs/configuration.md) — `~/.reflux/config.json` schema
- [docs/commands.md](docs/commands.md) — Full command reference
- [docs/troubleshooting.md](docs/troubleshooting.md) — When things go wrong
- [docs/faq.md](docs/faq.md) — Common questions
- [docs/testing.md](docs/testing.md) — Running tests; what's mocked

## Requirements

- Windows 10 or 11
- Node.js ≥ 20
- [`gh`](https://cli.github.com) ≥ 2.40 (multi-account `--user` support) — install with `winget install --id GitHub.cli -e`
- `git-credential-manager` installed (used for passthrough on non-GitHub hosts)

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 Marcus Markiewicz.
