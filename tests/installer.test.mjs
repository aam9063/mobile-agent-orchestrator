import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { resolveDestination, resolveUniqueDestinations } from "../lib/hosts.mjs";
import { buildPlan, discoverPackageFiles, executePlan, MANIFEST_NAME, sha256 } from "../lib/installer.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = join(repoRoot, "skills", "mobile-agent-orchestrator");
const installerVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const canonicalFiles = discoverPackageFiles(skillRoot);
const installerModuleUrl = pathToFileURL(join(repoRoot, "lib", "installer.mjs")).href;

/** Write a synthetic skill source tree (map of forward-slash path -> content). */
function writeSkillFixture(directory, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(directory, ...relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function makeEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "installer-test-"));
  return {
    root,
    cwd: join(root, "project"),
    home: join(root, "home"),
    destination: join(root, "home", ".agents", "skills", "mobile-agent-orchestrator"),
    manifestPath: join(root, "home", ".agents", "skills", MANIFEST_NAME),
  };
}

function install(environment, { targets: selectedTargets = ["codex"], skillRoot: sourceRoot = skillRoot, installerVersion: version = installerVersion, ...executeOptions } = {}) {
  const plan = buildPlan({
    targets: selectedTargets,
    scope: "user",
    cwd: environment.cwd,
    home: environment.home,
    skillRoot: sourceRoot,
    installerVersion: version,
  });
  return { plan, result: executePlan(plan, executeOptions) };
}

test("clean install copies SKILL.md and every discovered reference", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const { result } = install(environment);
  assert.equal(result.status, "installed");
  assert.equal(result.writtenFiles.length, canonicalFiles.length + 1);
  for (const file of canonicalFiles) {
    const installedPath = join(environment.destination, ...file.path.split("/"));
    assert.ok(existsSync(installedPath), `missing installed file: ${file.path}`);
    assert.equal(readFileSync(installedPath, "utf8"), readFileSync(file.source, "utf8"));
    assert.ok(result.writtenFiles.includes(installedPath));
  }
});

test("manifest is written beside the skill directory with version and checksums", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const manifest = JSON.parse(readFileSync(environment.manifestPath, "utf8"));
  assert.equal(manifest.installerVersion, installerVersion);
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    canonicalFiles.map((file) => file.path),
  );
  for (const file of manifest.files) {
    const source = canonicalFiles.find((candidate) => candidate.path === file.path).source;
    assert.equal(file.sha256, sha256(readFileSync(source)));
  }
});

test("reinstalling identical content is an up-to-date no-op", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const skillBefore = readFileSync(join(environment.destination, "SKILL.md"), "utf8");
  const manifestBefore = readFileSync(environment.manifestPath, "utf8");

  const { result } = install(environment);
  assert.equal(result.status, "up-to-date");
  assert.deepEqual(result.writtenFiles, []);
  assert.equal(readFileSync(join(environment.destination, "SKILL.md"), "utf8"), skillBefore);
  assert.equal(readFileSync(environment.manifestPath, "utf8"), manifestBefore);
});

test("reinstalling over a locally modified file aborts without writing", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const modifiedSkillPath = join(environment.destination, "SKILL.md");
  writeFileSync(modifiedSkillPath, `${readFileSync(modifiedSkillPath, "utf8")}\nlocal edit\n`);
  const manifestBefore = readFileSync(environment.manifestPath, "utf8");

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.includes("SKILL.md (modified)"));
  assert.match(readFileSync(modifiedSkillPath, "utf8"), /local edit/);
  assert.equal(readFileSync(environment.manifestPath, "utf8"), manifestBefore);
});

test("unmanaged destination content aborts the install", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const extraPath = join(environment.destination, "references", "extra-notes.md");
  writeFileSync(extraPath, "user notes\n");

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.includes("references/extra-notes.md (unmanaged)"));
  assert.equal(readFileSync(extraPath, "utf8"), "user notes\n");
});

test("dry run writes nothing", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const { plan, result } = install(environment, { dryRun: true });
  assert.equal(result.status, "installed");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(plan.destinations[0].files.every((file) => file.action === "create"));
  assert.ok(!existsSync(join(environment.home, ".agents")));

  install(environment);
  const manifestBefore = readFileSync(environment.manifestPath, "utf8");
  const rerun = install(environment, { dryRun: true });
  assert.equal(rerun.result.status, "up-to-date");
  assert.deepEqual(rerun.result.writtenFiles, []);
  assert.equal(readFileSync(environment.manifestPath, "utf8"), manifestBefore);
});

test("selecting the three shared-location targets yields one destination and one manifest", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const sharedTargets = ["codex", "opencode", "gemini"];
  assert.deepEqual(
    resolveUniqueDestinations(sharedTargets, "user", { cwd: environment.cwd, home: environment.home }).map((entry) => entry.destination),
    [environment.destination],
  );

  const { plan, result } = install(environment, { targets: sharedTargets });
  assert.equal(plan.destinations.length, 1);
  assert.deepEqual(plan.destinations[0].targets, ["codex", "opencode", "gemini"]);
  assert.equal(result.status, "installed");
  assert.ok(existsSync(environment.manifestPath));
  assert.equal(result.writtenFiles.filter((path) => path.endsWith(MANIFEST_NAME)).length, 1);
});

test("selecting all targets yields two destinations and two manifests", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const allTargets = ["codex", "opencode", "gemini", "claude-code"];

  const unique = resolveUniqueDestinations(allTargets, "user", { cwd: environment.cwd, home: environment.home });
  assert.deepEqual(
    unique.map((entry) => entry.destination),
    [
      environment.destination,
      join(environment.home, ".claude", "skills", "mobile-agent-orchestrator"),
    ],
  );

  const dryRun = install(environment, { targets: allTargets, dryRun: true });
  assert.equal(dryRun.result.status, "installed");
  assert.deepEqual(dryRun.result.writtenFiles, []);
  assert.ok(!existsSync(join(environment.home, ".claude")));
  assert.ok(!existsSync(join(environment.home, ".agents")));

  const { plan, result } = install(environment, { targets: allTargets });
  assert.equal(plan.destinations.length, 2);
  const agents = plan.destinations.find((entry) => entry.destination === environment.destination);
  const claude = plan.destinations.find((entry) => entry.destination !== environment.destination);
  assert.deepEqual(agents.targets, ["codex", "opencode", "gemini"]);
  assert.deepEqual(claude.targets, ["claude-code"]);
  assert.equal(result.status, "installed");
  assert.equal(result.writtenFiles.filter((path) => path.endsWith(MANIFEST_NAME)).length, 2);
});

test("claude-code clean install copies SKILL.md and every discovered reference", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const destination = join(environment.home, ".claude", "skills", "mobile-agent-orchestrator");

  const { result } = install(environment, { targets: ["claude-code"] });
  assert.equal(result.status, "installed");
  assert.equal(result.writtenFiles.length, canonicalFiles.length + 1);
  for (const file of canonicalFiles) {
    const installedPath = join(destination, ...file.path.split("/"));
    assert.ok(existsSync(installedPath), `missing installed file: ${file.path}`);
    assert.equal(readFileSync(installedPath, "utf8"), readFileSync(file.source, "utf8"));
    assert.ok(result.writtenFiles.includes(installedPath));
  }
});

test("claude-code manifest is written beside the skill directory with version and checksums", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const destination = join(environment.home, ".claude", "skills", "mobile-agent-orchestrator");
  const manifestPath = join(environment.home, ".claude", "skills", MANIFEST_NAME);

  install(environment, { targets: ["claude-code"] });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.installerVersion, installerVersion);
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    canonicalFiles.map((file) => file.path),
  );
  for (const file of manifest.files) {
    const source = canonicalFiles.find((candidate) => candidate.path === file.path).source;
    assert.equal(file.sha256, sha256(readFileSync(source)));
  }
  assert.ok(existsSync(join(destination, "SKILL.md")));
});

test("claude-code reinstalling identical content is an up-to-date no-op", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const destination = join(environment.home, ".claude", "skills", "mobile-agent-orchestrator");
  const manifestPath = join(environment.home, ".claude", "skills", MANIFEST_NAME);

  install(environment, { targets: ["claude-code"] });
  const skillBefore = readFileSync(join(destination, "SKILL.md"), "utf8");
  const manifestBefore = readFileSync(manifestPath, "utf8");

  const { result } = install(environment, { targets: ["claude-code"] });
  assert.equal(result.status, "up-to-date");
  assert.deepEqual(result.writtenFiles, []);
  assert.equal(readFileSync(join(destination, "SKILL.md"), "utf8"), skillBefore);
  assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore);
});

test("claude-code reinstalling over a locally modified file aborts without writing", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const destination = join(environment.home, ".claude", "skills", "mobile-agent-orchestrator");
  const manifestPath = join(environment.home, ".claude", "skills", MANIFEST_NAME);

  install(environment, { targets: ["claude-code"] });
  const modifiedSkillPath = join(destination, "SKILL.md");
  writeFileSync(modifiedSkillPath, `${readFileSync(modifiedSkillPath, "utf8")}\nlocal edit\n`);
  const manifestBefore = readFileSync(manifestPath, "utf8");

  const { result } = install(environment, { targets: ["claude-code"] });
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.includes("SKILL.md (modified)"));
  assert.match(readFileSync(modifiedSkillPath, "utf8"), /local edit/);
  assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore);
});

test("claude-code dry run writes nothing", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const destination = join(environment.home, ".claude", "skills", "mobile-agent-orchestrator");
  const manifestPath = join(environment.home, ".claude", "skills", MANIFEST_NAME);

  const { plan, result } = install(environment, { targets: ["claude-code"], dryRun: true });
  assert.equal(result.status, "installed");
  assert.deepEqual(result.writtenFiles, []);
  assert.equal(plan.destinations[0].destination, destination);
  assert.ok(plan.destinations[0].files.every((file) => file.action === "create"));
  assert.ok(!existsSync(join(environment.home, ".claude")));

  install(environment, { targets: ["claude-code"] });
  const manifestBefore = readFileSync(manifestPath, "utf8");
  const rerun = install(environment, { targets: ["claude-code"], dryRun: true });
  assert.equal(rerun.result.status, "up-to-date");
  assert.deepEqual(rerun.result.writtenFiles, []);
  assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore);
});

test("invalid target and invalid or missing scope fail with clear errors", () => {
  const options = { cwd: "/tmp/project", home: "/tmp/home" };
  assert.throws(() => resolveDestination("claude", "user", options), /Unknown target: "claude"/);
  assert.throws(() => resolveDestination("codex", "workspace", options), /Unknown scope: "workspace"/);
  assert.throws(() => resolveDestination("codex", "user", { cwd: "/tmp/project" }), /requires an explicit home directory/);
  assert.throws(() => resolveDestination("codex", "project", { home: "/tmp/home" }), /requires an explicit working directory/);
  assert.throws(
    () => resolveUniqueDestinations(["codex"], "user", {}),
    /requires an explicit home directory/,
  );
});

test("destinations are built with path.join semantics for both scopes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "installer-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { cwd: join(root, "project"), home: join(root, "home") };
  assert.equal(
    resolveDestination("codex", "user", options),
    join(options.home, ".agents", "skills", "mobile-agent-orchestrator"),
  );
  assert.equal(
    resolveDestination("gemini", "project", options),
    join(options.cwd, ".agents", "skills", "mobile-agent-orchestrator"),
  );
  assert.equal(
    resolveDestination("claude-code", "user", options),
    join(options.home, ".claude", "skills", "mobile-agent-orchestrator"),
  );
  assert.equal(
    resolveDestination("claude-code", "project", options),
    join(options.cwd, ".claude", "skills", "mobile-agent-orchestrator"),
  );
});

test("a corrupt manifest fails closed: reinstall aborts without writing", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  writeFileSync(environment.manifestPath, "{not valid json");

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.some((conflict) => /corrupt manifest/.test(conflict)));
  assert.equal(readFileSync(environment.manifestPath, "utf8"), "{not valid json");
});

test("a deleted manifest is rewritten without touching identical installed files", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const skillBefore = readFileSync(join(environment.destination, "SKILL.md"), "utf8");
  rmSync(environment.manifestPath);

  const { result } = install(environment);
  assert.equal(result.status, "installed");
  assert.deepEqual(result.writtenFiles, [environment.manifestPath]);
  assert.equal(readFileSync(join(environment.destination, "SKILL.md"), "utf8"), skillBefore);
});

test("a broken symlink at a managed path aborts the install", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const managedPath = join(environment.destination, "references", "platform-matrix.md");
  rmSync(managedPath);
  try {
    symlinkSync(join(environment.destination, "missing-target.md"), managedPath);
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.includes("references/platform-matrix.md (unmanaged)"));
  assert.ok(lstatSync(managedPath).isSymbolicLink());
});

test("a destination skill path that is a regular file aborts the install", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  mkdirSync(join(environment.home, ".agents", "skills"), { recursive: true });
  writeFileSync(environment.destination, "occupied");

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.some((conflict) => /not a managed directory/.test(conflict)));
});

test("a nested unmanaged file aborts the install", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const nestedPath = join(environment.destination, "references", "nested", "extra.md");
  mkdirSync(dirname(nestedPath), { recursive: true });
  writeFileSync(nestedPath, "stray notes\n");

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.includes("references/nested/extra.md (unmanaged)"));
});

test("a version update replaces managed content recorded by the previous manifest", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const fixtureRoot = join(environment.root, "fixture", "mobile-agent-orchestrator");
  cpSync(skillRoot, fixtureRoot, { recursive: true });
  install(environment, { skillRoot: fixtureRoot });

  const sourceSkillPath = join(fixtureRoot, "SKILL.md");
  writeFileSync(sourceSkillPath, `${readFileSync(sourceSkillPath, "utf8")}\n## New in this version\n`);

  const { plan, result } = install(environment, { skillRoot: fixtureRoot });
  assert.equal(result.status, "installed");
  const updated = plan.destinations[0].files.find((file) => file.path === "SKILL.md");
  assert.equal(updated.classification, "modified");
  assert.equal(updated.action, "replace");
  assert.deepEqual(readFileSync(join(environment.destination, "SKILL.md"), "utf8"), readFileSync(sourceSkillPath, "utf8"));
  assert.ok(result.writtenFiles.includes(environment.manifestPath));
});

test("a manifest that is a symlink is rejected without following it", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const external = join(environment.root, "external-manifest.json");
  const externalContent = `${JSON.stringify({ installerVersion: "unrelated", files: [], keep: "user-data" }, null, 2)}\n`;
  writeFileSync(external, externalContent);
  mkdirSync(dirname(environment.manifestPath), { recursive: true });
  try {
    symlinkSync(external, environment.manifestPath);
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.some((conflict) => /manifest is a symlink/.test(conflict)));
  assert.equal(readFileSync(external, "utf8"), externalContent);
});

test("a dangling symlink manifest is rejected before its target can be created", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const external = join(environment.root, "missing-external-manifest.json");
  mkdirSync(dirname(environment.manifestPath), { recursive: true });
  try {
    symlinkSync(external, environment.manifestPath);
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.some((conflict) => /manifest is a symlink/.test(conflict)));
  assert.ok(!existsSync(external), "must not create the dangling symlink target");
});

test("a manifest path that is not a regular file is rejected", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  mkdirSync(environment.manifestPath, { recursive: true });

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.some((conflict) => /manifest is not a regular file/.test(conflict)));
});

test("an upgrade removes a managed file the new package no longer ships", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const previousRoot = join(environment.root, "previous", "mobile-agent-orchestrator");
  writeSkillFixture(previousRoot, { "SKILL.md": "v1\n", "references/old.md": "old\n" });
  install(environment, { skillRoot: previousRoot });

  const nextRoot = join(environment.root, "next", "mobile-agent-orchestrator");
  writeSkillFixture(nextRoot, { "SKILL.md": "v1\n" });
  const stalePath = join(environment.destination, "references", "old.md");
  const { plan, result } = install(environment, { skillRoot: nextRoot });

  assert.equal(result.status, "installed");
  const removal = plan.destinations[0].files.find((file) => file.path === "references/old.md");
  assert.equal(removal.classification, "stale");
  assert.equal(removal.action, "remove");
  assert.ok(result.removedFiles.includes(stalePath));
  assert.ok(!existsSync(stalePath));
  assert.ok(existsSync(join(environment.destination, "SKILL.md")));

  const rerun = install(environment, { skillRoot: nextRoot });
  assert.equal(rerun.result.status, "up-to-date");
  assert.deepEqual(rerun.result.writtenFiles, []);
  assert.deepEqual(rerun.result.removedFiles, []);
});

test("an upgrade rename creates the new path and removes the old managed path", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const previousRoot = join(environment.root, "previous", "mobile-agent-orchestrator");
  writeSkillFixture(previousRoot, { "SKILL.md": "v1\n", "references/old.md": "moved\n" });
  install(environment, { skillRoot: previousRoot });

  const nextRoot = join(environment.root, "next", "mobile-agent-orchestrator");
  writeSkillFixture(nextRoot, { "SKILL.md": "v1\n", "references/new.md": "moved\n" });
  const { plan, result } = install(environment, { skillRoot: nextRoot });

  assert.equal(result.status, "installed");
  const created = plan.destinations[0].files.find((file) => file.path === "references/new.md");
  const removed = plan.destinations[0].files.find((file) => file.path === "references/old.md");
  assert.equal(created.action, "create");
  assert.equal(removed.action, "remove");
  assert.equal(readFileSync(join(environment.destination, "references", "new.md"), "utf8"), "moved\n");
  assert.ok(!existsSync(join(environment.destination, "references", "old.md")));
});

test("an upgrade refuses to remove a modified former managed file", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const previousRoot = join(environment.root, "previous", "mobile-agent-orchestrator");
  writeSkillFixture(previousRoot, { "SKILL.md": "v1\n", "references/old.md": "old\n" });
  install(environment, { skillRoot: previousRoot });

  const stalePath = join(environment.destination, "references", "old.md");
  writeFileSync(stalePath, "locally edited\n");
  const nextRoot = join(environment.root, "next", "mobile-agent-orchestrator");
  writeSkillFixture(nextRoot, { "SKILL.md": "v1\n" });
  const { result } = install(environment, { skillRoot: nextRoot });

  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.includes("references/old.md (modified)"));
  assert.equal(readFileSync(stalePath, "utf8"), "locally edited\n");
});

test("an upgrade refuses to remove a symlink at a former managed path", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const previousRoot = join(environment.root, "previous", "mobile-agent-orchestrator");
  writeSkillFixture(previousRoot, { "SKILL.md": "v1\n", "references/old.md": "old\n" });
  install(environment, { skillRoot: previousRoot });

  const stalePath = join(environment.destination, "references", "old.md");
  const external = join(environment.root, "external-target.md");
  writeFileSync(external, "external\n");
  rmSync(stalePath);
  try {
    symlinkSync(external, stalePath);
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }
  const nextRoot = join(environment.root, "next", "mobile-agent-orchestrator");
  writeSkillFixture(nextRoot, { "SKILL.md": "v1\n" });
  const { result } = install(environment, { skillRoot: nextRoot });

  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.includes("references/old.md (unmanaged)"));
  assert.ok(lstatSync(stalePath).isSymbolicLink());
  assert.equal(readFileSync(external, "utf8"), "external\n");
});

test("an upgrade reconciles a case-only rename by physical identity, not by path string", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const previousRoot = join(environment.root, "previous", "mobile-agent-orchestrator");
  writeSkillFixture(previousRoot, { "SKILL.md": "v1\n", "references/old.md": "same\n" });
  install(environment, { skillRoot: previousRoot });

  const lowerPath = join(environment.destination, "references", "old.md");
  const upperPath = join(environment.destination, "references", "OLD.md");
  const caseInsensitive = existsSync(upperPath);

  const nextRoot = join(environment.root, "next", "mobile-agent-orchestrator");
  writeSkillFixture(nextRoot, { "SKILL.md": "v1\n", "references/OLD.md": "same\n" });
  const { result } = install(environment, { skillRoot: nextRoot });

  if (caseInsensitive) {
    assert.equal(result.status, "aborted");
    assert.deepEqual(result.writtenFiles, []);
    assert.ok(result.conflicts.some((conflict) => /aliases managed file/.test(conflict)));
    assert.equal(readFileSync(lowerPath, "utf8"), "same\n");
  } else {
    assert.equal(result.status, "installed");
    assert.equal(readFileSync(upperPath, "utf8"), "same\n");
    assert.ok(!existsSync(lowerPath), "case-sensitive rename must remove the former path");
  }
});

test("an upgrade aborts on unmanaged content while planning a removal", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const previousRoot = join(environment.root, "previous", "mobile-agent-orchestrator");
  writeSkillFixture(previousRoot, { "SKILL.md": "v1\n", "references/old.md": "old\n" });
  install(environment, { skillRoot: previousRoot });

  const stalePath = join(environment.destination, "references", "old.md");
  const extraPath = join(environment.destination, "references", "extra.md");
  writeFileSync(extraPath, "user notes\n");
  const nextRoot = join(environment.root, "next", "mobile-agent-orchestrator");
  writeSkillFixture(nextRoot, { "SKILL.md": "v1\n" });
  const { result } = install(environment, { skillRoot: nextRoot });

  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.includes("references/extra.md (unmanaged)"));
  assert.equal(readFileSync(stalePath, "utf8"), "old\n");
  assert.equal(readFileSync(extraPath, "utf8"), "user notes\n");
});

test("a dry-run upgrade reports removals and still writes nothing", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  const previousRoot = join(environment.root, "previous", "mobile-agent-orchestrator");
  writeSkillFixture(previousRoot, { "SKILL.md": "v1\n", "references/old.md": "old\n" });
  install(environment, { skillRoot: previousRoot });

  const stalePath = join(environment.destination, "references", "old.md");
  const manifestBefore = readFileSync(environment.manifestPath, "utf8");
  const nextRoot = join(environment.root, "next", "mobile-agent-orchestrator");
  writeSkillFixture(nextRoot, { "SKILL.md": "v1\n" });
  const { plan, result } = install(environment, { skillRoot: nextRoot, dryRun: true });

  assert.equal(result.status, "installed");
  assert.deepEqual(result.writtenFiles, []);
  assert.deepEqual(result.removedFiles, []);
  assert.equal(plan.destinations[0].files.find((file) => file.path === "references/old.md").action, "remove");
  assert.ok(existsSync(stalePath));
  assert.equal(readFileSync(environment.manifestPath, "utf8"), manifestBefore);
});

test("a manifest write failure preserves the previous manifest and a later run repairs it", { skip: process.platform !== "linux" ? "requires Linux RLIMIT_FSIZE semantics" : false }, (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const first = install(environment);
  assert.equal(first.result.status, "installed");
  const manifestBefore = readFileSync(environment.manifestPath, "utf8");
  JSON.parse(manifestBefore);

  const nextVersion = `${installerVersion}-next`;
  const runnerPath = join(environment.root, "failure-runner.mjs");
  const planOptions = {
    targets: ["codex"],
    scope: "user",
    cwd: environment.cwd,
    home: environment.home,
    skillRoot,
    installerVersion: nextVersion,
  };
  writeFileSync(
    runnerPath,
    `import { buildPlan, executePlan } from ${JSON.stringify(installerModuleUrl)};\nexecutePlan(buildPlan(${JSON.stringify(planOptions)}));\n`,
  );

  const failed = spawnSync(
    "bash",
    ["-c", `trap '' XFSZ; ulimit -f 0; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(runnerPath)}`],
    { encoding: "utf8" },
  );
  assert.notEqual(failed.status, 0, `expected the install to fail, got status ${failed.status}`);
  assert.match(failed.stderr, /EFBIG/);
  assert.equal(readFileSync(environment.manifestPath, "utf8"), manifestBefore);
  assert.doesNotThrow(() => JSON.parse(readFileSync(environment.manifestPath, "utf8")));
  assert.deepEqual(
    readdirSync(dirname(environment.manifestPath)).filter((entry) => entry.startsWith(`${MANIFEST_NAME}.tmp-`)),
    [],
    "atomic write must clean up its temp file",
  );

  const repaired = install(environment, { installerVersion: nextVersion });
  assert.equal(repaired.result.status, "installed");
  const rerun = install(environment, { installerVersion: nextVersion });
  assert.equal(rerun.result.status, "up-to-date");
  assert.deepEqual(rerun.result.writtenFiles, []);
});
