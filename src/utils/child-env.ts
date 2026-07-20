/**
 * Build a child-process environment with git's command-line config injection
 * neutralized.
 *
 * git carries `-c key=value` overrides to every child through the
 * GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT environment variables. A
 * launching tool (for example the Copilot CLI) can use them to force its own
 * credential.helper for github.com. When git-credential-reflux wins and shells
 * out to gh or git to resolve a token, those children must not inherit that
 * injected helper, or a foreign token can win inside reflux's own resolution.
 *
 * Stripping the two variables is the only way to un-inherit them: git offers no
 * config-file or command-line opt-out for a value that lives in the child's
 * environment.
 */
export function sanitizedGitChildEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GIT_CONFIG_COUNT;
  return env;
}
