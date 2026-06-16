# Agent Development Guide

This repository is a lightweight WOS CLI. Keep future changes small,
composable, and easy to reuse.

## Core Rules

- Bump `package.json`, `package-lock.json`, and `CHANGELOG.md` for every code
  or behavior change.
- Prefer one clear convention over compatibility layers. Do not add fallback
  layouts unless the user explicitly asks for migration support.
- Update docs in the same change as code.
- When CLI commands, stdout formats, options, audit fields, SQLite behavior, or
  examples change, update every user-facing command surface in the same change:
  `README.md`, `docs/usage.md`, `docs/commands.md`, `docs/llm.md`,
  `docs/curl.md`, `src/lib/command-docs.js`, `docs/audit-view.html` when it
  contains embedded command/help text, and `docs/command-cheatsheet.html`.
- Keep modules focused. Extract shared workflow steps instead of copying command
  branches.
- Keep file-download commands and SQLite ingest commands separate:
  - `run` and `bib` download TXT/BibTeX only
  - `query ingest` and `record ingest` write parsed WOS records into
    `wosData.sqlite`
  - audit metadata may also be written to `wosData.sqlite` by query/record/raw
    export/import summaries

## Default Storage Model

The default product model is one managed project per working directory:

```text
./.iiaide-wos-cli/
```

Store long-lived project state here:

- `project.json`
- `state.json`
- `config.json`
- `index.json`
- `latest`
- `runs/<run-id>/command.json`
- `runs/<run-id>/runtime.jsonl`
- `runs/<run-id>/summary.json`
- `audit/activity.jsonl`
- `audit/searches.jsonl`
- `audit/resultsets.jsonl`
- `audit/artifacts.jsonl`
- `resultsets/...`
- `wosData.sqlite`

Legacy multi-task mode may still be entered explicitly through `--tasks-root`
or `--out-dir`, but new default behavior and docs should target the current
directory project store.

## SQLite Rules

- Store SQLite at `./.iiaide-wos-cli/wosData.sqlite` in default mode
- Keep audit metadata and structured record storage conceptually separate even
  when both live in the same SQLite file
- Use `relevance` order and at most the first 500 records
- Normal query ingest uses `isRefQuery=false`
- Citations/references/related ingest uses `isRefQuery=true`
- Preserve per-UUID WOSID order with 1-based positions and timestamps
- `record ingest` should be idempotent for the same source WOSID and relation
  type unless `--force` is passed
- `db uuid`, `db wosid`, and `db context` are read-only and must not start WOS
- `db searches` and `db artifacts` are read-only audit lookups and must not
  start WOS
- `db runs` and `db timeline` are read-only audit lookups and must not start
  WOS
- `db audit-html` is a read-only local viewer over the same SQLite data and
  must not start WOS
- `db audit-export` is a read-only static snapshot export over the same SQLite
  data and must not start WOS

## Artifact Names

- raw full-record TXT:
  `resultsets/<uuid>/raw/full-record/<uuid>_<start>_<end>.txt`
- raw BibTeX:
  `resultsets/<uuid>/raw/bib/<uuid>_<start>_<end>.bib`
- combined BibTeX:
  `resultsets/<uuid>/exports/bib/<uuid>.bib`
- extracted WOSIDs:
  `resultsets/<uuid-or-project-id>/<uuid-or-project-id>_wosid.csv`

## WOS Session Rules

- Reuse one workspace-scoped Playwright profile at
  `<tasksRoot>/.browser-profile`
- Default non-login browser work runs headless/background
- Inject `import/wos.js` before WOS navigation
- SID initialization must start from:
  `https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=<SID>`
- If a saved SID is invalid, reopen a visible WOS window, let the user log in,
  save the detected SID, then continue with the same profile

## Export Rules

- Use the browser-side `wos.js` export API for TXT/BibTeX
- Do not depend on export overlay clicks for the main export path
- It is acceptable to read summary metadata before request-based export
- Show the resolved UUID before long export work starts
- Use existing terminal progress helpers and append runtime progress to the run
  log

## Documentation Roles

- `README.md`: install, quick start, entry points
- `docs/usage.md`: workflow and artifact layout
- `docs/commands.md`: structured command contract
- `docs/llm.md`: agent-facing recipes
- `docs/curl.md`: WOS request/init/export details
- `CHANGELOG.md`: released behavior changes

## Review Checklist

- Version and changelog updated
- Matching docs updated
- No new fallback behavior unless requested
- Artifact names match convention
- `npm run check` and `npm test` pass
