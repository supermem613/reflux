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

/**
 * A `credential.helper` value together with the git config scope it came
 * from. Scope is git's own label from `--show-scope`: `system`, `global`,
 * `local`, `worktree`, or `command`.
 */
export interface ScopedHelper {
  scope: string;
  value: string;
}

export interface RefluxShadowState {
  /** The effective ordered helper values git consults for github.com. */
  effective: string[];
  /** True when reflux is not the first effective helper, or is absent. */
  shadowed: boolean;
  /** The scope of the helper that runs before reflux, when shadowed. */
  culpritScope: string | null;
  /** The helper value that runs before reflux, or replaces it, when shadowed. */
  winner: string | null;
}

const GENERIC_HELPER_KEY = "credential.helper";

/**
 * Parse `git config --list --show-scope` output into the ordered list of
 * credential.helper values that affect github.com, preserving config order.
 *
 * Only the generic `credential.helper` and the host-scoped
 * `credential.https://github.com.helper` keys participate in github.com
 * resolution. Other url-scoped helpers such as gist.github.com are ignored.
 * The merged output order is git's own read order (system, then global, then
 * local, preserving within-file order), which is the order git accumulates
 * helpers in, so an empty-string reset later in the list clears earlier ones.
 */
export function parseHelperScopes(configListOutput: string): ScopedHelper[] {
  const result: ScopedHelper[] = [];
  for (const raw of configListOutput.split(/\r?\n/)) {
    const tab = raw.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const scope = raw.slice(0, tab);
    const kv = raw.slice(tab + 1);
    const eq = kv.indexOf("=");
    const key = eq < 0 ? kv : kv.slice(0, eq);
    const value = eq < 0 ? "" : kv.slice(eq + 1);
    if (key === GENERIC_HELPER_KEY || key === HELPER_KEY) {
      result.push({ scope, value });
    }
  }
  return result;
}

/**
 * Apply git's empty-reset accumulation to an ordered ScopedHelper list and
 * return the final ordered list of effective helpers for github.com. An empty
 * value clears everything accumulated so far, matching git's rule that
 * `credential.helper=` resets the helper chain.
 */
export function computeEffectiveGithubHelpers(scoped: readonly ScopedHelper[]): ScopedHelper[] {
  let effective: ScopedHelper[] = [];
  for (const entry of scoped) {
    if (entry.value === "") {
      effective = [];
    } else {
      effective.push(entry);
    }
  }
  return effective;
}

/**
 * Decide whether reflux still wins github.com credential resolution given the
 * ordered, scope-tagged helper entries. reflux wins only when it is the first
 * effective helper: git calls helpers in order and the first to return a
 * password wins, and reflux always returns one. Anything earlier answers
 * before reflux, and an empty reset after reflux drops it entirely.
 */
export function detectRefluxShadow(scoped: readonly ScopedHelper[]): RefluxShadowState {
  const effective = computeEffectiveGithubHelpers(scoped);
  const values = effective.map((e) => e.value);
  if (values[0] === "reflux") {
    return { effective: values, shadowed: false, culpritScope: null, winner: null };
  }
  const winnerEntry = effective[0] ?? null;
  return {
    effective: values,
    shadowed: true,
    culpritScope: winnerEntry ? winnerEntry.scope : null,
    winner: winnerEntry ? winnerEntry.value : null,
  };
}

/**
 * Read the merged, scope-tagged credential.helper entries that apply to
 * github.com from the current working directory. Unlike readHelperValues,
 * this does NOT force `--global`: it runs plain `git config --list` so the
 * repo-local scope of the current directory is included, which is exactly
 * what a repo-local shadow lives in.
 */
export async function readMergedHelperScopes(): Promise<ScopedHelper[]> {
  let stdout = "";
  try {
    const r = await execFileAsync("git", ["config", "--list", "--show-scope"]);
    stdout = r.stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string };
    stdout = e.stdout ?? "";
  }
  return parseHelperScopes(stdout);
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
  const { runDoctor } = await import("./doctor.js");
  await runDoctor();
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
