import { execFile } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";

const execFileAsync = promisify(execFile);

/**
 * `reflux install` — make git-credential-reflux the first credential helper
 * git asks for github.com URLs.
 *
 * Two pieces of git config are required and both must be in place for
 * reflux to work end-to-end:
 *
 *   1. credential.https://github.com.helper = ""           (reset)
 *      credential.https://github.com.helper = "reflux"     (use us)
 *
 *      The empty-string entry clears any inherited helper. Git for Windows
 *      ships with `credential.helper = manager` in the system gitconfig;
 *      without the reset, git would call GCM first and we'd never see the
 *      `get`. Order matters — the reset must precede `reflux`.
 *
 *   2. credential.https://github.com.useHttpPath = true
 *
 *      Git omits the repo path from credential requests by default, so the
 *      helper sees only `host=github.com` and cannot tell whether the URL
 *      maps to a work or personal profile. With useHttpPath, git sends the
 *      full path and reflux's longest-prefix mapping resolves correctly.
 *
 * Implementation notes:
 *
 *   - `git config --unset-all` then `--add ""` then `--add reflux` is the
 *     simplest way to guarantee correct order and idempotency. The
 *     alternative — inspect-and-conditionally-add — is fragile because git
 *     emits an empty stdout for "no values" which `String.split` reports as
 *     `[""]`, indistinguishable from one literal empty value (the bug this
 *     comment replaces).
 *
 *   - `--unset-all` removes every value for the URL-scoped helper key,
 *     including any user-added third entry. Acceptable: install is opting
 *     reflux in to own github.com auth on this machine. uninstall reverses
 *     everything install added.
 */

const URL_SCOPE = "credential.https://github.com";
const HELPER_KEY = `${URL_SCOPE}.helper`;
const USE_HTTP_PATH_KEY = `${URL_SCOPE}.useHttpPath`;

interface GitConfigResult {
  stdout: string;
  exitCode: number;
}

async function gitConfig(args: string[]): Promise<GitConfigResult> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--global", ...args]);
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number; stdout?: string };
    return { stdout: e.stdout ?? "", exitCode: typeof e.code === "number" ? e.code : 1 };
  }
}

/**
 * Read the current ordered list of helper values for github.com. Returns
 * an empty array when the key is unset (git exits non-zero with no output
 * in that case — distinct from a key whose value is the empty string,
 * which yields a one-element `[""]`).
 */
export async function readHelperValues(): Promise<string[]> {
  const { stdout, exitCode } = await gitConfig(["--get-all", HELPER_KEY]);
  if (exitCode !== 0 && stdout === "") {
    return [];
  }
  return stdout.replace(/\r?\n$/, "").split(/\r?\n/);
}

export interface HelperState {
  hasReflux: boolean;
  hasResetBeforeReflux: boolean;
}

/**
 * Pure decision helper — given the current ordered list of helper values
 * for github.com, report whether reflux is installed correctly. Used by
 * install (to decide whether work is needed) and by doctor (to surface
 * broken state).
 *
 * Correctness requires:
 *   - "reflux" appears in the list, AND
 *   - an empty-string entry appears strictly before the first "reflux"
 *     so any inherited helper from a non-URL `credential.helper` is
 *     cleared before reflux runs.
 */
export function inspectHelperList(values: readonly string[]): HelperState {
  const refluxIndex = values.indexOf("reflux");
  if (refluxIndex < 0) {
    return { hasReflux: false, hasResetBeforeReflux: false };
  }
  const resetIndex = values.indexOf("");
  return {
    hasReflux: true,
    hasResetBeforeReflux: resetIndex >= 0 && resetIndex < refluxIndex,
  };
}

async function ensureHelperRegistered(): Promise<void> {
  const current = await readHelperValues();
  const state = inspectHelperList(current);
  if (state.hasReflux && state.hasResetBeforeReflux && current.length === 2) {
    return;
  }
  // Wipe and rewrite. Cheaper than computing a minimal patch and avoids
  // leaving stray third-party entries in front of us.
  await gitConfig(["--unset-all", HELPER_KEY]);
  await gitConfig(["--add", HELPER_KEY, ""]);
  await gitConfig(["--add", HELPER_KEY, "reflux"]);
}

export async function readUseHttpPath(): Promise<boolean> {
  const { stdout, exitCode } = await gitConfig(["--get", USE_HTTP_PATH_KEY]);
  if (exitCode !== 0) {
    return false;
  }
  return stdout.trim().toLowerCase() === "true";
}

async function ensureUseHttpPath(): Promise<void> {
  if (await readUseHttpPath()) {
    return;
  }
  await gitConfig([USE_HTTP_PATH_KEY, "true"]);
}

export async function installCommand(): Promise<void> {
  await ensureHelperRegistered();
  await ensureUseHttpPath();
  console.log(chalk.green("✓") + ` Registered git-credential-reflux for ${chalk.cyan("https://github.com")}`);
  console.log(chalk.green("✓") + ` Enabled ${chalk.cyan("useHttpPath")} so per-org mappings can resolve`);

  // Surface any missing gh sessions or other config issues now, so the user
  // sees them here instead of in the middle of the next `git pull`.
  console.log("");
  const { doctorCommand } = await import("./doctor.js");
  await doctorCommand();
}

async function tryUnsetValue(valuePattern: string): Promise<boolean> {
  const { exitCode } = await gitConfig(["--unset-all", HELPER_KEY, valuePattern]);
  return exitCode === 0;
}

async function tryUnsetKey(key: string): Promise<boolean> {
  const { exitCode } = await gitConfig(["--unset", key]);
  return exitCode === 0;
}

export async function uninstallCommand(): Promise<void> {
  // Reverse everything install added. Leaving the reset behind would keep
  // github.com auth broken for users who relied on a global GCM helper;
  // leaving useHttpPath behind would change git's wire behaviour for any
  // helper the user installs next.
  const removedReflux = await tryUnsetValue("^reflux$");
  const removedReset = await tryUnsetValue("^$");
  const removedUseHttpPath = await tryUnsetKey(USE_HTTP_PATH_KEY);
  if (removedReflux || removedReset || removedUseHttpPath) {
    console.log(chalk.green("✓") + " Removed git-credential-reflux from git config");
  } else {
    console.log(chalk.dim("git-credential-reflux was not registered."));
  }
  console.log(chalk.dim("\nProfiles and mappings in ~/.reflux/config.json were left alone."));
  console.log(chalk.dim("`gh` accounts were left alone. Use `gh auth logout` to clear them."));
}
