# Issue #18 — Prepare and verify the stable `v0.2.0` release

Issue: egdev6/mobile-agent-orchestrator#18 "Prepare the v0.2.0 multi-CLI installer release" (status:approved; all blockers #7, #9, #10, #11-#17 merged).
Branch: `chore/release-v0.2.0` (release-type branch).
Nature: release-only work unit. No new installer/skill behavior, no new hosts, no unrelated refactors.

## Specs (issue verbatim)

- S1: "`package.json` and `SKILL.md` declare the same `0.2.0` version."
- S2: "`CHANGELOG.md` contains a complete `0.2.0` release entry."
- S3: "README installation examples use the final published package name and version."
- S4: "`npm test` succeeds."
- S5: "`npm run pack:check` succeeds."
- S6: "`npm publish --dry-run` succeeds."
- S7: "A clean local Pi installation loads the skill."
- S8: "Temporary user-scope installations are verified for `.agents/skills` and `.claude/skills` targets."
- S9: "Status and uninstall checks pass against those temporary installations."
- S10: "After merge, the workflow creates the annotated `v0.2.0` tag and publishes npm version `0.2.0` from the same revision."
- Non-goals: "New features. New supported hosts. Refactoring unrelated code or documentation."

## Design decisions

1. Version bump `0.1.0` → `0.2.0` in `package.json` AND `skills/mobile-agent-orchestrator/SKILL.md` `metadata.version` (the validator enforces equality).
2. CHANGELOG `## [0.2.0]` entry with a complete, accurate summary of everything merged since `v0.1.0` (PRs #23-#31): host compatibility reference (#11), multi-CLI installer with checksummed manifests (#12), Claude Code target (#13), interactive no-args install (#14), read-only `status` (#15), checksum-verified `uninstall` (#16), npm publication with provenance (#17). Date: left as the merge date TBD (fill `YYYY-MM-DD` at PR time).
3. README version-bearing spots to update (mapped): badge (line ~16), status note (line ~22 → "stable v0.2.0. Published to npm with provenance" — now true at merge time), install section (npm becomes the recommended channel: `pi install npm:mobile-agent-orchestrator`; Git section becomes the alternative at `@v0.2.0`), operational-evidence caveat (line ~240: keep truthful — no new operational evidence is claimed for 0.2.0). The validator enforces: CHANGELOG heading equality, no draft marker, no `vX.Y.Z`/`<owner>`/`<tag>` placeholders.
4. SKILL.md changes are metadata-only (version field); no prose changes (non-goal).
5. Verification battery (parent-run): `npm test`, `pack:check`, `npm publish --dry-run` (must show 0.2.0), temporary user-scope installs via the CLI into temp homes for `.agents/skills` and `.claude/skills`, `status` + `uninstall` checks against them, and a clean Pi installation load test from the local checkout (S7) — executed without touching the user's real Pi config (isolated config dir if Pi supports one; otherwise ask).
6. Post-merge verification (S10) via public API: tag `v0.2.0` exists and peels to the merge SHA; `npm view mobile-agent-orchestrator@0.2.0 dist.integrity` matches the merged revision's pack integrity.

## Tasks

- [x] T1: release edits (package.json, SKILL.md, CHANGELOG.md, README.md) — writer; validator green except known Windows npm-ENOENT.
- [x] T2: parent verification battery (S4-S9) incl. temporary installs and Pi load test.
- [x] T3: commits approved by the user, pushed as 32dc408; PR body delivered and opened by the user.
- [ ] T4 (post-merge): verify tag + npm publication from the same revision (S10).


## Evidence log

(filled per task)

### T2 verification battery (parent-run, Windows host)

- S4: `node --test` full: 154 tests, 141 pass, 2 fail (pre-existing Windows detect-release), 11 skips. Note: `npm test` itself cannot complete on this host (pre-existing `spawnSync npm ENOENT` in the validator's tarball check, base-confirmed); on POSIX CI it runs fully.
- S5: `npm run pack:check`: exit 0.
- S6: `npm publish --dry-run`: exit 0, `version: 0.2.0`, 13 canonical files, public access.
- S8 (temporary user-scope installs, injected temp home/cwd via the exported `run()`): `install --target codex --scope user` → `.agents/skills/mobile-agent-orchestrator/` + manifest created, exit 0; `install --target claude-code --scope user` → `.claude/skills/...` created, exit 0.
- S9: `status` against the temp home → 2 `managed` (user-scope shared + claude) and 2 `absent` (project scope), exit 0; `uninstall --target codex` and `--target claude-code` → exit 0; final `status` → all 4 destinations `absent`. Installed `SKILL.md` content verified (canonical frontmatter `name: mobile-agent-orchestrator`).
- S7 (Pi load test) — VERIFIED by the user in their real Pi environment: `pi install <repo>` → headless probe `pi -p --no-session "Is a skill named 'mobile-agent-orchestrator' available?"` → **"Yes."** with the full trigger line quoted ("Trigger: mobile agent setup, mobile orchestrator, Moshi, Mosh, Tailscale, remote mobile agent…") and the skill location pointing at the repo's `SKILL.md` → `pi remove` restores the environment. Method findings documented: `-p` mode does not inject the `<available_skills>` block with `--no-tools` (probe must run with tools enabled), `--skill <path>` does not inject in `-p` mode on this Pi build, and isolated `PI_CODING_AGENT_DIR` installs lack credentials for model calls (auth is per-agent-dir).
