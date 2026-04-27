import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

/** Run a git command in `cwd`. */
export async function git(args: string[], cwd: string): Promise<GitResult> {
  const result = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

/** True if `dir` is the root of a git repo (its own .git, not a parent's). */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await git(["rev-parse", "--show-toplevel"], dir);
    const top = stdout.trim().replace(/\\/g, "/").toLowerCase();
    const target = dir.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
    return top === target;
  } catch {
    return false;
  }
}
