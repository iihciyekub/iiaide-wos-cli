# iiaide-wos CLI

`iiaide-wos` is a Web of Science automation CLI for query UUID discovery, raw
TXT/BibTeX export, relation traversal, task-level SQLite ingest, and structured
audit logging.

The short alias is `iiw`.

## Project Model

The CLI now uses a single managed project store per working directory:

```text
<your-project>/
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
        raw/bib/<uuid>_<start>_<end>.bib
        exports/bib/<uuid>.bib
    record-relations/
    wosData.sqlite
```

Default commands no longer need `--task`. The current directory name becomes
the managed project id, and all CLI state lives in `./.iiaide-wos-cli/`.

Explicit `--tasks-root` or `--out-dir` still enable legacy multi-task mode for
special cases, but the default and documented path is the single-project mode.

## Quick Start

```bash
mkdir my-wos-project
cd my-wos-project
iiaide-wos init
iiaide-wos workspace
```

Save or validate auth:

```bash
iiaide-wos check
iiaide-wos sid --from-browser --debug
```

Build a query UUID:

```bash
iiaide-wos query build --expr 'PY=(2026)'
```

Default output is compact single-line JSON:

```text
{"uuid":"<uuid>","url":"https://www.webofscience.com/wos/woscc/summary/<uuid>/relevance/1","count":123,"queryText":"PY=(2026)","cached":false}
```

The same task/query text is reused from `.iiaide-wos-cli/wosData.sqlite` by
default and returns `"cached":true`; add `--force` to run WOS again. Use
`--json` when another tool needs the full LLM-style result envelope.

Build many query UUIDs in one browser session:

```bash
iiaide-wos query batch \
  --expr 'TS=("two-dimensional materials") AND PY=(2025)' \
  --expr 'TS=("two-dimensional materials") AND PY=(2026)'
```

`query batch` prints one LLM-readable JSON object per line by default. Cached
queries are returned from `.iiaide-wos-cli/wosData.sqlite`; uncached queries run
sequentially in the same WOS browser session.

`queries.txt` is plain UTF-8 text with one WOS advanced-search expression per
line. Blank lines and lines beginning with `#` are ignored:

```text
# Two-dimensional materials project: compare recent yearly result sets
TS=("two-dimensional materials") AND PY=(2025)
TS=("two-dimensional materials") AND PY=(2026)

# Atomic thickness theory slice
TS=(("two-dimensional materials" OR graphene OR "transition metal dichalcogenide*") AND ("atomic thickness" OR monolayer) AND (theor* OR model* OR simulation*))
```

Download raw TXT:

```bash
iiaide-wos run --uuid "<uuid>"
```

Download raw BibTeX:

```bash
iiaide-wos bib --uuid "<uuid>"
```

Ingest the first 500 relevance-ordered records into SQLite:

```bash
iiaide-wos query ingest --expr 'PY=(2026)' --description "2026 search"
```

Ingest citations/references/related records through the front-end WOSID
collection path:

```bash
iiaide-wos record ingest --wosid "WOS:000000000000001" --type citations
```

Relation ingest collects WOSIDs from at most the first 6 `relevance` pages,
then queries those WOSIDs for full records. The relation UUID is kept as the
result-set identifier and marked as not directly exportable. Confirmed
zero-count relation results are also stored in SQLite, so the same WOSID/type
is not repeatedly queried.

Read stored metadata/context without opening WOS:

```bash
iiaide-wos db uuid --uuid "<uuid>" --json
iiaide-wos db wosid --wosid "WOS:000000000000001" --json
iiaide-wos db list --uuid "<uuid>" --json
iiaide-wos db list --wosid "WOS:000000000000001" --type citations --json
iiaide-wos db list --wosid "WOS:000000000000001" --type references --context --json
iiaide-wos db context --wosid "WOS:000000000000001" --type references --json
iiaide-wos db searches --limit 20 --json
iiaide-wos db artifacts --limit 20 --json
iiaide-wos db runs --limit 20 --json
iiaide-wos db timeline --limit 50 --json
iiaide-wos db audit-html
iiaide-wos db audit-export
```

`db list` is a read-only SQLite lookup. It returns the ordered WOSID list for a
stored UUID or for a stored source WOSID relation (`citations`, `references`,
or `related`). Add `--context` to include stored title, abstract, keywords, and
authors for each WOSID. For confirmed empty relation resultsets it returns
`ok=true` with an empty `wosids` array.

`db list` is a read-only SQLite lookup. It returns the ordered WOSID list for a
stored UUID or for a stored source WOSID relation (`citations`, `references`,
or `related`). Add `--context` to include stored title, abstract, keywords, and
authors for each WOSID.

## Install

Requirements:

- Node.js 20+
- npm
- Playwright Chromium for this release
- Your own valid Web of Science access

Install from GitHub:

```bash
gh auth login
gh auth setup-git
npm install --global github:iihciyekub/iiaide-wos-cli#v0.6.28
iiaide-wos install-browser
```

Local development:

```bash
npm install
npm link
npx playwright install chromium
npm run verify
```

## What Commands Do

- `query *`
  Discover UUIDs from WOS advanced queries, parsed text, IDs, or ingest
  directly into SQLite.
- `record *`
  Discover citations/references/related UUIDs, collect relation WOSIDs, or
  ingest relation records into SQLite through the front-end WOSID collection
  path.
- `run`
  Download raw field-tagged TXT batches only.
- `bib`
  Download raw BibTeX batches only.
- `import`
  Import a WOSID CSV into the managed project.
- `db *`
  Read the local `wosData.sqlite` without starting WOS.
- `workspace`, `list`, `tasks`, `show`, `path`, `validate`, `clear`
  Inspect or manage the current directory's project store.

`run` and `bib` never parse TXT into JSON. `wosData.sqlite` now has two roles:

- audit metadata for command runs, query/result UUIDs, and artifact records
- structured WOS record storage written only by `query ingest` and
  `record ingest`

`db audit-html` starts a small local viewer for audit review. It serves an HTML
page and loads timeline/search/artifact/run data from `wosData.sqlite` over
local AJAX. The same HTML now also includes a paged command-help manual and
collapsible timeline entries. Use the page-level `Sync` button to reload the
latest SQLite audit data while the local server stays open.

`db audit-export` writes a static audit snapshot under
`./.iiaide-wos-cli/audit/reports/<timestamp>/` by default, so one review state
can be archived as standalone HTML/JSON.

## Interactive Menu

Run:

```bash
iiaide-wos
```

The default menu is project-scoped. In normal mode it works against the current
directory's `./.iiaide-wos-cli/` store, reuses one Playwright profile, and
offers:

- UUID TXT export
- UUID BibTeX export
- batch UUID TXT export
- project-data clear
- SID pool and Playwright settings
- MUST login / auth monitor
- command docs shortcut

## Debugging

Use `--debug` on browser-backed commands to print step-level timing and WOS
session progress to stderr:

```bash
iiaide-wos sid --sid "<SID>" --debug
iiaide-wos query build --expr 'PY=(2026)' --debug
```

SID validation timing is reported as `loginElapsedMs=<ms>`.

## Documentation

- [CLI Command Reference](docs/commands.md)
- [Usage And Data Model](docs/usage.md)
- [LLM Calling Guide](docs/llm.md)
- [WOS Curl Reference](docs/curl.md)
- [Static Command Cheatsheet](docs/command-cheatsheet.html)
- [Audit Timeline Viewer Template](docs/audit-view.html)
