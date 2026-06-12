# WOS Curl Reference

This document mirrors the WOS network methods currently used by iiaide-wos CLI.
It is for debugging, reproducing requests, and keeping future implementations
request-based where possible.

## Variables

Set these before running the examples:

```bash
export WOS_DOMAIN="www.webofscience.com"
export WOS_BASE_URL="https://${WOS_DOMAIN}"
export WOS_SID="your-current-wos-sid"
export WOS_SID_INIT_URL="https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=${WOS_SID}"
export WOS_UUID="01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc"
export WOS_SORT_BY="relevance"
```

For a summary URL such as:

```text
https://www.webofscience.com/wos/woscc/summary/<uuid>/date-descending/1
```

the CLI extracts `<uuid>` and passes it into the injected wos.js export API.
Inside `import/wos.js`, that UUID is used as `parentQid` for WOS export
requests.
Protocol-less copied strings such as
`ofscience.com/wos/woscc/summary/<uuid>/date-descending/1` are normalized the
same way. WOS UUIDs may use either `8-4-4-4-12` or `8-4-4-4-12-10` segments.
Generated summary URLs preserve the pasted sort segment, and after SID
validation they are rebased to the actual WOS origin observed in Playwright.

## Shared Headers

The WOS export endpoint expects a current SID header:

```bash
-H "accept: application/json, text/plain, */*" \
-H "content-type: application/json" \
-H "x-1p-wos-sid: ${WOS_SID}"
```

The browser implementation also sends same-origin credentials. With `curl`,
the SID header is the important part; if WOS rejects the request, pass cookies
from an authenticated browser session with `-b cookies.txt`.

## 1. SID Initialization

CLI method:

```text
validateSid()
```

Purpose:

- Opens WOS with `Init=Yes`.
- Confirms WOS accepts the SID.
- Saves the SID in the user-level global SID pool at
  `~/.iiaide-wos/config.json` after validation.
- Before request-based exports, the CLI then opens the target summary URL so
  the `saveToFile` request runs from an initialized same-origin WOS page.
- The CLI uses the canonical initialization origin
  `https://www.webofscience.com` for this step, even when generated summary
  URLs later use a configured or observed WOS origin.

Curl equivalent:

```bash
curl -L \
  "${WOS_SID_INIT_URL}" \
  -o /tmp/wos-sid-check.html
```

This request can confirm that WOS accepts navigation with the SID, but the CLI's
strict validation still uses Playwright because it reads
`window.sessionData.BasicProperties.SID` from the initialized page.

Startup SID probe:

- The interactive dashboard uses this same initialization URL with a short HTTP
  timeout.
- If the response clearly exposes `sessionData` and the SID, the dashboard shows
  `SID valid`.
- If WOS returns 401/403 or an explicit session-expired page, it shows
  `SID invalid`.
- If WOS returns a generic login page with HTTP 200, it shows
  `SID not confirmed` because the lightweight probe may be missing browser
  cookies. Strict validation is left to the persistent Playwright session used
  by the command that needs WOS.

## 2. Summary Page Information

CLI method:

```text
readSummaryInfo()
```

Used by:

- `iiaide-wos run`
- `iiaide-wos parse-pipeline`

Purpose:

- Opens the WOS summary page.
- Reads the result-set UUID and expected record count from the page.
- Then uses the export API for actual full-record downloads.

Page URL:

```bash
curl -L \
  "${WOS_BASE_URL}/wos/woscc/summary/${WOS_UUID}/${WOS_SORT_BY}/1" \
  -o /tmp/wos-summary.html
```

Important distinction:

- Full-record `run` calls `window.wos.export.fetchTxtBatches` after opening the
  summary page.
- BibTeX `bib` calls `window.wos.export.fetchBibBatches` after opening the
  summary page.
- The curl examples below document the request shape maintained inside
  `import/wos.js`; CLI orchestration no longer hand-builds these export
  requests.

## 3. Full-Record Text Export

CLI method:

```text
exportTxtBatchesViaWosJs() -> window.wos.export.fetchTxtBatches(options)
```

Used by:

```bash
iiaide-wos run --uuid "${WOS_UUID}" --batch-size 200
iiaide-wos parse-pipeline --uuid "${WOS_UUID}" --batch-size 200
```

Endpoint:

```text
POST /api/wosnx/indic/export/saveToFile
```

Action:

```text
saveToFieldTagged
```

Single batch example:

```bash
curl "${WOS_BASE_URL}/api/wosnx/indic/export/saveToFile" \
  -X POST \
  -H "accept: application/json, text/plain, */*" \
  -H "content-type: application/json" \
  -H "x-1p-wos-sid: ${WOS_SID}" \
  --data-raw "{
    \"action\": \"saveToFieldTagged\",
    \"colName\": \"WOS\",
    \"displayTimesCited\": \"true\",
    \"displayUsageInfo\": \"true\",
    \"displayCitedRefs\": \"true\",
    \"filters\": \"fullRecord\",
    \"fileOpt\": \"othersoftware\",
    \"locale\": \"en_US\",
    \"parentQid\": \"${WOS_UUID}\",
    \"sortBy\": \"${WOS_SORT_BY}\",
    \"product\": \"UA\",
    \"markFrom\": \"1\",
    \"markTo\": \"200\",
    \"view\": \"summary\",
    \"isRefQuery\": \"false\"
  }" \
  -o "${WOS_UUID}_1_200.txt"
```

Batch behavior:

- CLI writes raw batches to `raw/<uuid>/full-record/<uuid>_<start>_<end>.txt`.
- Batch file ranges are inclusive. For an explicit `--from-index 400` range,
  existing contiguous raw files such as `<uuid>_400_600.txt` are reused and the
  next WOS export starts at `601`.
- CLI parses `UT` fields from the response text.
- CLI writes a single WOSID CSV to
  `raw/<uuid>/full-record/<uuid>_wosid.csv`.

## 4. WOS BibTeX Export

CLI method:

```text
exportBibBatchesViaWosJs() -> window.wos.export.fetchBibBatches(options)
```

Used by:

```bash
iiaide-wos bib --uuid "${WOS_UUID}" --batch-size 200
```

Endpoint:

```text
POST /api/wosnx/indic/export/saveToFile
```

Action:

```text
saveToBibtex
```

Single batch example:

```bash
curl "${WOS_BASE_URL}/api/wosnx/indic/export/saveToFile" \
  -X POST \
  -H "accept: application/json, text/plain, */*" \
  -H "content-type: application/json" \
  -H "x-1p-wos-sid: ${WOS_SID}" \
  --data-raw "{
    \"parentQid\": \"${WOS_UUID}\",
    \"sortBy\": \"${WOS_SORT_BY}\",
    \"displayTimesCited\": \"true\",
    \"displayCitedRefs\": \"true\",
    \"product\": \"UA\",
    \"colName\": \"WOS\",
    \"displayUsageInfo\": \"true\",
    \"fileOpt\": \"othersoftware\",
    \"action\": \"saveToBibtex\",
    \"markFrom\": \"1\",
    \"markTo\": \"200\",
    \"view\": \"summary\",
    \"isRefQuery\": \"false\",
    \"locale\": \"en_US\",
    \"filters\": \"authorTitleSource\"
  }" \
  -o "${WOS_UUID}_1_200.bib"
```

Request-based rule:

- `iiaide-wos bib` passes the resolved UUID into
  `window.wos.export.fetchBibBatches`.
- If the opened summary page exposes a final query UUID, the CLI passes that
  page UUID into wos.js.
- It does not click the WOS export overlay.
- It does not use summary-page DOM elements to drive the main download path.
- It still opens the summary URL before requesting export data, matching the
  browser-injected `wos.js` flow where `fetch()` runs inside an active WOS page.
- It reads summary metadata through `window.asy_uuid.fetchCurrentPageInfo`
  before downloading so request batches and progress totals can be bounded by
  the real record count.

Batch behavior:

- With `--limit`, the CLI downloads the explicit range.
- Without `--limit`, the CLI uses the WOS summary count as the final record
  index. If the count is unavailable, the command stops instead of guessing the
  final range.
- CLI counts BibTeX entries in each response.
- Raw batches are named by the actual returned range:
  `raw/<uuid>/bib/<uuid>_<start>_<actual-end>.bib`.
- CLI combines all batch files into `export/<uuid>/bib/<uuid>.bib`.

Explicit range example:

```bash
iiaide-wos bib \
  --uuid "${WOS_UUID}" \
  --from-index 1 \
  --limit 200 \
  --batch-size 200
```

Equivalent one-batch curl range:

```bash
curl "${WOS_BASE_URL}/api/wosnx/indic/export/saveToFile" \
  -X POST \
  -H "accept: application/json, text/plain, */*" \
  -H "content-type: application/json" \
  -H "x-1p-wos-sid: ${WOS_SID}" \
  --data-raw "{
    \"parentQid\": \"${WOS_UUID}\",
    \"sortBy\": \"${WOS_SORT_BY}\",
    \"displayTimesCited\": \"true\",
    \"displayCitedRefs\": \"true\",
    \"product\": \"UA\",
    \"colName\": \"WOS\",
    \"displayUsageInfo\": \"true\",
    \"fileOpt\": \"othersoftware\",
    \"action\": \"saveToBibtex\",
    \"markFrom\": \"1\",
    \"markTo\": \"200\",
    \"view\": \"summary\",
    \"isRefQuery\": \"false\",
    \"locale\": \"en_US\",
    \"filters\": \"authorTitleSource\"
  }" \
  -o "${WOS_UUID}_1_200.bib"
```

## 5. WOS Data Full-Record Pages

CLI method:

```text
extractOneRecordInfo()
  -> page.evaluate(targetWosId)
  -> window.wos.record.viewFullRecordByWosId(targetWosId)
  -> window.wos.record.parseCurrentFullRecordPage()
```

Used by:

```bash
iiaide-wos parse --task "<task-id>"
iiaide-wos parse --csv "./input/wosids.csv" --task "<task-id>"
iiaide-wos parse-pipeline --uuid "<uuid>" --task "<task-id>"
```

Page URL shape:

```bash
curl -L \
  "${WOS_BASE_URL}/wos/woscc/full-record/WOS:000123456700001" \
  -o /tmp/wos-full-record.html
```

The path segment after `full-record/` uses the accession prefix from the TXT or
CSV value. The CLI does not force a `WOS:` prefix when the input has another
prefix. Parsed page IDs are validated against the expected input ID after
removing non-alphanumeric characters from both values.

Important distinction:

- Page parsing is browser/page based, not a request-only JSON API path.
- The CLI starts from a WOS page with injected `import/wos.js`, calls
  `window.wos.record.viewFullRecordByWosId(targetWosId)`, then calls
  `window.wos.record.parseCurrentFullRecordPage()` in the page context.
- The CLI does not click summary-page links or `page.goto()` each WOSID record;
  the injected helper owns the browser-side full-record route change and loaded
  page verification.
- Each parse worker reuses one WOS page across records and relies on the
  `wos.js` front-end route helper to move between full-record pages; concurrency
  controls the number of reusable pages.
- Save the default reusable page count with `iiaide-wos settings
  --parse-concurrency <n>` or interactive menu item `5.2 Parse tabs`; explicit
  `--concurrency <n>` still overrides the saved value for one command.
- The browser-side opener treats the input as an externally prepared accession
  string. It trims whitespace and can extract `/full-record/<id>` path segments,
  but it preserves prefixes and punctuation such as `PUB:...`; CLI import and
  SQLite validation own canonicalization and loose comparison.
- CLI validates the structured page data and writes one SQLite row per WOSID to
  `~/.iiaide-wos/wosdata.sqlite`.
- Parse browser restarts now default to every `600` WOSIDs so reusable pages do
  not grow without bound during long runs. Use `--browser-restart-every 0` only
  when you intentionally want one long-lived Playwright session.
- Parse work is split into smaller memory-check chunks. By default the CLI
  checks RSS every `200` WOSIDs, and
  `--max-rss-mb <n>` can force a current-SID reconnect between chunks once RSS
  crosses the configured limit. The default is `4096`; use `0` to disable this
  recycle path.
- Dashboard, `workspace`, and `sid-pool` output mask saved SID values so status
  and troubleshooting commands do not print the full session token.
- On SID refresh, recovery reconnect, or explicit browser restart, the CLI
  releases reusable pages to `about:blank` before closing the persistent
  Playwright context so Chromium renderer memory is less likely to accumulate
  across long parse runs.
- If 20 full-record page parses fail consecutively, the CLI closes Playwright
  and reconnects with the current SID, then runs
  `window.wos.query.buildQuery("AB=<random 4 letters>")`. If that WOS query
  returns an explicit SID/session `error_code`, the CLI force-closes Playwright
  and treats the current SID as invalid. The active SID is removed from the
  saved pool even if it was detected from the persistent browser profile, and
  the restarted command will not accept that same SID again. If no saved SID
  remains during parse recovery, the CLI checks the global SID pool every 10
  seconds and resumes automatically when another process adds a SID. In
  interactive SID setup, the user can also choose manual input, SID pool wait,
  or visible browser login. Inconclusive browser-side results such as `unknown
  error` reconnect with the current SID instead of deleting it.
- The UUID-specific WOSID index remains at
  `raw/<uuid>/full-record/<uuid>_wosid.csv` and is the input list for parse.
- For `parse --csv`, the local CSV is normalized into
  `raw/<task-id>/full-record/<task-id>_wosid.csv` before the same parse stage
  runs.
- If a WOSID already exists in SQLite, `parse` skips it before page navigation.
  Use `parse --reparse-existing` only when those saved rows should be revisited
  and overwritten after validation.
- The parse summary prints aligned multi-line fields with the active SQLite
  `db` path, `dbRecords` count, `dbBlacklist` count, and `blacklistDb` path so a
  wrong database path or missing blacklist write is visible before WOS page
  visits start. Color terminals highlight the left-hand field labels.
- If DOM parsing of an opened full-record page produces no usable record, parse
  falls back to the WOS single-record export API before marking the WOSID failed.
- Every WOSID finally reported as `parse FAIL` is written to the separate global
  SQLite blacklist database `~/.iiaide-wos/wos-blacklist.sqlite` and skipped by
  default on future runs. Use `parse --retry-blacklist` to deliberately retry
  those WOSIDs, or `wosdata --unblacklist <WOSID>` / `wosdata
  --clear-blacklist` to remove saved blacklist entries. Use `--blacklist-db
  <file>` to choose another blacklist database. 20 consecutive final parse
  failures trigger the WOS `buildQuery` SID recovery diagnostic; blacklist
  writes do not reset this counter.
- If that recovery query returns a session/query-limit style `error_code` and
  removing the bad SID empties the saved pool, the current CLI keeps running,
  checks the global SID pool every 10 seconds, and resumes parse automatically
  as soon as a new saved SID is added.
- SQLite aggregation is local-only and global to the user by default at
  `~/.iiaide-wos/wosdata.sqlite`. `iiaide-wos wosdata --merge-db` can merge
  another WOS SQLite database, `wosdata --wosid` can look up one saved WOSID,
  `wosdata --blacklist` can inspect failed WOSIDs skipped by parse, and
  `wosdata --query` can run read-only `SELECT` queries; blacklist
  list/remove/clear results include `blacklistDbPath`, `stats.recordCount`, and
  `stats.blacklistCount`. Parse itself writes directly to SQLite. These local
  SQLite paths do not call WOS request APIs or import raw `.txt`/`.bib` files.

## 6. Local-Only Methods

These commands do not call WOS export APIs:

```bash
iiaide-wos import --csv input.csv --task imported
iiaide-wos list
iiaide-wos show --task imported
iiaide-wos path --task imported
iiaide-wos validate --task imported
iiaide-wos clear --task imported
iiaide-wos workspace
```

They read or write local task artifacts:

```text
tasks/index.json
tasks/latest
tasks/config.json                 # workspace runtime/browser settings
~/.iiaide-wos/config.json         # global SID pool
tasks/<task-id>/manifest.json
tasks/<task-id>/summary.json
tasks/<task-id>/raw/<uuid-or-task-id>/full-record/<uuid-or-task-id>_wosid.csv
tasks/<task-id>/export/<uuid>/bib/<uuid>.bib
~/.iiaide-wos/wosdata.sqlite
```

## 7. Debug Checklist

1. Confirm `WOS_SID` is current.
2. Confirm the UUID is copied from a WOS summary URL.
3. Try a small explicit range first: `markFrom=1`, `markTo=2`.
4. If curl gets 401/403, include authenticated browser cookies with `-b`.
5. If full-record text works but BibTeX fails, compare only the `action` and
   `filters` fields first.
6. If BibTeX returns fewer entries than requested, treat it as the final batch.
