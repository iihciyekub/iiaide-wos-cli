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
- Saves the SID in `tasks/config.json` after validation.
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
  -> window.wos.record.viewFullRecordByWosId(wosid)
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

Important distinction:

- Page parsing is browser/page based, not a request-only JSON API path.
- The CLI starts from a WOS page with injected `import/wos.js`, calls
  `wos.record.viewFullRecordByWosId()`, then calls
  `wos.record.parseCurrentFullRecordPage()` in the page context.
- CLI writes one structured raw JSON file per WOS ID to
  `raw/wosdata/<WOSID>.json`.
- The UUID-specific WOSID index remains at
  `raw/<uuid>/full-record/<uuid>_wosid.csv` and is the input list for parse.
- For `parse --csv`, the local CSV is normalized into
  `raw/<task-id>/full-record/<task-id>_wosid.csv` before the same parse stage
  runs.
- If a parsed WOSID JSON already exists in `raw/wosdata/`, `parse` skips it
  unless `--force` is set.

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
tasks/config.json
tasks/<task-id>/manifest.json
tasks/<task-id>/summary.json
tasks/<task-id>/raw/<uuid-or-task-id>/full-record/<uuid-or-task-id>_wosid.csv
tasks/<task-id>/export/<uuid>/bib/<uuid>.bib
tasks/<task-id>/raw/wosdata/<WOSID>.json
```

## 7. Debug Checklist

1. Confirm `WOS_SID` is current.
2. Confirm the UUID is copied from a WOS summary URL.
3. Try a small explicit range first: `markFrom=1`, `markTo=2`.
4. If curl gets 401/403, include authenticated browser cookies with `-b`.
5. If full-record text works but BibTeX fails, compare only the `action` and
   `filters` fields first.
6. If BibTeX returns fewer entries than requested, treat it as the final batch.
