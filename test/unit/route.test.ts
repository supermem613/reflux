import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeRequest } from "../../src/helper/route.js";
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

  it("passes through github.com when no mapping matches", () => {
    const decision = routeRequest(
      { host: "github.com", path: "unmapped-org/repo" },
      configAcmeOnly,
    );
    assert.equal(decision.kind, "passthrough");
  });

  it("passes through github.com when no mappings exist at all", () => {
    const decision = routeRequest({ host: "github.com", path: "any/repo" }, configEmpty);
    assert.equal(decision.kind, "passthrough");
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
