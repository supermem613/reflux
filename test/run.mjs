// Cross-platform test runner — expands glob and passes files to node --test.
// Mirrors the rotunda runner: HOME is sandboxed to a tmpdir so tests never
// read the developer's real ~/.reflux/config.json (and so a CI-only failure
// can't be masked by local state).
//
// Set REFLUX_TEST_REAL_HOME=1 to opt out of the HOME sandbox for ad-hoc debugging.
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimatch } from "minimatch";
import { execSync } from "node:child_process";

const pattern = process.argv[2] || "test/**/*.test.ts";
const baseDir = pattern.split(/[/\\]/)[0] || ".";
const allFiles = readdirSync(baseDir, { recursive: true })
  .map((f) => join(baseDir, f).split("\\").join("/"))
  .filter((f) => minimatch(f, pattern));
const files = allFiles;

if (files.length === 0) {
  console.error(`No test files found matching: ${pattern}`);
  process.exit(1);
}

const sandboxHome = process.env.REFLUX_TEST_REAL_HOME
  ? null
  : mkdtempSync(join(tmpdir(), "reflux-test-home-"));

const env = { ...process.env };
if (sandboxHome) {
  env.HOME = sandboxHome;
  env.USERPROFILE = sandboxHome;
  env.LOCALAPPDATA = join(sandboxHome, "AppData", "Local");
}

// Same node:test caveat as rotunda: avoid `--test` because its IPC pipe to
// worker subprocesses occasionally fails on Windows runners with deserialize
// errors. Using auto-start (triggered by node:test imports in the test file)
// keeps the run in one process. `--test-reporter=tap` preserves TAP output
// for the aggregate summary parsing below.
let exitCode = 0;
let totalTests = 0;
let totalPass = 0;
let totalFail = 0;
const failedFiles = [];
try {
  for (const file of files) {
    const cmd = `node --import tsx --test-reporter=tap ${file}`;
    let stdout = "";
    let fileFailed = false;
    try {
      stdout = execSync(cmd, { env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    } catch (err) {
      fileFailed = true;
      stdout = (err.stdout ?? "").toString();
      failedFiles.push(file);
    }
    process.stdout.write(stdout);
    const tests = parseInt((stdout.match(/^# tests (\d+)/m) ?? [])[1] ?? "0", 10);
    const pass  = parseInt((stdout.match(/^# pass (\d+)/m)  ?? [])[1] ?? "0", 10);
    const fail  = parseInt((stdout.match(/^# fail (\d+)/m)  ?? [])[1] ?? "0", 10);
    totalTests += tests;
    totalPass += pass;
    totalFail += fail;
    if (fileFailed && fail === 0) {
      totalFail += 1;
    }
  }
  console.log(`\n# AGGREGATE: tests ${totalTests} | pass ${totalPass} | fail ${totalFail}`);
  if (failedFiles.length) {
    console.log(`# Failed files:\n${failedFiles.map((f) => `#   ${f}`).join("\n")}`);
    exitCode = 1;
  }
} finally {
  if (sandboxHome) {
    rmSync(sandboxHome, { recursive: true, force: true });
  }
}
process.exit(exitCode);
