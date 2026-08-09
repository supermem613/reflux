import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sanitizedGitChildEnv } from "../utils/child-env.js";
import { git, isGitRepo } from "../utils/git.js";

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
};

type SodaEnvelope<TData> = {
  ok?: boolean;
  data?: TData;
  error?: string;
};

type SodaPullOutcome = {
  status?: string;
  worktreeUpdated?: boolean;
};

export type UpdateDeps = {
  target?: UpdateTarget;
  runGit?: (args: string[], cwd: string) => Promise<ExecResult>;
  runSd?: (args: string[], cwd: string) => Promise<ExecResult>;
  runNpm?: (args: string[], cwd: string) => Promise<ExecResult>;
  hasSodaWorkspace?: (dir: string) => boolean;
};

export type UpdateResult = {
  repoRoot: string;
  isLinked: boolean;
  beforeRevision: string | null;
  afterRevision: string | null;
  pulled: boolean;
  alreadyUpToDate: boolean;
  installed: boolean;
  built: boolean;
  linkRequired: boolean;
};

export function gitPullMadeNoChanges(output: string): boolean {
  return /already up[- ]to[- ]date\.?/i.test(output);
}

export function hasSodaWorkspaceMarkers(dir: string): boolean {
  const workspaceDir = join(dir, ".sd");
  const metaPath = join(workspaceDir, "meta.json");
  const repoIdPath = join(workspaceDir, "repo-id");
  if (!existsSync(metaPath) || !existsSync(repoIdPath)) {
    return false;
  }
  try {
    return readFileSync(repoIdPath, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

export function isSodaGitInterlockError(message: string): boolean {
  return /sd-powered repo/i.test(message) || /raw git .* blocked/i.test(message);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `sd` and `npm` are npm bin shims (sd.cmd / npm.cmd) on Windows, not native
 * exes, and execFile cannot launch a .cmd directly. Passing an args array with
 * `shell: true` is deprecated under Node DEP0190 and unsafe, so wrap the
 * command in an explicit `cmd.exe /d /s /c` argv instead.
 */
async function defaultRunShim(command: string, args: string[], cwd: string): Promise<ExecResult> {
  const invocation = process.platform === "win32"
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] }
    : { command, args };
  const result = await execFileAsync(invocation.command, invocation.args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    env: sanitizedGitChildEnv(),
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

async function defaultRunSd(args: string[], cwd: string): Promise<ExecResult> {
  return defaultRunShim("sd", args, cwd);
}

async function defaultRunNpm(args: string[], cwd: string): Promise<ExecResult> {
  return defaultRunShim("npm", args, cwd);
}

function parseSodaStatus(stdout: string): boolean {
  const envelope = JSON.parse(stdout) as SodaEnvelope<{ summary?: { initialized?: boolean } }>;
  return envelope.ok === true && envelope.data?.summary?.initialized === true;
}

async function probeSodaStatus(
  runSd: (args: string[], cwd: string) => Promise<ExecResult>,
  dir: string,
): Promise<boolean> {
  try {
    const result = await runSd(["status"], dir);
    return parseSodaStatus(result.stdout);
  } catch (err: unknown) {
    const stdout = stdoutFromError(err);
    if (stdout) {
      try {
        return parseSodaStatus(stdout);
      } catch {
        return false;
      }
    }
    return false;
  }
}

function stdoutFromError(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "stdout" in err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : undefined;
  }
  return undefined;
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

async function currentRevision(
  runGit: (args: string[], cwd: string) => Promise<ExecResult>,
  dir: string,
): Promise<string | null> {
  const result = await runGit(["rev-parse", "HEAD"], dir);
  return result.stdout.trim() || null;
}

function missingTargetError(): Error {
  const lookedIn = [
    process.env.REFLUX_DEV_DIR ? `$REFLUX_DEV_DIR = ${process.env.REFLUX_DEV_DIR}` : null,
    join(homedir(), "repos", "reflux"),
  ].filter((line): line is string => Boolean(line));
  return new Error(
    "Reflux is not linked and no development clone was found. "
    + `Looked in: ${lookedIn.join("; ")}. `
    + "Clone reflux to ~/repos/reflux (or set REFLUX_DEV_DIR), then run `npm link` from there.",
  );
}

export async function runSelfUpdate(deps: UpdateDeps = {}): Promise<UpdateResult> {
  const target = deps.target ?? await locateUpdateTarget();
  const runGit = deps.runGit ?? git;
  const runSd = deps.runSd ?? defaultRunSd;
  const runNpm = deps.runNpm ?? defaultRunNpm;

  if (!target) {
    throw missingTargetError();
  }

  const hasSodaWorkspace = deps.hasSodaWorkspace ?? hasSodaWorkspaceMarkers;
  const beforeRevision = await currentRevision(runGit, target.dir);
  const sodaByStatus = await probeSodaStatus(runSd, target.dir);
  const sodaByMarkers = hasSodaWorkspace(target.dir);
  const sodaManaged = sodaByStatus || sodaByMarkers;
  let pulled = false;
  if (sodaManaged) {
    try {
      pulled = await pullWithSoda(runSd, target.dir);
    } catch (err: unknown) {
      const detail = errorMessage(err);
      if (sodaByMarkers && !sodaByStatus) {
        throw new Error(
          `This reflux install is soda-managed, but sd pull failed. Put sd on PATH and rerun reflux update. ${detail}`,
        );
      }
      throw err instanceof Error ? err : new Error(detail);
    }
  } else {
    try {
      await runGit(["pull", "--ff-only"], target.dir);
    } catch (err: unknown) {
      const detail = errorMessage(err);
      if (!isSodaGitInterlockError(detail)) {
        throw err instanceof Error ? err : new Error(detail);
      }
      try {
        pulled = await pullWithSoda(runSd, target.dir);
      } catch (sodaErr: unknown) {
        throw new Error(
          `Pull was blocked by soda interlock hooks, and sd pull failed. Put sd on PATH and rerun reflux update. ${errorMessage(sodaErr)}`,
        );
      }
    }
  }
  const afterRevision = await currentRevision(runGit, target.dir);
  const alreadyUpToDate = sodaManaged || pulled ? !pulled : beforeRevision === afterRevision;

  if (alreadyUpToDate) {
    return {
      repoRoot: target.dir,
      isLinked: target.isLinked,
      beforeRevision,
      afterRevision,
      pulled: false,
      alreadyUpToDate: true,
      installed: false,
      built: false,
      linkRequired: !target.isLinked,
    };
  }

  await runNpm(["install", "--no-audit", "--no-fund"], target.dir);
  await runNpm(["run", "build"], target.dir);
  return {
    repoRoot: target.dir,
    isLinked: target.isLinked,
    beforeRevision,
    afterRevision,
    pulled: true,
    alreadyUpToDate: false,
    installed: true,
    built: true,
    linkRequired: !target.isLinked,
  };
}

function writeHuman(result: UpdateResult): void {
  process.stdout.write("reflux repo: " + result.repoRoot + "\n");
  if (result.alreadyUpToDate) {
    process.stdout.write("Already up to date. Skipping install and build.\n");
    if (result.linkRequired) {
      process.stdout.write(
        "Reflux is not linked to this clone. Run: cd " + result.repoRoot + " && npm link\n",
      );
    }
    return;
  }
  process.stdout.write("Pulled new changes. Dependencies installed. Build complete.\n");
  if (result.linkRequired) {
    process.stdout.write(
      "Reflux is not linked to this clone. Run: cd " + result.repoRoot + " && npm link\n",
    );
  }
}

export async function updateCommand(): Promise<void> {
  try {
    writeHuman(await runSelfUpdate());
  } catch (err: unknown) {
    const hint = err instanceof Error ? err.message : String(err);
    process.stderr.write("reflux update failed: " + hint + "\n");
    process.exitCode = 1;
  }
}
