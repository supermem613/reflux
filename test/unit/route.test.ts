import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { githubOwnerFromPath, routeRequest } from "../../src/helper/route.js";
import { Config } from "../../src/core/config.js";

const configWithMapping: Config = {
  version: 1,
  profiles: [{ name: "work", ghUser: "work-login" }, { name: "personal", ghUser: "personal-login" }],
  mappings: [
    { prefix: "https://github.com/acme/", profile: "work" },
    { prefix: "https://github.com/", profile: "personal" },
  ],
};

const configAcmeOnly: Config = {
  version: 1,
  profiles: [{ name: "work", ghUser: "work-login" }],
  mappings: [{ prefix: "https://github.com/acme/", profile: "work" }],
};

const configEmpty: Config = { version: 1, profiles: [], mappings: [] };

describe("routeRequest", () => {
  it("passes through when host is missing", () => {
    const decision = routeRequest({}, configWithMapping);
    assert.equal(decision.kind, "passthrough");
  });

  it("passes through hosts not in the reflux scope", () => {
    const decision = routeRequest({ host: "dev.azure.com" }, configWithMapping);
    assert.equal(decision.kind, "passthrough");
    if (decision.kind === "passthrough") {
      assert.match(decision.reason, /not in reflux scope/);
    }
  });

  it("marks github.com as unmapped when no mapping matches", () => {
    const decision = routeRequest(
      { host: "github.com", path: "unmapped-org/repo" },
      configAcmeOnly,
    );
    assert.equal(decision.kind, "unmapped-github");
    if (decision.kind === "unmapped-github") {
      assert.equal(decision.owner, "unmapped-org");
    }
  });

  it("marks github.com as unmapped when no mappings exist at all", () => {
    const decision = routeRequest({ host: "github.com", path: "any/repo" }, configEmpty);
    assert.equal(decision.kind, "unmapped-github");
  });

  it("routes to the matched profile (longest prefix wins)", () => {
    const decision = routeRequest(
      { protocol: "https", host: "github.com", path: "acme/widgets" },
      configWithMapping,
    );
    assert.equal(decision.kind, "reflux");
    if (decision.kind === "reflux") {
      assert.equal(decision.profile, "work");
    }
  });

  it("routes generic github.com to the catch-all", () => {
    const decision = routeRequest(
      { protocol: "https", host: "github.com", path: "personal-user/blog" },
      configWithMapping,
    );
    assert.equal(decision.kind, "reflux");
    if (decision.kind === "reflux") {
      assert.equal(decision.profile, "personal");
    }
  });

  it("is host-case-insensitive", () => {
    const decision = routeRequest(
      { protocol: "https", host: "GITHUB.COM", path: "acme/foo" },
      configWithMapping,
    );
    assert.equal(decision.kind, "reflux");
  });
});

describe("githubOwnerFromPath", () => {
  it("extracts the owner segment from a Git credential path", () => {
    assert.equal(githubOwnerFromPath("supermem613/reflux.git"), "supermem613");
  });

  it("returns undefined when the path is missing", () => {
    assert.equal(githubOwnerFromPath(undefined), undefined);
    assert.equal(githubOwnerFromPath(""), undefined);
  });
});
