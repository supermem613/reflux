# Testing

Reflux has unit tests for every module in `src/` and integration tests
that exercise the built `dist/` binaries end-to-end.

```powershell
npm install
npm run build
npm test                  # all tests (unit + integration)
npm run test:unit         # unit only
npm run test:integration  # integration only (requires `npm run build` first)
```

## Test runner

`test/run.mjs` is a thin wrapper that:
1. Expands a glob into individual `*.test.ts` files.
2. Sandboxes `HOME`, `USERPROFILE`, and `LOCALAPPDATA` to a tmpdir for
   the duration of each test (so tests can't read or write your real
   `~/.reflux/config.json` or pollute `%LOCALAPPDATA%`).
3. Runs each file with `node --import tsx --test-reporter=tap`.
4. Aggregates the per-file TAP summaries into a single total.

Set `REFLUX_TEST_REAL_HOME=1` to opt out of the home sandbox for ad-hoc
debugging (rarely useful).

## What's stubbed vs real

| Layer | Stubbed | Why |
|---|---|---|
| `gh` binary | Yes — via `REFLUX_GH_BIN` env override pointing at a generated `.cmd` shim that runs a Node.js stub script. | Gives unit tests deterministic, fast control over `gh` outputs without depending on the developer's actual `gh` state. |
| `git-credential-manager` | Yes — integration tests assert "GCM ran" or "helper exits non-zero with a useful message". | We don't want CI to depend on GCM being installed. |
| `git` (e.g. for `update.ts`) | No — `reflux update` tests are not part of the suite (they'd mutate the install dir). | Self-update is mechanical; tested manually. |
| Filesystem (config + logs) | No — real fs writes against `tmp` dirs. | Catches real path/encoding bugs. |
| Windows Credential Manager | Implicitly stubbed — reflux never touches it directly. `gh` does, and `gh` is stubbed. | Avoids real-keyring writes during tests. |

## Test inventory

### Unit (`test/unit/`)

| File | Covers |
|---|---|
| `config.test.ts` | Schema validation, load/save round-trip, error messages. |
| `gh.test.ts` | `gh` wrapper — token retrieval, status parsing, multi-account, login/logout. Uses generated `.cmd` shim + Node.js stub. |
| `lock.test.ts` | Cross-process lock (legacy; still tested for completeness). |
| `logger.test.ts` | File logging, ISO timestamps, debug mirroring. |
| `mapping.test.ts` | URL normalisation (.git stripping, SSH→HTTPS, case folding), longest-prefix resolution. |
| `paths.test.ts` | Path resolvers honour `LOCALAPPDATA`. |
| `profiles.test.ts` | Profile CRUD, mapping cleanup on remove. |
| `protocol.test.ts` | Git credential helper kv-stream parser/formatter. |
| `route.test.ts` | reflux-vs-passthrough decision matrix. |

### Integration (`test/integration/`)

| File | Covers |
|---|---|
| `cli-smoke.test.ts` | Full CLI smoke against `dist/cli.js`: `--help`, `profile add/list/show/remove`, `map add/list/resolve`, `status`, `doctor`. Sandboxed `HOME` + missing `REFLUX_GH_BIN`. |
| `helper-protocol.test.ts` | Drives `dist/helper.js` over the git credential helper protocol with no mappings configured (passthrough path). |

## Known coverage gaps

These are intentional — they require a real GitHub identity to test, which
isn't available in CI:

- The full hot path (helper → gh → real GitHub) end-to-end with a live
  token. Tested manually before each release.
- `reflux install` registering the helper in the user's real `.gitconfig`.
  Tested manually.
- `gh auth login` driven from `reflux login`. Interactive; tested
  manually.
- Survival across the 12h EMU cap. Validated empirically by Marcus over
  multiple days during development.

## Adding a test

Mirror the existing pattern:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
// ... module under test

beforeEach(() => { /* setup tmp dir + env */ });
afterEach(() => { /* cleanup */ });

describe("thing", () => {
  it("does the thing", () => {
    assert.equal(...);
  });
});
```

Tests live in `test/unit/<module>.test.ts` (one file per `src/` module
where practical).

## CI

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs on Windows
runners only — reflux is Windows-only. It runs `npm install`, `npm run
build`, `npm run lint`, and `npm test` on every push and PR.
