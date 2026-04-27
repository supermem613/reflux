/**
 * Global reflux config (~/.reflux/config.json).
 *
 * Holds identity profiles and remote-URL → profile mappings. Tokens live in
 * `gh`'s own keyring; reflux never persists them.
 *
 * The file is intentionally small and version-stamped so future fields can
 * be added without breaking older reflux binaries. It lives under ~/.reflux/
 * (not %APPDATA%) so the user can hand-edit and back it up alongside other
 * dotfiles.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { configPath } from "../utils/paths.js";
import { RefluxError } from "./types.js";

// ── Schema ───────────────────────────────────────────────────────────

const ProfileSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "profile name must be [a-z0-9-], starting with a letter or digit",
  }),
  ghUser: z.string().min(1, { message: "ghUser is required" }),
});

const MappingSchema = z.object({
  prefix: z.string().min(1),
  profile: z.string(),
});

export const ConfigSchema = z.object({
  version: z
    .number()
    .int()
    .refine((v) => v === 1, { message: "unsupported config version (expected 1)" }),
  profiles: z.array(ProfileSchema).default([]),
  mappings: z.array(MappingSchema).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;

export function emptyConfig(): Config {
  return { version: 1, profiles: [], mappings: [] };
}

// ── Load / save ──────────────────────────────────────────────────────

/**
 * Load ~/.reflux/config.json. Returns an empty (but valid) config if the
 * file doesn't exist. Throws RefluxError if the file exists but is
 * malformed.
 *
 * `path` is for testing; production callers should always omit it.
 */
export function loadConfig(path: string = configPath()): Config {
  if (!existsSync(path)) {
    return emptyConfig();
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new RefluxError(`Could not read ${path}`, { cause: err });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new RefluxError(`Invalid JSON in ${path}`, { cause: err });
  }

  const result = ConfigSchema.safeParse(json);
  if (!result.success) {
    throw new RefluxError(
      `Invalid config in ${path}: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  // Referential integrity: every mapping's profile must exist.
  const profileNames = new Set(result.data.profiles.map((p) => p.name));
  for (const m of result.data.mappings) {
    if (!profileNames.has(m.profile)) {
      throw new RefluxError(
        `Mapping prefix '${m.prefix}' references unknown profile '${m.profile}'`,
      );
    }
  }

  return result.data;
}

/** Write the config to disk. Creates parent directory if missing. */
export function saveConfig(config: Config, path: string = configPath()): void {
  const validated = ConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(validated, null, 2) + "\n", "utf-8");
}
