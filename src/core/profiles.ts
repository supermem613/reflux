/**
 * Profile registry — wraps Config.profiles[] with CRUD.
 *
 * Profiles are pure config entries: a (name, ghUser) pair. There is no
 * filesystem lifecycle — the live token is owned by `gh`'s own keyring and
 * is queried at credential-helper time.
 */

import { Config, loadConfig, saveConfig } from "./config.js";
import { Profile, RefluxError } from "./types.js";

export function listProfiles(config: Config = loadConfig()): Profile[] {
  return config.profiles;
}

export function getProfile(name: string, config: Config = loadConfig()): Profile | undefined {
  return config.profiles.find((p) => p.name === name);
}

/** Add a profile. Throws if a profile with the same name already exists. */
export function addProfile(profile: Profile, configFilePath?: string): Config {
  const config = loadConfig(configFilePath);
  if (config.profiles.some((p) => p.name === profile.name)) {
    throw new RefluxError(`Profile '${profile.name}' already exists.`);
  }
  config.profiles.push(profile);
  saveConfig(config, configFilePath);
  return config;
}

/**
 * Remove a profile and any mappings pointing at it. Throws if the profile
 * does not exist.
 */
export function removeProfile(name: string, configFilePath?: string): Config {
  const config = loadConfig(configFilePath);
  const before = config.profiles.length;
  config.profiles = config.profiles.filter((p) => p.name !== name);
  if (config.profiles.length === before) {
    throw new RefluxError(`Profile '${name}' does not exist.`);
  }
  config.mappings = config.mappings.filter((m) => m.profile !== name);
  saveConfig(config, configFilePath);
  return config;
}
