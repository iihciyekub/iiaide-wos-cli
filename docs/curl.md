# WOS Curl Reference

This document records the request-level WOS methods that the CLI mirrors through
the browser-injected `import/wos.js` helper. It is for debugging request shape
and implementation parity; normal users should start with `README.md` and
`docs/usage.md`.

## SID Initialization

Every Playwright-backed WOS operation starts from the canonical SID entry URL:

```text
https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=<SID>
```

Domain settings may shape generated summary URLs, but SID login and validation
start from that canonical entry URL.

The CLI also uses a lightweight HTTP probe before opening Playwright. It treats
the SID as quickly invalid when the final response lands off the configured WOS
domain or when the returned WOS shell contains `window.sessionData = undefined`
instead of a populated `BasicProperties.SID`.

## Summary Page Information

CLI methods:

```text
readSummaryInfo()
prepareWosRequestContext()
```

Used by:

```bash
iiaide-wos run --uuid "${WOS_UUID}"
iiaide-wos bib --uuid "${WOS_UUID}"
```

The CLI opens the WOS summary page, injects `import/wos.js`, reads page-exposed
metadata such as the final UUID and record count, and then uses the browser-side
export helper for the actual batch requests.

Summary URL shape:

```bash
curl -L \
  "${WOS_BASE_URL}/wos/woscc/summary/${WOS_UUID}/${WOS_SORT_BY}/1" \
  -o /tmp/wos-summary.html
```

## Full-Record TXT Export

CLI bridge:

```text
exportTxtBatchesViaWosJs() -> window.wos.export.fetchTxtBatches(options)
```

User command:

```bash
iiaide-wos run --uuid "${WOS_UUID}" --batch-size 500
```

Batch UUID TXT command:

```bash
iiaide-wos batch-run --task "batch-demo" --search-root "."
```

WOS endpoint:

```text
POST /api/wosnx/indic/export/saveToFile
```

The browser-side helper owns WOS request details such as `saveToFieldTagged`.
CLI code owns progress display, task logging, deterministic batch filenames,
and raw batch resume planning.

Raw batch naming:

```text
raw/<uuid>/full-record/<uuid>_<start>_<end>.txt
```

## BibTeX Export

CLI bridge:

```text
exportBibBatchesViaWosJs() -> window.wos.export.fetchBibBatches(options)
```

User command:

```bash
iiaide-wos bib --uuid "${WOS_UUID}" --batch-size 500
```

WOS endpoint:

```text
POST /api/wosnx/indic/export/saveToFile
```

The browser-side helper owns WOS request details such as `saveToBibtex`. CLI
code writes raw batch files and resumes from existing raw `.bib` ranges.

Artifact naming:

```text
raw/<uuid>/bib/<uuid>_<start>_<end>.bib
```

## Local-Only Methods

These files are managed locally and do not call WOS request APIs:

```text
tasks/index.json
tasks/latest
tasks/config.json
~/.iiaide-wos/config.json
tasks/<task-id>/manifest.json
tasks/<task-id>/summary.json
tasks/<task-id>/logs/progress.jsonl
tasks/<task-id>/raw/<uuid>/full-record/<uuid>_<start>_<end>.txt
tasks/<task-id>/raw/<uuid>/bib/<uuid>_<start>_<end>.bib
tasks/<task-id>/raw/<uuid-or-task-id>/full-record/<uuid-or-task-id>_wosid.csv (import only)
```

The CLI no longer creates, imports, or manages a WOS data SQLite database.

## Debug Checklist

1. Confirm `WOS_SID` or the saved SID pool contains a current SID.
2. Confirm the UUID is copied from a normal WOS records summary URL.
3. Confirm `import/wos.js` exists or pass an explicit `--wosjs <file>`.
4. Confirm raw batch filenames follow `<uuid>_<start>_<end>.txt` or `.bib`.
5. Check `logs/progress.jsonl`, `manifest.json`, and `summary.json` in the task
   directory before re-running with `--force`.
