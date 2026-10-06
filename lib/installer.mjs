import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolveUniqueDestinations } from "./hosts.mjs";

export const MANIFEST_NAME = ".mobile-agent-orchestrator.manifest.json";
const SKIPPED_DIRECTORIES = [".git", "node_modules", ".codegraph"];

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** Canonical managed files: every file under the skill root, discovered recursively and sorted. */
export function discoverPackageFiles(skillRoot) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : 1)) {
      if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push({ path: toRelativePath(relative(skillRoot, path)), source: path });
    }
  };
  visit(skillRoot);
  return files;
}

function toRelativePath(path) {
  return path.replaceAll(sep, "/");
}

/** List files under a directory without following symlinks: symlinked entries are reported as-is. */
function listFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files;
}

function readManifestFile(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      !parsed
      || typeof parsed !== "object"
      || typeof parsed.installerVersion !== "string"
      || !Array.isArray(parsed.files)
      || parsed.files.some((file) => typeof file?.path !== "string" || typeof file?.sha256 !== "string")
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function toDestinationPath(skillDirectory, relativePath) {
  return join(skillDirectory, ...relativePath.split("/"));
}

/**
 * Classify one canonical file against the destination. Symlinks are never followed or written
 * through: a symlink at a managed path is reported as unmanaged. `replace` is granted only when
 * the on-disk content matches a manifest record (version-update scenario).
 */
function classifyFile(destinationPath, filePath, sourceChecksum, manifestChecksums, destinationUsable) {
  if (!destinationUsable) return { classification: "conflict", action: "conflict" };
  let stats = null;
  try {
    stats = lstatSync(destinationPath);
  } catch {
    stats = null;
  }
  if (stats === null) return { classification: "absent", action: "create" };
  if (stats.isSymbolicLink()) return { classification: "unmanaged", action: "conflict" };
  const onDiskChecksum = sha256(readFileSync(destinationPath));
  if (onDiskChecksum === sourceChecksum) return { classification: "identical", action: "keep" };
  if (manifestChecksums.get(filePath) === onDiskChecksum) {
    return { classification: "modified", action: "replace" };
  }
  return { classification: "modified", action: "conflict" };
}

function resolveDestinationStatus(files, conflicts, validCurrentManifest) {
  if (conflicts.length > 0) return "aborted";
  if (validCurrentManifest && files.every((file) => file.action === "keep")) return "up-to-date";
  return "install";
}

function resolvePlanStatus(destinations) {
  if (destinations.some((destination) => destination.status === "aborted")) return "aborted";
  return destinations.every((destination) => destination.status === "up-to-date") ? "up-to-date" : "install";
}

/**
 * Pure plan builder: classifies canonical files per destination and computes per-file actions.
 * `create` for absent files, `keep` for identical ones, `replace` only for manifest-recorded
 * content, and `conflict` for anything else (modified, unmanaged, symlinked, corrupt manifest,
 * or a destination skill path that is not a directory).
 */
export function buildPlan({ targets: selectedTargets, scope, cwd, home, skillRoot, installerVersion }) {
  const canonicalFiles = discoverPackageFiles(skillRoot);
  const sourceChecksums = new Map(
    canonicalFiles.map((file) => [file.path, sha256(readFileSync(file.source))]),
  );
  const canonicalPaths = new Set(canonicalFiles.map((file) => file.path));
  const manifestPayload = {
    installerVersion,
    files: canonicalFiles.map((file) => ({ path: file.path, sha256: sourceChecksums.get(file.path) })),
  };

  const destinations = resolveUniqueDestinations(selectedTargets, scope, { cwd, home }).map(
    ({ destination, targets: resolvedTargets }) => {
      const skillDirectory = resolve(destination);
      const manifestPath = join(dirname(skillDirectory), MANIFEST_NAME);
      const conflicts = [];
      const unmanagedFiles = [];

      let destinationStats = null;
      try {
        destinationStats = lstatSync(skillDirectory);
      } catch {
        destinationStats = null;
      }
      const destinationUsable = destinationStats === null
        || (destinationStats.isDirectory() && !destinationStats.isSymbolicLink());
      if (!destinationUsable) conflicts.push(`skill destination is not a managed directory: ${skillDirectory}`);

      const manifestExists = existsSync(manifestPath);
      const manifest = manifestExists ? readManifestFile(manifestPath) : null;
      if (manifestExists && manifest === null) conflicts.push(`corrupt manifest: ${manifestPath}`);
      const manifestChecksums = new Map(manifest?.files.map((file) => [file.path, file.sha256]));
      const validCurrentManifest = Boolean(manifest)
        && manifest.installerVersion === installerVersion
        && manifestChecksums.size === canonicalPaths.size
        && canonicalFiles.every((file) => manifestChecksums.get(file.path) === sourceChecksums.get(file.path));

      const files = canonicalFiles.map((file) => {
        const destinationPath = toDestinationPath(skillDirectory, file.path);
        const { classification, action } = classifyFile(
          destinationPath,
          file.path,
          sourceChecksums.get(file.path),
          manifestChecksums,
          destinationUsable,
        );
        if (classification === "unmanaged") conflicts.push(`${file.path} (unmanaged)`);
        else if (action === "conflict") conflicts.push(`${file.path} (modified)`);
        return { path: file.path, source: file.source, destination: destinationPath, classification, action };
      });

      if (destinationUsable && destinationStats !== null) {
        for (const existingPath of listFiles(skillDirectory)) {
          const relativePath = toRelativePath(relative(skillDirectory, existingPath));
          if (canonicalPaths.has(relativePath)) continue;
          unmanagedFiles.push(relativePath);
          conflicts.push(`${relativePath} (unmanaged)`);
        }
      }

      return {
        destination: skillDirectory,
        manifestPath,
        targets: resolvedTargets,
        files,
        unmanagedFiles,
        conflicts,
        manifest: manifestPayload,
        status: resolveDestinationStatus(files, conflicts, validCurrentManifest),
      };
    },
  );

  return { installerVersion, scope, destinations, status: resolvePlanStatus(destinations) };
}

/** Execute a plan. Dry runs write nothing; conflicts abort the whole install before any write. */
export function executePlan(plan, { dryRun = false } = {}) {
  const conflicts = plan.destinations.flatMap((destination) => destination.conflicts);
  if (plan.status === "aborted" || dryRun) {
    return {
      status: plan.status === "aborted" ? "aborted" : plan.status === "up-to-date" ? "up-to-date" : "installed",
      writtenFiles: [],
      conflicts,
      plan,
    };
  }

  const writtenFiles = [];
  for (const destination of plan.destinations) {
    if (destination.status === "up-to-date") continue;
    for (const file of destination.files) {
      if (file.action === "keep") continue;
      mkdirSync(dirname(file.destination), { recursive: true });
      copyFileSync(file.source, file.destination);
      writtenFiles.push(file.destination);
    }
    mkdirSync(dirname(destination.manifestPath), { recursive: true });
    writeFileSync(destination.manifestPath, `${JSON.stringify(destination.manifest, null, 2)}\n`);
    writtenFiles.push(destination.manifestPath);
  }
  return {
    status: writtenFiles.length > 0 ? "installed" : "up-to-date",
    writtenFiles,
    conflicts,
    plan,
  };
}
