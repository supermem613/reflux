import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitPullMadeNoChanges, updateCommand } from "../../src/commands/update.js";

describe("updateCommand", () => {
  it("skips install and build when git pull made no changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflux-update-"));
    try {
      const commands: string[] = [];
      await updateCommand({
        target: { dir, isLinked: true },
        runGit: async (args) => {
          commands.push(`git ${args.join(" ")}`);
          return { stdout: "Already up to date.\n", stderr: "" };
        },
        runCommand: async (command) => {
          commands.push(command);
        },
      });
      assert.deepEqual(commands, ["git pull --ff-only"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs install and build when git pull returns changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reflux-update-"));
    try {
      const commands: string[] = [];
      await updateCommand({
        target: { dir, isLinked: true },
        runGit: async (args) => {
          commands.push(`git ${args.join(" ")}`);
          return { stdout: "Fast-forward\n package.json | 2 +-\n", stderr: "" };
        },
        runCommand: async (command) => {
          commands.push(command);
        },
      });
      assert.deepEqual(commands, [
        "git pull --ff-only",
        "npm install --no-audit --no-fund",
        "npm run build",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognizes current and legacy no-change git pull output", () => {
    assert.equal(gitPullMadeNoChanges("Already up to date."), true);
    assert.equal(gitPullMadeNoChanges("Already up-to-date."), true);
    assert.equal(gitPullMadeNoChanges("Updating abc..def\nFast-forward"), false);
  });
});
