import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeRemoteUrl, resolveProfile, resolveProfileFromCredentialRequest } from "../../src/core/mapping.js";
import { Config } from "../../src/core/config.js";

function configWith(...mappings: Array<[string, string]>): Config {
  const profileNames = new Set(mappings.map(([, p]) => p));
  return {
    version: 1,
    profiles: [...profileNames].map((name) => ({ name, ghUser: `${name}-user` })),
    mappings: mappings.map(([prefix, profile]) => ({ prefix, profile })),
  };
}

describe("normalizeRemoteUrl", () => {
  it("strips .git suffix", () => {
    assert.equal(
      normalizeRemoteUrl("https://github.com/foo/bar.git"),
      "https://github.com/foo/bar",
    );
  });

  it("lowercases the host", () => {
    assert.equal(
      normalizeRemoteUrl("https://GITHUB.COM/foo/bar"),
      "https://github.com/foo/bar",
    );
  });

  it("converts git@host:owner/repo SSH to https form", () => {
    assert.equal(
      normalizeRemoteUrl("git@github.com:acme/widgets.git"),
      "https://github.com/acme/widgets",
    );
  });

  it("converts ssh:// SSH form", () => {
    assert.equal(
      normalizeRemoteUrl("ssh://git@github.com/acme/widgets.git"),
      "https://github.com/acme/widgets",
    );
  });

  it("adds https:// to bare host/path inputs", () => {
    assert.equal(
      normalizeRemoteUrl("github.com/foo/bar"),
      "https://github.com/foo/bar",
    );
  });

  it("preserves trailing slash on prefix-style inputs", () => {
    assert.equal(
      normalizeRemoteUrl("https://github.com/acme/"),
      "https://github.com/acme/",
    );
  });

  it("returns empty string for empty input", () => {
    assert.equal(normalizeRemoteUrl(""), "");
    assert.equal(normalizeRemoteUrl("   "), "");
  });
});

describe("resolveProfile", () => {
  it("returns null when no mappings exist", () => {
    const config = configWith();
    assert.equal(resolveProfile("https://github.com/foo/bar", config), null);
  });

  it("returns null when no mapping matches", () => {
    const config = configWith(["https://github.com/acme/", "work"]);
    assert.equal(resolveProfile("https://github.com/personal/repo", config), null);
  });

  it("matches the longest prefix wins", () => {
    const config = configWith(
      ["https://github.com/", "personal"],
      ["https://github.com/acme/", "work"],
      ["https://github.com/acme/sub/", "work-sub"],
    );
    assert.equal(resolveProfile("https://github.com/acme/sub/foo", config), "work-sub");
    assert.equal(resolveProfile("https://github.com/acme/other-repo", config), "work");
    assert.equal(resolveProfile("https://github.com/personal/blog", config), "personal");
  });

  it("normalises the input URL before matching (SSH form)", () => {
    const config = configWith(["https://github.com/acme/", "work"]);
    assert.equal(resolveProfile("git@github.com:acme/widgets.git", config), "work");
  });

  it("normalises the prefix at config time too (lowercase host)", () => {
    const config = configWith(["HTTPS://GITHUB.COM/acme/", "work"]);
    assert.equal(resolveProfile("https://github.com/acme/foo", config), "work");
  });
});

describe("resolveProfileFromCredentialRequest", () => {
  it("reconstructs the URL from protocol+host+path and resolves", () => {
    const config = configWith(["https://github.com/acme/", "work"]);
    const result = resolveProfileFromCredentialRequest(
      { protocol: "https", host: "github.com", path: "acme/widgets.git" },
      config,
    );
    assert.equal(result, "work");
  });

  it("returns null when host is missing", () => {
    const config = configWith(["https://github.com/acme/", "work"]);
    assert.equal(resolveProfileFromCredentialRequest({ protocol: "https" }, config), null);
  });

  it("defaults protocol to https when absent", () => {
    const config = configWith(["https://github.com/acme/", "work"]);
    const result = resolveProfileFromCredentialRequest(
      { host: "github.com", path: "acme/foo" },
      config,
    );
    assert.equal(result, "work");
  });
});
