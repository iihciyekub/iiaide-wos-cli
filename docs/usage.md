# Usage And Data Model

## Default Mode

Run the CLI inside a project directory. The CLI creates and reuses one managed
store at:

```text
./.iiaide-wos-cli/
```

That directory is the long-lived project state for searches, exports, audit
logs, browser profile reuse, and SQLite-backed review data.

## Artifact Layout

```text
.iiaide-wos-cli/
  project.json
  state.json
  config.json
  index.json
  latest
  .browser-profile/
  audit/
    activity.jsonl
    searches.jsonl
    resultsets.jsonl
    artifacts.jsonl
  runs/
    RUN<timestamp>-<operation>/
      command.json
      runtime.jsonl
      summary.json
  resultsets/
    <uuid>/
      <uuid>_wosid.csv
      raw/full-record/<uuid>_<start>_<end>.txt
      raw/full-record/author-ascending/
      raw/full-record/author-descending/
      raw/bib/<uuid>_<start>_<end>.bib
      exports/bib/<uuid>.bib
  record-relations/
  wosData.sqlite
```

## Workflow Summary

```text
query/record -> uuid -> raw export or sqlite ingest -> local review / downstream use
```

## Query And Record Workflows

UUID discovery:

```bash
iiaide-wos query build --expr 'PY=(2026)'
iiaide-wos query batch --expr 'PY=(2025)' --expr 'PY=(2026)'
iiaide-wos query batch --expr-file "./queries.txt" --jsonl
iiaide-wos query parse --text "2026 AI safety papers"
iiaide-wos query ids --csv "./input/ids.csv"
iiaide-wos record relations --wosid "WOS:000000000000001" --type references
iiaide-wos record collect --wosid "WOS:000000000000001" --json
iiaide-wos record shared --wosid "WOS:000000000000001" --with "WOS:000000000000002"
```

`query build` prints compact single-line JSON with `uuid`, `url`, `count`,
`queryText`, and `cached`. The same successful task/query text is reused from
SQLite by default; add `--force` when you want WOS queried again.
`query batch` prints JSONL by default and reuses one WOS browser session for
uncached expressions while serving cached expressions directly from SQLite.
For `--expr-file`, use a plain text file with one WOS advanced-search
expression per line; blank lines and `#` comment lines are ignored:

```text
# Two-dimensional materials project: compare recent yearly result sets
TS=("two-dimensional materials") AND PY=(2025)
TS=("two-dimensional materials") AND PY=(2026)

# Atomic thickness theory slice
TS=(("two-dimensional materials" OR graphene OR "transition metal dichalcogenide*") AND ("atomic thickness" OR monolayer) AND (theor* OR model* OR simulation*))
```

SQLite ingest:

```bash
iiaide-wos query ingest --expr 'PY=(2026)' --description "2026 search"
iiaide-wos record ingest --wosid "WOS:000000000000001" --type references
```

Rules:

- `query ingest` uses `isRefQuery=false`
- `record ingest` uses `isRefQuery=true`
- normal query ingest uses `relevance` order
- relation ingest treats citations/references/related UUIDs as front-end result
  sets, not direct export result sets
- confirmed zero-count relation results are stored and reused, so empty
  citations/references/related lookups do not repeat unless `--force` is used
- relation ingest opens the relation result set in `relevance` order, scrolls
  and collects WOSIDs from at most the first 6 pages, then queries those WOSIDs
  to fetch full records
- normal query ingest stores at most the first 500 records; relation ingest
  stores the WOSIDs found in the first 6 relation pages, capped at 500
- relation UUID metadata is marked with `exportMode=front-scroll-wosid` and
  `uuidDirectExport=false` in SQLite

## SQLite Roles

`wosData.sqlite` now stores two different layers:

- audit metadata for command runs, query/result UUID observations, and recorded
  artifact paths
- structured WOS records and ordered result-set items written only by
  `query ingest` and `record ingest`

## TXT And BibTeX Export

TXT:

```bash
iiaide-wos run --uuid "<uuid>"
iiaide-wos run --url "https://www.webofscience.com/wos/woscc/summary/<uuid>/relevance/1"
```

BibTeX:

```bash
iiaide-wos bib --uuid "<uuid>"
iiaide-wos bib --uuid "<relation-uuid>"
```

Useful options:

```text
--from-index <n>
--limit <n>
--batch-size <n>
--ref-query
--reuse-raw
--allow-large-export
```

`run` and `bib` are file-download commands only. They do not parse TXT into
structured records, but their summary/audit metadata is written to
`wosData.sqlite`.
Both commands prepare the WOS summary page before export. When the page context
identifies a citations/references/related result set, the export automatically
uses relation/ref-query mode unless `--ref-query` or `--no-ref-query` is passed.

## CSV Import

```bash
iiaide-wos import --csv "./input/wosids.csv"
```

The imported deliverable is written under:

```text
.iiaide-wos-cli/resultsets/<project-id>/<project-id>_wosid.csv
```

## SQLite Lookup

After ingest:

```bash
iiaide-wos db uuid --uuid "<uuid>" --json
iiaide-wos db wosid --wosid "WOS:000000000000001" --json
iiaide-wos db list --uuid "<uuid>" --json
iiaide-wos db list --wosid "WOS:000000000000001" --type related --context --json
iiaide-wos db context --wosid "WOS:000000000000001" --type self --json
iiaide-wos db context --wosid "WOS:000000000000001" --type citations --json
iiaide-wos db context --wosid "WOS:000000000000001" --type references --json
iiaide-wos db context --wosid "WOS:000000000000001" --type related --json
iiaide-wos db searches --limit 20 --json
iiaide-wos db artifacts --limit 20 --json
iiaide-wos db runs --limit 20 --json
iiaide-wos db timeline --limit 50 --json
iiaide-wos db audit-html
iiaide-wos db audit-export
```

`db context`, `db searches`, `db artifacts`, `db runs`, and `db timeline` also
support `--limit`.

`db audit-html` starts a read-only local HTTP view for the current project and
serves a dynamic HTML timeline backed by `wosData.sqlite`, plus a paged command
manual in the same workspace. The live page includes an icon-only `Sync`
control for reloading the latest SQLite audit data without restarting the
server, while filter changes can still be submitted with Enter. Timeline cards
expose UUID links to the WOS summary page, show the source `Run ID` as a compact
pill, render matching query text as a labeled field/value row, and use compact
local-time badges. The command manual uses a lightweight API-docs-style sidebar,
includes scenario-based recipes for common project workflows, and shows command
examples as code blocks with per-command icon copy buttons.

SQLite audit timestamps are stored as UTC ISO strings for stable ordering and
automation. The audit HTML pages and non-JSON audit lookup commands display
those timestamps in the user's local time zone.

`db audit-export` writes a static snapshot to:

```text
.iiaide-wos-cli/audit/reports/<timestamp>/audit-report.html
.iiaide-wos-cli/audit/reports/<timestamp>/audit-report.json
```

## Project Inspection

```bash
iiaide-wos workspace
iiaide-wos list
iiaide-wos tasks
iiaide-wos latest
iiaide-wos show
iiaide-wos path
iiaide-wos validate
iiaide-wos clear
```

In default mode these all target the current directory's single managed
project. `clear` removes `./.iiaide-wos-cli/` after confirmation.

## Interactive Menu

```bash
iiaide-wos
```

Default menu groups:

```text
1 Download literature
  1.1 UUID - TXT format
  1.2 UUID - BIB format
  1.3 Batch UUID CSV - TXT
3 Project
  3.3 Clear data
5 Settings
  5.1 Playwright visible
  5.2 Add SIDs
  5.4 Clear dead SIDs
6 Auth producer
  6.1 MUST login
  6.2 MUST monitor
```

## Legacy Mode

Passing `--tasks-root` or `--out-dir` enables the old multi-task layout for
special automation cases. The default product direction is the single-project
store in the current directory.
