# Usage And Data Model

## Product Model

iiaide-wos CLI is built around tasks rather than isolated command outputs.
For request-level equivalents of the WOS methods used by the CLI, see
[`docs/curl.md`](curl.md).

A task represents one complete WOS data-processing job:

```text
input -> normalized WOS IDs -> author extraction -> validated task package
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
tasks/<task-id>/export/<uuid-or-task-id>/full-record/<uuid-or-task-id>_wosid.csv
```

This allows later commands to work independently of how the WOS IDs were
obtained.
When a repeated `run` finds complete raw full-record batches but the normalized
CSV is missing, it rebuilds `export/<uuid>/full-record/<uuid>_wosid.csv`
locally before attempting another WOS download.

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
9. Writes the normalized WOSID CSV under `export/<uuid>/full-record/`,
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

The imported task can immediately be passed to `authors`.

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

## Author Workflow

The `authors` command reads the task's
`export/<uuid-or-task-id>/full-record/<uuid-or-task-id>_wosid.csv` and opens
each WOS full-record page.

For every successfully processed WOS ID it writes:

```text
raw/<uuid>/author/<WOSID>.json
```

It also maintains:

```text
export/<uuid>/author/checkpoint.json
export/<uuid>/author/failures.json
export/<uuid>/author/<uuid>_authors.csv
export/<uuid>/author/<uuid>_authors_simple.csv
export/<uuid>/author/<uuid>_authors.jsonl
```

The raw JSON is the checkpointed page extraction. During aggregation the CLI
normalizes raw JSON in memory into:

```text
record -> authors[] -> addressDetails[] -> affiliations[]
```

The aggregate CSV and JSONL are rebuilt from raw JSON and expand this hierarchy
into one row per author/address/affiliation relationship. The companion
`export/<uuid>/author/<uuid>_authors_simple.csv` keeps only `wosid`,
`authorIndex`, `address`, `affiliation`, `rorId`, and `correspondingAddress`;
rows are included only when at least one of `address`, `affiliation`, `rorId`,
or `correspondingAddress` is non-empty, then duplicate six-column rows are
removed.

Resume behavior:

- Completed records are skipped.
- Failed records are skipped unless `--retry-failed` or `--failed-only` is used.
- `--force` refetches completed records.
- Checkpoint and per-record JSON files are written during processing.
- Aggregate CSV and JSONL files are regenerated at the end.

`--concurrency` opens and processes multiple full-record pages at the same time.
The default is `1`, which is steadier for a single WOS SID and browser profile;
raise it only when you intentionally want multiple tabs.
Each WOSID author page has a separate default `--author-timeout-ms 20000`
deadline. A slow record is marked failed and the batch continues; rerun with
`--failed-only` or `--retry-failed` to revisit failures.
If a full-record page redirects back to `https://www.webofscience.com/wos/`,
the CLI treats that WOSID as having no WOS data, marks it failed immediately,
and does not wait for deeper author-page selectors. Author page extraction does
not wait for WOS `networkidle`; it waits for the first useful signal: author
content or a WOS root redirect.
When 20 author records fail during one run, the CLI pauses for 60 seconds before
continuing. Tune this with `--failure-cooldown-threshold` and
`--failure-cooldown-ms`, or set the threshold to `0` to disable failure
cooldown.
The progress bar advances when records finish, so the visible completion events
still appear one by one. `--from-index 1` is the default scan start for selecting
work; resume still skips checkpointed `completed` records before building the
work queue.

In the interactive `2.1 Author & address` workflow, the CLI shows the
default author options before the pipeline starts:

```text
concurrency=1 | timeout=20000ms | cooldown=250ms | failCool=20/60000ms | from=1 | limit=all | retryFailed=no | failedOnly=no
```

Press Enter to keep defaults, or choose to edit concurrency, per-author timeout,
cooldown, failure cooldown, start index, limit, and retry filters for that run.

## Task Lifecycle

Typical task states:

```text
created/importing/running
completed/incomplete/failed
authors-running
authors-completed/authors-incomplete
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
0 Authentication
  0.1 Check SID
1 Download literature
  1.1 UUID - TXT format
  1.2 UUID - BIB format
2 Export
  2.1 Author & address
3 Task manager
  3.1 New
  3.2 Switch
  3.3 Clear
```

Download workflows run directly in the current task marked with `*`. Use
`0.1 Check SID` to validate the saved SID from the startup panel and go
directly into browser login when WOS rejects it.
Use
`3.1 New` before downloading when you want a fresh task, `3.2 Switch` to select
an existing task, and `3.3 Clear` to remove an existing managed task.

Interactive downloads reuse the current task by default. If the task already
has a completed TXT or BibTeX export for the same UUID, the CLI prints the
existing artifact path and skips SID validation and WOS download. Use `--force`
only when you intentionally want to replace a managed task's existing outputs.
For download workflows, pressing Enter at the `WOS summary URL or UUID` prompt
uses the shown saved source when one exists. If no saved source is available,
enter a source, press `c` to return to the menu, or press `q` to exit the CLI.
Saved task sources are
shown only when they look like a WOS summary URL or UUID, and
SID/authentication state is shown in the dashboard rather than inside each
workflow.

## Task Validation

`validate` is read-only.

For URL/UUID tasks it checks:

- manifest and summary files
- normalized WOS ID outputs
- expected and actual WOS ID counts
- raw WOS export batches
- completed author checkpoint entries and their JSON files
- aggregate author row count

When `authors` starts, it reconciles the checkpoint with existing raw author
JSON files. If checkpoint entries are missing but `raw/<uuid>/author/*.json` or
older `raw/<uuid>/authors/*.json` files exist for the current WOS IDs, those
records are marked completed before any WOS browser work begins. The author
stage also accepts older `data/<uuid>_wosid.csv` inputs when the current
`export/<uuid>/full-record/` CSV is missing.

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
returns the updated result as JSON.

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
validation, summary-page metadata, request-based export calls, and author page
extraction should compose through that profile instead of creating isolated
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

The CLI does not log in to WOS or manage user account credentials.

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

## Uninstall

Remove the globally installed package:

```bash
npm uninstall --global iiaide-wos-cli
```

If an older command package was installed before the rename, remove it too:

```bash
npm uninstall --global wos-aide-cli
```

For a local development link, remove the global link:

```bash
npm unlink --global iiaide-wos-cli
```
