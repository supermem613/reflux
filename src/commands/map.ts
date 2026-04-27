import chalk from "chalk";
import { loadConfig, saveConfig } from "../core/config.js";
import { normalizeRemoteUrl, resolveProfile } from "../core/mapping.js";
import { RefluxError } from "../core/types.js";

export function mapAddCommand(prefix: string, profile: string): void {
  const config = loadConfig();
  if (!config.profiles.some((p) => p.name === profile)) {
    throw new RefluxError(
      `Profile '${profile}' does not exist. Create it first with \`reflux profile add ${profile}\`.`,
    );
  }
  const normalized = normalizeRemoteUrl(prefix);
  if (!normalized) {
    throw new RefluxError(`Could not parse '${prefix}' as a URL prefix.`);
  }
  if (config.mappings.some((m) => normalizeRemoteUrl(m.prefix) === normalized)) {
    throw new RefluxError(`A mapping for '${prefix}' already exists.`);
  }
  config.mappings.push({ prefix: normalized, profile });
  saveConfig(config);
  console.log(chalk.green("✓") + ` Mapped ${chalk.cyan(normalized)} → ${chalk.cyan(profile)}`);
}

export function mapListCommand(): void {
  const config = loadConfig();
  if (config.mappings.length === 0) {
    console.log(chalk.dim("(no mappings)"));
    console.log(chalk.dim("  Add one with `reflux map add <url-prefix> <profile>`."));
    return;
  }
  // Print sorted by prefix length descending to mirror resolution order.
  const sorted = [...config.mappings].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const m of sorted) {
    console.log(`${chalk.cyan(m.profile.padEnd(12))} ${m.prefix}`);
  }
}

export function mapRemoveCommand(prefix: string): void {
  const config = loadConfig();
  const normalized = normalizeRemoteUrl(prefix);
  const before = config.mappings.length;
  config.mappings = config.mappings.filter(
    (m) => normalizeRemoteUrl(m.prefix) !== normalized,
  );
  if (config.mappings.length === before) {
    throw new RefluxError(`No mapping found for '${prefix}'.`);
  }
  saveConfig(config);
  console.log(chalk.green("✓") + ` Removed mapping for ${chalk.cyan(normalized)}`);
}

export function mapResolveCommand(remoteUrl: string): void {
  const profile = resolveProfile(remoteUrl);
  if (!profile) {
    console.log(chalk.dim(`No mapping for ${remoteUrl} — would passthrough to GCM.`));
    process.exitCode = 1;
    return;
  }
  console.log(`${chalk.cyan(remoteUrl)} → ${chalk.cyan(profile)}`);
}
