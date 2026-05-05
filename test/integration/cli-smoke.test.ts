import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const CLI_BIN = join(REPO_ROOT, "dist", "cli.js");

let tmp: string;
let env: NodeJS.ProcessEnv;

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

  it("`doctor` runs to completion (exits non-zero with gh missing, but does not crash)", () => {
    const r = reflux("doctor");
    // gh is intentionally missing in this test sandbox; doctor will report
    // the failure and exit 1. The important thing is it doesn't throw.
    assert.notEqual(r.status, null);
    assert.match(r.stdout, /gh CLI/);
  });
});
