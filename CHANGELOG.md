# Changelog

All notable changes are documented here. The version in `package.json` is the
authoritative CLI version.

## 0.4.54 - 2026-06-11

- Change long-running parse defaults to restart Playwright every 100 WOSIDs
  instead of keeping one browser session forever.
- Add `--max-rss-mb <n>` so parse can reconnect the current SID between chunks
  once process RSS reaches a configured memory cap. The default cap is 2048 MB;
  use `0` to disable memory-based restarts.
- Split parse work into smaller memory-check chunks while keeping reusable pages
  within each chunk, so long runs can recycle Chromium before renderer memory
  grows too far.

## 0.4.53 - 2026-06-11

- Release reusable WOS pages to `about:blank` before closing the persistent
  Playwright context during SID refresh, parse recovery reconnect, and explicit
  browser restart paths, so long-running Chromium renderer memory is less
  likely to accumulate across repeated sessions.

## 0.4.52 - 2026-06-11

- Add `iiaide-wos sid-pool` to print the current global saved SID pool as JSON,
  including the active SID, pool position, and full saved SID list.

## 0.4.51 - 2026-06-11

- Change interactive SID recovery so missing or invalid saved SIDs offer a
  choice between manual SID input and browser-login auto-detection, instead of
  forcing the visible browser login flow immediately.

## 0.4.50 - 2026-06-11

- Extend the WOS popup guard to recognize OneTrust `Privacy` dialog containers
  directly, then prefer `Accept all` and fall back to the dialog's close button
  when that banner variant does not expose an accept action.

## 0.4.49 - 2026-06-11

- Add a Playwright-side WOS popup guard that auto-handles common Clarivate
  privacy and cookie dialogs, including the OneTrust `Accept all` button.
- Re-arm popup dismissal after WOS login, SID validation, summary navigation,
  and reusable parse-page startup so first-load dialogs are less likely to
  block browser-driven flows.

## 0.4.48 - 2026-06-11

- Prevent parse SID recovery from re-saving a just-invalidated SID from the
  persistent WOS browser profile after the saved SID pool is emptied.
- Remove the active SID from the saved pool during recovery even when that SID
  was originally detected from the browser profile rather than loaded directly
  from config.
- Show the active SID and pool position in WOS authentication success output,
  and print parse recovery decisions as short multi-line notices.

## 0.4.47 - 2026-06-11

- Sync README and usage docs with the current CLI defaults for global SQLite
  data and blacklist database locations.
- Update the request-level parse recovery docs to the current 20-consecutive
  failure threshold.
- Refresh the install example tag to the current documented CLI version.

## 0.4.46 - 2026-06-11

- Highlight the left-hand labels in the multi-line parse work summary when the
  terminal supports color.

## 0.4.45 - 2026-06-11

- Write every final `parse FAIL` WOSID directly to the parse blacklist database,
  without filtering by error category.
- Keep counting blacklisted parse failures toward SID recovery diagnostics, and
  run the recovery query only after 20 consecutive failed WOSID page parses.
- Print the parse work summary as aligned multi-line fields instead of one long
  comma-separated line.

## 0.4.44 - 2026-06-11

- Store parse blacklist entries in a dedicated SQLite database at
  `~/.iiaide-wos/wos-blacklist.sqlite` instead of mixing them into the WOS data
  record database.
- Add `--blacklist-db <file>` for commands that need an explicit parse
  blacklist database path.
- Show `blacklistDb` in parse summaries and dashboard/status panels so blacklist
  writes can be verified independently from WOS record inserts.
- Treat non-session, non-SQLite, non-validation final WOSID parse failures as
  blacklistable, and report blacklist write failures explicitly.

## 0.4.43 - 2026-06-11

- Show the persisted SQLite blacklist count in workspace and WOS data status
  panels.
- Include SQLite record and blacklist counts in blacklist list/remove/clear
  command results so users can confirm whether blacklist writes and clears took
  effect.
- Add `dbBlacklist` to parse work summaries alongside `dbRecords` and `db`.

## 0.4.42 - 2026-06-11

- Treat WOSID record-level parse failures as persistent blacklist entries so
  future parse runs skip them by default instead of repeatedly visiting the same
  inaccessible pages.
- Add `wosdata --unblacklist <WOSID>` and `wosdata --clear-blacklist` to remove
  one or all parse blacklist entries.
- Keep SID/session, SQLite, and record-mismatch errors out of the WOSID
  blacklist so session recovery and data validation remain separate.

## 0.4.41 - 2026-06-11

- Add a WOS full-record export API fallback when DOM page parsing returns no
  usable record, so opened full-record pages are not marked failed solely
  because the WOS page structure changed.
- Print the active WOS SQLite database path and record count in parse work
  summaries to make wrong `--db` selection visible before browser work starts.

## 0.4.40 - 2026-06-11

- Keep `parse --force` scoped to task replacement; existing SQLite WOSID records
  are still skipped before WOS page visits.
- Add `parse --reparse-existing` for the explicit case where existing SQLite
  WOSID rows should be visited again and overwritten after validation.
- Add a worker-side SQLite existence guard so WOSIDs written by another running
  command are skipped before page navigation.

## 0.4.39 - 2026-06-11

- Add a global SQLite WOSID blacklist for no-result full-record page failures.
  Blacklisted WOSIDs are skipped by default on future parse runs and no longer
  contribute to the consecutive-failure SID recovery counter.
- Add `parse --retry-blacklist` to explicitly retry blacklisted WOSIDs. A
  successful retry removes the WOSID from the blacklist.
- Add `wosdata --blacklist` to inspect the persisted blacklist entries.

## 0.4.38 - 2026-06-11

- Add `iiw` as a short command alias for the existing `iiaide-wos` CLI entry
  point. Both commands run the same `bin/iiaide-wos.js` executable.

## 0.4.37 - 2026-06-11

- Remove per-WOSID parse retry attempts. A failed full-record parse is now
  recorded once with its real extraction/import error instead of being requeued
  as `retry`, so successful browser navigation is not hidden behind retry
  status text.
- Keep the 12-consecutive-failure WOS `buildQuery` diagnostic for SID/session
  recovery, but count only real final parse failures because individual retry
  attempts no longer exist.
- Remove the `--parse-max-attempts` / `--max-attempts` parse option from the
  command surface and documentation.

## 0.4.36 - 2026-06-11

- Classify parse recovery `buildQuery` errors before invalidating a SID.
  Inconclusive browser-side results such as `unknown error` now force-close
  Playwright and reconnect with the current SID instead of deleting it from the
  pool; only explicit WOS session, SID, login, expired-session, or query-limit
  messages discard the current SID.
- Wait briefly for browser `sessionData.BasicProperties.SID` during SID
  validation and avoid reopening the visible login prompt a second time when a
  browser-detected SID still cannot validate in the reopened WOS profile.

## 0.4.35 - 2026-06-11

- Retry failed WOSID page parses before recording final failures. Each WOSID now
  gets up to 8 attempts by default, with `--parse-max-attempts <n>` available
  for a lower retry ceiling.
- Use `buildQuery` as the SID/session judge after 12 consecutive WOSID parse
  failures: parse failures trigger diagnosis only, and the SID is invalidated
  only when WOS returns an explicit SID/session `error_code`.
- Force-close the whole Playwright context before parse recovery reconnects and
  before invalidating a SID on WOS `error_code`, ensuring the next SID starts in
  a fresh browser context.
- In the interactive menu, continue the selected WOS parse workflow immediately
  after saving a SID instead of returning to the dashboard for another Enter.
- When parse recovery restarts from menu mode, restart the selected parse
  command rather than reopening the top-level menu.

## 0.4.34 - 2026-06-11

- Move the saved SID pool from workspace `tasks/config.json` to the user-level
  global config at `~/.iiaide-wos/config.json`, so SIDs added from any working
  directory are available to every CLI run.
- Migrate legacy workspace `sid`, `sids`, `sidCursor`, and `deadSids` values into
  the global SID config on first use while keeping workspace browser/runtime
  settings in `tasks/config.json`.

## 0.4.33 - 2026-06-11

- Remove the `Dead SIDs` row from the interactive workspace dashboard. Invalid
  saved SIDs are still removed from the active pool immediately; discarded SID
  details remain only in config history for audit/debugging.

## 0.4.32 - 2026-06-11

- Stop forcing SID setup before the interactive workflow menu opens. Startup now
  only probes and displays authentication status, while WOS download/parse
  workflows request SID setup on demand.
- Keep non-WOS interactive workflows such as Settings, SQLite status/query,
  task management, and Update usable when no SID is configured.

## 0.4.31 - 2026-06-11

- Treat WOS `error_code` recovery responses as explicit evidence that the
  current SID is invalid without clearing the saved SID pool when the bad SID
  came from `--sid` or `WOS_SID`.
- Restart recovery commands without the explicit `--sid <value>` pair after an
  `error_code`, so a long-running command can pick up SID pool values added from
  another terminal.

## 0.4.30 - 2026-06-11

- Replace the single saved SID with a saved SID pool in `tasks/config.json`.
  The CLI selects the pool cursor value, removes only SIDs that are clearly
  invalid, then tries the next saved SID before falling back to browser login or
  manual input.
- Add `iiaide-wos settings --add-sid <SID>` and `--add-sids "<SID...>"` for
  scriptable SID pool updates. Batch input accepts spaces, newlines, or commas
  and de-duplicates saved values.
- Add interactive Settings actions `5.3 Add SID` and `5.4 Batch add SIDs`, and
  show the current SID, pool position/count, and discarded SID count in the
  workspace dashboard.

## 0.4.29 - 2026-06-11

- On WOS recovery `error_code`, force-close the shared Playwright context before
  clearing SID state and restarting the CLI. This avoids leaving the workspace
  `.browser-profile` locked by a kept-alive Chromium process in interactive
  menu runs.

## 0.4.28 - 2026-06-11

- Change the 10-consecutive-failure parse recovery probe to run
  `window.wos.query.buildQuery("AB=<random 4 letters>")` through `wos.js`.
- If that recovery query returns `error_code`, close Playwright, clear the saved
  SID and current `WOS_SID` environment value, and restart the current CLI
  command/menu so the next run starts from a fresh SID flow.

## 0.4.27 - 2026-06-11

- Disable fixed parse browser restarts by default so multi-tab parsing keeps
  collecting WOSID pages until real page failures force recovery.
- Change parse recovery to close the Playwright context after 10 consecutive
  WOSID page failures, reconnect with the current SID, and test WOS routing by
  opening `PY=2000` through `window.wos.query.openQueryPage()`.
- Make the recovery query tolerate missing summary `search-info` elements, so a
  selector timeout during connectivity probing does not stop the parse run.

## 0.4.26 - 2026-06-11

- Make parse progress detail completion-oriented so single-tab and multi-tab
  runs show the same progress semantics: the bar tracks completed selected
  records and the detail shows the last completed WOSID status, while source
  CSV positions remain in logs and non-interactive OK/FAIL lines.

## 0.4.25 - 2026-06-11

- Add a persistent parse tab setting: `iiaide-wos settings
  --parse-concurrency <n>` writes the default reusable WOS page count for
  `parse` and `parse-pipeline`, while explicit `--concurrency <n>` still
  overrides it for one command.
- Expose the same default in the interactive Settings menu as `5.2 Parse tabs`
  and show it in the workspace dashboard.

## 0.4.24 - 2026-06-11

- Clarify the CLI full-record parse contract: `parse` opens WOSID pages through
  the injected `window.wos.record.viewFullRecordByWosId(targetWosId)` helper,
  then parses the loaded page with `window.wos.record.parseCurrentFullRecordPage()`.
- Align README and usage/curl docs with the browser-helper boundary so CLI
  documentation matches the current `wos.js` opening path.

## 0.4.23 - 2026-06-11

- Harden browser-side full-record opening so `import/wos.js` preserves externally
  prepared WOSIDs such as `PUB:...`, rejects empty WOSID navigation instead of
  reusing old state, URL-encodes full-record routes, and verifies the loaded
  page before parsing.
- Document that CLI import and SQLite validation own WOSID canonicalization;
  the browser helper only trims input or extracts `/full-record/<id>` segments.

## 0.4.22 - 2026-06-11

- Reuse one WOS full-record Playwright page per parse worker instead of opening
  and closing a new page for every WOSID. Full-record parsing still uses the
  browser-side `wos.js` route/parser methods, but each worker now keeps its tab
  across records until the parse session or browser-restart boundary ends.

## 0.4.21 - 2026-06-11

- Add a persistent Playwright visibility setting: `iiaide-wos settings
  --playwright-visible on|off` writes `playwrightVisible` to
  `tasks/config.json`, and the interactive menu exposes it as `5.1 Playwright
  visible`.
- Preserve the saved Playwright visibility setting when refreshing or saving a
  WOS SID.

## 0.4.20 - 2026-06-11

- After parse browser restarts and 10-failure SID reconnects, run a warm-up WOS
  query page using `PY=2020` before continuing WOSID full-record parsing.

## 0.4.19 - 2026-06-11

- Clarify parse progress detail by labeling the original WOSID CSV position as
  `source <index>/<total>` so it is not confused with processed/failed counts.

## 0.4.18 - 2026-06-11

- Change the 10-failure parse recovery path to first close Playwright and
  reconnect with the current SID; visible browser login is used only if that SID
  reconnect cannot be validated.

## 0.4.17 - 2026-06-11

- Refresh the WOS SID after 10 consecutive full-record page parse failures
  instead of waiting for more than 20 failures.

## 0.4.16 - 2026-06-11

- Restart the Playwright WOS browser context between parse batches by default:
  `parse` now closes and reopens the browser every 100 attempted WOSID page
  parses while reusing the current SID.
- Add `--browser-restart-every <n>` for parse workflows; use `0` to disable the
  browser restart boundary, and `--restart-every` as a shorter alias.

## 0.4.15 - 2026-06-11

- Preserve the accession prefix found in WOSID TXT/CSV values during parse
  workflows instead of forcing IDs into a `WOS:<id>` shape.
- Compare expected and parsed full-record accession IDs after removing
  non-alphanumeric characters, so punctuation-only differences do not fail
  SQLite validation.
- When WOS full-record page parsing fails more than 20 times in a row, clear
  the saved SID and open a visible WOS login window to refresh authentication
  before continuing.

## 0.4.14 - 2026-06-10

- Start interactive TXT and BibTeX downloads immediately after printing the
  record and batch plan; the `Continue ... download?` confirmation prompt has
  been removed.
- Run interactive `WOS IDs to SQL` with default parse options directly, removing
  the `Change parse options?` prompt and its unused interactive option editor.

## 0.4.13 - 2026-06-10

- Remove the obsolete `wosdata --json-dir` and managed-task JSON import paths;
  SQLite data now enters through parse, direct validated record writes, or
  database merge.
- Remove legacy raw artifact directory fallback code so raw full-record and
  BibTeX batches use only the current `raw/<uuid>/...` layout.
- Refresh docs and tests to match the SQLite-only WOS data workflow.

## 0.4.12 - 2026-06-10

- Fix interactive `2 WOS IDs to SQL` indentation so it renders as a top-level
  workflow command instead of an indented submenu item.

## 0.4.11 - 2026-06-10

- Promote interactive `WOS IDs to SQL` from `2.1` to top-level `2`, removing
  the extra Parse submenu level.

## 0.4.10 - 2026-06-10

- Merge the interactive Parse panel into one `2.1 WOS IDs to SQL` action.
- Add automatic interactive input detection so `.csv` paths run the CSV parse
  path and WOS URL/UUID input runs the export-plus-parse pipeline.

## 0.4.9 - 2026-06-10

- Change interactive `4.3 Query` to prompt for a single WOSID and return that
  SQLite record, instead of requiring the user to type a SQL statement.
- Add `wosdata --wosid <WOSID>` for simple command-line WOSID lookup.

## 0.4.8 - 2026-06-10

- Replace interactive SQLite JSON import actions with global database merge and
  read-only query actions.
- Add `wosdata --merge-db <file>` for merging another WOS SQLite database into
  the active global database, skipping existing WOSIDs unless `--force` is used.
- Add `wosdata --query <sql>` for simple read-only `SELECT` queries against the
  WOS SQLite database.

## 0.4.7 - 2026-06-10

- Render the interactive workflow footer shortcuts (`c`, `u`, `B`, and `q`) as
  one compact line instead of multi-line descriptions.

## 0.4.6 - 2026-06-10

- Add interactive `4 SQL database` management actions for global SQLite status,
  importing existing task-local WOSID JSON, and importing a standalone WOSID JSON
  directory.
- Let interactive SQLite imports choose whether to force overwrite existing SQL
  rows; the default remains non-destructive skip behavior.

## 0.4.5 - 2026-06-10

- Change `parse` and `parse-pipeline` to validate parsed WOS page data and write
  directly to SQLite instead of writing task-local `raw/wosdata/<WOSID>.json`
  files.
- Keep SQLite inserts non-destructive by default: existing WOSID rows are
  skipped, while `--force` refetches and overwrites the existing database row
  after validation.
- Make parse commands print the SQLite database path as their final artifact.

## 0.4.4 - 2026-06-10

- Move the default WOS data SQLite database from the tasks root to the user
  global path `~/.iiaide-wos/wosdata.sqlite`, so all task workspaces share one
  WOSID cache by default.
- Show global SQLite database path, size, and WOSID count in the interactive
  startup dashboard and `workspace` status output.
- Make `parse` skip WOSIDs already present in the global SQLite database and
  insert new WOSID JSON only when the database does not already contain it.

## 0.4.3 - 2026-06-10

- Add a workspace SQLite WOS data index at `<tasks-root>/wosdata.sqlite`,
  populated from parsed `raw/wosdata/<WOSID>.json` records.
- Add `iiaide-wos wosdata` for local JSON-to-SQLite imports from a managed task
  or an explicit `--json-dir`, without requiring raw `.txt` or `.bib` files.
- Upsert parsed WOSID JSON into SQLite after `parse` and `parse-pipeline`, while
  keeping WOS usernames, passwords, and SID values out of the database.

## 0.4.2 - 2026-06-10

- Change `iiaide-wos check` to print only a short safe status message instead
  of JSON containing SID-related URLs or config paths.

## 0.4.1 - 2026-06-10

- Add interactive `2.2 WOSID CSV` so the Parse panel can run `parse --csv`
  from a local WOSID CSV without asking for a WOS URL or UUID.

## 0.4.0 - 2026-06-10

- Move interactive `Check SID` to the bottom command row as `c`, and change the
  back shortcut from `c` to `B` across interactive prompts.
- Add interactive `u Update`, which runs the updater and restarts the menu after
  a successful update.
- Document the version rollover rule: after `.100`, bump the minor version and
  reset patch to `.0`.

## 0.3.100 - 2026-06-10

- Add `parse --csv <wosids.csv>` so a local WOSID CSV can be normalized into a
  task WOSID index and parsed into the shared `raw/wosdata/<WOSID>.json` cache
  in one command.
- Make the parse summary explicitly report skipped cached WOS data records.

## 0.3.99 - 2026-06-10

- Move WOSID index CSV files from `export/<uuid>/wosid/` to
  `raw/<uuid>/full-record/<uuid>_wosid.csv`, keeping the UUID result-set index
  beside its raw full-record batches.
- Replace UUID-scoped record JSON and flattened record field exports with a
  task-level `raw/wosdata/<WOSID>.json` cache so repeated WOSIDs across UUIDs
  are parsed once and reused.
- Replace `records`/`records-pipeline` with `parse`/`parse-pipeline`, and remove
  the author extraction command/workflow and generated author/record CSV exports.

## 0.3.98 - 2026-06-10

- Route the CLI `records` extraction stage through the injected browser-side
  `wos.record.viewFullRecordByWosId()` and
  `wos.record.parseCurrentFullRecordPage()` helpers, saving the structured JSON
  under `raw/<uuid>/record/<WOSID>.json`.
- Flatten the structured full-record JSON into the existing record field CSV and
  JSONL exports for indexing.

## 0.3.97 - 2026-06-10

- Rename the browser-side full-record page parser entry point to
  `wos.record.parseCurrentFullRecordPage()` so the API reflects DOM parsing
  rather than request fetching.

## 0.3.96 - 2026-06-10

- Add browser-side WOS full-record page expansion and structured parsing helpers
  to `import/wos.js`, exposed through `wos.record.fetchCurrentPageInfo()`.

## 0.3.95 - 2026-06-10

- Rename the WOS ID CSV export directory from `export/<uuid>/full-record/` to
  `export/<uuid>/wosid/`, because the exported artifact is the normalized WOSID
  list rather than raw full-record data.
- Keep reading existing `export/<uuid>/full-record/<uuid>_wosid.csv` files as a
  legacy WOSID location for already-created tasks.

## 0.3.94 - 2026-06-10

- Allow a managed task to append downloads for multiple WOS UUIDs, keeping each
  UUID's files isolated under its own `raw/<uuid>/` and `export/<uuid>/`
  directories.
- Ignore stale task-level summary metadata from a different UUID when deciding
  whether current raw batches can be reused.

## 0.3.93 - 2026-06-10

- Add `records` and `records-pipeline` commands for full-record page field
  extraction, with outputs under `raw/<uuid>/record/` and
  `export/<uuid>/record/`.
- Add the interactive `2.2 Article full record` workflow.

## 0.3.92 - 2026-06-10

- Expand WOS full-record controls during author extraction and store generic
  `snMainArticle` field extraction in raw author JSON as `recordFields`,
  `recordTables`, and `recordSections`.

## 0.3.91 - 2026-06-10

- Repair missing author checkpoints from existing raw author JSON files before
  selecting WOS IDs for download, including older `raw/<uuid>/authors/`
  directories.
- Let `authors` read older `data/<uuid>_wosid.csv` files when the current
  `export/<uuid>/full-record/` CSV is missing.

## 0.3.90 - 2026-06-10

- Rebuild missing WOS ID export CSVs from existing complete
  `raw/<uuid>/full-record/` batches before attempting a new WOS download.
- Rebuild missing combined BibTeX files from existing `raw/<uuid>/bib/` batches
  before attempting a new WOS BibTeX export.

## 0.3.89 - 2026-06-10

- Move formatted deliverables from top-level `data/` and `authors/` folders into
  source-scoped `export/<uuid-or-task-id>/...` folders that mirror `raw/`.
- Write WOS ID CSVs to `export/<uuid>/full-record/<uuid>_wosid.csv`, combined
  BibTeX to `export/<uuid>/bib/<uuid>.bib`, and author exports to
  `export/<uuid>/author/<uuid>_authors.csv` plus
  `<uuid>_authors_simple.csv`.
- Store raw author page JSON under `raw/<uuid>/author/` so raw and export author
  folders use the same singular stage name.

## 0.3.88 - 2026-06-10

- Add `authors/authors-simple.csv` beside `authors.csv`; it keeps only
  `wosid`, `authorIndex`, `address`, `affiliation`, `rorId`, and
  `correspondingAddress`, drops rows where all four address-detail fields are
  empty, and removes duplicate rows.
- Require `iiaide-wos clear` to show the resolved task id and accept that exact
  task id as confirmation before deleting a managed task directory.

## 0.3.87 - 2026-06-10

- Make interactive startup show `Auth yes` only after a successful SID probe.
- Stop auto-opening a WOS browser on startup when the saved SID is invalid; the
  startup flow now shows `Auth no` and lets the user choose manual SID input or
  browser login.

## 0.3.86 - 2026-06-10

- Add `Check SID` to the interactive startup workflow menu so the saved SID can
  be validated and refreshed through browser login directly from the panel.

## 0.3.85 - 2026-06-10

- Add `iiaide-wos check` to probe the saved WOS SID and open a browser login to
  refresh it automatically when the SID is missing, invalid, or still not
  confirmed.

## 0.3.84 - 2026-06-10

- Speed up author no-data detection by waiting only for navigation commit and
  then racing author-page selectors against WOS root redirects instead of
  waiting for `networkidle`.

## 0.3.83 - 2026-06-10

- Stop waiting for author-page details when a WOS full-record URL redirects
  back to the WOS root page; the record is marked failed as no WOS data.

## 0.3.82 - 2026-06-10

- Add author failure cooldown controls; by default the author stage pauses for
  60 seconds after 20 failed records in one run before continuing.

## 0.3.81 - 2026-06-10

- Add a per-author WOSID timeout with a 20 second default so slow full-record
  author pages fail quickly and the batch can continue.

## 0.3.80 - 2026-06-10

- Change the default author extraction concurrency from `2` to `1` for steadier
  single-SID runs while keeping `--concurrency` available for explicit parallel
  tabs.

## 0.3.79 - 2026-06-10

- Store raw author extraction JSON under `raw/authors/` so all raw task inputs
  live under the task `raw/` directory.

## 0.3.78 - 2026-06-10

- Highlight the active interactive task id in the workspace panel and task
  list.

## 0.3.77 - 2026-06-10

- Replace the flat interactive workflow menu with folded command groups:
  download literature, export, and task manager.

## 0.3.76 - 2026-06-10

- Add a highlighted background to the `[ W O S - C L I ]` logo in the
  interactive dashboard.

## 0.3.75 - 2026-06-10

- Move the WOS origin URL into the left interactive dashboard panel under the
  `iiaide-wos CLI` title and remove the right-panel Origin row.

## 0.3.74 - 2026-06-10

- Redraw the interactive workspace dashboard after manual SID entry or browser
  login SID detection so refreshed authentication status is visible before the
  next workflow prompt.

## 0.3.73 - 2026-06-10

- Treat `c` as "back to the previous interactive step" and `q` as "quit the
  interactive CLI".
- Require a WOS source when no saved source exists instead of treating Enter as
  cancellation.

## 0.3.72 - 2026-06-10

- Let interactive prompts accept `c` as a back shortcut across
  workflow selection, task selection, WOS source input, SID setup, confirmations,
  and author option prompts, while keeping `q` as the CLI exit shortcut.

## 0.3.71 - 2026-06-10

- Print interactive task selection commands as aligned multi-line hints before
  the task prompt.

## 0.3.70 - 2026-06-10

- Generate new timestamp task ids with the `TID` prefix instead of `WOS`.

## 0.3.69 - 2026-06-10

- Store raw full-record and BibTeX export batches under UUID parent
  directories, such as `raw/full-record/<uuid>/<uuid>_<start>_<end>.txt` and
  `raw/bib/<uuid>/<uuid>_<start>_<end>.bib`.
- Point task summaries and validation at the UUID-specific raw batch
  directories.

## 0.3.68 - 2026-06-10

- Add the existing `latest` task command to CLI help so command docs and
  scriptable usage stay aligned.
- Align BibTeX curl documentation with the current bounded-count export
  behavior.
- Include the default browser-side `import/wos.js` helper in packaged installs.

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
