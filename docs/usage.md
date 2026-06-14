# Usage And Data Model

This CLI manages Web of Science export work as resumable tasks. The current
download deliverables are raw TXT full-record batches and raw BibTeX batches.

## Task Lifecycle

A task represents one WOS export job:

```text
input -> UUID/source resolution -> raw WOS export batches -> validated task package
```

Use a stable task id when a job may be resumed or shared:

```bash
iiaide-wos run --uuid "<uuid>" --task "demo-search"
iiaide-wos bib --uuid "<uuid>" --task "demo-bib"
iiaide-wos batch-run --task "batch-demo"
iiaide-wos import --csv "./input/wosids.csv" --task "demo-csv"
```

The default task root is `./tasks`. Override it with `--tasks-root <dir>`.

## Artifact Layout

```text
tasks/<task-id>/
  raw/<uuid>/full-record/       # <uuid>_<start>_<end>.txt raw WOS export batches
  raw/<uuid>/full-record/author-ascending/   # large UUID A-Z window batches
  raw/<uuid>/full-record/author-descending/  # large UUID Z-A window batches
  raw/<uuid>/bib/               # <uuid>_<start>_<end>.bib raw BibTeX batches
  logs/progress.jsonl
  manifest.json
  summary.json
```

TXT and BibTeX batches are kept as task artifacts. The CLI no longer parses
full-record TXT or page data into SQLite, and it no longer creates or manages a
WOS data SQLite database.

## TXT / WOSID Workflow

```bash
iiaide-wos run --url "https://www.webofscience.com/wos/woscc/summary/<uuid>/..."
```

or:

```bash
iiaide-wos run --uuid "<uuid>" --task "demo-search"
```

`run` downloads raw full-record TXT batches through the injected browser-side
`wos.js` export API. The task is complete when the planned raw `.txt` batches
cover the selected WOS range. Normal reruns of the same task skip existing raw
TXT batches and request only missing ranges.

Useful range options:

```text
--from-index <n>   Start from a 1-based WOS record index
--limit <n>        Process only n WOS records
--batch-size <n>   WOS export API batch size, default 500, max 500
--reuse-raw        Validate existing raw batches before contacting WOS
```

## CSV Import Workflow

Use `import` when a downstream workflow already has a WOSID CSV:

```bash
iiaide-wos import --csv "./input/wosids.csv" --task "demo-csv"
```

The CSV should contain a `wosid` or `UT` column. If no header is present, the
first column is treated as the WOSID column. The imported deliverable is written
to `raw/<task-id>/full-record/<task-id>_wosid.csv`. This command does not call
WOS, create a result-set UUID, or download raw TXT/BibTeX batches. A CSV-backed
raw export workflow should first build a WOS `UT=(...)` query from the CSV IDs,
read that query's UUID and record count, then use the same batch checklist and
resume path as URL/UUID exports.

## BibTeX Workflow

```bash
iiaide-wos bib --uuid "<uuid>" --task "demo-bib"
```

`bib` downloads raw BibTeX batches under `raw/<uuid>/bib/`. The task is
complete when the planned raw `.bib` batches cover the selected WOS range.
Rerunning the same task skips existing raw `.bib` batches and downloads only
missing ranges.

## Task Management

```bash
iiaide-wos list
iiaide-wos workspace
iiaide-wos latest
iiaide-wos show --latest
iiaide-wos path --task "demo-search"
iiaide-wos validate --task "demo-search"
iiaide-wos clear --task "demo-search"
```

Use `--force` only when intentionally replacing CLI-managed task outputs.
`clear` removes a managed task directory and its workspace index entry after
confirmation.

## Interactive Menu

The interactive menu focuses on export, task, settings, and auth work:

```text
1 Download literature
  1.1 UUID - TXT format
  1.2 UUID - BIB format
  1.3 Batch UUID CSV - TXT
3 Task manager
  3.1 New
  3.2 Switch
  3.3 Clear
5 Settings
  5.1 Playwright visible
  5.2 Add SIDs
  5.3 Clear all SIDs
  5.4 Clear dead SIDs
6 Auth producer
  6.1 MUST login
  6.2 MUST monitor
c Check SID
u Update
B Back
q Exit
```

Download workflows run in the current task marked with `*`. Pressing Enter at
the source prompt uses the saved URL/UUID when one exists. If authentication is
missing, the menu asks for the WOS URL/UUID first and only then enters SID
setup. The lightweight startup SID probe treats both an off-domain redirect and
`window.sessionData = undefined` in the WOS shell as fast invalid-SID signals.
When the interactive menu keeps one WOS browser session alive and you start a
download for a different UUID, the CLI rotates to the next saved SID
automatically when more than one saved SID is available.

The batch UUID TXT workflow searches the current working directory recursively
for `uuid.csv` files, reads the whole CSV text, extracts UUID-shaped values by
regex, and de-duplicates them before downloading. Each UUID writes raw TXT
batches under `raw/<uuid>/full-record/` and a `<uuid>_complete.json` marker
when that UUID's planned 500-record batch coverage is complete. UUIDs over
100,000 records are skipped unless large export mode is allowed. Large UUID
exports keep A-Z and Z-A windows under
`raw/<uuid>/full-record/author-ascending/` and
`raw/<uuid>/full-record/author-descending/`; each sort directory has an
`_wos_export_window.json` marker. Future batch runs use the completion marker as
a fast hint, but still validate the raw batch checklist for the recorded window
plan before skipping a UUID; if files are missing, the UUID is resumed instead
of being skipped.
The two-sort large export can cover at most 200,000 records for a UUID.
Batch UUID TXT progress details show the current UUID batch ordinal, total UUID
batches, and remaining UUID batches. The per-UUID TXT export progress uses the
same current/total/remaining batch detail format when it is shown directly.

CLI form:

```bash
iiaide-wos batch-run --task "batch-demo" --search-root "."
```

`--search-root` defaults to the current working directory.

## Authentication And Browser Profile

WOS operations use the workspace-scoped persistent Playwright profile at
`<tasks-root>/.browser-profile`. Non-login work runs headless by default unless
`--headed` or `--playwright-visible on` is set.

SID initialization uses:

```text
https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=<SID>
```

If a saved SID is invalid, interactive workflows offer manual SID input, waiting
for the saved SID pool, or opening a visible WOS login browser.
