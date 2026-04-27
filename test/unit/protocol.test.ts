import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatCredentialStream,
  parseCredentialStream,
  requestUrl,
} from "../../src/helper/protocol.js";

describe("parseCredentialStream", () => {
  it("parses a typical git get request", () => {
    const input = "protocol=https\nhost=github.com\npath=acme/foo.git\n\n";
    const req = parseCredentialStream(input);
    assert.equal(req.protocol, "https");
    assert.equal(req.host, "github.com");
    assert.equal(req.path, "acme/foo.git");
  });

  it("handles CRLF line endings", () => {
    const input = "protocol=https\r\nhost=github.com\r\n\r\n";
    const req = parseCredentialStream(input);
    assert.equal(req.host, "github.com");
  });

  it("collects capability[] lines into an array", () => {
    const input = "protocol=https\nhost=github.com\ncapability[]=authtype\ncapability[]=state\n\n";
    const req = parseCredentialStream(input);
    assert.deepStrictEqual(req.capabilities, ["authtype", "state"]);
  });

  it("preserves an = sign in the value", () => {
    const input = "host=github.com\npassword=ghp_abc=xyz\n\n";
    const req = parseCredentialStream(input);
    assert.equal(req.password, "ghp_abc=xyz");
  });

  it("collects unknown keys into extras (forward-compatible)", () => {
    const input = "host=github.com\nfuture_key=future_value\n\n";
    const req = parseCredentialStream(input);
    assert.equal(req.extras?.future_key, "future_value");
  });

  it("stops at the blank line and ignores trailing input", () => {
    const input = "host=github.com\n\nnoise=ignored\n";
    const req = parseCredentialStream(input);
    assert.equal(req.host, "github.com");
    assert.equal(req.extras, undefined);
  });

  it("ignores malformed lines (no =)", () => {
    const input = "host=github.com\ngarbage_line\n\n";
    const req = parseCredentialStream(input);
    assert.equal(req.host, "github.com");
  });
});

describe("formatCredentialStream", () => {
  it("emits username + password in canonical form with trailing blank line", () => {
    const out = formatCredentialStream({ username: "work", password: "ghp_abc" });
    assert.equal(out, "username=work\npassword=ghp_abc\n\n");
  });

  it("emits password_expiry_utc when supplied", () => {
    const out = formatCredentialStream({
      username: "work",
      password: "ghp_abc",
      password_expiry_utc: "2026-04-28T00:00:00Z",
    });
    assert.match(out, /password_expiry_utc=2026-04-28T00:00:00Z\n/);
  });

  it("forwards extras verbatim (passthrough proxy use)", () => {
    const out = formatCredentialStream({
      username: "u",
      password: "p",
      extras: { quit: "true" },
    });
    assert.match(out, /quit=true\n/);
  });

  it("always ends with a blank line (protocol terminator)", () => {
    const out = formatCredentialStream({});
    assert.equal(out.endsWith("\n\n"), true);
  });
});

describe("requestUrl", () => {
  it("prefers an explicit url field when present", () => {
    const url = requestUrl({
      url: "https://github.com/acme/foo",
      protocol: "ssh",
      host: "different.host",
    });
    assert.equal(url, "https://github.com/acme/foo");
  });

  it("reconstructs from protocol+host+path", () => {
    const url = requestUrl({ protocol: "https", host: "github.com", path: "foo/bar" });
    assert.equal(url, "https://github.com/foo/bar");
  });

  it("defaults protocol to https when absent", () => {
    const url = requestUrl({ host: "github.com", path: "foo/bar" });
    assert.equal(url, "https://github.com/foo/bar");
  });

  it("trims trailing slash when path is empty", () => {
    const url = requestUrl({ protocol: "https", host: "github.com" });
    assert.equal(url, "https://github.com");
  });
});
