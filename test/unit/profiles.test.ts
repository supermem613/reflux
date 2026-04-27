import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, saveConfig } from "../../src/core/config.js";
import {
  addProfile,
  getProfile,
  listProfiles,
  removeProfile,
} from "../../src/core/profiles.js";
import { RefluxError } from "../../src/core/types.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reflux-profiles-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function configPath(): string {
  return join(tmp, ".reflux", "config.json");
}

describe("profiles CRUD", () => {
  it("addProfile persists name + ghUser", () => {
    addProfile({ name: "work", ghUser: "work-login" }, configPath());
    const p = getProfile("work", { version: 1, profiles: [{ name: "work", ghUser: "work-login" }], mappings: [] });
    assert.equal(p?.ghUser, "work-login");
  });

  it("addProfile rejects duplicates", () => {
    addProfile({ name: "work", ghUser: "x" }, configPath());
    assert.throws(
      () => addProfile({ name: "work", ghUser: "y" }, configPath()),
      (err: Error) => err instanceof RefluxError && /already exists/.test(err.message),
    );
  });

  it("listProfiles returns what was added", () => {
    const config: Config = {
      version: 1,
      profiles: [{ name: "work", ghUser: "u1" }, { name: "personal", ghUser: "u2" }],
      mappings: [],
    };
    assert.equal(listProfiles(config).length, 2);
  });

  it("getProfile finds by name", () => {
    const config: Config = {
      version: 1,
      profiles: [{ name: "work", ghUser: "u1" }],
      mappings: [],
    };
    const p = getProfile("work", config);
    assert.equal(p?.ghUser, "u1");
    assert.equal(getProfile("missing", config), undefined);
  });

  it("removeProfile drops mappings that referenced it", () => {
    saveConfig({
      version: 1,
      profiles: [{ name: "work", ghUser: "u1" }, { name: "personal", ghUser: "u2" }],
      mappings: [
        { prefix: "https://github.com/acme/", profile: "work" },
        { prefix: "https://github.com/", profile: "personal" },
      ],
    }, configPath());

    const after = removeProfile("work", configPath());
    assert.equal(after.profiles.length, 1);
    assert.equal(after.mappings.length, 1);
    assert.equal(after.mappings[0].profile, "personal");
  });

  it("removeProfile throws on unknown name", () => {
    assert.throws(
      () => removeProfile("nope", configPath()),
      (err: Error) => err instanceof RefluxError,
    );
  });
});
