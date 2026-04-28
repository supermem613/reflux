import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installCommand,
  uninstallCommand,
  inspectHelperList,
  readHelperValues,
  readUseHttpPath,
} from "../../src/commands/install.js";

const URL_SCOPE = "credential.https://github.com";
const HELPER_KEY = `${URL_SCOPE}.helper`;
const USE_HTTP_PATH_KEY = `${URL_SCOPE}.useHttpPath`;

let tmp: string;
const originalHome = process.env.HOME;
const originalUserprofile = process.env.USERPROFILE;
const originalLocalAppData = process.env.LOCALAPPDATA;

function git(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("git", ["config", "--global", ...args], { encoding: "utf-8" });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; stdout?: Buffer | string };
    return { stdout: typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? ""), status: e.status ?? 1 };
  }
}

function readHelperValuesSync(): string[] {
  const r = git(["--get-all", HELPER_KEY]);
  if (r.status !== 0 && r.stdout === "") return [];
  return r.stdout.replace(/\r?\n$/, "").split(/\r?\n/);
}

function silenceConsole<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  console.log = () => {};
  return fn().finally(() => {
    console.log = origLog;
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reflux-install-int-"));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.LOCALAPPDATA = join(tmp, "AppData", "Local");
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserprofile;
  process.env.LOCALAPPDATA = originalLocalAppData;
  rmSync(tmp, { recursive: true, force: true });
});

describe("install command — git config side effects", () => {
  it("on a fresh HOME, writes the empty reset, the reflux helper, and useHttpPath", async () => {
    assert.deepEqual(readHelperValuesSync(), []);
    await silenceConsole(installCommand);

    const values = readHelperValuesSync();
    assert.deepEqual(values, ["", "reflux"], "expected helper list to be exactly [empty, reflux] in that order");
    assert.equal(git(["--get", USE_HTTP_PATH_KEY]).stdout.trim(), "true");
  });

  it("repairs the broken state of `helper = reflux` with no preceding reset", async () => {
    // This is the exact state install.ts would silently produce before the
    // fix to inspectHelperList. Simulate it by writing only `reflux`.
    git(["--add", HELPER_KEY, "reflux"]);
    assert.deepEqual(readHelperValuesSync(), ["reflux"]);

    await silenceConsole(installCommand);

    assert.deepEqual(readHelperValuesSync(), ["", "reflux"]);
  });

  it("places the empty reset before reflux even if reflux was already present in the wrong order", async () => {
    git(["--add", HELPER_KEY, "reflux"]);
    git(["--add", HELPER_KEY, ""]); // wrong order: reset after reflux
    assert.deepEqual(readHelperValuesSync(), ["reflux", ""]);

    await silenceConsole(installCommand);

    assert.deepEqual(readHelperValuesSync(), ["", "reflux"]);
  });

  it("is idempotent — re-running install does not duplicate entries", async () => {
    await silenceConsole(installCommand);
    await silenceConsole(installCommand);
    await silenceConsole(installCommand);

    assert.deepEqual(readHelperValuesSync(), ["", "reflux"]);
    assert.equal(git(["--get", USE_HTTP_PATH_KEY]).stdout.trim(), "true");
  });

  it("leaves a pre-existing global `credential.helper = manager` alone", async () => {
    // Mirrors Git for Windows' system-config default. install must not
    // touch the unscoped key — only add URL-scoped overrides.
    git(["credential.helper", "manager"]);
    await silenceConsole(installCommand);

    assert.equal(git(["--get", "credential.helper"]).stdout.trim(), "manager");
    assert.deepEqual(readHelperValuesSync(), ["", "reflux"]);
  });

  it("sets useHttpPath even when the helper list is already correct", async () => {
    git(["--add", HELPER_KEY, ""]);
    git(["--add", HELPER_KEY, "reflux"]);
    // useHttpPath deliberately not set.
    assert.equal(git(["--get", USE_HTTP_PATH_KEY]).status, 1);

    await silenceConsole(installCommand);

    assert.equal(git(["--get", USE_HTTP_PATH_KEY]).stdout.trim(), "true");
  });
});

describe("uninstall command — git config side effects", () => {
  it("removes the reflux helper, the empty reset, and useHttpPath", async () => {
    await silenceConsole(installCommand);
    assert.deepEqual(readHelperValuesSync(), ["", "reflux"]);

    await silenceConsole(uninstallCommand);

    assert.deepEqual(readHelperValuesSync(), []);
    assert.equal(git(["--get", USE_HTTP_PATH_KEY]).status, 1);
  });

  it("is a no-op when nothing was installed", async () => {
    await silenceConsole(uninstallCommand);
    assert.deepEqual(readHelperValuesSync(), []);
  });
});

describe("readHelperValues", () => {
  it("returns [] when the key is unset", async () => {
    assert.deepEqual(await readHelperValues(), []);
  });

  it("returns [\"\"] for a single empty value (distinct from unset)", async () => {
    git(["--add", HELPER_KEY, ""]);
    assert.deepEqual(await readHelperValues(), [""]);
  });

  it("preserves order of multiple values", async () => {
    git(["--add", HELPER_KEY, ""]);
    git(["--add", HELPER_KEY, "reflux"]);
    git(["--add", HELPER_KEY, "manager"]);
    assert.deepEqual(await readHelperValues(), ["", "reflux", "manager"]);
  });
});

describe("readUseHttpPath", () => {
  it("returns false when unset", async () => {
    assert.equal(await readUseHttpPath(), false);
  });

  it("returns true only for the literal string \"true\"", async () => {
    git([USE_HTTP_PATH_KEY, "false"]);
    assert.equal(await readUseHttpPath(), false);
    git([USE_HTTP_PATH_KEY, "true"]);
    assert.equal(await readUseHttpPath(), true);
  });
});

describe("inspectHelperList — pure decision logic", () => {
  it("flags missing reflux", () => {
    assert.deepEqual(inspectHelperList([]), { hasReflux: false, hasResetBeforeReflux: false });
    assert.deepEqual(inspectHelperList([""]), { hasReflux: false, hasResetBeforeReflux: false });
    assert.deepEqual(inspectHelperList(["manager"]), { hasReflux: false, hasResetBeforeReflux: false });
  });

  it("flags reflux with no reset", () => {
    assert.deepEqual(inspectHelperList(["reflux"]), { hasReflux: true, hasResetBeforeReflux: false });
  });

  it("flags reset that comes after reflux as broken", () => {
    assert.deepEqual(inspectHelperList(["reflux", ""]), { hasReflux: true, hasResetBeforeReflux: false });
  });

  it("accepts reset before reflux", () => {
    assert.deepEqual(inspectHelperList(["", "reflux"]), { hasReflux: true, hasResetBeforeReflux: true });
  });

  it("accepts other entries between reset and reflux", () => {
    assert.deepEqual(inspectHelperList(["", "manager", "reflux"]), { hasReflux: true, hasResetBeforeReflux: true });
  });
});
