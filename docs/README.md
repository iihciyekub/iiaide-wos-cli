# Documentation Guide

This directory stays lightweight on purpose. Each file has one role.

## Document Roles

- `README.md`
  Install, quick start, command entry points, and the top-level project scope.
- `docs/usage.md`
  User-facing workflows, task lifecycle, task states, artifact layout, and
  command behavior.
- `docs/curl.md`
  Request-level WOS reference for debugging, reproducing exports, and keeping
  CLI behavior aligned with the browser-side `wos.js` methods.
- `docs/auth-must.md`
  MUST SSO SID producer design, credential boundaries, monitor behavior, and
  handoff into the global saved SID pool.
- `CHANGELOG.md`
  Versioned behavior changes.
- `AGENTS.md`
  Development rules, review checklist, and doc-sync expectations for future
  code changes.

## Update Rules

Update docs in the same change as code:

- If install, command names, or quick-start commands change, update `README.md`.
- If task flow, task outputs, prompts, progress, confirmation, or lifecycle
  behavior changes, update `docs/usage.md`.
- If SID init, summary preparation, export endpoints, payload shape, or
  browser-side WOS method usage changes, update `docs/curl.md`.
- If auth producer behavior, credential handling, monitor heartbeat, or SID pool
  handoff changes, update `docs/auth-must.md` and the authentication section in
  `docs/usage.md`.
- If behavior changes in any user-visible way, add a concise `CHANGELOG.md`
  entry and bump `package.json` and `package-lock.json`.

## Keep Or Remove

- Avoid adding a new doc unless it has a stable, distinct role.
- Remove docs that only repeat `README.md` or another doc without adding a
  separate maintenance value.
- Prefer renaming a misleading doc over keeping an ambiguous title.
