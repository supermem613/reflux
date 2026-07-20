import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { findDuplicateLogins } from "../../src/auth/gh.js";
import type { GhAccount } from "../../src/auth/gh.js";
import { checkDuplicateGhLogins } from "../../src/commands/doctor.js";

function account(user: string, active: boolean): GhAccount {
  return { user, hostname: "github.com", active, scopes: ["workflow"] };
}

describe("findDuplicateLogins", () => {
  it("returns nothing when every login is unique", () => {
    const accounts = [account("supermem613", true), account("marcusm_microsoft", false)];
    assert.deepEqual(findDuplicateLogins(accounts), []);
  });

  it("flags a login signed in more than once and reports the count", () => {
    const accounts = [
      account("supermem613", false),
      account("marcusm_microsoft", true),
      account("supermem613", false),
    ];
    const dups = findDuplicateLogins(accounts);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].user, "supermem613");
    assert.equal(dups[0].count, 2);
  });

  it("records whether any of the duplicate entries is the active account", () => {
    const accounts = [account("supermem613", true), account("supermem613", false)];
    assert.equal(findDuplicateLogins(accounts)[0].activeAmongDuplicates, true);
  });

  it("returns an empty list for no accounts", () => {
    assert.deepEqual(findDuplicateLogins([]), []);
  });
});

describe("checkDuplicateGhLogins", () => {
  it("passes when no login is signed in more than once", () => {
    const result = checkDuplicateGhLogins([account("supermem613", true), account("marcusm_microsoft", false)]);
    assert.equal(result.ok, true);
  });

  it("fails and names the duplicate login when the same login appears twice", () => {
    const result = checkDuplicateGhLogins([
      account("supermem613", true),
      account("supermem613", false),
      account("marcusm_microsoft", false),
    ]);
    assert.equal(result.ok, false);
    assert.match(result.detail, /supermem613/);
    assert.ok(result.hint && result.hint.length > 0);
  });
});
