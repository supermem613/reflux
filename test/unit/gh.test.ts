import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import {
  authStatus,
  getToken,
  isAuthenticated,
  isInstalled,
  loginInteractive,
  logout,
  refreshScopesForUser,
  version,
} from "../../src/auth/gh.js";
import { loginCommand } from "../../src/commands/login.js";

let tmp: string;
let originalGhBin: string | undefined;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

/**
 * Write a stub `gh` binary at `tmp/gh.cmd` (Windows) / `tmp/gh` (POSIX) and
 * point REFLUX_GH_BIN at it. Stub behaviour is encoded as a Node.js script
 * the cmd-shim invokes; pass JS source to `script`.
 */
function installStub(script: string): string {
  const stubJs = join(tmp, "stub.js");
  writeFileSync(stubJs, script, "utf-8");
  if (platform() === "win32") {
    const cmd = join(tmp, "gh.cmd");
    writeFileSync(cmd, `@echo off\r\nnode "${stubJs}" %*\r\n`, "utf-8");
    return cmd;
  }
  const sh = join(tmp, "gh");
  writeFileSync(sh, `#!/usr/bin/env bash\nexec node "${stubJs}" "$@"\n`, "utf-8");
  chmodSync(sh, 0o755);
  return sh;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reflux-gh-test-"));
  originalGhBin = process.env.REFLUX_GH_BIN;
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
});

afterEach(() => {
  if (originalGhBin === undefined) {
    delete process.env.REFLUX_GH_BIN;
  } else {
    process.env.REFLUX_GH_BIN = originalGhBin;
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("gh wrapper — isInstalled / version", () => {
  it("returns false when REFLUX_GH_BIN points at a missing path", () => {
    process.env.REFLUX_GH_BIN = join(tmp, "nope.exe");
    assert.equal(isInstalled(), false);
    assert.equal(version(), null);
  });

  it("returns true when the stub responds 0 to --version", () => {
    process.env.REFLUX_GH_BIN = installStub(`
      if (process.argv[2] === "--version") { process.stdout.write("gh version 2.91.0\\n"); process.exit(0); }
      process.exit(1);
    `);
    assert.equal(isInstalled(), true);
    assert.match(version() ?? "", /gh version/);
  });
});

describe("gh wrapper — getToken", () => {
  it("returns the token on a clean stub run", () => {
    process.env.REFLUX_GH_BIN = installStub(`
      const args = process.argv.slice(2);
      if (args[0] === "auth" && args[1] === "token" && args.includes("--user") && args[args.indexOf("--user")+1] === "personal-login") {
        process.stdout.write("gho_FAKE_TOKEN_VALUE\\n");
        process.exit(0);
      }
      process.exit(1);
    `);
    const r = getToken("personal-login");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.token, "gho_FAKE_TOKEN_VALUE");
    }
  });

  it("reports the stderr reason when gh exits non-zero", () => {
    process.env.REFLUX_GH_BIN = installStub(`
      process.stderr.write("no oauth token found for github.com account work-login\\n");
      process.exit(1);
    `);
    const r = getToken("work-login");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /no oauth token/);
    }
  });

  it("reports a reason when stdout is empty even with exit 0", () => {
    process.env.REFLUX_GH_BIN = installStub(`process.exit(0);`);
    const r = getToken("anybody");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /empty/);
    }
  });
});

describe("gh wrapper — authStatus", () => {
  it("parses the multi-account 2.x format", () => {
    process.env.REFLUX_GH_BIN = installStub(`
      // gh writes status to stderr historically; mimic that.
      process.stderr.write([
        "github.com",
        "  \\u2713 Logged in to github.com account personal-login (keyring)",
        "  - Active account: true",
        "  - Token scopes: 'gist', 'read:org', 'repo'",
        "  \\u2713 Logged in to github.com account work-login (keyring)",
        "  - Active account: false",
        "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
      ].join("\\n") + "\\n");
      process.exit(0);
    `);
    const accounts = authStatus();
    assert.equal(accounts.length, 2);
    const personal = accounts.find((a) => a.user === "personal-login");
    const work = accounts.find((a) => a.user === "work-login");
    assert.ok(personal && work);
    assert.equal(personal!.active, true);
    assert.equal(work!.active, false);
    assert.deepEqual(personal!.scopes, ["gist", "read:org", "repo"]);
    assert.deepEqual(work!.scopes, ["gist", "read:org", "repo", "workflow"]);
  });

  it("returns [] when gh is missing", () => {
    process.env.REFLUX_GH_BIN = join(tmp, "missing.exe");
    assert.deepStrictEqual(authStatus(), []);
  });

  it("isAuthenticated reflects authStatus membership", () => {
    process.env.REFLUX_GH_BIN = installStub(`
      process.stderr.write("github.com\\n  \\u2713 Logged in to github.com account personal-login (keyring)\\n  - Active account: true\\n");
      process.exit(0);
    `);
    assert.equal(isAuthenticated("personal-login"), true);
    assert.equal(isAuthenticated("nobody"), false);
  });
});

describe("gh wrapper — login and scope refresh", () => {
  it("requests workflow scope during interactive login", async () => {
    const calls: string[] = [];
    process.env.REFLUX_GH_BIN = installStub(`
      const fs = require("fs");
      fs.appendFileSync(${JSON.stringify(join(tmp, "calls.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
      process.stdin.on("data", () => {});
      process.stdin.on("end", () => process.exit(0));
    `);

    const code = await loginInteractive([], { quietStdout: true });

    assert.equal(code, 0);
    calls.push(...readFileSync(join(tmp, "calls.log"), "utf-8").trim().split(/\r?\n/));
    assert.deepEqual(JSON.parse(calls[0]), [
      "auth",
      "login",
      "--hostname",
      "github.com",
      "--git-protocol",
      "https",
      "--web",
      "--scopes",
      "workflow",
    ]);
  });

  it("refreshes workflow scope for the requested gh user and restores the previous active user", async () => {
    process.env.REFLUX_GH_BIN = installStub(`
      const fs = require("fs");
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(join(tmp, "calls.log"))}, JSON.stringify(args) + "\\n");
      if (args[0] === "auth" && args[1] === "status") {
        process.stderr.write([
          "github.com",
          "  \\u2713 Logged in to github.com account personal-login (keyring)",
          "  - Active account: true",
          "  - Token scopes: 'gist', 'read:org', 'repo'",
          "  \\u2713 Logged in to github.com account work-login (keyring)",
          "  - Active account: false",
          "  - Token scopes: 'gist', 'read:org', 'repo'",
        ].join("\\n") + "\\n");
        process.exit(0);
      }
      if (args[0] === "auth" && (args[1] === "switch" || args[1] === "refresh")) {
        process.exit(0);
      }
      process.exit(1);
    `);

    const result = await refreshScopesForUser("work-login", ["workflow"], { quietStdout: true });

    assert.equal(result.ok, true);
    const calls = readFileSync(join(tmp, "calls.log"), "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls, [
      ["auth", "status", "--hostname", "github.com"],
      ["auth", "switch", "--hostname", "github.com", "--user", "work-login"],
      ["auth", "refresh", "--hostname", "github.com", "--scopes", "workflow"],
      ["auth", "switch", "--hostname", "github.com", "--user", "personal-login"],
    ]);
  });
});

describe("gh wrapper — logout", () => {
  it("returns ok on a clean stub run", () => {
    process.env.REFLUX_GH_BIN = installStub(`process.exit(0);`);
    const r = logout("anyone");
    assert.equal(r.ok, true);
  });

  it("returns the failure reason on non-zero exit", () => {
    process.env.REFLUX_GH_BIN = installStub(`
      process.stderr.write("not logged in to any hosts\\n");
      process.exit(1);
    `);
    const r = logout("nobody");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason ?? "", /not logged in/);
    }
  });
});

describe("reflux login — workflow scope", () => {
  it("refreshes workflow scope instead of no-oping when the gh user is already signed in", async () => {
    const callsFile = join(tmp, "calls.log");
    process.env.REFLUX_GH_BIN = installStub(`
      const fs = require("fs");
      const args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
      if (args[0] === "--version") {
        process.stdout.write("gh version 2.91.0\\n");
        process.exit(0);
      }
      if (args[0] === "auth" && args[1] === "status") {
        process.stderr.write([
          "github.com",
          "  \\u2713 Logged in to github.com account personal-login (keyring)",
          "  - Active account: true",
          "  - Token scopes: 'gist', 'read:org', 'repo'",
        ].join("\\n") + "\\n");
        process.exit(0);
      }
      if (args[0] === "auth" && args[1] === "refresh") {
        process.exit(0);
      }
      process.exit(1);
    `);
    mkdirSync(join(tmp, ".reflux"), { recursive: true });
    writeFileSync(
      join(tmp, ".reflux", "config.json"),
      JSON.stringify({
        version: 1,
        profiles: [{ name: "personal", ghUser: "personal-login" }],
        mappings: [],
      }) + "\n",
    );

    await loginCommand("personal");

    const calls = readFileSync(callsFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls, [
      ["--version"],
      ["auth", "status", "--hostname", "github.com"],
      ["auth", "status", "--hostname", "github.com"],
      ["auth", "status", "--hostname", "github.com"],
      ["auth", "refresh", "--hostname", "github.com", "--scopes", "workflow"],
    ]);
  });
});
