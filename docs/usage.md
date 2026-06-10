# Usage And Data Model

## Product Model

iiaide-wos CLI is built around tasks rather than isolated command outputs.
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

## URL And UUID Workflow

The `run` command:

1. Prepares the shared persistent Playwright WOS session from the workspace
   profile at `<tasksRoot>/.browser-profile`.
2. Shows the resolved WOS UUID parsed from the URL or UUID input.
3. Validates the supplied or saved WOS SID by opening
   `https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=<sid>`.
   If the saved SID is invalid, it opens a visible WOS login window, detects the
   fresh page SID after login, saves it, and reopens the same profile in
   background headless mode.
4. Opens the WOS summary page to prepare the same-origin request context.
5. Reads and reports the result-set UUID and expected record count.
6. Calls the injected `window.wos.export.fetchTxtBatches` API in batches.
7. Stores every raw batch under `raw/<uuid>/full-record/<uuid>_<start>_<end>.txt`.
8. Parses the `UT` field into normalized WOS IDs.
9. Writes the normalized WOSID CSV under `raw/<uuid>/full-record/`,
   plus metadata, logs, and a summary.

This is more reliable than scrolling the result list because WOS result pages
are virtualized and may not render every card at once.

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

For every successfully processed WOS ID it validates the parsed object, augments
it with `wosid`, `url`, and `fetchedAt`, and writes it directly to
`~/.iiaide-wos/wosdata.sqlite`.

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
- `--force` refetches existing WOSID records and overwrites the SQLite row after validation.
- `--from-index` and `--limit` select a slice of the WOSID index.
- Failures are recorded at `raw/<uuid>/full-record/<uuid>_parse_failures.json`.

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

The default database is `~/.iiaide-wos/wosdata.sqlite`; override it with
`--db <file>`. Database merge validates each record's stored JSON before
writing. By default, existing WOSID rows are skipped; `--force` overwrites them.
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
concurrency=1 | timeout=20000ms | cooldown=250ms | from=1 | limit=all
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
record count, and database size.

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
3 Task manager
  3.1 New
  3.2 Switch
  3.3 Clear
4 SQL database
  4.1 Status
  4.2 Merge database
  4.3 Query WOSID
c Check SID
u Update
B Back
q Exit
```

Download workflows run directly in the current task marked with `*`. Use
`c Check SID` to validate the saved SID from the startup panel and go
directly into browser login when WOS rejects it.
Use `2 WOS IDs to SQL` to parse from either a local WOSID CSV or a WOS summary
URL/UUID; `.csv` input runs the CSV path and URL/UUID input runs the WOS export
path first. Interactive parsing uses the default parse options directly.
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
when you intentionally want to replace a managed task's existing outputs or
overwrite existing WOSID database rows.
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
- The CLI refuses to clean any directory without a `iiaide-wos` manifest.
- `run --reuse-raw --force` preserves raw WOS batches and rebuilds derived
  files only when the raw batch range is contiguous and covers the known WOS
  record count.

## Authentication

Commands that interact with WOS require a current SID:

```text
explicit --sid -> WOS_SID -> tasks/config.json
```

Use `iiaide-wos check` when you want an explicit SID health check. It runs the
lightweight HTTP probe first, and if the SID is missing, invalid, or still not
confirmed, it opens a visible WOS browser login, saves the refreshed SID, and
prints only a short safe status message.

WOS domain/origin selection is separate from SID selection. Use
`--wos-domain <domain>` or `WOS_DOMAIN` when only the host changes. Use
`--base-url <origin>` only when the full origin must be explicit. Validated
sessions save both `wosDomain` and `baseUrl` in `tasks/config.json`.

The CLI validates the SID against WOS before use. In an interactive terminal,
missing or invalid SIDs are resolved by opening a visible WOS login window and
detecting `window.sessionData.BasicProperties.SID` after login. Non-interactive
environments must use `--sid`, `WOS_SID`, or an existing config.

All Playwright-backed WOS work uses the same workspace profile:
`<tasksRoot>/.browser-profile` (profile name: `.browser-profile`). Login, SID
validation, summary-page metadata, request-based export calls, and page
parsing should compose through that profile instead of creating isolated
browser contexts or alternate profiles. Normal WOS work runs in background
headless mode; only login and `--headed` runs open a visible browser.
Single-shot CLI commands close the browser process when they finish, but the
next command reopens the same profile. Interactive menu runs keep the same
profile session open across commands.

The shared Playwright context also injects the browser-side helper from
`import/wos.js` before WOS navigation. That script exposes `window.wos`,
`window.WosUUID`, and `window.asy_uuid`; summary metadata reads should prefer
`window.asy_uuid.fetchCurrentPageInfo()` so the CLI reuses the same browser-side
WOS logic as the older injected tool. Use `--wosjs <file>` or `WOSJS_PATH` only
when the helper file is stored somewhere else.

When the interactive CLI starts, it runs a lightweight SID probe against the WOS
initialization URL. This does not open Chromium and does not save or overwrite
the SID. The dashboard shows `Auth yes` only when that probe confirms the SID.
If the SID is `missing`, `invalid`, or still `unknown`, the dashboard shows
`Auth no` and the CLI prompts for either manual SID input or a visible WOS
browser login. The dashboard shows the WOS origin URL under the left-side
`iiaide-wos CLI` title, using the detected origin when the probe can resolve
it. The left dashboard logo is highlighted in color-capable terminals. If no
origin is confirmed, the CLI prints a hint to reopen WOS with
`https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=<SID>`. Commands that
download or extract WOS data still perform strict persistent Playwright
validation before doing network work.

In interactive menu mode, manual SID entry and browser login SID detection save
the refreshed SID, return to the outer menu loop, rerun the lightweight probe,
and redraw the dashboard before asking for the next workflow input.

The CLI does not log in to WOS or manage user account credentials. SQLite
imports also keep credentials out of the database.

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
