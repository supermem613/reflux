import { execFile } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";
import { authStatus, isInstalled, version as ghVersion } from "../auth/gh.js";
import type { GhAccount } from "../auth/gh.js";
import { findDuplicateLogins } from "../auth/gh.js";
import { loadConfig } from "../core/config.js";
import { inspectHelperList, readHelperValues, readMergedHelperScopes, readUseHttpPath, detectRefluxShadow } from "./install.js";
import type { ScopedHelper } from "./install.js";

const execFileAsync = promisify(execFile);

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

function checkGh(): CheckResult {
  if (!isInstalled()) {
    return {
      name: "gh CLI",
      ok: false,
      detail: "not found on PATH",
      hint: "Install gh from https://cli.github.com (winget install GitHub.cli).",
    };
  }
  return { name: "gh CLI", ok: true, detail: ghVersion() ?? "installed" };
}

async function checkGcm(): Promise<CheckResult> {
  // Invoke GCM via `git credential-manager` (not `git-credential-manager`
  // directly) so we find the copy that Git for Windows ships under
  // libexec/git-core/, which is not on PATH.
  try {
    const { stdout } = await execFileAsync("git", ["credential-manager", "--version"]);
    return { name: "git-credential-manager", ok: true, detail: stdout.trim().split("\n")[0] };
  } catch {
    return {
      name: "git-credential-manager",
      ok: false,
      detail: "not found via `git credential-manager`",
      hint: "Install Git for Windows (bundles GCM) or GCM standalone (https://github.com/git-ecosystem/git-credential-manager) — needed for passthrough hosts (ADO, etc.)",
    };
  }
}

function checkConfig(): CheckResult {
  try {
    const config = loadConfig();
    return {
      name: "config",
      ok: true,
      detail: `${config.profiles.length} profile(s), ${config.mappings.length} mapping(s)`,
    };
  } catch (err) {
    return {
      name: "config",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      hint: "Fix ~/.reflux/config.json or delete it to start fresh.",
    };
  }
}

function checkGhAccounts(accounts: { user: string }[]): CheckResult {
  if (accounts.length === 0) {
    return {
      name: "gh accounts",
      ok: false,
      detail: "no signed-in gh accounts; reflux cannot auto-learn GitHub owner mappings",
      hint: "Run `gh auth login --hostname github.com --git-protocol https --web` and retry.",
    };
  }
  return {
    name: "gh accounts",
    ok: true,
    detail: `${accounts.length} signed-in account(s): ${accounts.map((a) => a.user).join(", ")}`,
  };
}

function checkProfilesConfigured(): CheckResult {
  const config = loadConfig();
  if (config.profiles.length === 0) {
    return {
      name: "profiles configured",
      ok: true,
      detail: "none yet; reflux will auto-create profiles for personal GitHub owners that match signed-in gh accounts",
    };
  }
  return {
    name: "profiles configured",
    ok: true,
    detail: `${config.profiles.length} profile(s) configured`,
  };
}

function checkMappingsConfigured(): CheckResult {
  const config = loadConfig();
  if (config.mappings.length === 0) {
    return {
      name: "mappings configured",
      ok: true,
      detail: "none yet; personal-owner repos auto-learn, org repos require explicit `reflux map add`",
    };
  }
  return {
    name: "mappings configured",
    ok: true,
    detail: `${config.mappings.length} mapping(s) configured`,
  };
}

async function checkHelperRegistered(): Promise<CheckResult> {
  const values = await readHelperValues();
  const state = inspectHelperList(values);
  if (!state.hasReflux) {
    return {
      name: "git helper registration",
      ok: false,
      detail: "reflux is not in credential.https://github.com.helper",
      hint: "Run `reflux install`.",
    };
  }
  if (!state.hasResetBeforeReflux) {
    return {
      name: "git helper registration",
      ok: false,
      detail: "reflux is registered but no empty-string reset precedes it; an inherited helper (e.g. GCM via `credential.helper=manager`) will run first and prompt before reflux is consulted",
      hint: "Run `reflux install` to repair.",
    };
  }
  return { name: "git helper registration", ok: true, detail: `helper list = [${values.map((v) => JSON.stringify(v)).join(", ")}]` };
}

async function checkUseHttpPath(): Promise<CheckResult> {
  const ok = await readUseHttpPath();
  return ok
    ? { name: "git useHttpPath", ok: true, detail: "credential.https://github.com.useHttpPath = true" }
    : {
      name: "git useHttpPath",
      ok: false,
      detail: "credential.https://github.com.useHttpPath is not true; reflux will see no path on credential requests and per-org mappings cannot resolve (everything falls to the catch-all profile)",
      hint: "Run `reflux install` to repair.",
    };
}

function checkProfile(name: string, ghUser: string, accounts: { user: string }[]): CheckResult {
  const found = accounts.some((a) => a.user === ghUser);
  return {
    name: `profile/${name}`,
    ok: found,
    detail: found ? `gh signed in as ${ghUser}` : `gh has no session for ${ghUser}`,
    hint: found ? undefined : `Run \`reflux login ${name}\` to sign in.`,
  };
}

export function checkLocalHelperShadow(scoped: readonly ScopedHelper[]): CheckResult {
  const name = "git helper shadow (repo-local)";
  const globalOnly = scoped.filter((s) => s.scope === "system" || s.scope === "global");
  const globalShadowed = detectRefluxShadow(globalOnly).shadowed;
  const merged = detectRefluxShadow(scoped);
  // Only fire for a repo-local/worktree shadow. A shadow already present in the
  // global chain is the install-registration problem that `git helper
  // registration` owns; flagging it here too would be redundant noise.
  if (globalShadowed || !merged.shadowed) {
    const detail = merged.effective.length > 0
      ? `no repo-local helper shadows reflux; effective github.com helper = [${merged.effective.map((v) => JSON.stringify(v)).join(", ")}]`
      : "no repo-local credential.helper override in this repository";
    return { name, ok: true, detail };
  }
  const winner = merged.winner ?? "another helper";
  return {
    name,
    ok: false,
    detail: `a repo-local credential.helper (${JSON.stringify(winner)}) shadows reflux for github.com in this repository; git resolves credentials with it instead of reflux, so a token without repo access can win`,
    hint: "Remove the repo-local override with `git config --local --unset-all credential.helper` (run inside this repo), or re-point it at reflux. reflux cannot override an explicit repo-local helper — git's precedence gives the later repo-local reset the final say.",
  };
}

export function checkDuplicateGhLogins(accounts: readonly GhAccount[]): CheckResult {
  const name = "gh duplicate logins";
  const duplicates = findDuplicateLogins(accounts);
  if (duplicates.length === 0) {
    return { name, ok: true, detail: "no gh login is signed in more than once" };
  }
  const summary = duplicates.map((d) => `${d.user} (${d.count}x)`).join(", ");
  return {
    name,
    ok: false,
    detail: `the same gh login is signed in more than once: ${summary}; \`gh auth token --user\` is ambiguous, so reflux can emit a token for the wrong session and one of them may lack repo access`,
    hint: "Log out the stale duplicate with `gh auth logout --hostname github.com --user <login>`, keeping only the session whose token has access.",
  };
}

export async function runDoctor(): Promise<number> {
  const results: CheckResult[] = [
    checkGh(),
    await checkGcm(),
    await checkHelperRegistered(),
    checkLocalHelperShadow(await readMergedHelperScopes()),
    await checkUseHttpPath(),
    checkConfig(),
  ];

  if (isInstalled()) {
    let config;
    try {
      config = loadConfig();
    } catch {
      config = null;
    }
    if (config) {
      const accounts = authStatus();
      results.push(checkGhAccounts(accounts));
      results.push(checkDuplicateGhLogins(accounts));
      results.push(checkProfilesConfigured());
      results.push(checkMappingsConfigured());
      for (const p of config.profiles) {
        results.push(checkProfile(p.name, p.ghUser, accounts));
      }
    }
  }

  let bad = 0;
  for (const r of results) {
    const icon = r.ok ? chalk.green("✓") : chalk.red("✗");
    console.log(`${icon} ${chalk.bold(r.name)} — ${r.detail}`);
    if (!r.ok && r.hint) {
      console.log(chalk.dim(`    ${r.hint}`));
    }
    if (!r.ok) {
      bad += 1;
    }
  }

  if (bad === 0) {
    console.log("\n" + chalk.green("All checks passed."));
  } else {
    console.log("\n" + chalk.red(`${bad} check(s) failed.`));
  }
  return bad;
}

export async function doctorCommand(): Promise<void> {
  const bad = await runDoctor();
  if (bad > 0) {
    process.exitCode = 1;
  }
}
