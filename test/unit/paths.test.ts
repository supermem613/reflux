import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as paths from "../../src/utils/paths.js";

let tmp: string;
let originalLocalAppData: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reflux-paths-test-"));
  originalLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = tmp;
});

afterEach(() => {
  if (originalLocalAppData === undefined) {
    delete process.env.LOCALAPPDATA;
  } else {
    process.env.LOCALAPPDATA = originalLocalAppData;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("paths", () => {
  it("respects LOCALAPPDATA for refluxRoot", () => {
    assert.equal(paths.refluxRoot(), join(tmp, "reflux"));
    assert.equal(paths.logFile(), join(tmp, "reflux", "logs", "reflux.log"));
  });

  it("ensureDir is idempotent", () => {
    const target = join(tmp, "a", "b", "c");
    paths.ensureDir(target);
    paths.ensureDir(target);
    writeFileSync(join(target, "ok.txt"), "ok");
  });
});
