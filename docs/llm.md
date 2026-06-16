# LLM Calling Guide

Use stdout as the data channel and ignore stderr unless debugging.

Default mode is current-directory single-project mode with state under
`./.iiaide-wos-cli/`.

## JSON Envelope

Commands with `--json` return:

```json
{
  "ok": true,
  "code": "OK",
  "command": "query build",
  "taskId": "my-project",
  "artifact": "",
  "uuid": "<uuid>",
  "count": 123,
  "message": "WOS UUID resolved",
  "data": {}
}
```

## Recovery Hints

- `SID_MISSING` / `SID_INVALID`
  Run `iiaide-wos sid --from-browser --json` or start `iiaide-wos auth monitor`
- `PLAYWRIGHT_MISSING`
  Run `iiaide-wos install-browser`
- `WOS_API_MISSING`
  Check `import/wos.js` or pass `--wosjs`
- `TASK_NOT_FOUND`
  Check the current directory's `.iiaide-wos-cli/` state or run `iiaide-wos workspace`
- `ARTIFACT_EXISTS`
  Reuse the current project or pass `--force` only when replacement is intended

## Recipes

Build one UUID:

```bash
iiaide-wos query build --expr 'PY=(2026)' --json
```

For shell pipelines, omit `--json`; `query build` prints compact single-line
JSON with `uuid`, `url`, `count`, `queryText`, and `cached`. Add `--force` only
when the same task/query text should be queried in WOS again instead of reused
from SQLite.

Build many UUIDs:

```bash
iiaide-wos query batch --expr 'PY=(2025)' --expr 'PY=(2026)'
iiaide-wos query batch --expr-file ./queries.txt --jsonl
```

`query batch` prints JSONL by default, one LLM-readable result envelope per
query. Cached expressions return `data.cached=true`; uncached expressions are
resolved sequentially in the same WOS browser session.
The `--expr-file` input is plain UTF-8 text with one WOS advanced-search
expression per line; blank lines and `#` comment lines are ignored.

```text
# Two-dimensional materials project: compare recent yearly result sets
TS=("two-dimensional materials") AND PY=(2025)
TS=("two-dimensional materials") AND PY=(2026)

# Atomic thickness theory slice
TS=(("two-dimensional materials" OR graphene OR "transition metal dichalcogenide*") AND ("atomic thickness" OR monolayer) AND (theor* OR model* OR simulation*))
```

Parse natural language:

```bash
iiaide-wos query parse --text 'recent AI safety papers from 2026' --json
```

Download TXT:

```bash
iiaide-wos run --uuid '<uuid>' --json
```

Download BibTeX:

```bash
iiaide-wos bib --uuid '<uuid>' --json
```

Ingest query results into SQLite:

```bash
iiaide-wos query ingest --expr 'PY=(2026)' --description '2026 search' --json
```

Ingest relation results into SQLite:

```bash
iiaide-wos record ingest --wosid 'WOS:000000000000001' --type references --json
```

For `citations`, `references`, and `related`, relation ingest does not directly
export the relation UUID. It collects WOSIDs from at most the first 6
`relevance` pages, queries those WOSIDs, and stores the full records under the
relation UUID with `exportMode=front-scroll-wosid`. Confirmed zero-count
relation results are stored with `emptyResult=true` and should be treated as
complete.

Read stored metadata/context:

```bash
iiaide-wos db uuid --uuid '<uuid>' --json
iiaide-wos db wosid --wosid 'WOS:000000000000001' --json
iiaide-wos db list --uuid '<uuid>' --context --json
iiaide-wos db list --wosid 'WOS:000000000000001' --type citations --json
iiaide-wos db context --wosid 'WOS:000000000000001' --type references --limit 50 --json
iiaide-wos db searches --limit 50 --json
iiaide-wos db artifacts --limit 50 --json
iiaide-wos db runs --limit 50 --json
iiaide-wos db timeline --limit 100 --json
iiaide-wos db audit-html
iiaide-wos db audit-export
```

Use `db list` when the user wants the ordered WOSID list for a UUID or for one
source WOSID's citations/references/related relation. Add `--context` when the
LLM needs title, abstract, keywords, and authors alongside each WOSID.

Resolve relation UUIDs:

```bash
iiaide-wos record relations --wosid 'WOS:000000000000001' --type citations --json
```

Inspect project status:

```bash
iiaide-wos workspace
iiaide-wos tasks --json
iiaide-wos list --json
```

## Guardrails

- Prefer `--json` or `--jsonl`
- Prefer `query batch` over one CLI process per query
- Do not echo full SID values
- Do not use `--force` unless replacement is intended
- In default mode, do not invent many `--task` names; the working directory is
  already the project boundary
