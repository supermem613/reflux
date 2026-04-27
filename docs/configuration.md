# Configuration

Reflux's only config file is `~/.reflux/config.json`. It lives in your
homedir (not `%APPDATA%`) so you can hand-edit, version-control, and back
it up alongside other dotfiles.

## Schema

```json
{
  "version": 1,
  "profiles": [
    { "name": "personal", "ghUser": "<personal-login>" },
    { "name": "work",     "ghUser": "<work-login>" }
  ],
  "mappings": [
    { "prefix": "https://github.com/<work-org>/",   "profile": "work" },
    { "prefix": "https://github.com/<work-login>/", "profile": "work" },
    { "prefix": "https://github.com/",              "profile": "personal" }
  ]
}
```

### `version`

Always `1`. Reserved for future schema evolution.

### `profiles[]`

An ordered list. Each profile has:

| Field | Type | Notes |
|---|---|---|
| `name` | `string` matching `/^[a-z0-9][a-z0-9-]*/` | Friendly identifier used by reflux commands and shown to git as the auth username. |
| `ghUser` | `string` (non-empty) | The GitHub login as it appears in `gh auth status`. Reflux passes this verbatim to `gh auth token --user <ghUser>`. |

Profile names must be unique. Adding a profile via `reflux profile add` is
the recommended path (it validates), but hand-editing the JSON works too —
reflux re-validates on every read.

### `mappings[]`

An ordered list. Each mapping has:

| Field | Type | Notes |
|---|---|---|
| `prefix` | `string` (non-empty) | A URL prefix. Normalised before matching: lowercased host, `.git` suffix stripped, SSH form rewritten to HTTPS. |
| `profile` | `string` | Must reference an existing profile by name. |

The order in the file does not matter. Resolution is **longest-prefix
wins**. Ties (same prefix length, different profile) shouldn't occur in
practice — `reflux map add` rejects duplicates.

## Validation

`loadConfig` runs zod validation on every read. If the file is malformed,
reflux fails loudly with a structured error message. Common failures:

- **Unknown profile in a mapping** — you removed a profile via `reflux
  profile remove` but the mapping survived. (Shouldn't happen via the CLI;
  `profile remove` cleans up matching mappings. Hand-edits can leave stale
  references.) Fix: edit the file or run `reflux map remove <prefix>`.
- **Profile name with uppercase or special characters** — names must be
  `[a-z0-9-]+` starting with a letter or digit.
- **Empty `ghUser`** — required, must be a non-empty string.

## Locations

| Path | Contents |
|---|---|
| `~/.reflux/config.json` | This file. |
| `%LOCALAPPDATA%\reflux\logs\reflux.log` | Helper + CLI diagnostic log. |

Tokens are not stored by reflux. They live in `gh`'s keyring entries under
`gh:github.com:*` in Windows Credential Manager.

## Editing safely

```powershell
# Validate after a hand-edit:
reflux status

# Or use reflux's commands:
reflux profile add work --gh-user <work-login>
reflux map add https://github.com/<work-org>/ work
```

`reflux status` reads the file and re-parses it; an error there means the
file is malformed.

## Migrating between machines

The config file is portable. Copy `~/.reflux/config.json` to a new machine,
then on the new machine:

```powershell
gh auth login --hostname github.com   # repeat for each identity
reflux install
reflux status   # confirm everything resolves
```

`reflux install` is idempotent — run it on the new machine to register the
git helper.
