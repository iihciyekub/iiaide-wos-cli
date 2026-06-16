# CLI Command Reference

This document is the structured command contract for humans, scripts, and LLM
agents that call `iiaide-wos`. Prefer these commands over scraping terminal
prompts. Use explicit flags, stable `--task` names, and `--json` where the
command supports machine-readable output.

## Calling Rules For Automation

- Run from the intended workspace directory, or pass `--tasks-root <dir>`.
- Use `--task <task-id>` for repeatable jobs. If omitted, artifact commands
  create a timestamp task id.
- Do not pass full SID values through task labels or output files. Use
  `--sid`, `WOS_SID`, or the saved SID pool.
- Expect progress and warnings on stderr. Parse stdout only.
- Query/Record commands print a UUID by default. Add `--json` to get the
  standard LLM envelope `{ ok, code, command, taskId, artifact, uuid, count,
  message, data }`.
- Raw export commands print the final artifact directory/path on stdout.
- Do not use `--force` unless intentionally replacing a CLI-managed task.

## Common Options

```text
--task <id>              Stable task id
--task-label <label>     Human label in task metadata
--tasks-root <dir>       Task workspace root, default ./tasks
--out-dir <dir>          Exact task directory override
--sid <SID>              WOS session SID
--from-browser           Open visible WOS login and detect SID
--wos-domain <domain>    WOS domain for generated URLs
--base-url <url>         WOS origin URL
--wosjs <file>           Browser-side wos.js helper path
--headed                 Show browser window
--headless               Run browser in background
--json                   Machine-readable output where supported
--quiet                  Suppress progress where supported
```

## Query Commands

### `query build`

Build a WOS advanced-search query and return the result-set UUID.

```bash
iiaide-wos query build --expr 'PY=(2026)' --task "query-2026"
iiaide-wos query build --expr 'TS=("large language model") AND PY=(2025)' --json
```

Output:

```text
<uuid>
```

JSON output:

```json
{
  "ok": true,
  "code": "OK",
  "command": "query build",
  "taskId": "query-2026",
  "artifact": "",
  "uuid": "<uuid>",
  "count": 123,
  "message": "WOS UUID resolved",
  "data": {
    "operation": "query build",
    "rowText": "PY=(2026)",
    "source": { "kind": "expr", "value": "PY=(2026)" }
  }
}
```

### `query batch`

Run many WOS advanced-search queries through one prepared WOS session and return
one UUID result per input line.

```bash
iiaide-wos query batch --expr-file "./queries.txt" --task "query-batch"
iiaide-wos query batch --expr-file "./queries.txt" --task "query-batch" --jsonl
iiaide-wos query batch --expr-file "./queries.txt" --task "query-batch" --json
```

Input file format:

```text
# empty lines and comment lines are ignored
PY=(2025)
TS=("large language model") AND PY=(2026)
```

Default stdout prints one successful UUID per line. Failed items are reported on
stderr so scripts can keep stdout as the data channel.

`--jsonl` prints one LLM envelope per query line:

```json
{"ok":true,"code":"OK","command":"query batch","taskId":"query-batch","artifact":"","uuid":"<uuid>","count":123,"message":"WOS UUID resolved","data":{"index":1,"total":2,"expr":"PY=(2025)","operation":"query build","rowText":"PY=(2025)","source":{"kind":"expr","value":"PY=(2025)"}}}
```

`--json` prints one final summary envelope after the whole batch completes.
Use this when the caller wants all item results in one JSON object.

### `query parse`

Ask the WOS search engine to parse search text into a query, open it, and return
the result-set UUID.

```bash
iiaide-wos query parse --text "2026 AI safety papers" --task "query-ai-safety"
iiaide-wos query parse --text "papers about graph neural networks in 2025" --json
```

Use this when the user gave natural search text instead of a WOS advanced query.

### `query ids`

Build a WOS query from WOS IDs and/or DOIs, then return the result-set UUID.

```bash
iiaide-wos query ids --wosid "WOS:000000000000001" --task "query-one-id"
iiaide-wos query ids --wosid "WOS:000000000000001" --doi "10.1000/example" --json
iiaide-wos query ids --csv "./input/ids.csv" --task "query-from-csv"
```

CSV input may contain `wosid`, `UT`, or `doi` columns. If no recognized header
exists, the first column is treated as WOS IDs.

## Record Commands

### `record relations`

Open a relation result set for one WOS record and return its UUID.

```bash
iiaide-wos record relations --wosid "WOS:000000000000001" --type citations --task "citations"
iiaide-wos record relations --wosid "WOS:000000000000001" --type references --json
iiaide-wos record relations --wosid "WOS:000000000000001" --type related --json
```

Allowed `--type` values:

```text
citations
references
related
```

### `record shared`

Open the shared-reference result set between two WOS records and return its
UUID.

```bash
iiaide-wos record shared \
  --wosid "WOS:000000000000001" \
  --with "WOS:000000000000002" \
  --task "shared-refs"
```

## Export Commands

### `run`

Download raw full-record TXT batches for a WOS result-set UUID or summary URL.

```bash
iiaide-wos run --uuid "<uuid>" --task "txt-export"
iiaide-wos run --url "https://www.webofscience.com/wos/woscc/summary/<uuid>/relevance/1" --task "txt-export"
iiaide-wos run --uuid "<uuid>" --from-index 501 --limit 1000 --task "txt-slice"
```

Stdout on success:

```text
tasks/<task-id>/raw/<uuid>/full-record
```

Notes:

- Existing raw batches are skipped when coverage is complete.
- Default batch size is 500 records.
- Large result sets over 100,000 records require `--allow-large-export`.

### `bib`

Download raw BibTeX batches for a WOS result-set UUID or summary URL.

```bash
iiaide-wos bib --uuid "<uuid>" --task "bib-export"
iiaide-wos bib --uuid "<uuid>" --from-index 1 --limit 500 --task "bib-slice"
```

Stdout on success:

```text
tasks/<task-id>/raw/<uuid>/bib
```

### `batch-run`

Recursively find `uuid.csv` files and download TXT batches for each UUID.

```bash
iiaide-wos batch-run --task "batch-demo" --search-root "."
iiaide-wos batch-run --task "batch-large" --search-root "./input" --allow-large-export
```

Stdout on success:

```text
tasks/<task-id>/raw
```

## Import Commands

### `import`

Normalize an existing WOSID CSV into a managed task without contacting WOS.

```bash
iiaide-wos import --csv "./input/wosids.csv" --task "imported-ids"
```

Stdout on success:

```text
tasks/<task-id>/raw/<task-id>/full-record/<task-id>_wosid.csv
```

## Workspace And Task Commands

```bash
iiaide-wos init
iiaide-wos workspace
iiaide-wos list
iiaide-wos latest
iiaide-wos show --task "txt-export"
iiaide-wos show --latest
iiaide-wos path --task "txt-export"
iiaide-wos validate --task "txt-export"
iiaide-wos clear --task "txt-export"
```

Output expectations:

- `init` and `workspace` print JSON status objects.
- `list` prints CSV by default; `list --json` prints the standard LLM envelope
  with `data.tasks`.
- `show` and `validate` print command-specific JSON by default; `--json` wraps
  them in the standard LLM envelope.
- `latest` prints the latest task id.
- `path` prints the task directory.
- `latest --json` and `path --json` print the standard LLM envelope.
- `clear` prints the removed task directory after confirmation.

## Authentication And Settings Commands

```bash
iiaide-wos check
iiaide-wos sid --from-browser
iiaide-wos sid-pool
iiaide-wos settings --add-sids "SID_ONE SID_TWO"
iiaide-wos settings --clear-sids
iiaide-wos settings --clear-dead-sids
iiaide-wos settings --playwright-visible on
```

MUST SID producer:

```bash
iiaide-wos auth login --provider must
iiaide-wos auth monitor --provider must --min-sids 2 --interval-ms 3000
```

Use `auth monitor` when long-running workflows should wait for a refreshed SID
pool instead of manually pasting SIDs.

## Maintenance Commands

```bash
iiaide-wos install-browser
iiaide-wos install-browser --with-deps
iiaide-wos update --check
iiaide-wos update
iiaide-wos --help
iiaide-wos --version
```

Run `install-browser` after a fresh install or when the bundled Playwright
version changes.
