import { existsSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

/**
 * CLI executable names per host, used for the PATH scan. `pi` is detection-only and never
 * becomes a write target; the other four are the installer's supported destinations.
 */
export const HOST_EXECUTABLES = {
  pi: "pi",
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
};

/**
 * Well-known config-directory candidates per host (relative to the user's home directory).
 * Locations follow skills/mobile-agent-orchestrator/references/agent-hosts.md where documented:
 * `~/.pi` (default agent directory `~/.pi/agent`), `~/.claude`, `~/.gemini`,
 * `~/.config/opencode` (alternative `~/.opencode`). Codex has no documented config dir in that
 * reference (its user skills live in the shared `~/.agents/skills`), so the conventional Codex
 * CLI config dir `~/.codex` is used as the least ambiguous probe. The first existing candidate
 * wins; hosts with several candidates are tried in order.
 */
export const HOST_CONFIG_DIRS = {
  pi: [".pi"],
  "claude-code": [".claude"],
  codex: [".codex"],
  opencode: [".config/opencode", ".opencode"],
  gemini: [".gemini"],
};

/** Canonical order of detection results (Pi first, since it is detect-only). */
const HOST_ORDER = Object.keys(HOST_EXECUTABLES);

const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat"];

/** Existence-only directory check; never throws and never writes. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scan PATH directories for the per-host executables with platform-aware extensions.
 * Nonexistent entries, file entries, and empty segments are skipped without throwing.
 * Returns a Set of executable names found.
 */
function findExecutablesInPath(pathEnv, platform) {
  const found = new Set();
  if (!pathEnv) return found;
  const separator = platform === "win32" ? ";" : ":";
  const extensions = platform === "win32" ? WINDOWS_EXECUTABLE_EXTENSIONS : [""];
  for (const entry of pathEnv.split(separator)) {
    if (!entry || !isDirectory(entry)) continue;
    for (const id of HOST_ORDER) {
      const name = HOST_EXECUTABLES[id];
      if (found.has(name)) continue;
      for (const extension of extensions) {
        if (existsSync(join(entry, name + extension))) {
          found.add(name);
          break;
        }
      }
    }
  }
  return found;
}

/**
 * Detect coding-agent CLIs read-only: probe well-known config directories under `home` and scan
 * `pathEnv` for the CLI executables. No process spawning, no filesystem writes.
 *
 * @param {{ home?: string, pathEnv?: string, platform?: string }} options - All injectable for
 *   deterministic tests; defaults to the current user's environment.
 * @returns {Array<{ id: string, detected: boolean, evidence: string }>} One entry per host in
 *   canonical order (pi, claude-code, codex, opencode, gemini). `evidence` is a short
 *   human-readable string ("" when nothing was found).
 */
export function detectHosts({ home = os.homedir(), pathEnv = process.env.PATH, platform = process.platform } = {}) {
  const executablesFound = findExecutablesInPath(pathEnv, platform);
  return HOST_ORDER.map((id) => {
    const evidence = [];
    for (const candidate of HOST_CONFIG_DIRS[id]) {
      if (isDirectory(join(home, ...candidate.split("/")))) {
        evidence.push(`config dir ~/${candidate}`);
        break;
      }
    }
    if (executablesFound.has(HOST_EXECUTABLES[id])) {
      evidence.push("found in PATH");
    }
    return { id, detected: evidence.length > 0, evidence: evidence.join("; ") };
  });
}
