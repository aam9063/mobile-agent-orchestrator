import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binPath = join(repoRoot, "bin", "mobile-agent-orchestrator.mjs");

function runBin(entry, args) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" });
}

test("invoked directly, the CLI answers --help", () => {
  const result = runBin(binPath, ["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test("invoked through a symlink (the npm .bin shim), the CLI still runs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "installer-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shimDirectory = join(root, "node_modules", ".bin");
  mkdirSync(shimDirectory, { recursive: true });
  const shim = join(shimDirectory, "mobile-agent-orchestrator");
  try {
    symlinkSync(binPath, shim);
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }

  const result = runBin(shim, ["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test("a bogus subcommand through the symlink reports a failure", (t) => {
  const root = mkdtempSync(join(tmpdir(), "installer-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shimDirectory = join(root, "node_modules", ".bin");
  mkdirSync(shimDirectory, { recursive: true });
  const shim = join(shimDirectory, "mobile-agent-orchestrator");
  try {
    symlinkSync(binPath, shim);
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }

  const result = runBin(shim, ["bogus"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown subcommand/);
});
