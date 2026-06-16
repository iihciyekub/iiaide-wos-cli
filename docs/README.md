# Documentation Guide

This docs set assumes the default single-project model:

```text
<project>/.iiaide-wos-cli/
```

## File Roles

- `README.md`
  Install, quick start, project model, and command entry points
- `docs/usage.md`
  Workflow, artifact layout, and project lifecycle
- `docs/commands.md`
  Structured command contract
- `docs/command-cheatsheet.html`
  Static categorized command page with copy buttons
- `docs/audit-view.html`
  Local audit viewer template served by `db audit-html` and reused by static
  audit export output, using the same light audit workspace style and command
  manual layout
- `docs/llm.md`
  Agent-facing calling rules and recipes
- `docs/curl.md`
  WOS request/init/export parity notes
- `docs/auth-must.md`
  MUST auth producer notes
- `CHANGELOG.md`
  Released behavior changes
- `AGENTS.md`
  Repository development rules

## Sync Rules

- If command shape or default storage changes, update `README.md`,
  `docs/usage.md`, `docs/commands.md`, and `docs/llm.md`
- If WOS session/bootstrap/export behavior changes, update `docs/curl.md`
- If menu behavior changes, update `README.md`, `docs/usage.md`, and
  `docs/command-cheatsheet.html`
- Every behavior change must also bump version and changelog
