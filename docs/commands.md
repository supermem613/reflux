# Command reference

All commands take `--help` for inline usage. This page gives the full
intent + behaviour for each.

## `reflux profile`

Manage identity profiles. A profile is a named (alias, gh user) pair.

### `reflux profile add <name> --gh-user <login>`

Create a new profile bound to a `gh` user. Both arguments are required.

- `<name>` — `[a-z0-9-]+` starting with a letter or digit. Used as the git
  auth username and shown in `reflux profile list`.
- `--gh-user <login>` — the GitHub login as it appears in `gh auth status`.
  Case-sensitive. Reflux verifies (with a warning, not a hard error) that
  `gh` is signed in as this user, since the profile is useless until that's
  true.

Idempotency: rejects duplicate names.

### `reflux profile list`

List all profiles. Shows a `●` next to each profile whose gh user is
currently signed in, `○` otherwise.

### `reflux profile show <name>`

Show details for a single profile (gh user, sign-in state).

### `reflux profile remove <name>`

Remove a profile and any mappings that referenced it. Does **not** call
`gh auth logout` — that would affect other tools binding to the same
account. Use `reflux logout <name>` first if you want a full cleanup.

## `reflux map`

Manage URL → profile mappings. Resolution is longest-prefix wins after URL
normalisation.

### `reflux map add <prefix> <profile>`

Map a URL prefix to a profile. The profile must already exist. The prefix
is normalised before storage (lowercased host, `.git` stripped, SSH
rewritten), so the four forms below all map identically:

- `https://github.com/acme/`
- `https://GITHUB.COM/acme/`
- `github.com/acme/`
- `git@github.com:acme/`

### `reflux map list`

List all mappings, sorted by prefix length descending — i.e. resolution
order. Useful for spotting accidental shadowing.

### `reflux map remove <prefix>`

Remove a mapping by prefix. Normalises before matching, so the prefix you
pass doesn't have to be byte-identical to the stored form.

### `reflux map resolve <url>`

Show which profile a URL would resolve to. Useful for debugging:

```powershell
reflux map resolve https://github.com/acme/widgets.git
# https://github.com/acme/widgets → work
```

Exits 1 if no mapping matches (the URL would passthrough to GCM).

## `reflux login <profile>`

Sign into GitHub for a profile. Delegates to `gh auth login --hostname
github.com --git-protocol https --web` if the profile's gh user isn't
already signed in. If it is, prints a friendly "already signed in" and
exits.

After completion, verifies that `gh auth status` now reports the expected
gh user; warns if not (you may have signed in as a different account).

## `reflux logout <profile>`

Sign the profile's gh user out. Delegates to `gh auth logout --hostname
github.com --user <ghUser>`. Other gh accounts are unaffected.

## `reflux status`

Single-screen overview:

- `gh CLI` — installed? what version?
- `Profiles` — name, gh user, sign-in state per profile
- `Mappings` — sorted by resolution priority
- `gh accounts not bound to any profile` — gh accounts you signed into but
  haven't bound a reflux profile to. Helpful when you forget.

## `reflux doctor`

Checks each of the above and prints `✓` or `✗` per item. Exits non-zero if
any check fails. Run this after a fresh install or when something feels off.

Checks:
- `gh CLI` is on PATH and reports a version.
- `git-credential-manager` is on PATH (used for passthrough).
- `~/.reflux/config.json` parses cleanly.
- Each profile's gh user appears in `gh auth status`.

## `reflux install`

Register `git-credential-reflux` in `~/.gitconfig` for `https://github.com`,
preserving any pre-existing helper as a fallback.

The exact git config writes:

```
git config --global --add credential.https://github.com.helper ""
git config --global --add credential.https://github.com.helper reflux
```

The empty-string entry clears any inherited helper for the URL scope so
reflux runs first. Reflux itself passes through to GCM for unmapped URLs,
so the user gets the union of behaviours. Other URL scopes (e.g.
`dev.azure.com`) are untouched.

Idempotent — running it twice is harmless.

## `reflux uninstall`

Reverse of `install`. Removes the reflux entry from the helper list.
Leaves the empty-string entry alone (removing it would silently re-enable
inherited helpers the user may not remember adding).

Profiles, mappings, and `gh` accounts are left intact.

## `reflux update`

Self-update. Runs in the install repo:

1. `git pull --ff-only`
2. `npm install --no-audit --no-fund`
3. `npm run build`

If you cloned the repo to `~/repos/reflux` and `npm link`-ed the bin, this
gives you in-place updates.

## `reflux` (no args)

Prints the version banner and full help, exits 0.

## Environment variables

| Var | Purpose |
|---|---|
| `REFLUX_DEBUG=1` | Mirror log lines to stderr from the helper. Useful for live diagnosis; very chatty. |
| `REFLUX_GH_BIN` | Override the `gh` binary path. Used by tests; you should never set this in production. |
