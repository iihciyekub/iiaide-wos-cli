# Workflow

## Inputs

The CLI accepts either:

- a WOS summary URL
- a WOS result-set UUID

It also requires a current SID from an authenticated WOS browser session.
The SID may be supplied through `--sid`, `WOS_SID`, or the owner-readable `tasks/config.json`.

## Process

1. Launch Chromium with Playwright.
2. Open WOS with `?Init=Yes&SrcApp=CR&SID=<SID>`.
3. Verify `window.sessionData.BasicProperties.SID` matches the input SID.
4. Open the summary URL.
5. Read `div[data-ta="search-info"]`:
   - `data-ta-search-info-qid` as UUID
   - `data-ta-search-info-count` as expected record count
6. Call WOS export API in batches:
   - action: `saveToFieldTagged`
   - filters: `fullRecord`
   - view: `summary`
   - markFrom / markTo for record ranges
7. Save each raw export batch under `raw/full-record/`.
8. Parse `UT` lines from the raw field-tagged records.
9. Write `wosids.csv`, `wosids_detailed.csv`, `wosids.json`, `full_records.txt`, and run metadata.

## Author Stage

The `authors` command reads `data/wosids.csv` from a task and opens each WOS full-record page.

For every WOS ID it writes:

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

`normalized-json/<WOSID>.json` keeps the nested structure as `author -> addressDetails[] -> affiliations[]`.
`authors.csv` and `authors.jsonl` are expanded aggregate files: when one author has multiple addresses or
multiple institutions under an address, the author is written as multiple author-address-affiliation rows.
Addresses without affiliation details are still kept as rows with empty `affiliation` and `rorId`.

Default resume behavior:

- completed records are skipped
- failed records are skipped unless `--retry-failed` or `--failed-only` is used
- `--force` refetches records even if they are completed
- checkpoint and per-record JSON are written immediately after each record

To rebuild normalized JSON and aggregate CSV/JSONL from existing raw JSON:

```bash
node bin/wos-export-wosids.js authors \
  --task <task-id> \
  --rebuild-only
```
- aggregate CSV/JSONL are regenerated at the end of each run

Example:

```bash
node bin/wos-export-wosids.js authors \
  --task "ijir-title-search" \
  --concurrency 3
```

## Why This Is More Stable Than Page Scraping

The result list UI is virtualized and can miss cards while scrolling. The export endpoint returns the field-tagged records by record range, so it is not sensitive to page rendering, scroll position, or card visibility.

## Directory Policy

Use the default `./tasks` for normal runs. The CLI creates one task directory per export and never overwrites prior results unless `--force` is used. The default task id is the creation timestamp, such as `20260606_193742_123`.

Use `--task <task-id>` when you want a stable, reusable task name. This is useful for switching between searches or regenerating outputs from existing raw downloads.

Use `--out-dir` only when you need a fixed absolute path. If the directory already has files, pass `--force`.

Use `--reuse-raw` when raw batches already exist and you want to regenerate derived CSV/JSON without calling WOS again.
Raw batches are filtered by result-set UUID. Overlapping ranges are rejected instead of being silently merged.

For export runs, `--force` removes the existing CLI-managed task contents before downloading fresh data,
while preserving unrelated files in a custom output directory. Combining `--force --reuse-raw` preserves
the raw directory and rebuilds derived files from it.

## Task Index

The CLI maintains:

```text
tasks/index.json
tasks/latest
```

Commands:

```bash
node bin/wos-export-wosids.js list
node bin/wos-export-wosids.js latest
node bin/wos-export-wosids.js show --latest
node bin/wos-export-wosids.js path --task <task-id>
node bin/wos-export-wosids.js validate --task <task-id>
```

`validate` is a read-only operation. Task index entries created by version `0.2.0` and later use paths
relative to the tasks root when possible, so a project directory can be moved without invalidating them.

## Development

```bash
npm run verify
node bin/wos-export-wosids.js --version
```

The release version is maintained in `package.json` and documented in `CHANGELOG.md`.
