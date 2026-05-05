import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const HELPER_BIN = join(REPO_ROOT, "dist", "helper.js");

let tmp: string;
let stubDir: string;
let env: NodeJS.ProcessEnv;
let stubLog: string;

/**
 * Install a stub `git.cmd` at the front of PATH so the helper's passthrough
 * never invokes the real `git credential-manager` (which would hit real
 * GCM and could pop a real browser auth window). The stub:
 *   - Logs invocations to `stubLog` so the test can assert what was called
 *   - For `credential-manager get`: emits canned credentials and exits 0
 *   - For `credential-manager erase`/`store`: exits 0 silently
 *   - For anything else: exits 1 (so the test fails loudly if the helper
 *     ever spawns git for an unexpected reason)
 */
function installGitStub(dir: string, logPath: string): void {
  const jsPath = join(dir, "git-stub.js");
  const cmdPath = join(dir, "git.cmd");
  writeFileSync(
    jsPath,
    `const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args[0] !== "credential-manager") {
  process.stderr.write("stub git: unexpected command " + JSON.stringify(args) + "\\n");
  process.exit(1);
}
const action = args[1];
// Drain stdin so the helper can finish writing.
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  if (action === "get") {
    process.stdout.write("username=stub-passthrough-user\\npassword=stub-passthrough-pass\\n\\n");
  }
  process.exit(0);
});
`,
  );
  writeFileSync(cmdPath, `@echo off\r\nnode "${jsPath}" %*\r\n`);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reflux-helper-int-"));
  stubDir = join(tmp, "stub-bin");
  mkdirSync(stubDir, { recursive: true });
  stubLog = join(tmp, "git-calls.log");
  writeFileSync(stubLog, "");
  installGitStub(stubDir, stubLog);

  // REFLUX_GIT_BIN points the helper at our stub git, so the passthrough
  // path never invokes real `git credential-manager` (which would hit real
  // GCM and could pop a browser auth window for the developer).
  env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    LOCALAPPDATA: join(tmp, "AppData", "Local"),
    REFLUX_GH_BIN: join(tmp, "no-gh-here.exe"),
    REFLUX_GIT_BIN: join(stubDir, "git.cmd"),
  };
  // Empty config so loadConfig returns the default empty shape.
  mkdirSync(join(tmp, ".reflux"), { recursive: true });
  writeFileSync(
    join(tmp, ".reflux", "config.json"),
    JSON.stringify({ version: 1, profiles: [], mappings: [] }) + "\n",
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function runHelper(action: string, stdin: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", [HELPER_BIN, action], {
    input: stdin,
    env,
    encoding: "utf-8",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function gitCalls(): string[][] {
  return readFileSync(stubLog, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as string[]);
}

describe("helper protocol — passthrough path", () => {
  it("passes unmapped github.com through to `git credential-manager get`", () => {
    if (!existsSync(HELPER_BIN)) {
      throw new Error(`Helper not built: run \`npm run build\` first. Expected ${HELPER_BIN}`);
    }
    const result = runHelper("get", "protocol=https\nhost=github.com\n\n");
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /username=stub-passthrough-user/);
    assert.deepEqual(gitCalls(), [["credential-manager", "get"]]);
  });

  it("passes non-github.com hosts through to GCM as well", () => {
    if (!existsSync(HELPER_BIN)) {
      return;
    }
    const result = runHelper("get", "protocol=https\nhost=dev.azure.com\n\n");
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    assert.deepEqual(gitCalls(), [["credential-manager", "get"]]);
  });

  it("forwards `erase` to GCM via `git credential-manager erase`", () => {
    if (!existsSync(HELPER_BIN)) {
      return;
    }
    const result = runHelper("erase", "protocol=https\nhost=dev.azure.com\n\n");
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    assert.deepEqual(gitCalls(), [["credential-manager", "erase"]]);
  });

  it("forwards `store` to GCM via `git credential-manager store`", () => {
    if (!existsSync(HELPER_BIN)) {
      return;
    }
    const result = runHelper("store", "protocol=https\nhost=dev.azure.com\nusername=foo\npassword=bar\n\n");
    assert.equal(result.status, 0, `expected 0, got ${result.status}: ${result.stderr}`);
    assert.deepEqual(gitCalls(), [["credential-manager", "store"]]);
  });
});
