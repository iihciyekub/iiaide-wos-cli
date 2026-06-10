# Changelog

All notable changes are documented here. The version in `package.json` is the
authoritative CLI version.

## 0.3.67 - 2026-06-10

- Explain accessible GitHub repositories with no Releases separately from
  private repository authentication failures during `iiaide-wos update`.

## 0.3.66 - 2026-06-10

- Rename the package, executable, source entrypoint, help text, manifest marker,
  interactive dashboard, tests, and docs to use `iiaide-wos` consistently.

## 0.3.65 - 2026-06-10

- Let interactive download workflows use the shown saved WOS source when the
  URL/UUID prompt is submitted with Enter.

## 0.3.64 - 2026-06-10

- Stop writing derived `authors/normalized-json` files; author aggregation now
  normalizes `authors/raw-json` in memory and keeps task artifacts lighter.
- Simplify author checkpoints to store only raw JSON paths for completed
  records.

## 0.3.63 - 2026-06-10

- Clarify author download resume behavior by printing total, completed, failed,
  selected range, and concurrency before fetching.
- Show original WOS ID indexes in author progress details so resumed runs do not
  look like they restarted from record 1.
- Add a regression test proving the author worker pool honors configured
  concurrency.

## 0.3.62 - 2026-06-10

- Add an interactive author-download options prompt so users can keep defaults
  with Enter or tune concurrency, cooldown, range, and retry filters per run.

## 0.3.61 - 2026-06-10

- Reuse completed WOS ID CSV and BibTeX artifacts before SID validation so
  local completed tasks return immediately.
- Require reusable raw full-record batches to be contiguous and cover the known
  WOS record count before rebuilding derived CSV outputs.
- Treat short or empty non-final BibTeX batches as incomplete exports instead
  of writing a completed combined `.bib`.

## 0.3.60 - 2026-06-10

- Fix author pipelines after completed WOS ID CSV reuse so they use the reused
  summary CSV and UUID instead of stale task metadata.

## 0.3.59 - 2026-06-10

- Shorten completed WOS ID CSV and BibTeX reuse messages so the final artifact
  path remains the clear command result.

## 0.3.58 - 2026-06-10

- Run interactive download/export workflows directly in the current `*` task
  instead of asking for a task id again.

## 0.3.57 - 2026-06-10

- Hide invalid saved task sources such as `q` from the interactive URL/UUID
  prompt.
- Remove the per-workflow saved SID message so authentication status remains in
  the dashboard.

## 0.3.56 - 2026-06-10

- Treat empty Enter at the interactive `WOS summary URL or UUID` prompt as a
  workflow cancellation that returns to the menu.

## 0.3.55 - 2026-06-10

- Treat download confirmation declines as user cancellations without printing a
  stack trace or failure return in the interactive menu.
- Stop adding `--force` to interactive download commands by default so the
  current task is reused instead of being cleared before each download.
- Reuse completed TXT and BibTeX task artifacts for the same UUID instead of
  refetching them from WOS.

## 0.3.54 - 2026-06-10

- Vertically center the left dashboard information block within its panel.
- Rename the dashboard date constant to clarify that it is the fixed CLI
  version update date.

## 0.3.53 - 2026-06-10

- Add centered `lyj` and `2026-06-10` lines under the left dashboard title
  without restoring label-style author/date rows.

## 0.3.52 - 2026-06-10

- Remove `Author` and `Last Update` rows from the left interactive dashboard
  panel so the centered CLI title remains the main visual focus.

## 0.3.51 - 2026-06-10

- Rename the Current workspace panel field from `Current` to `Task ID`.
- Remove the redundant task-count row from the Current workspace panel.

## 0.3.50 - 2026-06-10

- Print a visible `Task selection:` hint before interactive task prompts so
  switching, creating, and keeping the current task are clear before input.

## 0.3.49 - 2026-06-10

- Make the interactive CLI task-oriented by ensuring a current task exists on
  menu startup.
- Show the current task id in the Current workspace panel and mark it in the
  task list.
- Add a Switch task workflow that can select an existing task or create a new
  current task, then immediately refreshes the panel.

## 0.3.48 - 2026-06-10

- Ask for the interactive workflow before asking for a task so clear/download
  actions can show task prompts that match the selected action.
- Keep clear-task prompts limited to existing tasks and reject out-of-range task
  numbers instead of treating them as new task ids.

## 0.3.47 - 2026-06-10

- Clarify the interactive `Task id` prompt with explicit `Enter`, `number`,
  `new`, and custom-id guidance so task switching and creation are easier to
  discover.

## 0.3.46 - 2026-06-10

- Fix interactive task selection so menu actions keep the active `--tasks-root`
  and numbered task selection applies to the current workspace.
- Add explicit `new` support in the `Task id` prompt so creating a fresh task is
  visible even when a latest task already exists.

## 0.3.45 - 2026-06-10

- Let the interactive `Task id` prompt accept an existing task number, an
  existing task id, or a new task id.

## 0.3.44 - 2026-06-10

- Simplify the documentation structure by removing the redundant demo guide and
  renaming the workflow document to `docs/usage.md`.
- Add explicit documentation sync rules to `AGENTS.md` so code and docs stay in
  the same change.

## 0.3.43 - 2026-06-10

- Exit quietly on interactive `Ctrl+C` instead of printing the readline
  `AbortError` stack in menu or prompt flows.

## 0.3.42 - 2026-06-10

- Show the WOS record count and require interactive confirmation before TXT or
  BibTeX downloads start.
- Calculate download progress in 200-record batches so one progress step matches
  one WOS export request.

## 0.3.41 - 2026-06-10

- Simplify the interactive dashboard by removing the code badge and centering
  `iiaide-wos CLI` in the left panel.

## 0.3.40 - 2026-06-10

- Refine the interactive dashboard layout with a centered code badge and
  cleaner status grouping.

## 0.3.39 - 2026-06-10

- Replace the interactive dashboard ASCII leaf with a compact code icon.

## 0.3.38 - 2026-06-10

- Add a small ASCII leaf to the interactive dashboard.
- Align the author and last-update values in the left dashboard panel.

## 0.3.37 - 2026-06-10

- Update the interactive dashboard copy to `iiaide-wos CLI`.
- Remove the workflow subtitle from the left dashboard panel.
- Add author and last-update fields and keep both dashboard panels equal height.

## 0.3.36 - 2026-06-10

- Replace the interactive dashboard `Started` timestamp with a live `Runtime`
  duration.

## 0.3.35 - 2026-06-10

- Run non-visible WOS Playwright sessions in true background headless mode.
- Show the WOS browser mode and Playwright profile name in the interactive
  dashboard.
- Expose the workspace profile name as `.browser-profile`.

## 0.3.34 - 2026-06-10

- Route full-record and BibTeX exports through the injected browser-side
  `window.wos.export.fetchTxtBatches` and `fetchBibBatches` APIs.
- Add a thin Node bridge for calling stable wos.js export methods while keeping
  task file writing, progress logging, WOSID parsing, and BibTeX combination in
  the CLI.
- Add stable options-object export methods to the local `import/wos.js`
  reference helper.

## 0.3.33 - 2026-06-10

- Simplify the interactive task hint list to a numbered table that shows only
  task IDs.

## 0.3.32 - 2026-06-10

- Add `iiaide-wos clear (--task <task-id> | --latest)` for removing a managed
  task directory and its index entry.
- Refresh or remove the workspace `latest` pointer after clearing a task.
- Add a clear-task action to the interactive menu without requiring WOS SID
  setup.

## 0.3.31 - 2026-06-10

- Inject the browser-side `import/wos.js` helper into every Playwright-backed
  WOS context so WOS pages expose `window.wos`, `window.WosUUID`, and
  `window.asy_uuid`.
- Prefer `window.asy_uuid.fetchCurrentPageInfo()` for summary UUID/count
  metadata before request-based TXT and BibTeX exports.
- Add `--wosjs` and `WOSJS_PATH` for explicit wos.js injection paths, with a
  clear failure when the helper file is missing.

## 0.3.30 - 2026-06-10

- Standardize all Playwright-backed WOS work on the same workspace profile at
  `<tasksRoot>/.browser-profile`.
- Document that login, SID validation, summary metadata reads, request-based
  exports, and author page extraction must not create isolated WOS browser
  profiles or contexts.
- Add tests to lock WOS browser work to the persistent profile helper and guard
  against reintroducing short-lived Chromium contexts.

## 0.3.29 - 2026-06-10

- Route WOS downloads and author-page work through a shared persistent
  Playwright session during interactive CLI runs.
- Use the canonical Web of Science SID initialization URL for login and
  validation, then continue with the observed WOS origin for summary/export
  pages.
- Open a visible WOS browser login window when the saved SID is invalid, save
  the detected SID, and move/reopen the browser outside the visible desktop
  area before continuing background work.
- Report the WOS record count from summary metadata before full-record and
  BibTeX downloads begin.

## 0.3.28 - 2026-06-09

- Read WOS summary record counts before BibTeX downloads, matching the older
  `wos.js` batch runner behavior.
- Use the real WOS record count to bound unbounded BibTeX downloads and compute
  accurate progress-bar totals.
- Keep BibTeX downloads request-based through `saveToBibtex` while using summary
  metadata only for UUID/count preparation.

## 0.3.27 - 2026-06-09

- Include request diagnostics in WOS export failures: endpoint URL, page URL,
  origin, parent query UUID, sort key, action, and requested range.
- Apply the diagnostics to both full-record and BibTeX request-based exports so
  URL construction issues are visible in the console error.

## 0.3.26 - 2026-06-09

- Add a first-class WOS domain variable with `--wos-domain` and `WOS_DOMAIN`.
- Derive generated WOS origins from the domain variable while keeping
  `--base-url` available for explicit full-origin overrides.
- Persist `wosDomain` alongside `baseUrl` in SID config and reuse it on later
  CLI starts.

## 0.3.25 - 2026-06-09

- Show the detected WOS origin in the interactive dashboard when the startup
  SID probe can resolve it.
- Add a startup hint to reopen WOS with the SID initialization URL when the
  origin cannot be confirmed.

## 0.3.24 - 2026-06-09

- Preserve the sort segment from pasted WOS summary URLs when rebuilding
  protocol-less inputs.
- Rebase generated summary URLs to the actual WOS origin observed during SID
  validation, while preserving user-provided absolute URLs.
- Use the final page-exposed WOS query UUID for BibTeX `parentQid` when WOS
  exposes one after opening the summary page.

## 0.3.23 - 2026-06-09

- Normalize protocol-less `--url` WOS summary inputs before Playwright
  navigation.
- Prepare a shared WOS request context for both full-record and BibTeX exports
  by validating SID with the WOS initialization URL and then opening the target
  summary URL before request-based download calls.
- Document the SID initialization plus summary-page request-context flow used by
  request-based WOS exports.

## 0.3.22 - 2026-06-09

- Explain WOS `Server.invalidState` export failures as non-record result-set
  UUIDs and guide users to copy a normal records summary URL/UUID.
- Reuse structured WOS export error parsing for full-record and BibTeX exports.

## 0.3.21 - 2026-06-09

- Add local startup time to the right side of the interactive dashboard.

## 0.3.20 - 2026-06-09

- Avoid marking startup SID checks as invalid just because a lightweight HTTP
  probe sees a generic WOS login page.
- Report ambiguous startup SID probes as unknown while keeping strict
  Playwright validation before downloads.

## 0.3.19 - 2026-06-09

- Print a startup SID check line showing whether authentication appears usable
  and the masked current SID.

## 0.3.18 - 2026-06-09

- Simplify the startup dashboard authentication rows to `Auth` and masked
  `SID Value`, while preserving right-panel height alignment.

## 0.3.17 - 2026-06-09

- Expand the right startup dashboard panel to match the left panel height.
- Show SID authentication as clearer yes/no/unknown fields with SID source and
  a masked SID value.

## 0.3.16 - 2026-06-09

- Update the startup dashboard logo to `[ W O S - C L I ]`.
- Align current-workspace fields as table-like key/value rows and remove the
  getting-started text from the right panel.

## 0.3.15 - 2026-06-09

- Print final artifact paths for artifact-producing commands instead of JSON
  summaries.
- Make `bib` print only the combined BibTeX file path after completion.

## 0.3.14 - 2026-06-09

- Show WOS BibTeX downloads with a progress bar even when the final batch count
  is not known ahead of time.
- Add dynamic progress totals so request-based batch downloads can expand the
  visible progress as new batches are requested.

## 0.3.13 - 2026-06-09

- Add a lightweight startup SID probe for the interactive CLI dashboard.
- Classify startup authentication as valid, invalid, unknown, or missing without
  opening Chromium or overwriting saved SID config.
- Keep strict Playwright SID validation before WOS download and extraction
  commands.

## 0.3.12 - 2026-06-09

- Normalize protocol-less WOS summary strings passed through `--uuid`, including
  copied `ofscience.com/wos/woscc/summary/...` inputs.
- Explicitly support WOS UUIDs with `8-4-4-4-12-10` segment structure during
  UUID extraction.

## 0.3.11 - 2026-06-09

- Add `docs/curl.md` with structured curl examples for SID initialization,
  full-record export, WOS BibTeX export, summary page inspection, author page
  access, and local-only commands.
- Link the curl reference from README and workflow documentation.

## 0.3.10 - 2026-06-09

- Keep `iiaide-wos bib` on the request-based `saveToBibtex` export path without
  reading summary-page DOM elements for record counts.
- Let BibTeX downloads continue by request batches until WOS returns an empty or
  short final batch, with `--from-index` and `--limit` supporting explicit
  ranges.
- Count BibTeX entries from API responses so raw `.bib` batch names use the
  actual returned record range.

## 0.3.9 - 2026-06-09

- Rename the interactive BibTeX workflow to `Download WOS BibTeX`.
- Show the resolved WOS UUID before SID validation and download work starts.
- Reuse a shared WOS export preparation helper for UUID announcement and SID
  preparation.
- Clarify WOS BibTeX progress and document the UUID-before-download workflow.

## 0.3.8 - 2026-06-09

- Combine BibTeX batch downloads into a final `data/<uuid>.bib` file.
- Validate BibTeX tasks by checking both raw batch files and the combined BibTeX
  deliverable.

## 0.3.7 - 2026-06-09

- Add `iiaide-wos bib` to download WOS BibTeX exports in batches.
- Save BibTeX batches as `raw/bib/<uuid>_<start>_<end>.bib`.
- Allow task validation to recognize BibTeX-only tasks.

## 0.3.6 - 2026-06-09

- Add `AGENTS.md` with lightweight development rules for modular CLI work.
- Document how to use local `import/wos.js` as reference code without copying it
  wholesale into the CLI.
- Ignore the local `import/` reference directory in git.

## 0.3.5 - 2026-06-09

- Remove legacy WOSID CSV path fallback code and require the single
  `<uuid-or-task-id>_wosid.csv` output convention.
- Keep WOSID CSV path resolution as a small deterministic helper instead of
  scanning task directories.

## 0.3.4 - 2026-06-09

- Name extracted WOSID CSV files as `<uuid>_wosid.csv`.
- Stop generating derived WOSID JSON, detailed CSV, and combined
  `full_records.txt` files during WOSID extraction.
- Parse raw full-record batch names from the trailing `<start>_<end>.txt`
  suffix so UUIDs with underscores remain safe.

## 0.3.3 - 2026-06-09

- Keep interactive menu sessions open after each selected command finishes.
- Refactor command dispatch so menu runs can reuse normal CLI commands without
  forcing process exit state between selections.

## 0.3.1 - 2026-06-07

- Make the GitHub repository and all Releases private.
- Authenticate private Release checks with `GH_TOKEN`, `GITHUB_TOKEN`, or
  credentials from `gh auth login`.
- Prevent accidental publication to the public npm Registry.

## 0.3.0 - 2026-06-07

- Rename the project to `iiaide-wos-cli` and make `iiaide-wos` the primary command.
- Remove the old command aliases and old CLI source entrypoints.
- Add a dependency-free, responsive startup dashboard inspired by modern interactive CLIs.
- Add TTY-aware spinners and progress bars for SID validation, exports, and author fetching.
- Add CSV-to-task import for existing WOS ID lists.
- Reframe documentation around WOS interaction and complete task-package delivery.
- Add a complete Chinese user demo for URL/UUID and CSV workflows.
- Remove the unused legacy `runs/` output directory convention.
- Add `init` and `workspace` commands for explicit cwd-scoped Task workspaces.
- Prevent invalid imports from leaving an empty Task workspace behind.
- Redact SID values from manifests and restrict `--force` cleanup to managed Task directories.
- Store new author checkpoint artifact paths relative to the Task for portability.
- Allow completed author Tasks to finish locally without launching Chromium or requiring a SID.
- Prompt securely for missing SIDs and allow expired SIDs to be replaced and revalidated immediately.
- Add `iiaide-wos update` and `iiaide-wos update --check` using stable GitHub Releases.
- Verify the test suite on Windows, macOS, and Linux.
- Allow npm packaging and document GitHub checkout installation.

## 0.2.0 - 2026-06-07

- Reject unsafe task IDs and malformed CLI option values.
- Make JSON and aggregate output writes atomic and report corrupt JSON files.
- Keep validation read-only and store new task paths relative to `tasks/`.
- Filter reused raw batches by UUID and reject overlapping batches.
- Preserve expected counts while rebuilding from raw files.
- Record failed run states and support `WOS_SID`.
- Add automated tests, CI, Node.js version metadata, and `--version`.
