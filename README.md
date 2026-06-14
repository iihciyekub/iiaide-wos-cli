# iiaide-wos CLI

iiaide-wos CLI is a task-oriented command-line tool for interacting with the
Web of Science website and turning WOS exports into reusable data packages.

The npm package name is `iiaide-wos-cli` and its primary command is
`iiaide-wos`. Installed releases also expose `iiw` as a short alias for the
same CLI.

It currently supports three input workflows:

1. Provide a WOS summary URL or result-set UUID. The CLI downloads full-record
   data through the WOS web export API and extracts a normalized WOS ID list.
2. Provide an existing CSV containing WOS IDs. The CLI imports and normalizes
   the IDs into a managed task.
3. Provide a WOS summary URL or result-set UUID and download BibTeX batches.

The complete task directory can then be archived, shared, or used by downstream tools.

## What The Project Produces

Every workflow is managed as a task under `tasks/<task-id>/`.

```text
tasks/<task-id>/
  raw/<uuid>/full-record/   # <uuid>_<start>_<end>.txt raw WOS export batches
  raw/<uuid>/full-record/author-ascending/   # large UUID A-Z window batches
  raw/<uuid>/full-record/author-descending/  # large UUID Z-A window batches
  raw/<uuid>/bib/           # <uuid>_<start>_<end>.bib BibTeX export batches
  logs/progress.jsonl
  manifest.json
  summary.json
```

The task directory is the deliverable data package. It keeps raw inputs, progress, failures, and metadata together. For TXT and BibTeX downloads, the task is complete once the planned raw batch files are present for the selected WOS range.

WOS UUID TXT exports are limited to 400 files per sort window, or 200,000
records at the default 500-record batch size. If a UUID has more than 200,000
records, `run` stops by default and asks before using `--allow-large-export`.
Large TXT export mode downloads the first window as `author-ascending` and the
tail window as `author-descending`, with one overlap batch. Those batches are
kept in separate sort directories, and each directory contains an
`_wos_export_window.json` marker so a resumed run does not confuse A-Z and Z-A
files that share names such as `<uuid>_1_500.txt`.

Artifact-producing commands print only the final artifact path on success: `run` prints the raw TXT batch directory, `bib` prints the raw BibTeX batch directory, and `import` prints the managed WOSID CSV path.

## Install

Requirements:

- Node.js 20+
- npm
- A Playwright Chromium download for this iiaide-wos release
- A valid WOS session SID for operations that interact with WOS

This is a private GitHub project. Authenticate an account that has repository
access before installing:

```bash
gh auth login
gh auth setup-git
npm install --global github:iihciyekub/iiaide-wos-cli#v0.4.74
iiaide-wos install-browser
iiaide-wos
# or
iiw
```

For local development:

```bash
npm install
npm link
npx playwright install chromium
npm run verify
```

On Linux, Chromium system dependencies may also be required:

```bash
iiaide-wos install-browser --with-deps
```

If an interactive WOS command finds Chromium missing, the CLI now offers to run
the bundled browser install for the matching Playwright version instead of
crashing with the upstream `Executable doesn't exist` stack trace.

Start the interactive navigator:

```bash
iiaide-wos
```

Show scriptable commands:

```bash
iiaide-wos --help
# or
iiw --help
```

For request-level debugging examples, see
[docs/curl.md](docs/curl.md).

## Update

Check the latest stable GitHub Release without changing the installation:

```bash
iiaide-wos update --check
```

Install the latest stable release:

```bash
iiaide-wos update
```

The updater installs only published GitHub Release tags, not arbitrary changes
from the main branch. Private release checks automatically use `GH_TOKEN`,
`GITHUB_TOKEN`, or credentials from `gh auth login`. The authenticated account
must retain access to the repository. If a release changes the Playwright
version, run `iiaide-wos install-browser` after updating.

## Uninstall

Remove the globally installed package:

```bash
npm uninstall --global iiaide-wos-cli
```

For a local development link, remove the global link:

```bash
npm unlink --global iiaide-wos-cli
```

## Workspace Isolation

The default task workspace is resolved from the directory where the command is
run, not from the CLI installation directory:

```text
<current-working-directory>/tasks/
```

Create a dedicated workspace outside the CLI source directory:

```bash
mkdir my-wos-project
cd my-wos-project
iiaide-wos init
iiaide-wos workspace
```

All later commands run from `my-wos-project` use its local Task index,
authentication config, latest-task pointer, and checkpoints. This keeps
downloaded data separate from the CLI source code.

The CLI does not search parent directories for a workspace. Run commands from
the same workspace directory, or explicitly select one:

```bash
iiaide-wos list --tasks-root "/path/to/my-wos-project/tasks"
```

## Quick Start

### 1. Save WOS Authentication

Open a logged-in Web of Science page and run this in the browser DevTools
Console:

```js
window.sessionData.BasicProperties.SID
```

Check the saved SID and refresh it in a browser when WOS rejects it:

```bash
iiaide-wos check
```

Validate and save the SID directly:

```bash
iiaide-wos sid
```

Show the current saved SID pool:

```bash
iiaide-wos sid-pool
```

Add saved SID pool values without validating them immediately:

```bash
iiaide-wos settings --add-sids "SID_ONE SID_TWO
SID_THREE"
```

`--add-sid` remains available as a single-value compatibility alias.

Clear every saved SID from the global pool:

```bash
iiaide-wos settings --clear-sids
```

Clear only saved dead-SID history while keeping the live SID pool:

```bash
iiaide-wos settings --clear-dead-sids
```

If you use a MUST institutional account, `auth login` can produce one fresh SID
and write it to the same global pool:

```bash
iiaide-wos auth login --provider must
```

For long-running download work, run a separate monitor process that refills the
pool when it gets low:

```bash
iiaide-wos auth monitor --provider must --min-sids 2 --interval-ms 3000
```

The auth commands use a short-lived Playwright browser that is separate from the
workspace WOS browser profile used for export and validation work. Repeated
`--account` and `--password` pairs rotate across multiple MUST accounts. Prefer
interactive password input or `WOS_ACCOUNT` / `WOS_PASSWORD` over `--password`
because command-line arguments can be visible in shell history and process
lists. `--min-sids` is the SID pool low-water mark: the monitor refreshes when
`sidPoolCount <= min-sids`. If a refresh login fails after reaching the
low-water mark, the monitor waits `--retry-delay-ms` milliseconds before
continuing; the default delay is 60000. Routine auth output masks SID values;
the full SID is only saved in `~/.iiaide-wos/config.json`. The monitor also
writes a small heartbeat at `~/.iiaide-wos/auth-monitor.json`; the
interactive/workspace dashboard shows this as `SID Producer` and marks it stale
when updates stop.

In an interactive terminal, iiaide-wos validates the SID with the canonical WOS
initialization URL and saves it to the global SID pool in
`~/.iiaide-wos/config.json`. SID pool values are user-level, so a SID added from
one directory is available to CLI runs started from other directories.
`iiaide-wos sid-pool` prints the current global SID pool as JSON, including the
active pool position, a masked active SID, and masked saved SID values.
Commands that require WOS authentication use the same workspace Playwright profile at
`tasks/.browser-profile` (profile name: `.browser-profile`); in menu mode the
session stays open while the menu process is alive. Normal WOS work runs in
background headless Playwright mode. Use `iiaide-wos settings
--playwright-visible on` or menu item `5.1 Playwright visible` to save visible
browser mode in `tasks/config.json`; use `off` to return to background mode.
The `--headed` and `--headless` flags remain one-command overrides. If a saved
SID is clearly invalid, the CLI removes that SID from the pool and tries the
next saved SID. It opens a visible WOS browser window for login only after the
pool is empty or no saved SID can be used, detects the fresh SID from the page,
saves it to the pool, and then reopens the same profile in the configured mode
before continuing.
Each WOS Playwright context injects the browser-side helper from
`import/wos.js` by default, which provides `window.wos` and
`window.asy_uuid.fetchCurrentPageInfo()` inside WOS pages. Use `--wosjs <file>`
or `WOSJS_PATH` when that helper lives elsewhere.

When the interactive CLI starts, it runs a lightweight SID probe with a
short HTTP timeout. The dashboard shows `Auth yes` only when that probe
confirms the SID. If the saved SID is missing, invalid, or still not
confirmed, the panel shows `Auth no` but still opens the workflow menu. The
lightweight probe treats both an off-domain redirect and the WOS shell state
`window.sessionData = undefined` as fast invalid-SID signals. SID setup is
requested only when you choose a WOS download workflow that
needs WOS network access. The left dashboard logo is highlighted in
color-capable terminals, and the WOS origin URL appears under the left-side
`iiaide-wos CLI` title. Export commands still run the stricter persistent
Playwright validation before downloading. In menu mode, SID setup offers
`Manual input`, `Wait for SID pool`, and `Open browser login`. Manual entry and
browser detection add the SID to the saved pool; SID pool waiting keeps checking
until another process, such as `auth monitor`, adds one. The CLI then redraws
the workspace dashboard so the refreshed authentication state is visible before
the next workflow prompt. Download workflows prompt for the WOS URL/UUID first
and only then ask for SID setup when authentication is missing. The Settings
menu provides `5.2 Add SIDs` for one or more pasted values and `5.3 Clear all
SIDs` to empty the global SID pool. `5.4 Clear dead SIDs` removes only the
saved invalid-SID history. When the interactive CLI keeps one WOS browser
session alive and you switch to downloading a different UUID, it automatically
rotates to the next saved SID when more than one saved SID is available. The separate `6 Auth producer` group
provides `6.1 MUST login` for one fresh MUST-produced SID and `6.2 MUST
monitor` to keep the current CLI process refilling the pool. Settings, task
management, auth producer, and update workflows can be used while `Auth no` is
shown. The
dashboard shows a masked current SID, the active pool position/count, and `SID
Producer` when an auth monitor heartbeat is available.
`iiaide-wos check` first runs the lightweight SID probe; when the SID is
missing, invalid, or cannot be confirmed, it tries the saved SID pool and, in an
interactive terminal, uses the same SID setup choices. It logs which masked SID
value is currently being validated and still prints only a short safe status
message.

For scripts and CI, prompts are disabled. Supply authentication explicitly:

```bash
iiaide-wos run --sid "YOUR_SID" --uuid "<uuid>"
WOS_SID="YOUR_SID" iiaide-wos bib --uuid "<uuid>" --task "demo-bib"
```

SID sources are checked in this order: explicit `--sid`, `WOS_SID`
environment variable, then the saved SID pool in `~/.iiaide-wos/config.json`. WOS domain
sources use the same lightweight model: pass `--wos-domain access.example.edu`,
set `WOS_DOMAIN`, or use the saved `wosDomain` in `tasks/config.json`.
`--base-url` remains available when a full origin URL is needed.

### 2A. Create A Task From A WOS URL

```bash
iiaide-wos run \
  --url "https://www.webofscience.com/wos/woscc/summary/<uuid>/relevance/1" \
  --task "demo-search" \
  --task-label "Demo WOS search"
```

The CLI downloads field-tagged full records into
`tasks/demo-search/raw/<uuid>/full-record/`. Use `--from-index` and `--limit`
to export a slice of WOS records. Re-running the
same task first reads the WOS record count, converts the selected range into
500-record TXT batch files, then skips any batch file already present on disk
and downloads only the missing files. During long exports, each completed batch
is written to disk immediately, so an interrupted browser session still leaves
resumable raw TXT batches behind. The task is complete once the selected TXT
batch plan is complete. If WOS rejects a TXT export request for
a missing batch, the CLI treats the active SID as expired, removes it from the
saved pool, reopens WOS with the next saved SID, and requests that same missing
batch again.

### 2B. Create A Task From A WOS UUID

```bash
iiaide-wos run \
  --uuid "<wos-result-set-uuid>" \
  --task "demo-uuid"
```

### 2C. Download WOS BibTeX

```bash
iiaide-wos bib \
  --url "https://www.webofscience.com/wos/woscc/summary/<uuid>/relevance/1" \
  --task "demo-bib"
```

BibTeX downloads call the injected browser-side
`window.wos.export.fetchBibBatches` API with the resolved UUID, not the webpage
export overlay. The CLI still initializes WOS with the SID, opens the summary
URL first, and uses the final page-exposed query UUID when WOS provides one.
The wos.js helper owns WOS request details; the CLI writes task files and
displays progress. Re-running the same BibTeX task reads the selected WOS
record range, skips any existing 500-record raw `.bib` batch, and downloads
only missing ranges. The task is complete once the selected raw BibTeX batch
plan is complete. Incomplete BibTeX batch coverage is not marked completed. Use
`--from-index` and `--limit` for an explicit range.

You can also start the batch UUID TXT workflow directly:

```bash
iiaide-wos batch-run --task "batch-demo" --search-root "."
```

`batch-run` recursively searches `--search-root` (default: the current working
directory) for files named `uuid.csv`, extracts UUID-shaped values from their
contents, de-duplicates them, and downloads each UUID through the same
500-record resumable TXT checklist flow used by `run`.

### 2D. Create A Task From An Existing WOS ID CSV

The CSV may contain a `wosid` or `UT` column. If neither exists, the first
column is used.

```csv
wosid
WOS:000123456700001
WOS:000123456700002
```

Import and normalize it:

```bash
iiaide-wos import \
  --csv "./input/wosids.csv" \
  --task "demo-csv" \
  --task-label "Imported WOS IDs"
```

CSV import is local-only: it normalizes an existing WOSID list into the task
artifact layout and does not create a WOS result-set UUID, raw TXT batches, or
BibTeX batches. To download raw WOS TXT or BibTeX from a CSV list, the CLI needs
a separate WOS query-building workflow that submits the IDs as a `UT=(...)`
search, reads the resulting UUID and record count, then follows the same
500-record checklist download path used by URL/UUID tasks.

### 3. Use WOSID CSVs Downstream

The CLI no longer parses full-record TXT or WOSID page data into SQLite. `run` and `bib` now stop at complete raw batch exports; `import` remains available when you want to manage an existing WOSID CSV as a task artifact.

Useful options:

```text
--limit 20              Process only the first 20 selected WOS records
--from-index 101        Start from the 101st WOS record
--force                 Replace managed task outputs when needed
--reuse-raw             Validate existing raw TXT batches before contacting WOS
```

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

Use a stable `--task` name for work that may be resumed or shared. Use
`--force` only when intentionally replacing CLI-managed task outputs.
Use `clear` only when intentionally removing a CLI-managed task directory and
its workspace index entry; before deletion the CLI prints the resolved task id
and requires you to type that exact task id as confirmation.
The interactive CLI always has a current task. On menu startup, iiaide-wos
creates one if the workspace has no current task, shows it in the Current
workspace panel as `Task ID`, and highlights it with a `*` marker in the task
list.
Before prompting for a task, the menu prints a short `Task selection:` hint so
the available inputs are visible before the cursor waits for input.
Interactive downloads reuse the current task by default. If the same UUID has
complete raw TXT coverage for its verified WOS record range, iiaide-wos skips
SID validation and WOS download, then prints the existing final artifact path. A
different UUID can be appended to the same task; its raw batches are kept under
separate `raw/<uuid>/` directories.
After showing the available record count and planned batch count, interactive
TXT and BibTeX downloads start directly.
At the `WOS summary URL or UUID` prompt, pressing Enter uses the shown saved
source when one exists. Without a saved source, enter a source, press `B` to
return to the menu, or press `q` to exit the CLI.
Authentication status stays in the dashboard instead of being repeated inside
each workflow prompt. When `auth monitor` is active, the same panel shows
`SID Producer` beside `SID Pool` so you can see whether the background SID
producer is running, stale, or off. If a WOS workflow needs authentication
while the pool is empty, SID setup offers `Wait for SID pool` so the workflow can
keep checking until an auth monitor or another terminal adds a SID.
The interactive workflow menu is grouped by command family:

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

Download workflows run directly in the current task marked with `*`. Use
`c Check SID` when you want to validate the saved SID from the startup panel
and enter SID setup choices if the saved SID pool has no usable value.
Use `u Update` to install the latest release and restart the interactive CLI.
Use
`3.1 New` before downloading when you want a fresh task, `3.2 Switch` to select
an existing task, and `3.3 Clear` to remove an existing managed task.

`1.3 Batch UUID CSV - TXT` searches the current working directory recursively
for files named `uuid.csv`, extracts UUID-shaped values from their contents, and
downloads TXT batches for each UUID in sequence. Each UUID is treated as its own
resumable subtask under the current task. Completed UUIDs write a small marker
file beside their raw TXT batches, but the CLI still verifies the planned
500-record batch coverage before skipping them, so stale markers do not cause an
incomplete UUID to be skipped.

## Documentation

- [Docs Guide](docs/README.md): what each document is for and when to update it
- [Usage And Data Model](docs/usage.md): user workflows, task lifecycle, and output definitions
- [MUST SID Producer Spec](docs/auth-must.md): integrated MUST SSO auth producer design
- [WOS Curl Reference](docs/curl.md): request-level debugging and export method reference
- [Changelog](CHANGELOG.md): versioned behavior changes

## Current Scope

- WOS export workflows interact with WOS using a valid user session SID. The optional `auth` commands can log into MUST SSO to produce fresh SIDs, but task artifacts do not store account usernames, passwords, or SID values.
- URL/UUID exports use the WOS web export endpoint instead of scrolling the
  virtualized result list.
- Imported CSV tasks do not contain raw WOS full-record export files until
  another command explicitly adds them.
- WOS page structure and export behavior may change, so task logs and raw export batches are retained for troubleshooting.
