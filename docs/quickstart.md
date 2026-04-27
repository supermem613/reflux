# Quickstart

A complete walkthrough from clone to verified routing in seven steps. Uses
placeholder names — substitute your own GitHub logins, orgs, and repo
paths.

Throughout this doc:

- `<personal-login>` — your personal GitHub login (e.g. as it appears in
  `gh auth status`)
- `<work-login>` — your work / EMU GitHub login
- `<work-org>` — a GitHub org that should route to your work identity
- `<personal-repo>`, `<work-repo>`, `<dual-remote-repo>` — paths to local
  clones you want to test against

## 1. Build & link

```powershell
cd C:\path\to\reflux
npm install
npm run build
npm link        # makes `reflux` and `git-credential-reflux` global
reflux --version
```

`npm link` creates global symlinks pointing at this checkout, so
`reflux update` (which runs `git pull && npm install && npm run build` in
this dir) updates your installed binary in place.

## 2. Sign `gh` into each identity (one-time)

```powershell
gh auth status
# Confirm any accounts already signed in.

gh auth login --hostname github.com
# Pick: HTTPS → "Login with a web browser" → sign in as <work-login>
# (Repeat for each identity you want reflux to route to.)

gh auth status
# Should now list every identity you'll use, e.g.:
# github.com
#   ✓ Logged in to github.com account <personal-login> (keyring)
#   - Active account: true
#   ✓ Logged in to github.com account <work-login> (keyring)
#   - Active account: false
```

The "Active account" line doesn't matter to reflux — reflux always asks
`gh` for a specific account by name, never the active one.

## 3. Configure reflux profiles + mappings

```powershell
reflux profile add personal --gh-user <personal-login>
reflux profile add work     --gh-user <work-login>

# Longest-prefix wins. List the most specific routes first; they all coexist.
reflux map add https://github.com/<work-org>/         work
reflux map add https://github.com/<work-login>/       work
reflux map add https://github.com/<personal-login>/   personal
# Optional fall-through for any other URL on github.com:
reflux map add https://github.com/                    personal

reflux status    # ● next to each signed-in profile; mappings sorted by priority
reflux doctor    # all checks should be ✓
```

`reflux profile add` rejects unknown gh users with a warning; `reflux map
add` rejects mappings that point at a non-existent profile.

## 4. Smoke-test routing without touching git

```powershell
reflux map resolve https://github.com/<work-org>/<work-repo>.git
# → https://github.com/<work-org>/<work-repo> → work

reflux map resolve https://github.com/<personal-login>/<personal-repo>.git
# → https://github.com/<personal-login>/<personal-repo> → personal

# Drive the helper protocol directly to prove `gh` returns a token:
"protocol=https`nhost=github.com`npath=<work-org>/<work-repo>.git`n" | git-credential-reflux get
# Expected:
# username=<work-login>
# password=gho_...
```

This step is fully local — no git, no network, no credential prompts.

## 5. Wire reflux into git

```powershell
reflux install
git config --global --get-all credential.https://github.com.helper
# Expected output (in this order):
#   ""
#   reflux
```

`reflux install` is idempotent — running it twice is harmless. Other URL
scopes (e.g. `dev.azure.com`) are untouched and continue to use whatever
helper you had before.

## 6. Real-world test against your repos

```powershell
# Work repo (must route to <work-login>):
cd <work-repo>; git fetch

# Personal repo (must route to <personal-login>):
cd <personal-repo>; git fetch

# Dual-remote repo (the case GCM can't handle):
cd <dual-remote-repo>
git remote -v
# origin  https://github.com/<personal-login>/<repo>.git    (personal route)
# work    https://github.com/<work-org>/<repo>.git          (work route)
git fetch --all   # each remote routes independently
```

If any push/fetch silently re-prompts you, that's the `gh` session
expiring (most often the EMU 12h cap). Run `reflux login <profile>` once
and the next ~12h are silent again.

## 7. Tail the log to watch routing decisions

```powershell
# Live log in a separate pane:
Get-Content $env:LOCALAPPDATA\reflux\logs\reflux.log -Wait -Tail 0

# Or, for one-shot live debug to stderr:
$env:REFLUX_DEBUG = "1"
cd <work-repo>; git fetch
```

The log will show one line per helper invocation with the URL, the
matching mapping (or `passthrough`), the resolved profile, and the gh
user used.

## Rollback

If anything goes wrong and you want to step back:

```powershell
reflux uninstall          # removes reflux from .gitconfig, restores GCM
npm unlink -g reflux      # remove global symlinks
# ~/.reflux/config.json, your gh logins, and your repos are untouched.
```

To go all the way back to vanilla:

```powershell
reflux uninstall
Remove-Item $HOME\.reflux -Recurse
gh auth logout --hostname github.com   # repeat per identity if you want
```

## What to expect

- **First fetch of the day per identity:** may still prompt, because the
  underlying gh OAuth token may have expired. This is the EMU 12h cap;
  reflux can't dodge it. After one prompt per identity, every repo behind
  that identity is silent for the rest of the cap window.
- **Routing seems wrong:** check `reflux map list` for overlap. Mappings
  are listed in resolution order (longest prefix first); the first match
  wins.
- **Auth fails with reflux installed:** set `REFLUX_DEBUG=1` and re-run
  the failing git command. The log will show exactly which path the
  helper took.
