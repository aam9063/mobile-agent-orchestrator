# Agent hosts reference

Compatibility claims in this file are limited to what current official host documentation states. Behavior that official documentation does not confirm is marked **Unverified** and must be observed locally before being relied on. Skill locations do not imply lifecycle guarantees: session persistence and resume behavior are host-specific.

This skill is one canonical Agent Skill directory (`SKILL.md` plus on-demand references). Every host below can discover the same skill content through its own documented locations; no host-specific behavior is inferred from compatibility alone.

## Host skill locations

| Host | Project scope | User scope | Source |
| --- | --- | --- | --- |
| Pi | `.pi/skills/`; Agent Skills root `.agents/skills/` (project discovery walks ancestors up to the repository root). The `skills/` directory or `pi.skills` array in `package.json` is package discovery for `pi install`, not a general project skill root | `~/.pi/agent/skills/` (default agent directory) and `~/.agents/skills/`; additional directories via the `skills` setting in `settings.json` | Pi documentation; `pi install npm:...|git:...|./local` for package installs |
| Claude Code | `.claude/skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` | Claude Code docs, "Skills" |
| Codex CLI | `.agents/skills/` at the launch directory, parent directories, and the repository root | `$HOME/.agents/skills/` | Codex docs, "Agent Skills" |
| Gemini CLI | `.gemini/skills/` with `.agents/skills/` as an interoperable alias | `~/.gemini/skills/` with `~/.agents/skills/` as an interoperable alias | Gemini CLI docs, "Agent Skills" |
| OpenCode | `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` | `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/` | OpenCode docs, "Skills" |

All five hosts implement the open [Agent Skills specification](https://agentskills.io/specification): one directory per skill containing a `SKILL.md` with YAML frontmatter (`name`, `description` required). Within this repository, Pi package discovery stays on the `pi.skills: ./skills` manifest and must not be changed; other hosts copy or link the same `skills/mobile-agent-orchestrator/` directory into one of the documented roots above.

### Host-specific notes

- **Pi.** Project `.agents/skills/` discovery walks from the working directory through ancestors and stops at the repository root. Personal package installs are recorded in `~/.pi/agent/settings.json`; project package installs in `.pi/settings.json` after project trust. Pi session persistence is JSONL under `~/.pi/agent/sessions/`, with `--continue`, `--resume`, and `/fork`. **This JSONL resume behavior is Pi-specific and must not be generalized to any other host.**
- **Claude Code.** Project skills load from `.claude/skills/` in the launch directory and every parent up to the repository root; nested skills activate when Claude works on files in their subtree. Symlinked skill folders are read from the symlink target. Personal skills in `~/.claude/skills/` do not load in Cowork or cloud sessions. Transcript-based resume uses `claude --continue` / `claude --resume`.
- **Codex CLI.** Codex scans `.agents/skills` from the launch directory up to the repository root and reads `$HOME/.agents/skills` for user scope; it follows symlinked skill folders. Skills sharing a name are not merged; both appear in selectors. Session resume uses `codex resume`.
- **Gemini CLI.** User skills load from `~/.gemini/skills/` or the `~/.agents/skills/` alias; workspace skills from `.gemini/skills/` or the `.agents/skills/` alias. Within a tier, the `.agents/skills/` alias takes precedence. Session resume uses `gemini --resume` or the `/resume` session browser.
- **OpenCode.** Project-local paths are discovered by walking up from the working directory to the git worktree root across `.opencode/skills/`, `.claude/skills/`, and `.agents/skills/`; global paths load from the three user roots above. Session resume uses `--continue` (last session) or `--session <id>`; `--fork` branches a resumed session and must be combined with one of those (for example `--continue --fork`).

## Session persistence boundary

Session resume is a property of the invoking CLI, not of the skill. The mechanisms above (Pi JSONL, Claude Code transcripts, `codex resume`, Gemini CLI session browser, OpenCode `--continue`/`--session`) recover **agent conversation state** only.

**Herdr** is an agent-aware multiplexer: it keeps agent panes running on the host across mobile-client disconnects and network drops and tracks per-pane agent state (blocked, working, done). Like tmux, it does not preserve live processes across a physical reboot. **Agent conversation recovery after a disconnect or reboot is a separate, CLI-owned capability** and must be verified with the evidence rules in the [verification and recovery reference](verification-and-recovery.md): mark cold-boot behavior as pending whenever observed evidence is unavailable.

Whether Herdr integrates with each CLI's resume flow beyond pane survival is **Unverified**; consult current official Herdr and Moshi documentation and observe local behavior before claiming it.

## Sources (official documentation, accessed 2026-09-30)

- Pi: Agent Skills and package discovery — Pi coding agent documentation v0.99.1 (`docs/skills.md`, `docs/packages.md`); session format and resume — `docs/session-format.md`, `docs/sessions.md`.
- Claude Code: Skills — https://code.claude.com/docs/en/skills; sessions and resume — https://code.claude.com/docs/en/sessions.
- Codex: Agent Skills — https://developers.openai.com/codex/skills; CLI reference (`codex resume`) — https://developers.openai.com/codex/cli/reference.
- Gemini CLI: Agent Skills — https://geminicli.com/docs/cli/skills/; session management — https://geminicli.com/docs/cli/session-management/.
- OpenCode: Skills — https://opencode.ai/docs/skills/; CLI flags — https://opencode.ai/docs/cli/.
- Agent Skills specification — https://agentskills.io/specification.
- Moshi/Herdr integration — https://getmoshi.app/docs/herdr.

Claims not listed under an official source above remain **Unverified** and require local observation before use.
