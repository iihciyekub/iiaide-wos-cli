# CLI Command Reference

Default mode is current-directory single-project mode. All managed state is
written to `./.iiaide-wos-cli/`.

## Common Options

```text
--sid <SID>
--from-browser
--wos-domain <domain>
--base-url <url>
--wosjs <file>
--headed
--headless
--json
--jsonl
--quiet
--debug
--force
--reuse-raw
```

Legacy-only options:

```text
--task <task-id>
--task-label <label>
--tasks-root <dir>
--out-dir <dir>
```

## Query

```bash
iiaide-wos query build --expr 'PY=(2026)'
iiaide-wos query parse --text "2026 AI safety papers"
iiaide-wos query ids --wosid "WOS:000000000000001"
iiaide-wos query ids --csv "./input/ids.csv"
iiaide-wos query batch --expr 'PY=(2025)' --expr 'PY=(2026)'
iiaide-wos query batch --expr-file "./queries.txt" --jsonl
iiaide-wos query ingest --expr 'PY=(2026)' --description "2026 search"
```

- `query build` prints compact single-line JSON by default:
  `{"uuid":"...","url":"...","count":123,"queryText":"...","cached":false}`
- `query build` reuses the same successful task/query text from SQLite by
  default; pass `--force` to query WOS again
- use `--json` for the full LLM-style machine-readable result envelope
- `query parse` and `query ids` print UUID by default
- `query batch` accepts repeated `--expr` and/or `--expr-file`
- `query batch` prints one LLM-readable JSON object per query line by default;
  `--json` prints one full summary envelope
- uncached `query batch` items run sequentially in one WOS browser session;
  cached items are returned from SQLite without touching WOS
- `--expr-file` points to a plain UTF-8 text file with one WOS advanced-search
  expression per line; blank lines and `#` comment lines are ignored

Example `queries.txt`:

```text
# Two-dimensional materials project: compare recent yearly result sets
TS=("two-dimensional materials") AND PY=(2025)
TS=("two-dimensional materials") AND PY=(2026)

# Atomic thickness theory slice
TS=(("two-dimensional materials" OR graphene OR "transition metal dichalcogenide*") AND ("atomic thickness" OR monolayer) AND (theor* OR model* OR simulation*))
```

- query commands also append structured audit rows to `.iiaide-wos-cli/wosData.sqlite`
- `query ingest` additionally stores parsed WOS records in `.iiaide-wos-cli/wosData.sqlite`
- `query build` uses the advanced-search `Add to history` path and avoids
  clicking the main Search/run button so it can capture history UUID/count
  metadata without jumping straight to a summary page

## Record

```bash
iiaide-wos record relations --wosid "WOS:000000000000001" --type citations
iiaide-wos record collect --wosid "WOS:000000000000001" --json
iiaide-wos record shared --wosid "WOS:000000000000001" --with "WOS:000000000000002"
iiaide-wos record ingest --wosid "WOS:000000000000001" --type references
```

- relation types: `citations`, `references`, `related`
- `record collect` writes relation JSON plus per-relation WOSID CSVs
- record commands also append structured audit rows to `.iiaide-wos-cli/wosData.sqlite`
- `record ingest` collects relation WOSIDs from the first 6 `relevance` pages,
  queries those WOSIDs, and stores parsed WOS records in
  `.iiaide-wos-cli/wosData.sqlite`
- confirmed zero-count relation results are stored as completed SQLite
  resultsets and reused for the same source WOSID/type unless `--force` is used
- relation ingest UUIDs are marked `exportMode=front-scroll-wosid` and
  `uuidDirectExport=false`

## TXT Export

```bash
iiaide-wos run --uuid "<uuid>"
iiaide-wos run --url "https://www.webofscience.com/wos/woscc/summary/<uuid>/relevance/1"
iiaide-wos run --uuid "<uuid>" --from-index 501 --limit 1000
iiaide-wos run --uuid "<relation-uuid>" --ref-query
```

Success stdout:

```text
.iiaide-wos-cli/resultsets/<uuid>/raw/full-record
```

`run` also records export audit metadata in `.iiaide-wos-cli/wosData.sqlite`.

## BibTeX Export

```bash
iiaide-wos bib --uuid "<uuid>"
iiaide-wos bib --uuid "<uuid>" --from-index 1 --limit 500
```

Success stdout:

```text
.iiaide-wos-cli/resultsets/<uuid>/raw/bib
```

`bib` also records export audit metadata in `.iiaide-wos-cli/wosData.sqlite`.

## Batch UUID TXT Export

```bash
iiaide-wos batch-run --search-root "."
iiaide-wos batch-run --search-root "./input" --allow-large-export
```

This recursively finds `uuid.csv` files, reuses one prepared WOS session, and
downloads TXT result sets into the current project's `resultsets/` tree.

## CSV Import

```bash
iiaide-wos import --csv "./input/wosids.csv"
```

Success stdout:

```text
.iiaide-wos-cli/resultsets/<project-id>/<project-id>_wosid.csv
```

`import` also records artifact audit metadata in `.iiaide-wos-cli/wosData.sqlite`.

## SQLite Lookup

```bash
iiaide-wos db uuid --uuid "<uuid>" --json
iiaide-wos db wosid --wosid "WOS:000000000000001" --json
iiaide-wos db list --uuid "<uuid>" --json
iiaide-wos db list --uuid "<uuid>" --context --json
iiaide-wos db list --wosid "WOS:000000000000001" --type citations --json
iiaide-wos db list --wosid "WOS:000000000000001" --type references --context --json
iiaide-wos db context --wosid "WOS:000000000000001" --type self --json
iiaide-wos db context --wosid "WOS:000000000000001" --type references --limit 100 --json
iiaide-wos db searches --limit 50 --json
iiaide-wos db searches --uuid "<uuid>" --json
iiaide-wos db artifacts --limit 50 --json
iiaide-wos db artifacts --uuid "<uuid>" --json
iiaide-wos db runs --limit 50 --json
iiaide-wos db runs --uuid "<uuid>" --json
iiaide-wos db timeline --limit 100 --json
iiaide-wos db timeline --wosid "WOS:000000000000001" --json
iiaide-wos db audit-html
iiaide-wos db audit-html --port 3761 --uuid "<uuid>"
iiaide-wos db audit-export
iiaide-wos db audit-export --format html
iiaide-wos db audit-export --report-dir "./reports/latest-audit" --format both
```

- `db audit-html` is read-only, does not start WOS, and serves a local HTML
  audit viewer backed by `wosData.sqlite`, with integrated command-help pages
- `db audit-export` is read-only, does not start WOS, and writes a static audit
  snapshot from `wosData.sqlite`
- `db list` is read-only and does not start WOS. It returns ordered WOSIDs from
  `resultset_items`; `--context` also joins stored `records` context.
- For confirmed empty relation resultsets, `db list` returns `ok=true`,
  `count=0`, and an empty `wosids` array.

Direct SQLite equivalents:

```sql
-- WOSIDs for a UUID, using its latest ingest run
WITH latest_run AS (
  SELECT run_id
  FROM ingest_runs
  WHERE uuid = '<uuid>'
  ORDER BY finished_at DESC, started_at DESC, run_id DESC
  LIMIT 1
)
SELECT i.position, i.wosid
FROM resultset_items i
WHERE i.uuid = '<uuid>'
  AND i.run_id = (SELECT run_id FROM latest_run)
ORDER BY i.position
LIMIT 500;

-- Relation UUIDs linked to a source WOSID
SELECT uuid, kind, available_count, last_ingested_count, last_seen_at
FROM resultsets
WHERE source_wosid = 'WOS:000000000000001'
  AND kind IN ('citations', 'references', 'related')
ORDER BY kind, last_seen_at DESC;
```

## Project Commands

```bash
iiaide-wos init
iiaide-wos workspace
iiaide-wos list
iiaide-wos tasks
iiaide-wos latest
iiaide-wos show
iiaide-wos path
iiaide-wos validate
iiaide-wos clear
```

Notes:

- `tasks` and `list` are read-only views
- `latest` prints the current project id in default mode
- `clear` removes the managed project store after confirmation

## Output Rules

- `--json` commands return one JSON object on stdout
- `--jsonl` batch commands return one JSON object per line
- progress/debug goes to stderr
- `run`, `bib`, and `import` print artifact paths on stdout
