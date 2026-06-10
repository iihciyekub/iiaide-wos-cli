# iiaide-wos CLI

iiaide-wos CLI is a task-oriented command-line tool for interacting with the
Web of Science website and turning WOS records into reusable data packages.

The npm package name is `iiaide-wos-cli` and its command is `iiaide-wos`.

It currently supports three input workflows:

1. Provide a WOS summary URL or result-set UUID. The CLI downloads full-record
   data through the WOS web export API and extracts a normalized WOS ID list.
2. Provide an existing CSV containing WOS IDs. The CLI imports and normalizes
   the IDs into a managed task.
3. Provide a WOS summary URL or result-set UUID and download BibTeX batches.

After a workflow creates a task, the CLI can open each WOS full-record page through the injected browser-side `wos.js` helper and cache the structured page JSON by WOSID. The complete task directory can then be archived, shared, or used by downstream tools.

## What The Project Produces

Every workflow is managed as a task under `tasks/<task-id>/`.

```text
tasks/<task-id>/
  raw/<uuid>/full-record/   # <uuid>_<start>_<end>.txt raw WOS export batches
    <uuid>_wosid.csv        # normalized one-column WOS ID index for this UUID
  raw/<uuid>/bib/           # <uuid>_<start>_<end>.bib BibTeX export batches
  raw/wosdata/              # <WOSID>.json parsed full-record page data, shared by UUIDs
  export/<uuid>/bib/
    <uuid>.bib              # combined BibTeX file
  logs/progress.jsonl
  manifest.json
  summary.json
```

The task directory is the deliverable data package. It keeps raw inputs, normalized WOSID indexes, parsed WOS data JSON, progress, failures, and metadata together. If a repeat run finds raw batches but the WOSID index is missing, the CLI rebuilds the missing index locally before attempting another WOS download.

Artifact-producing commands print only the final artifact path on success: `run` and `import` print the WOSID CSV, `bib` prints the combined `.bib`, and `parse` or `parse-pipeline` print the task-level `raw/wosdata` directory.

## Install

Requirements:

- Node.js 20+
- npm
- A Playwright-supported Chromium browser
- A valid WOS session SID for operations that interact with WOS

This is a private GitHub project. Authenticate an account that has repository
access before installing:

```bash
gh auth login
gh auth setup-git
npm install --global github:iihciyekub/iiaide-wos-cli#v0.3.100
npx playwright install chromium
iiaide-wos
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
npx playwright install --with-deps chromium
```

Start the interactive navigator:

```bash
iiaide-wos
```

Show scriptable commands:

```bash
iiaide-wos --help
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
version, run `npx playwright install chromium` after updating.

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

In an interactive terminal, iiaide-wos validates the SID with the canonical WOS
initialization URL and saves it to `tasks/config.json`. Commands that require
WOS authentication use the same workspace Playwright profile at
`tasks/.browser-profile` (profile name: `.browser-profile`); in menu mode the
session stays open while the menu process is alive. Normal WOS work runs in
background headless Playwright mode. If a saved SID is invalid, the CLI opens a
visible WOS browser window for login, detects the fresh SID from the page, saves
it, and then reopens the same profile in background mode before continuing.
Each WOS Playwright context injects the browser-side helper from
`import/wos.js` by default, which provides `window.wos` and
`window.asy_uuid.fetchCurrentPageInfo()` inside WOS pages. Use `--wosjs <file>`
or `WOSJS_PATH` when that helper lives elsewhere.

When the interactive CLI starts, it runs a lightweight SID probe with a
short HTTP timeout. The dashboard shows `Auth yes` only when that probe
confirms the SID. If the saved SID is missing, invalid, or still not
confirmed, the panel shows `Auth no`, then the CLI lets you choose manual SID
input or opening a WOS browser login. The left dashboard logo is highlighted in
color-capable terminals, and the WOS origin URL appears under the left-side
`iiaide-wos CLI` title. Export commands still run the stricter persistent
Playwright validation before downloading. In menu mode, after a SID is entered
manually or detected from a browser login, the CLI saves it and redraws the
workspace dashboard so the refreshed authentication state is visible before the
next workflow prompt.
`iiaide-wos check` first runs the lightweight SID probe; when the SID is
missing, invalid, or cannot be confirmed, it opens a visible WOS browser login,
updates the saved SID, and prints the refreshed status as JSON.

For scripts and CI, prompts are disabled. Supply authentication explicitly:

```bash
iiaide-wos run --sid "YOUR_SID" --uuid "<uuid>"
WOS_SID="YOUR_SID" iiaide-wos parse --task "demo-search"
```

SID sources are checked in this order: explicit `--sid`, `WOS_SID`
environment variable, then `tasks/config.json`. WOS domain sources use the same
lightweight model: pass `--wos-domain access.example.edu`, set `WOS_DOMAIN`, or
use the saved `wosDomain` in `tasks/config.json`. `--base-url` remains available
when a full origin URL is needed.

### 2A. Create A Task From A WOS URL

```bash
iiaide-wos run \
  --url "https://www.webofscience.com/wos/woscc/summary/<uuid>/relevance/1" \
  --task "demo-search" \
  --task-label "Demo WOS search"
```

The CLI downloads field-tagged full records and generates
`tasks/demo-search/raw/<uuid>/full-record/<uuid>_wosid.csv`.

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
The wos.js helper owns WOS request details; the CLI writes task files, combines
the final `.bib`, and displays progress. Incomplete BibTeX batches are not
marked completed. Use `--from-index` and `--limit` for an explicit range.

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

### 3. Parse WOS Data JSON

Starting from a URL or UUID, run the WOSID index step and then parse every WOSID page into shared JSON cache files:

```bash
iiaide-wos parse-pipeline --uuid "<uuid>" --task "demo-search"
```

If the task already has a WOSID CSV, run only the parse stage:

```bash
iiaide-wos parse --task "demo-search"
```

Or parse directly from a local WOSID CSV:

```bash
iiaide-wos parse --csv "./input/wosids.csv" --task "demo-csv"
```

This first normalizes the CSV into
`raw/<task-id>/full-record/<task-id>_wosid.csv`, then parses that WOSID list into
the shared `raw/wosdata` JSON cache.

The parse stage opens each full-record page through the injected browser-side `wos.js` helper:

```js
await wos.record.viewFullRecordByWosId("WOS:000000000000001")
await wos.record.parseCurrentFullRecordPage()
```

Each parsed record is saved once at `raw/wosdata/<WOSID>.json`, so another UUID or imported CSV in the same task can reuse the same WOSID JSON without downloading it again. The result-set WOSID CSV remains the index for that source at `raw/<uuid-or-task-id>/full-record/<uuid-or-task-id>_wosid.csv`.

Useful options:

```text
--limit 20              Process only the first 20 selected WOS IDs
--from-index 101        Start from the 101st WOS ID
--force                 Refetch records that already exist in raw/wosdata
--record-timeout-ms 30000
--cooldown-ms 500       Delay between records
```

In the interactive menu, use `2.1 WOS data`.

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
Interactive downloads reuse the current task by default. If the same UUID is
already completed, iiaide-wos skips SID validation and WOS download, then prints
the existing final artifact path. A different UUID can be appended to the same
task; its raw batches are kept under separate `raw/<uuid>/` directories, while parsed page JSON is shared under `raw/wosdata/`.
At the `WOS summary URL or UUID` prompt, pressing Enter uses the shown saved
source when one exists. Without a saved source, enter a source, press `c` to
return to the menu, or press `q` to exit the CLI.
Authentication status stays in the dashboard instead of being repeated inside
each workflow prompt.
The interactive workflow menu is grouped by command family:

```text
0 Authentication
  0.1 Check SID
1 Download literature
  1.1 UUID - TXT format
  1.2 UUID - BIB format
2 Parse
  2.1 WOS data
3 Task manager
  3.1 New
  3.2 Switch
  3.3 Clear
```

Download workflows run directly in the current task marked with `*`. Use
`0.1 Check SID` when you want to validate the saved SID from the startup panel
and jump straight into browser login if WOS rejects it.
Use
`3.1 New` before downloading when you want a fresh task, `3.2 Switch` to select
an existing task, and `3.3 Clear` to remove an existing managed task.

## Documentation

- [Docs Guide](docs/README.md): what each document is for and when to update it
- [Usage And Data Model](docs/usage.md): user workflows, task lifecycle, and output definitions
- [WOS Curl Reference](docs/curl.md): request-level debugging and export method reference
- [Changelog](CHANGELOG.md): versioned behavior changes

## Current Scope

- The CLI interacts with WOS using a valid user session. It does not perform
  account login or bypass WOS authentication.
- URL/UUID exports use the WOS web export endpoint instead of scrolling the
  virtualized result list.
- Imported CSV tasks do not contain raw WOS full-record export files until
  another command explicitly adds them.
- WOS page structure and export behavior may change, so task logs, raw JSON,
  validation results are retained for troubleshooting.
