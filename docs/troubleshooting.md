# Troubleshooting

Steps are ordered by frequency. Start at the top.

## `git push` prompts for credentials when I expected reflux to handle it

1. Run `reflux map resolve <the-remote-url>`.
   - If it says "no mapping" — you don't have a route for that URL. Fix
     with `reflux map add <prefix> <profile>`.
   - If it returns a profile — go to step 2.
2. Run `reflux profile show <that-profile>`.
   - If `gh signed in` says no — run `reflux login <profile>`.
3. Run `reflux doctor`.
   - It will tell you exactly which check failed and the suggested fix.

## `git push` succeeded but as the wrong identity

You probably have overlapping mappings. Check resolution order:

```powershell
reflux map list
```

Mappings are sorted by length descending. The first one whose prefix is a
prefix of your URL wins. If the wrong profile is winning, either:

- Add a more specific mapping that takes precedence, or
- Remove the over-broad one.

## `gh auth status` says I'm signed in, but reflux can't get a token

Confirm by hand:

```powershell
gh auth token --hostname github.com --user <theGhUser>
```

- If this prints a `gho_...` token, reflux should be able to too. Run with
  `REFLUX_DEBUG=1` set to see what's happening:
  ```powershell
  $env:REFLUX_DEBUG = "1"
  "protocol=https`nhost=github.com`npath=<owner>/<repo>`n" | git-credential-reflux get
  ```
- If `gh auth token` itself fails, the keyring entry is gone or corrupt.
  Run `gh auth login --hostname github.com` and pick the missing account.

## `reflux install` says `git-credential-manager` was not registered

That's fine — it means GCM wasn't your global credential helper before.
Reflux still installs cleanly. Unmapped requests will fail to passthrough,
but mapped ones work. Install GCM if you have any non-GitHub remotes.

## `gh auth login` opens the wrong browser

`gh` opens your OS default browser. Reflux has no control over which
browser opens for `gh auth login`. To change: set the default browser in
Windows Settings, or close the wrong one and pick "Use a different account"
in the right one.

## I'm getting prompted every 12 hours anyway

Read [docs/auth.md § The Microsoft EMU 12h cap](auth.md#the-microsoft-emu-12h-cap).
Short version: the 12h cap is a Microsoft tenant policy on EMU. Reflux
cannot defeat it. What reflux gives you is **one re-prompt per identity per
12h, not one per repo per 12h**. After re-prompting, every repo behind that
identity works again until the next cap window.

If you find yourself re-prompted multiple times in one cap window for the
same identity, that's a bug — file an issue with `reflux doctor` output.

## The helper exits 0 with no output

That's intentional. Reflux exits 0 with no output when:
- The host is not github.com (passthrough; the next helper handles it).
- No mapping matches the URL (passthrough).

In both cases, git falls through to whichever helper comes next in
your config (typically GCM). To force reflux to log what it decided:

```powershell
$env:REFLUX_DEBUG = "1"
git push origin main 2>&1 | Out-String
```

Look for lines tagged `[helper]`.

## `reflux update` fails on `git pull`

Usually means you have local uncommitted changes in the install dir.
`git pull --ff-only` refuses to fast-forward over a dirty working tree.

```powershell
cd <reflux-install-dir>
git status
# stash, commit, or discard your changes
reflux update
```

## I want to start over

```powershell
reflux uninstall                  # remove from git config
Remove-Item ~/.reflux -Recurse    # delete profiles + mappings
gh auth logout --hostname github.com    # repeat per account
```

Then start over from the [Quick start](../README.md#quick-start).

## Logs

Every helper invocation appends to
`%LOCALAPPDATA%\reflux\logs\reflux.log`. Use it as the first source of
truth when something is wrong:

```powershell
Get-Content $env:LOCALAPPDATA\reflux\logs\reflux.log -Tail 50
```

Set `REFLUX_DEBUG=1` to mirror those lines to stderr in real time.
