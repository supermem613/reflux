import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const HELPER_BIN = join(REPO_ROOT, "dist", "helper.js");
const IS_WINDOWS = platform() === "win32";

let tmp: string;
let stubDir: string;
let env: NodeJS.ProcessEnv;
let ghLog: string;
let ghStateFile: string;

/**
 * Install a stub `gh` binary that simulates the missing-token / login /
 * token-present lifecycle. State is persisted between invocations via a
 * JSON file so the helper sees a different `gh auth token` result before
 * vs after `gh auth login`.
 *
 * State file shape: { signedIn: string[] } — the list of usernames the
 * stub considers authenticated. `auth login --user X` adds X (or whatever
 * the test seeded). `auth token --user X` succeeds iff X is in the list.
 *
 * The test seeds the post-login user via $STUB_GH_LOGIN_AS so it can
 * simulate "user signed in as the wrong account" without rewriting the
 * stub.
 */
function installGhStub(dir: string, logPath: string, statePath: string): void {
  const jsPath = join(dir, "gh-stub.js");
  writeFileSync(statePath, JSON.stringify({ signedIn: [] }) + "\n");
  writeFileSync(
    jsPath,
    `const fs = require("fs");
const args = process.argv.slice(2);
const STATE = ${JSON.stringify(statePath)};
const LOG = ${JSON.stringify(logPath)};
fs.appendFileSync(LOG, JSON.stringify(args) + "\\n");

function readState() {
  return JSON.parse(fs.readFileSync(STATE, "utf-8"));
}
function writeState(s) {
  fs.writeFileSync(STATE, JSON.stringify(s) + "\\n");
}

function findArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (args[0] === "--version") {
  process.stdout.write("gh version 2.91.0 (stub)\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "token") {
  const user = findArg("--user");
  const state = readState();
  if (state.signedIn.includes(user)) {
    process.stdout.write("ghs_stubtoken_for_" + user + "\\n");
    process.exit(0);
  }
  process.stderr.write("no oauth token found for github.com account " + user + "\\n");
  process.exit(1);
}
if (args[0] === "auth" && args[1] === "status") {
  const state = readState();
  if (state.signedIn.length === 0) {
    process.stderr.write("You are not logged into any GitHub hosts.\\n");
    process.exit(1);
  }
  for (const u of state.signedIn) {
    process.stderr.write("- account " + u + " (active)\\n");
  }
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "login") {
  // Drain stdin so the helper's "n\\n" pipe write does not deadlock us.
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => {
    // Simulate the user signing in as whoever STUB_GH_LOGIN_AS says.
    // Default to "" which represents login failure (no one signed in).
    const loginAs = process.env.STUB_GH_LOGIN_AS || "";
    if (loginAs === "__FAIL__") {
      process.stderr.write("stub: login failed by request\\n");
      process.exit(1);
    }
    if (loginAs) {
      const state = readState();
      if (!state.signedIn.includes(loginAs)) state.signedIn.push(loginAs);
      writeState(state);
      process.stdout.write("Authentication complete.\\n");
    }
    process.exit(0);
  });
  return;
}
process.stderr.write("stub gh: unhandled args " + JSON.stringify(args) + "\\n");
process.exit(2);
`,
  );
  if (IS_WINDOWS) {
    writeFileSync(join(dir, "gh.cmd"), `@echo off\r\nnode "${jsPath}" %*\r\n`);
  } else {
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash\nexec node "${jsPath}" "$@"\n`, { mode: 0o755 });
  }
}

function installGitStub(dir: string, logPath: string): void {
  const jsPath = join(dir, "git-stub.js");
  writeFileSync(
    jsPath,
    `const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  if (args[0] === "credential-manager" && args[1] === "get") {
    process.stdout.write("username=stub-passthrough-user\\npassword=stub-passthrough-pass\\n\\n");
  }
  process.exit(0);
});
`,
  );
  if (IS_WINDOWS) {
    writeFileSync(join(dir, "git.cmd"), `@echo off\r\nnode "${jsPath}" %*\r\n`);
  } else {
    writeFileSync(join(dir, "git"), `#!/usr/bin/env bash\nexec node "${jsPath}" "$@"\n`, { mode: 0o755 });
  }
}

function gitCallLog(): string {
  return join(stubDir, "git-calls.log");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reflux-helper-recovery-"));
  stubDir = join(tmp, "stub-bin");
  mkdirSync(stubDir, { recursive: true });
  ghLog = join(tmp, "gh-calls.log");
  ghStateFile = join(tmp, "gh-state.json");
  writeFileSync(ghLog, "");
  writeFileSync(gitCallLog(), "");
  installGhStub(stubDir, ghLog, ghStateFile);
  installGitStub(stubDir, gitCallLog());

  env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    LOCALAPPDATA: join(tmp, "AppData", "Local"),
    REFLUX_GH_BIN: join(stubDir, IS_WINDOWS ? "gh.cmd" : "gh"),
    REFLUX_GIT_BIN: join(stubDir, IS_WINDOWS ? "git.cmd" : "git"),
  };

  // A profile + mapping so the helper takes the reflux-owned path.
  mkdirSync(join(tmp, ".reflux"), { recursive: true });
  writeFileSync(
    join(tmp, ".reflux", "config.json"),
    JSON.stringify({
      version: 1,
      profiles: [{ name: "personal", ghUser: "supermem613" }],
      mappings: [{ prefix: "https://github.com/supermem613/", profile: "personal" }],
    }) + "\n",
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function runHelper(stdin: string, extraEnv: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("node", [HELPER_BIN, "get"], {
    input: stdin,
    env: { ...env, ...extraEnv },
    encoding: "utf-8",
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function ghCalls(): string[][] {
  return readFileSync(ghLog, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as string[]);
}

function gitStubCalls(): string[][] {
  return readFileSync(gitCallLog(), "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as string[]);
}

const REQUEST = "protocol=https\nhost=github.com\npath=supermem613/dotfiles\n\n";

describe("helper — auto-login recovery for missing token", () => {
  it("drives gh auth login when getToken fails for a configured profile, then returns the new token", () => {
    if (!existsSync(HELPER_BIN)) {
      throw new Error(`Helper not built: run \`npm run build\` first. Expected ${HELPER_BIN}`);
    }

    // Seed the stub: login will sign in as supermem613.
    const r = runHelper(REQUEST, { STUB_GH_LOGIN_AS: "supermem613" });

    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert.match(r.stdout, /username=supermem613/);
    assert.match(r.stdout, /password=ghs_stubtoken_for_supermem613/);
    // Critical: stdout must not contain `quit=1` or any gh device-flow noise.
    assert.doesNotMatch(r.stdout, /quit=1/);

    // Call sequence: probe token (fail) → isInstalled probe (--version) → login → status (verify) → re-probe token (succeed).
    const calls = ghCalls();
    assert.deepEqual(calls[0], ["auth", "token", "--hostname", "github.com", "--user", "supermem613"]);
    assert.deepEqual(calls[1], ["--version"]);
    assert.equal(calls[2][0], "auth");
    assert.equal(calls[2][1], "login");
    assert.deepEqual(calls[3].slice(0, 2), ["auth", "status"]);
    assert.deepEqual(calls[4], ["auth", "token", "--hostname", "github.com", "--user", "supermem613"]);

    // We must NOT have spawned GCM as a fallback.
    assert.deepEqual(gitStubCalls(), [], "helper should not invoke git/GCM when auto-login succeeds");

    // The user must see clear stderr messaging explaining what happened.
    assert.match(r.stderr, /Profile personal/);
    assert.match(r.stderr, /supermem613/);
    assert.match(r.stderr, /gh auth login/);
    // CLI-styled status block (icon + indented hints), not the raw WARN log line.
    assert.match(r.stderr, /⚠ Profile personal/);
    assert.doesNotMatch(r.stderr, /WARN \[helper\] gh auth token failed/);
    // Success confirmation after login.
    assert.match(r.stderr, /✓ Signed in as supermem613/);
  });

  it("emits quit=1 and does not call GCM when login succeeds but the wrong user signs in", () => {
    if (!existsSync(HELPER_BIN)) return;

    // User signs in as the wrong github account.
    const r = runHelper(REQUEST, { STUB_GH_LOGIN_AS: "someone-else" });

    assert.equal(r.status, 0);
    assert.match(r.stdout, /quit=1/);
    assert.doesNotMatch(r.stdout, /username=/, "must not emit a credential we do not have");
    assert.match(r.stderr, /no account named supermem613/);
    assert.match(r.stderr, /Update the profile/i);
    assert.match(r.stderr, /✗/);
    assert.deepEqual(gitStubCalls(), []);
  });

  it("respects REFLUX_NO_AUTO_LOGIN=1 by quitting instead of driving login", () => {
    if (!existsSync(HELPER_BIN)) return;

    const r = runHelper(REQUEST, { REFLUX_NO_AUTO_LOGIN: "1", STUB_GH_LOGIN_AS: "supermem613" });

    assert.equal(r.status, 0);
    assert.match(r.stdout, /quit=1/);
    assert.match(r.stderr, /Auto-login disabled by REFLUX_NO_AUTO_LOGIN=1/);
    assert.match(r.stderr, /reflux login personal/);
    // Critically: gh auth login MUST NOT have been spawned.
    const calls = ghCalls();
    const sawLogin = calls.some((c) => c[0] === "auth" && c[1] === "login");
    assert.equal(sawLogin, false, "must not invoke gh auth login when opt-out is set");
    assert.deepEqual(gitStubCalls(), []);
  });

  it("emits quit=1 with a clear message when gh auth login itself fails", () => {
    if (!existsSync(HELPER_BIN)) return;

    const r = runHelper(REQUEST, { STUB_GH_LOGIN_AS: "__FAIL__" });

    assert.equal(r.status, 0);
    assert.match(r.stdout, /quit=1/);
    assert.match(r.stderr, /gh auth login exited 1/);
    assert.match(r.stderr, /reflux login personal/);
    assert.deepEqual(gitStubCalls(), []);
  });

  it("emits quit=1 with install instructions when gh CLI is absent", () => {
    if (!existsSync(HELPER_BIN)) return;

    const r = runHelper(REQUEST, { REFLUX_GH_BIN: join(tmp, "no-gh-here.exe") });

    assert.equal(r.status, 0);
    assert.match(r.stdout, /quit=1/);
    assert.match(r.stderr, /gh CLI is not installed/);
    assert.match(r.stderr, /supermem613/);
    assert.deepEqual(gitStubCalls(), []);
  });

  it("when gh already has the token, returns it directly without driving login", () => {
    if (!existsSync(HELPER_BIN)) return;

    // Pre-seed the stub state as if the user had already signed in.
    writeFileSync(ghStateFile, JSON.stringify({ signedIn: ["supermem613"] }) + "\n");

    const r = runHelper(REQUEST);

    assert.equal(r.status, 0);
    assert.match(r.stdout, /password=ghs_stubtoken_for_supermem613/);
    const calls = ghCalls();
    // Only one gh call: the initial auth token. No login, no status.
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], "token");
  });

  it("does NOT drive gh auth login for unmapped github.com requests (passthrough)", () => {
    if (!existsSync(HELPER_BIN)) return;

    // Path has no mapping → passthrough to GCM. gh must not be invoked.
    const r = runHelper("protocol=https\nhost=github.com\npath=some-other-org/repo\n\n");

    assert.equal(r.status, 0);
    assert.match(r.stdout, /username=stub-passthrough-user/);
    assert.equal(ghCalls().length, 0, "gh must not be invoked for passthrough requests");
    assert.deepEqual(gitStubCalls(), [["credential-manager", "get"]]);
  });
});
