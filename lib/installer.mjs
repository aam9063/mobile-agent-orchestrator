import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
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

/** Inspect the manifest path without following links: valid and dangling symlinks are both rejected. */
function inspectManifestPath(manifestPath) {
  let stats;
  try {
    stats = lstatSync(manifestPath);
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (stats.isSymbolicLink()) return { kind: "symlink" };
  if (!stats.isFile()) return { kind: "nonregular" };
  return { kind: "regular" };
}

function siblingTempPath(destinationPath) {
  return `${destinationPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Physical file identity as BigInt dev:ino, or null when the filesystem does not expose an inode. */
function physicalIdentity(stats) {
  if (!stats.isFile() || stats.ino === 0n) return null;
  return `${stats.dev}:${stats.ino}`;
}

/** Physical identity of an existing regular file (BigInt dev:ino), or null when absent or inode-less. */
function fileIdentity(path) {
  let stats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch {
    return null;
  }
  return physicalIdentity(stats);
}

/** Publish content through an exclusive sibling temp file and atomic rename; any failure keeps the old file. */
function writeFileAtomic(destinationPath, content) {
  const tempPath = siblingTempPath(destinationPath);
  try {
    writeFileSync(tempPath, content, { flag: "wx" });
    renameSync(tempPath, destinationPath);
  } catch (error) {
    if (error.code !== "EEXIST") rmSync(tempPath, { force: true });
    throw error;
  }
}

/** Copy one managed file through an exclusive sibling temp file so an interrupted install never publishes a partial file. */
function copyFileAtomic(sourcePath, destinationPath) {
  const tempPath = siblingTempPath(destinationPath);
  try {
    copyFileSync(sourcePath, tempPath, fsConstants.COPYFILE_EXCL);
    renameSync(tempPath, destinationPath);
  } catch (error) {
    if (error.code !== "EEXIST") rmSync(tempPath, { force: true });
    throw error;
  }
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

      const manifestKind = inspectManifestPath(manifestPath).kind;
      if (manifestKind === "symlink") conflicts.push(`manifest is a symlink: ${manifestPath}`);
      else if (manifestKind === "nonregular") conflicts.push(`manifest is not a regular file: ${manifestPath}`);
      const manifest = manifestKind === "regular" ? readManifestFile(manifestPath) : null;
      if (manifestKind === "regular" && manifest === null) conflicts.push(`corrupt manifest: ${manifestPath}`);
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

      // Never remove a stale path that is the same physical file as a canonical destination: on a
      // case-insensitive filesystem the two spellings share one inode, so a case-only rename there must
      // conflict instead of deleting the file the canonical path keeps. Identity is BigInt dev:ino, which is
      // casing-independent and still distinguishes the two spellings on a case-sensitive filesystem.
      const canonicalIdentities = new Map();
      for (const file of files) {
        const identity = fileIdentity(file.destination);
        if (identity !== null) canonicalIdentities.set(identity, file.path);
      }
      const removals = [];
      if (destinationUsable && destinationStats !== null) {
        for (const existingPath of listFiles(skillDirectory)) {
          const relativePath = toRelativePath(relative(skillDirectory, existingPath));
          if (canonicalPaths.has(relativePath)) continue;
          const existingStats = lstatSync(existingPath);
          const recordedChecksum = manifestChecksums.get(relativePath);
          const existingIdentity = existingStats.isFile() ? fileIdentity(existingPath) : null;
          const canonicalAlias = existingIdentity === null ? undefined : canonicalIdentities.get(existingIdentity);
          if (canonicalAlias !== undefined) {
            conflicts.push(`${relativePath} (aliases managed file ${canonicalAlias})`);
          } else if (existingStats.isFile() && existingIdentity === null) {
            // The filesystem exposes no inode: identity is unknown, so this path could alias a canonical file.
            // Fall back to the conservative unmanaged conflict and never delete it.
            unmanagedFiles.push(relativePath);
            conflicts.push(`${relativePath} (unmanaged)`);
          } else if (existingStats.isFile() && recordedChecksum !== undefined && sha256(readFileSync(existingPath)) === recordedChecksum) {
            removals.push({ path: relativePath, destination: existingPath, classification: "stale", action: "remove" });
          } else if (existingStats.isFile() && recordedChecksum !== undefined) {
            conflicts.push(`${relativePath} (modified)`);
          } else {
            unmanagedFiles.push(relativePath);
            conflicts.push(`${relativePath} (unmanaged)`);
          }
        }
      }
      files.push(...removals);

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
      removedFiles: [],
      conflicts,
      plan,
    };
  }

  const writtenFiles = [];
  const removedFiles = [];
  for (const destination of plan.destinations) {
    if (destination.status === "up-to-date") continue;
    for (const file of destination.files) {
      if (file.action === "keep" || file.action === "conflict") continue;
      if (file.action === "remove") {
        unlinkSync(file.destination);
        removedFiles.push(file.destination);
        continue;
      }
      mkdirSync(dirname(file.destination), { recursive: true });
      copyFileAtomic(file.source, file.destination);
      writtenFiles.push(file.destination);
    }
    mkdirSync(dirname(destination.manifestPath), { recursive: true });
    writeFileAtomic(destination.manifestPath, `${JSON.stringify(destination.manifest, null, 2)}\n`);
    writtenFiles.push(destination.manifestPath);
  }
  return {
    status: writtenFiles.length > 0 || removedFiles.length > 0 ? "installed" : "up-to-date",
    writtenFiles,
    removedFiles,
    conflicts,
    plan,
  };
}
