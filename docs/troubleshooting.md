# Troubleshooting

Steps are ordered by frequency. Start at the top.

## `git push` prompts for credentials when I expected reflux to handle it

1. Run `reflux map resolve <the-remote-url>`.
   - If it says "no explicit mapping" — personal-owner GitHub repos can still
     auto-learn when the owner matches a signed-in `gh` account. Org owners need
     `reflux map add <prefix> <profile>`.
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

## `git fetch` says "Repository not found" but reflux works when isolated

Symptom: `git fetch` in a repo returns `remote: Repository not found` (a
GitHub 404 for a private repo you can access), yet
`git -c credential.helper= -c credential.helper=reflux ls-remote origin`
succeeds. A soda/`uatu` write to the same repo fails with `REPO_NOT_READY`.

Cause: a `credential.helper` outside the global chain resets the helper list
and re-adds another helper. Git accumulates helpers across system, global, then
local config in order, and an empty-string value clears everything before it.
There are two origins:

- **Repo-local file:** the repository's own config has
  `credential.helper=''` then `credential.helper=!gh auth git-credential`.
  Because local config is read last, that reset drops reflux from the chain.
- **Command line / injected environment:** the launching tool (for example the
  Copilot CLI) forces its own helper through `GIT_CONFIG_PARAMETERS` and
  `GIT_CONFIG_COUNT`, for example
  `GIT_CONFIG_PARAMETERS="'credential.https://github.com.helper=' 'credential.https://github.com.helper=copilot'"`.
  Git labels these entries origin `command line` and gives them the highest
  precedence, so reflux is evicted from the helper list and git never invokes
  git-credential-reflux at all.

reflux cannot override either shadow: git's precedence gives the later reset the
final say, and a command-line helper wins outright.

Fix:

```powershell
reflux doctor            # names the origin: "(repo-local)" or "(command line)"
```

For a **repo-local** shadow, remove the override:

```powershell
git config --local --get-all credential.helper   # inspect the override
git config --local --unset-all credential.helper # remove it, or re-point at reflux
```

For a **command-line / injected** shadow, a repo-local unset does nothing. Clear
the injection in the launching environment instead:

```powershell
$env:GIT_CONFIG_PARAMETERS = $null   # unset the injected helper (or set GIT_CONFIG_COUNT=0)
$env:GIT_CONFIG_COUNT = $null
# or force reflux for a single command:
git -c credential.helper= -c credential.helper=reflux ls-remote origin
```

After the shadow is cleared, github.com resolution falls back to the global
chain where reflux runs first. When reflux does win, it strips
`GIT_CONFIG_PARAMETERS`/`GIT_CONFIG_COUNT` from the gh and git children it spawns
so an injected helper cannot leak into its own token resolution.

## `reflux install` says `git-credential-manager` was not registered

That's fine — it means GCM wasn't your global credential helper before.
Reflux still installs cleanly. GitHub requests still use reflux. Install GCM
if you have any non-GitHub remotes that need passthrough.

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
Reflux owns all `github.com` credential requests once installed. If a personal
repo owner matches a signed-in `gh` account, reflux auto-creates the profile
and owner mapping. If the repo is owned by an org or another ambiguous owner,
reflux fails loud with `quit=1`; add an explicit mapping such as
`reflux map add https://github.com/<org>/ <profile>`.

## The helper exits 0 with no output

That's intentional. Reflux exits 0 with no output when:
- The host is not github.com (passthrough; the next helper handles it).
- Git calls `store` for an unmapped github.com URL. gh owns token storage,
  so reflux has nothing to persist.

For github.com `get`, reflux does not passthrough to GCM just because a mapping
is missing. It auto-learns safe personal-owner mappings or returns `quit=1`
with an explicit mapping command. To force reflux to log what it decided:

```powershell
$env:REFLUX_DEBUG = "1"
git push origin main 2>&1 | Out-String
```

Look for lines tagged `[helper]`.

## `reflux update` fails on the pull

Usually means you have local uncommitted changes in the install dir.
`git pull --ff-only` refuses to fast-forward over a dirty working tree, and
`sd pull` refuses when the worktree has open files.

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
