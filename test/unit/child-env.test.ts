import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sanitizedGitChildEnv } from "../../src/utils/child-env.js";

describe("sanitizedGitChildEnv", () => {
  it("strips GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT", () => {
    const env = sanitizedGitChildEnv({
      GIT_CONFIG_PARAMETERS: "'credential.https://github.com.helper=copilot'",
      GIT_CONFIG_COUNT: "2",
      PATH: "/usr/bin",
    });
    assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
  });

  it("preserves every other variable unchanged", () => {
    const env = sanitizedGitChildEnv({
      GIT_CONFIG_COUNT: "2",
      PATH: "/usr/bin",
      REFLUX_GH_BIN: "gh",
    });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.REFLUX_GH_BIN, "gh");
  });

  it("returns a copy and does not mutate the base env", () => {
    const base = { GIT_CONFIG_COUNT: "2", PATH: "/usr/bin" };
    const env = sanitizedGitChildEnv(base);
    assert.equal(base.GIT_CONFIG_COUNT, "2");
    assert.notEqual(env, base);
  });

  it("is a no-op when the injected variables are absent", () => {
    const env = sanitizedGitChildEnv({ PATH: "/usr/bin" });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
  });
});
