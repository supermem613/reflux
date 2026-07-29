import chalk from "chalk";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { git, isGitRepo } from "../utils/git.js";
import { sanitizedGitChildEnv } from "../utils/child-env.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * `reflux update` — refresh reflux from its development clone.
 *
 * Reflux is always installed via `npm link` from a local clone — never
 * `npm install -g`. The link makes `<npm-prefix>/node_modules/reflux` a
 * junction pointing at the clone, and the bin shim points into the same
 * clone's `dist/`. That means a successful rebuild updates the live
 * binary atomically, with no global install step.
 *
 * Topologies this command handles:
 *
 *   1. Linked install: `import.meta.url` resolves into the clone itself
 *      (because the junction is transparent to fileURLToPath). isGitRepo
 *      returns true, we update in place, done.
 *
 *   2. Stale or missing link: `import.meta.url` resolves into a copied
 *      `node_modules/reflux/` directory left over from an old global
 *      install. We locate the dev clone via $REFLUX_DEV_DIR or
 *      ~/repos/reflux, refresh it, then ask the user to re-run
 *      `npm link` from there. We do not silently `npm install -g` because
 *      that recreates the same brittle global-prefix mess we are trying
 *      to leave behind.
 *
 * The pull backend is auto-detected: a soda-managed clone is pulled with
 * `sd pull`, everything else with `git pull --ff-only`.
 */

export interface UpdateTarget {
  dir: string;
  isLinked: boolean;
}

type ExecResult = {
  stdout: string;
  stderr: string;
}

type SodaEnvelope<TData> = {
  ok?: boolean;
  data?: TData;
  error?: string;
}

type SodaPullOutcome = {
  worktreeUpdated?: boolean;
}

export type UpdateDeps = {
  target?: UpdateTarget;
  runGit?: (args: string[], cwd: string) => Promise<ExecResult>;
  runSd?: (args: string[], cwd: string) => Promise<ExecResult>;
  runCommand?: (command: string, cwd: string) => Promise<void>;
}

export function gitPullMadeNoChanges(output: string): boolean {
  return /already up[- ]to[- ]date\.?/i.test(output);
}

/**
 * `sd` is an npm bin shim (sd.cmd / sd.ps1) on Windows, not a native exe, and
 * execFile cannot launch a .cmd directly. Passing an args array with
 * `shell: true` is deprecated under Node DEP0190 and unsafe, so wrap the
 * command in an explicit `cmd.exe /d /s /c` argv instead.
 */
async function defaultRunSd(args: string[], cwd: string): Promise<ExecResult> {
  const invocation = process.platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", "sd", ...args] }
    : { command: "sd", args };
  const result = await execFileAsync(invocation.command, invocation.args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: sanitizedGitChildEnv(),
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

/**
 * A soda-managed clone must not be pulled with raw git: soda's git-interlock
 * hooks block the write, and soda tracks stream state that `git pull` bypasses.
 * `sd status` reporting an initialized repo is the same authoritative signal
 * rotunda trusts; any failure to run or parse it means "not soda".
 */
async function isSodaManagedRepo(
  runSd: (args: string[], cwd: string) => Promise<ExecResult>,
  dir: string,
): Promise<boolean> {
  try {
    const result = await runSd(["status"], dir);
    const envelope = JSON.parse(result.stdout) as SodaEnvelope<{ summary?: { initialized?: boolean } }>;
    return envelope.ok === true && envelope.data?.summary?.initialized === true;
  } catch {
    return false;
  }
}

function parseSodaPull(stdout: string): boolean {
  const envelope = JSON.parse(stdout) as SodaEnvelope<SodaPullOutcome[]>;
  if (envelope.ok !== true) {
    throw new Error(`sd pull failed: ${envelope.error ?? "unknown error"}`);
  }
  if (!Array.isArray(envelope.data)) {
    throw new Error("sd pull failed: missing pull outcomes");
  }
  return envelope.data.some((outcome) => outcome.worktreeUpdated === true);
}

function stdoutFromError(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "stdout" in err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : undefined;
  }
  return undefined;
}

/** Returns true when the pull actually changed the worktree. */
async function pullWithSoda(
  runSd: (args: string[], cwd: string) => Promise<ExecResult>,
  dir: string,
): Promise<boolean> {
  try {
    const result = await runSd(["pull"], dir);
    return parseSodaPull(result.stdout);
  } catch (err: unknown) {
    // sd reports a refused pull as a non-zero exit with the JSON envelope still
    // on stdout, so the envelope error beats the raw exec message.
    const stdout = stdoutFromError(err);
    if (stdout) {
      try {
        return parseSodaPull(stdout);
      } catch (parseErr: unknown) {
        if (parseErr instanceof Error && parseErr.message.startsWith("sd pull failed:")) {
          throw parseErr;
        }
      }
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`sd pull failed: ${detail}`);
  }
}

function resolveModuleRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return dirname(dirname(dirname(thisFile)));
}

async function locateUpdateTarget(): Promise<UpdateTarget | null> {
  const moduleRoot = resolveModuleRoot();
  if (await isGitRepo(moduleRoot)) {
    return { dir: moduleRoot, isLinked: true };
  }

  const candidates = [
    process.env.REFLUX_DEV_DIR,
    join(homedir(), "repos", "reflux"),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    if (await isGitRepo(candidate)) {
      return { dir: candidate, isLinked: false };
    }
  }
  return null;
}

async function defaultRunCommand(cmd: string, cwd: string): Promise<void> {
  await execAsync(cmd, { cwd });
}

async function runStep(
  label: string,
  cmd: string,
  cwd: string,
  runCommand: (command: string, cwd: string) => Promise<void>,
): Promise<void> {
  console.log(chalk.bold(`\n  ${label}`));
  try {
    await runCommand(cmd, cwd);
    console.log(chalk.green(`    ✓ ${label.replace(/^[^\w]+\s*/, "")} done.`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`  ✗ ${label} failed:`) + ` ${msg}`);
    process.exit(1);
  }
}

export async function updateCommand(deps: UpdateDeps = {}): Promise<void> {
  const target = deps.target ?? await locateUpdateTarget();
  const runGit = deps.runGit ?? git;
  const runSd = deps.runSd ?? defaultRunSd;
  const runCommand = deps.runCommand ?? defaultRunCommand;

  if (!target) {
    const moduleRoot = resolveModuleRoot();
    console.log(chalk.dim(`  Reflux module: ${moduleRoot}\n`));
    console.error(chalk.red("Error:") + " Reflux is not linked and no development clone was found.");
    console.error(chalk.dim("  Looked in:"));
    if (process.env.REFLUX_DEV_DIR) {
      console.error(chalk.dim(`    $REFLUX_DEV_DIR = ${process.env.REFLUX_DEV_DIR}`));
    }
    console.error(chalk.dim(`    ${join(homedir(), "repos", "reflux")}`));
    console.error(chalk.dim("\n  Clone reflux to ~/repos/reflux (or set REFLUX_DEV_DIR), then run `npm link` from there."));
    process.exit(1);
  }

  console.log(chalk.dim(`  Reflux repo: ${target.dir}\n`));

  const sodaManaged = await isSodaManagedRepo(runSd, target.dir);
  const pullLabel = sodaManaged ? "sd pull" : "git pull";

  console.log(chalk.bold("  ↓ Pulling latest..."));
  try {
    if (sodaManaged) {
      const worktreeUpdated = await pullWithSoda(runSd, target.dir);
      if (!worktreeUpdated) {
        console.log(chalk.dim("    Already up to date."));
        console.log(chalk.dim("    Skipping install and build."));
        return;
      }
      console.log(chalk.green("    ✓ Pulled new changes."));
    } else {
      const result = await runGit(["pull", "--ff-only"], target.dir);
      const output = (result.stdout + result.stderr).trim();
      if (gitPullMadeNoChanges(output)) {
        console.log(chalk.dim("    Already up to date."));
        console.log(chalk.dim("    Skipping install and build."));
        return;
      }
      console.log(chalk.green("    ✓ Pulled new changes."));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`  ✗ ${pullLabel} failed:`) + ` ${msg}`);
    process.exit(1);
  }

  await runStep("⬡ Installing dependencies...", "npm install --no-audit --no-fund", target.dir, runCommand);
  await runStep("🔨 Building...", "npm run build", target.dir, runCommand);

  if (!target.isLinked) {
    // The dev clone was found via the fallback, but the running reflux is
    // not the linked clone — most likely a leftover global install. Ask
    // the user to run `npm link` from the clone so future invocations pick
    // up the rebuilt dist/ automatically.
    console.log(chalk.yellow("\n  ⚠  Reflux is not linked to this clone."));
    console.log(chalk.dim(`     Run:  cd ${target.dir} && npm link`));
    console.log(chalk.dim("     After that, `reflux update` will refresh in place with no global install."));
    return;
  }

  console.log(chalk.green("\n  ✓ Reflux updated successfully."));
}
