import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/utils/logger.js";

let tmp: string;
let originalLocalAppData: string | undefined;
let originalDebug: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reflux-logger-test-"));
  originalLocalAppData = process.env.LOCALAPPDATA;
  originalDebug = process.env.REFLUX_DEBUG;
  process.env.LOCALAPPDATA = tmp;
  delete process.env.REFLUX_DEBUG;
});

afterEach(() => {
  if (originalLocalAppData === undefined) {
    delete process.env.LOCALAPPDATA;
  } else {
    process.env.LOCALAPPDATA = originalLocalAppData;
  }
  if (originalDebug === undefined) {
    delete process.env.REFLUX_DEBUG;
  } else {
    process.env.REFLUX_DEBUG = originalDebug;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("logger", () => {
  it("writes to %LOCALAPPDATA%\\reflux\\logs\\reflux.log", () => {
    const log = createLogger("test-scope");
    log.info("hello world", { key: "value" });

    const logPath = join(tmp, "reflux", "logs", "reflux.log");
    assert.equal(existsSync(logPath), true);
    const content = readFileSync(logPath, "utf-8");
    assert.match(content, /\[test-scope\] hello world/);
    assert.match(content, /"key":"value"/);
  });

  it("emits ISO timestamp + pid + level + scope", () => {
    const log = createLogger("scope");
    log.warn("warning text");
    const content = readFileSync(join(tmp, "reflux", "logs", "reflux.log"), "utf-8");
    assert.match(content, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z pid=\d+ WARN \[scope\] warning text/m);
  });

  it("does not throw when the log directory cannot be created", () => {
    // Point LOCALAPPDATA at a regular file so mkdirSync(recursive) fails.
    const blocker = join(tmp, "blocker.txt");
    writeFileSync(blocker, "x");
    process.env.LOCALAPPDATA = blocker;
    const log = createLogger("scope");
    // Must not throw even though file IO fails internally.
    log.info("ignored");
  });
});
