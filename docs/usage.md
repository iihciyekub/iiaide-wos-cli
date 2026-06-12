# Usage And Data Model

## Product Model

iiaide-wos CLI is built around tasks rather than isolated command outputs.
Installed releases expose both `iiaide-wos` and the short alias `iiw`; they run
the same CLI entry point.
Installed releases should download Chromium with `iiaide-wos install-browser`
so the browser revision always matches the bundled Playwright version.
For request-level equivalents of the WOS methods used by the CLI, see
[`docs/curl.md`](curl.md).

A task represents one complete WOS data-processing job:

```text
input -> UUID WOSID index -> global SQLite WOS data -> validated task package
```

Inputs currently supported:

- WOS summary URL
- WOS result-set UUID
- Existing CSV containing WOS IDs
- WOS summary URL or result-set UUID for BibTeX export

URL/UUID parsing accepts standard WOS summary URLs, protocol-less copied
strings such as `ofscience.com/wos/woscc/summary/<uuid>/date-descending/1`,
and WOS UUIDs with either `8-4-4-4-12` or `8-4-4-4-12-10` segment structure.
When the CLI rebuilds a protocol-less or UUID-only summary URL, it preserves the
pasted sort segment and rebases generated URLs to the WOS origin observed during
SID validation.

All input methods converge on the same normalized file:

```text
tasks/<task-id>/raw/<uuid-or-task-id>/full-record/<uuid-or-task-id>_wosid.csv
```

This allows later commands to work independently of how the WOS IDs were
obtained.
When a repeated `run` finds complete raw full-record batches but the WOSID index is missing, it rebuilds `raw/<uuid>/full-record/<uuid>_wosid.csv` locally before attempting another WOS download.

The default global SQLite database lives at:

```text
~/.iiaide-wos/wosdata.sqlite
```

It is an aggregation database built from parsed WOS full-record page data. It
does not store raw full-record `.txt` batches, BibTeX `.bib` files, WOS
usernames, passwords, or SID values. All task workspaces use this same database
unless `--db <file>` is supplied.

The parse blacklist is isolated in a separate SQLite database:

```text
~/.iiaide-wos/wos-blacklist.sqlite
```

These databases are user-level files, not task artifacts. Use `--db <file>` or
`--blacklist-db <file>` when you need custom database paths.

## URL And UUID Workflow

The `run` command:

1. Prepares the shared persistent Playwright WOS session from the workspace
   profile at `<tasksRoot>/.browser-profile`.
2. Shows the resolved WOS UUID parsed from the URL or UUID input.
3. Validates the supplied or saved WOS SID by opening
   `https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=<sid>`.
   If the active saved pool SID is invalid, it removes that SID and tries the
   next saved value. In interactive terminals, SID setup can then wait for the
   saved SID pool, accept manual input, or open a visible WOS login window.
4. Opens the WOS summary page to prepare the same-origin request context.
5. Reads and reports the result-set UUID and expected record count.
6. Applies `--from-index` and `--limit` when a record slice is requested. When
   no slice is requested, infers the range start from the first existing raw TXT
   batch for the UUID.
7. Calls the injected `window.wos.export.fetchTxtBatches` API only for the
   missing tail range.
8. Stores every raw batch under `raw/<uuid>/full-record/<uuid>_<start>_<end>.txt`.
9. Parses the `UT` field into normalized WOS IDs.
10. Writes the normalized WOSID CSV under `raw/<uuid>/full-record/`,
    plus metadata, logs, and a summary.

This is more reliable than scrolling the result list because WOS result pages
are virtualized and may not render every card at once.

Raw TXT batch names are inclusive ranges. If a task already has
`<uuid>_400_600.txt` as its first raw batch and no explicit range is requested,
the CLI infers record 400 as the selected range start. The next TXT export
starts at record 601 and then rebuilds the WOSID CSV from both existing and new
raw batches. Existing raw batches must be contiguous from the selected start;
gaps fail fast so the task does not accumulate overlapping raw files. Passing
`--from-index` or `--limit` disables raw-start inference and uses the requested
range. Use `--force` to clean a managed task before a fresh WOS export, or
choose a range that starts at the first existing raw batch.

## CSV Import Workflow

The `import --csv` command creates the same managed task structure without
calling WOS.

CSV rules:

- A column named `wosid`, `wos_id`, `wos-id`, or `UT` is preferred.
- If no recognized header exists, the first column is used.
- WOS IDs are normalized to uppercase.
- Invalid values are ignored.
- Duplicate WOS IDs are removed while preserving input order.
- Import fails when no valid `WOS:<id>` values are found.

The imported task can immediately be passed to `parse`. If the next step is to
parse WOS data, `parse --csv` can perform this import step and then parse the
same WOSID list in one command.

## BibTeX Workflow

The `bib` command uses the same persistent Playwright WOS session strategy as
`run`: initialize WOS from
`https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=<sid>`, open the target
summary URL, read the page-exposed query UUID and record count, report the
count, and then download BibTeX through the injected
`window.wos.export.fetchBibBatches` API. It does not use the export overlay
buttons or frontend click flows for the main download path. The browser-side
wos.js helper owns WOS request details such as `saveToBibtex`; the CLI owns task
file writing, progress logging, and final BibTeX composition.
Batch files are kept under `raw/<uuid>/bib/`, then combined into one final BibTeX
file under `export/<uuid>/bib/`. In the folded interactive menu, use
`1.2 UUID - BIB format`; after source input it prints the resolved UUID before
SID validation and then shows download progress for each WOS BibTeX batch.
When a repeated `bib` finds raw BibTeX batches but the combined `.bib` file is
missing, it rebuilds `export/<uuid>/bib/<uuid>.bib` locally before attempting
another WOS BibTeX export.

When `--limit` is omitted, `bib` requests records up to the WOS summary count.
If WOS does not expose a count, the command stops instead of guessing the final
range. Empty or short non-final BibTeX batches are treated as incomplete exports
and are not marked completed. Use `--from-index` and `--limit` to download an
explicit range.

If WOS returns `Server.invalidState` with `Records can only be retrieved from a
record type query`, the UUID belongs to a non-record result set. Copy a normal
WOS Core Collection records summary URL/UUID and run the export again.

```text
tasks/<task-id>/raw/<uuid>/bib/<uuid>_<start>_<end>.bib
tasks/<task-id>/export/<uuid>/bib/<uuid>.bib
```

## WOS Data Parse Workflow

The `parse` command reads the task's WOSID CSV and opens missing WOS full-record
pages through the injected browser-side `wos.js` parser. Its deliverable is the
global SQLite database, not local JSON files or a CSV export.

For each selected WOSID, the CLI enters the Playwright page context and calls
`window.wos.record.viewFullRecordByWosId(targetWosId)`, then parses the loaded
page with `window.wos.record.parseCurrentFullRecordPage()`. It does not click
summary-page links or call `page.goto()` for each record; `wos.js` owns the
browser-side full-record route change and readiness verification.

Each parse worker reuses one WOS Playwright page across records. The worker
opens `/wos/` once, then uses the browser-side `wos.js` front-end route helper
to move between full-record pages before parsing the current page. With
`--concurrency 3`, the CLI keeps up to three reusable WOS pages instead of
opening and closing a new page for every WOSID.
Save that default with `iiaide-wos settings --parse-concurrency 3` or menu item
`5.2 Parse tabs`; explicit `--concurrency <n>` still overrides the saved value
for one command.
When a SID refresh, recovery reconnect, or `--browser-restart-every` segment
restart closes Playwright, the CLI first releases those reusable pages to
`about:blank` and then closes the persistent context so long-running Chromium
renderer memory is more likely to drop before the next session starts. Parse
work is also split into smaller memory-check chunks. By default the CLI checks
RSS every 200 WOSIDs and can restart the current SID session between chunks
once RSS crosses the configured limit.

The browser-side `wos.js` helper opens externally prepared WOSIDs. It trims
input and accepts full-record URLs by extracting the path segment, but it does
not canonicalize prefixes, case, or punctuation; values such as `PUB:...` are
passed through to WOS routing. CSV/TXT import and SQLite validation remain the
canonicalization and loose-comparison boundary.

For every successfully processed WOS ID it validates the parsed object, augments
it with `wosid`, `url`, and `fetchedAt`, and writes it directly to
`~/.iiaide-wos/wosdata.sqlite`.
That stored page JSON preserves structured keyword sections from the WOS full
record page, including `Keywords Plus` values when WOS exposes either
`keywordPlus` or `keyWordsPlus`-style link ids.

The parse workflow preserves the accession prefix found in the TXT or CSV input
instead of forcing every record URL into `WOS:<id>`. During validation, the
expected TXT/CSV ID and the parsed page ID are compared after removing
non-alphanumeric characters, which tolerates punctuation-only differences while
still requiring the same prefix and identifier content.

The UUID's WOSID CSV remains the index for that result set:

```text
raw/<uuid>/full-record/<uuid>_wosid.csv
```

Use `parse-pipeline` when starting from a URL or UUID:

```bash
iiaide-wos parse-pipeline --uuid "<uuid>" --task "<task-id>"
```

Use `parse` when the task already has a WOSID CSV:

```bash
iiaide-wos parse --task "<task-id>"
```

Use `parse --csv` when starting from a local WOSID CSV:

```bash
iiaide-wos parse --csv "./input/wosids.csv" --task "<task-id>"
```

This normalizes the CSV into
`raw/<task-id>/full-record/<task-id>_wosid.csv` before parsing that index. The
parsed data goes directly to SQLite.

Resume behavior is database-based:

- Existing SQLite WOSID records are skipped by default.
- `--force` can replace managed task outputs, but parse still skips existing
  SQLite rows before page visits.
- `--reparse-existing` refetches existing WOSID records and overwrites the
  SQLite row after validation.
- The parse work summary prints aligned multi-line fields for `dbRecords`,
  `dbBlacklist`, `db`, and `blacklistDb` so wrong database selection or a failed
  blacklist write is visible before browser work starts. Color terminals
  highlight the left-hand field labels.
- `--from-index` and `--limit` select a slice of the WOSID index.
- WOSID page failures are recorded once with the real extraction or SQLite
  import error. They are not requeued for retry.
- If a full-record page opens but DOM extraction returns no usable record, parse
  falls back to the WOS single-record export API before counting the WOSID as
  failed.
- Every WOSID finally reported as `parse FAIL` is written to the separate global
  SQLite blacklist database and skipped by default on future parse runs. Use
  `--retry-blacklist` to include them in a deliberate retry run.
- 20 consecutive final parse failures trigger the WOS `buildQuery` SID recovery
  diagnostic. Blacklist writes do not reset this counter.
- Use `wosdata --unblacklist <WOSID>` to remove one blacklist entry or
  `wosdata --clear-blacklist` to remove all blacklist entries.
- Final failures are recorded at `raw/<uuid>/full-record/<uuid>_parse_failures.json`.
- `--browser-restart-every <n>` restarts Playwright between parse batches. The
  default is `600`; use `0` only when you intentionally want one long-lived
  browser session.
- `--max-rss-mb <n>` restarts Playwright between parse chunks once the Node
  process RSS reaches that limit. The default is `4096`; use `0` to disable the
  memory-based recycle path.
- Parse failures do not directly invalidate the current SID. 20 consecutive
  WOSID page parse failures close the entire Playwright context and reconnect
  with the current SID, then run
  `window.wos.query.buildQuery("AB=<random 4 letters>")`. If that WOS query
  returns an explicit SID/session `error_code`, the CLI force-closes Playwright
  and treats the current SID as invalid. The active SID is removed from the
  saved pool even if it was detected from the persistent browser profile, and
  the recovery flow will not accept that same SID again. If no saved SID
  remains, the current CLI checks the global SID pool every 10 seconds and
  resumes parsing automatically as soon as a new saved SID is added.
  Inconclusive browser-side results such as `unknown error` reconnect with the
  current SID instead of deleting it. If the query does not return `error_code`,
  the consecutive parse-failure counter resets and parsing continues.
- Authentication success output shows a masked active SID and pool position. Parse
  recovery output is printed as short multi-line notices with the reason and
  next action.
- If WOS opens with the Clarivate privacy/cookie dialog, the Playwright session
  auto-clicks the usual OneTrust `Accept all` or close buttons, recognizes the
  `Privacy` / `ot-sdk-container` dialog shell, and keeps a short-lived popup
  guard active across navigation.
- If a saved SID is missing or fails validation and the current terminal is
  interactive, the CLI offers `Manual input`, `Open browser login`, and `Wait
  for SID pool` as SID recovery choices instead of forcing the visible browser
  login flow first.

Before the parse stage, WOSIDs already present in the global SQLite database are
treated as completed and are skipped. After the parse stage, newly completed
records are inserted directly into `~/.iiaide-wos/wosdata.sqlite`.

## WOS Data SQLite Workflow

The `wosdata` command manages the local SQLite aggregation database only. It
does not open a browser, validate SID, or contact WOS.

Merge records from another WOS SQLite database:

```bash
iiaide-wos wosdata --merge-db "./shared/other-wosdata.sqlite"
```

Query one WOSID in the active database:

```bash
iiaide-wos wosdata --wosid "WOS:000000000000001"
```

List WOSIDs that parse skips by default because their full-record pages could
not yield usable records:

```bash
iiaide-wos wosdata --blacklist
iiaide-wos wosdata --unblacklist "WOS:000000000000001"
iiaide-wos wosdata --clear-blacklist
```

Blacklist list/remove/clear results include `blacklistDbPath`,
`stats.recordCount`, and `stats.blacklistCount`. After
`wosdata --clear-blacklist`, `stats.blacklistCount` should be `0`.

The default database is `~/.iiaide-wos/wosdata.sqlite`; override it with
`--db <file>`. The default blacklist database is
`~/.iiaide-wos/wos-blacklist.sqlite`; override it with `--blacklist-db <file>`.
Database merge validates each record's stored JSON before writing. By default,
existing WOSID rows are skipped; `wosdata --merge-db --force` overwrites them.
Advanced queries are available with `wosdata --query "<SELECT ...>"` and are
restricted to read-only `SELECT` statements. The database stores one
primary row per WOSID in `wos_records`
with common query columns such as title, year, DOI, source title, document type,
URL, fetched time, and the complete raw JSON. `wos_record_sources` records which
task, parse run, or merged database contributed each WOSID.

In the interactive menu, use `2 WOS IDs to SQL`. Paste either a WOS summary
URL/result-set UUID or a local `.csv` file path; the CLI chooses the matching
parse pipeline automatically. The default parse options are:

```text
concurrency=saved parse tabs, default 1 | timeout=20000ms | cooldown=250ms | restart=600 | memoryCheck=200 | maxRssMb=4096 | blacklist=skip | recovery=20x buildQuery AB=<random> | from=1 | limit=all
```

## Task Lifecycle

Typical task states:

```text
created/importing/running
completed/incomplete/failed
parse-running
parse-completed/parse-incomplete
```

The task index is stored in:

```text
tasks/index.json
tasks/latest
```

In the interactive CLI, `tasks/latest` is also the current task pointer. Menu
startup automatically creates a managed current task when none exists. The
Current workspace panel shows that task id as `Task ID`, and the task list
highlights it with `*`. Before any task prompt, the menu prints a
`Task selection:` hint that shows whether Enter keeps the current task, numeric
input switches tasks, or `new` creates a fresh task.

The same startup panel shows the active global WOS data database path, WOSID
record count, blacklist database path, blacklist count, and database size.

Task commands:

```bash
iiaide-wos list
iiaide-wos latest
iiaide-wos show --latest
iiaide-wos path --task <task-id>
iiaide-wos validate --task <task-id>
iiaide-wos clear --task <task-id>
```

`clear` prints the resolved task id, asks you to type that exact task id, then
removes the managed task directory, deletes the task entry from
`tasks/index.json`, and refreshes `tasks/latest` to the next remaining task. It
refuses to remove directories that do not contain a `iiaide-wos` manifest.
In the interactive menu, the `Task id` prompt accepts a numbered task selection
from the current workspace list, an existing task id, `new` for a fresh
generated task id, or a new task id that you type directly. The menu asks for
the folded workflow first, then shows the right task prompt for task-management
actions:

```text
1 Download literature
  1.1 UUID - TXT format
  1.2 UUID - BIB format
2 WOS IDs to SQL
  2.1 Resume
3 Task manager
  3.1 New
  3.2 Switch
  3.3 Clear
4 SQL database
  4.1 Status
  4.2 Merge database
  4.3 Query WOSID
5 Settings
  5.1 Playwright visible
  5.2 Parse tabs
  5.3 Add SIDs
6 Auth producer
  6.1 MUST login
  6.2 MUST monitor
c Check SID
u Update
B Back
q Exit
```

Download workflows run directly in the current task marked with `*`. Use
`c Check SID` to validate the saved SID from the startup panel and go
through the saved SID pool before SID setup choices are needed.
Use `2 WOS IDs to SQL` to parse from either a local WOSID CSV or a WOS summary
URL/UUID; `.csv` input runs the CSV path and URL/UUID input runs the WOS export
path first. Interactive parsing uses the default parse options directly. Use
`2.1 Resume` to parse the current task's existing WOSID CSV into SQLite without
entering the CSV path, URL, or UUID again.
Use `4.1 Status` to inspect the global SQLite database, `4.2 Merge database`
to merge another WOS SQLite database, and `4.3 Query WOSID` to enter one WOSID
and print its SQLite record. Merge asks whether existing SQL rows should be
force overwritten; the default is no.
Use `u Update` to install the latest release and restart the interactive CLI.
Use
`3.1 New` before downloading when you want a fresh task, `3.2 Switch` to select
an existing task, and `3.3 Clear` to remove an existing managed task.

Interactive downloads reuse the current task by default. If the task already
has a completed TXT or BibTeX export for the same UUID, the CLI prints the
existing artifact path and skips SID validation and WOS download. If the input
is a different UUID, the CLI appends that source to the same task and writes it
under separate `raw/<uuid>/` directories, while parsed page data is shared in
the global SQLite database. After printing the available record count and batch
plan, interactive TXT and BibTeX downloads start directly. Use `--force` only
when you intentionally want to replace a managed task's existing outputs. Use
`--reparse-existing` only when you intentionally want `parse` to revisit WOSIDs
that are already present in SQLite.
For download workflows, pressing Enter at the `WOS summary URL or UUID` prompt
uses the shown saved source when one exists. If no saved source is available,
enter a source, press `B` to return to the menu, or press `q` to exit the CLI.
Saved task sources are
shown only when they look like a WOS summary URL or UUID, and
SID/authentication state is shown in the dashboard rather than inside each
workflow.

## Task Validation

`validate` is read-only.

For URL/UUID tasks it checks:

- manifest and summary files
- normalized WOS ID index
- expected and actual WOS ID counts
- raw WOS export batches
- parsed WOS data coverage in SQLite

For imported CSV tasks, raw WOS export batches are not required.

## Directory And Replacement Policy

Normal work should use the default `./tasks` directory.

- `./tasks` is relative to the current working directory, not the installed CLI.
- `iiaide-wos init` explicitly initializes a workspace.
- `iiaide-wos workspace` shows the active workspace and latest Task.
- The CLI does not search parent directories for a workspace.
- `--tasks-root <dir>` explicitly selects a Task workspace from any directory.
- `--task <id>` creates a stable, reusable task name.
- Without `--task`, a timestamp-based task ID is generated.
- `--out-dir` overrides the task directory.
- `--force` permits replacement of CLI-managed task outputs.
- `--reparse-existing` permits parse to revisit WOSIDs already present in the
  SQLite database.
- The CLI refuses to clean any directory without a `iiaide-wos` manifest.
- `run --reuse-raw --force` preserves raw WOS batches and rebuilds derived
  files only when the raw batch range is contiguous and covers the requested WOS
  record range.

## Authentication

Commands that interact with WOS require a current SID:

```text
explicit --sid -> WOS_SID -> ~/.iiaide-wos/config.json SID pool
```

Use `iiaide-wos check` when you want an explicit SID health check. It runs the
lightweight HTTP probe first. If a saved pool SID is clearly invalid, the CLI
removes only that SID and tries the next saved value. If the pool is empty,
missing, or still cannot be confirmed, an interactive terminal uses the SID
setup choices: `Manual input`, `Wait for SID pool`, or `Open browser login`.
Manual entry and browser detection save the refreshed SID into the pool; pool
waiting continues after another process adds a saved SID. The command prints
only a short safe status message.

Add one or many saved SID values without validating them immediately:

```bash
iiaide-wos settings --add-sids "SID_ONE SID_TWO
SID_THREE"
```

Show the current global SID pool:

```bash
iiaide-wos sid-pool
```

Produce one fresh SID through MUST SSO and write it to the same global pool:

```bash
iiaide-wos auth login --provider must
```

Keep a separate process running to refill the pool when it gets low:

```bash
iiaide-wos auth monitor --provider must --min-sids 2 --interval-ms 3000
```

`auth login` and `auth monitor` accept `--account <email>` and `--password
<secret>`. Repeat both flags in matching order to rotate across multiple MUST
accounts. When no credentials are supplied and the terminal is interactive, the
CLI prompts for the account and hides password input. `WOS_ACCOUNT` and
`WOS_PASSWORD` are also supported. Prefer prompts or environment variables over
`--password` because command-line arguments can be visible in shell history and
process lists. `--min-sids` is the SID pool low-water mark: the monitor runs one
login/save refresh whenever `sidPoolCount <= min-sids`. `--threshold` remains
available as an alias for older scripts. While running, the monitor updates
`~/.iiaide-wos/auth-monitor.json`; the interactive/workspace dashboard reads
that heartbeat and shows it as `SID Producer` next to the saved `SID Pool`.

The auth commands use a short-lived Playwright browser context to log into the
MUST Shibboleth flow, advance SAML consent pages, extract
`sessionData.BasicProperties.SID`, and save the resulting SID with the existing
SID pool helper. They do not use the workspace WOS profile and do not write
account credentials into task artifacts, SQLite, or `~/.iiaide-wos/config.json`.
Routine auth output masks SID values; use `sid-pool` to inspect masked pool
state.

`--add-sids` accepts spaces, newlines, or commas and de-duplicates values.
`--add-sid` remains available as a single-value compatibility alias. In the
interactive Settings menu, use `5.3 Add SIDs` for one value or a multi-line
paste. Use `6.1 MUST login` under `6 Auth producer` to run one short-lived MUST
SSO login, or `6.2 MUST monitor` to keep the current CLI process running until
you stop it with Ctrl-C. The SID pool is global per user, so values added from
any working directory are available to every CLI run. The dashboard shows the
masked current SID and the active pool position/count.
`sid-pool` prints the same saved pool as JSON, with `sidPoolCount`,
`sidPoolPosition`, a masked `activeSid`, and masked `sids` values.

WOS domain/origin selection is separate from SID selection. Use
`--wos-domain <domain>` or `WOS_DOMAIN` when only the host changes. Use
`--base-url <origin>` only when the full origin must be explicit. Validated
sessions save both `wosDomain` and `baseUrl` in `tasks/config.json`.

The CLI validates the SID against WOS before use. In an interactive terminal,
missing SIDs or an exhausted SID pool are resolved through SID setup. Choose
`Wait for SID pool` when an auth monitor is expected to add a SID, `Manual
input` to paste a current SID, or `Open browser login` to detect
`window.sessionData.BasicProperties.SID` after login. Non-interactive
environments must use `--sid`, `WOS_SID`, or an existing saved pool.

All Playwright-backed WOS export and parse work uses the same workspace profile:
`<tasksRoot>/.browser-profile` (profile name: `.browser-profile`). Login, SID
validation, summary-page metadata, request-based export calls, and page
parsing should compose through that profile instead of creating isolated
browser contexts or alternate profiles. The MUST auth producer is the exception:
it intentionally uses a separate short-lived browser because it only produces
SIDs for the pool. Normal WOS work runs in background
headless mode. Use `iiaide-wos settings --playwright-visible on` or menu item
`5.1 Playwright visible` to save visible browser mode in `tasks/config.json`;
use `off` to return to background mode. The `--headed` and `--headless` flags
override the saved setting for one command. Login always opens a visible browser
when user action is required.
Use `iiaide-wos settings --parse-concurrency <n>` or menu item `5.2 Parse tabs`
to save the default reusable WOS tab count for parse workflows. The saved value
is stored in `tasks/config.json`; explicit `--concurrency <n>` overrides it for
one parse command.
Single-shot CLI commands close the browser process when they finish, but the
next command reopens the same profile. Interactive menu runs keep the same
profile session open across commands.
If Chromium is missing for the installed Playwright version, interactive WOS
commands offer to run `iiaide-wos install-browser` before retrying the launch.
Non-interactive commands fail with the same repair instruction instead of
printing the upstream Playwright executable-path stack trace.

The shared Playwright context also injects the browser-side helper from
`import/wos.js` before WOS navigation. That script exposes `window.wos`,
`window.WosUUID`, and `window.asy_uuid`; summary metadata reads should prefer
`window.asy_uuid.fetchCurrentPageInfo()` so the CLI reuses the same browser-side
WOS logic as the older injected tool. Use `--wosjs <file>` or `WOSJS_PATH` only
when the helper file is stored somewhere else.

When the interactive CLI starts, it runs a lightweight SID probe against the WOS
initialization URL. This does not open Chromium. It removes a saved SID only when
the probe clearly classifies it as invalid, then tries the next pool value. The
dashboard shows `Auth yes` only when that probe confirms the active SID. If the
SID is `missing`, `invalid`, or still `unknown`, the dashboard shows `Auth no`
but still opens the workflow menu. SID setup is requested only after you choose
a WOS download or parse workflow that needs WOS network access. The dashboard
shows the WOS origin URL under the left-side `iiaide-wos CLI` title, using the
detected origin when the probe can resolve it. The left dashboard logo is
highlighted in color-capable terminals. If no origin is confirmed, the CLI
prints a hint to reopen WOS with
`https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=<SID>`. Commands that
download or extract WOS data still perform strict persistent Playwright
validation before doing network work. Settings, SQLite, task management, and
update workflows can be used while `Auth no` is shown.

In interactive menu mode, manual SID entry and browser login SID detection save
the refreshed SID into the pool, return to the outer menu loop, rerun the
lightweight probe, and redraw the dashboard before asking for the next workflow
input. `Wait for SID pool` stays in the SID setup step and keeps checking the
global saved pool until another process, such as `auth monitor`, adds a SID.

WOS export and parse workflows do not manage account credentials; they consume
only SIDs. The optional MUST auth producer can log in through MUST SSO to write
fresh SIDs into the global pool, but it keeps usernames, passwords, and SID
values out of task artifacts and SQLite.

## Extension Direction

New WOS commands should consume or enrich the same task package instead of
creating unrelated output folders. Suitable future stages include:

- cited-reference extraction
- funding and organization normalization
- journal and category enrichment
- citation metrics snapshots
- task archive/export commands
- machine-readable task reports

Each new stage should retain raw inputs, normalized outputs, checkpoint state,
failures, and validation rules.

## Updates

`iiaide-wos update --check` queries the latest stable GitHub Release.
`iiaide-wos update` installs that exact release tag globally through npm:

```text
github:iihciyekub/iiaide-wos-cli#<release-tag>
```

The repository and its Releases are private. Before installing or updating, run
`gh auth login` and `gh auth setup-git`, or provide a `GH_TOKEN`/`GITHUB_TOKEN`
with repository read access. The updater does not install unreleased commits
from the default branch.

The first update check requires at least one published GitHub Release; create a
release tag before relying on `iiaide-wos update`.
In the interactive menu, choose `u Update` to run the updater and restart the
menu process after a successful update.

## Uninstall

Remove the globally installed package:

```bash
npm uninstall --global iiaide-wos-cli
```

For a local development link, remove the global link:

```bash
npm unlink --global iiaide-wos-cli
```
