# WOS Aide CLI

WOS Aide CLI is a task-oriented command-line tool for interacting with the
Web of Science website and turning WOS records into reusable data packages.

The npm package name is `wos-aide-cli` and its command is `wos-aide`.

It currently supports two input workflows:

1. Provide a WOS summary URL or result-set UUID. The CLI downloads full-record
   data through the WOS web export API and extracts a normalized WOS ID list.
2. Provide an existing CSV containing WOS IDs. The CLI imports and normalizes
   the IDs into a managed task.

After either workflow creates a task, the CLI can open each WOS full-record
page and extract author, address, affiliation, email, ResearcherID, ORCID, and
ROR information. The complete task directory can then be archived, shared, or
used by downstream tools.

## What The Project Produces

Every workflow is managed as a task under `tasks/<task-id>/`.

```text
tasks/<task-id>/
  raw/full-record/          # raw WOS export data, when created from URL/UUID
  data/
    wosids.csv              # normalized one-column WOS ID list
    wosids_detailed.csv
    wosids.json
    full_records.txt
  authors/
    raw-json/               # raw page extraction, one file per WOS ID
    normalized-json/        # normalized author hierarchy
    authors.csv             # expanded author/address/affiliation rows
    authors.jsonl
    checkpoint.json         # resume state
    failures.json
  logs/progress.jsonl
  manifest.json
  summary.json
```

The task directory is the deliverable data package. It keeps raw inputs,
normalized outputs, progress, failures, and metadata together.

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
npm install --global github:iihciyekub/wos-aide-cli#v0.3.1
npx playwright install chromium
wos-aide
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
wos-aide
```

Show scriptable commands:

```bash
wos-aide --help
```

## Update

Check the latest stable GitHub Release without changing the installation:

```bash
wos-aide update --check
```

Install the latest stable release:

```bash
wos-aide update
```

The updater installs only published GitHub Release tags, not arbitrary changes
from the main branch. Private release checks automatically use `GH_TOKEN`,
`GITHUB_TOKEN`, or credentials from `gh auth login`. The authenticated account
must retain access to the repository. If a release changes the Playwright
version, run `npx playwright install chromium` after updating.

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
wos-aide init
wos-aide workspace
```

All later commands run from `my-wos-project` use its local Task index,
authentication config, latest-task pointer, and checkpoints. This keeps
downloaded data separate from the CLI source code.

The CLI does not search parent directories for a workspace. Run commands from
the same workspace directory, or explicitly select one:

```bash
wos-aide list --tasks-root "/path/to/my-wos-project/tasks"
```

## Quick Start

### 1. Save WOS Authentication

Open a logged-in Web of Science page and run this in the browser DevTools
Console:

```js
window.sessionData.BasicProperties.SID
```

Validate and save the SID:

```bash
wos-aide sid
```

In an interactive terminal, WOS Aide securely prompts for the SID without
echoing it, validates it against WOS, and saves it to `tasks/config.json`.
Commands that require WOS authentication also prompt automatically when no SID
is available. If a saved SID has expired, the CLI asks for a replacement and
immediately validates and saves the new value.

For scripts and CI, prompts are disabled. Supply authentication explicitly:

```bash
wos-aide run --sid "YOUR_SID" --uuid "<uuid>"
WOS_SID="YOUR_SID" wos-aide authors --task "demo-search"
```

SID sources are checked in this order: explicit `--sid`, `WOS_SID`
environment variable, then `tasks/config.json`.

### 2A. Create A Task From A WOS URL

```bash
wos-aide run \
  --url "https://www.webofscience.com/wos/woscc/summary/<uuid>/relevance/1" \
  --task "demo-search" \
  --task-label "Demo WOS search"
```

The CLI downloads field-tagged full records and generates
`tasks/demo-search/data/wosids.csv`.

### 2B. Create A Task From A WOS UUID

```bash
wos-aide run \
  --uuid "<wos-result-set-uuid>" \
  --task "demo-uuid"
```

### 2C. Create A Task From An Existing WOS ID CSV

The CSV may contain a `wosid` or `UT` column. If neither exists, the first
column is used.

```csv
wosid
WOS:000123456700001
WOS:000123456700002
```

Import and normalize it:

```bash
wos-aide import \
  --csv "./input/wosids.csv" \
  --task "demo-csv" \
  --task-label "Imported WOS IDs"
```

### 3. Extract Author Information

```bash
wos-aide authors --task "demo-search" --concurrency 3
```

The author stage is checkpointed. Running the same command again skips
completed WOS IDs and continues incomplete work.

Useful options:

```text
--limit 20          Process only the first 20 selected WOS IDs
--from-index 101    Start from the 101st WOS ID
--retry-failed      Retry previously failed records
--failed-only       Process only failed records
--force             Refetch completed records
--cooldown-ms 500   Delay between records
```

### 4. Validate And Deliver The Task

```bash
wos-aide validate --task "demo-search"
wos-aide path --task "demo-search"
```

When validation succeeds, the returned task directory can be delivered as a
complete data package.

## Task Management

```bash
wos-aide list
wos-aide workspace
wos-aide latest
wos-aide show --latest
wos-aide path --task "demo-search"
wos-aide validate --task "demo-search"
```

Use a stable `--task` name for work that may be resumed or shared. Use
`--force` only when intentionally replacing CLI-managed task outputs.

## Documentation

- [User Demo](docs/demo.md): complete Chinese walkthrough for URL/UUID and CSV workflows
- [Workflow And Data Model](docs/workflow.md): technical workflow, task lifecycle, and output definitions
- [Changelog](CHANGELOG.md): released and unreleased changes

## Current Scope

- The CLI interacts with WOS using a valid user session. It does not perform
  account login or bypass WOS authentication.
- URL/UUID exports use the WOS web export endpoint instead of scrolling the
  virtualized result list.
- Author extraction opens WOS full-record pages because the required author
  hierarchy is presented there.
- Imported CSV tasks do not contain raw WOS full-record export files until
  another command explicitly adds them.
- WOS page structure and export behavior may change, so task logs, raw JSON,
  checkpoints, and validation results are retained for troubleshooting.
