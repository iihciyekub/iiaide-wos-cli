# LLM Calling Guide

This guide is for agents that call `iiaide-wos` as a tool. The stable rule is:
parse stdout, ignore stderr unless debugging, and prefer `--json` or `--jsonl`
for machine workflows.

## Output Contract

Commands that support `--json` return one JSON object on stdout:

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
  "data": {}
}
```

On failure, `--json` commands return:

```json
{
  "ok": false,
  "code": "SID_INVALID",
  "command": "query build",
  "taskId": "query-2026",
  "artifact": "",
  "uuid": "",
  "count": 0,
  "message": "Saved SID is invalid",
  "data": {},
  "nextAction": "Run iiaide-wos sid --from-browser --json, or start iiaide-wos auth monitor."
}
```

Progress, browser notices, and warnings go to stderr. Do not parse stderr for
normal control flow.

## Error Codes

```text
OK
INVALID_ARGS
SID_MISSING
SID_INVALID
SID_POOL_EMPTY
WOS_API_MISSING
WOS_QUERY_FAILED
WOS_UUID_MISSING
PLAYWRIGHT_MISSING
TASK_NOT_FOUND
TASK_INCOMPLETE
ARTIFACT_EXISTS
UNKNOWN_ERROR
```

Recommended recovery:

- `SID_MISSING` or `SID_INVALID`: run `iiaide-wos sid --from-browser --json`,
  or start `iiaide-wos auth monitor`.
- `PLAYWRIGHT_MISSING`: run `iiaide-wos install-browser`.
- `WOS_API_MISSING`: verify `import/wos.js` exists or pass `--wosjs`.
- `TASK_NOT_FOUND`: run `iiaide-wos list` and choose an existing task.
- `ARTIFACT_EXISTS`: use a new `--task` or intentionally pass `--force`.

## Intent Recipes

### Build a UUID from a WOS query

```bash
iiaide-wos query build --expr 'PY=(2026)' --task query-2026 --json
```

Read `.uuid` and `.count`. If `.ok` is false, follow `.nextAction`.

### Build many UUIDs from WOS queries

```bash
iiaide-wos query batch --expr-file ./queries.txt --task query-batch --jsonl
```

Put one WOS advanced-search query on each line. Empty lines and lines starting
with `#` are ignored. `--jsonl` emits one JSON envelope per query and keeps one
prepared WOS session for the whole file.

### Download TXT after query

```bash
iiaide-wos query build --expr 'PY=(2026)' --task query-2026 --json
iiaide-wos run --uuid '<uuid>' --task query-2026-txt --json
```

Read `.artifact` from the second command. It points to the raw TXT batch
directory.

### Download BibTeX after query

```bash
iiaide-wos query build --expr 'PY=(2026)' --task query-2026 --json
iiaide-wos bib --uuid '<uuid>' --task query-2026-bib --json
```

Read `.artifact` from the second command. It points to the raw BibTeX batch
directory.

### Resolve citations, references, or related records

```bash
iiaide-wos record relations --wosid 'WOS:000000000000001' --type citations --json
iiaide-wos record relations --wosid 'WOS:000000000000001' --type references --json
iiaide-wos record relations --wosid 'WOS:000000000000001' --type related --json
```

Read `.uuid`, then optionally pass it to `run` or `bib`.

### Build a UUID from IDs or DOI values

```bash
iiaide-wos query ids --csv ./input/ids.csv --task ids-query --json
```

CSV columns may be `wosid`, `UT`, or `doi`.

### Check whether auth is ready

```bash
iiaide-wos check --json
iiaide-wos sid-pool
iiaide-wos workspace
```

Use `check --json` for a direct auth status. `sid-pool` and `workspace` print
JSON status objects.

## Guardrails

- Never echo full SID values in task labels, summaries, or user-visible output.
- Prefer stable task ids generated from user intent, such as `query-2026-txt`.
- Use `--quiet --json` when a command is run inside an agent loop.
- Do not use `--force` unless the user explicitly asked to replace a task.
- For repeated advanced-search queries, prefer `query batch --jsonl` so one CLI
  process and one WOS session handle the full input file.
