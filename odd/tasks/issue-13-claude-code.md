# Issue #13 — Claude Code installer target

Upstream issue: https://github.com/egdev6/mobile-agent-orchestrator/issues/13
Branch: `feat/issue-13-claude-code-target` (from `main` @ fe19cb1, which includes e15dc4e "fix(installer): make managed installs and upgrades safe")
Status: in progress — implementation not committed until user review

## Outcome

`--target claude-code` installs the canonical skill into the documented Claude Code
skill locations (`~/.claude/skills` user scope, `<cwd>/.claude/skills` project scope)
through the existing managed-copy engine, without duplicating the installer
implementation: `lib/installer.mjs` and `bin/mobile-agent-orchestrator.mjs` receive
zero changes.

## Design decisions (issue text + verified documentation)

| Decision | Value | Justification |
| --- | --- | --- |
| Target name | `claude-code` | Upstream issue #13 names the target `claude-code` |
| Destinations | user `~/.claude/skills`; project `<cwd>/.claude/skills` | `skills/mobile-agent-orchestrator/references/agent-hosts.md`, Claude Code row (Claude Code docs, "Skills", https://code.claude.com/docs/en/skills) |
| Isolation | Per-target directory registry in `lib/hosts.mjs` (`targetLocations`) replaces the hardcoded `.agents/skills` segments; `targets` export becomes `Object.keys(targetLocations)` (codex, opencode, gemini, claude-code) | Hosts registry owns location knowledge; the installer stays location-agnostic |
| Non-duplication | Zero changes to `lib/installer.mjs` and `bin/mobile-agent-orchestrator.mjs` | The managed-copy engine (plan/execute, manifest, conflict abort, atomic writes) is reused as-is; only destination resolution changes |
| Dedup semantics | `resolveUniqueDestinations` unchanged: destinations are deduplicated by resolved path, so codex/opencode/gemini still collapse to one `.agents/skills` entry, and claude-code yields a distinct second `.claude/skills` entry with its own manifest | Existing Map-on-destination logic already handles mixed selections |
| `--scope` | Still required, no default; scopes unchanged (`user`, `project`) | Issue #12 decision preserved; no new scope semantics introduced |

## Tasks

- [x] `lib/hosts.mjs` — per-target `targetLocations` registry; `targets` derived from it; `resolveDestination` spreads the target's segments; comment references `references/agent-hosts.md`
- [x] `tests/installer.test.mjs` — three-target test selects `[codex, opencode, gemini]` explicitly; mixed-selection test (4 targets → 2 destinations, 2 manifests, dry-run zero writes); claude-code behavior-parity tests (path.join semantics both scopes, clean install, manifest beside skill dir, up-to-date no-op, modified-file abort, dry-run zero writes)
- [x] `README.md` — Installer section documents `claude-code` and the separate `.claude/skills` destination; example command extended with `--target claude-code`
- [x] `odd/tasks/issue-13-claude-code.md` — this document
- [x] `lib/installer.mjs` and `bin/mobile-agent-orchestrator.mjs` — untouched (verified with `git diff --stat`)
- [x] Work-unit commit(s) recorded by the parent after user review

## Commits

- `077a133` feat(installer): add claude-code target to the skill installer (branch `feat/issue-13-claude-code-target`)

## Evidence

- `node --test tests/installer.test.mjs` — 32 tests, 27 pass, 0 fail, 5 skips (4 pre-existing Windows symlink skips + 1 Linux-only manifest-write-failure test). New coverage: mixed selection (2 destinations, 2 manifests, dry-run writes nothing), claude-code clean install, manifest with installerVersion + sha256 beside the `.claude/skills` dir, up-to-date no-op, modified-file abort with zero writes, dry-run zero writes, path.join destinations for both scopes.
- RED (verified in a throwaway temp copy of the repo with the pre-issue `hosts.mjs` restored): exactly the 7 new/extended tests fail (mixed selection, 5 claude-code tests, path.join destinations test); all pre-existing tests still pass. GREEN in the repo after the registry change: 0 failures.
- `node --test tests/installer-cli.test.mjs` — 3/3 pass (CLI untouched).
- `node --test` — 2 pre-existing Windows detect-release spawn failures only; no other failures.
- `node scripts/validate-package.mjs` — fails only at the pre-existing Windows `spawnSync npm ENOENT` npm-pack step.
- `npm run pack:check` — exit 0; tarball inventory unchanged (no new shipped files).
- Issue verification commands: `install --target claude-code --scope user --dry-run` (exit 0, plan destination under the real home, nothing written — `~/.claude/skills` untouched) and `install --target claude-code --scope project --dry-run` run from a temp cwd (exit 0, plan destination under the temp cwd, nothing written).
