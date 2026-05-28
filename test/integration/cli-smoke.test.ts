import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CLI_BIN = join(REPO_ROOT, "dist", "cli.js");

let tmp: string;
let env: NodeJS.ProcessEnv;

function installGhStub(accounts: string[] = []): string {
  const stubJs = join(tmp, "gh-stub.js");
  writeFileSync(
    stubJs,
    `
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("gh version 2.91.0\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  for (const account of ${JSON.stringify(accounts)}) {
    process.stderr.write("- account " + account + " (active)\\n");
  }
  process.exit(0);
}
process.exit(1);
`,
    "utf-8",
  );
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
  tmp = mkdtempSync(join(tmpdir(), "reflux-cli-int-"));
  env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    LOCALAPPDATA: join(tmp, "AppData", "Local"),
    Path: process.env.PATH ?? process.env.Path ?? "",
    // Block real `gh` lookups in CLI smoke tests by pointing at a missing
    // path. The CLI prints "gh missing" / "not signed in" but still runs.
    REFLUX_GH_BIN: join(tmp, "no-gh-here.exe"),
  };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function reflux(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", [CLI_BIN, ...args], { env, encoding: "utf-8" });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("CLI smoke tests", () => {
  it("`reflux` (no args) prints version + help and exits 0", () => {
    if (!existsSync(CLI_BIN)) {
      throw new Error("Build dist/cli.js first");
    }
    const r = reflux();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /reflux v\d+\.\d+\.\d+/);
    assert.match(r.stdout, /Usage: reflux/);
  });

  it("`reflux --help` lists registered commands", () => {
    const r = reflux("--help");
    assert.equal(r.status, 0);
    for (const cmd of ["doctor", "install", "login", "logout", "map", "profile", "status", "uninstall", "update"]) {
      assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `expected '${cmd}' in help output`);
    }
    assert.match(r.stdout, /auto-learn ready/);
  });

  it("`map resolve` explains that missing explicit github.com mappings do not mean passthrough", () => {
    const r = reflux("map", "resolve", "https://github.com/supermem613/reflux.git");

    assert.equal(r.status, 1);
    assert.match(r.stdout, /No explicit mapping/);
    assert.match(r.stdout, /auto-learn safe personal-owner mappings/);
    assert.doesNotMatch(r.stdout, /passthrough to GCM/i);
  });

  it("`profile add` requires --gh-user", () => {
    const r = reflux("profile", "add", "work");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /gh-user|required/i);
  });

  it("`profile add` then `profile list` reflects the new profile", () => {
    let r = reflux("profile", "add", "work", "--gh-user", "work-login");
    assert.equal(r.status, 0, `add failed: ${r.stderr}`);

    r = reflux("profile", "list");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /work/);
    assert.match(r.stdout, /work-login/);
  });

  it("`profile show` includes ghUser", () => {
    reflux("profile", "add", "work", "--gh-user", "work-login");
    const r = reflux("profile", "show", "work");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /gh user/);
    assert.match(r.stdout, /work-login/);
  });

  it("`map add` rejects mapping to a missing profile", () => {
    const r = reflux("map", "add", "https://github.com/foo/", "ghost-profile");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ghost-profile|profile/i);
  });

  it("`map add` then `map resolve` returns the mapped profile", () => {
    reflux("profile", "add", "work", "--gh-user", "work-login");
    let r = reflux("map", "add", "https://github.com/acme/", "work");
    assert.equal(r.status, 0, `map add failed: ${r.stderr}`);

    r = reflux("map", "resolve", "https://github.com/acme/widgets.git");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /work/);
  });

  it("`profile remove` drops associated mappings", () => {
    reflux("profile", "add", "work", "--gh-user", "x");
    reflux("map", "add", "https://github.com/acme/", "work");
    const r = reflux("profile", "remove", "work");
    assert.equal(r.status, 0, `remove failed: ${r.stderr}`);

    const list = reflux("map", "list");
    assert.doesNotMatch(list.stdout, /acme/);
  });

  it("`status` prints sections for gh, profiles, mappings", () => {
    reflux("profile", "add", "work", "--gh-user", "work-login");
    const r = reflux("status");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /gh CLI/);
    assert.match(r.stdout, /Profile/i);
    assert.match(r.stdout, /Mapping/i);
  });

  it("`status` describes empty mappings as auto-learnable instead of passthrough", () => {
    const r = reflux("status");

    assert.equal(r.status, 0);
    assert.match(r.stdout, /personal github\.com owners can auto-learn/);
    assert.doesNotMatch(r.stdout, /every git request will passthrough/i);
  });

  it("`doctor` runs to completion (exits non-zero with gh missing, but does not crash)", () => {
    const r = reflux("doctor");
    // gh is intentionally missing in this test sandbox; doctor will report
    // the failure and exit 1. The important thing is it doesn't throw.
    assert.notEqual(r.status, null);
    assert.match(r.stdout, /gh CLI/);
  });

  it("`doctor` fails when reflux is installed but gh has no signed-in accounts", () => {
    env.REFLUX_GH_BIN = installGhStub();
    spawnSync("git", ["config", "--global", "--add", "credential.https://github.com.helper", ""], { env });
    spawnSync("git", ["config", "--global", "--add", "credential.https://github.com.helper", "reflux"], { env });
    spawnSync("git", ["config", "--global", "credential.https://github.com.useHttpPath", "true"], { env });

    const r = reflux("doctor");

    assert.equal(r.status, 1);
    assert.match(r.stdout, /gh accounts/i);
  });

  it("`doctor` accepts empty profiles and mappings when gh accounts are available to auto-learn", () => {
    env.REFLUX_GH_BIN = installGhStub(["supermem613"]);
    spawnSync("git", ["config", "--global", "--add", "credential.https://github.com.helper", ""], { env });
    spawnSync("git", ["config", "--global", "--add", "credential.https://github.com.helper", "reflux"], { env });
    spawnSync("git", ["config", "--global", "credential.https://github.com.useHttpPath", "true"], { env });

    const r = reflux("doctor");

    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /will auto-create profiles/i);
    assert.match(r.stdout, /personal-owner repos auto-learn/i);
  });
});
