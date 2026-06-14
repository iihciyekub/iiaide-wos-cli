# Agent Development Guide

This repository is a lightweight WOS CLI. Keep future changes small, composable,
and easy to reuse from other commands.

## Core Principles

- Bump `package.json`, `package-lock.json`, and `CHANGELOG.md` for every code or
  behavior change.
- Version patch numbers may run through `.100`; when the next bump would exceed
  100, increment the minor version and reset patch to 0, for example
  `0.3.100` -> `0.4.0`.
- Prefer one clear output convention over compatibility layers. Do not add
  fallback file names or directory scans unless the user explicitly asks for
  migration support.
- Keep documentation lightweight and role-based:
  - `README.md`: install, quick start, and command entry points.
  - `docs/usage.md`: user workflows, task lifecycle, and artifact layout.
  - `docs/curl.md`: request-level WOS method reference for debugging and implementation parity.
  - `CHANGELOG.md`: released behavior changes.
- When code changes user-visible behavior, task artifacts, WOS request shape, or
  command flow, update the matching docs in the same change. Do not leave doc
  sync as a follow-up task.
- Keep modules small. A function should do one job: discover UUID, navigate,
  export batches, parse WOS IDs, write artifacts, fetch authors, or validate.
- Reuse workflow steps by composition, not by copying command branches. For
  example, an authors pipeline should compose UUID discovery, page navigation,
  record export, WOSID CSV generation, and author fetching.
- Keep generated task artifacts minimal. Do not create extra JSON, detailed CSV,
  or combined text outputs unless they are the requested deliverable.
- Use deterministic names for artifacts:
  - raw full-record batches: `<uuid>_<start>_<end>.txt`
  - raw BibTeX batches: `<uuid>_<start>_<end>.bib`
  - combined BibTeX deliverable: `<uuid>.bib`
  - extracted WOS IDs: `<uuid-or-task-id>_wosid.csv`
- Avoid hidden global state in CLI code. Pass `args`, `paths`, and explicit
  context objects through functions.
- After parsing a WOS URL or source string, show the resolved UUID before SID
  validation or downloading. Reuse the shared UUID announcement/export
  preparation helper instead of adding per-command print logic.
- Long-running downloads should use the existing terminal progress helpers and
  append progress events to the task log.
- User-facing terminal progress labels should be English-only. For large TXT
  export windows, use clear sort labels such as `A-Z TXT` and `Z-A TXT`, not
  localized labels.
- Resume progress should display the original batch ordinal within the planned
  window. For example, if batches 1-160 already exist, the resumed download
  should continue at 161/400, not renumber the remaining work as 1/N.
- WOS operations should run through the same workspace-scoped persistent
  Playwright profile at `<tasksRoot>/.browser-profile`. Use the shared session
  preparation helper; do not launch short-lived per-command browsers, isolated
  browser contexts, or alternate profiles for WOS downloads, login, validation,
  or author page work.
- Non-login WOS Playwright sessions should run in background headless mode by
  default. Only explicit login flows or `--headed` should open a visible browser
  window.
- Every Playwright-backed WOS context should inject the browser-side wos.js
  helper before WOS navigation. The default source is `import/wos.js`; allow
  explicit override via `--wosjs` or `WOSJS_PATH`, and fail clearly if the file
  is missing instead of silently running without `window.wos`.
- WOS SID initialization must use
  `https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=<SID>`. Domain
  configuration may shape generated summary URLs, but SID login/validation
  starts from this canonical WOS entry URL.
- If a saved SID is invalid, open a visible Playwright WOS window and let the
  user log in there. After detecting `window.sessionData.BasicProperties.SID`,
  save the SID and reopen the same profile in background headless mode before
  continuing work.
- Full-record and BibTeX downloads should call the browser-side wos.js export
  API (`window.wos.export.fetchTxtBatches` and `fetchBibBatches`). The wos.js
  helper owns WOS request details such as `saveToFieldTagged` and
  `saveToBibtex`; CLI code owns progress display, task logging, deterministic
  file names, parsing, and final artifact composition.
- Do not depend on summary-page DOM elements, export overlay buttons, or
  frontend click flows for the main export path.
- It is acceptable to read summary metadata such as page-exposed query UUID and
  record count before a request-based export, because those values only prepare
  `parentQid`, range bounds, and progress totals.
- Prefer standard Node APIs and existing helpers in `src/lib/` before adding new
  dependencies.
- Tests should cover the contract of each reusable step and the command workflow
  that composes it.

## Suggested Module Shape

Keep `src/iiaide-wos.js` as the command orchestration layer. When logic grows,
extract it into focused modules under `src/lib/`.

- `src/lib/wos-session.js`: SID detection, validation, browser login helpers.
- `src/lib/wos-navigation.js`: WOS URL construction, UUID extraction, page route helpers.
- `src/lib/wos-export.js`: browser-side wos.js export bridge, batch naming, raw batch parsing.
- `src/lib/wos-artifacts.js`: task paths, CSV names, manifest and summary writes.
- `src/lib/wos-authors.js`: author page extraction, checkpoints, aggregates.

Do not create a module only because a file is long. Extract when two commands
need the same step, or when a step has its own tests and failure modes.

## Reference Import Code

`import/wos.js` is local reference code from an older browser-injected WOS tool.
The `import/` directory is ignored by git on purpose.

Use it as a source of implementation ideas for future CLI features, especially:

- `WebFuncs`: popup handling, auto-scroll, browser-side download utilities.
- `WebWait`: polling and wait helpers.
- `WosInfo`: WOS session information such as SID.
- `WosGoto`: WOS route and page navigation ideas.
- `WosIdStore`: current WOS ID state and related page flows.
- `WosUuidStore`: current page UUID detection and result-set metadata.
- `WosJcr` and `WosQuery`: later reference for JCR/query workflows.

When borrowing from `import/wos.js`, do not paste the whole class into the CLI.
Extract the smallest behavior needed, adapt it to Playwright/Node, add a focused
test, and place it in the appropriate `src/lib/` module.

## Workflow Design

Build workflows as a sequence of reusable steps:

1. Resolve task paths and artifact names.
2. Resolve or validate WOS SID.
3. Discover or normalize UUID and rebuild protocol-less WOS summary strings into
   canonical summary URLs while preserving the pasted sort segment.
4. Show the resolved UUID to the user before network export work starts.
5. Prepare the WOS request context: open
   `https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=<sid>`, use the
   observed WOS origin for generated URLs, then open the target summary URL.
6. Call the WOS export endpoint from that initialized same-origin page context.
7. Write raw batches with deterministic names.
8. Parse `UT` fields into WOS IDs.
9. Write the single WOSID CSV.
10. Compose optional downstream work such as author extraction.

Each step should return plain data, not print directly unless it is explicitly a
CLI presentation function. Long-running steps may emit progress through the
existing terminal helpers.

## Review Checklist

- Version and changelog updated.
- Matching docs updated for any changed behavior:
  - `README.md` for install, quick start, or command surface changes.
  - `docs/usage.md` for workflow, task, or output changes.
  - `docs/curl.md` for WOS request/init/export method changes.
- No new compatibility fallback unless requested.
- No broad rewrite or unrelated cleanup.
- Reusable logic is factored into a named helper or module.
- Artifact names match the current convention.
- `npm run check` and `npm test` pass.
