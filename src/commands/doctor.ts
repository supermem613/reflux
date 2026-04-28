import { execFile } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";
import { authStatus, isInstalled, version as ghVersion } from "../auth/gh.js";
import { loadConfig } from "../core/config.js";
import { inspectHelperList, readHelperValues, readUseHttpPath } from "./install.js";

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

export async function doctorCommand(): Promise<void> {
  const results: CheckResult[] = [
    checkGh(),
    await checkGcm(),
    await checkHelperRegistered(),
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
      for (const p of config.profiles) {
        results.push(checkProfile(p.name, p.ghUser, accounts));
      }
    }
  }

  let bad = 0;
  for (const r of results) {
    const icon = r.ok ? chalk.green("✓") : chalk.red("✗");
    console.log(`${icon} ${chalk.bold(r.name)} — ${r.detail}`);
    if (!r.ok && r.hint) console.log(chalk.dim(`    ${r.hint}`));
    if (!r.ok) bad += 1;
  }

  if (bad === 0) {
    console.log("\n" + chalk.green("All checks passed."));
  } else {
    console.log("\n" + chalk.red(`${bad} check(s) failed.`));
    process.exitCode = 1;
  }
}
