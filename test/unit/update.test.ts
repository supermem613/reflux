import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gitPullMadeNoChanges, isSodaGitInterlockError, runSelfUpdate } from "../../src/commands/update.js";

function recordCall(kind: string, args: string[]): string {
  return [kind, ...args].join(" ");
}

const NOT_SODA = JSON.stringify({ ok: false, error: "not a soda repo" });

function sodaStatus(initialized: boolean): string {
  return JSON.stringify({ ok: true, data: { summary: { initialized } } });
}

function sodaPull(worktreeUpdated: boolean): string {
  return JSON.stringify({ ok: true, data: [{ status: worktreeUpdated ? "pulled" : "up-to-date", worktreeUpdated }] });
}

describe("runSelfUpdate", () => {
  it("skips install and build when pull keeps the same revision", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      target: { dir: "repo", isLinked: true },
      hasSodaWorkspace: () => false,
      runSd: async (args) => {
        calls.push(recordCall("sd", args));
        return { stdout: NOT_SODA, stderr: "" };
      },
      runGit: async (args) => {
        calls.push(recordCall("git", args));
        if (args.join(" ") === "rev-parse HEAD") {
          return { stdout: "abc123\n", stderr: "" };
        }
        return { stdout: "Already up to date.\n", stderr: "" };
      },
      runNpm: async (args) => {
        calls.push(recordCall("npm", args));
        return { stdout: "", stderr: "" };
      },
    });

    assert.deepEqual(calls, [
      "git rev-parse HEAD",
      "sd status",
      "git pull --ff-only",
      "git rev-parse HEAD",
    ]);
    assert.equal(result.alreadyUpToDate, true);
    assert.equal(result.installed, false);
    assert.equal(result.built, false);
    assert.equal(result.linkRequired, false);
  });

  it("installs and builds when pull changes the revision", async () => {
    const revisions = ["abc123\n", "def456\n"];
    const calls: string[] = [];
    const result = await runSelfUpdate({
      target: { dir: "repo", isLinked: true },
      hasSodaWorkspace: () => false,
      runSd: async (args) => {
        calls.push(recordCall("sd", args));
        return { stdout: NOT_SODA, stderr: "" };
      },
      runGit: async (args) => {
        calls.push(recordCall("git", args));
        if (args.join(" ") === "rev-parse HEAD") {
          return { stdout: revisions.shift() ?? "def456\n", stderr: "" };
        }
        return { stdout: "Fast-forward\n", stderr: "" };
      },
      runNpm: async (args) => {
        calls.push(recordCall("npm", args));
        return { stdout: "", stderr: "" };
      },
    });

    assert.deepEqual(calls, [
      "git rev-parse HEAD",
      "sd status",
      "git pull --ff-only",
      "git rev-parse HEAD",
      "npm install --no-audit --no-fund",
      "npm run build",
    ]);
    assert.equal(result.pulled, true);
    assert.equal(result.installed, true);
    assert.equal(result.built, true);
    assert.equal(result.beforeRevision, "abc123");
    assert.equal(result.afterRevision, "def456");
  });

  it("uses sd pull in a soda-managed repo and installs after worktree updates", async () => {
    const revisions = ["abc123\n", "def456\n"];
    const calls: string[] = [];
    const result = await runSelfUpdate({
      target: { dir: "repo", isLinked: true },
      hasSodaWorkspace: () => false,
      runSd: async (args) => {
        calls.push(recordCall("sd", args));
        return {
          stdout: args[0] === "status" ? sodaStatus(true) : sodaPull(true),
          stderr: "",
        };
      },
      runGit: async (args) => {
        calls.push(recordCall("git", args));
        if (args.join(" ") === "rev-parse HEAD") {
          return { stdout: revisions.shift() ?? "def456\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
      runNpm: async (args) => {
        calls.push(recordCall("npm", args));
        return { stdout: "", stderr: "" };
      },
    });

    assert.deepEqual(calls, [
      "git rev-parse HEAD",
      "sd status",
      "sd pull",
      "git rev-parse HEAD",
      "npm install --no-audit --no-fund",
      "npm run build",
    ]);
    assert.equal(calls.includes("git pull --ff-only"), false);
    assert.equal(result.pulled, true);
    assert.equal(result.installed, true);
    assert.equal(result.built, true);
  });

  it("skips install and build when sd pull does not update the worktree", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      target: { dir: "repo", isLinked: true },
      hasSodaWorkspace: () => false,
      runSd: async (args) => {
        calls.push(recordCall("sd", args));
        return {
          stdout: args[0] === "status" ? sodaStatus(true) : sodaPull(false),
          stderr: "",
        };
      },
      runGit: async (args) => {
        calls.push(recordCall("git", args));
        return { stdout: "abc123\n", stderr: "" };
      },
      runNpm: async (args) => {
        calls.push(recordCall("npm", args));
        return { stdout: "", stderr: "" };
      },
    });

    assert.deepEqual(calls, [
      "git rev-parse HEAD",
      "sd status",
      "sd pull",
      "git rev-parse HEAD",
    ]);
    assert.equal(result.alreadyUpToDate, true);
    assert.equal(result.installed, false);
    assert.equal(result.built, false);
  });

  it("falls back to git when sd status reports an uninitialized repo", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      target: { dir: "repo", isLinked: true },
      hasSodaWorkspace: () => false,
      runSd: async (args) => {
        calls.push(recordCall("sd", args));
        return { stdout: sodaStatus(false), stderr: "" };
      },
      runGit: async (args) => {
        calls.push(recordCall("git", args));
        return { stdout: "abc123\n", stderr: "" };
      },
      runNpm: async (args) => {
        calls.push(recordCall("npm", args));
        return { stdout: "", stderr: "" };
      },
    });

    assert.equal(calls.includes("git pull --ff-only"), true);
    assert.equal(result.alreadyUpToDate, true);
  });

  it("falls back to git when sd is not installed", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      target: { dir: "repo", isLinked: true },
      hasSodaWorkspace: () => false,
      runSd: async () => {
        throw new Error("spawn sd ENOENT");
      },
      runGit: async (args) => {
        calls.push(recordCall("git", args));
        return { stdout: "abc123\n", stderr: "" };
      },
      runNpm: async (args) => {
        calls.push(recordCall("npm", args));
        return { stdout: "", stderr: "" };
      },
    });

    assert.equal(calls.includes("git pull --ff-only"), true);
    assert.equal(result.alreadyUpToDate, true);
  });

  it("surfaces sd pull envelope errors without installing or building", async () => {
    const calls: string[] = [];
    await assert.rejects(
      () =>
        runSelfUpdate({
          target: { dir: "repo", isLinked: true },
      hasSodaWorkspace: () => false,
          runSd: async (args) => {
            calls.push(recordCall("sd", args));
            if (args[0] === "status") {
              return { stdout: sodaStatus(true), stderr: "" };
            }
            return { stdout: JSON.stringify({ ok: false, error: "stream is blocked" }), stderr: "" };
          },
          runGit: async (args) => {
            calls.push(recordCall("git", args));
            return { stdout: "abc123\n", stderr: "" };
          },
          runNpm: async (args) => {
            calls.push(recordCall("npm", args));
            return { stdout: "", stderr: "" };
          },
        }),
      /stream is blocked/,
    );

    assert.equal(calls.includes("sd pull"), true);
    assert.equal(calls.some((call) => call.startsWith("npm ")), false);
  });

  it("marks linkRequired when the install is not linked", async () => {
    const result = await runSelfUpdate({
      target: { dir: "repo", isLinked: false },
      hasSodaWorkspace: () => false,
      runSd: async () => ({ stdout: NOT_SODA, stderr: "" }),
      runGit: async (args) => {
        if (args.join(" ") === "rev-parse HEAD") {
          return { stdout: "abc123\n", stderr: "" };
        }
        return { stdout: "Already up to date.\n", stderr: "" };
      },
      runNpm: async () => ({ stdout: "", stderr: "" }),
    });

    assert.equal(result.linkRequired, true);
    assert.equal(result.isLinked, false);
  });

  it("uses sd pull when soda markers are present even if status probe fails", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      target: { dir: "repo", isLinked: true },
      hasSodaWorkspace: () => true,
      runSd: async (args) => {
        calls.push(recordCall("sd", args));
        if (args[0] === "status") {
          throw new Error("spawn sd ENOENT");
        }
        return { stdout: sodaPull(false), stderr: "" };
      },
      runGit: async (args) => {
        calls.push(recordCall("git", args));
        return { stdout: "abc123\n", stderr: "" };
      },
      runNpm: async (args) => {
        calls.push(recordCall("npm", args));
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(calls.includes("sd pull"), true);
    assert.equal(calls.includes("git pull --ff-only"), false);
    assert.equal(result.alreadyUpToDate, true);
  });

  it("retries with sd pull after soda interlock blocks git pull", async () => {
    const calls: string[] = [];
    const result = await runSelfUpdate({
      target: { dir: "repo", isLinked: true },
      hasSodaWorkspace: () => false,
      runSd: async (args) => {
        calls.push(recordCall("sd", args));
        if (args[0] === "status") {
          return { stdout: sodaStatus(false), stderr: "" };
        }
        return { stdout: sodaPull(false), stderr: "" };
      },
      runGit: async (args) => {
        calls.push(recordCall("git", args));
        if (args.join(" ") === "pull --ff-only") {
          throw new Error("soda: raw git commit blocked in this sd-powered repo");
        }
        return { stdout: "abc123\n", stderr: "" };
      },
      runNpm: async (args) => {
        calls.push(recordCall("npm", args));
        return { stdout: "", stderr: "" };
      },
    });
    assert.equal(calls.includes("git pull --ff-only"), true);
    assert.equal(calls.includes("sd pull"), true);
    assert.equal(result.alreadyUpToDate, true);
  });

  it("hard-fails when markers say soda but sd pull cannot run", async () => {
    await assert.rejects(
      () =>
        runSelfUpdate({
          target: { dir: "repo", isLinked: true },
          hasSodaWorkspace: () => true,
          runSd: async () => {
            throw new Error("spawn sd ENOENT");
          },
          runGit: async () => ({ stdout: "abc123\n", stderr: "" }),
          runNpm: async () => ({ stdout: "", stderr: "" }),
        }),
      /soda-managed.*sd pull failed/i,
    );
  });

  it("recognizes current and legacy no-change git pull output", () => {
    assert.equal(gitPullMadeNoChanges("Already up to date."), true);
    assert.equal(gitPullMadeNoChanges("Already up-to-date."), true);
    assert.equal(gitPullMadeNoChanges("Updating abc..def\nFast-forward"), false);
    assert.equal(isSodaGitInterlockError("soda: raw git commit blocked in this sd-powered repo"), true);
  });
});
