# FAQ

## Why not just use `gh auth git-credential` directly?

`gh` ships its own git credential helper. You can install it with:
```powershell
git config --global credential.https://github.com.helper "!gh auth git-credential"
```

It works great — for one account. The catch: `gh auth git-credential` only
serves the **active** account (the one with `Active account: true` in
`gh auth status`). It has no `--user` flag.

Reflux's contribution is per-URL routing. Different remote URLs route to
different `gh` accounts based on the URL itself, not based on which
account `gh` last marked active. If you only have one GitHub identity, you
don't need reflux — `gh auth git-credential` is simpler.

## Why not register an OAuth App and run a real OAuth flow?

We tried this. The full plan was: own OAuth App + Playwright + headless
re-mint via a private Edge user-data-dir. Two reasons it died:

1. **Microsoft EMU won't approve a personal OAuth App** for the work
   tenant. Without that approval, the flow can't access EMU repos.
2. **The 12h cap is policy, not client-id-keyed.** Even with our own
   OAuth App, EMU would still cap the token at 12h with no refresh
   tokens. The whole "headless re-mint" architecture rested on having
   refresh-style behaviour we didn't actually have.

Driving `gh` is strictly better for this user: no app registration, no
client_secret, no localhost callback, and `gh` is already the trusted
client for both personal and EMU accounts.

## Why not use a fine-grained PAT?

Considered and rejected. PATs require:
- One-time creation per identity, with a chosen expiration date.
- Per-org configuration to allowlist the PAT.
- Manual rotation when the PAT expires.

For this user, the rotation hassle outweighed the silent-auth benefit.
You can still use a PAT in the username:password URL form for individual
repos if you want — it composes cleanly with reflux (reflux passes
through unmapped URLs, and explicit URL credentials bypass the helper
chain entirely).

## Why not SSH?

The user's environment doesn't allow SSH for these accounts. (Also: SSH
doesn't survive the EMU policy any better than HTTPS does for org-level
push policies that require the broker.)

## Does reflux send my tokens anywhere?

No. Reflux:
- Reads `~/.reflux/config.json` (local).
- Spawns `gh auth token --user X` (local).
- Writes the token to git's stdin (local).
- Logs to `%LOCALAPPDATA%\reflux\logs\reflux.log` (local).

There is no network call from reflux itself. `gh auth login` does call
GitHub — but that's `gh` doing what `gh` always does.

## Is reflux Windows-only?

Yes. `package.json` declares `"os": ["win32"]` and the install path uses
git config + Windows Credential Manager (via `gh`). The architecture
would port to macOS/Linux trivially (`gh` is cross-platform), but the
problem reflux solves — GCM's 12h re-prompts on EMU on Windows — is a
Windows-specific pain point. There are no plans to port.

## What if `gh` updates and breaks the `--user` flag?

Reflux pins itself to "gh ≥ 2.40" but tracks gh's own behaviour at
runtime. If gh changes its `auth status` output format, the
`authStatus()` parser may need updating; if it changes `auth token --user`
output, `getToken()` may need updating. Both are isolated to
`src/auth/gh.ts` (~150 lines), so the blast radius is small.

`reflux doctor` will surface any version mismatch the parser doesn't
understand.

## Can I have more than one profile resolve to the same `gh` user?

Yes. Two profile names can share a single `ghUser`. Useful if you want
different friendly names for organisational clarity (e.g. `work-frontend`
and `work-platform`) but they both serve from the same gh account.

## Can two `gh` accounts share one profile?

No. A profile is a (name, gh user) pair. Each profile resolves to exactly
one gh user. To serve two gh users, make two profiles.

## What happens to the cached tokens when I run `reflux uninstall`?

Nothing. `reflux uninstall` only removes the git config entry. Your
profiles, mappings, and `gh`'s tokens are all untouched. To do a deep
clean, see [troubleshooting.md § I want to start over](troubleshooting.md#i-want-to-start-over).

## Why does `reflux install` print "Registered git-credential-reflux for https://github.com"?

That's the URL scope the helper is registered for — only requests for
`https://github.com/...` will hit reflux. ADO, gitea, GitHub Enterprise
on a custom host, etc. all bypass reflux entirely (they use whatever
helper the global `credential.helper` points at).

## What does the username field in `username=<X>\npassword=<token>` do?

GitHub's HTTPS auth accepts any non-empty username when the password is
an OAuth token. We use the gh user's login (e.g. `<work-login>`) so
the username shows up usefully in git's auth logs and any server-side
audit trail.
