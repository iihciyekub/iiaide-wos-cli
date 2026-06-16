# WOS Curl Reference

This file tracks the request-level WOS behavior mirrored by the injected
`import/wos.js` helper.

## SID Initialization

Every browser-backed WOS session starts from:

```text
https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=<SID>
```

The CLI validates session readiness from WOS session signals such as
`window.sessionData.BasicProperties.SID`, not from a blind `networkidle` wait.

## Query And Record UUID Discovery

Browser bridge:

```text
window.wos.query.*
window.wos.record.*
window.wos.results.fetchCurrentPageInfo()
```

Used by:

```bash
iiaide-wos query build --expr "${WOS_QUERY}"
iiaide-wos query batch --expr "${WOS_QUERY_A}" --expr "${WOS_QUERY_B}"
iiaide-wos query batch --expr-file "./queries.txt" --jsonl
iiaide-wos query parse --text "${SEARCH_TEXT}"
iiaide-wos query ids --wosid "${WOS_ID}" --doi "${DOI}"
iiaide-wos record relations --wosid "${WOS_ID}" --type citations
iiaide-wos record shared --wosid "${WOS_ID_A}" --with "${WOS_ID_B}"
```

These commands discover UUID/count metadata only. They do not download raw TXT
or BibTeX.
`query build` prints compact single-line JSON by default and reuses the same
successful task/query text from SQLite unless `--force` is passed. Add `--json`
for the full structured result envelope.
`query batch` prints JSONL by default, accepts repeated `--expr`, and runs
uncached expressions sequentially in the same WOS browser session.

## TXT Export

Browser bridge:

```text
window.wos.export.fetchTxtBatches(options)
```

Used by:

```bash
iiaide-wos run --uuid "${WOS_UUID}"
iiaide-wos batch-run --search-root "."
```

WOS endpoint:

```text
POST /api/wosnx/indic/export/saveToFile
```

The browser helper owns request fields such as `saveToFieldTagged`. The CLI
owns progress, retry, batch filenames, and audit records.

For relation result sets, WOS export may require:

```json
{
  "isRefQuery": "true"
}
```

`run` auto-retries relation-like failures in ref-query mode, and `--ref-query`
forces it from the start.

## BibTeX Export

Browser bridge:

```text
window.wos.export.fetchBibBatches(options)
```

Used by:

```bash
iiaide-wos bib --uuid "${WOS_UUID}"
```

This uses the same WOS export endpoint with a BibTeX action owned by
`import/wos.js`.

## SQLite Ingest

Used by:

```bash
iiaide-wos query ingest --expr "${WOS_QUERY}"
iiaide-wos record ingest --wosid "${WOS_ID}" --type references
iiaide-wos db list --wosid "${WOS_ID}" --type references --context --json
```

Rules:

- export window is records `1-500`
- normal query ingest uses `sortBy=relevance`
- normal query ingest uses `isRefQuery=false`
- citations/references/related ingest uses `isRefQuery=true`
- citations/references/related UUIDs are not treated as directly exportable
  SQLite ingest UUIDs
- relation ingest opens the relation summary in `relevance` order, scrolls and
  collects WOSIDs from at most the first 6 pages, then builds a WOSID/UT query
  and exports that query's full records
- relation UUID metadata is stored with `exportMode=front-scroll-wosid` and
  `uuidDirectExport=false`
- confirmed zero-count relation results are still inserted into
  `wosData.sqlite` with `emptyResult=true` and reused on later runs
- TXT is parsed in memory with `import/WosFieldTags.json`
- structured rows are stored in `.iiaide-wos-cli/wosData.sqlite`
- the same SQLite file also stores audit metadata for command runs, query UUID
  observations, and artifact records
- intermediate TXT/JSON files are not kept

Advanced-search query build safety:

- `query build` avoids clicking the main WOS Search/run button
- it prefers `Add to history`
- when WOS exposes a Search split button, it opens the menu from the arrow icon
  and chooses `Add to history` so history UUID/count metadata is captured

## Local Project Files

Default local state:

```text
.iiaide-wos-cli/project.json
.iiaide-wos-cli/state.json
.iiaide-wos-cli/config.json
.iiaide-wos-cli/index.json
.iiaide-wos-cli/latest
.iiaide-wos-cli/runs/<run-id>/command.json
.iiaide-wos-cli/runs/<run-id>/runtime.jsonl
.iiaide-wos-cli/runs/<run-id>/summary.json
.iiaide-wos-cli/audit/activity.jsonl
.iiaide-wos-cli/audit/searches.jsonl
.iiaide-wos-cli/audit/resultsets.jsonl
.iiaide-wos-cli/audit/artifacts.jsonl
.iiaide-wos-cli/resultsets/<uuid>/raw/full-record/<uuid>_<start>_<end>.txt
.iiaide-wos-cli/resultsets/<uuid>/raw/bib/<uuid>_<start>_<end>.bib
.iiaide-wos-cli/resultsets/<uuid>/exports/bib/<uuid>.bib
.iiaide-wos-cli/resultsets/<uuid-or-project-id>/<uuid-or-project-id>_wosid.csv
.iiaide-wos-cli/wosData.sqlite
```

## Debug Checklist

1. Confirm the SID is current
2. Confirm the UUID came from a WOS summary URL
3. Confirm `import/wos.js` is present
4. Check `.iiaide-wos-cli/runs/<run-id>/runtime.jsonl`
5. Check `.iiaide-wos-cli/runs/<run-id>/summary.json`
6. Check `.iiaide-wos-cli/audit/*.jsonl`
