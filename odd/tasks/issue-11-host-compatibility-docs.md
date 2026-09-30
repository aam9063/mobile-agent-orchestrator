# Issue #11 — Document supported Agent Skills hosts and installation paths

Upstream issue: https://github.com/egdev6/mobile-agent-orchestrator/issues/11
Branch: `docs/issue-11-host-compatibility` (from `main` @ f708931)
Status: in progress

## Outcome

Document the supported Agent Skills hosts (Pi, Claude Code, Codex, OpenCode,
Gemini CLI), their officially documented skill locations, and their
host-specific session recovery boundaries, citing current official
documentation.

## Tasks

- [x] Research official host documentation (skill locations, resume behavior) with citations
- [x] Create `skills/mobile-agent-orchestrator/references/agent-hosts.md`
- [x] Link the reference from canonical `SKILL.md` and `README.md`
- [x] Keep Pi JSONL resume behavior explicitly Pi-specific; mark unverified behavior as unverified
- [x] Distinguish Herdr process persistence from agent conversation recovery
- [x] `npm test` and `npm run pack:check` pass
- [x] Work-unit commit(s) recorded below

## Evidence

Verification environment: Windows 11 + Git Bash, Node v24.18.0 (CI verifies on Linux/Node 22).

- `npm pack --dry-run --json` (`npm run pack:check`): exit 0; tarball contains exactly the 8 expected entries including `skills/mobile-agent-orchestrator/references/agent-hosts.md`.
- `node scripts/validate-package.mjs`: every check passes except the tarball comparison, which reports `spawnSync npm ENOENT` — a pre-existing Windows-only limitation (`spawnSync("npm")` cannot resolve `npm.cmd` without `shell: true`; Node blocks `.cmd` without it). The same run proves all accumulated checks passed: package.json metadata, `pi.skills`, SKILL.md frontmatter/sections, and all local Markdown links (failures are collected and reported together).
- `node --test`: 13/13 pure-logic tests pass. The 2 failing tests both spawn the detector via `detector.pathname`, which on Windows yields `/C:/...` and Node resolves it as `C:\C:\...` (pre-existing; fix would be `fileURLToPath`). The CLI itself was verified manually with identical expected results:
  - `node scripts/detect-release.mjs 0.1.0 0.1.0` → `should_tag=false`, exit 0
  - `node scripts/detect-release.mjs 0.1.0 0.2.0` → `should_tag=true\nversion=0.2.0`, exit 0
  - `node scripts/detect-release.mjs 0.2.0 0.1.0` → `Invalid release transition: Release version must strictly increase SemVer precedence`, exit 1
- Both Windows-only failures reproduce on unmodified `main` and are unrelated to this documentation change; candidates for a separate upstream issue.

## Commits

- `82f9136` docs(hosts): document supported Agent Skills hosts and skill locations (branch `docs/issue-11-host-compatibility`)
- Review round 1 (maintainer): corrected Pi skill roots (`.pi/skills/` project, `~/.pi/agent/skills/` user per Pi v0.99.1 `docs/configuration.md`; `skills/`/`pi.skills` clarified as package discovery) and OpenCode `--fork` presented as a modifier of `--continue`/`--session` → `a8caff3`
