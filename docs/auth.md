# Authentication

Reflux delegates all authentication state to the [`gh`](https://cli.github.com)
CLI. This document explains:

1. How to set `gh` up for one or more accounts
2. How reflux uses `gh`'s tokens
3. The Microsoft EMU 12h cap and what reflux does about it

## Installing `gh`

```powershell
winget install GitHub.cli
gh --version   # >= 2.40
```

`gh`'s multi-account support (the `--user` flag on `auth token`) requires
gh ≥ 2.40. Older versions will fail in the helper hot path.

## Signing in

For each GitHub identity you have:

```powershell
gh auth login --hostname github.com
# Choose: GitHub.com → HTTPS → Login with a web browser
# A browser opens; sign in with the matching account.
```

You can repeat this for as many accounts as you need. `gh` keeps them all in
its keyring and exposes them via `--user`:

```powershell
gh auth status
# github.com
#   ✓ Logged in to github.com account <personal-login> (keyring)
#   - Active account: true
#   ✓ Logged in to github.com account <work-login> (keyring)
#   - Active account: false
```

The "Active account" line is the one `gh` uses by default for `gh repo
clone`, `gh issue create`, etc. Reflux ignores active-vs-inactive — it always
asks for the specific account a profile is bound to.

## Binding reflux profiles to `gh` users

```powershell
reflux profile add personal --gh-user <personal-login>
reflux profile add work     --gh-user <work-login>
```

The `--gh-user` value must match the login `gh auth status` reports
(case-sensitive). `reflux profile list` shows whether each profile's gh user
is currently signed in.

## What reflux actually calls

In the helper hot path, reflux runs:

```
gh auth token --hostname github.com --user <ghUser>
```

This returns the OAuth token (`gho_...`, 40 chars) `gh` already has cached
in Windows Credential Manager. Reflux pipes it back to git as the password,
with `<ghUser>` as the username. No browser, no network round-trip — fast
local lookup.

## The Microsoft EMU 12h cap

Microsoft EMU caps OAuth tokens at 12 hours and disables refresh tokens by
policy. This is why GCM re-prompts every 12h. **Using `gh` instead of GCM
does not eliminate the cap** — `gh` is using the same OAuth flow against
the same tenant.

What changes with reflux:

- **One re-prompt per identity per cap window**, not one per repo. With raw
  GCM, every distinct `https://github.com/...` repo path can incur its own
  prompt because GCM caches per-credential. With `gh`, all repos for a
  given identity share one cached token; one `gh auth login` covers them all
  for the next 12h.
- **The re-prompt is interactive at a moment of your choosing**, not when
  you happen to push. When `gh`'s token expires, you can run
  `gh auth login --hostname github.com` ahead of time and the next push
  works silently.
- **Reflux recovers when `gh`'s token is gone.** For mapped GitHub URLs,
  the helper warns and drives `gh auth login` for the mapped profile instead
  of falling through to a generic username/password prompt.

## What reflux does NOT do

- **Reflux does not register an OAuth App.** Reflux uses `gh`'s own
  client_id, which has GitHub's blessing for OAuth on personal and EMU
  accounts.
- **Reflux does not store tokens.** Every helper invocation asks `gh` for
  the live token. No reflux-side cache, no expiry tracking, no key rotation.
- **Reflux does not run a local OAuth callback server.** `gh auth login`
  uses the device flow (an 8-character code in the browser); no localhost
  port is opened.
- **Reflux does not touch your Edge profiles.** `gh auth login` opens your
  default browser; reflux is never in that path.

## Recovering from a stale token

If `git push` ever does fail with a credential rejection while reflux is
installed:

1. Reflux should print a warning and launch `gh auth login` for the mapped
   profile. Pick the matching account when prompted.
2. Retry the Git operation after the login completes.
3. If auto-login is disabled with `REFLUX_NO_AUTO_LOGIN=1`, run
   `reflux login <profile>` manually and retry.

`reflux logout <profile>` runs `gh auth logout --user <ghUser>` if you want
to force a clean re-auth.

## Per-identity logout without disturbing others

`reflux logout <profile>` only affects the gh account bound to that profile.
Other accounts in `gh`'s keyring are untouched.

```powershell
reflux logout work
# → gh auth logout --hostname github.com --user <work-login>
# personal account is unaffected
```
