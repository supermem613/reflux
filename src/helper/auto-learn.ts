import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { authStatus } from "../auth/gh.js";
import { Config, loadConfig, saveConfig } from "../core/config.js";
import { normalizeRemoteUrl, resolveProfile } from "../core/mapping.js";
import { configPath } from "../utils/paths.js";

export type AutoLearnResult =
  | { ok: true; profile: string; ghUser: string; created: boolean }
  | { ok: false; reason: string; hints: string[] };

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function profileNameForGhUser(ghUser: string, config: Config): string {
  const base = ghUser.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "") || "github";
  if (PROFILE_NAME_PATTERN.test(base) && !config.profiles.some((p) => p.name === base)) {
    return base;
  }

  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!config.profiles.some((p) => p.name === candidate)) {
      return candidate;
    }
  }
}

function profileForGhUser(ghUser: string, config: Config): string {
  const existing = config.profiles.find((p) => p.ghUser.toLowerCase() === ghUser.toLowerCase());
  if (existing) {
    return existing.name;
  }

  const name = profileNameForGhUser(ghUser, config);
  config.profiles.push({ name, ghUser });
  return name;
}

async function acquireConfigLock(): Promise<() => void> {
  const lockDir = `${configPath()}.lock`;
  const deadline = Date.now() + 1000;

  for (;;) {
    try {
      mkdirSync(dirname(lockDir), { recursive: true });
      mkdirSync(lockDir);
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || Date.now() >= deadline) {
        throw err;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

export async function autoLearnGithubOwner(owner: string | undefined): Promise<AutoLearnResult> {
  if (!owner) {
    return {
      ok: false,
      reason: "Git did not include a GitHub owner in the credential request.",
      hints: [
        "Run `reflux install` to enable credential.https://github.com.useHttpPath.",
        "Then add an explicit mapping with `reflux map add https://github.com/<owner>/ <profile>`.",
      ],
    };
  }

  const accounts = authStatus();
  const account = accounts.find((a) => a.user.toLowerCase() === owner.toLowerCase());
  if (!account) {
    const known = accounts.map((a) => a.user).join(", ") || "none";
    return {
      ok: false,
      reason: `No signed-in gh account matches GitHub owner '${owner}'.`,
      hints: [
        `Signed-in gh accounts: ${known}.`,
        `To sign in as a different account: gh auth login --hostname github.com --git-protocol https --web`,
        `For org repos, then add an explicit mapping: reflux map add https://github.com/${owner}/ <profile>`,
        `For personal repos, sign in as ${owner} and retry.`,
      ],
    };
  }

  const prefix = normalizeRemoteUrl(`https://github.com/${owner}/`);
  const release = await acquireConfigLock();
  try {
    const config = loadConfig();
    const existing = resolveProfile(prefix, config);
    if (existing) {
      const profile = config.profiles.find((p) => p.name === existing);
      return { ok: true, profile: existing, ghUser: profile?.ghUser ?? account.user, created: false };
    }

    const profile = profileForGhUser(account.user, config);
    config.mappings.push({ prefix, profile });
    saveConfig(config);
    return { ok: true, profile, ghUser: account.user, created: true };
  } finally {
    release();
  }
}
