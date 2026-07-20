import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseHelperScopes,
  computeEffectiveGithubHelpers,
  detectRefluxShadow,
} from "../../src/commands/install.js";
import { checkLocalHelperShadow } from "../../src/commands/doctor.js";

// Real `git config --list --show-scope` shape: "<scope>\t<key>=<value>".
const REFLUX_REPO_LIST = [
  "system\tcredential.helper=manager",
  "global\tcredential.helper=manager",
  "global\tcredential.https://github.com.helper=",
  "global\tcredential.https://github.com.helper=reflux",
  "global\tcredential.https://gist.github.com.helper=",
  "global\tcredential.https://gist.github.com.helper=!gh auth git-credential",
  "global\tuser.name=Marcus Markiewicz",
].join("\n");

const EIDOS_REPO_LIST = [
  "system\tcredential.helper=manager",
  "global\tcredential.helper=manager",
  "global\tcredential.https://github.com.helper=",
  "global\tcredential.https://github.com.helper=reflux",
  "global\tcredential.https://gist.github.com.helper=",
  "global\tcredential.https://gist.github.com.helper=!gh auth git-credential",
  "local\tcredential.helper=",
  "local\tcredential.helper=!gh auth git-credential",
].join("\n");

// Global config that never registered reflux with a reset in front of it.
// This is the install-registration problem, owned by a different doctor check.
const GLOBAL_ONLY_NO_RESET = [
  "system\tcredential.helper=manager",
  "global\tcredential.https://github.com.helper=reflux",
].join("\n");

// A github.com helper injected on the command line via GIT_CONFIG_PARAMETERS
// (exactly what Copilot CLI injects). git labels the scope `command`, resets
// the accumulated list, and forces its own helper ahead of reflux.
const COMMAND_INJECTED_LIST = [
  "system\tcredential.helper=manager",
  "global\tcredential.helper=manager",
  "global\tcredential.https://github.com.helper=",
  "global\tcredential.https://github.com.helper=reflux",
  "command\tcredential.https://github.com.helper=",
  "command\tcredential.https://github.com.helper=copilot",
].join("\n");

describe("parseHelperScopes", () => {
  it("keeps only generic and github.com helper keys, in order, with scope", () => {
    const parsed = parseHelperScopes(EIDOS_REPO_LIST);
    assert.deepEqual(parsed, [
      { scope: "system", value: "manager" },
      { scope: "global", value: "manager" },
      { scope: "global", value: "" },
      { scope: "global", value: "reflux" },
      { scope: "local", value: "" },
      { scope: "local", value: "!gh auth git-credential" },
    ]);
  });

  it("ignores gist.github.com and unrelated keys", () => {
    const parsed = parseHelperScopes(REFLUX_REPO_LIST);
    assert.deepEqual(
      parsed.map((p) => p.value),
      ["manager", "manager", "", "reflux"],
    );
  });
});

describe("computeEffectiveGithubHelpers", () => {
  it("clears the accumulated list on an empty-string reset", () => {
    const effective = computeEffectiveGithubHelpers(parseHelperScopes(EIDOS_REPO_LIST));
    assert.deepEqual(
      effective.map((e) => e.value),
      ["!gh auth git-credential"],
    );
  });

  it("leaves reflux as the sole effective helper for a clean global config", () => {
    const effective = computeEffectiveGithubHelpers(parseHelperScopes(REFLUX_REPO_LIST));
    assert.deepEqual(
      effective.map((e) => e.value),
      ["reflux"],
    );
  });
});

describe("detectRefluxShadow", () => {
  it("reports no shadow when reflux is the first effective helper", () => {
    const state = detectRefluxShadow(parseHelperScopes(REFLUX_REPO_LIST));
    assert.equal(state.shadowed, false);
    assert.deepEqual(state.effective, ["reflux"]);
    assert.equal(state.winner, null);
  });

  it("reports a shadow when a local helper reset drops reflux", () => {
    const state = detectRefluxShadow(parseHelperScopes(EIDOS_REPO_LIST));
    assert.equal(state.shadowed, true);
    assert.equal(state.winner, "!gh auth git-credential");
    assert.equal(state.culpritScope, "local");
  });

  it("attributes a command-line injected shadow to the command scope", () => {
    const state = detectRefluxShadow(parseHelperScopes(COMMAND_INJECTED_LIST));
    assert.equal(state.shadowed, true);
    assert.equal(state.winner, "copilot");
    assert.equal(state.culpritScope, "command");
  });
});

describe("checkLocalHelperShadow", () => {
  it("fails when a repo-local helper shadows reflux for github.com", () => {
    const result = checkLocalHelperShadow(parseHelperScopes(EIDOS_REPO_LIST));
    assert.equal(result.ok, false);
    assert.match(result.detail, /repo-local/i);
    assert.match(result.detail, /!gh auth git-credential/);
    assert.ok(result.hint && result.hint.length > 0);
  });

  it("passes when the global chain resolves to reflux and no local override exists", () => {
    const result = checkLocalHelperShadow(parseHelperScopes(REFLUX_REPO_LIST));
    assert.equal(result.ok, true);
  });

  it("stays green for a global-only registration gap (owned by the registration check)", () => {
    const result = checkLocalHelperShadow(parseHelperScopes(GLOBAL_ONLY_NO_RESET));
    assert.equal(result.ok, true);
  });

  it("labels a GIT_CONFIG_PARAMETERS-injected shadow as command line, not repo-local", () => {
    const result = checkLocalHelperShadow(parseHelperScopes(COMMAND_INJECTED_LIST));
    assert.equal(result.ok, false);
    assert.match(result.name, /command line/i);
    assert.doesNotMatch(result.detail, /repo-local/i);
    assert.match(result.detail, /command line|GIT_CONFIG_PARAMETERS/i);
    assert.match(result.detail, /copilot/);
  });

  it("recommends clearing the injected env, not a repo-local unset, for a command-line shadow", () => {
    const result = checkLocalHelperShadow(parseHelperScopes(COMMAND_INJECTED_LIST));
    assert.ok(result.hint);
    assert.match(result.hint, /GIT_CONFIG_PARAMETERS/);
    assert.doesNotMatch(result.hint, /--local --unset-all/);
    assert.match(result.hint, /cannot override/i);
  });
});
