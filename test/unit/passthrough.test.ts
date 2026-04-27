import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { passthroughToGcm } from "../../src/helper/passthrough.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "reflux-passthrough-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Generate a `.cmd` shim that pretends to be `git`. The shim:
 *   1. Asserts arg1 == "credential-manager" (proves we're invoking via
 *      git's subcommand interface, not as `git-credential-manager` directly)
 *   2. Reads stdin and writes it to a side-channel file so the test can
 *      verify request body propagation
 *   3. Echoes a canned response and exits with the configured status
 */
function installGitStub(jsBody: string): { gitBin: string; sidecar: string } {
  const sidecar = join(tmp, "stdin.txt");
  const jsPath = join(tmp, "git-stub.js");
  const cmdPath = join(tmp, "git.cmd");
  writeFileSync(jsPath, jsBody.replace("__SIDECAR__", JSON.stringify(sidecar)));
  writeFileSync(cmdPath, `@echo off\r\nnode "${jsPath}" %*\r\n`);
  return { gitBin: cmdPath, sidecar };
}

class CollectingStream extends Writable {
  chunks: Buffer[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    cb();
  }
  text(): string { return Buffer.concat(this.chunks).toString("utf-8"); }
}

describe("passthroughToGcm", () => {
  it("invokes `git credential-manager <action>` (not the bare binary)", async () => {
    const stub = installGitStub(`
      const fs = require("fs");
      // arg0 is the script path, args after that are passed by the .cmd shim
      // node ${"$"}{jsPath} %*  → process.argv = [node, jsPath, "credential-manager", "get", ...]
      if (process.argv[2] !== "credential-manager") {
        process.stderr.write("expected first git arg to be credential-manager, got " + process.argv[2]);
        process.exit(99);
      }
      let buf = "";
      process.stdin.on("data", (c) => { buf += c; });
      process.stdin.on("end", () => {
        fs.writeFileSync(__SIDECAR__, JSON.stringify({ argv: process.argv.slice(2), stdin: buf }));
        process.stdout.write("username=stubuser\\npassword=stubpass\\n\\n");
        process.exit(0);
      });
    `);

    const stdout = new CollectingStream();
    const stderr = new CollectingStream();
    const result = await passthroughToGcm("get", {
      gitBin: stub.gitBin,
      stdinBuffer: "protocol=https\nhost=github.com\n\n",
      stdout,
      stderr,
    });

    assert.equal(result.exitCode, 0);
    const sidecar = JSON.parse(readFileSync(stub.sidecar, "utf-8"));
    assert.deepEqual(sidecar.argv, ["credential-manager", "get"]);
    assert.equal(sidecar.stdin, "protocol=https\nhost=github.com\n\n");
    assert.match(stdout.text(), /username=stubuser/);
  });

  it("propagates non-zero exit codes from GCM", async () => {
    const stub = installGitStub(`
      process.stdin.on("data", () => {});
      process.stdin.on("end", () => {
        process.stderr.write("simulated gcm failure\\n");
        process.exit(42);
      });
    `);

    const stdout = new CollectingStream();
    const stderr = new CollectingStream();
    const result = await passthroughToGcm("get", {
      gitBin: stub.gitBin,
      stdinBuffer: "protocol=https\nhost=dev.azure.com\n\n",
      stdout,
      stderr,
    });

    assert.equal(result.exitCode, 42);
    assert.match(stderr.text(), /simulated gcm failure/);
  });

  it("rejects with a clear error when git is not on PATH", async () => {
    await assert.rejects(
      passthroughToGcm("get", {
        gitBin: join(tmp, "definitely-not-here.exe"),
        stdinBuffer: "protocol=https\nhost=github.com\n\n",
        stdout: new CollectingStream(),
        stderr: new CollectingStream(),
      }),
      /git credential-manager.*Install Git/i,
    );
  });

  it("supports erase action (forwards arg correctly)", async () => {
    const stub = installGitStub(`
      const fs = require("fs");
      let buf = "";
      process.stdin.on("data", (c) => { buf += c; });
      process.stdin.on("end", () => {
        fs.writeFileSync(__SIDECAR__, JSON.stringify({ argv: process.argv.slice(2), stdin: buf }));
        process.exit(0);
      });
    `);

    const result = await passthroughToGcm("erase", {
      gitBin: stub.gitBin,
      stdinBuffer: "protocol=https\nhost=github.com\n\n",
      stdout: new CollectingStream(),
      stderr: new CollectingStream(),
    });

    assert.equal(result.exitCode, 0);
    const sidecar = JSON.parse(readFileSync(stub.sidecar, "utf-8"));
    assert.deepEqual(sidecar.argv, ["credential-manager", "erase"]);
  });
});

// Pin Readable so it isn't tree-shaken out (referenced for type only above).
void Readable;
