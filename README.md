# iiaide-wos CLI

iiaide-wos CLI is a task-oriented command-line tool for interacting with the
Web of Science website and turning WOS records into reusable data packages.

The npm package name is `iiaide-wos-cli` and its primary command is
`iiaide-wos`. Installed releases also expose `iiw` as a short alias for the
same CLI.

It currently supports three input workflows:

1. Provide a WOS summary URL or result-set UUID. The CLI downloads full-record
   data through the WOS web export API and extracts a normalized WOS ID list.
2. Provide an existing CSV containing WOS IDs. The CLI imports and normalizes
   the IDs into a managed task.
3. Provide a WOS summary URL or result-set UUID and download BibTeX batches.

After a workflow creates a task, the CLI can open each WOS full-record page
through the injected browser-side `wos.js` helper and write the structured page
record into the global SQLite database by WOSID. The complete task directory can
then be archived, shared, or used by downstream tools.

## What The Project Produces

Every workflow is managed as a task under `tasks/<task-id>/`.

```text
tasks/<task-id>/
  raw/<uuid>/full-record/   # <uuid>_<start>_<end>.txt raw WOS export batches
    <uuid>_wosid.csv        # normalized one-column WOS ID index for this UUID
  raw/<uuid>/bib/           # <uuid>_<start>_<end>.bib BibTeX export batches
  export/<uuid>/bib/
    <uuid>.bib              # combined BibTeX file
  logs/progress.jsonl
  manifest.json
  summary.json
```

The task directory is the deliverable data package. It keeps raw inputs, normalized WOSID indexes, progress, failures, and metadata together. Parsed WOS data is stored in the global SQLite database. If a repeat run finds raw batches but the WOSID index is missing, the CLI rebuilds the missing index locally before attempting another WOS download.

The CLI also keeps user-level global SQLite files outside task directories:

```text
~/.iiaide-wos/wosdata.sqlite          # parsed WOS page records
~/.iiaide-wos/wos-blacklist.sqlite    # WOSIDs skipped after parse FAIL
```

The WOS data database is built from parsed WOS page data only; raw full-record
`.txt` batches and BibTeX `.bib` files are not imported into SQLite. The parse
blacklist is stored separately so it can be inspected, cleared, or replaced
without touching saved WOS records.

Artifact-producing commands print only the final artifact path on success: `run` and `import` print the WOSID CSV, `bib` prints the combined `.bib`, and `parse`, `parse-pipeline`, or `wosdata` print the SQLite database path.

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
npm install --global github:iihciyekub/iiaide-wos-cli#v0.4.59
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
iiaide-wos settings --add-sid "SID_ONE"
iiaide-wos settings --add-sids "SID_ONE SID_TWO
SID_THREE"
```

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
Use `iiaide-wos settings --parse-concurrency 3` or menu item `5.2 Parse tabs`
to save the default reusable WOS tab count for parse workflows.
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
confirmed, the panel shows `Auth no` but still opens the workflow menu. SID
setup is requested only when you choose a WOS download or parse workflow that
needs WOS network access. The left dashboard logo is highlighted in
color-capable terminals, and the WOS origin URL appears under the left-side
`iiaide-wos CLI` title. Export commands still run the stricter persistent
Playwright validation before downloading. In menu mode, after a SID is entered
manually or detected from a browser login, the CLI adds it to the saved pool and
redraws the workspace dashboard so the refreshed authentication state is visible
before the next workflow prompt. The Settings menu also provides `5.3 Add SID`
for one value and `5.4 Batch add SIDs` for multiple values separated by spaces,
newlines, or commas. Settings, SQLite, task management, and update workflows can
be used while `Auth no` is shown. The dashboard shows a masked current SID and the
active pool position/count.
`iiaide-wos check` first runs the lightweight SID probe; when the SID is
missing, invalid, or cannot be confirmed, it tries the saved SID pool and then
opens a visible WOS browser login if needed. It prints only a short safe status
message.

For scripts and CI, prompts are disabled. Supply authentication explicitly:

```bash
iiaide-wos run --sid "YOUR_SID" --uuid "<uuid>"
WOS_SID="YOUR_SID" iiaide-wos parse --task "demo-search"
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

### 3. Parse WOS Data To SQLite

Starting from a URL or UUID, run the WOSID index step and then parse every missing WOSID page into SQLite:

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
the global SQLite database.

The parse stage opens each full-record page through the injected browser-side `wos.js` helper:

```js
await window.wos.record.viewFullRecordByWosId(targetWosId)
const parsed = await window.wos.record.parseCurrentFullRecordPage()
```

The CLI calls those methods from Playwright `page.evaluate()`. It does not open
WOSID full-record pages by clicking summary-page links or by calling
`page.goto()` for each record; `wos.js` owns the browser-side route change and
page-readiness check.

During parse, each Playwright worker reuses one WOS tab across records and lets
`wos.js` move between full-record pages through WOS front-end routing. With
`--concurrency 3`, for example, the CLI keeps up to three reusable WOS tabs
instead of opening and closing a new tab for every WOSID.
Save that default with `iiaide-wos settings --parse-concurrency 3` or
interactive menu item `5.2 Parse tabs`; explicit `--concurrency <n>` still wins
for one command.

The browser-side `wos.js` opener treats WOSIDs as externally prepared accession
strings. It trims whitespace and can extract the accession segment from a
`/full-record/<id>` URL, but it preserves prefixes such as `PUB:`, `WOS:`, or
`MEDLINE:` without uppercasing or stripping punctuation. CLI CSV/TXT import and
SQLite validation remain responsible for canonicalization and loose ID
comparison.

When the first WOS page shows the Clarivate privacy or cookie banner, the CLI's
persistent Playwright profile now auto-clicks the common OneTrust `Accept all`
or close buttons, and it also recognizes the `Privacy` / `ot-sdk-container`
dialog shell before choosing which button to press. That makes login, summary
export, and parse warm-up pages less likely to stall behind either the
full-banner or close-only cookie variant.

When a saved SID is missing or fails browser validation in an interactive
terminal, the CLI now offers a SID choice first: paste a SID manually or open a
WOS browser login for auto-detection. It no longer forces the visible browser
login path before giving you the manual SID option.

WOSID parsing preserves the accession prefix found in the TXT or CSV input. The
CLI no longer forces parsed IDs into a `WOS:<id>` shape; it validates the
expected TXT/CSV ID against the parsed page ID by comparing both values with
non-alphanumeric characters removed.

Parse failures do not directly invalidate the current SID. If the CLI sees 20
consecutive WOSID page parse failures, it closes the entire current Playwright
context, reconnects with the current SID, and runs
`window.wos.query.buildQuery("AB=<random 4 letters>")` through `wos.js`. If WOS
returns an explicit SID/session `error_code` such as a query-limit,
expired-session, login, or invalid-SID message, the CLI force-closes Playwright
and treats the current SID as invalid. The current SID is removed from the saved
pool even if it was detected from the persistent browser profile, and that SID is
not accepted again during recovery. If no saved SID remains, the current CLI
checks the global SID pool every 10 seconds and resumes parsing automatically as
soon as a new saved SID is added. If another saved SID is already available, or
if the current process inherited `WOS_SID`, the CLI still removes that
environment value before restarting the child CLI process.
Inconclusive browser-side query results such as `unknown error` force-close
Playwright and reconnect with the current SID without deleting it. If
`buildQuery` does not return `error_code`, the consecutive parse-failure counter
resets and the parse continues without changing SID.

The authentication success line includes a masked active SID and pool position, and
parse recovery messages are printed as short multi-line notices so the running
SID, recovery reason, and next action are easier to read.

Individual WOSID page failures are recorded once with the real extraction or
SQLite import error. They are not requeued for retry; 20 consecutive final
parse failures still trigger the WOS `buildQuery` recovery diagnostic described
above.

When a WOSID parse attempt is finally reported as `parse FAIL`, the CLI stores
that WOSID in the separate global SQLite parse blacklist database and skips it
by default on future parse runs. These blacklisted failures still contribute to
the 20-failure SID recovery diagnostic counter. Use
`iiaide-wos wosdata --blacklist` to inspect the list, `iiaide-wos wosdata
--unblacklist <WOSID>` to remove one entry, or `iiaide-wos wosdata
--clear-blacklist` to remove all entries. Add `--retry-blacklist` to a parse
command when you want to deliberately try those WOSIDs again. A successful retry
removes the WOSID from the blacklist.

If WOS opens a full-record page but the DOM structure cannot be parsed, the CLI
falls back to the browser-side single-record export API before marking the WOSID
as failed.

For long parse runs, the CLI now restarts Playwright every 600 parsed WOSIDs by
default, and it also checks RSS memory every 200 WOSIDs so a hot
Chromium renderer can be recycled before memory growth gets out of hand. Use
`--browser-restart-every 0` if you deliberately want one long-lived browser
session, or tune `--max-rss-mb <n>` when you want a stricter or looser memory
cap.
When parse recovery, a manual browser-login SID refresh, or an explicit browser
restart closes Playwright, the CLI now first releases each reusable WOS page to
`about:blank` and then tears down the persistent context so Chromium renderer
memory is less likely to accumulate across long runs.

Before parsing, the CLI checks the global SQLite database and skips WOSIDs that
are already present. The work summary prints aligned multi-line fields for
`dbRecords`, `dbBlacklist`, `db`, and `blacklistDb` before browser work starts,
with highlighted left-hand labels in color terminals, so a wrong database
selection or failed blacklist write is visible before page visits begin. New
full-record page data is validated and
written directly to `~/.iiaide-wos/wosdata.sqlite`; no local WOSID JSON files are
written. To merge records collected in another WOS SQLite database, run:

```bash
iiaide-wos wosdata --merge-db "./shared/other-wosdata.sqlite"
```

Use `--db ./shared/wosdata.sqlite` to choose the target database file. Use `--blacklist-db ./shared/wos-blacklist.sqlite` to choose the parse blacklist database. Database merge reads only SQLite WOS record rows; it does not require raw `.txt` or `.bib` files and does not store WOS usernames, passwords, or SID values. Existing database records are skipped by default; add `--force` to `wosdata --merge-db` to overwrite them after validation. For quick inspection, query one WOSID:

```bash
iiaide-wos wosdata --wosid "WOS:000000000000001"
```

List WOSIDs that parse will skip by default because a prior full-record page
could not yield a usable record:

```bash
iiaide-wos wosdata --blacklist
iiaide-wos wosdata --unblacklist "WOS:000000000000001"
iiaide-wos wosdata --clear-blacklist
```

Blacklist list/remove/clear results include database stats such as
`stats.recordCount` and `stats.blacklistCount`, so clearing the blacklist should
immediately change `stats.blacklistCount` to `0`.

Advanced users can still run read-only `SELECT` statements with `wosdata --query`.

The interactive dashboard shows the active database path, WOSID count,
blacklist database path, blacklist count, and database size at startup.

Useful options:

```text
--limit 20              Process only the first 20 selected WOS IDs
--from-index 101        Start from the 101st WOS ID
--force                 Replace managed task outputs when needed
--reparse-existing      Refetch and overwrite records that already exist in SQLite
--blacklist-db <file>   Use a custom SQLite parse blacklist database
--record-timeout-ms 30000
--cooldown-ms 500       Delay between records
--concurrency 3         Use up to 3 reusable WOS tabs for this parse run
--browser-restart-every 50
--max-rss-mb 1536       Restart between parse chunks once RSS reaches 1536 MB
--retry-blacklist       Retry WOSIDs previously skipped after parse failures
```

In the interactive menu, use `2 WOS IDs to SQL`. Paste either a WOS summary
URL/result-set UUID or a local `.csv` file path; the CLI chooses the matching
parse pipeline automatically and runs with the saved default parse options.

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
`--force` only when intentionally replacing CLI-managed task outputs; use
`--reparse-existing` only when intentionally revisiting WOSIDs already saved in
SQLite.
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
task; its raw batches are kept under separate `raw/<uuid>/` directories, while
parsed page data is shared through the global SQLite database.
After showing the available record count and planned batch count, interactive
TXT and BibTeX downloads start directly.
At the `WOS summary URL or UUID` prompt, pressing Enter uses the shown saved
source when one exists. Without a saved source, enter a source, press `B` to
return to the menu, or press `q` to exit the CLI.
Authentication status stays in the dashboard instead of being repeated inside
each workflow prompt.
The interactive workflow menu is grouped by command family:

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
5 Settings
  5.1 Playwright visible
  5.2 Parse tabs
  5.3 Add SID
  5.4 Batch add SIDs
c Check SID
u Update
B Back
q Exit
```

Download workflows run directly in the current task marked with `*`. Use
`c Check SID` when you want to validate the saved SID from the startup panel
and fall back to browser login if the saved SID pool has no usable value.
Use `2 WOS IDs to SQL` to parse from either a local WOSID CSV or a WOS summary
URL/UUID; `.csv` input runs the CSV path and URL/UUID input runs the WOS export
path first.
Use `4.1 Status` to inspect the global SQLite database, `4.2 Merge database`
to merge another WOS SQLite database, and `4.3 Query WOSID` to enter one WOSID
and print its SQLite record. Merge asks whether existing SQL rows should be
force overwritten; the default is no.
Use `u Update` to install the latest release and restart the interactive CLI.
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
  account login or bypass WOS authentication, and it does not store usernames,
  passwords, or SID values in `wosdata.sqlite`.
- URL/UUID exports use the WOS web export endpoint instead of scrolling the
  virtualized result list.
- Imported CSV tasks do not contain raw WOS full-record export files until
  another command explicitly adds them.
- WOS page structure and export behavior may change, so task logs, SQLite raw
  record payloads, and validation results are retained for troubleshooting.
