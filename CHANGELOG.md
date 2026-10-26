# Changelog

All notable changes to this project are documented in this file.

## Unreleased

## [0.2.0] - 2026-10-21

- Document the supported Agent Skills hosts, their documented skill locations, and the session-resume boundary in an agent-hosts reference, with unverified host behavior marked as unverified.
- Add a deterministic installer for Codex, OpenCode, and Gemini CLI that writes the shared `.agents/skills` destinations, records a checksum manifest beside the skill directory, supports dry-run planning, and aborts without writing anything on modified, unmanaged, or symlinked destination content.
- Support the documented Claude Code `.claude/skills` locations as a separate installer destination with its own manifest.
- Add an interactive no-arguments install flow that detects installed coding-agent CLIs read-only, presents detection evidence and supported destinations, and asks which targets and scope to configure before writing anything.
- Add a strictly read-only `status` command that classifies each managed destination as absent, managed, outdated, modified, or unknown and reports merged scopes for destinations serving both scopes.
- Add a checksum-verified `uninstall` command that removes only manifest-recorded files whose on-disk checksums still match, keeps unmanaged files, blocks modified destinations, and pins destination and parent identity against ancestor swaps.
- Publish the package to npm with provenance from the release workflow, with a rerun guard that never overwrites a published version and fails closed on integrity differences.
- Document the trusted-publisher prerequisites for npm publication and add an issue-linked pull request template.

## [0.1.0] - 2026-09-06

- Introduce the Mobile Agent Orchestrator Pi skill for human-supervised, private mobile-agent setup on supported macOS and Windows 11 + WSL2 paths.
- Add package validation, CI, and an allowlisted npm dry-run package check for the skill and its references.
- Establish validated, merged-PR-only annotated Git tag automation; branch protection remains an external policy and direct pushes cannot create release tags.
- Publish installation, safety, recovery, contribution, and release documentation for the stable distribution path.
- License the project under MIT.
