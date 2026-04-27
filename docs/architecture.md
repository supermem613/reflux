# Architecture

Reflux is a thin per-URL router that sits on top of the [`gh`](https://cli.github.com) CLI.
Auth state, token storage, refresh logic, and credential lifecycle are all
delegated to `gh`. Reflux's contribution is per-URL identity routing — the
piece `gh auth git-credential` cannot do, because it only ever serves the
*active* account.

## Component diagram

```
                       ┌─────────────────────────┐
       git push  ─────►│  git-credential-reflux  │  (this repo's helper bin)
                       └────────────┬────────────┘
                                    │
                ┌───────────────────┼─────────────────────┐
                ▼                                          ▼
        ┌──────────────────┐                  ┌────────────────────────┐
        │ ~/.reflux/       │                  │ host not github.com?   │
        │   config.json    │                  │ no mapping match?      │
        │ profiles+maps    │                  │ → spawn GCM, pipe IO   │
        └────────┬─────────┘                  └────────────────────────┘
                 │ longest-prefix
                 ▼
        ┌──────────────────┐
        │ profile.ghUser   │
        └────────┬─────────┘
                 │
                 ▼
        ┌──────────────────────────────────────┐
        │ gh auth token --hostname github.com  │
        │            --user <ghUser>           │
        └────────┬─────────────────────────────┘
                 │
                 ▼
        username=<ghUser>\npassword=<token>\n\n  → git
```

## State ownership

| What | Where it lives | Who manages it |
|---|---|---|
| Reflux profiles + URL mappings | `~/.reflux/config.json` | reflux (zod-validated) |
| GitHub OAuth tokens | Windows Credential Manager (`gh:github.com:*`) | `gh` |
| `gh` account state (login, refresh, logout) | `gh`'s own state dir | `gh` |
| Helper logs | `%LOCALAPPDATA%\reflux\logs\reflux.log` | reflux |

Reflux does **not** persist tokens. Every `git push` calls `gh auth token`
fresh; there is no cache, so there is no cache invalidation problem.

## Hot path

```
git push origin main
  │
  ▼
git invokes the helper:  git-credential-reflux get
  │   stdin:
  │     protocol=https
  │     host=github.com
  │     path=acme/widgets.git
  │
  ▼
helper.handleGet(request)
  │   loadConfig()                       → ~/.reflux/config.json
  │   routeRequest(request, config)
  │     → host == "github.com"? yes
  │     → resolveProfileFromCredentialRequest(request, config)
  │         → normalize URL: https://github.com/acme/widgets
  │         → longest-prefix scan over config.mappings
  │         → returns "work"
  │     → kind: "reflux", profile: "work"
  │   getProfile("work", config)         → { name: "work", ghUser: "work-login" }
  │   getToken("work-login")
  │     → spawn gh auth token --hostname github.com --user work-login
  │     → ~30ms cold; returns "gho_..."
  │
  ▼
stdout:
  username=work-login
  password=gho_...

git authenticates and pushes.
```

Total cost: one config-file read, one `gh` subprocess invocation. Cache-free,
fork-free. The expensive part is the gh subprocess; that's the entire latency
budget.

## Routing semantics

Routing is purely structural — *the URL determines the identity*, not the
local repo, not the active branch, not the user's recent activity. This makes
the dual-remote repo case (one local repo with both personal and work
forks as separate remotes) trivially correct: each remote has a different
URL, each URL routes to a different profile, no special config required.

URL normalisation (`src/core/mapping.ts:normalizeRemoteUrl`) handles:

- `https://github.com/foo/bar.git` → `https://github.com/foo/bar`
- `https://GITHUB.COM/foo/bar` → `https://github.com/foo/bar`
- `git@github.com:foo/bar.git` → `https://github.com/foo/bar`
- `ssh://git@github.com/foo/bar.git` → `https://github.com/foo/bar`
- bare `github.com/foo/bar` → `https://github.com/foo/bar`

so a single mapping prefix covers every URL form a git remote might present.

## Routing decision

The router's three branches (`src/helper/route.ts`):

1. **Host outside reflux scope** (anything other than `github.com`) →
   passthrough to GCM. Reflux is github.com-only in v0.1.0.
2. **github.com with no matching mapping** → passthrough to GCM. Mapped
   identity is opt-in: unmapped GitHub repos keep working with whatever GCM
   has cached.
3. **github.com with a mapping** → reflux serves the request from `gh`.

## Why no token caching

Three reasons:

1. `gh auth token` is ~30ms — cheaper than the failure modes a cache
   introduces (stale token after `gh auth refresh`, stale token after the user
   ran `gh auth logout`, stale token after EMU revoked it server-side).
2. The Windows Credential Manager already caches `gh`'s tokens — adding a
   second cache means two writers, two truths, two stale-detection paths.
3. The git credential helper protocol is not on a hot loop. Even a 200ms
   round-trip per `git push` is not noticeable.

## Failure mode: gh has no token for the routed user

When `gh auth token --user X` fails (user isn't signed in, gh isn't
installed, gh's keyring is locked), reflux exits 0 with no output. Git
interprets this as "this helper had nothing to say" and moves to the next
configured helper — typically GCM, which will then prompt the user
interactively. The user sees one re-auth prompt, not a stack trace.

This is deliberate: reflux is in the hot path, git is blocked on it, and an
unrecoverable-from-the-helper failure should fail open to whatever git was
going to do without us.

## Failure mode: git rejects our token (`erase` action)

When git tells us `erase` (the credential we served was rejected), we log a
warning and exit 0 *without* calling `gh auth logout`. Logging the user out
of `gh` would also log out other tools (`gh repo clone`, gh's own credential
helper, anything else binding to that account) — far beyond what git is asking
us to do. The right recovery is `reflux login <profile>`, which the user runs
when they notice.

## Why pass through unmapped hosts to GCM?

Because reflux's value-add is per-identity routing for GitHub. Azure DevOps,
on-prem GitHub Enterprise, gitea, and self-hosted git instances are well
served by GCM today, often via Microsoft auth broker integration. Re-implementing
that scope would multiply the project's surface area for no user gain.

## Self-update

`reflux update` (`src/commands/update.ts`) follows the rotunda pattern:

1. Resolve the install repo from `import.meta.url` (`dist/commands/update.js`
   → repo root is two directories up).
2. `git pull --ff-only` in that repo.
3. `npm install --no-audit --no-fund`.
4. `npm run build`.

The update command runs in the same shell — there's no relauncher, no
PowerShell wrapper. Subsequent invocations of `reflux` pick up the new
`dist/`.
