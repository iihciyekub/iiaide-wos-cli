# WOS Export Tools

Standalone CLI for exporting Web of Science summary-result records through the WOS export API and extracting WOS IDs from the exported `UT` field.

This project is independent of the WOS Aide Codex plugin. It only needs Node.js and Playwright.

Current CLI version: `0.2.0`. `package.json` is the authoritative version source and
`CHANGELOG.md` records released changes.

## Install

```bash
npm install
npm run verify
```

If Playwright browsers are not already installed:

```bash
npx playwright install chromium
```

## Get A SID

Open a logged-in Web of Science page, then run this in DevTools Console:

```js
window.sessionData.BasicProperties.SID
```

Use the returned value as `--sid`. A valid SID is verified and saved to `tasks/config.json`, so later
commands can omit `--sid` until the WOS session expires.

For environments where the SID should not be stored on disk, set `WOS_SID`. The CLI checks an explicit
`--sid` first, then `WOS_SID`, then `tasks/config.json`. Saved config files use owner-only permissions.

Validate and save a SID explicitly:

```bash
node bin/wos-export-wosids.js sid --sid "YOUR_SID"
```

Show the installed version:

```bash
node bin/wos-export-wosids.js --version
```

## Export By Summary URL

```bash
node bin/wos-export-wosids.js \
  run \
  --url "https://www.webofscience.com/wos/woscc/summary/c9e46227-d7e5-40ec-9ee4-df8c4d5e832f-01b7d4b7be/relevance/1" \
  --task-label "IJIR publication title"
```

## Export By UUID

```bash
node bin/wos-export-wosids.js \
  run \
  --uuid "c9e46227-d7e5-40ec-9ee4-df8c4d5e832f-01b7d4b7be"
```

## Task Management

Every export is a task. By default tasks are stored in `./tasks`, and each task has its own raw downloads, derived data, logs, manifest, and summary. If `--task` is omitted, the task id is the creation timestamp, for example `20260606_193742_123`.

```bash
node bin/wos-export-wosids.js list
node bin/wos-export-wosids.js latest
node bin/wos-export-wosids.js show --latest
node bin/wos-export-wosids.js path --task "20260606_112851_c9e46227-d"
node bin/wos-export-wosids.js validate --latest
```

Use a stable task id when you want to rerun or switch predictably:

```bash
node bin/wos-export-wosids.js run \
  --uuid "c9e46227-d7e5-40ec-9ee4-df8c4d5e832f-01b7d4b7be" \
  --task "ijir-title-search" \
  --force
```

For `run`, `--force` starts a clean export and removes the CLI-managed contents of the prior task unless
`--reuse-raw` is also supplied. Unrelated files in a custom `--out-dir` are preserved. `--reuse-raw`
only accepts batches matching the requested UUID and rejects overlapping batch ranges.
For safety, the CLI refuses to clean a custom non-empty output directory unless it contains a manifest
created by this CLI.

## Task Directory

When `--out-dir` is not provided, the CLI creates:

```text
tasks/<task-id>/
  raw/full-record/
    <uuid>_1_200.txt
    <uuid>_201_400.txt
  data/
    wosids.csv
    wosids_detailed.csv
    wosids.json
    full_records.txt
  authors/
    raw-json/
    normalized-json/
    authors.csv
    authors.jsonl
    checkpoint.json
    failures.json
  logs/
    progress.jsonl
  manifest.json
  summary.json
```

`raw/full-record/` is the downloaded literature data from the WOS `saveToFieldTagged` export API. `data/wosids.csv` is the one-column CSV for downstream tools.

## Rebuild From Raw Files

If raw batches already exist and you only want to regenerate CSV/JSON:

```bash
node bin/wos-export-wosids.js \
  run \
  --uuid "c9e46227-d7e5-40ec-9ee4-df8c4d5e832f-01b7d4b7be" \
  --task "ijir-title-search" \
  --reuse-raw \
  --force
```

## Fetch Author Information

After a task has `data/wosids.csv`, fetch author details for every WOS ID:

```bash
node bin/wos-export-wosids.js authors \
  --task "ijir-title-search" \
  --concurrency 3
```

The author stage is checkpointed. Completed WOS IDs are skipped by default, so rerunning the same command continues from the last incomplete record.

Useful options:

```bash
--limit 20          # debug first 20 selected WOS IDs
--from-index 101    # start from 1-based WOSID index
--retry-failed      # retry failed records
--failed-only       # only process failed records
--force             # refetch even completed records
--cooldown-ms 500   # delay between records
```

Author outputs:

```text
tasks/<task-id>/authors/
  raw-json/                 # one raw page extraction JSON per WOSID
  normalized-json/          # one normalized JSON per WOSID
  authors.csv               # aggregate, one author-affiliation record per row
  authors.jsonl             # aggregate, one author-affiliation record per line
  checkpoint.json
  failures.json
```

`normalized-json/<WOSID>.json` keeps the hierarchy as `author -> addressDetails[] -> affiliations[]`.
`authors.csv` expands that hierarchy into one author-address-affiliation record per row. The singular
columns `authorAddressIndex`, `addressNumber`, `address`, `authorInstitutionIndex`, `affiliation`, and
`rorId` describe the expanded row. The old combined `addresses`, `affiliations`, and `rorIds` fields are
kept only in normalized JSON for compatibility and are not exported to the aggregate CSV.

Rebuild normalized JSON and aggregate files from existing raw JSON without opening WOS:

```bash
node bin/wos-export-wosids.js authors \
  --task "ijir-title-search" \
  --rebuild-only
```

Validate a task:

```bash
node bin/wos-export-wosids.js validate --task "ijir-title-search"
```

## Notes

- The CLI does not scrape result pages one by one.
- It opens WOS only to validate the SID and read the summary UUID/count.
- It downloads records through the same WOS export endpoint used by the web app:
  `/api/wosnx/indic/export/saveToFile`
- WOS IDs are parsed from field-tagged full records, specifically the `UT` field.
- `validate` is read-only and does not create missing task directories.
- `runs/` is a legacy output location. New work should use `tasks/`.
