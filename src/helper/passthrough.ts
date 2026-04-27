/**
 * Passthrough to vanilla git-credential-manager.
 *
 * For requests reflux doesn't own (anything not github.com, or github.com
 * with no mapping), we spawn `git credential-manager <action>`, pipe stdin
 * straight in, copy stdout straight out, and propagate the exit code. The
 * caller (helper.ts) then exits with the same code.
 *
 * We invoke GCM via `git`'s subcommand resolution (`git credential-manager`)
 * rather than spawning `git-credential-manager.exe` directly, because
 * Git for Windows ships GCM under
 * `C:\Program Files\Git\mingw64\libexec\git-core\git-credential-manager.exe`,
 * which is **not** on the user's PATH. `git` itself finds it via libexec
 * resolution. This makes reflux work on stock Git-for-Windows installs
 * without any additional setup.
 *
 * This makes reflux a router rather than a wholesale replacement. ADO,
 * GitHub Enterprise on a custom host, gitea, etc. all keep working the way
 * they did before reflux was installed.
 */

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { CredentialAction } from "./protocol.js";

export interface PassthroughOptions {
  /** Stdin to pipe into the child. Default: process.stdin. */
  stdin?: Readable;
  /** Stdout to copy from the child. Default: process.stdout. */
  stdout?: Writable;
  /** Stderr to copy from the child. Default: process.stderr. */
  stderr?: Writable;
  /** Pre-buffered stdin content. If set, used instead of `stdin`. */
  stdinBuffer?: string;
  /** Override the git binary used to invoke GCM (for tests). Default: git. */
  gitBin?: string;
}

export interface PassthroughResult {
  exitCode: number;
}

export async function passthroughToGcm(
  action: CredentialAction,
  options: PassthroughOptions = {},
): Promise<PassthroughResult> {
  // Resolution order:
  //   1. Test-only env override (REFLUX_GIT_BIN) — used by integration tests
  //      to redirect to a stub so we never invoke real GCM/browser auth.
  //   2. Caller-supplied options.gitBin.
  //   3. Plain "git" — found via PATH; on Windows this is git.exe and
  //      `git credential-manager` resolves GCM via libexec/git-core.
  const gitBin = process.env.REFLUX_GIT_BIN ?? options.gitBin ?? "git";
  // Node 20.12+ refuses to spawn .cmd/.bat directly without shell:true
  // (CVE-2024-27980). Production `git` is git.exe so this is a no-op there;
  // it only kicks in for test stubs.
  const useShell = /\.(cmd|bat)$/i.test(gitBin);
  const child = spawn(gitBin, ["credential-manager", action], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: useShell,
  });

  const stdoutSink = options.stdout ?? process.stdout;
  const stderrSink = options.stderr ?? process.stderr;
  child.stdout.on("data", (chunk) => stdoutSink.write(chunk));
  child.stderr.on("data", (chunk) => stderrSink.write(chunk));

  if (options.stdinBuffer !== undefined) {
    child.stdin.end(options.stdinBuffer);
  } else {
    const src = options.stdin ?? process.stdin;
    src.pipe(child.stdin);
  }

  return new Promise<PassthroughResult>((resolve, reject) => {
    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        reject(new Error(
          `Passthrough failed: '${gitBin}' not found on PATH. ` +
          `Reflux invokes GCM as \`git credential-manager\`; install Git ` +
          `(which bundles GCM on Windows) or remove the unmapped remote.`,
        ));
        return;
      }
      reject(err);
    });
    child.on("exit", (code) => {
      resolve({ exitCode: code ?? 1 });
    });
  });
}
