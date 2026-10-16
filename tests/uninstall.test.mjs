import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { run } from "../bin/mobile-agent-orchestrator.mjs";
import { buildPlan, buildUninstallPlan, executePlan, executeUninstallPlan, MANIFEST_NAME } from "../lib/installer.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

/** A small synthetic skill source tree, independent of the repository's real skill. */
const fixtureFiles = {
  "SKILL.md": "# fixture skill\n\nGenerated for uninstall tests.\n",
  "references/notes.md": "fixture notes\n",
};

/** Write a synthetic skill source tree (map of forward-slash path -> content). */
function writeSkillFixture(directory, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(directory, ...relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function makeEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "uninstall-test-"));
  const environment = {
    root,
    cwd: join(root, "project"),
    home: join(root, "home"),
    skillRoot: join(root, "fixture-skill"),
  };
  mkdirSync(environment.cwd, { recursive: true });
  mkdirSync(environment.home, { recursive: true });
  writeSkillFixture(environment.skillRoot, fixtureFiles);
  return environment;
}

/** Install the fixture skill through the real plan builder so fixtures are genuine managed installations. */
function installFixture(environment, { targets: selectedTargets = ["codex"], scope = "user", installerVersion: version = installerVersion } = {}) {
  const plan = buildPlan({
    targets: selectedTargets,
    scope,
    cwd: environment.cwd,
    home: environment.home,
    skillRoot: environment.skillRoot,
    installerVersion: version,
  });
  return executePlan(plan);
}

/** Snapshot every path (relative, forward slashes, sorted) under a directory without following symlinks. */
function snapshotTree(directory) {
  const paths = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      paths.push(relative(directory, path).replaceAll(sep, "/"));
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
    }
  };
  if (existsSync(directory)) visit(directory);
  return paths.sort();
}

function planUninstall(environment, { targets: selectedTargets = ["codex"], scopes: selectedScopes = ["user"] } = {}) {
  return buildUninstallPlan({
    targets: selectedTargets,
    scopes: selectedScopes,
    cwd: environment.cwd,
    home: environment.home,
  });
}

function destinationPath(environment, scope = "user") {
  const base = scope === "user" ? environment.home : environment.cwd;
  return join(base, ".agents", "skills", "mobile-agent-orchestrator");
}

function manifestPathFor(environment, scope = "user") {
  return join(destinationPath(environment, scope), "..", MANIFEST_NAME);
}

test("buildUninstallPlan is pure: it writes nothing", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const before = snapshotTree(environment.root);
  planUninstall(environment);
  assert.deepEqual(snapshotTree(environment.root), before, "plan building must not change the tree");
});

test("clean uninstall removes exactly the managed set, the manifest, and emptied directories", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = destinationPath(environment);
  const manifestPath = manifestPathFor(environment);

  const plan = planUninstall(environment);
  assert.equal(plan.status, "uninstall");
  assert.equal(plan.destinations.length, 1);
  const [entry] = plan.destinations;
  assert.equal(entry.destination, destination);
  assert.equal(entry.manifestPath, manifestPath);
  assert.deepEqual(entry.targets, ["codex"]);
  assert.equal(entry.status, "uninstall");
  assert.equal(entry.manifestRemoved, true);
  assert.deepEqual(entry.removals.map((removal) => removal.path).sort(), ["SKILL.md", "references/notes.md"]);
  assert.ok(entry.removals.every((removal) => removal.destination === join(destination, ...removal.path.split("/"))));
  // Bottom-up: the recorded-path directory before the skill directory itself.
  assert.deepEqual(entry.directories, [join(destination, "references"), destination]);
  assert.deepEqual(entry.details, []);

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "uninstalled");
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.unmanaged, []);
  assert.deepEqual(result.removedFiles.sort(), [
    join(destination, "SKILL.md"),
    manifestPath,
    join(destination, "references", "notes.md"),
  ].sort());
  assert.deepEqual(result.removedDirectories, [join(destination, "references"), destination]);
  assert.equal(existsSync(destination), false, "the emptied skill directory is removed");
  assert.equal(existsSync(manifestPath), false, "the manifest is removed");
  assert.equal(existsSync(join(environment.home, ".agents", "skills")), true, "the parent skills directory is preserved");
});

test("a modified managed file blocks the destination and nothing is removed", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = destinationPath(environment);
  writeFileSync(join(destination, "SKILL.md"), "# locally edited\n");
  const before = snapshotTree(environment.root);

  const plan = planUninstall(environment);
  const [entry] = plan.destinations;
  assert.equal(entry.status, "blocked", "a modified managed file must block the whole destination");
  assert.ok(entry.details.includes("SKILL.md (modified)"), `expected a modified detail, got: ${JSON.stringify(entry.details)}`);
  assert.deepEqual(entry.removals, [], "a blocked destination plans zero removals");
  assert.equal(plan.status, "blocked");

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.removedFiles, []);
  assert.deepEqual(result.removedDirectories, []);
  assert.deepEqual(snapshotTree(environment.root), before, "a blocked uninstall must be a zero-write operation");
});

test("unmanaged files and directories are preserved and listed, and keep their directories", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = destinationPath(environment);
  writeFileSync(join(destination, "user-notes.txt"), "user content\n");
  writeFileSync(join(destination, "references", "user-notes.md"), "user reference\n");
  mkdirSync(join(destination, "docs"), { recursive: true });
  writeFileSync(join(destination, "docs", "readme.md"), "user docs\n");

  const plan = planUninstall(environment);
  const [entry] = plan.destinations;
  assert.equal(entry.status, "uninstall", "unmanaged content must not block the uninstall");
  assert.deepEqual(
    entry.details.filter((detail) => detail.includes("unmanaged")).sort(),
    ["docs/readme.md (unmanaged)", "references/user-notes.md (unmanaged)", "user-notes.txt (unmanaged)"],
  );
  assert.deepEqual(entry.removals.map((removal) => removal.path).sort(), ["SKILL.md", "references/notes.md"]);
  // references/ is kept non-empty by the user file and the skill directory by all user content.
  assert.deepEqual(entry.directories, [], "directories kept non-empty by unmanaged content are never planned for removal");

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "uninstalled");
  assert.deepEqual(result.unmanaged.sort(), ["docs/readme.md", "references/user-notes.md", "user-notes.txt"]);
  assert.equal(existsSync(join(destination, "user-notes.txt")), true);
  assert.equal(existsSync(join(destination, "references", "user-notes.md")), true);
  assert.equal(existsSync(join(destination, "docs", "readme.md")), true);
  assert.equal(existsSync(destination), true, "the skill directory survives while user content remains");
  assert.equal(existsSync(join(destination, "SKILL.md")), false);
  assert.equal(existsSync(join(destination, "references", "notes.md")), false);
  assert.equal(existsSync(manifestPathFor(environment)), false);
});

test("a partial installation uninstalls what remains and reports already-absent files", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = destinationPath(environment);
  unlinkSync(join(destination, "SKILL.md"));

  const plan = planUninstall(environment);
  const [entry] = plan.destinations;
  assert.equal(entry.status, "uninstall", "a partial installation is not blocked");
  assert.ok(entry.details.includes("SKILL.md (already absent)"), `expected an already-absent detail, got: ${JSON.stringify(entry.details)}`);
  assert.deepEqual(entry.removals.map((removal) => removal.path), ["references/notes.md"]);

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "uninstalled");
  assert.equal(existsSync(destination), false, "the destination ends empty and is removed");
});

test("a missing manifest is unknown and nothing is removed", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const manifestPath = manifestPathFor(environment);
  unlinkSync(manifestPath);
  const before = snapshotTree(environment.root);

  const plan = planUninstall(environment);
  const [entry] = plan.destinations;
  assert.equal(entry.status, "unknown");
  assert.ok(entry.details.includes(`manifest is missing: ${manifestPath}`), `expected a missing-manifest detail, got: ${JSON.stringify(entry.details)}`);
  assert.deepEqual(entry.removals, []);

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.removedFiles, []);
  assert.deepEqual(result.removedDirectories, []);
  assert.deepEqual(snapshotTree(environment.root), before, "an unknown destination must be a zero-write operation");
});

test("a corrupt manifest is unknown and nothing is removed", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const manifestPath = manifestPathFor(environment);
  writeFileSync(manifestPath, "{not json");
  const before = snapshotTree(environment.root);

  const plan = planUninstall(environment);
  const [entry] = plan.destinations;
  assert.equal(entry.status, "unknown");
  assert.ok(entry.details.includes(`corrupt manifest: ${manifestPath}`));
  assert.deepEqual(entry.removals, []);

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "blocked");
  assert.deepEqual(snapshotTree(environment.root), before);
});

test("a symlinked manifest is unknown and never followed", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const manifestPath = manifestPathFor(environment);
  const externalManifest = join(environment.root, "external-manifest.json");
  writeFileSync(externalManifest, JSON.stringify({ installerVersion, files: [] }, null, 2));
  unlinkSync(manifestPath);
  try {
    symlinkSync(externalManifest, manifestPath);
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }
  const before = snapshotTree(environment.root);

  const plan = planUninstall(environment);
  const [entry] = plan.destinations;
  assert.equal(entry.status, "unknown");
  assert.ok(entry.details.includes(`manifest is a symlink: ${manifestPath}`));
  assert.deepEqual(entry.removals, []);

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "blocked");
  assert.deepEqual(snapshotTree(environment.root), before);
  assert.equal(lstatSync(manifestPath).isSymbolicLink(), true, "the symlinked manifest itself must survive");
});

test("a non-canonical recorded path is unknown and nothing is removed", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const manifestPath = manifestPathFor(environment);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files = [{ path: "SKILL.md/../references/notes.md", sha256: manifest.files[0].sha256 }];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const before = snapshotTree(environment.root);

  const plan = planUninstall(environment);
  const [entry] = plan.destinations;
  assert.equal(entry.status, "unknown");
  assert.ok(
    entry.details.some((detail) => detail.includes("SKILL.md/../references/notes.md") && detail.includes("unsafe manifest path")),
    `expected an unsafe-path detail, got: ${JSON.stringify(entry.details)}`,
  );
  assert.deepEqual(entry.removals, []);

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "blocked");
  assert.deepEqual(snapshotTree(environment.root), before);
});

test("a containment-violating recorded path is unknown and nothing is removed", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const manifestPath = manifestPathFor(environment);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files = [{ path: "../outside.txt", sha256: manifest.files[0].sha256 }];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const before = snapshotTree(environment.root);

  const plan = planUninstall(environment);
  const [entry] = plan.destinations;
  assert.equal(entry.status, "unknown");
  assert.ok(
    entry.details.some((detail) => detail.includes("../outside.txt") && detail.includes("unsafe manifest path")),
    `expected an unsafe-path detail, got: ${JSON.stringify(entry.details)}`,
  );

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "blocked");
  assert.deepEqual(snapshotTree(environment.root), before);
});

test("a shared destination reports every target and uninstalls the single copy", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { targets: ["codex", "opencode", "gemini"] });
  const destination = destinationPath(environment);

  const plan = planUninstall(environment, { targets: ["codex", "opencode", "gemini"] });
  assert.equal(plan.destinations.length, 1, "codex, opencode, and gemini share one .agents destination");
  const [entry] = plan.destinations;
  assert.deepEqual(entry.targets, ["codex", "opencode", "gemini"]);
  assert.equal(entry.status, "uninstall");

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "uninstalled");
  assert.equal(existsSync(destination), false);
  assert.deepEqual(readdirSync(join(environment.home, ".agents", "skills")), [], "the shared skills directory is left empty");
});

test("a dry run reports the plan and writes nothing", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const before = snapshotTree(environment.root);
  const plan = planUninstall(environment);

  const result = executeUninstallPlan(plan, { dryRun: true });
  assert.equal(result.status, "uninstalled");
  assert.deepEqual(result.removedFiles, []);
  assert.deepEqual(result.removedDirectories, []);
  assert.deepEqual(result.blocked, []);
  assert.equal(result.plan, plan, "the plan is echoed in the return value");
  assert.deepEqual(snapshotTree(environment.root), before, "a dry run must be a zero-write operation");
});

test("a recorded file turned into a symlink after planning is refused at execution time", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = destinationPath(environment);
  const plan = planUninstall(environment);
  assert.equal(plan.status, "uninstall", "the plan itself was built against a clean installation");

  const external = join(environment.root, "external-notes.md");
  writeFileSync(external, "fixture notes\n");
  const notesPath = join(destination, "references", "notes.md");
  unlinkSync(notesPath);
  try {
    symlinkSync(external, notesPath);
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "blocked", "execution must refuse the destination");
  assert.deepEqual(result.removedFiles, [], "the refusal is all-or-nothing per destination");
  assert.deepEqual(result.removedDirectories, []);
  assert.equal(result.plan.destinations[0].status, "blocked");
  assert.equal(lstatSync(notesPath).isSymbolicLink(), true, "the symlink must survive");
  assert.equal(existsSync(join(destination, "SKILL.md")), true, "no sibling file may be removed either");
  assert.equal(existsSync(manifestPathFor(environment)), true, "the manifest must survive a refused destination");
});

test("a symlinked intermediate directory blocks the destination and is never resolved through", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = destinationPath(environment);
  const externalDirectory = join(environment.root, "external-references");
  mkdirSync(externalDirectory, { recursive: true });
  writeFileSync(join(externalDirectory, "notes.md"), "fixture notes\n");
  rmSync(join(destination, "references"), { recursive: true });
  try {
    // "junction" needs no symlink privilege on Windows and is ignored on POSIX, where a real
    // directory symlink is created; lstat reports both as symbolic links.
    symlinkSync(externalDirectory, join(destination, "references"), "junction");
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }
  const before = snapshotTree(environment.root);

  const plan = planUninstall(environment);
  const [entry] = plan.destinations;
  assert.equal(entry.status, "blocked", "a symlinked intermediate must never be resolved through");
  const detail = entry.details.find((line) => line.includes("references/notes.md"));
  assert.ok(detail, `expected a detail naming the recorded file, got: ${JSON.stringify(entry.details)}`);
  assert.match(detail, /intermediate/, "the detail must name the offending intermediate");
  assert.deepEqual(entry.removals, []);

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.removedFiles, []);
  assert.deepEqual(result.removedDirectories, []);
  assert.deepEqual(snapshotTree(environment.root), before, "a blocked destination must be a zero-write operation");
});

test("an absent destination is reported and writes nothing", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const plan = planUninstall(environment);
  assert.equal(plan.status, "absent");
  const [entry] = plan.destinations;
  assert.equal(entry.status, "absent");
  assert.deepEqual(entry.removals, []);
  assert.deepEqual(entry.directories, []);
  assert.equal(entry.manifestRemoved, false);

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "absent");
  assert.deepEqual(result.removedFiles, []);
  assert.deepEqual(result.removedDirectories, []);
  assert.deepEqual(snapshotTree(environment.home), [], "nothing exists and nothing was written");
});

test("one blocked destination never prevents the uninstall of another", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { targets: ["codex"] });
  installFixture(environment, { targets: ["claude-code"] });
  const codexDestination = destinationPath(environment);
  const claudeDestination = join(environment.home, ".claude", "skills", "mobile-agent-orchestrator");
  writeFileSync(join(codexDestination, "SKILL.md"), "# locally edited\n");

  const plan = planUninstall(environment, { targets: ["codex", "claude-code"] });
  assert.equal(plan.destinations.length, 2);
  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "blocked");
  assert.equal(existsSync(join(codexDestination, "SKILL.md")), true, "the blocked destination is untouched");
  assert.equal(existsSync(claudeDestination), false, "the clean destination is still uninstalled");
  assert.ok(result.removedFiles.every((path) => path.startsWith(join(environment.home, ".claude"))));
});

// --- Adversarial-review fixes (issue #16 round 2) ---

test("a junction swapped in for an intermediate directory after planning is refused and the external victim file survives", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = destinationPath(environment);
  const plan = planUninstall(environment);
  assert.equal(plan.status, "uninstall", "the plan itself was built against a clean installation");

  // Swap the real `references` directory for a junction AFTER planning: the re-lstat of the full
  // recorded path would traverse the junction and see the external file as a regular file, so the
  // executor must re-check the intermediate components themselves before any unlink.
  const externalDirectory = join(environment.root, "victim-dir");
  mkdirSync(externalDirectory, { recursive: true });
  const victimPath = join(externalDirectory, "notes.md");
  writeFileSync(victimPath, "victim content\n");
  rmSync(join(destination, "references"), { recursive: true });
  try {
    symlinkSync(externalDirectory, join(destination, "references"), "junction");
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "blocked", "execution must refuse the destination");
  const detail = result.blocked.find((line) => line.includes("references/notes.md") && line.includes("intermediate"));
  assert.ok(detail, `expected an intermediate detail, got: ${JSON.stringify(result.blocked)}`);
  assert.equal(existsSync(victimPath), true, "the external victim file must survive");
  assert.equal(readFileSync(victimPath, "utf8"), "victim content\n", "the victim file's content must be intact");
  assert.equal(existsSync(join(destination, "SKILL.md")), true, "no sibling file may be removed either");
  assert.equal(existsSync(manifestPathFor(environment)), true, "the manifest must survive a refused destination");
});

test("an execution-time manifest failure refuses only its own destination; the next destination still uninstalls", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { targets: ["codex"] });
  installFixture(environment, { targets: ["claude-code"] });
  const codexDestination = destinationPath(environment);
  const claudeDestination = join(environment.home, ".claude", "skills", "mobile-agent-orchestrator");

  const plan = planUninstall(environment, { targets: ["codex", "claude-code"] });
  assert.equal(plan.destinations[0].destination, codexDestination, "precondition: the codex destination is planned first");
  // The first destination's manifest disappears between planning and execution.
  unlinkSync(manifestPathFor(environment));

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "blocked");
  const detail = result.blocked.find((line) => line.includes("changed during execution"));
  assert.ok(detail, `expected an execution-time detail, got: ${JSON.stringify(result.blocked)}`);
  assert.equal(existsSync(join(codexDestination, "SKILL.md")), true, "the failing destination is not modified");
  assert.equal(existsSync(claudeDestination), false, "the second destination is still uninstalled");
  assert.ok(
    result.removedFiles.some((path) => path.startsWith(join(environment.home, ".claude"))),
    `removedFiles must include the second destination's files, got: ${JSON.stringify(result.removedFiles)}`,
  );
});

test("a file modified after planning is refused at execution time and its modified content survives", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = destinationPath(environment);
  const plan = planUninstall(environment);
  assert.equal(plan.status, "uninstall");

  const tamperedPath = join(destination, "SKILL.md");
  writeFileSync(tamperedPath, "# tampered after planning\n");

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "blocked", "execution must refuse the destination");
  const detail = result.blocked.find((line) => line.startsWith("SKILL.md") && line.includes("modified"));
  assert.ok(detail, `expected a detail naming the modified file, got: ${JSON.stringify(result.blocked)}`);
  assert.equal(readFileSync(tamperedPath, "utf8"), "# tampered after planning\n", "the modified content must survive");
  assert.equal(existsSync(manifestPathFor(environment)), true, "the manifest must survive a refused destination");
});

test("a case-only rename of a managed file blocks the destination when the alias hides its recorded name", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = destinationPath(environment);
  renameSync(join(destination, "SKILL.md"), join(destination, "skill.md"));

  const plan = planUninstall(environment);
  const [entry] = plan.destinations;
  let aliasHidesRecordedName = false;
  try {
    aliasHidesRecordedName = lstatSync(join(destination, "SKILL.md")).isFile();
  } catch {
    aliasHidesRecordedName = false;
  }
  if (aliasHidesRecordedName) {
    // Case-insensitive filesystem (Windows): the recorded name resolves to the renamed file, so
    // the manifest record verifies while the real listing spells it differently. That alias must
    // block: removing the manifest would orphan managed content under a different spelling.
    assert.equal(entry.status, "blocked");
    assert.ok(
      entry.details.includes("SKILL.md (not present under its recorded name)"),
      `expected a recorded-name detail, got: ${JSON.stringify(entry.details)}`,
    );
    assert.deepEqual(entry.removals, []);
    const result = executeUninstallPlan(plan);
    assert.equal(result.status, "blocked");
    assert.equal(existsSync(join(destination, "skill.md")), true, "the alias file survives a blocked uninstall");
  } else {
    // Case-sensitive filesystem (POSIX): the recorded name is genuinely gone and the differently
    // cased file is unmanaged content that survives.
    assert.equal(entry.status, "uninstall");
    assert.ok(
      entry.details.includes("SKILL.md (already absent)"),
      `expected an already-absent detail, got: ${JSON.stringify(entry.details)}`,
    );
    assert.ok(entry.unmanagedFiles.includes("skill.md"), "the alias file is treated as unmanaged");
    assert.equal(existsSync(join(destination, "skill.md")), true, "the recorded file (under its on-disk spelling) is intact");
  }
});

test("an unmanaged empty directory keeps the skill directory while everything managed is removed", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = destinationPath(environment);
  mkdirSync(join(destination, "user-empty-dir"), { recursive: true });

  const plan = planUninstall(environment);
  const [entry] = plan.destinations;
  assert.equal(entry.status, "uninstall", "an untracked empty directory must not block the uninstall");
  assert.deepEqual(entry.removals.map((removal) => removal.path).sort(), ["SKILL.md", "references/notes.md"]);
  assert.deepEqual(
    entry.directories,
    [join(destination, "references"), destination],
    "the plan still removes the recorded-path directories it can",
  );

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "uninstalled");
  assert.deepEqual(
    result.removedDirectories,
    [join(destination, "references")],
    "the skill directory rmdir is skipped (ENOTEMPTY), not an error",
  );
  assert.equal(existsSync(join(destination, "user-empty-dir")), true, "the unmanaged empty directory keeps the skill directory alive");
  assert.equal(existsSync(join(destination, "SKILL.md")), false);
  assert.equal(existsSync(join(destination, "references", "notes.md")), false);
  assert.equal(existsSync(manifestPathFor(environment)), false);
});

test("the manifest is removed last and a partially cleaned destination converges on re-run", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = destinationPath(environment);
  const manifestPath = manifestPathFor(environment);

  const plan = planUninstall(environment);
  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "uninstalled");
  assert.equal(
    result.removedFiles.indexOf(manifestPath),
    result.removedFiles.length - 1,
    `the manifest is the commit point and must be removed last, got: ${JSON.stringify(result.removedFiles)}`,
  );

  // Partial-failure convergence: files gone, manifest present — the only shape a failure can
  // leave now that the manifest is the commit point. Re-running the uninstall must converge to
  // fully removed instead of refusing forever.
  installFixture(environment);
  unlinkSync(join(destination, "SKILL.md"));
  rmSync(join(destination, "references"), { recursive: true });
  const rerun = executeUninstallPlan(planUninstall(environment));
  assert.equal(rerun.status, "uninstalled");
  assert.deepEqual(rerun.removedFiles, [manifestPath], "only the manifest is left to remove");
  assert.equal(existsSync(destination), false, "the partially cleaned destination is fully removed");
  assert.equal(existsSync(manifestPath), false);
});

test("a junction swapped in for the destination root after planning is refused before any unlink and the external victim survives", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = destinationPath(environment);
  const plan = planUninstall(environment);
  assert.equal(plan.status, "uninstall", "the plan itself was built against a clean installation");

  // Move the real installation aside and put a junction in its place. The external directory
  // mirrors the managed content byte-for-byte (every recorded checksum matches), so without a
  // re-check of the destination ROOT itself the executor would follow the junction and unlink
  // the external victim files even though every per-file re-check passes.
  const realInstallation = join(environment.root, "real-installation");
  renameSync(destination, realInstallation);
  const externalDirectory = join(environment.root, "victim-root");
  mkdirSync(join(externalDirectory, "references"), { recursive: true });
  const victimPath = join(externalDirectory, "SKILL.md");
  const victimReferencePath = join(externalDirectory, "references", "notes.md");
  writeFileSync(victimPath, fixtureFiles["SKILL.md"]);
  writeFileSync(victimReferencePath, fixtureFiles["references/notes.md"]);
  try {
    symlinkSync(externalDirectory, destination, "junction");
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }

  const result = executeUninstallPlan(plan);
  assert.equal(result.status, "blocked", "execution must refuse the destination");
  assert.ok(
    result.blocked.includes(`skill destination is no longer a managed directory: ${destination}`),
    `expected a root-refusal detail, got: ${JSON.stringify(result.blocked)}`,
  );
  assert.deepEqual(result.removedFiles, [], "the refusal happens before any unlink");
  assert.deepEqual(result.removedDirectories, []);
  assert.equal(existsSync(victimPath), true, "the external victim file must survive");
  assert.equal(readFileSync(victimPath, "utf8"), fixtureFiles["SKILL.md"], "the victim file's content must be intact");
  assert.equal(existsSync(victimReferencePath), true, "the external victim reference must survive");
  assert.equal(existsSync(join(realInstallation, "SKILL.md")), true, "the real installation moved aside is untouched");
  assert.equal(existsSync(manifestPathFor(environment)), true, "the manifest must survive a refused destination");
});

// --- CLI-level tests: the `uninstall` subcommand (issue #16 T2) ---

/** Writable stream that records every chunk synchronously, for deterministic output asserts. */
function makeOutput() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join(""), lines: () => chunks.join("").split("\n").filter((line) => line.length > 0) };
}

function cliRun(environment, argv) {
  const out = makeOutput();
  const err = makeOutput();
  const runPromise = run(argv, {
    input: Readable.from([]),
    output: out.stream,
    errorOutput: err.stream,
    home: environment.home,
    cwd: environment.cwd,
  });
  return { exitPromise: runPromise, out, err };
}

const sharedDestination = (environment, scope = "user") => join(scope === "user" ? environment.home : environment.cwd, ".agents", "skills", "mobile-agent-orchestrator");

/** Sorted plan detail lines (`- remove ...`, `- keep ...`), excluding executed `- removed ...` result lines. */
function planDetailLines(lines) {
  return lines.filter((line) => line.startsWith("  - ") && !line.startsWith("  - removed")).sort();
}

const cleanUninstallPlanLines = (destination, manifestPath) => [
  `  - remove ${join(destination, "SKILL.md")}`,
  `  - remove ${join(destination, "references", "notes.md")}`,
  `  - remove directory ${destination}`,
  `  - remove directory ${join(destination, "references")}`,
  `  - remove manifest ${manifestPath}`,
].sort();

test("CLI uninstall --dry-run prints the exact plan, writes nothing, and exits 0", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = sharedDestination(environment);
  const manifestPath = manifestPathFor(environment);
  const before = snapshotTree(environment.root);

  const { exitPromise, out, err } = cliRun(environment, ["uninstall", "--target", "codex", "--scope", "user", "--dry-run"]);
  const exit = await exitPromise;

  assert.equal(exit, 0);
  assert.equal(err.text(), "", "a dry run must not write to stderr");
  const lines = out.lines();
  assert.equal(lines[0], `uninstall [user] ${destination} (codex, opencode, gemini)`);
  assert.deepEqual(planDetailLines(lines), cleanUninstallPlanLines(destination, manifestPath));
  assert.equal(lines.at(-1), "1 destination(s) inspected");
  assert.deepEqual(snapshotTree(environment.root), before, "a dry run must be a zero-write operation");
});

test("CLI uninstall removes managed files, the manifest, and emptied directories; user content survives", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = sharedDestination(environment);
  const manifestPath = manifestPathFor(environment);
  writeFileSync(join(destination, "user-notes.txt"), "user content\n");

  const { exitPromise, out, err } = cliRun(environment, ["uninstall", "--target", "codex", "--scope", "user"]);
  const exit = await exitPromise;

  assert.equal(exit, 0);
  assert.equal(err.text(), "");
  const lines = out.lines();
  assert.equal(lines[0], `uninstall [user] ${destination} (codex, opencode, gemini)`, "the plan is printed before execution");
  assert.deepEqual(planDetailLines(lines), [
    `  - remove ${join(destination, "SKILL.md")}`,
    `  - remove ${join(destination, "references", "notes.md")}`,
    `  - remove directory ${join(destination, "references")}`,
    `  - remove manifest ${manifestPath}`,
    `  - keep ${join(destination, "user-notes.txt")} (unmanaged)`,
  ].sort());
  const removedLines = lines.filter((line) => line.startsWith("  - removed")).sort();
  assert.deepEqual(removedLines, [
    `  - removed ${join(destination, "SKILL.md")}`,
    `  - removed ${join(destination, "references", "notes.md")}`,
    `  - removed ${manifestPath}`,
    `  - removed directory ${join(destination, "references")}`,
  ].sort(), "every executed removal is reported");
  assert.equal(lines.at(-1), "1 destination(s) inspected");
  assert.equal(existsSync(join(destination, "user-notes.txt")), true, "user content is preserved");
  assert.equal(existsSync(join(destination, "SKILL.md")), false);
  assert.equal(existsSync(join(destination, "references", "notes.md")), false);
  assert.equal(existsSync(manifestPath), false, "the manifest is removed");

  // Optional cross-check: the destination directory survives (kept by user content) without a
  // manifest, so a follow-up status honestly reports it as unknown (needs attention).
  const status = cliRun(environment, ["status", "--target", "codex", "--scope", "user"]);
  assert.equal(await status.exitPromise, 1);
  const statusLines = status.out.lines();
  assert.equal(statusLines[0], `unknown [user] ${destination} (codex)`);
  assert.ok(statusLines.some((line) => line.includes(`manifest is missing: ${manifestPath}`)));
});

test("CLI uninstall over a modified managed file exits 1, explains the block, and writes nothing", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = sharedDestination(environment);
  writeFileSync(join(destination, "SKILL.md"), "# locally edited\n");
  const before = snapshotTree(environment.root);

  // No --dry-run and no second scope on purpose: the block itself must guarantee the zero-write outcome.
  const { exitPromise, out } = cliRun(environment, ["uninstall", "--target", "codex", "--scope", "user"]);
  const exit = await exitPromise;

  assert.equal(exit, 1, "a blocked destination fails the uninstall");
  const lines = out.lines();
  assert.equal(lines[0], `blocked [user] ${destination} (codex, opencode, gemini)`);
  const detail = lines.find((line) => line.startsWith("  - "));
  assert.ok(detail, "a blocking detail line is printed");
  assert.ok(detail.includes("SKILL.md (modified)"), `expected a modified detail, got: ${JSON.stringify(detail)}`);
  assert.equal(lines.at(-1), "1 destination(s) inspected");
  assert.deepEqual(snapshotTree(environment.root), before, "a blocked uninstall must be a zero-write operation");
});

test("CLI uninstall without --scope plans BOTH scopes; --scope narrows to one", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { scope: "user" });
  installFixture(environment, { scope: "project" });
  const userDestination = sharedDestination(environment, "user");
  const projectDestination = sharedDestination(environment, "project");

  const both = cliRun(environment, ["uninstall", "--target", "codex", "--dry-run"]);
  assert.equal(await both.exitPromise, 0);
  const bothLines = both.out.lines();
  assert.ok(bothLines.includes(`uninstall [user] ${userDestination} (codex, opencode, gemini)`), `missing user entry: ${JSON.stringify(bothLines)}`);
  assert.ok(bothLines.includes(`uninstall [project] ${projectDestination} (codex, opencode, gemini)`), `missing project entry: ${JSON.stringify(bothLines)}`);
  assert.equal(bothLines.at(-1), "2 destination(s) inspected");

  const projectOnly = cliRun(environment, ["uninstall", "--target", "codex", "--scope", "project", "--dry-run"]);
  assert.equal(await projectOnly.exitPromise, 0);
  const projectLines = projectOnly.out.lines();
  assert.equal(projectLines[0], `uninstall [project] ${projectDestination} (codex, opencode, gemini)`);
  assert.equal(projectLines.at(-1), "1 destination(s) inspected");
  assert.ok(!projectLines.some((line) => line.includes("[user]")), "--scope project must exclude the user scope");
});

test("CLI uninstall reuses the exact install validation messages and exits 1", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const cases = [
    { argv: ["uninstall"], message: "Missing required --target (codex, opencode, gemini, claude-code); no default is provided." },
    { argv: ["uninstall", "--target", "bogus"], message: "Unknown target: bogus. Expected one of: codex, opencode, gemini, claude-code." },
    { argv: ["uninstall", "--target", "codex", "--scope", "root"], message: "Unknown scope: root. Expected one of: user, project." },
    { argv: ["uninstall", "--target", "codex", "--nope"], message: "Unknown argument: --nope." },
    { argv: ["uninstall", "--target"], message: "--target requires a value." },
    { argv: ["uninstall", "--scope"], message: "--scope requires a value." },
  ];
  for (const { argv, message } of cases) {
    const { exitPromise, err } = cliRun(environment, argv);
    const exit = await exitPromise;
    assert.equal(exit, 1, `expected exit 1 for ${argv.join(" ")}`);
    assert.equal(err.text(), `${message}\n`);
  }
});

test("CLI uninstall of a shared destination names every target and removes the single copy", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { targets: ["codex", "opencode", "gemini"] });
  const destination = sharedDestination(environment);

  const dryRun = cliRun(environment, ["uninstall", "--target", "codex", "--dry-run"]);
  assert.equal(await dryRun.exitPromise, 0);
  assert.equal(dryRun.out.lines()[0], `uninstall [user] ${destination} (codex, opencode, gemini)`);

  const real = cliRun(environment, ["uninstall", "--target", "codex"]);
  const exit = await real.exitPromise;
  assert.equal(exit, 0);
  assert.equal(existsSync(destination), false, "the shared copy is removed by any one of its targets");
  assert.deepEqual(readdirSync(join(environment.home, ".agents", "skills")), [], "the shared skills directory is left empty");
});

// --- PR review round 1 fixes (issue #16 round 3) ---

test("uninstall from the home directory deduplicates the shared destination into one [user, project] entry", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  // Running from the home directory makes BOTH default scopes resolve to the SAME destination;
  // the plan must carry one entry with merged scopes, not a second entry that finds its files
  // already removed and blocks the command.
  environment.cwd = environment.home;

  installFixture(environment, { scope: "user" });
  const destination = sharedDestination(environment);

  const { exitPromise, out, err } = cliRun(environment, ["uninstall", "--target", "codex"]);
  const exit = await exitPromise;

  assert.equal(exit, 0, "one clean destination must uninstall successfully");
  assert.equal(err.text(), "");
  const lines = out.lines();
  assert.equal(lines[0], `uninstall [user, project] ${destination} (codex, opencode, gemini)`);
  assert.equal(lines.at(-1), "1 destination(s) inspected");
  const removedLines = lines.filter((line) => line.startsWith("  - removed")).sort();
  assert.deepEqual(removedLines, [
    `  - removed ${join(destination, "SKILL.md")}`,
    `  - removed ${join(destination, "references", "notes.md")}`,
    `  - removed ${manifestPathFor(environment)}`,
    `  - removed directory ${join(destination, "references")}`,
    `  - removed directory ${destination}`,
  ].sort(), "each managed path is removed exactly once");
  assert.equal(existsSync(destination), false);
});

test("--help documents the uninstall command, its options, and its exit codes", async () => {
  const out = makeOutput();

  const exit = await run(["--help"], {
    input: Readable.from([]),
    output: out.stream,
    errorOutput: makeOutput().stream,
  });

  assert.equal(exit, 0);
  const text = out.text();
  assert.ok(text.includes("uninstall --target <name>"), "the uninstall form is documented");
  assert.match(text, /REQUIRED/, "--target is documented as required for uninstall");
  assert.match(text, /both scopes/i, "the both-scopes default is documented");
  assert.match(text, /one copy/, "the shared .agents/skills destination is documented");
  assert.match(text, /already absent/, "the uninstall exit-code contract is documented");
});

test("CLI uninstall --dry-run renders informational details for clean destinations", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  unlinkSync(join(sharedDestination(environment), "SKILL.md"));

  const { exitPromise, out, err } = cliRun(environment, ["uninstall", "--target", "codex", "--scope", "user", "--dry-run"]);
  const exit = await exitPromise;

  assert.equal(exit, 0);
  assert.equal(err.text(), "");
  const lines = out.lines();
  assert.ok(
    lines.includes("  - SKILL.md (already absent)"),
    `a clean destination's informational details are part of the exact plan, got: ${JSON.stringify(lines)}`,
  );
  assert.equal(existsSync(join(sharedDestination(environment), "references", "notes.md")), true, "a dry run writes nothing");
});
