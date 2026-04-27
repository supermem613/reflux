import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, emptyConfig, loadConfig, saveConfig } from "../../src/core/config.js";
import { RefluxError } from "../../src/core/types.js";

let tmp: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reflux-config-test-"));
  configPath = join(tmp, "config.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("ConfigSchema", () => {
  it("accepts a minimal valid config", () => {
    const result = ConfigSchema.parse({ version: 1 });
    assert.deepStrictEqual(result.profiles, []);
    assert.deepStrictEqual(result.mappings, []);
  });

  it("rejects an unsupported version", () => {
    const result = ConfigSchema.safeParse({ version: 2 });
    assert.equal(result.success, false);
  });

  it("requires ghUser on each profile", () => {
    const missing = ConfigSchema.safeParse({
      version: 1,
      profiles: [{ name: "work" }],
    });
    assert.equal(missing.success, false);

    const empty = ConfigSchema.safeParse({
      version: 1,
      profiles: [{ name: "work", ghUser: "" }],
    });
    assert.equal(empty.success, false);
  });

  it("rejects profile names with uppercase letters", () => {
    const result = ConfigSchema.safeParse({
      version: 1,
      profiles: [{ name: "Work", ghUser: "x" }],
    });
    assert.equal(result.success, false);
  });

  it("accepts profile names with hyphens", () => {
    const result = ConfigSchema.parse({
      version: 1,
      profiles: [{ name: "work-acme", ghUser: "work-login" }],
    });
    assert.equal(result.profiles[0].name, "work-acme");
    assert.equal(result.profiles[0].ghUser, "work-login");
  });
});

describe("loadConfig", () => {
  it("returns an empty config when the file doesn't exist", () => {
    const config = loadConfig(configPath);
    assert.deepStrictEqual(config, emptyConfig());
  });

  it("parses a valid config from disk", () => {
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      profiles: [{ name: "work", ghUser: "work-login" }],
      mappings: [{ prefix: "https://github.com/acme/", profile: "work" }],
    }));
    const config = loadConfig(configPath);
    assert.equal(config.profiles[0].name, "work");
    assert.equal(config.profiles[0].ghUser, "work-login");
    assert.equal(config.mappings[0].profile, "work");
  });

  it("throws RefluxError on invalid JSON", () => {
    writeFileSync(configPath, "not json {");
    assert.throws(
      () => loadConfig(configPath),
      (err: Error) => err instanceof RefluxError && /Invalid JSON/.test(err.message),
    );
  });

  it("throws RefluxError on schema mismatch", () => {
    writeFileSync(configPath, JSON.stringify({ version: 99 }));
    assert.throws(
      () => loadConfig(configPath),
      (err: Error) => err instanceof RefluxError && /Invalid config/.test(err.message),
    );
  });

  it("throws when a mapping references an unknown profile", () => {
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      profiles: [{ name: "work", ghUser: "x" }],
      mappings: [{ prefix: "https://github.com/personal/", profile: "personal" }],
    }));
    assert.throws(
      () => loadConfig(configPath),
      (err: Error) => err instanceof RefluxError && /unknown profile 'personal'/.test(err.message),
    );
  });
});

describe("saveConfig", () => {
  it("writes the config to disk with a trailing newline", () => {
    saveConfig(emptyConfig(), configPath);
    assert.equal(existsSync(configPath), true);
    const raw = readFileSync(configPath, "utf-8");
    assert.equal(raw.endsWith("\n"), true);
  });

  it("creates the parent directory if missing", () => {
    const nested = join(tmp, "a", "b", "c", "config.json");
    saveConfig(emptyConfig(), nested);
    assert.equal(existsSync(nested), true);
  });

  it("survives a save → load round-trip", () => {
    const cfg = {
      version: 1 as const,
      profiles: [{ name: "work", ghUser: "work-login" }],
      mappings: [{ prefix: "https://github.com/acme/", profile: "work" }],
    };
    saveConfig(cfg, configPath);
    const reloaded = loadConfig(configPath);
    assert.deepStrictEqual(reloaded, cfg);
  });

  it("rejects an invalid config at save time (defensive validation)", () => {
    assert.throws(() => saveConfig({ version: 99 } as unknown as ReturnType<typeof emptyConfig>, configPath));
  });
});
