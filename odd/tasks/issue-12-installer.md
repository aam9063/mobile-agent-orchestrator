# Issue #12 — Deterministic installer for `.agents/skills` hosts

Upstream issue: https://github.com/egdev6/mobile-agent-orchestrator/issues/12
Branch: `feat/issue-12-agents-skills-installer` (from `main` @ 9183524)
Status: in progress — implementation not committed until user review

## Outcome

Deterministic installer that copies the canonical skill into the shared
`.agents/skills` locations used by Codex, OpenCode, and Gemini CLI, with a
managed-file safety model (dry-run, checksums, idempotency, no silent
overwrite).

## Design decisions (issue text + explicit user decisions)

| Decision | Value | Justification |
| --- | --- | --- |
| Targets | `codex`, `opencode`, `gemini` | Issue scope |
| Destinations | user `~/.agents/skills`; project `<cwd>/.agents/skills` | Issue: "resolves the documented `.agents/skills` destination"; user chose cwd for project scope |
| `--scope` | Required, no default | Issue defines `--scope user|project`; no default documented, none invented |
| Multi-target | Repeated `--target <name>` | User decision |
| Dedup | Unique destinations across selected targets → one copy, one manifest | Issue acceptance criterion |
| Manifest | `.mobile-agent-orchestrator.manifest.json` beside the skill dir: installer version + sha256 per managed file | User asked for recommendation; keeps managed tree identical to canonical |
| Conflict policy | Abort entire install, list conflicts, write nothing | User decision; satisfies "never overwritten silently"; no `--force` (not in issue) |
| Dry-run | Exact plan, zero writes | Issue acceptance criterion |
| Idempotency | Identical content + valid manifest → no-op | Issue acceptance criterion |
| Non-goals respected | No Claude Code target, no interactive detection, no status/uninstall, no runtime tooling install, no npm publish | Issue non-goals |

## Tasks

- [x] `bin/mobile-agent-orchestrator.mjs` — `install` subcommand, `--target` repeatable, `--scope user|project`, `--dry-run`
- [x] `lib/hosts.mjs` — target registry + destination resolution
- [x] `lib/installer.mjs` — pure planning/copy engine: discovery, checksums, manifest, conflict abort, idempotent no-op
- [x] `tests/installer.test.mjs` — isolated tests with temp dirs (never real home/repo): clean install, manifest content, idempotency, modified/unmanaged abort, dry-run no-write, dedup, invalid input
- [x] `package.json` — `bin` entry; `files` extended to `bin/`, `lib/` (`pi.skills` untouched)
- [x] `scripts/validate-package.mjs` — allowlist + inventory extended for `bin/`, `lib/`
- [x] `README.md` — document the install command
- [x] Verification: `npm test`, `npm run pack:check`, three `--dry-run` commands from the issue
- [ ] Work-unit commit(s) recorded below

## Evidence

- `node --test tests/installer.test.mjs` — 10/10 pass (temp-dir isolated: clean install, manifest beside dir with
  version + per-file sha256, up-to-date no-op, modified abort, unmanaged abort, dry-run zero writes, 3-target dedup
  to one destination/one manifest, invalid target/scope errors, path.join destinations, version-update replace).
- `npm run pack:check` — exit 0; tarball inventory: `bin/mobile-agent-orchestrator.mjs`, `lib/hosts.mjs`,
  `lib/installer.mjs`, 5 skill files, LICENSE, README.md, package.json.
- `node scripts/validate-package.mjs` — fails only at the pre-existing Windows `spawnSync npm ENOENT` npm-pack step;
  all other validator checks (package.json files check with the new `bin/`+`lib/` allowlist, SKILL.md checks, link
  checks, inventory discovery) ran and reported no errors.
- Three issue `--dry-run` commands (project scope, user scope, single target) — exit 0, full plan printed, no
  `.agents` directory created in repo cwd and no `mobile-agent-orchestrator` entry or manifest written to the real
  user home.
- CLI validation errors (`bogus` subcommand, `--target claude`, missing `--scope`) — usage/diagnostic on stderr,
  exit 1; `--help` on stdout, exit 0.
- `node --test` (full suite) — 25 tests, 23 pass, 2 fail: only the 2 pre-existing Windows spawn failures in the
  detect-release tests (`spawnSync node` path duplication); no other failures.
- `tests/validate-package.test.mjs` — updated under authorized scope expansion: the exact-allowlist assertion now
  matches the issue-mandated `publishedTopLevelPaths` extension
  (`["LICENSE", "README.md", "package.json", "skills/", "bin/", "lib/"]`), and the "expands recursively allowlisted
  non-skill directories" test no longer re-pushes `"bin/"` onto the shared export (it is already in the export, so
  the push duplicated it). No other assertion in that file was weakened or removed. Flagged for parent/user review.
- Code review round (user-approved findings, applied exactly): **A1** symlinks in the managed tree are never
  followed — `listFiles` does not recurse into symlinked directories and reports them as unmanaged;
  `classifyFile` uses `lstatSync`, so a symlink at a managed path conflicts as `path (unmanaged)` without reads or
  writes through it; **A2** a destination skill path that exists but is not a directory produces a clean
  `not a managed directory` conflict instead of ENOTDIR; **A3** bin wraps `buildPlan`/`executePlan` in try/catch —
  execute failures report "failed partway through / may be inconsistent / re-running repairs it"; **A4** a corrupt
  manifest fails closed (abort, zero writes) while `readManifestFile`'s null-return behavior is unchanged;
  **B1** `discoverPackageFiles` walks skillRoot recursively, sorted, forward-slash paths (matches validator/npm
  pack semantics, no `.md` filter); **B2** removed the provably unreachable unmanaged-skip condition;
  **B3** repeated `--target` values dedupe preserving first-seen order; **B4** `--scope` missing a value errors
  symmetrically and the parser no longer mutates the loop index inside subscripts; **B5** removed vestigial
  originalPaths/try/finally scaffolding from the validator test; **B6** replaced triple-nested ternaries with
  `classifyFile`, `resolveDestinationStatus`, and `resolvePlanStatus` helpers. Rejected findings: TOCTOU
  re-verification (check-then-use races accepted for a local CLI; re-lstat would not close them), cross-destination
  conflict test (unreachable — the single-scope CLI yields one deduped destination), case-insensitive target dedup
  (targets are validated as exact lowercase names first), dry-run path suppression (printing exact absolute paths
  is the documented dry-run contract).
- Post-review verification: `node --test tests/installer.test.mjs` — 15 tests, 14 pass, 1 skip (symlink test skips
  via `t.skip("symlinks unavailable on this platform")` after `symlinkSync` EPERM on Windows; Linux CI keeps T3
  coverage; EPERM confirmed as a privilege limitation, not a logic failure). `node --test` — 30 tests, 27 pass,
  1 skip, 2 fail (only the 2 pre-existing Windows detect-release spawn failures).

## PR #26 review fixes (branch `fix/pr-26-installer-review`, HEAD 2d85073)

Human authorization: keep all four fixes together in one PR (`allow-four-fix-diff`) with every regression test preserved; estimated diff admitted at ~460 lines. Only the four review findings are in scope; no other P3 work.

| Finding | Fix | Regression coverage |
| --- | --- | --- |
| P1 `bin` guard fails under the npm `.bin` symlink (silent exit 0) | `isDirectExecution()` compares `realpathSync(process.argv[1])` with `realpathSync(fileURLToPath(import.meta.url))` | `tests/installer-cli.test.mjs`: direct `--help`, symlink `--help`, symlink `bogus` exit 1 |
| P1 manifest symlink/non-regular followed by `existsSync`/read/write | new `inspectManifestPath` uses `lstat` and rejects valid symlink, dangling symlink, and non-regular manifest before any write | valid symlink (external JSON byte-for-byte intact), dangling symlink (target never created), directory manifest |
| P2 upgrade left stale managed files as `unmanaged` conflicts | inventoried paths under `skillDirectory` whose checksum matches the previous manifest become an explicit `remove` action; modified/unmanaged/symlink abort; dry-run reports removals without writing | remove, rename, modified abort, symlink abort, unmanaged abort, dry-run removal, second-install idempotency |
| P2 manifest write truncated the previous manifest on partial failure | exclusive sibling temp file + `renameSync` with cleanup on failure; managed copies use the same temp+rename path | Linux `trap '' XFSZ; ulimit -f 0` version-only update: old manifest byte-identical and valid, temp file cleaned, retry installs then no-ops |

Decisions:

- Removals reconcile only paths from the real inventory under `skillDirectory`, never arbitrary manifest entries, so a crafted `../evil` manifest record cannot drive deletion outside the skill directory.
- A case-only rename must still work on a case-sensitive filesystem, so alias detection compares physical identity (`lstatSync(path, { bigint: true })` `dev:ino`), never a `toLowerCase` string compare and never an OS `realpath` string. On a case-insensitive filesystem the former and canonical spellings share one inode and the install aborts with `aliases managed file <path>` instead of deleting the file the canonical path keeps; on a case-sensitive filesystem the inodes differ, so the rename reconciles as create + remove. When the filesystem exposes no inode (`ino === 0`), identity is unknown and the stale path falls back to the conservative `unmanaged` conflict rather than being deleted.
- Managed copies are published through temp+rename because an interrupted install must not leave a partially overwritten managed file that a later run cannot repair. Copies use an exclusive (`COPYFILE_EXCL`) sibling temp, and an `EEXIST` collision never deletes a temp the process did not create. A stale path that is a hardlink to a canonical file is caught by the same `dev:ino` check (alias conflict, not a removal); FIFOs and other non-regular entries remain unmanaged and are never removed.
- The parent will land this branch with the commit message `fix(installer): make managed installs and upgrades safe`; this task records the plan and does not commit.
- `scripts/validate-package.mjs` keeps its own `resolve(process.argv[1])` symlink guard unchanged (outside the authorized edit surfaces).

RED before the source fixes: `tests/installer-cli.test.mjs` 2/3 fail (symlink `--help` printed nothing, symlink `bogus` exited 0); `tests/installer.test.mjs` 25 tests / 17 pass / 8 fail, including `installed` instead of `aborted` on the dangling manifest (external target created) and the manifest truncated to `""` under `ulimit -f 0`. The case-alias regression was recorded separately as `installed` vs `aborted` before the identity guard.

GREEN after the fixes: `node --test tests/installer.test.mjs` 26/26 pass; `node --test tests/installer-cli.test.mjs` 3/3 pass; `npm test` 44/44 pass, 0 fail, 0 skip; `npm run pack:check` exit 0 with the unchanged tarball allowlist.

Interrupted-refactor repair: a cancelled worker left `realPathOrNull` referenced but undefined, `physicalIdentity` unused, and `realpathSync` imported unused. Replacing the realpath-string alias guard with the `dev:ino` `physicalIdentity` check reproduced RED as `tests/installer.test.mjs` 26 tests / 2 pass / 24 fail (`ReferenceError: realPathOrNull is not defined` at `lib/installer.mjs:225`) and GREEN as 26/26 pass with `tests/installer-cli.test.mjs` 3/3 pass.

Residual risk: only the case-sensitive branch of the case-only rename test executes on this Linux host; the case-insensitive branch is guarded by `existsSync(upperPath)` and is not executed here. `dev:ino` identity is the implemented guard; on filesystems that expose no inode the fallback is conservative (stale removals abort as `unmanaged` conflicts instead of deleting an ambiguous file).

## Commits

- `27dd9b0` feat(installer): add deterministic .agents/skills installer (branch `feat/issue-12-agents-skills-installer`)
