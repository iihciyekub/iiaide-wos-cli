# Workflow And Data Model

## Product Model

WOS Aide CLI is built around tasks rather than isolated command outputs.

A task represents one complete WOS data-processing job:

```text
input -> normalized WOS IDs -> author extraction -> validated task package
```

Inputs currently supported:

- WOS summary URL
- WOS result-set UUID
- Existing CSV containing WOS IDs

All input methods converge on the same normalized file:

```text
tasks/<task-id>/data/wosids.csv
```

This allows later commands to work independently of how the WOS IDs were
obtained.

## URL And UUID Workflow

The `run` command:

1. Launches Chromium through Playwright.
2. Validates the supplied or saved WOS SID.
3. Opens the WOS summary page.
4. Reads the result-set UUID and expected record count.
5. Calls the WOS `saveToFieldTagged` web export endpoint in batches.
6. Stores every raw batch under `raw/full-record/`.
7. Parses the `UT` field into normalized WOS IDs.
8. Writes normalized data files, metadata, logs, and a summary.

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

## Author Workflow

The `authors` command reads `data/wosids.csv` and opens each WOS full-record
page.

For every successfully processed WOS ID it writes:

```text
authors/raw-json/<WOSID>.json
authors/normalized-json/<WOSID>.json
```

It also maintains:

```text
authors/checkpoint.json
authors/failures.json
authors/authors.csv
authors/authors.jsonl
```

The normalized structure preserves:

```text
record -> authors[] -> addressDetails[] -> affiliations[]
```

The aggregate CSV and JSONL expand this hierarchy into one row per
author/address/affiliation relationship.

Resume behavior:

- Completed records are skipped.
- Failed records are skipped unless `--retry-failed` or `--failed-only` is used.
- `--force` refetches completed records.
- Checkpoint and per-record JSON files are written during processing.
- Aggregate CSV and JSONL files are regenerated at the end.

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

Task commands:

```bash
wos-aide list
wos-aide latest
wos-aide show --latest
wos-aide path --task <task-id>
wos-aide validate --task <task-id>
```

## Task Validation

`validate` is read-only.

For URL/UUID tasks it checks:

- manifest and summary files
- normalized WOS ID outputs
- expected and actual WOS ID counts
- raw WOS export batches
- completed author checkpoint entries and their JSON files
- aggregate author row count

For imported CSV tasks, raw WOS export batches are not required.

## Directory And Replacement Policy

Normal work should use the default `./tasks` directory.

- `./tasks` is relative to the current working directory, not the installed CLI.
- `wos-aide init` explicitly initializes a workspace.
- `wos-aide workspace` shows the active workspace and latest Task.
- The CLI does not search parent directories for a workspace.
- `--tasks-root <dir>` explicitly selects a Task workspace from any directory.
- `--task <id>` creates a stable, reusable task name.
- Without `--task`, a timestamp-based task ID is generated.
- `--out-dir` overrides the task directory.
- `--force` permits replacement of CLI-managed task outputs.
- The CLI refuses to clean any directory without a `wos-aide` manifest.
- `run --reuse-raw --force` preserves raw WOS batches and rebuilds derived files.

## Authentication

Commands that interact with WOS require a current SID:

```text
explicit --sid -> WOS_SID -> tasks/config.json
```

The CLI validates the SID against WOS before use. In an interactive terminal,
missing SIDs are requested with hidden input. If validation reports an expired
or invalid SID, the user can enter a replacement which is immediately
revalidated and saved. Non-interactive environments never prompt and must use
`--sid`, `WOS_SID`, or an existing config.

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

`wos-aide update --check` queries the latest stable GitHub Release.
`wos-aide update` installs that exact release tag globally through npm:

```text
github:iihciyekub/wos-aide-cli#<release-tag>
```

The repository and its Releases are private. Before installing or updating, run
`gh auth login` and `gh auth setup-git`, or provide a `GH_TOKEN`/`GITHUB_TOKEN`
with repository read access. The updater does not install unreleased commits
from the default branch.
