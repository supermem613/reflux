import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitPullMadeNoChanges, updateCommand } from "../../src/commands/update.js";

const NOT_SODA = JSON.stringify({ ok: false, error: "not a soda repo" });

function sodaStatus(initialized: boolean): string {
  return JSON.stringify({ ok: true, data: { summary: { initialized } } });
}

function sodaPull(worktreeUpdated: boolean): string {
  return JSON.stringify({ ok: true, data: [{ status: "ok", worktreeUpdated }] });
}

function withTempDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflux-update-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("updateCommand", () => {
  it("skips install and build when git pull made no changes", withTempDir(async (dir) => {
    const commands: string[] = [];
    await updateCommand({
      target: { dir, isLinked: true },
      runSd: async (args) => {
        commands.push(`sd ${args.join(" ")}`);
        return { stdout: NOT_SODA, stderr: "" };
      },
      runGit: async (args) => {
        commands.push(`git ${args.join(" ")}`);
        return { stdout: "Already up to date.\n", stderr: "" };
      },
      runCommand: async (command) => {
        commands.push(command);
      },
    });
    assert.deepEqual(commands, ["sd status", "git pull --ff-only"]);
  }));

  it("runs install and build when git pull returns changes", withTempDir(async (dir) => {
    const commands: string[] = [];
    await updateCommand({
      target: { dir, isLinked: true },
      runSd: async (args) => {
        commands.push(`sd ${args.join(" ")}`);
        return { stdout: NOT_SODA, stderr: "" };
      },
      runGit: async (args) => {
        commands.push(`git ${args.join(" ")}`);
        return { stdout: "Fast-forward\n package.json | 2 +-\n", stderr: "" };
      },
      runCommand: async (command) => {
        commands.push(command);
      },
    });
    assert.deepEqual(commands, [
      "sd status",
      "git pull --ff-only",
      "npm install --no-audit --no-fund",
      "npm run build",
    ]);
  }));

  it("pulls with sd and rebuilds when the repo is soda-managed", withTempDir(async (dir) => {
    const commands: string[] = [];
    await updateCommand({
      target: { dir, isLinked: true },
      runSd: async (args) => {
        commands.push(`sd ${args.join(" ")}`);
        return { stdout: args[0] === "status" ? sodaStatus(true) : sodaPull(true), stderr: "" };
      },
      runGit: async (args) => {
        commands.push(`git ${args.join(" ")}`);
        return { stdout: "", stderr: "" };
      },
      runCommand: async (command) => {
        commands.push(command);
      },
    });
    assert.deepEqual(commands, [
      "sd status",
      "sd pull",
      "npm install --no-audit --no-fund",
      "npm run build",
    ]);
  }));

  it("skips install and build when sd pull left the worktree unchanged", withTempDir(async (dir) => {
    const commands: string[] = [];
    await updateCommand({
      target: { dir, isLinked: true },
      runSd: async (args) => {
        commands.push(`sd ${args.join(" ")}`);
        return { stdout: args[0] === "status" ? sodaStatus(true) : sodaPull(false), stderr: "" };
      },
      runGit: async (args) => {
        commands.push(`git ${args.join(" ")}`);
        return { stdout: "", stderr: "" };
      },
      runCommand: async (command) => {
        commands.push(command);
      },
    });
    assert.deepEqual(commands, ["sd status", "sd pull"]);
  }));

  it("falls back to git when sd status reports an uninitialized repo", withTempDir(async (dir) => {
    const commands: string[] = [];
    await updateCommand({
      target: { dir, isLinked: true },
      runSd: async (args) => {
        commands.push(`sd ${args.join(" ")}`);
        return { stdout: sodaStatus(false), stderr: "" };
      },
      runGit: async (args) => {
        commands.push(`git ${args.join(" ")}`);
        return { stdout: "Already up to date.\n", stderr: "" };
      },
      runCommand: async (command) => {
        commands.push(command);
      },
    });
    assert.deepEqual(commands, ["sd status", "git pull --ff-only"]);
  }));

  it("falls back to git when sd is not installed", withTempDir(async (dir) => {
    const commands: string[] = [];
    await updateCommand({
      target: { dir, isLinked: true },
      runSd: async () => {
        throw new Error("spawn sd ENOENT");
      },
      runGit: async (args) => {
        commands.push(`git ${args.join(" ")}`);
        return { stdout: "Already up to date.\n", stderr: "" };
      },
      runCommand: async (command) => {
        commands.push(command);
      },
    });
    assert.deepEqual(commands, ["git pull --ff-only"]);
  }));

  it("recognizes current and legacy no-change git pull output", () => {
    assert.equal(gitPullMadeNoChanges("Already up to date."), true);
    assert.equal(gitPullMadeNoChanges("Already up-to-date."), true);
    assert.equal(gitPullMadeNoChanges("Updating abc..def\nFast-forward"), false);
  });
});
