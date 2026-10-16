import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
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

/**
 * First intermediate component between the skill directory and a recorded file that is not a real
 * directory (a symlink or some other entry kind), or null when every intermediate is a real
 * directory. Checking only the final component with lstat would let a symlinked intermediate (e.g.
 * `references`) redirect recorded-file reads outside the skill directory. An absent intermediate is
 * not a failure here: the final-component lstat then reports the file itself as missing.
 */
function unsafeIntermediateComponent(skillDirectory, relativePath) {
  const components = relativePath.split("/");
  let current = skillDirectory;
  for (const component of components.slice(0, -1)) {
    current = join(current, component);
    let stats = null;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error.code !== "ENOTDIR") throw error;
      return component;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) return component;
  }
  return null;
}

/**
 * A manifest-recorded path is canonical only when it is already in its simplest form relative to
 * the skill directory: a non-empty string with no backslash, not absolute, and every
 * `/`-separated segment non-empty and neither `.` nor `..`. Non-canonical records are untrusted
 * as a whole: `toDestinationPath` joins with `join()`, which normalizes `.` and `..` away, so
 * without this check a crafted record like `missing/../references/notes.md` could slip past the
 * intermediate-component inspection (which stops at the first absent component) and follow a
 * symlinked directory outside the skill.
 */
function isCanonicalRecordedPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) return false;
  if (relativePath.includes("\\") || relativePath.startsWith("/")) return false;
  return relativePath.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Inspect the manifest path without following links: valid and dangling symlinks are both rejected. */
function inspectManifestPath(manifestPath) {
  let stats;
  try {
    stats = lstatSync(manifestPath);
  } catch (error) {
    // ENOTDIR (POSIX) means an ancestor of the manifest path is a regular file, so no manifest can
    // exist there; Windows maps the same situation to ENOENT. Treat both as absent instead of
    // failing whole-command planning on one platform and degrading per-destination on the other.
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return { kind: "absent" };
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

/**
 * Classify one destination for uninstall (pure, zero writes). Status precedence: absent (no skill
 * directory), unknown (destination or manifest fails the same trust bar as `inspectInstallations`),
 * blocked (a manifest-recorded file cannot be safely removed), uninstall (clean).
 */
function classifyUninstallDestination(destination, destinationTargets, destinationScopes) {
  const skillDirectory = resolve(destination);
  const manifestPath = join(dirname(skillDirectory), MANIFEST_NAME);
  const details = [];
  const unmanagedFiles = [];
  const entry = {
    destination: skillDirectory,
    manifestPath,
    scopes: destinationScopes,
    targets: destinationTargets,
    removals: [],
    directories: [],
    manifestRemoved: false,
    status: "unknown",
    details,
    unmanagedFiles,
  };

  let directoryStats = null;
  try {
    directoryStats = lstatSync(skillDirectory);
  } catch (error) {
    // ENOTDIR (POSIX) for a non-directory ancestor of the destination means no managed
    // installation can exist under it: treat it as absent instead of failing the whole report
    // (matches the inspectManifestPath ENOTDIR handling).
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
  if (directoryStats === null) {
    entry.status = "absent";
    return entry;
  }
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    details.push(`skill destination is not a managed directory: ${skillDirectory}`);
    return entry;
  }

  const manifestKind = inspectManifestPath(manifestPath).kind;
  if (manifestKind === "symlink") details.push(`manifest is a symlink: ${manifestPath}`);
  else if (manifestKind === "nonregular") details.push(`manifest is not a regular file: ${manifestPath}`);
  else if (manifestKind === "absent") details.push(`manifest is missing: ${manifestPath}`);
  const manifest = manifestKind === "regular" ? readManifestFile(manifestPath) : null;
  if (manifestKind === "regular" && manifest === null) details.push(`corrupt manifest: ${manifestPath}`);
  if (manifest === null) return entry;

  // Same canonical + containment gate as `inspectInstallations`: a crafted manifest must never
  // drive lstat, checksum reads, or unlinks outside the skill directory.
  const unsafeRecordedPaths = manifest.files.filter((file) => {
    if (!isCanonicalRecordedPath(file.path)) return true;
    const resolvedPath = resolve(toDestinationPath(skillDirectory, file.path));
    return resolvedPath !== skillDirectory && !resolvedPath.startsWith(skillDirectory + sep);
  });
  if (unsafeRecordedPaths.length > 0) {
    for (const file of unsafeRecordedPaths) details.push(`${file.path} (unsafe manifest path)`);
    return entry;
  }

  const recordedChecksums = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  const blocks = new Set();
  const alreadyAbsentDetails = [];
  const verifiedRecordedPaths = [];
  for (const [recordedPath, recordedChecksum] of recordedChecksums) {
    const recordedDestinationPath = toDestinationPath(skillDirectory, recordedPath);
    const unsafeIntermediate = unsafeIntermediateComponent(skillDirectory, recordedPath);
    // Resolve the final component ONLY when every intermediate is safe (the #29 lesson: check
    // intermediates BEFORE any read or unlink, and never resolve through a symlink).
    let fileStats = null;
    if (unsafeIntermediate === null) {
      try {
        fileStats = lstatSync(recordedDestinationPath);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      }
    }
    if (unsafeIntermediate !== null) {
      blocks.add(`${recordedPath} (intermediate ${unsafeIntermediate} is a symlink or not a directory)`);
    } else if (fileStats === null) {
      // A partial installation is not a block: report it as already gone (S7) and proceed.
      alreadyAbsentDetails.push(`${recordedPath} (already absent)`);
    } else if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      blocks.add(`${recordedPath} (symlinked or not a regular file)`);
    } else if (sha256(readFileSync(recordedDestinationPath)) !== recordedChecksum) {
      blocks.add(`${recordedPath} (modified)`);
    } else {
      verifiedRecordedPaths.push(recordedPath);
    }
  }

  // Removal candidates come from the real listing, never from manifest paths (the #26 lesson):
  // `listFiles` only recurses real non-symlink directories, so every intermediate component of a
  // real-listing path is a real directory by construction, and the final component is re-checked
  // with lstat below before the file can become a removal candidate.
  const realFiles = listFiles(skillDirectory).map((existingPath) => ({
    absolutePath: existingPath,
    relativePath: toRelativePath(relative(skillDirectory, existingPath)),
  }));
  const realRelativePaths = new Set(realFiles.map((file) => file.relativePath));
  for (const realFile of realFiles) {
    const recordedChecksum = recordedChecksums.get(realFile.relativePath);
    if (recordedChecksum === undefined) {
      // Decision (recorded per task T1): unmanaged files never block the uninstall (S3). A user's
      // own files coexist with managed content; only a manifest-recorded file that differs blocks.
      // They are never removed and are listed in the details.
      unmanagedFiles.push(realFile.relativePath);
      continue;
    }
    let fileStats = null;
    try {
      fileStats = lstatSync(realFile.absolutePath);
    } catch (error) {
      // ENOENT: the file was deleted between `listFiles` and this lstat. Treat it as already
      // absent (consistent with the recorded-path handling) instead of failing planning for
      // every destination; anything else is a real filesystem error and propagates.
      if (error.code !== "ENOENT") throw error;
      alreadyAbsentDetails.push(`${realFile.relativePath} (already absent)`);
      continue;
    }
    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      blocks.add(`${realFile.relativePath} (symlinked or not a regular file)`);
    } else if (sha256(readFileSync(realFile.absolutePath)) !== recordedChecksum) {
      blocks.add(`${realFile.relativePath} (modified)`);
    } else {
      entry.removals.push({ path: realFile.relativePath, destination: realFile.absolutePath, sha256: recordedChecksum });
    }
  }
  // A recorded path whose content verifies but which the real listing spells differently (a
  // case-insensitive alias) must block: removing the manifest would orphan managed content that
  // the real listing correctly refuses to classify as removable.
  for (const recordedPath of verifiedRecordedPaths) {
    if (!realRelativePaths.has(recordedPath)) {
      blocks.add(`${recordedPath} (not present under its recorded name)`);
    }
  }

  details.push(...blocks, ...unmanagedFiles.map((path) => `${path} (unmanaged)`), ...alreadyAbsentDetails);
  entry.status = blocks.size > 0 ? "blocked" : "uninstall";
  if (entry.status !== "uninstall") {
    // All-or-nothing per destination (Design decision 4): a blocked destination removes nothing,
    // so its plan carries zero removals, no directory cleanup, and no manifest removal. Unmanaged
    // files stay listed in the details and in `unmanagedFiles` (S3 reporting).
    entry.removals = [];
    return entry;
  }

  entry.manifestRemoved = true;
  // Directory cleanup plan (S4, computed here, executed by `executeUninstallPlan`): only
  // directories on recorded-file paths may be removed, bottom-up, and only the ones that end
  // empty once the removable files are gone. Unmanaged content keeps its directory (S3).
  const removalPaths = new Set(entry.removals.map((removal) => removal.path));
  const candidateDirectories = new Set();
  for (const recordedPath of recordedChecksums.keys()) {
    const components = recordedPath.split("/");
    let current = skillDirectory;
    for (const component of components.slice(0, -1)) {
      current = join(current, component);
      candidateDirectories.add(current);
    }
  }
  const remainingFiles = realFiles
    .filter((file) => !removalPaths.has(file.relativePath))
    .map((file) => file.relativePath);
  const endsEmpty = (directory) => {
    const directoryRelative = toRelativePath(relative(skillDirectory, directory));
    return !remainingFiles.some((path) => path.startsWith(`${directoryRelative}/`));
  };
  // Sorting by path length descending puts every directory before its ancestors, so children are
  // always removed first.
  entry.directories = [...candidateDirectories].filter(endsEmpty).sort((left, right) => right.length - left.length);
  // The skill directory itself is removed only when nothing survives the removals.
  if (remainingFiles.length === 0) entry.directories.push(skillDirectory);
  return entry;
}

/**
 * Merge every scope's resolved destinations into one entry per absolute destination: when two
 * scopes resolve to the SAME directory (e.g. `cwd === home` makes the user and project scopes
 * collide), the entry carries the union of targets and the requested scopes in request order
 * instead of duplicating the destination — a duplicate would classify, report, and (for
 * uninstall) execute the same installation twice, and the second pass would always find its
 * planned files already removed.
 */
function mergeScopedDestinations(selectedTargets, selectedScopes, { cwd, home }) {
  const merged = new Map();
  for (const scope of selectedScopes) {
    for (const { destination, targets: destinationTargets } of resolveUniqueDestinations(selectedTargets, scope, { cwd, home })) {
      const skillDirectory = resolve(destination);
      const existing = merged.get(skillDirectory);
      if (existing) {
        for (const target of destinationTargets) {
          if (!existing.targets.includes(target)) existing.targets.push(target);
        }
        existing.scopes.push(scope);
      } else {
        merged.set(skillDirectory, { destination: skillDirectory, targets: [...destinationTargets], scopes: [scope] });
      }
    }
  }
  return [...merged.values()];
}

/**
 * Pure plan builder for uninstall (issue #16 T1): for each unique destination across the
 * requested scopes, classify the installation and compute the removals, directory cleanup, and
 * manifest removal that a clean uninstall would perform. Never writes; recorded-but-absent files
 * are reported, modified or unsafe content blocks its whole destination, and unmanaged content is
 * preserved.
 */
export function buildUninstallPlan({ targets: selectedTargets, scopes: selectedScopes, cwd, home }) {
  const destinations = mergeScopedDestinations(selectedTargets, selectedScopes, { cwd, home }).map(
    ({ destination, targets: destinationTargets, scopes: destinationScopes }) =>
      classifyUninstallDestination(destination, destinationTargets, destinationScopes),
  );
  const status = destinations.some((entry) => entry.status === "blocked" || entry.status === "unknown")
    ? "blocked"
    : destinations.every((entry) => entry.status === "absent") ? "absent" : "uninstall";
  return { destinations, status };
}

/**
 * Execute an uninstall plan. Dry runs write nothing; removal is all-or-nothing per destination
 * (one blocked destination never prevents the removal of others, and an execution-time failure
 * refuses only its own destination). A pre-verification pass re-checks every removal candidate
 * (intermediate components, final file kind, manifest checksum), the destination ROOT itself,
 * and the manifest before any
 * write, so — in all but race conditions — a refusal happens before anything is removed. If a
 * race is detected mid-loop, the destination stops immediately: the returned `removedFiles`
 * honestly reports exactly what was removed and the entry is marked blocked. No atomicity beyond
 * that is claimed or implemented. The manifest is removed LAST (the commit point): a destination
 * whose manifest is gone therefore implies its files and directory cleanup already succeeded, so
 * re-running the uninstall converges after any earlier partial failure.
 */
export function executeUninstallPlan(plan, { dryRun = false } = {}) {
  const removedFiles = [];
  const removedDirectories = [];
  const blocked = plan.destinations
    .filter((entry) => entry.status === "blocked" || entry.status === "unknown")
    .flatMap((entry) => entry.details);
  const unmanaged = plan.destinations.flatMap((entry) => entry.unmanagedFiles);
  let status = plan.status === "blocked" ? "blocked" : plan.status === "absent" ? "absent" : "uninstalled";

  const refuse = (entry, detail) => {
    entry.status = "blocked";
    entry.details.push(detail);
    blocked.push(detail);
    status = "blocked";
  };

  // Re-check one removal candidate immediately before its unlink (defense in depth, PR#29 round 3):
  // - the destination ROOT itself must still be a real, non-symlink directory (PR round-1 P1
  //   finding): a junction swapped in for the skill directory after planning redirects every
  //   per-file check through the link, so the full-path lstat would see external content as a
  //   regular file with the recorded checksum and the unlink would delete content OUTSIDE the
  //   installation;
  // - every intermediate component must still be a real directory: a junction or symlink swapped
  //   in after planning would make the plain full-path lstat see the redirected file as a regular
  //   file and the unlink would delete content OUTSIDE the skill directory;
  // - the final component must still be a regular file (never follow or unlink a symlink);
  // - the content must still match the manifest checksum that made it a removal candidate: only
  //   checksum-verified manifest content is ever removed (S1/S2).
  const verifyDestinationRoot = (entry) => {
    let directoryStats = null;
    try {
      directoryStats = lstatSync(entry.destination);
    } catch {
      directoryStats = null;
    }
    if (directoryStats === null || directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      return `skill destination is no longer a managed directory: ${entry.destination}`;
    }
    return null;
  };
  const verifyRemovalCandidate = (entry, removal) => {
    const rootRefusal = verifyDestinationRoot(entry);
    if (rootRefusal !== null) return rootRefusal;
    const unsafeIntermediate = unsafeIntermediateComponent(entry.destination, removal.path);
    if (unsafeIntermediate !== null) {
      return `${removal.path} (intermediate ${unsafeIntermediate} is a symlink or not a directory at execution time)`;
    }
    let stats = null;
    try {
      stats = lstatSync(removal.destination);
    } catch {
      stats = null;
    }
    if (stats === null || stats.isSymbolicLink() || !stats.isFile()) {
      return `${removal.path} (no longer a regular file at execution time)`;
    }
    if (sha256(readFileSync(removal.destination)) !== removal.sha256) {
      return `${removal.path} (modified after planning)`;
    }
    return null;
  };

  if (!dryRun) {
    for (const entry of plan.destinations) {
      if (entry.status !== "uninstall") continue;
      // Pre-verification pass: re-validate every removal candidate and the manifest before
      // touching anything, so in all but race conditions a refusal happens before any write.
      // Errors are isolated per destination (a changed destination refuses only itself).
      let refused = null;
      try {
        // The destination ROOT is re-validated first, before ANY unlink of this destination (the
        // per-unlink re-checks below re-run it through `verifyRemovalCandidate`).
        refused = verifyDestinationRoot(entry);
        if (refused === null) {
          for (const removal of entry.removals) {
            refused = verifyRemovalCandidate(entry, removal);
            if (refused !== null) break;
          }
        }
        if (refused === null) {
          let manifestStats = null;
          try {
            manifestStats = lstatSync(entry.manifestPath);
          } catch (error) {
            refused = `manifest (changed during execution: ${error.message})`;
          }
          if (refused === null && (manifestStats.isSymbolicLink() || !manifestStats.isFile())) {
            refused = `manifest is no longer a regular file: ${entry.manifestPath}`;
          }
        }
      } catch (error) {
        refused = `destination changed during execution: ${error.message}`;
      }
      if (refused !== null) {
        refuse(entry, refused);
        continue;
      }
      try {
        for (const removal of entry.removals) {
          // Re-verify immediately before EACH unlink (the PR#29 round-3 lesson, extended to
          // intermediate components and manifest checksums).
          refused = verifyRemovalCandidate(entry, removal);
          if (refused !== null) break;
          unlinkSync(removal.destination);
          removedFiles.push(removal.destination);
        }
        if (refused === null) {
          for (const directory of entry.directories) {
            try {
              rmdirSync(directory);
              removedDirectories.push(directory);
            } catch (error) {
              // ENOTEMPTY means unmanaged content (including an untracked empty directory) keeps
              // the directory alive: a skip, not an error. ENOENT means it is already gone.
              if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
            }
          }
          // The manifest is the commit point: it is unlinked only after every file and directory
          // removal succeeded, so a destination without a manifest is fully cleaned and re-running
          // the uninstall converges. ENOENT means something else already removed it.
          try {
            unlinkSync(entry.manifestPath);
            removedFiles.push(entry.manifestPath);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
      } catch (error) {
        refused = `destination changed during execution: ${error.message}`;
      }
      if (refused !== null) {
        refuse(entry, refused);
      }
    }
  }

  return { status, removedFiles, removedDirectories, blocked, unmanaged, plan };
}

/**
 * Read-only classification for the `status` command (issue #15 T1): for one unique destination
 * (deduplicated across the requested scopes), report exactly one status in precedence order:
 * absent, unknown, modified, outdated, managed. Never writes and never follows symlinks
 * (manifests are checked with `inspectManifestPath` and managed files with `lstatSync`).
 *
 * Decision (recorded per task T1): extra unmanaged files beside a fully matching manifest keep
 * the status `managed` and are only listed in `details`. The installer treats unmanaged content
 * as a write-time conflict, but this report is read-only-informational: a verified install whose
 * checksums all match must not be downgraded merely because the user added their own files.
 */
export function inspectInstallations({ targets: selectedTargets, scopes: selectedScopes, cwd, home, installerVersion: currentInstallerVersion }) {
  const entries = [];
  for (const { destination, targets: destinationTargets, scopes: destinationScopes } of mergeScopedDestinations(selectedTargets, selectedScopes, { cwd, home })) {
      const skillDirectory = destination;
      const manifestPath = join(dirname(skillDirectory), MANIFEST_NAME);
      const details = [];
      let manifestVersion = null;

      let directoryStats = null;
      try {
        directoryStats = lstatSync(skillDirectory);
      } catch (error) {
        // ENOTDIR (POSIX) for a non-directory ancestor of the destination means no managed
        // installation can exist under it: treat it as absent (matches inspectManifestPath).
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      }
      if (directoryStats === null) {
        entries.push({ status: "absent", scopes: destinationScopes, destination: skillDirectory, manifestPath, targets: destinationTargets, manifestVersion, details });
        continue;
      }
      if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
        details.push(`skill destination is not a managed directory: ${skillDirectory}`);
        entries.push({ status: "unknown", scopes: destinationScopes, destination: skillDirectory, manifestPath, targets: destinationTargets, manifestVersion, details });
        continue;
      }

      const manifestKind = inspectManifestPath(manifestPath).kind;
      if (manifestKind === "symlink") details.push(`manifest is a symlink: ${manifestPath}`);
      else if (manifestKind === "nonregular") details.push(`manifest is not a regular file: ${manifestPath}`);
      else if (manifestKind === "absent") details.push(`manifest is missing: ${manifestPath}`);
      const manifest = manifestKind === "regular" ? readManifestFile(manifestPath) : null;
      if (manifestKind === "regular" && manifest === null) details.push(`corrupt manifest: ${manifestPath}`);
      if (manifest === null) {
        entries.push({ status: "unknown", scopes: destinationScopes, destination: skillDirectory, manifestPath, targets: destinationTargets, manifestVersion, details });
        continue;
      }

      manifestVersion = manifest.installerVersion;
      // Never inspect recorded paths that escape the skill directory: a crafted manifest must not
      // drive checksum reads outside it. Such a manifest is untrustworthy as a whole, so the
      // destination is unknown instead of modified (nothing was verified against it). A
      // non-canonical record (backslash, empty/`.`/`..` segment) is rejected here too: every
      // surviving record is canonical, so `join()` in `toDestinationPath` performs no
      // normalization and `unsafeIntermediateComponent` below validates exactly the components of
      // the path that will actually be read — no normalization gap remains.
      const unsafeRecordedPaths = manifest.files.filter((file) => {
        if (!isCanonicalRecordedPath(file.path)) return true;
        const resolvedPath = resolve(toDestinationPath(skillDirectory, file.path));
        return resolvedPath !== skillDirectory && !resolvedPath.startsWith(skillDirectory + sep);
      });
      if (unsafeRecordedPaths.length > 0) {
        for (const file of unsafeRecordedPaths) details.push(`${file.path} (unsafe manifest path)`);
        entries.push({ status: "unknown", scopes: destinationScopes, destination: skillDirectory, manifestPath, targets: destinationTargets, manifestVersion, details });
        continue;
      }
      const recordedPaths = new Set(manifest.files.map((file) => file.path));
      let managedFileMismatch = false;
      for (const file of manifest.files) {
        const destinationPath = toDestinationPath(skillDirectory, file.path);
        const unsafeIntermediate = unsafeIntermediateComponent(skillDirectory, file.path);
        // Resolve the final component ONLY when every intermediate is safe: lstat still traverses
        // intermediate symlinks during path resolution, so a cyclic one would throw ELOOP here
        // (POSIX) and abort the whole inspection instead of degrading to a per-file mismatch.
        let fileStats = null;
        if (unsafeIntermediate === null) {
          try {
            fileStats = lstatSync(destinationPath);
          } catch (error) {
            // ENOTDIR (and the Windows-mapped ENOENT for traversal through a regular file) mean an
            // intermediate is not a directory: degrade to a per-file mismatch, never abort the report.
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
          }
        }
        if (unsafeIntermediate !== null) {
          // A symlinked or non-directory intermediate must never be read through: the recorded file
          // is unverifiable, so it counts as a mismatch instead of confirming managed content.
          managedFileMismatch = true;
          details.push(`${file.path} (intermediate ${unsafeIntermediate} is a symlink or not a directory)`);
        } else if (fileStats === null) {
          managedFileMismatch = true;
          details.push(`${file.path} (missing)`);
        } else if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
          // Never follow symlinks to read a checksum: an unverifiable managed path counts as a mismatch.
          managedFileMismatch = true;
          details.push(`${file.path} (symlinked or not a regular file)`);
        } else if (sha256(readFileSync(destinationPath)) !== file.sha256) {
          managedFileMismatch = true;
          details.push(`${file.path} (modified)`);
        }
      }
      for (const existingPath of listFiles(skillDirectory)) {
        const relativePath = toRelativePath(relative(skillDirectory, existingPath));
        if (recordedPaths.has(relativePath)) continue;
        details.push(`${relativePath} (unmanaged)`);
      }

      const status = managedFileMismatch
        ? "modified"
        : manifest.installerVersion === currentInstallerVersion ? "managed" : "outdated";
      entries.push({ status, scopes: destinationScopes, destination: skillDirectory, manifestPath, targets: destinationTargets, manifestVersion, details });
  }
  return entries;
}
