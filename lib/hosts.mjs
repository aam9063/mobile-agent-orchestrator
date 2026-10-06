import { resolve } from "node:path";

const SKILL_DIRECTORY = "mobile-agent-orchestrator";

/** Host targets that read the shared `.agents/skills` location (see references/agent-hosts.md). */
export const targets = ["codex", "opencode", "gemini"];
export const scopes = ["user", "project"];

function resolveBase(scope, { cwd, home }) {
  if (!scopes.includes(scope)) {
    throw new Error(`Unknown scope: ${JSON.stringify(scope)}. Expected one of: ${scopes.join(", ")}.`);
  }
  if (scope === "user") {
    if (!home) throw new Error("User scope requires an explicit home directory.");
    return home;
  }
  if (!cwd) throw new Error("Project scope requires an explicit working directory.");
  return cwd;
}

/** Resolve the absolute skill directory for one target and scope. */
export function resolveDestination(target, scope, { cwd, home } = {}) {
  if (!targets.includes(target)) {
    throw new Error(`Unknown target: ${JSON.stringify(target)}. Expected one of: ${targets.join(", ")}.`);
  }
  return resolve(resolveBase(scope, { cwd, home }), ".agents", "skills", SKILL_DIRECTORY);
}

/** Resolve destinations for many targets, deduplicated: shared locations collapse to one entry. */
export function resolveUniqueDestinations(selectedTargets, scope, options = {}) {
  const unique = new Map();
  for (const target of selectedTargets) {
    const destination = resolveDestination(target, scope, options);
    if (!unique.has(destination)) unique.set(destination, { destination, targets: [] });
    unique.get(destination).targets.push(target);
  }
  return [...unique.values()];
}
