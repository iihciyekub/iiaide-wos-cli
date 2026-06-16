const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const cli = require("../src/iiaide-wos");
const playwrightInstall = require("../src/lib/playwright-install");
const { readJson, writeJson } = require("../src/lib/io");
const { errorCode, llmErrorResult, llmResult } = require("../src/lib/llm-output");
const { askSidFromBrowserOrManual, currentTaskSelection, formatBytes, formatRuntime, isLikelySidInput, isWosSourceLike, listTaskHints, openUrl, printHeader, resolveTaskSelection, taskPromptHelp, taskSelectionHint } = require("../src/lib/interactive");
const { createProgress, createSpinner } = require("../src/lib/terminal");
const { callWosBrowserApi } = require("../src/lib/wos-browser-bridge");
const { normalizeBatchResult } = require("../src/lib/wos-browser-export");
const { wosIdsEquivalent } = require("../src/lib/wos-ids");
const { formatUuidDebug, normalizeUuidError, normalizeUuidResult, publicResult, queryTextForIds } = require("../src/lib/wos-query-record");
function temporaryDirectory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iiaide-wos-test-"));
  process.env.IIAIDE_WOS_CONFIG = path.join(root, "global-config.json");
  return root;
}

function writeProjectMarker(taskDir) {
  writeJson(path.join(taskDir, "project.json"), {
    command: "iiaide-wos",
    kind: "wos-project",
  });
}

function firstRunDir(taskDir) {
  const runsDir = path.join(taskDir, "runs");
  const [runId] = fs.readdirSync(runsDir).sort();
  return path.join(runsDir, runId);
}

test("rejects unsafe task IDs and malformed option values", () => {
  assert.throws(
    () => cli.parseArgs(["node", "cli", "run", "--uuid", "abc", "--task", ".."]),
    /Invalid task id/
  );
  assert.throws(
    () => cli.parseArgs(["node", "cli", "run", "--uuid", "abc", "--batch-size", "nope"]),
    /Invalid integer/
  );
  assert.throws(
    () => cli.parseArgs(["node", "cli", "run", "--sid", "--uuid", "abc"]),
    /Missing value/
  );
  assert.throws(
    () => cli.parseArgs(["node", "cli", "wosdata", "--json-dir", "old-json"]),
    /Unknown argument: --json-dir/
  );
  assert.throws(
    () => cli.parseArgs(["node", "cli", "run", "--uuid", "abc", "--task", "???"]),
    /Invalid task id/
  );
});

test("places named tasks inside tasks root", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "run", "--uuid", "abc", "--task", "safe", "--tasks-root", root]);
  assert.equal(args.outDir, path.join(root, "safe"));
});

test("defaults to a single managed project store in the current directory", () => {
  const args = cli.parseArgs(["node", "cli", "run", "--uuid", "abc"]);
  assert.equal(args.projectMode, true);
  assert.equal(args.tasksRoot, path.join(process.cwd(), ".iiaide-wos-cli"));
  assert.equal(args.outDir, path.join(process.cwd(), ".iiaide-wos-cli"));
  assert.equal(args.taskId, path.basename(process.cwd()));
});

test("parses BibTeX export tasks", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "bib", "--uuid", "abc", "--task", "refs", "--tasks-root", root]);
  assert.equal(args.command, "bib");
  assert.equal(args.url, "https://www.webofscience.com/wos/woscc/summary/abc/relevance/1");
  assert.equal(args.outDir, path.join(root, "refs"));
  const refArgs = cli.parseArgs(["node", "cli", "run", "--uuid", "abc", "--ref-query", "--task", "ref", "--tasks-root", root]);
  assert.equal(refArgs.refQuery, true);
  const normalArgs = cli.parseArgs(["node", "cli", "run", "--uuid", "abc", "--no-ref-query", "--task", "normal", "--tasks-root", root]);
  assert.equal(normalArgs.refQuery, false);
});

test("parses batch UUID TXT tasks", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "batch-run", "--task", "batch-demo", "--tasks-root", root]);
  assert.equal(args.command, "batch-run");
  assert.equal(args.outDir, path.join(root, "batch-demo"));
  assert.equal(args.searchRoot, process.cwd());
  const quietArgs = cli.parseArgs(["node", "cli", "batch-run", "--task", "batch-demo", "--tasks-root", root, "--quiet"]);
  assert.equal(quietArgs.quiet, true);
  assert.equal(quietArgs.authQuiet, true);
});

test("parses Query and Record command families", () => {
  const root = temporaryDirectory();
  const queryArgs = cli.parseArgs(["node", "cli", "query", "build", "--expr", "PY=(2026)", "--task", "q1", "--tasks-root", root]);
  assert.equal(queryArgs.command, "query");
  assert.equal(queryArgs.queryCommand, "build");
  assert.equal(queryArgs.queryExpr, "PY=(2026)");
  assert.equal(queryArgs.outDir, path.join(root, "q1"));

  const debugArgs = cli.parseArgs(["node", "cli", "query", "build", "--expr", "PY=(2026)", "--debug", "--task", "q-debug", "--tasks-root", root]);
  assert.equal(debugArgs.debug, true);

  const batchArgs = cli.parseArgs(["node", "cli", "query", "batch", "--expr-file", "queries.txt", "--jsonl", "--task", "qb1", "--tasks-root", root]);
  assert.equal(batchArgs.command, "query");
  assert.equal(batchArgs.queryCommand, "batch");
  assert.equal(batchArgs.queryExprFile, path.resolve("queries.txt"));
  assert.equal(batchArgs.jsonl, true);
  assert.equal(batchArgs.outDir, path.join(root, "qb1"));

  const inlineBatchArgs = cli.parseArgs([
    "node", "cli", "query", "batch",
    "--expr", "PY=(2025)",
    "--expr", "PY=(2026)",
    "--task", "qb-inline",
    "--tasks-root", root,
  ]);
  assert.deepEqual(inlineBatchArgs.queryExprs, ["PY=(2025)", "PY=(2026)"]);
  assert.equal(inlineBatchArgs.queryExpr, "PY=(2026)");
  assert.deepEqual(cli.readQueryBatchExpressions(inlineBatchArgs), ["PY=(2025)", "PY=(2026)"]);

  const ingestArgs = cli.parseArgs(["node", "cli", "query", "ingest", "--expr", "PY=(2026)", "--description", "recent papers", "--task", "qi1", "--tasks-root", root]);
  assert.equal(ingestArgs.command, "query");
  assert.equal(ingestArgs.queryCommand, "ingest");
  assert.equal(ingestArgs.queryExpr, "PY=(2026)");
  assert.equal(ingestArgs.semanticDescription, "recent papers");

  const recordArgs = cli.parseArgs(["node", "cli", "record", "relations", "--wosid", "WOS:ABC", "--type", "citations", "--task", "r1", "--tasks-root", root]);
  assert.equal(recordArgs.command, "record");
  assert.equal(recordArgs.recordCommand, "relations");
  assert.deepEqual(recordArgs.wosIds, ["WOS:ABC"]);
  assert.equal(recordArgs.relationType, "citations");

  const recordIngestArgs = cli.parseArgs(["node", "cli", "record", "ingest", "--wosid", "WOS:ABC", "--type", "references", "--task", "ri1", "--tasks-root", root]);
  assert.equal(recordIngestArgs.command, "record");
  assert.equal(recordIngestArgs.recordCommand, "ingest");
  assert.equal(recordIngestArgs.relationType, "references");

  const dbArgs = cli.parseArgs(["node", "cli", "db", "context", "--wosid", "WOS:ABC", "--type", "ref", "--task", "db1", "--tasks-root", root]);
  assert.equal(dbArgs.command, "db");
  assert.equal(dbArgs.dbCommand, "context");
  assert.equal(dbArgs.relationType, "ref");

  const dbListArgs = cli.parseArgs(["node", "cli", "db", "list", "--wosid", "WOS:ABC", "--type", "citations", "--context", "--task", "db1", "--tasks-root", root]);
  assert.equal(dbListArgs.command, "db");
  assert.equal(dbListArgs.dbCommand, "list");
  assert.equal(dbListArgs.context, true);

  const auditHtmlArgs = cli.parseArgs(["node", "cli", "db", "audit-html", "--task", "db1", "--tasks-root", root, "--port", "0"]);
  assert.equal(auditHtmlArgs.command, "db");
  assert.equal(auditHtmlArgs.dbCommand, "audit-html");
  assert.equal(auditHtmlArgs.port, 0);

  const auditExportArgs = cli.parseArgs(["node", "cli", "db", "audit-export", "--task", "db1", "--tasks-root", root, "--format", "html", "--report-dir", "./tmp-report"]);
  assert.equal(auditExportArgs.command, "db");
  assert.equal(auditExportArgs.dbCommand, "audit-export");
  assert.equal(auditExportArgs.outputFormat, "html");
  assert.equal(auditExportArgs.reportDir, path.resolve("tmp-report"));

  const collectArgs = cli.parseArgs(["node", "cli", "record", "collect", "--wosid", "WOS:ABC", "--types", "references,related", "--pages", "12", "--task", "rc1", "--tasks-root", root]);
  assert.equal(collectArgs.command, "record");
  assert.equal(collectArgs.recordCommand, "collect");
  assert.deepEqual(collectArgs.relationTypes, ["references", "related"]);
  assert.equal(collectArgs.pages, 12);
});

test("help output groups command families for automation", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "iiaide-wos.js"), "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Command groups:/);
  assert.doesNotMatch(result.stdout, /iiaide-wos query smart/);
  assert.match(result.stdout, /Query UUID discovery:/);
  assert.match(result.stdout, /Record relation UUID discovery:/);
  assert.match(result.stdout, /SQLite lookup:/);
  assert.match(result.stdout, /iiaide-wos tasks/);
  assert.match(result.stdout, /iiaide-wos record collect --wosid <id>/);
  assert.match(result.stdout, /Output conventions:/);
  assert.match(result.stdout, /docs\/commands\.md/);
});

test("query smart command is not supported", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "iiaide-wos.js"), "query", "smart", "--text", "AI safety papers"], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown query command: smart/);
});

test("documentation guide links the structured command reference", () => {
  const docsReadme = fs.readFileSync(path.join(__dirname, "..", "docs", "README.md"), "utf8");
  const rootReadme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.match(docsReadme, /docs\/commands\.md/);
  assert.match(docsReadme, /docs\/llm\.md/);
  assert.match(rootReadme, /CLI Command Reference/);
  assert.match(rootReadme, /LLM Calling Guide/);
});

test("tasks command lists existing task names from the current tasks root", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const taskDir = path.join(tasksRoot, "existing-task");
  fs.mkdirSync(taskDir, { recursive: true });
  writeProjectMarker(taskDir);
  writeJson(path.join(taskDir, "state.json"), {
    status: "completed",
    uuid: "uuid-1",
    updatedAt: "2026-06-16T12:00:00.000Z",
  });

  const result = cli.listTaskNames(cli.parseArgs(["node", "cli", "tasks", "--tasks-root", tasksRoot]));
  assert.equal(result.count, 1);
  assert.deepEqual(result.taskIds, ["existing-task"]);
  assert.equal(result.tasks[0].uuid, "uuid-1");
});

test("LLM output helpers normalize success and error envelopes", () => {
  assert.deepEqual(llmResult({ command: "run", taskId: "t1" }, {
    artifact: "/tmp/raw",
    uuid: "uuid",
    count: 10,
    message: "ready",
  }), {
    ok: true,
    code: "OK",
    command: "run",
    taskId: "t1",
    artifact: "/tmp/raw",
    uuid: "uuid",
    count: 10,
    message: "ready",
    data: {},
  });
  assert.equal(errorCode(new Error("wos.js browser API missing: window.wos.query.buildQuery")), "WOS_API_MISSING");
  assert.equal(errorCode(new Error("Query expression file not found: /tmp/queries.txt")), "INVALID_ARGS");
  const errorResult = llmErrorResult({ command: "query", queryCommand: "build", taskId: "q1" }, new Error("Saved SID is invalid"));
  assert.equal(errorResult.ok, false);
  assert.equal(errorResult.command, "query build");
  assert.equal(errorResult.code, "SID_INVALID");
  assert.match(errorResult.nextAction, /sid --from-browser/);
});

test("JSON command errors use the LLM envelope on stdout", () => {
  const root = temporaryDirectory();
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "..", "bin", "iiaide-wos.js"),
    "query", "build", "--json", "--tasks-root", root,
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, "query build");
  assert.equal(parsed.code, "WOS_QUERY_FAILED");
  assert.match(parsed.message, /Missing --expr/);
});

test("browser bridge invokes injected window.wos APIs and reports missing methods", async () => {
  const fakePage = {
    async evaluate(fn, payload) {
      global.window = {
        wos: {
          query: {
            buildQuery(expr) {
              return { uuid: "abc", ref_count: 3, rowText: expr, status: "success" };
            },
          },
        },
      };
      try {
        return await fn(payload);
      } finally {
        delete global.window;
      }
    },
  };
  const result = await callWosBrowserApi(fakePage, "query.buildQuery", ["PY=(2026)"]);
  assert.equal(result.uuid, "abc");
  assert.equal(result.ref_count, 3);

  await assert.rejects(
    () => callWosBrowserApi(fakePage, "query.missing", []),
    /wos\.js browser API missing: window\.wos\.query\.missing/
  );
});

test("normalizes Query and Record UUID metadata without leaking SID", () => {
  const result = normalizeUuidResult(
    { uuid: "uuid-1", ref_count: "1,234", rowText: "PY=(2026)", status: "success" },
    { taskId: "task-one", operation: "query build", source: { kind: "expr" } }
  );
  result.sid = "SECRET";
  assert.equal(result.ok, true);
  assert.equal(result.count, 1234);
  assert.equal(normalizeUuidResult(
    { uuid: "uuid-2", ref_count: "8", sortBy: "date-descending", href: "https://example.test/wos/woscc/summary/uuid-2/date-descending/1" },
    { operation: "record citations" }
  ).sortBy, "date-descending");
  const output = publicResult(result);
  assert.deepEqual(Object.keys(output), ["ok", "taskId", "operation", "uuid", "count", "rowText", "source"]);
  assert.equal(JSON.stringify(output).includes("SECRET"), false);
  assert.equal(queryTextForIds(["WOS:A", "WOS:B"], ["10.1/a"]), "UT=(WOS:A OR WOS:B) OR DO=(10.1/a)");
});

test("Query UUID errors replace generic unknown browser failures with context", () => {
  const error = normalizeUuidError("unknown error", {
    operation: "query build",
    rowText: "PY=(2026)",
    debug: {
      pathname: "/wos/woscc/advanced-search",
      inputReady: true,
      inputVisible: true,
      inputValue: "PY=(2026)",
      historyCount: 0,
      buttonLabels: ["Search", "Add to history"],
    },
  });
  assert.match(error, /query build failed for "PY=\(2026\)"/);
  assert.match(error, /did not create a result-set UUID/);
  assert.match(error, /path=\/wos\/woscc\/advanced-search/);
  assert.match(error, /buttons=Search\|Add to history/);

  const result = normalizeUuidResult(
    { uuid: "ignored-on-failure", status: "failed", error_code: "unknown error", debug: { inputVisible: false } },
    { operation: "query build", rowText: "PY=(2026)" }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /inputVisible=false/);
  assert.match(result.error, /Check the query in Web of Science advanced search/);
  assert.match(formatUuidDebug({ pathname: "/wos/woscc/advanced-search", historyCount: 1 }), /history=1/);
});

test("Query UUID no-result errors collapse to the user-facing WOS message", () => {
  const error = normalizeUuidError("Your search found no resultsCheck the spelling and/or broaden your search parameters.", {
    operation: "query build",
    rowText: "TP=(what is the )",
    debug: {
      pathname: "/wos/woscc/advanced-search",
      inputValue: "TP=(what is the )",
      historyCount: 10,
      buttonLabels: ["Add to query"],
      errorText: "Your search found no resultsCheck the spelling and/or broaden your search parameters.",
    },
  });
  assert.equal(error, "Your search found no results");
});

test("browser query helper waits for advanced search readiness before submitting", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "import", "wos.js"), "utf8");
  const buildQuery = source.match(/async buildQuery\(expr = 'PY=\(2025\)'\) \{[\s\S]*?\n    \}/);
  assert.ok(buildQuery, "buildQuery source should be present");
  assert.match(source, /#advancedSearchState\(\)/);
  assert.match(source, /#waitForAdvancedSearchReady/);
  assert.match(source, /#submitAdvancedSearchAction/);
  assert.match(buildQuery[0], /await this\.#waitForAdvancedSearchReady\(100\)/);
  assert.match(buildQuery[0], /advanced search page not ready/);
  assert.match(buildQuery[0], /this\.#setNativeInputValue\(input, expr\)/);
  assert.match(source, /add to history\|add to query\|search/);
  assert.match(source, /button\[data-ta="run-search"\]/);
  assert.match(source, /#findAdvancedSearchMenuTrigger/);
  assert.match(source, /search-arrow-svg-icon/);
  assert.match(source, /search-menu-add-to-history/);
  assert.doesNotMatch(source.match(/async #submitAdvancedSearchAction\(oldCount\) \{[\s\S]*?\n    \}/)?.[0] || "", /add-to-query-then-run-search|search-button/);
  assert.match(buildQuery[0], /submitResult = await this\.#submitAdvancedSearchAction\(old_num\)/);
  assert.match(buildQuery[0], /advanced search action button not ready/);
  assert.match(buildQuery[0], /advanced search history did not update/);
  assert.match(buildQuery[0], /debug: this\.#advancedSearchState\(\)/);
});

test("browser query helper waits for count metadata instead of defaulting to zero", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "import", "wos.js"), "utf8");
  const buildQuery = source.match(/async buildQuery\(expr = 'PY=\(2025\)'\) \{[\s\S]*?\n    \}/);
  assert.ok(buildQuery, "buildQuery source should be present");
  assert.match(source, /#readCurrentPageInfoSnapshot\(note = ''\)/);
  assert.match(source, /this\.\#extractUuid\(window\.location\.href\)/);
  assert.match(source, /summarySortMatch/);
  assert.match(source, /sortBy,/);
  assert.match(source, /const uuidReady = expectedUuid \? res\.uuid === expectedUuid : Boolean\(res\.uuid\)/);
  assert.match(source, /uuidReady && res\.ref_count !== ''/);
  assert.match(source, /#waitForHistoryResult\(oldCount, expr = '', maxTry = 100\)/);
  assert.match(buildQuery[0], /result && result\.ref_count !== ''/);
  assert.match(buildQuery[0], /this\.#waitForHistoryResult\(old_num, expr, 100\)/);
});

test("browser-backed commands navigate to their command-specific pages before operating", () => {
  const browserSource = fs.readFileSync(path.join(__dirname, "..", "import", "wos.js"), "utf8");
  const cliSource = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const querySource = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "wos-query-record.js"), "utf8");

  const buildQuery = browserSource.match(/async buildQuery\(expr = 'PY=\(2025\)'\) \{[\s\S]*?\n    \}/);
  const parseQuery = browserSource.match(/async parseQueryWithSearchEngine\(text\) \{[\s\S]*?\n    \}/);
  const openQueryPage = browserSource.match(/async openQueryPage\(rowText = 'PY=2025'\) \{[\s\S]*?\n    \}/);
  const recordMethods = browserSource.match(/async collectCitationsByWosId[\s\S]*?async collectSharedReferencesBetweenWosIds\(wosid1, wosid2\) \{[\s\S]*?\n    \}/);
  const requestContextStart = cliSource.indexOf("async function prepareWosRequestContext(page, args)");
  const requestContextEnd = cliSource.indexOf("function pageContextUuid", requestContextStart);
  const requestContext = requestContextStart >= 0 && requestContextEnd > requestContextStart
    ? cliSource.slice(requestContextStart, requestContextEnd)
    : "";
  const runQueryStart = querySource.indexOf("async function runQueryBrowserCommand(page, args)");
  const runRecordStart = querySource.indexOf("async function runRecordBrowserCommand(page, args)");
  const publicResultStart = querySource.indexOf("function publicResult", runRecordStart);
  const runQuery = runQueryStart >= 0 && runRecordStart > runQueryStart
    ? querySource.slice(runQueryStart, runRecordStart)
    : "";
  const runRecord = runRecordStart >= 0 && publicResultStart > runRecordStart
    ? querySource.slice(runRecordStart, publicResultStart)
    : "";

  assert.ok(buildQuery, "query build helper should be present");
  assert.ok(parseQuery, "query parse helper should be present");
  assert.ok(openQueryPage, "query result page helper should be present");
  assert.ok(recordMethods, "record relation helpers should be present");
  assert.ok(requestContext, "export request context helper should be present");
  assert.ok(runQuery, "query command bridge should be present");
  assert.ok(runRecord, "record command bridge should be present");

  assert.match(buildQuery[0], /wosGoto\.goToAdvancedSearchPage\(\)/);
  assert.match(parseQuery[0], /wosGoto\.goToBasicSearchPage\(\)/);
  assert.match(browserSource, /await this\.openQueryPage\(rowText\)/);
  assert.doesNotMatch(browserSource, /goToSmartSearchPage/);
  assert.doesNotMatch(browserSource, /smartSearchWithSearchEngine/);
  assert.doesNotMatch(browserSource, /smartSearchFromInput/);
  assert.doesNotMatch(browserSource, /composeQuerySmartSearch/);
  assert.match(openQueryPage[0], /\/wos\/woscc\/general-summary\?queryJson=/);
  assert.match(openQueryPage[0], /waitForUrlChange/);

  assert.match(recordMethods[0], /goToCitationsPageByWosId/);
  assert.match(recordMethods[0], /goToReferencesPageByWosId/);
  assert.match(recordMethods[0], /goToRelatedRecordsPageByWosId/);
  assert.match(recordMethods[0], /goToSharedReferencesPageByWosIds/);

  assert.match(requestContext, /page\.goto\(args\.url/);
  assert.match(requestContext, /fetchCurrentPageInfo\("iiaide-wos request context"\)/);
  assert.doesNotMatch(requestContext, /networkidle/);
  assert.match(cliSource, /phase: "txt-export-ref-query-retry"/);
  assert.match(cliSource, /isRefQuery: exportRefQuery/);
  assert.match(cliSource, /prepareWosRequestContext\(page, args\)/);
  assert.match(cliSource, /debug\("wos sid: domcontentloaded"/);
  assert.match(cliSource, /waitForWosSidSessionSignal\(page, args\)/);
  assert.match(cliSource, /debug\("wos sid: session signal wait complete"/);
  assert.match(cliSource, /debug\("wos sid: wos\.js injected"/);
  assert.match(cliSource, /loginElapsedMs: Date\.now\(\) - loginStartedAt/);
  const validateStart = cliSource.indexOf("async function validateSid(page, args)");
  const validateEnd = cliSource.indexOf("async function detectSidFromPage", validateStart);
  const validateSidSource = cliSource.slice(validateStart, validateEnd);
  assert.doesNotMatch(validateSidSource, /networkidle/);

  assert.match(runQuery, /query\.buildQuery/);
  assert.match(querySource, /waiting for WOS browser API/);
  assert.match(runQuery, /query\.parseQueryWithSearchEngine/);
  assert.doesNotMatch(runQuery, /query\.smartSearchWithSearchEngine/);
  assert.doesNotMatch(runQuery, /query\.composeQuerySmartSearch/);
  assert.match(runQuery, /query\.openQueryByWosIdsOrDois/);
  assert.match(querySource, /citations: "record\.collectCitationsByWosId"/);
  assert.match(querySource, /references: "record\.collectReferencesByWosId"/);
  assert.match(querySource, /related: "record\.collectRelatedRecordsByWosId"/);
  assert.match(runRecord, /record collect: collecting WOS IDs from relation result set/);
  assert.match(runRecord, /results\.collectWosIdsByUuidPages/);
  assert.match(runRecord, /record\.collectSharedReferencesBetweenWosIds/);
});

test("Query workflow writes only task metadata and returns resolved UUID", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "query", "build", "--expr", "PY=(2026)", "--task", "query-demo", "--tasks-root", root]);
  const summary = await cli.runQueryRecord(args, {
    prepareWosSession: async () => ({ page: {}, close: async () => {} }),
    runQueryBrowserCommand: async () => ({
      ok: true,
      taskId: args.taskId,
      operation: "query build",
      uuid: "12345678-1234-1234-1234-123456789abc-123456789a",
      count: 42,
      rowText: "PY=(2026)",
      source: { kind: "expr", value: "PY=(2026)" },
    }),
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.uuid, "12345678-1234-1234-1234-123456789abc-123456789a");
  assert.equal(fs.existsSync(path.join(args.outDir, "project.json")), true);
  assert.equal(fs.existsSync(path.join(args.outDir, "state.json")), true);
  assert.equal(fs.existsSync(path.join(args.outDir, "audit", "activity.jsonl")), true);
  assert.equal(fs.existsSync(path.join(args.outDir, "audit", "searches.jsonl")), true);
  assert.equal(fs.existsSync(path.join(args.outDir, "wosData.sqlite")), true);
  assert.equal(fs.existsSync(path.join(firstRunDir(args.outDir), "command.json")), true);
  assert.equal(fs.existsSync(path.join(firstRunDir(args.outDir), "summary.json")), true);
  assert.equal(fs.existsSync(path.join(args.outDir, "resultsets")), true);
  const searchRows = spawnSync("sqlite3", [
    path.join(args.outDir, "wosData.sqlite"),
    "select command || ':' || subcommand || ':' || query_text || ':' || uuid || ':' || result_count || ':' || ok from search_queries order by id;",
  ], { encoding: "utf8" });
  assert.equal(searchRows.status, 0);
  assert.match(searchRows.stdout.trim(), /^query:build:PY=\(2026\):12345678-1234-1234-1234-123456789abc-123456789a:42:1$/);
  const auditRows = spawnSync("sqlite3", [
    path.join(args.outDir, "wosData.sqlite"),
    "select command || ':' || operation || ':' || uuid || ':' || count from audit_runs;",
  ], { encoding: "utf8" });
  assert.equal(auditRows.status, 0);
  assert.match(auditRows.stdout.trim(), /^query:query build:12345678-1234-1234-1234-123456789abc-123456789a:42$/);
});

test("Query build default output prints a compact single-line JSON result", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "query", "build", "--expr", "TS=(\"two-dimensional materials\") AND PY=(2026)", "--tasks-root", root]);
  const summary = {
    ok: true,
    command: "query",
    subcommand: "build",
    uuid: "bd5e1b31-f8d7-4326-8b4f-8cf430b14d89-01b9d68a89",
    sortBy: "relevance",
    count: 855,
    rowText: "TS=(\"two-dimensional materials\") AND PY=(2026)",
  };
  const output = cli.formatQueryRecordOutput(args, summary);
  assert.equal(output.includes("\n"), false);
  assert.deepEqual(JSON.parse(output), {
    uuid: "bd5e1b31-f8d7-4326-8b4f-8cf430b14d89-01b9d68a89",
    url: "https://www.webofscience.com/wos/woscc/summary/bd5e1b31-f8d7-4326-8b4f-8cf430b14d89-01b9d68a89/relevance/1",
    count: 855,
    queryText: "TS=(\"two-dimensional materials\") AND PY=(2026)",
    cached: false,
  });
});

test("Query build reuses successful SQLite results for the same expression", async () => {
  const root = temporaryDirectory();
  const argv = ["node", "cli", "query", "build", "--expr", "PY=(2026)", "--task", "query-cache", "--tasks-root", root];
  const firstArgs = cli.parseArgs(argv);
  await cli.runQueryRecord(firstArgs, {
    prepareWosSession: async () => ({ page: {}, close: async () => {} }),
    runQueryBrowserCommand: async () => ({
      ok: true,
      taskId: firstArgs.taskId,
      operation: "query build",
      uuid: "12345678-1234-1234-1234-123456789abc-123456789a",
      count: 42,
      rowText: "PY=(2026)",
      source: { kind: "expr", value: "PY=(2026)" },
      sortBy: "relevance",
    }),
  });

  let preparedBrowser = false;
  const secondArgs = cli.parseArgs(argv);
  const secondSummary = await cli.runQueryRecord(secondArgs, {
    prepareWosSession: async () => {
      preparedBrowser = true;
      throw new Error("browser should not start on cache hit");
    },
  });

  assert.equal(preparedBrowser, false);
  assert.equal(secondSummary.method, "wos-sqlite-cache");
  assert.equal(secondSummary.cached, true);
  assert.equal(secondSummary.uuid, "12345678-1234-1234-1234-123456789abc-123456789a");
  assert.equal(secondSummary.count, 42);
  const auditRows = spawnSync("sqlite3", [
    path.join(secondArgs.outDir, "wosData.sqlite"),
    "select count(*) from search_queries where command='query' and subcommand='build' and query_text='PY=(2026)' and ok=1;",
  ], { encoding: "utf8" });
  assert.equal(auditRows.status, 0);
  assert.equal(auditRows.stdout.trim(), "2");
});

test("Record collect workflow writes relation JSON and WOSID CSV artifacts", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "record", "collect", "--wosid", "WOS:ABC", "--task", "record-collect", "--tasks-root", root]);
  const ids = {
    citations: "11111111-1111-1111-1111-111111111111-1111111111",
    references: "22222222-2222-2222-2222-222222222222-2222222222",
    related: "33333333-3333-3333-3333-333333333333-3333333333",
  };
  const summary = await cli.runQueryRecord(args, {
    prepareWosSession: async () => ({ page: {}, close: async () => {} }),
    runRecordBrowserCommand: async () => ({
      ok: true,
      taskId: args.taskId,
      operation: "record collect",
      uuid: ids.citations,
      count: 3,
      rowText: "citations,references,related relations for WOS:ABC",
      source: { kind: "record-relation-collection", wosid: "WOS:ABC", types: ["citations", "references", "related"], pages: 20 },
      relations: Object.entries(ids).map(([type, uuid], index) => ({
        type,
        ok: true,
        uuid,
        count: 10,
        rowText: `${type} of WOS:ABC`,
        pagesRequested: 20,
        uniqueCount: 1,
        wosids: [{ wosid: `WOS:${type.toUpperCase()}${index + 1}` }],
      })),
    }),
  });
  const relationDir = path.join(args.outDir, "record-relations", "WOS:ABC");
  assert.equal(summary.ok, true);
  assert.equal(summary.files.relationsDir, relationDir);
  assert.equal(fs.existsSync(path.join(relationDir, "citations.json")), true);
  assert.equal(fs.existsSync(path.join(relationDir, "references.json")), true);
  assert.equal(fs.existsSync(path.join(relationDir, "related.json")), true);
  assert.equal(fs.existsSync(path.join(args.outDir, "resultsets", ids.references, `${ids.references}_wosid.csv`)), true);
  const references = JSON.parse(fs.readFileSync(path.join(relationDir, "references.json"), "utf8"));
  assert.equal(references.type, "references");
  assert.equal(references.uniqueCount, 1);
  assert.match(references.files.wosidsCsv, /22222222-2222-2222-2222-222222222222-2222222222_wosid\.csv$/);
});

test("WOS ingest writes task-level SQLite with result-set order", () => {
  const root = temporaryDirectory();
  const taskDir = path.join(root, "tasks", "sqlite-task");
  const basePaths = cli.getRunPaths(taskDir);
  const runId = "RUN20260616120000-query-ingest";
  const paths = {
    ...basePaths,
    runId,
    runDir: path.join(taskDir, "runs", runId),
    progressLog: path.join(taskDir, "runs", runId, "runtime.jsonl"),
    commandJson: path.join(taskDir, "runs", runId, "command.json"),
    runSummary: path.join(taskDir, "runs", runId, "summary.json"),
  };
  const args = cli.parseArgs(["node", "cli", "query", "ingest", "--expr", "PY=(2026)", "--task", "sqlite-task", "--tasks-root", path.join(root, "tasks")]);
  fs.mkdirSync(taskDir, { recursive: true });
  writeProjectMarker(taskDir);
  writeJson(path.join(root, "tasks", "index.json"), {
    version: 1,
    tasks: [{ taskId: "sqlite-task", taskDir: "sqlite-task", uuid: "query-uuid" }],
  });

  const summary = cli.writeWosIngestSummary(paths, args, {
    startedAt: "2026-06-16T12:00:00.000Z",
    finishedAt: "2026-06-16T12:00:01.000Z",
    operation: "query ingest build",
    kind: "normal",
    queryText: "PY=(2026)",
    semanticDescription: "2026 papers",
    uuid: "query-uuid",
    isRefQuery: false,
    availableCount: 2,
    records: [
      { wos_id: "A", meta_info: { doi: "10.1/a" }, wos_data: { title: "First", publication_year: "2026", source_title: "Journal A" } },
      { wos_id: "WOS:B", meta_info: { doi: "10.1/b" }, wos_data: { title: "Second", publication_year: "2026", source_title: "Journal B" } },
    ],
  });

  assert.equal(summary.files.sqlite, path.join(taskDir, "wosData.sqlite"));
  assert.equal(summary.ingestedCount, 2);
  const rows = spawnSync("sqlite3", [
    summary.files.sqlite,
    "select position || ':' || wosid from resultset_items order by position;",
  ], { encoding: "utf8" });
  assert.equal(rows.status, 0);
  assert.deepEqual(rows.stdout.trim().split(/\n/), ["1:WOS:A", "2:WOS:B"]);
  const resultset = spawnSync("sqlite3", [
    summary.files.sqlite,
    "select kind || ':' || is_ref_query || ':' || query_text from resultsets where uuid='query-uuid';",
  ], { encoding: "utf8" });
  assert.equal(resultset.status, 0);
  assert.equal(resultset.stdout.trim(), "normal:0:PY=(2026)");
  const searches = spawnSync("sqlite3", [
    summary.files.sqlite,
    "select command || ':' || subcommand || ':' || semantic_description || ':' || uuid || ':' || result_count from search_queries where uuid='query-uuid';",
  ], { encoding: "utf8" });
  assert.equal(searches.status, 0);
  assert.equal(searches.stdout.trim(), "query:ingest:2026 papers:query-uuid:2");
  const validation = cli.validateTask(cli.parseArgs(["node", "cli", "validate", "--task", "sqlite-task", "--tasks-root", path.join(root, "tasks")]));
  assert.equal(validation.ok, true);
  assert.equal(validation.sqlite, summary.files.sqlite);
});

test("record ingest reuses existing SQLite rows for the same WOSID and type", async () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const taskDir = path.join(tasksRoot, "record-sqlite");
  const args = cli.parseArgs([
    "node", "cli", "record", "ingest",
    "--wosid", "WOS:SOURCE",
    "--type", "references",
    "--task", "record-sqlite",
    "--tasks-root", tasksRoot,
  ]);
  const seedPaths = {
    ...cli.getRunPaths(taskDir),
    runId: "RUN20260616121000-record-ingest",
    runDir: path.join(taskDir, "runs", "RUN20260616121000-record-ingest"),
    progressLog: path.join(taskDir, "runs", "RUN20260616121000-record-ingest", "runtime.jsonl"),
    commandJson: path.join(taskDir, "runs", "RUN20260616121000-record-ingest", "command.json"),
    runSummary: path.join(taskDir, "runs", "RUN20260616121000-record-ingest", "summary.json"),
  };
  fs.mkdirSync(taskDir, { recursive: true });
  writeProjectMarker(taskDir);
  cli.writeWosIngestSummary(seedPaths, args, {
    startedAt: "2026-06-16T12:10:00.000Z",
    finishedAt: "2026-06-16T12:10:01.000Z",
    operation: "record ingest references",
    kind: "references",
    sourceWosId: "WOS:SOURCE",
    queryText: "references of WOS:SOURCE",
    semanticDescription: "seed references",
    uuid: "references-uuid",
    isRefQuery: true,
    availableCount: 1,
    records: [
      { wos_id: "WOS:REF1", meta_info: { doi: "10.1/ref1" }, wos_data: { title: "Reference 1" } },
    ],
  });

  const summary = await cli.runRecordIngest(args, {
    prepareWosSession: async () => assert.fail("record ingest should reuse SQLite before opening WOS"),
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.reused, true);
  assert.equal(summary.uuid, "references-uuid");
  assert.equal(summary.ingestedCount, 1);
  assert.equal(summary.files.sqlite, path.join(taskDir, "wosData.sqlite"));
});

test("record ingest stores and reuses confirmed empty relation resultsets", async () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const args = cli.parseArgs([
    "node", "cli", "record", "ingest",
    "--wosid", "WOS:EMPTY",
    "--type", "related",
    "--task", "record-empty",
    "--tasks-root", tasksRoot,
  ]);
  let prepared = 0;
  const relationUuid = "534b543d-9f54-4350-b079-7ed7bf16f9c1-01b9d5c991";
  const summary = await cli.runRecordIngest(args, {
    prepareWosSession: async () => {
      prepared += 1;
      return { page: {}, close: async () => {} };
    },
    runRecordBrowserCommand: async () => ({
      ok: true,
      taskId: args.taskId,
      operation: "record related",
      uuid: relationUuid,
      count: 0,
      rowText: "related of WOS:EMPTY",
      source: { kind: "record-relation", wosid: "WOS:EMPTY", type: "related" },
    }),
    collectRelationWosIdsForIngest: async () => assert.fail("empty relation count should not collect WOSIDs"),
    exportIngestRecordsByWosIds: async () => assert.fail("empty relation count should not export records"),
  });

  assert.equal(prepared, 1);
  assert.equal(summary.ok, true);
  assert.equal(summary.emptyResult, true);
  assert.equal(summary.uuid, relationUuid);
  assert.equal(summary.expectedCount, 0);
  assert.equal(summary.ingestedCount, 0);

  const uuidResult = cli.runDbLookup(cli.parseArgs([
    "node", "cli", "db", "uuid",
    "--uuid", relationUuid,
    "--task", "record-empty",
    "--tasks-root", tasksRoot,
  ]));
  assert.equal(uuidResult.ok, true);
  assert.equal(uuidResult.resultset.kind, "related");
  assert.equal(uuidResult.resultset.itemCount, 0);
  assert.equal(uuidResult.resultset.availableCount, 0);

  const listResult = cli.runDbLookup(cli.parseArgs([
    "node", "cli", "db", "list",
    "--wosid", "WOS:EMPTY",
    "--type", "related",
    "--task", "record-empty",
    "--tasks-root", tasksRoot,
  ]));
  assert.equal(listResult.ok, true);
  assert.equal(listResult.uuid, relationUuid);
  assert.equal(listResult.count, 0);
  assert.deepEqual(listResult.wosids, []);

  const reused = await cli.runRecordIngest(args, {
    prepareWosSession: async () => assert.fail("empty relation resultset should be reused before opening WOS"),
  });
  assert.equal(reused.ok, true);
  assert.equal(reused.reused, true);
  assert.equal(reused.emptyResult, true);
  assert.equal(reused.uuid, relationUuid);
  assert.equal(reused.ingestedCount, 0);
});

test("record ingest uses front-scroll WOSIDs instead of direct relation UUID export", async () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const args = cli.parseArgs([
    "node", "cli", "record", "ingest",
    "--wosid", "WOS:SOURCE",
    "--type", "citations",
    "--task", "record-front-scroll",
    "--tasks-root", tasksRoot,
  ]);
  const relationUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-aaaaaaaaaa";
  const queryUuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-bbbbbbbbbb";
  const calls = [];
  const summary = await cli.runRecordIngest(args, {
    prepareWosSession: async () => ({ page: {}, close: async () => {} }),
    runRecordBrowserCommand: async (_page, itemArgs) => {
      calls.push(`relation:${itemArgs.recordCommand}:${itemArgs.sortBy}`);
      return {
        ok: true,
        taskId: args.taskId,
        operation: "record citations",
        uuid: relationUuid,
        count: 99,
        rowText: "citations of WOS:SOURCE",
        sortBy: "date-descending",
        source: { kind: "record-relation", wosid: "WOS:SOURCE", type: "citations" },
      };
    },
    collectRelationWosIdsForIngest: async (_page, _args, options) => {
      calls.push(`collect:${options.uuid}:${options.kind}`);
      assert.equal(options.uuid, relationUuid);
      return {
        rows: [{ wosid: "WOS:C1" }, { wosid: "WOS:C2" }],
        wosIds: ["WOS:C1", "WOS:C2"],
        pagesRequested: 6,
        sortBy: "relevance",
      };
    },
    exportIngestRecordsByWosIds: async (_page, _args, options) => {
      calls.push(`export-wosids:${options.relationUuid}:${options.wosIds.join(",")}`);
      assert.equal(options.relationUuid, relationUuid);
      assert.deepEqual(options.wosIds, ["WOS:C1", "WOS:C2"]);
      return {
        records: [
          { wos_id: "WOS:C1", wos_data: { title: "Citation 1" } },
          { wos_id: "WOS:C2", wos_data: { title: "Citation 2" } },
        ],
        requestedLimit: 500,
        exportedCount: 2,
        textBytes: 100,
        queryUuid,
        queryCount: 2,
      };
    },
  });

  assert.deepEqual(calls, [
    "relation:relations:relevance",
    `collect:${relationUuid}:citations`,
    `export-wosids:${relationUuid}:WOS:C1,WOS:C2`,
  ]);
  assert.equal(summary.ok, true);
  assert.equal(summary.uuid, relationUuid);
  assert.equal(summary.sourceQueryUuid, queryUuid);
  assert.equal(summary.exportMode, "front-scroll-wosid");
  assert.equal(summary.uuidDirectExport, false);
  assert.equal(summary.sortBy, "relevance");
  assert.equal(summary.ingestedCount, 2);

  const uuidResult = cli.runDbLookup(cli.parseArgs([
    "node", "cli", "db", "uuid",
    "--uuid", relationUuid,
    "--task", "record-front-scroll",
    "--tasks-root", tasksRoot,
  ]));
  assert.equal(uuidResult.resultset.exportMode, "front-scroll-wosid");
  assert.equal(uuidResult.resultset.uuidDirectExport, false);
  assert.equal(uuidResult.records[0].wosid, "WOS:C1");
  assert.equal(uuidResult.records[1].wosid, "WOS:C2");
});

test("relation ingest record ordering follows collected WOSID order", () => {
  const ordered = cli.orderedRecordsForWosIds(
    [
      { wos_id: "WOS:B", wos_data: { title: "B" } },
      { wos_id: "WOS:A", wos_data: { title: "A" } },
    ],
    ["WOS:A", "WOS:B", "WOS:MISSING"]
  );
  assert.deepEqual(ordered.map((record) => record.wos_id), ["WOS:A", "WOS:B"]);
});

test("direct UUID export refuses resultsets marked for front-end WOSID collection", async () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const taskDir = path.join(tasksRoot, "record-no-direct");
  const relationUuid = "cccccccc-cccc-cccc-cccc-cccccccccccc-cccccccccc";
  const args = cli.parseArgs([
    "node", "cli", "record", "ingest",
    "--wosid", "WOS:SOURCE",
    "--type", "related",
    "--task", "record-no-direct",
    "--tasks-root", tasksRoot,
  ]);
  const paths = {
    ...cli.getRunPaths(taskDir),
    runId: "RUN20260617120000-record-ingest",
    runDir: path.join(taskDir, "runs", "RUN20260617120000-record-ingest"),
    progressLog: path.join(taskDir, "runs", "RUN20260617120000-record-ingest", "runtime.jsonl"),
    commandJson: path.join(taskDir, "runs", "RUN20260617120000-record-ingest", "command.json"),
    runSummary: path.join(taskDir, "runs", "RUN20260617120000-record-ingest", "summary.json"),
  };
  fs.mkdirSync(taskDir, { recursive: true });
  writeProjectMarker(taskDir);
  cli.writeWosIngestSummary(paths, args, {
    operation: "record ingest related",
    kind: "related",
    sourceWosId: "WOS:SOURCE",
    uuid: relationUuid,
    isRefQuery: true,
    sortBy: "relevance",
    exportMode: "front-scroll-wosid",
    uuidDirectExport: false,
    availableCount: 1,
    records: [{ wos_id: "WOS:R1", wos_data: { title: "Related 1" } }],
  });

  const runArgs = cli.parseArgs([
    "node", "cli", "run",
    "--uuid", relationUuid,
    "--task", "record-no-direct",
    "--tasks-root", tasksRoot,
    "--quiet",
  ]);
  await assert.rejects(
    () => cli.prepareWosExport(runArgs),
    /front-end WOSID collection only.*record ingest --wosid "WOS:SOURCE" --type related/
  );
});

test("record ingest opens relation summary page before SQLite export", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const method = source.match(/async function exportIngestRecordsFromUuid\(page, args, options = \{\}\) \{[\s\S]*?\n}\n\nfunction writeWosIngestSummary/);
  assert.ok(method, "exportIngestRecordsFromUuid should be present");
  assert.match(method[0], /const sortBy = options\.sortBy \|\| "relevance"/);
  assert.match(method[0], /phase: "wos-ingest-open-summary"/);
  assert.match(method[0], /openSummaryPageForExport\(page, args, \{ uuid: options\.uuid, sortBy \}\)/);
  assert.match(method[0], /phase: "wos-ingest-summary-ready"/);
  assert.match(method[0], /exportTxtBatchesViaWosJs/);
  assert.match(method[0], /sortBy,/);
});

test("db lookup returns UUID metadata and WOSID relation context from SQLite", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const taskDir = path.join(tasksRoot, "record-db");
  const args = cli.parseArgs([
    "node", "cli", "record", "ingest",
    "--wosid", "WOS:SOURCE",
    "--type", "references",
    "--task", "record-db",
    "--tasks-root", tasksRoot,
  ]);
  const seedPaths = {
    ...cli.getRunPaths(taskDir),
    runId: "RUN20260616122000-record-ingest",
    runDir: path.join(taskDir, "runs", "RUN20260616122000-record-ingest"),
    progressLog: path.join(taskDir, "runs", "RUN20260616122000-record-ingest", "runtime.jsonl"),
    commandJson: path.join(taskDir, "runs", "RUN20260616122000-record-ingest", "command.json"),
    runSummary: path.join(taskDir, "runs", "RUN20260616122000-record-ingest", "summary.json"),
  };
  fs.mkdirSync(taskDir, { recursive: true });
  writeProjectMarker(taskDir);
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [{ taskId: "record-db", taskDir: "record-db", uuid: "references-uuid", status: "completed" }],
  });
  cli.writeWosIngestSummary(seedPaths, args, {
    startedAt: "2026-06-16T12:20:00.000Z",
    finishedAt: "2026-06-16T12:20:01.000Z",
    operation: "record ingest references",
    kind: "references",
    sourceWosId: "WOS:SOURCE",
    queryText: "references of WOS:SOURCE",
    semanticDescription: "seed references",
    uuid: "references-uuid",
    isRefQuery: true,
    availableCount: 2,
    records: [
      {
        wos_id: "WOS:REF1",
        meta_info: { doi: "10.1/ref1" },
        wos_data: {
          title: "Atomically thin theory paper",
          abstract: "A density functional theory study of a monolayer material.",
          author_full_names: ["Ada Example", "Ben Example"],
          author_keywords: ["2D materials", "DFT"],
        },
      },
      {
        wos_id: "WOS:REF2",
        wos_data: {
          title: "Second reference",
          keywords_plus: ["GRAPHENE"],
        },
      },
    ],
  });

  const uuidResult = cli.runDbLookup(cli.parseArgs(["node", "cli", "db", "uuid", "--uuid", "references-uuid", "--task", "record-db", "--tasks-root", tasksRoot]));
  assert.equal(uuidResult.ok, true);
  assert.equal(uuidResult.resultset.kind, "references");
  assert.equal(uuidResult.resultset.itemCount, 2);
  assert.equal(uuidResult.records.length, 2);
  assert.equal(uuidResult.records[0].wosid, "WOS:REF1");

  const wosidResult = cli.runDbLookup(cli.parseArgs(["node", "cli", "db", "wosid", "--wosid", "SOURCE", "--task", "record-db", "--tasks-root", tasksRoot]));
  assert.equal(wosidResult.ok, true);
  assert.equal(wosidResult.relations.references[0].uuid, "references-uuid");

  const contextResult = cli.runDbLookup(cli.parseArgs(["node", "cli", "db", "context", "--wosid", "WOS:SOURCE", "--type", "ref", "--task", "record-db", "--tasks-root", tasksRoot]));
  assert.equal(contextResult.ok, true);
  assert.equal(contextResult.type, "references");
  assert.equal(contextResult.records.length, 2);
  assert.equal(contextResult.records[0].wosid, "WOS:REF1");
  assert.equal(contextResult.records[0].title, "Atomically thin theory paper");
  assert.deepEqual(contextResult.records[0].authors, ["Ada Example", "Ben Example"]);
  assert.deepEqual(contextResult.records[0].keywords, ["2D materials", "DFT"]);

  const selfResult = cli.runDbLookup(cli.parseArgs(["node", "cli", "db", "context", "--wosid", "WOS:REF1", "--type", "self", "--task", "record-db", "--tasks-root", tasksRoot]));
  assert.equal(selfResult.ok, true);
  assert.equal(selfResult.records[0].abstract, "A density functional theory study of a monolayer material.");
});

test("db list returns stored WOSID lists and optional record context", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const taskDir = path.join(tasksRoot, "record-list-db");
  const args = cli.parseArgs([
    "node", "cli", "record", "ingest",
    "--wosid", "WOS:SOURCE",
    "--type", "citations",
    "--task", "record-list-db",
    "--tasks-root", tasksRoot,
  ]);
  const seedPaths = {
    ...cli.getRunPaths(taskDir),
    runId: "RUN20260616123000-record-ingest",
    runDir: path.join(taskDir, "runs", "RUN20260616123000-record-ingest"),
    progressLog: path.join(taskDir, "runs", "RUN20260616123000-record-ingest", "runtime.jsonl"),
    commandJson: path.join(taskDir, "runs", "RUN20260616123000-record-ingest", "command.json"),
    runSummary: path.join(taskDir, "runs", "RUN20260616123000-record-ingest", "summary.json"),
  };
  fs.mkdirSync(taskDir, { recursive: true });
  writeProjectMarker(taskDir);
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [{ taskId: "record-list-db", taskDir: "record-list-db", uuid: "citations-uuid", status: "completed" }],
  });
  cli.writeWosIngestSummary(seedPaths, args, {
    startedAt: "2026-06-16T12:30:00.000Z",
    finishedAt: "2026-06-16T12:30:01.000Z",
    operation: "record ingest citations",
    kind: "citations",
    sourceWosId: "WOS:SOURCE",
    queryText: "citations of WOS:SOURCE",
    semanticDescription: "seed citations",
    uuid: "citations-uuid",
    isRefQuery: true,
    availableCount: 2,
    records: [
      {
        wos_id: "WOS:CITE1",
        wos_data: {
          title: "First citing paper",
          abstract: "Atomic thickness theory context.",
          author_full_names: ["A. Writer"],
          author_keywords: ["atomic layer"],
        },
      },
      {
        wos_id: "WOS:CITE2",
        wos_data: {
          title: "Second citing paper",
          author_full_names: ["B. Writer"],
        },
      },
    ],
  });

  const byWosId = cli.runDbLookup(cli.parseArgs([
    "node", "cli", "db", "list",
    "--wosid", "WOS:SOURCE",
    "--type", "citations",
    "--task", "record-list-db",
    "--tasks-root", tasksRoot,
  ]));
  assert.equal(byWosId.ok, true);
  assert.equal(byWosId.uuid, "citations-uuid");
  assert.deepEqual(byWosId.wosids, ["WOS:CITE1", "WOS:CITE2"]);
  assert.equal(byWosId.items[0].record, undefined);

  const byUuid = cli.runDbLookup(cli.parseArgs([
    "node", "cli", "db", "list",
    "--uuid", "citations-uuid",
    "--context",
    "--task", "record-list-db",
    "--tasks-root", tasksRoot,
  ]));
  assert.equal(byUuid.ok, true);
  assert.equal(byUuid.type, "citations");
  assert.equal(byUuid.items[0].record.title, "First citing paper");
  assert.deepEqual(byUuid.items[0].record.authors, ["A. Writer"]);
  assert.deepEqual(byUuid.items[0].record.keywords, ["atomic layer"]);

  const formatted = cli.formatDbLookup(byUuid);
  assert.match(formatted, /"wosids": \[/);
  assert.match(formatted, /First citing paper/);
});

test("db searches and db artifacts return SQLite audit rows", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "query", "build", "--expr", "PY=(2026)", "--task", "audit-db", "--tasks-root", root]);
  await cli.runQueryRecord(args, {
    prepareWosSession: async () => ({ page: {}, close: async () => {} }),
    runQueryBrowserCommand: async () => ({
      ok: true,
      taskId: args.taskId,
      operation: "query build",
      uuid: "12345678-1234-1234-1234-123456789abc-123456789a",
      count: 12,
      rowText: "PY=(2026)",
      source: { kind: "expr", value: "PY=(2026)" },
    }),
  });

  const searchesResult = cli.runDbLookup(cli.parseArgs(["node", "cli", "db", "searches", "--task", "audit-db", "--tasks-root", root, "--limit", "5"]));
  assert.equal(searchesResult.ok, true);
  assert.equal(searchesResult.command, "db searches");
  assert.equal(searchesResult.count, 1);
  assert.equal(searchesResult.searches[0].queryText, "PY=(2026)");
  assert.equal(searchesResult.searches[0].uuid, "12345678-1234-1234-1234-123456789abc-123456789a");
  assert.match(searchesResult.searches[0].createdAt, /Z$/);
  const formattedSearches = cli.formatDbLookup(searchesResult);
  assert.doesNotMatch(formattedSearches, /createdAt": "[^"]+Z"/);
  assert.match(formattedSearches, /createdAt": "\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

  const searchesByUuid = cli.runDbLookup(cli.parseArgs(["node", "cli", "db", "searches", "--task", "audit-db", "--tasks-root", root, "--uuid", "12345678-1234-1234-1234-123456789abc-123456789a"]));
  assert.equal(searchesByUuid.count, 1);

  const artifactsResult = cli.runDbLookup(cli.parseArgs(["node", "cli", "db", "artifacts", "--task", "audit-db", "--tasks-root", root]));
  assert.equal(artifactsResult.ok, true);
  assert.equal(artifactsResult.command, "db artifacts");
  assert.equal(artifactsResult.count >= 1, true);
  assert.equal(artifactsResult.artifacts.some((item) => item.role === "progressLog"), true);

  const runsResult = cli.runDbLookup(cli.parseArgs(["node", "cli", "db", "runs", "--task", "audit-db", "--tasks-root", root, "--limit", "5"]));
  assert.equal(runsResult.ok, true);
  assert.equal(runsResult.command, "db runs");
  assert.equal(runsResult.count, 1);
  assert.equal(runsResult.runs[0].operation, "query build");
  const formattedRuns = cli.formatDbLookup(runsResult);
  assert.doesNotMatch(formattedRuns, /finishedAt": "[^"]+Z"/);

  const timelineResult = cli.runDbLookup(cli.parseArgs(["node", "cli", "db", "timeline", "--task", "audit-db", "--tasks-root", root, "--limit", "20"]));
  assert.equal(timelineResult.ok, true);
  assert.equal(timelineResult.command, "db timeline");
  assert.equal(timelineResult.count >= 3, true);
  assert.equal(timelineResult.items.some((item) => item.type === "run"), true);
  assert.equal(timelineResult.items.some((item) => item.type === "search"), true);
  assert.equal(timelineResult.items.some((item) => item.type === "artifact"), true);
});

test("db audit-html serves a local AJAX audit viewer over SQLite", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "query", "build", "--expr", "PY=(2026)", "--task", "audit-html", "--tasks-root", root]);
  await cli.runQueryRecord(args, {
    prepareWosSession: async () => ({ page: {}, close: async () => {} }),
    runQueryBrowserCommand: async () => ({
      ok: true,
      taskId: args.taskId,
      operation: "query build",
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-aaaaaaaaaa",
      count: 7,
      rowText: "PY=(2026)",
      source: { kind: "expr", value: "PY=(2026)" },
    }),
  });

  const serverHandle = await cli.runAuditHtml(cli.parseArgs(["node", "cli", "db", "audit-html", "--task", "audit-html", "--tasks-root", root, "--port", "0", "--limit", "10"]));
  try {
    const htmlResponse = await fetch(serverHandle.url);
    const html = await htmlResponse.text();
    assert.equal(htmlResponse.status, 200);
    assert.match(html, /WOS Audit Timeline/);
    assert.match(html, /Commands/);
    assert.match(html, /CLI Help/);
    assert.match(html, /Recipes/);
    assert.match(html, /Start a new literature project/);
    assert.match(html, /id="syncBtn"/);
    assert.match(html, /copy-icon/);
    assert.match(html, /formatLocalTime/);
    assert.match(html, /woscc\/summary/);
    assert.match(html, /timeline-field/);
    assert.match(html, /run-pill/);
    assert.doesNotMatch(html, /copy-all/);

    const overviewResponse = await fetch(`${serverHandle.url}api/overview?limit=10`);
    const overview = await overviewResponse.json();
    assert.equal(overview.ok, true);
    assert.equal(overview.taskId, "audit-html");
    assert.equal(overview.stats.searches >= 1, true);
    assert.equal(overview.stats.timeline >= 3, true);

    const commandsResponse = await fetch(`${serverHandle.url}api/commands`);
    const commands = await commandsResponse.json();
    assert.equal(commands.ok, true);
    assert.equal(Array.isArray(commands.pages), true);
    assert.equal(commands.pages.length >= 5, true);
    assert.equal(commands.pages.some((page) => page.id === "recipes"), true);
    assert.equal(commands.pages.some((page) => page.id === "db"), true);
  } finally {
    await new Promise((resolve) => serverHandle.server.close(resolve));
  }
});

test("db audit-export writes static audit HTML and JSON snapshots", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "query", "build", "--expr", "PY=(2026)", "--task", "audit-export", "--tasks-root", root]);
  await cli.runQueryRecord(args, {
    prepareWosSession: async () => ({ page: {}, close: async () => {} }),
    runQueryBrowserCommand: async () => ({
      ok: true,
      taskId: args.taskId,
      operation: "query build",
      uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-bbbbbbbbbb",
      count: 5,
      rowText: "PY=(2026)",
      source: { kind: "expr", value: "PY=(2026)" },
    }),
  });

  const reportDir = path.join(root, "audit-report-output");
  const result = cli.runAuditExport(cli.parseArgs([
    "node", "cli", "db", "audit-export",
    "--task", "audit-export",
    "--tasks-root", root,
    "--report-dir", reportDir,
    "--format", "both",
    "--limit", "10",
  ]));
  assert.equal(result.ok, true);
  assert.equal(result.command, "db audit-export");
  assert.equal(fs.existsSync(path.join(reportDir, "audit-report.html")), true);
  assert.equal(fs.existsSync(path.join(reportDir, "audit-report.json")), true);

  const html = fs.readFileSync(path.join(reportDir, "audit-report.html"), "utf8");
  assert.match(html, /WOS Audit Report/);
  assert.match(html, /Command Manual/);
  assert.match(html, /CLI Help/);
  assert.match(html, /Recipes/);
  assert.match(html, /Search, ingest, and review a normal query/);
  assert.match(html, /copy-icon/);
  assert.match(html, /woscc\/summary/);
  assert.match(html, /timeline-field/);
  assert.match(html, /run-pill/);
  assert.doesNotMatch(html, /copy-all/);
  assert.doesNotMatch(html, /T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  const json = JSON.parse(fs.readFileSync(path.join(reportDir, "audit-report.json"), "utf8"));
  assert.equal(json.ok, true);
  assert.equal(json.taskId, "audit-export");
  assert.equal(json.stats.searches >= 1, true);
  assert.equal(json.stats.timeline >= 3, true);
  assert.equal(Array.isArray(json.commandDocs), true);
  assert.equal(json.commandDocs.some((page) => page.id === "recipes"), true);
  assert.equal(json.commandDocs.some((page) => page.id === "query"), true);
});

test("browser-side WOS ID page collection accumulates multiple pages", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "import", "wos.js"), "utf8");
  const method = source.match(/async collectWosIdsByUuidPages\(uuid, pages = 2, sortBy = 'relevance'\) \{[\s\S]*?\n    \}/);
  assert.ok(method, "collectWosIdsByUuidPages should be present");
  assert.match(method[0], /const allRows = \[\]/);
  assert.match(method[0], /for \(const row of pageRows \|\| \[\]\)/);
  assert.match(method[0], /this\.mergeIntoCache\(uuid, \{ page_wosids: allRows \}\)/);
  assert.match(method[0], /return allRows/);
});

test("Query debug mode reports session and browser command steps to stderr", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "query", "build", "--expr", "PY=(2026)", "--debug", "--task", "query-debug", "--tasks-root", root]);
  const stderr = [];
  const originalError = console.error;
  console.error = (line) => stderr.push(String(line));
  try {
    await cli.runQueryRecord(args, {
      prepareWosSession: async () => ({ page: {}, close: async () => {} }),
      runQueryBrowserCommand: async () => ({
        ok: true,
        taskId: args.taskId,
        operation: "query build",
        uuid: "12345678-1234-1234-1234-123456789abc-123456789a",
        count: 42,
        rowText: "PY=(2026)",
        source: { kind: "expr", value: "PY=(2026)" },
      }),
    });
  } finally {
    console.error = originalError;
  }
  assert.match(stderr.join("\n"), /\[debug\] query: preparing WOS session/);
  assert.match(stderr.join("\n"), /\[debug\] query: running browser command/);
  assert.match(stderr.join("\n"), /\[debug\] query: browser command complete/);
});

test("Query batch workflow reuses one session and prints LLM-readable JSONL items", async () => {
  const root = temporaryDirectory();
  const exprFile = path.join(root, "queries.txt");
  fs.writeFileSync(exprFile, "\n# ignored\nPY=(2025)\nPY=(2026)\n", "utf8");
  const args = cli.parseArgs(["node", "cli", "query", "batch", "--expr-file", exprFile, "--task", "query-batch", "--tasks-root", root]);
  let prepareCount = 0;
  const stdout = [];
  const summary = await cli.runQueryBatch(args, {
    prepareWosSession: async () => {
      prepareCount += 1;
      return { page: { id: "fake-page" }, close: async () => {} };
    },
    runQueryBrowserCommand: async (_page, itemArgs) => ({
      ok: true,
      taskId: itemArgs.taskId,
      operation: "query build",
      uuid: itemArgs.queryExpr.includes("2025")
        ? "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-aaaaaaaaaa"
        : "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-bbbbbbbbbb",
      count: itemArgs.queryExpr.includes("2025") ? 25 : 26,
      rowText: itemArgs.queryExpr,
      source: { kind: "expr", value: itemArgs.queryExpr },
      sortBy: "relevance",
    }),
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(prepareCount, 1);
  assert.equal(summary.ok, true);
  assert.equal(summary.total, 2);
  assert.equal(summary.completed, 2);
  assert.equal(summary.failed, 0);
  assert.equal(stdout.length, 2);
  const first = JSON.parse(stdout[0]);
  assert.equal(first.command, "query batch");
  assert.equal(first.uuid, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-aaaaaaaaaa");
  assert.equal(first.artifact, "https://www.webofscience.com/wos/woscc/summary/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-aaaaaaaaaa/relevance/1");
  assert.equal(first.data.index, 1);
  assert.equal(first.data.total, 2);
  assert.equal(first.data.expr, "PY=(2025)");
  assert.equal(first.data.queryText, "PY=(2025)");
  assert.equal(first.data.cached, false);
  assert.equal(first.data.url, first.artifact);
  assert.equal(JSON.stringify(first).includes("SECRET"), false);
  assert.equal(fs.existsSync(path.join(args.outDir, "project.json")), true);
  assert.equal(fs.existsSync(path.join(args.outDir, "state.json")), true);
  assert.equal(fs.existsSync(path.join(args.outDir, "audit", "activity.jsonl")), true);
  assert.equal(fs.existsSync(path.join(firstRunDir(args.outDir), "runtime.jsonl")), true);
});

test("Query batch reuses cached SQLite results without opening WOS", async () => {
  const root = temporaryDirectory();
  const seedArgv = ["node", "cli", "query", "build", "--task", "query-batch-cache", "--tasks-root", root];
  for (const [expr, uuid, count] of [
    ["PY=(2025)", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-aaaaaaaaaa", 25],
    ["PY=(2026)", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-bbbbbbbbbb", 26],
  ]) {
    const args = cli.parseArgs([...seedArgv, "--expr", expr]);
    await cli.runQueryRecord(args, {
      prepareWosSession: async () => ({ page: {}, close: async () => {} }),
      runQueryBrowserCommand: async () => ({
        ok: true,
        taskId: args.taskId,
        operation: "query build",
        uuid,
        count,
        rowText: expr,
        source: { kind: "expr", value: expr },
        sortBy: "relevance",
      }),
    });
  }

  let preparedBrowser = false;
  const stdout = [];
  const batchArgs = cli.parseArgs([
    "node", "cli", "query", "batch",
    "--expr", "PY=(2025)",
    "--expr", "PY=(2026)",
    "--task", "query-batch-cache",
    "--tasks-root", root,
  ]);
  const summary = await cli.runQueryBatch(batchArgs, {
    prepareWosSession: async () => {
      preparedBrowser = true;
      throw new Error("browser should not start when every batch item is cached");
    },
    writeStdout: (line) => stdout.push(line),
  });

  assert.equal(preparedBrowser, false);
  assert.equal(summary.ok, true);
  assert.equal(summary.completed, 2);
  assert.equal(stdout.length, 2);
  const rows = stdout.map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.data.cached), [true, true]);
  assert.deepEqual(rows.map((row) => row.uuid), [
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-aaaaaaaaaa",
    "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb-bbbbbbbbbb",
  ]);
});

test("parses SID check tasks", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "check", "--tasks-root", root]);
  assert.equal(args.command, "check");
  assert.equal(args.tasksRoot, root);
});

test("parses bundled browser install tasks", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "install-browser", "--with-deps", "--tasks-root", root]);
  assert.equal(args.command, "install-browser");
  assert.equal(args.withDeps, true);
  assert.equal(args.tasksRoot, root);
});

test("shows the saved SID pool with the active position", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "sid-pool", "--tasks-root", root]);

  cli.addSidsToConfig(args, ["SID_ONE", "SID_TWO"], { activate: true });
  const status = cli.currentSidPoolStatus(args);

  assert.equal(args.command, "sid-pool");
  assert.equal(status.sidPoolCount, 2);
  assert.equal(status.sidPoolIndex, 0);
  assert.equal(status.sidPoolPosition, 1);
  assert.equal(status.activeSid, "S***E");
  assert.deepEqual(status.sids, ["S***E", "S***O"]);
});

test("package exposes iiw as the short CLI alias", () => {
  const pkg = require("../package.json");
  assert.equal(pkg.bin["iiaide-wos"], "bin/iiaide-wos.js");
  assert.equal(pkg.bin.iiw, "bin/iiaide-wos.js");
});

test("bundled playwright install helper resolves the packaged cli.js", () => {
  const cliPath = playwrightInstall.bundledPlaywrightCliPath();
  assert.equal(path.basename(cliPath), "cli.js");
  assert.equal(fs.existsSync(cliPath), true);
  assert.match(cliPath, /playwright/);
});

test("bundled playwright install helper composes the local browser installer", () => {
  const calls = [];
  const result = playwrightInstall.installBundledPlaywrightBrowser({
    cliPath: "/tmp/playwright/cli.js",
    withDeps: true,
    run(command, argv, options) {
      calls.push({ command, argv, options });
      return { status: 0 };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].argv, ["/tmp/playwright/cli.js", "install", "--with-deps", "chromium"]);
  assert.equal(calls[0].options.stdio, "inherit");
  assert.equal(result.withDeps, true);
  assert.equal(result.browser, "chromium");
});

test("detects Playwright missing-browser launch failures", () => {
  assert.equal(
    playwrightInstall.isMissingPlaywrightBrowserError(
      new Error("browserType.launchPersistentContext: Executable doesn't exist at /root/.cache/ms-playwright/foo")
    ),
    true
  );
  assert.equal(playwrightInstall.isMissingPlaywrightBrowserError(new Error("WOS SID validation failed")), false);
});

test("supports WOS domain variables for generated URLs", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "bib", "--uuid", "abc", "--wos-domain", "access.example.edu", "--task", "refs", "--tasks-root", root,
  ]);

  assert.equal(args.wosDomain, "access.example.edu");
  assert.equal(args.baseUrl, "https://access.example.edu");
  assert.equal(args.url, "https://access.example.edu/wos/woscc/summary/abc/relevance/1");
});

test("uses the canonical Web of Science SID initialization URL", () => {
  assert.equal(
    cli.buildSidInitUrl("USW2EC0F65Ywm8LOVJHYvtqhrtPKt"),
    "https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=USW2EC0F65Ywm8LOVJHYvtqhrtPKt"
  );
});

test("WOS popup guard includes OneTrust accept and close selectors", () => {
  assert.ok(cli.WOS_POPUP_DISMISS_SELECTORS.includes("#onetrust-accept-btn-handler"));
  assert.ok(cli.WOS_POPUP_DISMISS_SELECTORS.includes("#onetrust-close-btn-container button"));
  assert.ok(cli.WOS_POPUP_DISMISS_SELECTORS.includes('button._pendo-close-guide[aria-label="Close"]'));
  assert.ok(cli.WOS_POPUP_DIALOG_SELECTORS.includes('div[role="dialog"][aria-label="Privacy"]'));
  assert.ok(cli.WOS_POPUP_DIALOG_SELECTORS.includes(".ot-sdk-container"));
  assert.equal(cli.WOS_POPUP_GUARD_OPTIONS.observeMs, 30000);
});

test("clears saved SID before browser-login repair", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "parse", "--task", "sid-repair", "--tasks-root", root]);
  writeJson(path.join(root, "config.json"), {
    version: 1,
    sid: "stale",
    baseUrl: "https://www.webofscience.com",
    wosDomain: "www.webofscience.com",
  });
  args.sid = "stale";
  args.sidSource = "config";

  assert.equal(cli.clearSavedSidConfig(args), true);
  assert.equal(args.sid, "");
  assert.equal(args.sidSource, "");
  assert.equal(readJson(path.join(root, "config.json")).sid, undefined);
  assert.equal(readJson(path.join(root, "config.json")).baseUrl, "https://www.webofscience.com");
});

test("missing Playwright browser error becomes a friendly repair message without prompting", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "parse", "--task", "demo", "--tasks-root", root]);

  await assert.rejects(
    () => cli.ensurePlaywrightBrowserInstalledForLaunch(
      args,
      new Error("browserType.launchPersistentContext: Executable doesn't exist at /root/.cache/ms-playwright/foo"),
      { canPrompt: () => false }
    ),
    (error) => {
      assert.equal(cli.isCliMessageError(error), true);
      assert.match(error.message, /iiaide-wos install-browser/);
      return true;
    }
  );
});

test("interactive missing Playwright browser repair runs bundled install before retry", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "parse", "--task", "demo", "--tasks-root", root]);
  const reports = [];
  const installs = [];
  const repaired = await cli.ensurePlaywrightBrowserInstalledForLaunch(
    args,
    new Error("Please run the following command to download new browsers"),
    {
      canPrompt: () => true,
      prompt: async () => "install",
      report(message) {
        reports.push(message);
      },
      install(options) {
        installs.push(options);
      },
    }
  );

  assert.equal(repaired, true);
  assert.deepEqual(installs, [{ withDeps: false }]);
  assert.match(reports.join("\n"), /Installing Playwright Chromium/);
});

test("restart argv sanitization removes explicit SID values", () => {
  assert.deepEqual(
    cli.omitSidArgs(["node", "cli", "parse", "--sid", "bad", "--task", "demo"]),
    ["node", "cli", "parse", "--task", "demo"]
  );
  assert.deepEqual(
    cli.omitSidArgs(["node", "cli", "parse", "--task", "demo"]),
    ["node", "cli", "parse", "--task", "demo"]
  );
});

test("detects readline Ctrl+C abort errors", () => {
  assert.equal(cli.isUserAbortError({ name: "AbortError", message: "Aborted with Ctrl+C" }), true);
  assert.equal(cli.isUserAbortError({ code: "ABORT_ERR", message: "aborted" }), true);
  assert.equal(cli.isUserAbortError(new Error("normal failure")), false);
});

test("calculates WOS download batches in 500-record chunks by default", () => {
  assert.equal(cli.downloadBatchCount(0), 0);
  assert.equal(cli.downloadBatchCount(1), 1);
  assert.equal(cli.downloadBatchCount(500), 1);
  assert.equal(cli.downloadBatchCount(501), 2);
  assert.equal(cli.downloadBatchCount(1001), 3);
});

test("formats per-UUID download window progress details without batch wording", () => {
  assert.equal(cli.formatDownloadWindowDetail(1, 2, "79001-79500"), "download 1/2 79001-79500");
  assert.equal(cli.formatDownloadWindowDetail(2, 2), "download 2/2");
  assert.equal(cli.formatUuidRemainingDetail(1, 4), "uuids 1/4 done, 3 left");
  assert.equal(cli.formatUuidRemainingDetail(5, 4), "uuids 4/4 done, 0 left");
  assert.equal(
    cli.formatBatchUuidDownloadDetail({ batchUuidProgress: { completed: 1, total: 4 } }, "download 1/2 79001-79500"),
    "uuids 1/4 done, 3 left | download 1/2 79001-79500"
  );
});

test("counts batch UUID download windows from missing work", () => {
  assert.equal(cli.downloadWindowCountForState({ complete: false, plan: { missingBatches: [{ markFrom: 1, markTo: 500 }] } }), 1);
  assert.equal(cli.downloadWindowCountForState({
    complete: false,
    plan: {
      exportWindows: [
        { plan: { missingBatches: [{ markFrom: 1, markTo: 500 }] } },
        { plan: { missingBatches: [{ markFrom: 1, markTo: 500 }] } },
      ],
    },
  }), 2);
  assert.equal(cli.downloadWindowCountForState({
    complete: false,
    plan: {
      exportWindows: [
        { plan: { missingBatches: [] } },
        { plan: { missingBatches: [{ markFrom: 1, markTo: 500 }] } },
      ],
    },
  }), 1);
  assert.equal(cli.downloadWindowCountForState({ complete: true, plan: { missingBatches: [{ markFrom: 1, markTo: 500 }] } }), 0);

  const paths = cli.getRunPaths(temporaryDirectory());
  const largeState = cli.rawUuidDownloadState(paths, "query", { uuid: "query", expectedCount: 200000 });
  assert.equal(cli.downloadWindowCountForState(largeState), 2);
});

test("calculates bounded WOS record ranges before download planning", () => {
  assert.equal(cli.boundedRecordCount(800, 1, 0), 800);
  assert.equal(cli.boundedRecordCount(800, 1, 200), 200);
  assert.equal(cli.boundedRecordCount(800, 201, 200), 200);
  assert.equal(cli.boundedRecordCount(800, 701, 200), 100);
  assert.equal(cli.boundedRecordCount(800, 900, 200), 0);
  assert.deepEqual(cli.selectedRecordRange(800, 400, 201), {
    availableCount: 800,
    startIndex: 400,
    endIndex: 600,
    selectedCount: 201,
    bounded: true,
  });
});

test("interactive task hints show only numbered task IDs", () => {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk, ...args) => {
    output += String(chunk);
    const callback = args.find((item) => typeof item === "function");
    if (callback) callback();
    return true;
  };
  try {
    listTaskHints({
      latestTask: "second",
      tasks: [
        { taskId: "first", status: "completed", uniqueCount: 8 },
        { taskId: "second", status: "failed", uniqueCount: 3 },
      ],
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(output, /Tasks in this directory/);
  assert.match(output, /#\s+Task ID/);
  assert.match(output, /1\s+first/);
  assert.match(output, /2\s+second/);
  assert.doesNotMatch(output, /completed|failed|latest|WOS IDs/);
});

test("interactive task hints highlight the current task in a TTY", () => {
  const originalWrite = process.stdout.write;
  const originalIsTty = process.stdout.isTTY;
  const originalTerm = process.env.TERM;
  const originalCi = process.env.CI;
  const originalNoColor = process.env.NO_COLOR;
  let output = "";
  process.stdout.write = (chunk, ...args) => {
    output += String(chunk);
    const callback = args.find((item) => typeof item === "function");
    if (callback) callback();
    return true;
  };
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  process.env.TERM = "xterm-256color";
  delete process.env.CI;
  delete process.env.NO_COLOR;
  try {
    listTaskHints({
      currentTask: "second",
      tasks: [{ taskId: "first" }, { taskId: "second" }],
    });
  } finally {
    process.stdout.write = originalWrite;
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTty, configurable: true });
    if (originalTerm === undefined) delete process.env.TERM;
    else process.env.TERM = originalTerm;
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  }

  assert.match(output, /\x1b\[1;30;46msecond\x1b\[0m \*/);
});

test("interactive task selection accepts task numbers and new task ids", () => {
  const workspace = {
    latestTask: "second",
    tasks: [
      { taskId: "first" },
      { taskId: "second" },
    ],
  };

  const indexed = resolveTaskSelection(workspace, "2", "second");
  assert.equal(indexed.taskId, "second");
  assert.equal(indexed.task.taskId, "second");
  assert.equal(indexed.fromIndex, true);

  const invalidIndex = resolveTaskSelection(workspace, "9", "second");
  assert.equal(invalidIndex.taskId, "9");
  assert.equal(invalidIndex.task, null);
  assert.equal(invalidIndex.invalidIndex, true);

  const created = resolveTaskSelection(workspace, "new-task", "second");
  assert.equal(created.taskId, "new-task");
  assert.equal(created.task, undefined);
  assert.equal(created.fromIndex, false);

  const fallback = resolveTaskSelection(workspace, "", "second");
  assert.equal(fallback.taskId, "second");
  assert.equal(fallback.task.taskId, "second");

  const keyword = resolveTaskSelection(workspace, "new", "second", "TID20260610120000");
  assert.equal(keyword.taskId, "TID20260610120000");
  assert.equal(keyword.task, null);
  assert.equal(keyword.isNew, true);

  const back = resolveTaskSelection(workspace, "B", "second", "TID20260610120000");
  assert.equal(back.back, true);
  assert.equal(back.taskId, "");

  const quit = resolveTaskSelection(workspace, "q", "second", "TID20260610120000");
  assert.equal(quit.quit, true);
  assert.equal(quit.taskId, "");
});

test("interactive task prompt copy separates resume/create from clear", () => {
  assert.equal(
    taskPromptHelp("new", "TID20260610120000", "TID20260610120000", 2),
    "Enter creates TID20260610120000; type a custom task id; B goes back; q quits"
  );
  assert.equal(
    taskPromptHelp("any", "latest-task", "TID20260610120000", 2),
    "Enter keeps latest-task; type 1-2 to switch; type new to create TID20260610120000; type a custom task id; B goes back; q quits"
  );
  assert.equal(
    taskPromptHelp("existing", "latest-task", "TID20260610120000", 2),
    "Enter keeps latest-task; type 1-2 to select an existing task; type an exact task id; B goes back; q quits"
  );
  assert.equal(
    taskSelectionHint("any", "latest-task", "TID20260610120000", 2),
    [
      "  Enter  keep latest-task",
      "  1-2    switch to a listed task",
      "  new    create TID20260610120000",
      "  custom type a custom task id",
      "  B      back",
      "  q      quit",
    ].join("\n")
  );
  assert.equal(
    taskSelectionHint("new", "TID20260610120000", "TID20260610120000", 2),
    [
      "  Enter  create TID20260610120000",
      "  custom type a custom task id",
      "  B      back",
      "  q      quit",
    ].join("\n")
  );
  assert.equal(
    taskSelectionHint("existing", "latest-task", "TID20260610120000", 2),
    [
      "  Enter  keep latest-task",
      "  1-2    select an existing task",
      "  custom type an exact task id",
      "  B      back",
      "  q      quit",
    ].join("\n")
  );
});

test("interactive workflow menu uses folded command groups", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "interactive.js"), "utf8");
  const workflowMatch = source.match(/async function askWorkflow[\s\S]*?\n}\n\nasync function promptSid/);
  const argsMatch = source.match(/const choice = await askWorkflow[\s\S]*?\n  } finally/);
  assert.ok(workflowMatch, "askWorkflow source should be present");
  assert.ok(argsMatch, "interactiveArgs workflow branch should be present");
  assert.doesNotMatch(workflowMatch[0], /Authentication/);
  assert.doesNotMatch(workflowMatch[0], /0\.1", "Check SID/);
  assert.match(workflowMatch[0], /Download literature/);
  assert.match(workflowMatch[0], /1\.1", "UUID - TXT format/);
  assert.match(workflowMatch[0], /1\.2", "UUID - BIB format/);
  assert.match(workflowMatch[0], /1\.3", "Batch UUID CSV - TXT/);
  assert.match(workflowMatch[0], /projectMode/);
  assert.match(workflowMatch[0], /3\.3", "Clear data/);
  assert.doesNotMatch(workflowMatch[0], /WOS IDs to SQL/);
  assert.doesNotMatch(workflowMatch[0], /2\.1", "Resume/);
  assert.doesNotMatch(workflowMatch[0], /Parse"\)/);
  assert.doesNotMatch(workflowMatch[0], /2\.2/);
  assert.doesNotMatch(workflowMatch[0], /WOSID CSV/);
  assert.match(workflowMatch[0], /3\.1", "New/);
  assert.match(workflowMatch[0], /3\.2", "Switch/);
  assert.match(workflowMatch[0], /3\.3", "Clear/);
  assert.doesNotMatch(workflowMatch[0], /SQL database/);
  assert.doesNotMatch(workflowMatch[0], /Merge database/);
  assert.doesNotMatch(workflowMatch[0], /Query WOSID/);
  assert.match(workflowMatch[0], /Settings/);
  assert.match(workflowMatch[0], /5\.1", "Playwright visible/);
  assert.match(workflowMatch[0], /5\.2", "Add SIDs/);
  assert.doesNotMatch(workflowMatch[0], /5\.3", "Clear all SIDs/);
  assert.match(workflowMatch[0], /5\.4", "Clear dead SIDs/);
  assert.doesNotMatch(workflowMatch[0], /Parse tabs/);
  assert.match(workflowMatch[0], /Auth producer/);
  assert.match(workflowMatch[0], /6\.1", "MUST login/);
  assert.match(workflowMatch[0], /6\.2", "MUST monitor/);
  assert.match(workflowMatch[0], /shortcutRow/);
  assert.match(workflowMatch[0], /\["\?", "Commands doc"\]/);
  assert.match(workflowMatch[0], /\["c", "Check SID"\]/);
  assert.match(workflowMatch[0], /\["u", "Update"\]/);
  assert.match(workflowMatch[0], /\["B", "Back"\]/);
  assert.match(workflowMatch[0], /\["q", "Exit"\]/);
  assert.match(workflowMatch[0], /choice === "\?" \|\| choice === "help" \|\| choice === "docs"/);
  assert.doesNotMatch(workflowMatch[0], /Probe the saved SID/);
  assert.doesNotMatch(workflowMatch[0], /Install the latest release/);
  assert.doesNotMatch(workflowMatch[0], /Return to the workspace menu/);
  assert.match(workflowMatch[0], /choose \$\{projectMode \? "1\.1, 1\.2, 1\.3, 3\.3, 5\.1, 5\.2, 5\.4, 6\.1, 6\.2" : "1\.1, 1\.2, 1\.3, 3\.1, 3\.2, 3\.3, 5\.1, 5\.2, 5\.4, 6\.1, 6\.2"\}, \? to open command docs, c to check SID, u to update, B to go back/);
  assert.doesNotMatch(workflowMatch[0], /choose .*5\.3/);
  assert.doesNotMatch(workflowMatch[0], /Download WOS IDs/);
  assert.match(argsMatch[0], /choice === "\?"/);
  assert.match(argsMatch[0], /openUrl\(COMMAND_DOC_URL\)/);
  assert.match(argsMatch[0], /choice === "c"/);
  assert.match(argsMatch[0], /return \["check", "--tasks-root", activeWorkspace\.tasksRoot\]/);
  assert.match(argsMatch[0], /choice === "u"/);
  assert.match(argsMatch[0], /return \["update"\]/);
  assert.match(argsMatch[0], /choice === "1\.3"/);
  assert.match(argsMatch[0], /activeWorkspace\.projectMode/);
  assert.match(argsMatch[0], /\["batch-run", "--allow-large-export"\]/);
  assert.match(argsMatch[0], /\["batch-run", "--task", taskId, "--tasks-root", activeWorkspace\.tasksRoot, "--allow-large-export"\]/);
  assert.match(argsMatch[0], /choice === "3\.1"/);
  assert.match(argsMatch[0], /mode: "new"/);
  assert.match(argsMatch[0], /choice === "3\.2"/);
  assert.match(argsMatch[0], /choice === "3\.3"/);
  assert.doesNotMatch(argsMatch[0], /choice === "4\.1"/);
  assert.doesNotMatch(argsMatch[0], /appendWosDataDbArg/);
  assert.doesNotMatch(argsMatch[0], /wosdata/);
  assert.match(argsMatch[0], /choice === "5\.1"/);
  assert.match(argsMatch[0], /helpers\.setPlaywrightVisible/);
  assert.match(argsMatch[0], /choice === "5\.2"/);
  assert.doesNotMatch(argsMatch[0], /choice === "5\.3"/);
  assert.doesNotMatch(argsMatch[0], /helpers\.clearSids/);
  assert.match(argsMatch[0], /choice === "5\.4"/);
  assert.match(argsMatch[0], /helpers\.clearDeadSids/);
  assert.doesNotMatch(argsMatch[0], /helpers\.setParseConcurrency/);
  assert.doesNotMatch(argsMatch[0], /choice === "5\.5"/);
  assert.match(argsMatch[0], /choice === "6\.1"/);
  assert.match(argsMatch[0], /choice === "6\.2"/);
  assert.match(argsMatch[0], /helpers\.addSids/);
  assert.match(argsMatch[0], /\["auth", "login", "--provider", "must", "--tasks-root", activeWorkspace\.tasksRoot\]/);
  assert.match(argsMatch[0], /\["auth", "monitor", "--provider", "must", "--tasks-root", activeWorkspace\.tasksRoot\]/);
  assert.doesNotMatch(argsMatch[0], /SQL SELECT query/);
  assert.doesNotMatch(argsMatch[0], /Force overwrite existing SQL rows/);
  assert.doesNotMatch(argsMatch[0], /choice === "2"/);
  assert.doesNotMatch(argsMatch[0], /classifyWosIdsToSqlInput/);
  assert.doesNotMatch(argsMatch[0], /"parse-pipeline"/);
  assert.doesNotMatch(argsMatch[0], /askParseOptions/);
  assert.doesNotMatch(argsMatch[0], /Change parse options/);
  assert.match(argsMatch[0], /choice === "1\.2" \? "bib"/);
});

test("interactive command docs opener uses the platform browser command", () => {
  const calls = [];
  const fakeSpawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref: () => calls.push({ unref: true }) };
  };

  assert.deepEqual(openUrl("https://example.test/docs", { platform: "darwin", spawn: fakeSpawn }), {
    command: "open",
    args: ["https://example.test/docs"],
  });
  assert.deepEqual(openUrl("https://example.test/docs", { platform: "linux", spawn: fakeSpawn }), {
    command: "xdg-open",
    args: ["https://example.test/docs"],
  });
  assert.deepEqual(openUrl("https://example.test/docs", { platform: "win32", spawn: fakeSpawn }), {
    command: "cmd",
    args: ["/c", "start", "", "https://example.test/docs"],
  });
  assert.equal(calls.filter((call) => call.unref).length, 3);
  assert.ok(calls.every((call) => call.unref || call.options.detached));
});

test("interactive saved source only accepts WOS-like values", () => {
  assert.equal(isWosSourceLike("q"), false);
  assert.equal(isWosSourceLike("c"), false);
  assert.equal(isWosSourceLike("cancel"), false);
  assert.equal(isWosSourceLike("ofscience.com/wos/woscc/summary/01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc/date-descending/1"), true);
  assert.equal(isWosSourceLike("01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc"), true);
});

test("interactive downloads use the current task selection", () => {
  const workspace = {
    currentTask: "selected",
    latestTask: "selected",
    tasks: [{ taskId: "selected" }, { taskId: "other" }],
  };
  const selection = currentTaskSelection(workspace);
  assert.equal(selection.taskId, "selected");
  assert.equal(selection.task.taskId, "selected");
});

test("interactive header shows WOS browser mode and profile name", () => {
  const originalWrite = process.stdout.write;
  const originalColumns = process.stdout.columns;
  let output = "";
  process.stdout.write = (chunk, ...args) => {
    output += String(chunk);
    const callback = args.find((item) => typeof item === "function");
    if (callback) callback();
    return true;
  };
  process.stdout.columns = 120;
  try {
    printHeader("0.0.0", {
      initialized: true,
      tasksRoot: "/tmp/tasks",
      taskCount: 0,
      currentTask: "TID20260610120000",
      wosBrowserMode: "background",
      wosProfileName: ".browser-profile",
      runtimeMs: 65000,
      sid: "current-sid",
      sidPoolCount: 3,
      sidPoolIndex: 1,
      authMonitor: { label: "must monitor running, min-sids 2" },
      sidCheck: { origin: "https://www.webofscience.com" },
    });
  } finally {
    process.stdout.write = originalWrite;
    process.stdout.columns = originalColumns;
  }

  assert.match(output, /Playwright\s+background/);
  assert.doesNotMatch(output, /Parse Tabs/);
  assert.match(output, /SID Value\s+curr...-sid/);
  assert.match(output, /SID Pool\s+2\/3/);
  assert.match(output, /SID Producer\s+must monitor running, min-sids 2/);
  assert.doesNotMatch(output, /Dead SIDs/);
  assert.match(output, /Profile\s+\.browser-profile/);
  assert.match(output, /Task ID\s+TID20260610120000/);
  assert.doesNotMatch(output, /WOS DB/);
  assert.doesNotMatch(output, /WOS IDs\s+0/);
  assert.doesNotMatch(output, /Blacklist DB/);
  assert.doesNotMatch(output, /Blacklist\s+0/);
  assert.doesNotMatch(output, /DB Size/);
  assert.doesNotMatch(output, /Tasks\s+\d+ tasks/);
  assert.match(output, /Runtime\s+1m 05s/);
  assert.match(output, /iiaide-wos CLI/);
  assert.match(output, /https:\/\/www\.webofscience\.com/);
  assert.doesNotMatch(output, /Origin\s+https:\/\/www\.webofscience\.com/);
  const titleLine = output.split(/\r?\n/).find((line) => line.includes("iiaide-wos CLI") && line.trim().startsWith("|"));
  const originLine = output.split(/\r?\n/).find((line) => line.includes("https://www.webofscience.com"));
  const creditLine = output.split(/\r?\n/).find((line) => line.includes("lyj"));
  const dateLine = output.split(/\r?\n/).find((line) => line.includes("2026-06-10"));
  assert.ok(titleLine);
  assert.ok(originLine);
  assert.ok(creditLine);
  assert.ok(dateLine);
  assert.ok(titleLine.indexOf("iiaide-wos CLI") > 8);
  assert.ok(originLine.indexOf("https://www.webofscience.com") > 8);
  assert.ok(creditLine.indexOf("lyj") > 8);
  assert.ok(dateLine.indexOf("2026-06-10") > 8);
  assert.doesNotMatch(output, /\+----------\+|<\/>/);
  assert.doesNotMatch(output, /___\/\)|\(___\//);
  assert.doesNotMatch(output, /Author\s+@lyj/);
  assert.doesNotMatch(output, /Last Update\s+2026-06-10/);
  assert.doesNotMatch(output, /Started/);
  assert.doesNotMatch(output, /Web of Science task workspace|URL \/ UUID \/ CSV/);
  const panelRows = output
    .split(/\r?\n/)
    .filter((line) => /\|.*\|\s+\|.*\|/.test(line));
  assert.equal(panelRows.length, 11);
  assert.match(panelRows[0], /^\| {50}\|/);
  const logoRowIndex = panelRows.findIndex((line) => line.includes("[ W O S - C L I ]"));
  assert.ok(logoRowIndex > 0);
  assert.ok(panelRows.length - logoRowIndex > 4);
});

test("interactive dashboard logo uses highlighted background in a TTY", () => {
  const originalWrite = process.stdout.write;
  const originalColumns = process.stdout.columns;
  const originalIsTty = process.stdout.isTTY;
  const originalTerm = process.env.TERM;
  const originalCi = process.env.CI;
  const originalNoColor = process.env.NO_COLOR;
  let output = "";
  process.stdout.write = (chunk, ...args) => {
    output += String(chunk);
    const callback = args.find((item) => typeof item === "function");
    if (callback) callback();
    return true;
  };
  process.stdout.columns = 120;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  process.env.TERM = "xterm-256color";
  delete process.env.CI;
  delete process.env.NO_COLOR;
  try {
    printHeader("0.0.0", {
      tasksRoot: "/tmp/tasks",
      currentTask: "TID20260610120000",
      sidCheck: { origin: "https://www.webofscience.com" },
    });
  } finally {
    process.stdout.write = originalWrite;
    process.stdout.columns = originalColumns;
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTty, configurable: true });
    if (originalTerm === undefined) delete process.env.TERM;
    else process.env.TERM = originalTerm;
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
  }

  assert.match(output, /\x1b\[1;30;43m\[ W O S - C L I \]\x1b\[0m/);
  assert.match(output, /\x1b\[1;30;46mTID20260610120000\x1b\[0m/);
});

test("formats runtime for the interactive dashboard", () => {
  assert.equal(formatRuntime(0), "0s");
  assert.equal(formatRuntime(9000), "9s");
  assert.equal(formatRuntime(65000), "1m 05s");
  assert.equal(formatRuntime(7380000), "2h 03m");
  assert.equal(cli.formatRuntime(0), "0s");
  assert.equal(cli.formatRuntime(9000), "9s");
  assert.equal(cli.formatRuntime(65000), "1m 05s");
  assert.equal(cli.formatRuntime(7380000), "2h 03m");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
});

test("uses one workspace-scoped WOS Playwright profile", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root]);
  assert.equal(cli.wosUserDataDir(args), path.join(root, ".browser-profile"));
  assert.equal(cli.wosProfileName(args), ".browser-profile");
  assert.equal(cli.wosBrowserMode(args), "background");

  const status = cli.workspaceStatus(args);
  assert.equal(status.wosProfileName, ".browser-profile");
  assert.equal(status.wosProfilePath, path.join(root, ".browser-profile"));
  assert.equal(status.wosBrowserMode, "background");
  assert.equal(typeof status.runtimeMs, "number");
  assert.ok(status.runtimeMs >= 0);
  assert.equal("wosDataDb" in status, false);
});

test("persists visible Playwright mode in workspace config", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root]);
  const saved = cli.setPlaywrightVisibleSetting(args, true);

  assert.equal(saved.playwrightVisible, true);
  assert.equal(readJson(path.join(root, "config.json")).playwrightVisible, true);

  const configured = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root]);
  assert.equal(configured.headed, true);
  assert.equal(cli.wosBrowserMode(configured), "visible");
  assert.equal(cli.workspaceStatus(configured).playwrightVisible, true);

  const oneOffBackground = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root, "--headless"]);
  assert.equal(oneOffBackground.headed, false);
  assert.equal(cli.wosBrowserMode(oneOffBackground), "background");

  cli.setPlaywrightVisibleSetting(configured, false);
  const disabled = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root]);
  assert.equal(disabled.headed, false);
  assert.equal(cli.workspaceStatus(disabled).wosBrowserMode, "background");
});

test("settings command can add single and batch SID pool values", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "settings",
    "--tasks-root", root,
    "--add-sid", "one",
    "--add-sids", "two three\none",
  ]);

  const originalLog = console.log;
  let output = "";
  console.log = (value = "") => {
    output += `${value}\n`;
  };
  try {
    assert.equal(await cli.executeCommand(args), 0);
  } finally {
    console.log = originalLog;
  }

  const result = JSON.parse(output);
  assert.equal(result.sidPoolCount, 3);
  assert.equal(result.added, 3);
  assert.deepEqual(readJson(cli.globalConfigPath()).sids, ["one", "two", "three"]);
});

test("auth command parses MUST login and monitor options", () => {
  const root = temporaryDirectory();
  const loginArgs = cli.parseArgs([
    "node", "cli", "auth", "login",
    "--provider", "must",
    "--account", "one@example.edu",
    "--password", "secret-one",
    "--auth-url", "https://login.example.test",
    "--retries", "2",
    "--json",
    "--tasks-root", root,
  ]);
  assert.equal(loginArgs.command, "auth");
  assert.equal(loginArgs.authCommand, "login");
  assert.equal(loginArgs.authProvider, "must");
  assert.deepEqual(loginArgs.authAccounts, ["one@example.edu"]);
  assert.deepEqual(loginArgs.authPasswords, ["secret-one"]);
  assert.equal(loginArgs.authLoginUrl, "https://login.example.test");
  assert.equal(loginArgs.authRetries, 2);
  assert.equal(loginArgs.json, true);

  const monitorArgs = cli.parseArgs([
    "node", "cli", "auth", "monitor",
    "--account", "one@example.edu",
    "--password", "secret-one",
    "--account", "two@example.edu",
    "--password", "secret-two",
    "--min-sids", "3",
    "--interval-ms", "5000",
    "--retry-delay-ms", "7000",
    "--max-checks", "4",
    "--quiet",
    "--tasks-root", root,
  ]);
  assert.equal(monitorArgs.authCommand, "monitor");
  assert.deepEqual(monitorArgs.authAccounts, ["one@example.edu", "two@example.edu"]);
  assert.deepEqual(monitorArgs.authPasswords, ["secret-one", "secret-two"]);
  assert.equal(monitorArgs.authMinSids, 3);
  assert.equal(monitorArgs.authIntervalMs, 5000);
  assert.equal(monitorArgs.authRetryDelayMs, 7000);
  assert.equal(monitorArgs.authMaxChecks, 4);
  assert.equal(monitorArgs.authQuiet, true);
});

test("auth login saves captured MUST SID without printing the full value", async () => {
  const root = temporaryDirectory();
  const fullSid = "SIDSECRET1234567890";
  const args = cli.parseArgs([
    "node", "cli", "auth", "login",
    "--account", "user@example.edu",
    "--password", "secret",
    "--quiet",
    "--tasks-root", root,
  ]);
  const deps = {
    ...cli.authDependencies(args),
    login: async (loginArgs) => {
      assert.equal(loginArgs.account, "user@example.edu");
      assert.equal(loginArgs.password, "secret");
      return { sid: fullSid, finalUrl: "https://www.webofscience.com/wos/" };
    },
  };

  const originalLog = console.log;
  let output = "";
  console.log = (value = "") => {
    output += `${value}\n`;
  };
  try {
    assert.equal(await cli.executeAuthCommand(args, deps, { canPrompt: () => false, progress: () => {} }), 0);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(readJson(cli.globalConfigPath()).sids, [fullSid]);
  assert.doesNotMatch(output, new RegExp(fullSid));
  assert.match(output, /SID/);
  assert.match(output, /pool=1/);
});

test("auth monitor keeps threshold as a compatibility alias for min-sids", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "auth", "monitor",
    "--account", "one@example.edu",
    "--password", "secret-one",
    "--threshold", "4",
    "--tasks-root", root,
  ]);
  assert.equal(args.authMinSids, 4);
});

test("auth monitor status heartbeat reports running, stale, and off", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "auth", "monitor",
    "--account", "one@example.edu",
    "--password", "secret-one",
    "--min-sids", "2",
    "--interval-ms", "3000",
    "--tasks-root", root,
  ]);

  assert.equal(cli.readAuthMonitorStatus().status, "off");

  const running = cli.writeAuthMonitorStatus(args, {
    status: "running",
    checks: 1,
    triggered: 0,
  });
  const runningMs = Date.parse(running.updatedAt);
  const fresh = cli.readAuthMonitorStatus({ nowMs: runningMs + 1000 });
  assert.equal(fresh.status, "running");
  assert.equal(fresh.label, "must monitor running, min-sids 2");
  assert.equal(fresh.checks, 1);
  assert.equal(fresh.triggered, 0);

  const stale = cli.readAuthMonitorStatus({ nowMs: runningMs + 20000 });
  assert.equal(stale.status, "stale");
  assert.equal(stale.label, "must monitor stale");

  cli.writeAuthMonitorStatus(args, {
    status: "stopped",
    checks: 2,
    triggered: 1,
  });
  const stopped = cli.readAuthMonitorStatus();
  assert.equal(stopped.status, "off");
  assert.equal(stopped.label, "off");
});

test("auth monitor refreshes SID pool when count is at min-sids", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "auth", "monitor",
    "--account", "one@example.edu",
    "--password", "secret-one",
    "--min-sids", "2",
    "--max-checks", "1",
    "--quiet",
    "--tasks-root", root,
  ]);
  let loginCalls = 0;
  const deps = {
    ...cli.authDependencies(args),
    login: async () => {
      loginCalls += 1;
      return { sid: `SIDMONITOR${loginCalls}`, finalUrl: "https://www.webofscience.com/wos/" };
    },
  };

  const originalLog = console.log;
  let output = "";
  console.log = (value = "") => {
    output += `${value}\n`;
  };
  try {
    assert.equal(await cli.executeAuthCommand(args, deps, {
      canPrompt: () => false,
      progress: () => {},
      sleep: async () => {},
      installSignalHandlers: false,
    }), 0);
  } finally {
    console.log = originalLog;
  }

  assert.equal(loginCalls, 1);
  assert.deepEqual(readJson(cli.globalConfigPath()).sids, ["SIDMONITOR1"]);
  assert.ok(fs.existsSync(cli.authMonitorStatusPath()));
  assert.equal(cli.readAuthMonitorStatus().status, "off");
  assert.match(output, /checks=1/);
  assert.match(output, /triggered=1/);
});

test("auth monitor waits and keeps running after a refresh login failure", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "auth", "monitor",
    "--account", "one@example.edu",
    "--password", "secret-one",
    "--min-sids", "2",
    "--retries", "0",
    "--max-checks", "2",
    "--quiet",
    "--tasks-root", root,
  ]);
  let loginCalls = 0;
  const deps = {
    ...cli.authDependencies(args),
    login: async () => {
      loginCalls += 1;
      if (loginCalls === 1) {
        throw new Error("Login succeeded but SID was not found. Final URL: chrome-error://chromewebdata/");
      }
      return { sid: "SIDMONITOR2", finalUrl: "https://www.webofscience.com/wos/" };
    },
  };
  const sleeps = [];
  const progress = [];

  const originalLog = console.log;
  let output = "";
  console.log = (value = "") => {
    output += `${value}\n`;
  };
  try {
    assert.equal(await cli.executeAuthCommand(args, deps, {
      canPrompt: () => false,
      progress: (message) => progress.push(message),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      installSignalHandlers: false,
    }), 0);
  } finally {
    console.log = originalLog;
  }

  assert.equal(loginCalls, 2);
  assert.deepEqual(sleeps, [60000]);
  assert.deepEqual(readJson(cli.globalConfigPath()).sids, ["SIDMONITOR2"]);
  assert.match(progress.join("\n"), /refresh failed: Login succeeded but SID was not found/);
  assert.match(progress.join("\n"), /waiting 1m before retrying/);
  assert.match(output, /checks=2/);
  assert.match(output, /triggered=1/);
});

test("runs WOS Playwright in background unless visible browser is requested", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root]);
  const background = cli.wosBrowserLaunchOptions(args, false);
  const visible = cli.wosBrowserLaunchOptions(args, true);

  assert.equal(background.headless, true);
  assert.deepEqual(background.viewport, { width: 1280, height: 900 });
  assert.match(background.args.join(" "), /--window-position=/);
  assert.equal(visible.headless, false);
  assert.deepEqual(visible.args, []);
});

test("resolves the browser-side wos.js injection file", () => {
  const root = temporaryDirectory();
  const custom = path.join(root, "wos.js");
  fs.writeFileSync(custom, "window.wos = {};\n");
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root, "--wosjs", custom]);

  assert.equal(cli.resolveWosJsPath(args), custom);
  assert.equal(cli.requireWosJsPath(args), custom);
  assert.match(cli.resolveWosJsPath(cli.parseArgs(["node", "cli", "workspace"])), /import[\\/]wos\.js$/);
});

test("normalizes protocol-less WOS summary strings passed as UUID input", () => {
  const root = temporaryDirectory();
  const source = "ofscience.com/wos/woscc/summary/01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc/date-descending/1";
  const args = cli.parseArgs(["node", "cli", "bib", "--uuid", source, "--task", "refs", "--tasks-root", root]);

  assert.equal(args.uuid, "01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc");
  assert.equal(
    args.url,
    "https://www.webofscience.com/wos/woscc/summary/01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc/date-descending/1"
  );
});

test("extracts UUIDs from free-form CSV text", () => {
  const uuids = cli.extractUuidsFromText([
    "uuid",
    "01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc",
    "ignore,this,cell",
    "https://www.webofscience.com/wos/woscc/summary/11111111-2222-3333-4444-555555555555-6666666666/relevance/1",
    "01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc",
  ].join("\n"));

  assert.deepEqual(uuids, [
    "01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc",
    "11111111-2222-3333-4444-555555555555-6666666666",
  ]);
});

test("normalizes protocol-less WOS summary strings passed as URL input", () => {
  const root = temporaryDirectory();
  const source = "ofscience.com/wos/woscc/summary/01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc/date-descending/1";
  const args = cli.parseArgs(["node", "cli", "run", "--url", source, "--task", "refs", "--tasks-root", root]);

  assert.equal(args.uuid, "01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc");
  assert.equal(
    args.url,
    "https://www.webofscience.com/wos/woscc/summary/01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc/date-descending/1"
  );
});

test("rebases generated summary URLs to the validated WOS origin", () => {
  const args = cli.parseArgs(["node", "cli", "bib", "--uuid", "abc", "--task", "refs"]);
  const changed = cli.applyValidatedWosOrigin(args, { origin: "https://access.webofscience.com" });

  assert.equal(changed, true);
  assert.equal(args.baseUrl, "https://access.webofscience.com");
  assert.equal(args.url, "https://access.webofscience.com/wos/woscc/summary/abc/relevance/1");

  const absolute = cli.parseArgs([
    "node", "cli", "bib", "--url", "https://custom.example/wos/woscc/summary/abc/relevance/1", "--task", "refs",
  ]);
  assert.equal(cli.applyValidatedWosOrigin(absolute, { origin: "https://access.webofscience.com" }), false);
  assert.equal(absolute.url, "https://custom.example/wos/woscc/summary/abc/relevance/1");
});

test("uses page context UUID when WOS exposes a final record-query UUID", () => {
  assert.equal(cli.pageContextUuid({ uuid: "page-qid" }, "input-qid"), "page-qid");
  assert.equal(cli.pageContextUuid({}, "input-qid"), "input-qid");
});

test("extracts WOS UUIDs with 8-4-4-4-12-10 structure", () => {
  assert.equal(
    cli.extractUuid("ofscience.com/wos/woscc/summary/01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc/date-descending/1"),
    "01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc"
  );
  assert.equal(
    cli.extractUuid("01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc"),
    "01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc"
  );
});

test("announces resolved WOS UUID for reusable export preparation", () => {
  const lines = [];
  const announced = cli.announceResolvedWosUuid({ uuid: "01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc" }, (line) => lines.push(line));

  assert.equal(announced, true);
  assert.deepEqual(lines, ["Resolved WOS UUID: 01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc"]);
  assert.equal(cli.announceResolvedWosUuid({}, (line) => lines.push(line)), false);
  assert.equal(lines.length, 1);
});

test("detects WOS full-record redirects back to the WOS root", () => {
  assert.equal(cli.isWosRootRecordRedirect("https://www.webofscience.com/wos/", "https://www.webofscience.com"), true);
  assert.equal(cli.isWosRootRecordRedirect("https://www.webofscience.com/wos", "https://www.webofscience.com"), true);
  assert.equal(cli.isWosRootRecordRedirect("https://www.webofscience.com/wos/woscc/full-record/WOS:ABC", "https://www.webofscience.com"), false);
  assert.equal(cli.isWosRootRecordRedirect("https://other.example/wos/", "https://www.webofscience.com"), false);
});

test("browser-side wos.js preserves externally prepared WOSIDs", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "import", "wos.js"), "utf8");
  const helper = source.match(/function prepareWosRecordId\(value = ''\) \{[\s\S]*?\n\}/);
  assert.ok(helper, "prepareWosRecordId helper should be present");
  assert.match(helper[0], /return extractWosIdFromFullRecordPath\(text\) \|\| text;/);
  assert.doesNotMatch(helper[0], /toUpperCase|replace\(/);
  assert.match(source, /static def_value = '';/);
  assert.match(source, /const href = `\/wos\/woscc\/full-record\/\$\{encodeURIComponent\(normalizedWosId\)\}`/);
});

test("browser-side wos.js rejects empty WOSID navigation instead of reusing current state", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "import", "wos.js"), "utf8");
  const viewMethod = source.match(/async viewFullRecordByWosId\(wosid = ''\) \{[\s\S]*?\n    \}/);
  assert.ok(viewMethod, "viewFullRecordByWosId source should be present");
  assert.match(viewMethod[0], /#requireWosId\(wosid, 'full record page navigation'\)/);
  assert.doesNotMatch(viewMethod[0], /this\.currentWosId = wosid/);
});

test("browser-side wos.js extracts full-record WOSID path segments without query or hash", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "import", "wos.js"), "utf8");
  const extractor = source.match(/function extractWosIdFromFullRecordPath\(value = ''\) \{[\s\S]*?\n\}/);
  assert.ok(extractor, "full-record WOSID extractor should be present");
  assert.ok(extractor[0].includes("text.match(/\\/full-record\\/([^/?#\\s]+)/i)"));
  assert.match(extractor[0], /decodeURIComponent/);
  const syncMethod = source.match(/async syncCurrentWosIdFromUrl\(\) \{[\s\S]*?\n    \}/);
  assert.ok(syncMethod, "syncCurrentWosIdFromUrl source should be present");
  assert.match(syncMethod[0], /const wosid = this\.#normalizeWosId\(href\);/);
  assert.doesNotMatch(syncMethod[0], /href\.split\('\/'\)\.pop\(\)/);
});

test("browser-side wos.js matches both Keywords Plus id variants", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "import", "wos.js"), "utf8");
  const snippet = source.match(/const keywordsPlus = uniq\([\s\S]*?\n        \);/);
  assert.ok(snippet, "keywordsPlus selector should be present");
  assert.match(snippet[0], /id\*="keywordPlus" i/);
  assert.match(snippet[0], /id\*="keywordsPlus" i/);
});

test("browser-side wos.js does not let stale full-record DOM satisfy another WOSID", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "import", "wos.js"), "utf8");
  const waitMethod = source.match(/async #waitForFullRecordPageByWosId\(wosid\) \{[\s\S]*?\n    \}/);
  assert.ok(waitMethod, "full-record wait helper should be present");
  assert.match(waitMethod[0], /pageWosId && wosRecordIdsMatch\(expectedWosId, pageWosId\)/);
  assert.match(waitMethod[0], /!pageWosId && wosRecordIdsMatch\(expectedWosId, routeWosId\)/);
  assert.match(waitMethod[0], /throw new Error/);
});

test("browser-side wos.js streams TXT batch text through awaited progress", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "import", "wos.js"), "utf8");
  assert.match(source, /async #runBatchExportByUuid\(uuid,/);
  assert.match(source, /const emitProgress = async/);
  assert.match(source, /await onProgress\(payload\)/);
  assert.match(source, /await emitProgress\(\{\s*phase: 'batch'/);
  assert.match(source, /isRefQuery: options\.isRefQuery \? "true" : "false"/);
  assert.match(source, /isRefQuery = false/);
  assert.match(source, /fetchBatchFn\(uuid, current, batchEnd, fieldList, \{ sortBy, isRefQuery \}\)/);
  const txtMethod = source.match(/async fetchTxtBatches\(options = \{\}\) \{[\s\S]*?\n    \}/);
  assert.ok(txtMethod, "fetchTxtBatches should be present");
  assert.match(txtMethod[0], /return \{ resultLength: batches\.length, text \};/);
});

test("browser-side wos.js logs export failure response bodies", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "import", "wos.js"), "utf8");
  const txtFetch = source.match(/async #fetchWosdataTxtByRange\(uuid = ''[\s\S]*?\n    \}/);
  assert.ok(txtFetch, "TXT export fetch helper should be present");
  assert.match(txtFetch[0], /const errorText = await response\.text\(\)\.catch\(\(\) => ''\);/);
  assert.match(txtFetch[0], /String\(errorText\)\.slice\(0, 500\)/);
  const bibFetch = source.match(/async #fetchBibtexByRange\(uuid = ''[\s\S]*?\n    \}/);
  assert.ok(bibFetch, "BibTeX export fetch helper should be present");
  assert.match(bibFetch[0], /const errorText = await response\.text\(\)\.catch\(\(\) => ''\);/);
});

test("browser-side wos.js preserves requested sort while refreshing export page info", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "import", "wos.js"), "utf8");
  assert.match(source, /async #runBatchExportByUuid\(uuid,/);
  assert.match(source, /#fetchPageInfoByUuid\(uuid, sortBy, 1, 'export'\)/);
  const currentInfo = source.match(/async fetchCurrentPageInfo\(note = '', expectedUuid = ''\)[\s\S]*?\n    \}/);
  assert.ok(currentInfo, "current page info helper should accept expected UUID");
  assert.match(currentInfo[0], /const uuidReady = expectedUuid \? res\.uuid === expectedUuid : Boolean\(res\.uuid\)/);
});

test("releasing a WOS context blanks and closes every page before the context", async () => {
  const events = [];
  const makePage = (id) => ({
    id,
    closed: false,
    async evaluate() {
      events.push(`evaluate:${id}`);
    },
    async goto(url) {
      events.push(`goto:${id}:${url}`);
    },
    isClosed() {
      return this.closed;
    },
    async close() {
      this.closed = true;
      events.push(`close:${id}`);
    },
  });
  const pages = [makePage(1), makePage(2)];
  let contextClosed = 0;
  const context = {
    pages() {
      return pages;
    },
    async close() {
      contextClosed += 1;
      events.push("context:close");
    },
  };

  await cli.releaseWosContext(context);

  assert.equal(contextClosed, 1);
  assert.equal(events.filter((entry) => entry === "context:close").length, 1);
  assert.ok(events.includes("evaluate:1"));
  assert.ok(events.includes("evaluate:2"));
  assert.ok(events.includes("goto:1:about:blank"));
  assert.ok(events.includes("goto:2:about:blank"));
  assert.ok(events.includes("close:1"));
  assert.ok(events.includes("close:2"));
});

test("counts BibTeX entries without treating metadata directives as records", () => {
  const text = [
    "@comment{generated by WOS}",
    "@string{j = {Demo Journal}}",
    "@article{one,",
    "  title = {One}",
    "}",
    "@inproceedings{two,",
    "  title = {Two}",
    "}",
  ].join("\n");

  assert.equal(cli.parseBibEntryCount(text), 2);
  assert.equal(cli.parseBibEntryCount(""), 0);
});

test("parses WOS summary counts for bounded BibTeX progress", () => {
  assert.equal(cli.parseWosCount("1,234"), 1234);
  assert.equal(cli.parseWosCount("8 results"), 8);
  assert.equal(cli.parseWosCount(""), 0);
});

test("normalizes wos.js export batches for CLI file writing", () => {
  const result = normalizeBatchResult({
    status: "completed",
    uuid: "query",
    totalRecords: 2,
    totalBatches: 1,
    completedBatches: 1,
    batches: [{ markFrom: 1, markTo: 2, text: "UT WOS:A\nUT WOS:B\n" }],
  });

  assert.equal(result.uuid, "query");
  assert.equal(result.totalRecords, 2);
  assert.deepEqual(result.batches, [{ uuid: "query", markFrom: 1, markTo: 2, text: "UT WOS:A\nUT WOS:B\n" }]);
});

test("BibTeX export path uses injected wos.js export API while reading summary count metadata", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/async function exportBibFromWos[\s\S]*?\n}\n\nfunction combineBibFiles/);
  assert.ok(match, "exportBibFromWos source should be present");

  assert.match(match[0], /prepareWosRequestContext/);
  assert.match(match[0], /expectedCount/);
  assert.match(match[0], /totalBatches/);
  assert.match(match[0], /reportDownloadPlan/);
  assert.match(match[0], /batchSize = DEFAULT_BATCH_SIZE/);
  assert.match(match[0], /exportRefQuery = initialExportRefQuery\(args, context\)/);
  assert.match(match[0], /exportBibBatchesViaWosJs/);
  assert.match(match[0], /isRefQuery: exportRefQuery/);
  assert.match(match[0], /exportIsRefQuery: exportRefQuery/);
  assert.doesNotMatch(source, /api\/wosnx\/indic\/export\/saveToFile/);
  assert.doesNotMatch(source, /action:\s*["']saveTo(?:Bibtex|FieldTagged)["']/);
});

test("uses project-scoped default task IDs and preserves timestamp IDs in legacy mode", () => {
  const taskId = cli.makeTaskId(new Date(2026, 5, 9, 20, 30, 40));
  assert.equal(taskId, "TID20260609203040");
  assert.equal(cli.parseArgs(["node", "cli", "run", "--uuid", "abc"]).taskId, "iiaide-wos-cli");
  assert.equal(cli.parseArgs(["node", "cli", "import", "--csv", "wosids.csv"]).taskId, "iiaide-wos-cli");
  assert.match(
    cli.parseArgs(["node", "cli", "run", "--uuid", "abc", "--tasks-root", temporaryDirectory()]).taskId,
    /^TID\d{14}$/
  );
});

test("initializes and reports a cwd-scoped workspace", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const args = cli.parseArgs(["node", "cli", "init", "--tasks-root", tasksRoot]);

  const initialized = cli.initializeWorkspace(args);
  const status = cli.workspaceStatus(args);

  assert.equal(initialized.initialized, true);
  assert.equal(status.initialized, true);
  assert.equal(status.tasksRoot, tasksRoot);
  assert.equal(status.taskCount, 0);
  assert.equal(status.latestTask, "");
});

test("interactive workspace ensures a current task exists", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", tasksRoot]);

  const task = cli.ensureCurrentTask(args);
  const status = cli.workspaceStatus(args);
  const taskDir = path.join(tasksRoot, task.taskId);

  assert.match(task.taskId, /^TID\d{14}$/);
  assert.equal(status.taskCount, 1);
  assert.equal(status.currentTask, task.taskId);
  assert.equal(status.latestTask, task.taskId);
  assert.equal(fs.readFileSync(path.join(tasksRoot, "latest"), "utf8").trim(), task.taskId);
  assert.equal(fs.existsSync(path.join(taskDir, "project.json")), true);
});

test("interactive workspace reuses discovered task directories before creating a task", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const existingDir = path.join(tasksRoot, "existing-task");
  fs.mkdirSync(existingDir, { recursive: true });
  writeProjectMarker(existingDir);
  writeJson(path.join(existingDir, "state.json"), {
    status: "query-completed",
    uuid: "6649ab6a-71b4-d6ae-4c3d-f57c3ea762b2-a541d4a9e6",
    expectedCount: 12,
  });
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", tasksRoot]);

  const task = cli.ensureCurrentTask(args);
  const status = cli.workspaceStatus(args);

  assert.equal(task.taskId, "existing-task");
  assert.equal(status.taskCount, 1);
  assert.equal(status.currentTask, "existing-task");
  assert.equal(fs.readdirSync(tasksRoot).filter((name) => /^TID/.test(name)).length, 0);
  assert.equal(readJson(path.join(tasksRoot, "index.json")).tasks[0].expectedCount, 12);
});

test("current task can switch to an existing or new task id", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", tasksRoot]);

  const first = cli.ensureCurrentTask(args);
  const second = cli.setCurrentTaskId(args, "manual-task");
  const back = cli.setCurrentTaskId(args, first.taskId);

  assert.equal(second.taskId, "manual-task");
  assert.equal(cli.workspaceStatus(args).currentTask, first.taskId);
  assert.equal(back.taskId, first.taskId);
  assert.deepEqual(cli.readTaskIndex(tasksRoot).tasks.map((task) => task.taskId).sort(), [first.taskId, "manual-task"].sort());
});

test("initializes a workspace when the tasks directory already exists", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  fs.mkdirSync(tasksRoot);
  const args = cli.parseArgs(["node", "cli", "init", "--tasks-root", tasksRoot]);

  assert.equal(cli.initializeWorkspace(args).initialized, true);
  assert.equal(cli.initializeWorkspace(args).initialized, false);
});

test("failed imports do not initialize an empty task workspace", () => {
  const root = temporaryDirectory();
  const csvPath = path.join(root, "empty.csv");
  const tasksRoot = path.join(root, "tasks");
  fs.writeFileSync(csvPath, "wosid\nnot-a-wos-id\n");
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "..", "bin", "iiaide-wos.js"),
    "import", "--csv", csvPath, "--task", "invalid", "--tasks-root", tasksRoot,
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(tasksRoot), false);
});

test("no-argument non-interactive invocation prints help without creating a workspace", () => {
  const root = temporaryDirectory();
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "iiaide-wos.js")], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:\s+iiaide-wos <command> \[options\]/);
  assert.match(result.stdout, /Command groups:/);
  assert.match(result.stdout, /iiaide-wos latest \[--tasks-root <dir>\]/);
  assert.equal(fs.existsSync(path.join(root, "tasks")), false);
});

test("SID preparation prompts when missing and reuses saved config", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "sid", "--tasks-root", root]);
  const entered = await cli.ensureSid(args, "SID", async () => "prompted-sid", () => true);
  assert.equal(entered, "prompted-sid");
  assert.equal(args.sidSource, "prompt");

  fs.rmSync(cli.globalConfigPath(), { force: true });
  writeJson(path.join(root, "config.json"), { sid: "saved-sid" });
  const savedArgs = cli.parseArgs(["node", "cli", "sid", "--tasks-root", root]);
  const saved = await cli.ensureSid(
    savedArgs,
    "SID",
    async () => assert.fail("saved SID should not prompt"),
    () => true
  );
  assert.equal(saved, "saved-sid");
  assert.equal(savedArgs.sidSource, "config");
});

test("SID preparation reuses saved WOS domain config", async () => {
  const root = temporaryDirectory();
  writeJson(path.join(root, "config.json"), { sid: "saved-sid", wosDomain: "access.example.edu" });
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root]);
  const sid = await cli.ensureSid(args, "SID", async () => assert.fail("saved SID should not prompt"), () => true);

  assert.equal(sid, "saved-sid");
  assert.equal(args.wosDomain, "access.example.edu");
  assert.equal(args.baseUrl, "https://access.example.edu");
});

test("interactive SID recovery can take a manually entered SID instead of forcing browser login", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "run", "--task", "demo", "--tasks-root", root]);
  const sid = await cli.acquireFreshSid(args, () => {}, {
    canPrompt: () => true,
    chooseSid: async () => "manual-sid",
  });

  assert.equal(sid, "manual-sid");
  assert.equal(args.sid, "manual-sid");
  assert.equal(args.sidSource, "prompt");
});

test("interactive SID recovery can wait for the saved SID pool", async () => {
  const originalWrite = process.stdout.write;
  let output = "";
  let waitCalls = 0;
  process.stdout.write = (chunk, ...args) => {
    output += String(chunk);
    const callback = args.find((item) => typeof item === "function");
    if (callback) callback();
    return true;
  };

  try {
    const sid = await askSidFromBrowserOrManual(
      () => ({ question: async () => "3" }),
      async () => assert.fail("browser login should not run"),
      async () => assert.fail("manual SID prompt should not run"),
      async () => {
        waitCalls += 1;
        return "pooled-sid";
      }
    );

    assert.equal(sid, "pooled-sid");
    assert.equal(waitCalls, 1);
    assert.match(output, /Wait for SID pool/);
    assert.match(output, /loaded from SID pool/);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("interactive SID recovery accepts a pasted SID at the method prompt", async () => {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk, ...args) => {
    output += String(chunk);
    const callback = args.find((item) => typeof item === "function");
    if (callback) callback();
    return true;
  };

  try {
    const sid = "TEST_SID_VALUE_1234567890";
    assert.equal(isLikelySidInput(sid), true);
    assert.equal(isLikelySidInput("manual"), false);
    const received = await askSidFromBrowserOrManual(
      () => ({ question: async () => sid }),
      async () => assert.fail("browser login should not run"),
      async () => assert.fail("manual SID prompt should not run"),
      async () => assert.fail("SID pool wait should not run")
    );

    assert.equal(received, sid);
    assert.match(output, /received manually/);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("SID recovery still falls back to browser login when no interactive terminal is available", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "run", "--task", "demo", "--tasks-root", root]);
  const sid = await cli.acquireFreshSid(args, () => {}, {
    canPrompt: () => false,
    readBrowserSid: async () => {
      args.sid = "browser-sid";
      args.sidSource = "browser";
      return args.sid;
    },
  });

  assert.equal(sid, "browser-sid");
  assert.equal(args.sid, "browser-sid");
  assert.equal(args.sidSource, "browser");
});

test("SID pool parses, deduplicates, and migrates legacy saved SID config", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root]);
  writeJson(path.join(root, "config.json"), {
    sid: "legacy",
    sids: ["one", "legacy"],
    sidCursor: 1,
    playwrightVisible: true,
  });

  assert.deepEqual(cli.parseSidValues("two three\nfour, five"), ["two", "three", "four", "five"]);
  assert.deepEqual(cli.sidPoolFromConfig(readJson(path.join(root, "config.json"))).sids, ["one", "legacy"]);

  const saved = cli.addSidsToConfig(args, ["legacy two\nthree", "three,four"]);
  const config = readJson(cli.globalConfigPath());
  const workspaceConfig = readJson(path.join(root, "config.json"));
  assert.equal(saved.added, 3);
  assert.equal(saved.sidPoolCount, 5);
  assert.equal(config.sid, undefined);
  assert.deepEqual(config.sids, ["one", "legacy", "two", "three", "four"]);
  assert.equal(config.sidCursor, 1);
  assert.equal(workspaceConfig.sid, undefined);
  assert.equal(workspaceConfig.sids, undefined);
  assert.equal(workspaceConfig.playwrightVisible, true);

  const status = cli.workspaceStatus(args);
  assert.equal(status.sid, "l***y");
  assert.equal(status.sidPoolCount, 5);
  assert.equal(status.sidPoolIndex, 1);
  assert.equal(status.playwrightVisible, true);
});

test("settings command can clear the saved SID pool", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "settings", "--clear-sids", "--tasks-root", root]);
  cli.addSidsToConfig(args, ["one two"], { activate: true });

  const cleared = cli.clearSavedSidConfig(args);
  const config = readJson(cli.globalConfigPath(), {});

  assert.equal(args.clearSids, true);
  assert.equal(cleared, true);
  assert.deepEqual(config.sids, undefined);
  assert.equal(args.sid, "");
  assert.equal(args.sidPoolCount, 0);
});

test("settings command can clear saved dead SID history", () => {
  const root = temporaryDirectory();
  writeJson(cli.globalConfigPath(), {
    sids: ["live"],
    sidCursor: 0,
    deadSids: [{ sid: "dead", reason: "expired", removedAt: "2026-06-14T00:00:00.000Z" }],
  });
  const args = cli.parseArgs(["node", "cli", "settings", "--clear-dead-sids", "--tasks-root", root]);

  const cleared = cli.clearDeadSidHistory(args);
  const config = readJson(cli.globalConfigPath(), {});

  assert.equal(args.clearDeadSids, true);
  assert.equal(cleared, true);
  assert.deepEqual(config.sids, ["live"]);
  assert.equal(config.deadSids, undefined);
});

test("advanceSavedSid rotates to the next saved SID", () => {
  const root = temporaryDirectory();
  writeJson(cli.globalConfigPath(), { sids: ["one", "two", "three"], sidCursor: 0 });
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root]);
  args.sid = "one";
  args.sidSource = "config";
  args.sidPoolIndex = 0;
  args.sidPoolCount = 3;

  const rotated = cli.advanceSavedSid(args);
  const config = readJson(cli.globalConfigPath(), {});

  assert.equal(rotated.activeSid, "two");
  assert.equal(args.sid, "two");
  assert.equal(args.sidPoolIndex, 1);
  assert.equal(config.sidCursor, 1);
});

test("SID pool is shared across task roots through global config", () => {
  const firstRoot = temporaryDirectory();
  const globalConfig = cli.globalConfigPath();
  const firstArgs = cli.parseArgs(["node", "cli", "settings", "--tasks-root", firstRoot]);
  cli.addSidsToConfig(firstArgs, ["one two"], { activate: true });

  const secondRoot = temporaryDirectory();
  process.env.IIAIDE_WOS_CONFIG = globalConfig;
  const secondArgs = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", secondRoot]);
  const status = cli.workspaceStatus(secondArgs);

  assert.equal(status.sid, "o***e");
  assert.equal(status.sidPoolCount, 2);
  assert.equal(status.sidConfig, globalConfig);
  assert.equal(readJson(path.join(secondRoot, "config.json"), {}).sids, undefined);
});

test("quick SID validation discards invalid config SIDs and tries the next pool value", async () => {
  const root = temporaryDirectory();
  writeJson(cli.globalConfigPath(), { sids: ["bad", "good"], sidCursor: 0 });
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root]);
  const seen = [];

  const result = await cli.quickValidateSid(args, {
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.includes("SID=bad")) {
        return {
          ok: false,
          status: 403,
          url: "https://www.webofscience.com/wos/",
          async text() {
            return "session expired";
          },
        };
      }
      return {
        ok: true,
        status: 200,
        url: "https://www.webofscience.com/wos/",
        async text() {
          return "window.sessionData={BasicProperties:{SID:'good'}}";
        },
      };
    },
  });

  assert.equal(result.status, "valid");
  assert.equal(result.sid, "good");
  assert.equal(args.sid, "good");
  assert.deepEqual(readJson(cli.globalConfigPath()).sids, ["good"]);
  assert.equal(readJson(cli.globalConfigPath()).sidCursor, 0);
  assert.equal(readJson(cli.globalConfigPath()).deadSids[0].sid, "bad");
  assert.equal(seen.length, 2);
});

test("forced SID discard removes the current SID from the saved pool for recovery restarts", () => {
  const root = temporaryDirectory();
  writeJson(cli.globalConfigPath(), { sids: ["stale", "next"], sidCursor: 0 });
  const args = cli.parseArgs(["node", "cli", "parse", "--task", "demo", "--tasks-root", root]);
  args.sid = "stale";
  args.sidSource = "browser";

  assert.equal(cli.discardActiveConfigSid(args, "query limit"), false);
  assert.deepEqual(readJson(cli.globalConfigPath()).sids, ["stale", "next"]);

  const discarded = cli.discardActiveConfigSid(args, "query limit", { force: true });
  assert.equal(discarded.removedSid, "stale");
  assert.equal(discarded.sidPoolCount, 1);
  assert.deepEqual(readJson(cli.globalConfigPath()).sids, ["next"]);
  assert.deepEqual(args.invalidatedSids, ["stale"]);
  assert.equal(args.sid, "");
  assert.equal(args.sidSource, "");
});

test("waitForSavedSidPool keeps polling until a new saved SID is added", async () => {
  const root = temporaryDirectory();
  writeJson(cli.globalConfigPath(), { sids: [], sidCursor: 0 });
  const args = cli.parseArgs(["node", "cli", "parse", "--task", "demo", "--tasks-root", root]);
  const reports = [];

  const result = await cli.waitForSavedSidPool(args, {
    intervalMs: 5,
    report(message) {
      reports.push(message);
    },
    onPoll({ attempts }) {
      if (attempts === 1) {
        const addArgs = cli.parseArgs(["node", "cli", "settings", "--tasks-root", root]);
        cli.addSidsToConfig(addArgs, ["fresh"], { activate: true });
      }
    },
  });

  assert.equal(result.sid, "fresh");
  assert.equal(result.sidSource, "config");
  assert.equal(result.sidPoolCount, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.waitedMs, 5);
  assert.equal(args.sid, "fresh");
  assert.equal(args.sidSource, "config");
  assert.deepEqual(readJson(cli.globalConfigPath()).sids, ["fresh"]);
  assert.match(reports[0], /Saved SID pool is empty/);
});

test("saved dead SIDs are rejected after a CLI restart", async () => {
  const root = temporaryDirectory();
  writeJson(cli.globalConfigPath(), {
    sids: [],
    deadSids: [{ sid: "stale", reason: "query limit", removedAt: "2026-06-11T00:00:00.000Z" }],
  });
  const args = cli.parseArgs(["node", "cli", "parse", "--task", "demo", "--tasks-root", root]);

  const result = await cli.quickValidateSid(args, {
    fetchImpl: async () => assert.fail("missing SID should not probe WOS"),
  });

  assert.equal(result.status, "missing");
  assert.deepEqual(args.invalidatedSids, ["stale"]);
  assert.equal(args.sid, "");
});

test("unknown SID probe does not discard saved SID pool values", async () => {
  const root = temporaryDirectory();
  writeJson(cli.globalConfigPath(), { sids: ["maybe", "later"], sidCursor: 0 });
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root]);

  const result = await cli.quickValidateSid(args, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: "https://www.webofscience.com/wos/",
      async text() {
        return "<html>Sign In</html>";
      },
    }),
  });

  assert.equal(result.status, "unknown");
  assert.deepEqual(readJson(cli.globalConfigPath()).sids, ["maybe", "later"]);
});

test("SID preparation fails clearly outside an interactive terminal", async () => {
  const args = cli.parseArgs(["node", "cli", "sid", "--tasks-root", temporaryDirectory()]);
  await assert.rejects(
    () => cli.ensureSid(args, "SID", async () => "unused", () => false),
    /Pass --sid, set WOS_SID, or run: iiaide-wos sid/
  );
});

test("quick SID validation classifies lightweight WOS responses", async () => {
  const root = temporaryDirectory();
  writeJson(cli.globalConfigPath(), { sid: "saved-sid" });
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root]);
  const valid = await cli.quickValidateSid(args, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: "https://www.webofscience.com/wos/",
      async text() {
        return "window.sessionData={BasicProperties:{SID:'saved-sid'}}";
      },
    }),
  });

  assert.equal(valid.status, "valid");
  assert.equal(valid.sidSource, "config");
  assert.equal(valid.sidMasked, "save...-sid");
  assert.equal(valid.origin, "https://www.webofscience.com");
  assert.equal(valid.ok, true);

  const invalidArgs = cli.parseArgs(["node", "cli", "workspace", "--sid", "bad", "--tasks-root", root]);
  const invalid = await cli.quickValidateSid(invalidArgs, {
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      url: "https://www.webofscience.com/wos/",
      async text() {
        return "Sign In";
      },
    }),
  });

  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.ok, false);
});

test("quick SID validation treats undefined WOS session shell as invalid", async () => {
  const args = cli.parseArgs(["node", "cli", "workspace", "--sid", "expired", "--tasks-root", temporaryDirectory()]);
  const result = await cli.quickValidateSid(args, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: "https://www.webofscience.com/wos/",
      async text() {
        return "<script>window.sessionData = undefined;</script>";
      },
    }),
  });

  assert.equal(result.status, "invalid");
  assert.equal(result.ok, false);
});

test("quick SID validation reports missing or unknown without prompting", async () => {
  const missingArgs = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", temporaryDirectory()]);
  assert.equal((await cli.quickValidateSid(missingArgs)).status, "missing");

  const unknownArgs = cli.parseArgs(["node", "cli", "workspace", "--sid", "maybe", "--tasks-root", temporaryDirectory()]);
  const unknown = await cli.quickValidateSid(unknownArgs, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: "https://www.webofscience.com/wos/",
      async text() {
        return "<html>WOS</html>";
      },
    }),
  });

  assert.equal(unknown.status, "unknown");
});

test("quick SID validation treats login pages as unknown without HTTP rejection", async () => {
  const args = cli.parseArgs(["node", "cli", "workspace", "--sid", "maybe", "--tasks-root", temporaryDirectory()]);
  const result = await cli.quickValidateSid(args, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: "https://www.webofscience.com/wos/",
      async text() {
        return "<html>Sign In</html>";
      },
    }),
  });

  assert.equal(result.status, "unknown");
  assert.match(result.message, /login page/);
});

test("checkSid returns immediately when the lightweight SID probe is valid", async () => {
  const args = cli.parseArgs(["node", "cli", "check", "--tasks-root", temporaryDirectory()]);
  const messages = [];
  const result = await cli.checkSid(args, {
    report(message) {
      messages.push(message);
    },
    async quickValidateSid() {
      return {
        status: "valid",
        sidSource: "config",
        href: "https://www.webofscience.com/wos/",
        message: "SID accepted by WOS",
      };
    },
    async validateAndSaveSid() {
      assert.fail("valid SID should not trigger browser validation");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "valid");
  assert.equal(result.checkedWith, "http-probe");
  assert.equal(result.sidSource, "config");
  assert.equal(messages.length, 0);
});

test("checkSid reports which SID is being validated", async () => {
  const root = temporaryDirectory();
  writeJson(cli.globalConfigPath(), { sids: ["USW2EC0B24fGZzu0fzuFeJTlS61zb"], sidCursor: 0 });
  const args = cli.parseArgs(["node", "cli", "check", "--tasks-root", root]);
  const messages = [];

  await cli.checkSid(args, {
    report(message) {
      messages.push(message);
    },
    async quickValidateSid() {
      return {
        status: "valid",
        sidSource: "config",
        href: "https://www.webofscience.com/wos/",
        message: "SID accepted by WOS",
      };
    },
    async validateAndSaveSid() {
      assert.fail("valid SID should not trigger browser validation");
    },
  });

  assert.match(messages[0], /Validating WOS authentication/);
  assert.match(messages[0], /USW2\.\.\.61zb/);
});

test("check command output does not expose SID details", () => {
  const valid = cli.formatCheckSidResult({
    ok: true,
    status: "valid",
    href: "https://www.webofscience.com/wos/?Init=Yes&SrcApp=CR&SID=USW2EC0DEBlsMfZ3oPCDdkYzLMs2x",
    sid: "[saved]",
    config: "/tmp/tasks/config.json",
  });
  assert.equal(valid, "WOS SID check passed");
  assert.doesNotMatch(valid, /SID=|USW2|config|href|\{/);

  assert.equal(cli.formatCheckSidResult({ ok: true, status: "refreshed" }), "WOS SID refreshed and saved");
  assert.equal(cli.formatCheckSidResult({ ok: false, status: "invalid" }), "WOS SID check failed: invalid");
});

test("checkSid refreshes an invalid SID through the browser validation flow", async () => {
  const args = cli.parseArgs(["node", "cli", "check", "--tasks-root", temporaryDirectory()]);
  const messages = [];
  const result = await cli.checkSid(args, {
    async quickValidateSid() {
      return {
        status: "invalid",
        message: "SID was rejected by WOS",
      };
    },
    async validateAndSaveSid() {
      return {
        ok: true,
        sidSource: "browser",
        config: "/tmp/config.json",
        href: "https://www.webofscience.com/wos/",
        sid: "[saved]",
      };
    },
    report(message) {
      messages.push(message);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "refreshed");
  assert.equal(result.checkedWith, "browser-validation");
  assert.equal(result.initialStatus, "invalid");
  assert.match(messages.join("\n"), /Choose manual SID input, wait for SID pool, or browser login/);
});

test("masks SID values for dashboard display", () => {
  assert.equal(cli.maskSid("saved-sid"), "save...-sid");
  assert.equal(cli.maskSid("abc"), "a***c");
  assert.equal(cli.maskSid(""), "");
});

test("invalid SID can be replaced and immediately revalidated", async () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "sid", "--sid", "expired", "--tasks-root", root]);
  writeJson(path.join(root, "config.json"), { playwrightVisible: true });
  const page = {
    async goto() {},
    async waitForLoadState() {},
    async waitForFunction() {},
    async evaluate() {
      return { href: "https://www.webofscience.com/wos/", sid: args.sid === "fresh" ? "fresh" : "" };
    },
  };

  const messages = [];
  const status = await cli.validateSidWithRetry(
    page,
    args,
    async () => "fresh",
    () => true,
    (message) => messages.push(message)
  );
  assert.equal(status.sid, "fresh");
  assert.equal(args.sid, "fresh");
  assert.equal(args.sidSource, "prompt");
  assert.deepEqual(readJson(cli.globalConfigPath()).sids, ["fresh"]);
  assert.equal(readJson(cli.globalConfigPath()).sidCursor, 0);
  assert.equal(readJson(path.join(root, "config.json")).playwrightVisible, true);
  assert.match(messages[0], /invalid or expired/);
});

test("parses and deduplicates WOS IDs from field-tagged text", () => {
  const rows = cli.parseExportText("UT WOS:ABC\nUT: WOS:DEF\nUT ALT:12-34\nDOI 10.1/example\nCR WOS:REF\nUT WOS:ABC\n", 1, 4);
  assert.deepEqual(rows.map((row) => row.wosid), ["WOS:ABC", "WOS:DEF", "ALT:1234"]);
});

test("failed TXT summaries do not make partial raw look complete", () => {
  assert.equal(cli.isFailedTxtRunSummary({
    ok: false,
    method: "wos-js-export-fetchTxtBatches",
    expectedCount: 1400,
    rangeEnd: 1400,
  }), true);
  assert.equal(cli.isFailedTxtRunSummary({
    ok: true,
    method: "wos-js-export-fetchTxtBatches",
  }), false);
  assert.equal(cli.isFailedTxtRunSummary({
    ok: false,
    method: "imported-wosid-csv",
  }), false);
});

test("normalizes accession IDs without forcing the WOS prefix", () => {
  assert.equal(cli.normalizeWosId("ALT:12-34"), "ALT:1234");
  assert.equal(cli.normalizeWosId("https://www.webofscience.com/wos/woscc/full-record/ALT:12-34"), "ALT:1234");
  assert.equal(cli.normalizeWosId("000123456700001"), "");
});

test("chunks parse work for browser restart boundaries", () => {
  assert.deepEqual(cli.chunkItemsByCount([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(cli.chunkItemsByCount([1, 2, 3], 0), [[1, 2, 3]]);
});

test("reads WOS IDs from a named CSV column and deduplicates them", () => {
  const root = temporaryDirectory();
  const csvPath = path.join(root, "input.csv");
  fs.writeFileSync(csvPath, [
    "title,UT,notes",
    '"First, title",WOS:ABC,"quoted, note"',
    "Second,ALT:12-34,",
    "Duplicate,wos:abc,",
  ].join("\n"));

  assert.deepEqual(cli.readWosIdsCsv(csvPath), ["WOS:ABC", "ALT:1234"]);
});

test("reads UUIDs from a uuid.csv file by regex extraction", () => {
  const root = temporaryDirectory();
  const csvPath = path.join(root, "uuid.csv");
  fs.writeFileSync(csvPath, [
    "label,notes",
    "first,01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc",
    "second,https://www.webofscience.com/wos/woscc/summary/11111111-2222-3333-4444-555555555555-6666666666/relevance/1",
  ].join("\n"));

  assert.deepEqual(cli.readUuidCsv(csvPath), [
    "01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc",
    "11111111-2222-3333-4444-555555555555-6666666666",
  ]);
});

test("finds uuid.csv files recursively", () => {
  const root = temporaryDirectory();
  fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
  fs.writeFileSync(path.join(root, "uuid.csv"), "uuid\n");
  fs.writeFileSync(path.join(root, "a", "b", "UUID.csv"), "uuid\n");
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "uuid.csv"), "uuid\n");

  assert.deepEqual(cli.findUuidCsvFiles(root), [
    path.join(root, "a", "b", "UUID.csv"),
    path.join(root, "uuid.csv"),
  ]);
});

test("imports an external WOS ID CSV as a complete task", () => {
  const root = temporaryDirectory();
  const csvPath = path.join(root, "input.csv");
  fs.writeFileSync(csvPath, "wosid\nWOS:ABC\nWOS:DEF\nWOS:ABC\n");
  const args = cli.parseArgs([
    "node", "cli", "import", "--csv", csvPath, "--task", "csv-demo", "--tasks-root", path.join(root, "tasks"),
  ]);

  const summary = cli.importWosIds(args);
  const validation = cli.validateTask(cli.parseArgs([
    "node", "cli", "validate", "--task", "csv-demo", "--tasks-root", path.join(root, "tasks"),
  ]));

  assert.equal(summary.method, "imported-wosid-csv");
  assert.equal(summary.uniqueCount, 2);
  assert.equal(validation.ok, true);
  assert.deepEqual(cli.readWosIdsCsv(summary.files.wosidsCsv), ["WOS:ABC", "WOS:DEF"]);
});

test("import --json prints the LLM artifact envelope", () => {
  const root = temporaryDirectory();
  const csvPath = path.join(root, "input.csv");
  fs.writeFileSync(csvPath, "wosid\nWOS:ABC\n");
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "..", "bin", "iiaide-wos.js"),
    "import", "--csv", csvPath, "--task", "json-import", "--tasks-root", path.join(root, "tasks"), "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.code, "OK");
  assert.equal(parsed.command, "import");
  assert.equal(parsed.taskId, "json-import");
  assert.match(parsed.artifact, /json-import_wosid\.csv$/);
  assert.equal(parsed.count, 1);
});

test("list --json prints task data in the LLM envelope", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const csvPath = path.join(root, "input.csv");
  fs.writeFileSync(csvPath, "wosid\nWOS:ABC\n");
  spawnSync(process.execPath, [
    path.join(__dirname, "..", "bin", "iiaide-wos.js"),
    "import", "--csv", csvPath, "--task", "listed-task", "--tasks-root", tasksRoot,
  ], { encoding: "utf8" });

  const result = spawnSync(process.execPath, [
    path.join(__dirname, "..", "bin", "iiaide-wos.js"),
    "list", "--tasks-root", tasksRoot, "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, "list");
  assert.equal(parsed.count, 1);
  assert.equal(parsed.data.tasks[0].taskId, "listed-task");
});

test("reports corrupt JSON instead of silently replacing it", () => {
  const root = temporaryDirectory();
  const filePath = path.join(root, "broken.json");
  fs.writeFileSync(filePath, "{", "utf8");
  assert.throws(() => readJson(filePath, {}), /Invalid JSON file/);
  assert.deepEqual(readJson(path.join(root, "missing.json"), { ok: true }), { ok: true });
});

test("writes JSON atomically without leftover temporary files", () => {
  const root = temporaryDirectory();
  const filePath = path.join(root, "state.json");
  writeJson(filePath, { value: 1 });
  writeJson(filePath, { value: 2 });
  assert.deepEqual(readJson(filePath), { value: 2 });
  assert.deepEqual(fs.readdirSync(root), ["state.json"]);
});

test("filters raw batches by UUID and rejects overlaps", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  const firstRawDir = cli.rawBatchDir(paths, "first");
  const otherRawDir = cli.rawBatchDir(paths, "other");
  fs.mkdirSync(firstRawDir, { recursive: true });
  fs.mkdirSync(otherRawDir, { recursive: true });
  fs.writeFileSync(path.join(firstRawDir, "first_1_2.txt"), "UT WOS:A\nUT WOS:B\n");
  fs.writeFileSync(path.join(otherRawDir, "other_1_1.txt"), "UT WOS:OTHER\n");
  assert.deepEqual(cli.rawBatchFiles(paths, "first"), ["first_1_2.txt"]);
  assert.deepEqual(cli.parseExistingRawBatches(paths, "first").map((row) => row.wosid), ["WOS:A", "WOS:B"]);

  fs.writeFileSync(path.join(firstRawDir, "first_2_3.txt"), "UT WOS:C\n");
  assert.throws(() => cli.parseExistingRawBatches(paths, "first"), /Non-contiguous raw batches/);
});

test("raw batch coverage supports resume from an explicit WOS record range", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  const rawDir = cli.rawBatchDir(paths, "query");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, "query_400_600.txt"), "UT WOS:400\nUT WOS:401\nUT WOS:600\n");

  const coverage = cli.rawBatchCoverageFromStart(paths, "query", 400, 800);

  assert.deepEqual(coverage.files, ["query_400_600.txt"]);
  assert.equal(coverage.lastEnd, 600);
  assert.deepEqual(
    cli.parseExistingRawBatches(paths, "query", {
      files: coverage.files,
      startIndex: 400,
      endIndex: coverage.lastEnd,
    }).map((row) => row.wosid),
    ["WOS:400", "WOS:401", "WOS:600"]
  );
  assert.equal(coverage.lastEnd + 1, 601);
  fs.writeFileSync(path.join(rawDir, "query_800_900.txt"), "UT WOS:800\n");
  assert.throws(
    () => cli.rawBatchCoverageFromStart(paths, "query", 400, 1000),
    /Non-contiguous raw batches/
  );
});

test("raw batch plan identifies arbitrary missing TXT ranges", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  const rawDir = cli.rawBatchDir(paths, "query");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, "query_1_200.txt"), "UT WOS:1\n");
  fs.writeFileSync(path.join(rawDir, "query_401_600.txt"), "UT WOS:401\n");

  const plan = cli.rawBatchPlanForRange(paths, "query", 1, 800, 200);

  assert.equal(plan.plannedBatchCount, 4);
  assert.equal(plan.complete, false);
  assert.equal(plan.coveredCount, 400);
  assert.deepEqual(plan.presentFiles, ["query_1_200.txt", "query_401_600.txt"]);
  assert.deepEqual(plan.missingBatches, [
    { markFrom: 201, markTo: 400 },
    { markFrom: 601, markTo: 800 },
  ]);
});

test("plans WOS large UUID exports with author sort windows", () => {
  assert.deepEqual(
    cli.planWosExportWindows(99999, 500, { sortBy: "relevance" }).map((window) => ({
      sortBy: window.sortBy,
      startIndex: window.startIndex,
      endIndex: window.endIndex,
      batchCount: window.batchCount,
    })),
    [{ sortBy: "relevance", startIndex: 1, endIndex: 99999, batchCount: 200 }]
  );
  assert.equal(cli.planWosExportWindows(100000, 500).length, 1);

  const justOver = cli.planWosExportWindows(100001, 500);
  assert.deepEqual(justOver.map((window) => [window.sortBy, window.endIndex, window.batchCount]), [
    ["author-ascending", 100000, 200],
    ["author-descending", 1000, 2],
  ]);

  const windows = cli.planWosExportWindows(175000, 500);
  assert.deepEqual(windows.map((window) => [window.sortBy, window.endIndex, window.batchCount]), [
    ["author-ascending", 100000, 200],
    ["author-descending", 75500, 151],
  ]);
  assert.equal(cli.usesLargeExportWindows(windows), true);

  const capped = cli.planWosExportWindows(200001, 500);
  assert.deepEqual(capped.map((window) => [window.sortBy, window.endIndex, window.batchCount]), [
    ["author-ascending", 100000, 200],
    ["author-descending", 100000, 200],
  ]);
  assert.equal(capped[0].incompleteBeyondWosLimit, true);
});

test("raw TXT batch planning supports per-sort large export directories", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  const uuid = "query";
  const ascDir = cli.rawBatchDir(paths, uuid, { sortBy: "author-ascending" });
  const descDir = cli.rawBatchDir(paths, uuid, { sortBy: "author-descending" });
  fs.mkdirSync(ascDir, { recursive: true });
  fs.mkdirSync(descDir, { recursive: true });
  fs.writeFileSync(path.join(ascDir, "query_1_500.txt"), "UT WOS:A\n");
  fs.writeFileSync(path.join(descDir, "query_1_500.txt"), "UT WOS:Z\n");

  const ascPlan = cli.rawBatchPlanForRange(paths, uuid, 1, 1000, 500, { sortBy: "author-ascending" });
  const descPlan = cli.rawBatchPlanForRange(paths, uuid, 1, 500, 500, { sortBy: "author-descending" });

  assert.deepEqual(ascPlan.presentFiles, ["query_1_500.txt"]);
  assert.deepEqual(ascPlan.missingBatches, [{ markFrom: 501, markTo: 1000 }]);
  assert.equal(descPlan.complete, true);
  assert.deepEqual(cli.rawBatchFiles(paths, uuid), [
    path.join("author-ascending", "query_1_500.txt"),
    path.join("author-descending", "query_1_500.txt"),
  ]);
  assert.deepEqual(
    cli.rawBatchPlanForRange(paths, uuid, 1, 500, 500).presentFiles,
    [],
    "flat resume planning should not treat sort-window batches as default-order batches"
  );
});

test("large TXT completion markers preserve sort windows and write per-directory markers", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  const uuid = "query";
  const windows = cli.planWosExportWindows(175000, 500);
  for (const window of windows) {
    const rawDir = cli.rawBatchDir(paths, uuid, { sortBy: window.sortBy });
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(path.join(rawDir, `query_1_${window.sortBy === "author-ascending" ? 100000 : 75500}.txt`), "UT WOS:A\n");
  }

  cli.writeRawUuidCompleteMarker(paths, {
    uuid,
    expectedCount: 175000,
    rangeStart: 1,
    rangeEnd: 350000,
    largeExport: true,
    limitedByWosWindow: true,
    exportWindows: windows,
  });

  const marker = cli.readRawUuidCompleteMarker(paths, uuid);
  assert.equal(marker.largeExport, true);
  assert.deepEqual(marker.exportWindows.map((window) => window.sortBy), ["author-ascending", "author-descending"]);
  const windowDirs = cli.rawWindowDirs(paths, uuid, windows);
  assert.equal(windowDirs.length, 2);
  for (const entry of windowDirs) {
    const sortMarker = JSON.parse(fs.readFileSync(entry.marker, "utf8"));
    assert.equal(sortMarker.uuid, uuid);
    assert.equal(sortMarker.sortBy, entry.sortBy);
    assert.match(sortMarker.direction, /^(a-z|z-a)$/);
  }
});

test("BibTeX batch plan identifies arbitrary missing ranges", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  const bibDir = cli.bibBatchDir(paths, "query");
  fs.mkdirSync(bibDir, { recursive: true });
  fs.writeFileSync(path.join(bibDir, "query_1_500.bib"), "@article{a}\n");
  fs.writeFileSync(path.join(bibDir, "query_1001_1500.bib"), "@article{b}\n");

  const plan = cli.bibBatchPlanForRange(paths, "query", 1, 2000, 500);

  assert.equal(plan.plannedBatchCount, 4);
  assert.equal(plan.complete, false);
  assert.equal(plan.coveredCount, 1000);
  assert.deepEqual(plan.presentFiles, ["query_1_500.bib", "query_1001_1500.bib"]);
  assert.deepEqual(plan.missingBatches, [
    { markFrom: 501, markTo: 1000 },
    { markFrom: 1501, markTo: 2000 },
  ]);
});

test("writes and reads per-UUID TXT completion markers", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  const uuid = "01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc";
  fs.mkdirSync(cli.rawBatchDir(paths, uuid), { recursive: true });

  const markerPath = cli.writeRawUuidCompleteMarker(paths, {
    uuid,
    expectedCount: 1000,
    rangeStart: 1,
    rangeEnd: 1000,
  });
  const marker = cli.readRawUuidCompleteMarker(paths, uuid);

  assert.equal(markerPath, cli.rawUuidCompleteMarkerPath(paths, uuid));
  assert.equal(marker.uuid, uuid);
  assert.equal(marker.expectedCount, 1000);
  assert.equal(marker.rangeEnd, 1000);
});

test("raw batch parsing handles large existing files without spreading rows", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  const rawDir = cli.rawBatchDir(paths, "query");
  fs.mkdirSync(rawDir, { recursive: true });
  const lines = Array.from({ length: 150000 }, (_, index) => `UT WOS:${index + 1}`);
  fs.writeFileSync(path.join(rawDir, "query_1_150000.txt"), `${lines.join("\n")}\n`);

  const rows = cli.parseExistingRawBatches(paths, "query", {
    files: ["query_1_150000.txt"],
    startIndex: 1,
    endIndex: 150000,
  });

  assert.equal(rows.length, 150000);
  assert.equal(rows[0].wosid, "WOS:1");
  assert.equal(rows.at(-1).wosid, "WOS:150000");
});

test("raw batch start infers default TXT resume range", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  const rawDir = cli.rawBatchDir(paths, "query");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, "query_400_600.txt"), "UT WOS:400\n");

  const defaultArgs = cli.parseArgs(["node", "cli", "run", "--uuid", "query", "--tasks-root", root]);
  assert.equal(defaultArgs.fromIndexSource, "");
  assert.equal(cli.inferTxtRangeStart(paths, "query", defaultArgs, defaultArgs.fromIndex), 400);

  const explicitArgs = cli.parseArgs(["node", "cli", "run", "--uuid", "query", "--from-index", "1", "--tasks-root", root]);
  assert.equal(explicitArgs.fromIndexSource, "cli");
  assert.equal(cli.inferTxtRangeStart(paths, "query", explicitArgs, explicitArgs.fromIndex), 1);
});

test("TXT export persists streamed batches before final export completion", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const exportMethod = source.match(/async function exportFromWos\(args, paths\) \{[\s\S]*?\n}\n\nasync function exportBibFromWos/);
  assert.ok(exportMethod, "exportFromWos should be present");
  assert.match(exportMethod[0], /const persistTxtBatch = \(batch, sourcePhase = "batch", sortOptions = \{\}\) => \{/);
  assert.match(exportMethod[0], /const \{ text, \.\.\.progressEvent \} = event \|\| \{\};/);
  assert.match(exportMethod[0], /progressEvent\.phase === "batch" && typeof text === "string"/);
  assert.match(exportMethod[0], /persistTxtBatch\(\{\s*uuid: progressEvent\.uuid \|\| info\.uuid,/);
  assert.match(exportMethod[0], /appendProgress\(paths, \{ phase: "wosjs-export-progress", sidSwitchCount, sortBy: window\.sortBy, isRefQuery: exportRefQuery, \.\.\.progressEvent \}\)/);
});

test("batch UUID TXT runs per-UUID inspect and downloads quietly", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const batchMethod = source.match(/async function runBatchUuidTxt\(args\) \{[\s\S]*?\n}\n\nfunction combineBibFiles/);
  const exportMethod = source.match(/async function exportFromWos\(args, paths\) \{[\s\S]*?\n}\n\nasync function exportBibFromWos/);
  assert.ok(batchMethod, "runBatchUuidTxt should be present");
  assert.ok(exportMethod, "exportFromWos should be present");
  assert.match(batchMethod[0], /quiet: true,/);
  assert.match(batchMethod[0], /createProgress\("Planning UUID downloads", uuids\.length\)/);
  assert.doesNotMatch(batchMethod[0], /Batch UUID TXT prepare/);
  assert.doesNotMatch(batchMethod[0], /checking \$\{shortUuid\(uuid\)\}/);
  assert.match(batchMethod[0], /totalDownloadBatches = jobs\.reduce/);
  assert.match(batchMethod[0], /createProgress\("Batch UUID TXT", totalDownloadBatches\)/);
  assert.match(batchMethod[0], /formatUuidRemainingDetail\(completedDownloadUuids, totalDownloadUuids\)/);
  assert.match(batchMethod[0], /showDownloadProgress: true/);
  assert.match(batchMethod[0], /batchUuidProgress: \{\s*completed: completedDownloadUuids,\s*total: totalDownloadUuids,/);
  assert.match(exportMethod[0], /createSpinner\(authValidationMessage\(args\), \{ quiet \}\)/);
  assert.match(exportMethod[0], /const progressQuiet = quiet && !args\.showDownloadProgress/);
  assert.match(exportMethod[0], /createProgress\("Exporting records", batchCount, \{ quiet: progressQuiet \}\)/);
  assert.match(exportMethod[0], /const useWindowProgress = useSortWindowDirs/);
  assert.match(exportMethod[0], /txtExportProgressLabel\(window\.sortBy\)/);
  assert.match(exportMethod[0], /createProgress\(windowLabel, window\.plan\.plannedBatchCount, \{ quiet: progressQuiet \}\)/);
  assert.match(exportMethod[0], /batchOrdinalInRange\(markTo, currentWindowStartIndex, batchSize\)/);
  assert.match(exportMethod[0], /formatBatchUuidDownloadDetail\(args, formatDownloadWindowDetail\(currentDownloadWindow, downloadWindowCount/);
  assert.match(exportMethod[0], /batchOrdinalInRange\(firstMissing\.markFrom - 1, currentWindowStartIndex, batchSize\)/);
  assert.match(source, /if \(sortBy === "author-ascending"\) return "A-Z TXT"/);
  assert.match(source, /if \(sortBy === "author-descending"\) return "Z-A TXT"/);
  assert.match(exportMethod[0], /if \(!quiet\) \{\s*reportDownloadPlan/);
});

test("TXT export switches SID on WOS batch request failures without logging the full missing plan", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const exportMethod = source.match(/async function exportFromWos\(args, paths\) \{[\s\S]*?\n}\n\nasync function exportBibFromWos/);
  assert.ok(exportMethod, "exportFromWos should be present");
  assert.doesNotMatch(source, /DEFAULT_TXT_EXPORT_RETRIES/);
  assert.match(exportMethod[0], /switchSidAfterTxtExportFailure/);
  assert.match(exportMethod[0], /phase: "txt-export-sid-switch"/);
  assert.match(exportMethod[0], /discardActiveConfigSid\(args, `WOS TXT export failed for records/);
  assert.match(exportMethod[0], /waitForUsableWosSession\(args/);
  assert.match(exportMethod[0], /txt-export-sid-switch-validation-failed/);
  assert.match(exportMethod[0], /prepareWosRequestContext\(page, args\)/);
  assert.match(exportMethod[0], /missingBatchCount,/);
  assert.match(exportMethod[0], /firstMissingBatch: firstMissingWindow\?\.plan\.missingBatches\[0\] \|\| null/);
  assert.doesNotMatch(exportMethod[0], /missingBatches: resumePlan\.missingBatches,/);
});

test("failed TXT summaries do not short-circuit raw resume", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const runMethod = source.match(/async function run\(args\) \{[\s\S]*?\n}\n\nasync function runBib/);
  assert.ok(runMethod, "run should be present");
  assert.match(runMethod[0], /const priorRunFailed = isFailedTxtRunSummary\(samePriorSummary\);/);
  assert.match(runMethod[0], /const priorRunUnverifiedPartial = isUnverifiedPartialTxtSummary\(samePriorSummary, args\);/);
  assert.match(runMethod[0], /const priorSummary = \(priorRunFailed \|\| priorRunUnverifiedPartial\) \? \{\} : samePriorSummary;/);
  assert.match(runMethod[0], /const canRepairFromRaw = !args\.force &&/);
  assert.match(runMethod[0], /\(\(args\.reuseRaw && !priorRunFailed && !priorRunUnverifiedPartial\) \|\| canRepairFromRaw\)/);
});

test("unverified partial TXT summaries are not treated as completed", () => {
  const summary = {
    ok: true,
    method: "wos-js-export-fetchTxtBatches",
    uuid: "query",
    expectedCount: 1400,
    availableCount: 1400,
    selectedCount: 1400,
    fromIndex: 1,
    limit: 0,
    rangeStart: 1,
    rangeEnd: 1400,
    rowText: "",
  };

  assert.equal(cli.isUnverifiedPartialTxtSummary(summary, { uuid: "query" }), true);
  assert.equal(cli.isUnverifiedPartialTxtSummary({ ...summary, rowText: "321,607 results" }, { uuid: "query" }), false);
  assert.equal(cli.isUnverifiedPartialTxtSummary({ ...summary, limit: 1400 }, { uuid: "query" }), false);
});

test("validate does not create a missing task directory", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const taskDir = path.join(root, "missing");
  fs.mkdirSync(tasksRoot);
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [{ taskId: "missing", taskDir }],
  });
  const args = cli.parseArgs(["node", "cli", "validate", "--task", "missing", "--tasks-root", tasksRoot]);
  const result = cli.validateTask(args);
  assert.equal(result.ok, false);
  assert.equal(fs.existsSync(taskDir), false);
});

test("command dispatcher returns a status code for repeatable menu execution", async () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  fs.mkdirSync(tasksRoot);
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [{ taskId: "missing", taskDir: "missing" }],
  });
  const args = cli.parseArgs(["node", "cli", "validate", "--task", "missing", "--tasks-root", tasksRoot]);
  const originalLog = console.log;
  let output = "";
  console.log = (value = "") => {
    output += `${value}\n`;
  };
  try {
    const exitCode = await cli.executeCommand(args);
    assert.equal(exitCode, 1);
    assert.match(output, /"ok": false/);
  } finally {
    console.log = originalLog;
  }
});

test("artifact commands print final artifact paths instead of JSON", async () => {
  const root = temporaryDirectory();
  const csvPath = path.join(root, "input.csv");
  const tasksRoot = path.join(root, "tasks");
  fs.writeFileSync(csvPath, "wosid\nWOS:ABC\n");
  const args = cli.parseArgs([
    "node", "cli", "import", "--csv", csvPath, "--task", "imported", "--tasks-root", tasksRoot,
  ]);
  const originalLog = console.log;
  let output = "";
  console.log = (value = "") => {
    output += `${value}\n`;
  };
  try {
    const exitCode = await cli.executeCommand(args);
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
  }

  assert.equal(output.trim(), path.join(tasksRoot, "imported", "resultsets", "imported", "imported_wosid.csv"));
  assert.doesNotMatch(output, /"ok"|"wosidsCsv"/);
});

test("clear removes a managed task directory and refreshes latest", async () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const oldDir = path.join(tasksRoot, "old-task");
  const nextDir = path.join(tasksRoot, "next-task");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(nextDir, { recursive: true });
  writeProjectMarker(oldDir);
  writeProjectMarker(nextDir);
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [
      { taskId: "old-task", taskDir: "old-task", updatedAt: "2026-06-10T10:00:00.000Z" },
      { taskId: "next-task", taskDir: "next-task", updatedAt: "2026-06-10T09:00:00.000Z" },
    ],
  });
  fs.writeFileSync(path.join(tasksRoot, "latest"), "old-task\n");

  const result = await cli.confirmAndClearTask(
    cli.parseArgs(["node", "cli", "clear", "--task", "old-task", "--tasks-root", tasksRoot]),
    async () => "old-task",
    () => {}
  );

  assert.equal(result.taskDir, oldDir);
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(nextDir), true);
  assert.deepEqual(cli.readTaskIndex(tasksRoot).tasks.map((task) => task.taskId), ["next-task"]);
  assert.equal(fs.readFileSync(path.join(tasksRoot, "latest"), "utf8").trim(), "next-task");
});

test("clear removes latest when the final managed task is cleared", () => {
  const tasksRoot = temporaryDirectory();
  const taskDir = path.join(tasksRoot, "only-task");
  fs.mkdirSync(taskDir, { recursive: true });
  writeProjectMarker(taskDir);
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [{ taskId: "only-task", taskDir: "only-task" }],
  });
  fs.writeFileSync(path.join(tasksRoot, "latest"), "only-task\n");

  const result = cli.clearTask(cli.parseArgs(["node", "cli", "clear", "--latest", "--tasks-root", tasksRoot]));
  assert.equal(result.taskId, "only-task");
  assert.equal(result.latestTask, "");
  assert.equal(fs.existsSync(taskDir), false);
  assert.equal(fs.existsSync(path.join(tasksRoot, "latest")), false);
  assert.deepEqual(cli.readTaskIndex(tasksRoot).tasks, []);
});

test("clear requires typing the resolved task id before removal", async () => {
  const tasksRoot = temporaryDirectory();
  const taskDir = path.join(tasksRoot, "confirm-task");
  fs.mkdirSync(taskDir, { recursive: true });
  writeProjectMarker(taskDir);
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [{ taskId: "confirm-task", taskDir: "confirm-task" }],
  });

  await assert.rejects(
    () => cli.confirmAndClearTask(
      cli.parseArgs(["node", "cli", "clear", "--task", "confirm-task", "--tasks-root", tasksRoot]),
      async () => "wrong-task",
      () => {}
    ),
    /Task clear cancelled/
  );
  assert.equal(fs.existsSync(taskDir), true);

  const result = await cli.confirmAndClearTask(
    cli.parseArgs(["node", "cli", "clear", "--task", "confirm-task", "--tasks-root", tasksRoot]),
    async () => "confirm-task",
    () => {}
  );
  assert.equal(result.taskId, "confirm-task");
  assert.equal(fs.existsSync(taskDir), false);
});

test("clear rejects unmanaged task directories", () => {
  const tasksRoot = temporaryDirectory();
  const taskDir = path.join(tasksRoot, "unmanaged");
  fs.mkdirSync(taskDir, { recursive: true });
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [{ taskId: "unmanaged", taskDir: "unmanaged" }],
  });

  assert.throws(
    () => cli.clearTask(cli.parseArgs(["node", "cli", "clear", "--task", "unmanaged", "--tasks-root", tasksRoot])),
    /Refusing to clear unmanaged task directory/
  );
  assert.equal(fs.existsSync(taskDir), true);
  assert.deepEqual(cli.readTaskIndex(tasksRoot).tasks.map((task) => task.taskId), ["unmanaged"]);
});

test("validate accepts BibTeX batch tasks", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const taskDir = path.join(tasksRoot, "bib-task");
  const paths = cli.withRawSource(cli.getRunPaths(taskDir), "query");
  const queryBibDir = cli.bibBatchDir(paths, "query");
  fs.mkdirSync(queryBibDir, { recursive: true });
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [{ taskId: "bib-task", taskDir: "bib-task", uuid: "query" }],
  });
  writeProjectMarker(paths.taskDir);
  writeJson(paths.summary, {
    method: "wos-js-export-fetchBibBatches",
    taskId: "bib-task",
    uuid: "query",
    expectedCount: 2,
    batchCount: 1,
    rangeStart: 1,
    rangeEnd: 2,
  });
  fs.writeFileSync(path.join(queryBibDir, "query_1_2.bib"), "@article{demo}\n");

  const result = cli.validateTask(cli.parseArgs([
    "node", "cli", "validate", "--task", "bib-task", "--tasks-root", tasksRoot,
  ]));

  assert.equal(result.ok, true);
  assert.equal(result.bibBatches, 1);
  assert.equal(result.bibDir, queryBibDir);
  assert.equal(result.wosids, 0);
});

test("force cleanup preserves unrelated files in a managed output directory", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  fs.mkdirSync(paths.rawDir, { recursive: true });
  fs.mkdirSync(paths.exportRoot, { recursive: true });
  fs.writeFileSync(path.join(paths.rawDir, "batch.txt"), "data");
  fs.writeFileSync(path.join(root, "keep-me.txt"), "user data");
  writeJson(paths.summary, { ok: true });
  writeProjectMarker(paths.taskDir);

  cli.cleanRunLayout(paths);
  assert.equal(fs.existsSync(paths.rawDir), false);
  assert.equal(fs.existsSync(paths.exportRoot), false);
  assert.equal(fs.existsSync(paths.summary), false);
  assert.equal(fs.readFileSync(path.join(root, "keep-me.txt"), "utf8"), "user data");
});

test("force cleanup rejects an unmanaged directory inside tasks root", () => {
  const tasksRoot = temporaryDirectory();
  const paths = cli.getRunPaths(path.join(tasksRoot, "unmanaged"));
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(path.join(paths.dataDir, "user.csv"), "user data");

  assert.throws(() => cli.cleanRunLayout(paths), /Refusing to clean unmanaged output directory/);
  assert.equal(fs.readFileSync(path.join(paths.dataDir, "user.csv"), "utf8"), "user data");
});

test("import manifests redact SID values", () => {
  const root = temporaryDirectory();
  const csvPath = path.join(root, "input.csv");
  fs.writeFileSync(csvPath, "wosid\nWOS:ABC\n");
  const args = cli.parseArgs([
    "node", "cli", "import", "--csv", csvPath, "--task", "redacted",
    "--sid", "secret-sid", "--tasks-root", path.join(root, "tasks"),
  ]);

  cli.importWosIds(args);
  assert.equal(readJson(path.join(firstRunDir(args.outDir), "command.json")).args.sid, "[redacted]");
});

test("force import clears stale URL and UUID task metadata", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const csvPath = path.join(root, "input.csv");
  fs.writeFileSync(csvPath, "wosid\nWOS:ABC\n");
  fs.mkdirSync(tasksRoot, { recursive: true });
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [{
      taskId: "replace-me",
      taskDir: "replace-me",
      uuid: "old-uuid",
      url: "https://example.test/old",
      status: "completed",
    }],
  });
  const taskDir = path.join(tasksRoot, "replace-me");
  fs.mkdirSync(taskDir);
  writeProjectMarker(taskDir);
  const args = cli.parseArgs([
    "node", "cli", "import", "--csv", csvPath, "--task", "replace-me",
    "--tasks-root", tasksRoot, "--force",
  ]);

  cli.importWosIds(args);
  const task = cli.readTaskIndex(tasksRoot).tasks[0];
  assert.equal(task.uuid, "");
  assert.equal(task.url, "");
});

test("force cleanup rejects an unmanaged custom output directory", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  assert.throws(
    () => cli.cleanRunLayout(paths),
    /Refusing to clean unmanaged output directory/
  );
});

test("reuse-raw preserves expected count and stores a relative task path", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "run", "--uuid", "query", "--task", "reuse",
    "--tasks-root", tasksRoot, "--reuse-raw",
  ]);
  const paths = cli.getRunPaths(args.outDir);
  const queryPaths = cli.withRawSource(paths, "query");
  const queryRawDir = cli.rawBatchDir(paths, "query");
  fs.mkdirSync(queryRawDir, { recursive: true });
  writeProjectMarker(paths.taskDir);
  writeJson(paths.summary, { expectedCount: 2, rowText: "2 results", summaryHref: args.url });
  fs.writeFileSync(path.join(queryRawDir, "query_1_2.txt"), "UT WOS:A\nUT WOS:B\n");

  const result = await cli.run(args);
  assert.equal(result.ok, true);
  assert.equal(result.expectedCount, 2);
  assert.equal(result.files.rawDir, queryRawDir);
  assert.equal(fs.existsSync(path.join(queryPaths.wosIdsDir, "wosids_detailed.csv")), false);
  assert.equal(fs.existsSync(path.join(queryPaths.wosIdsDir, "wosids.json")), false);
  assert.equal(fs.existsSync(path.join(queryPaths.wosIdsDir, "full_records.txt")), false);
  assert.equal(Boolean(result.files.wosidsCsv), false);
  assert.equal(cli.readTaskIndex(tasksRoot).tasks[0].taskDir, "reuse");
});

test("raw-only reuse requires a known WOS record count for a different UUID", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "run", "--uuid", "new-query", "--task", "multi-uuid",
    "--tasks-root", tasksRoot, "--reuse-raw",
  ]);
  const paths = cli.getRunPaths(args.outDir);
  const oldPaths = cli.withRawSource(paths, "old-query");
  const newPaths = cli.withRawSource(paths, "new-query");
  const oldRawDir = cli.rawBatchDir(paths, "old-query");
  const newRawDir = cli.rawBatchDir(paths, "new-query");
  fs.mkdirSync(oldRawDir, { recursive: true });
  fs.mkdirSync(newRawDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeProjectMarker(paths.taskDir);
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchTxtBatches",
    taskId: "multi-uuid",
    uuid: "old-query",
    expectedCount: 999,
    uniqueCount: 999,
    summaryHref: "https://example.test/wos/woscc/summary/old-query/relevance/1",
    files: { wosidsCsv: path.join(oldPaths.wosIdsDir, "old-query_wosid.csv") },
  });
  fs.writeFileSync(path.join(oldRawDir, "old-query_1_1.txt"), "UT WOS:OLD\n");
  fs.writeFileSync(path.join(newRawDir, "new-query_1_1.txt"), "UT WOS:NEW\n");

  await assert.rejects(
    () => cli.run(args),
    /Cannot reuse raw batches without a known WOS record count/
  );
  assert.equal(fs.existsSync(path.join(newPaths.wosIdsDir, "new-query_wosid.csv")), false);
  assert.equal(fs.existsSync(path.join(oldRawDir, "old-query_1_1.txt")), true);
  assert.equal(cli.readTaskIndex(tasksRoot).tasks[0].uuid, "new-query");
});

test("missing WOS ID export is rebuilt from existing raw batches", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "run", "--uuid", "query", "--task", "repair-run",
    "--tasks-root", tasksRoot,
  ]);
  const paths = cli.getRunPaths(args.outDir);
  const queryPaths = cli.withRawSource(paths, "query");
  const queryRawDir = cli.rawBatchDir(paths, "query");
  fs.mkdirSync(queryRawDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeProjectMarker(paths.taskDir);
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchTxtBatches",
    taskId: "repair-run",
    uuid: "query",
    expectedCount: 2,
    rangeStart: 1,
    rangeEnd: 2,
    summaryHref: args.url,
  });
  fs.writeFileSync(path.join(queryRawDir, "query_1_2.txt"), "UT WOS:A\nUT WOS:B\n");

  const result = await cli.run(args);

  assert.equal(result.ok, true);
  assert.equal(result.files.rawDir, queryRawDir);
});

test("completed WOS ID task is reused without refetching", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "run", "--uuid", "query", "--task", "complete-run",
    "--tasks-root", tasksRoot,
  ]);
  const paths = cli.withRawSource(cli.getRunPaths(args.outDir), "query");
  fs.mkdirSync(paths.rawDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeProjectMarker(paths.taskDir);
  fs.writeFileSync(path.join(paths.rawDir, "query_1_1.txt"), "UT WOS:A\n");
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchTxtBatches",
    taskId: "complete-run",
    uuid: "query",
    expectedCount: 1,
    rangeStart: 1,
    rangeEnd: 1,
    rowText: "1 result",
  });

  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  let result;
  try {
    result = await cli.run(args);
  } finally {
    console.error = originalError;
  }

  assert.equal(result.files.rawDir, paths.rawDir);
  assert.equal(result.uuid, "query");
  assert.deepEqual(errors, ["WOS raw TXT batches already exist; skipping download."]);
});

test("completed WOS ID command returns before SID preparation", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "run", "--uuid", "query", "--task", "complete-command",
    "--tasks-root", tasksRoot,
  ]);
  const paths = cli.withRawSource(cli.getRunPaths(args.outDir), "query");
  fs.mkdirSync(paths.rawDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeProjectMarker(paths.taskDir);
  fs.writeFileSync(path.join(paths.rawDir, "query_1_1.txt"), "UT WOS:A\n");
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchTxtBatches",
    taskId: "complete-command",
    uuid: "query",
    expectedCount: 1,
    rangeStart: 1,
    rangeEnd: 1,
    rowText: "1 result",
  });

  const originalLog = console.log;
  const originalError = console.error;
  let output = "";
  const errors = [];
  console.log = (value = "") => {
    output += `${value}\n`;
  };
  console.error = (message = "") => errors.push(message);
  try {
    const exitCode = await cli.executeCommand(args);
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(output.trim(), paths.rawDir);
  assert.deepEqual(errors, ["WOS raw TXT batches already exist; skipping download."]);
});

test("completed BibTeX task is reused without refetching", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "bib", "--uuid", "query", "--task", "complete-bib",
    "--tasks-root", tasksRoot,
  ]);
  const paths = cli.withRawSource(cli.getRunPaths(args.outDir), "query");
  fs.mkdirSync(paths.bibDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeProjectMarker(paths.taskDir);
  fs.writeFileSync(path.join(paths.bibDir, "query_1_1.bib"), "@article{demo}\n");
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchBibBatches",
    taskId: "complete-bib",
    uuid: "query",
    expectedCount: 1,
    rangeStart: 1,
    rangeEnd: 1,
  });

  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  let result;
  try {
    result = await cli.runBib(args);
  } finally {
    console.error = originalError;
  }

  assert.equal(result.files.bibDir, paths.bibDir);
  assert.equal(result.uuid, "query");
  assert.deepEqual(errors, ["BibTeX raw batches already exist; skipping download."]);
});

test("missing combined BibTeX export is rebuilt from existing raw batches", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "bib", "--uuid", "query", "--task", "repair-bib",
    "--tasks-root", tasksRoot,
  ]);
  const paths = cli.getRunPaths(args.outDir);
  const queryPaths = cli.withRawSource(paths, "query");
  const queryBibDir = cli.bibBatchDir(paths, "query");
  fs.mkdirSync(queryBibDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeProjectMarker(paths.taskDir);
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchBibBatches",
    taskId: "repair-bib",
    uuid: "query",
    expectedCount: 1,
    rangeStart: 1,
    rangeEnd: 1,
  });
  fs.writeFileSync(path.join(queryBibDir, "query_1_1.bib"), "@article{demo,\n  title={Demo}\n}\n");

  const result = await cli.runBib(args);

  assert.equal(result.files.bibDir, queryBibDir);
});

test("completed BibTeX command returns before SID preparation", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "bib", "--uuid", "query", "--task", "complete-bib-command",
    "--tasks-root", tasksRoot,
  ]);
  const paths = cli.withRawSource(cli.getRunPaths(args.outDir), "query");
  fs.mkdirSync(paths.bibDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeProjectMarker(paths.taskDir);
  fs.writeFileSync(path.join(paths.bibDir, "query_1_1.bib"), "@article{demo}\n");
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchBibBatches",
    taskId: "complete-bib-command",
    uuid: "query",
    expectedCount: 1,
    rangeStart: 1,
    rangeEnd: 1,
  });

  const originalLog = console.log;
  const originalError = console.error;
  let output = "";
  const errors = [];
  console.log = (value = "") => {
    output += `${value}\n`;
  };
  console.error = (message = "") => errors.push(message);
  try {
    const exitCode = await cli.executeCommand(args);
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(output.trim(), paths.bibDir);
  assert.deepEqual(errors, ["BibTeX raw batches already exist; skipping download."]);
});

test("managed current task placeholder can be reused without force", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "run", "--uuid", "query", "--task", "current",
    "--tasks-root", tasksRoot, "--reuse-raw",
  ]);
  const paths = cli.getRunPaths(args.outDir);
  const queryPaths = cli.withRawSource(paths, "query");
  const queryRawDir = cli.rawBatchDir(paths, "query");
  fs.mkdirSync(queryRawDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeProjectMarker(paths.taskDir);
  writeJson(paths.summary, { expectedCount: 1, rowText: "1 result", summaryHref: args.url });
  fs.writeFileSync(path.join(queryRawDir, "query_1_1.txt"), "UT WOS:A\n");

  const result = await cli.run(args);

  assert.equal(result.ok, true);
  assert.equal(result.files.rawDir, queryRawDir);
});

test("reuse-raw refuses partial batches without marking complete", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "run", "--uuid", "query", "--task", "partial-raw",
    "--tasks-root", tasksRoot, "--reuse-raw",
  ]);
  const paths = cli.getRunPaths(args.outDir);
  const queryPaths = cli.withRawSource(paths, "query");
  const queryRawDir = cli.rawBatchDir(paths, "query");
  fs.mkdirSync(queryRawDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeProjectMarker(paths.taskDir);
  writeJson(paths.summary, { expectedCount: 3, rowText: "3 results", summaryHref: args.url });
  fs.writeFileSync(path.join(queryRawDir, "query_1_1.txt"), "UT WOS:A\n");

  await assert.rejects(
    () => cli.run(args),
    /Incomplete raw batches/
  );
  assert.equal(fs.existsSync(path.join(queryPaths.wosIdsDir, "query_wosid.csv")), false);
});

test("BibTeX export refuses incomplete downloaded record counts", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/async function exportBibFromWos[\s\S]*?\n}\n\nfunction combineBibFiles/);
  assert.ok(match, "exportBibFromWos source should be present");
  assert.match(match[0], /const resumePlan = bibBatchPlanForRange/);
  assert.match(match[0], /resume-bib-raw/);
  assert.match(match[0], /for \(const missingBatch of resumePlan\.missingBatches\)/);
  assert.match(match[0], /Incomplete raw BibTeX batches after export/);
  assert.match(match[0], /downloadedEntries < selectedCount/);
  assert.match(match[0], /Incomplete BibTeX export/);
  assert.match(match[0], /throw new Error/);
});

test("failed runs are recorded as failed", () => {
  const tasksRoot = temporaryDirectory();
  const taskDir = path.join(tasksRoot, "broken");
  const paths = cli.getRunPaths(taskDir);
  const rawDir = cli.rawBatchDir(paths, "query");
  fs.mkdirSync(rawDir, { recursive: true });
  writeProjectMarker(taskDir);
  writeJson(paths.summary, { expectedCount: 3 });
  fs.writeFileSync(path.join(rawDir, "query_1_2.txt"), "UT WOS:A\n");
  fs.writeFileSync(path.join(rawDir, "query_2_3.txt"), "UT WOS:B\n");
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "..", "bin", "iiaide-wos.js"),
    "run", "--sid", "unused", "--uuid", "query", "--task", "broken",
    "--tasks-root", tasksRoot, "--reuse-raw", "--force",
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  const task = cli.readTaskIndex(tasksRoot).tasks.find((item) => item.taskId === "broken");
  assert.equal(task.status, "failed");
  assert.match(task.lastError, /Overlapping raw batches/);
});

test("runParsedCommand handles Ctrl+C abort errors quietly", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/async function runParsedCommand[\s\S]*?\n}\n\nasync function runInteractiveMenu/);
  assert.ok(match, "runParsedCommand source should be present");
  assert.match(match[0], /isUserAbortError\(error\)/);
  assert.match(match[0], /return 130/);
  assert.doesNotMatch(match[0], /recordCommandFailure\(args, error\);[\s\S]*isUserAbortError/);
});

test("runParsedCommand handles user cancellation without a stack trace", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/async function runParsedCommand[\s\S]*?\n}\n\nasync function runInteractiveMenu/);
  assert.ok(match, "runParsedCommand source should be present");
  assert.match(match[0], /isUserCancelledError\(error\)/);
  assert.match(match[0], /return 0/);
  assert.equal(cli.isUserCancelledError({ code: "USER_CANCELLED" }), true);
});

test("runParsedCommand handles user quit without returning to command work", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/async function runParsedCommand[\s\S]*?\n}\n\nasync function runInteractiveMenu/);
  assert.ok(match, "runParsedCommand source should be present");
  assert.match(match[0], /isUserQuitError\(error\)/);
  assert.match(match[0], /return 130/);
  assert.equal(cli.isUserQuitError({ code: "USER_QUIT" }), true);
});


test("interactive downloads do not force-clear the current task by default", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "interactive.js"), "utf8");
  const match = source.match(/const result = activeWorkspace\.projectMode[\s\S]*?return result;/);
  const branch = source.match(/let selection = currentTaskSelection[\s\S]*?return result;/);
  assert.ok(match, "interactive command result source should be present");
  assert.ok(branch, "interactive download branch should be present");
  assert.doesNotMatch(match[0], /"--force"/);
  assert.match(match[0], /"--reuse-raw"/);
  assert.match(match[0], /\[command, sourceFlag, source\]/);
  assert.match(match[0], /\[command, sourceFlag, source, "--task", taskId, "--tasks-root", activeWorkspace\.tasksRoot\]/);
  assert.match(branch[0], /currentTaskSelection/);
  assert.doesNotMatch(branch[0], /askTaskSelection/);
});

test("interactive URL or UUID prompt supports saved source fallback", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "interactive.js"), "utf8");
  const promptMatch = source.match(/async function askParameterOrCancel[\s\S]*?\n}\n\nfunction defaultTaskId/);
  const workflowMatch = source.match(/const source = await askParameterOrCancel[\s\S]*?const sourceFlag/);
  assert.ok(promptMatch, "askParameterOrCancel source should be present");
  assert.ok(workflowMatch, "interactive source prompt should be present");
  assert.doesNotMatch(promptMatch[0], /Enter or c cancels/);
  assert.match(promptMatch[0], /Enter uses saved/);
  assert.match(promptMatch[0], /B back, q quit/);
  assert.match(promptMatch[0], /if \(!answer && fallback\) return fallback/);
  assert.match(promptMatch[0], /B goes back, q quits/);
  assert.match(promptMatch[0], /CONTROL_BACK/);
  assert.match(promptMatch[0], /CONTROL_QUIT/);
  assert.match(workflowMatch[0], /sourceFallback/);
  assert.match(workflowMatch[0], /return \{ refresh: true \}/);
});

test("interactive WOS workflows ask for source before SID setup", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "interactive.js"), "utf8");
  const method = source.match(/async function interactiveArgs[\s\S]*?\n}\n\nmodule\.exports = \{/);
  assert.ok(method, "interactiveArgs should be present");
  const sourcePromptIndex = method[0].indexOf('const source = await askParameterOrCancel(');
  const sidPromptIndex = method[0].indexOf('sid = await askSidFromBrowserOrManual(');
  assert.ok(sourcePromptIndex >= 0, "source prompt should be present");
  assert.ok(sidPromptIndex >= 0, "SID prompt should be present");
  assert.ok(sourcePromptIndex < sidPromptIndex, "source prompt should happen before SID setup");
});

test("interactive workflow does not print saved SID noise", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "interactive.js"), "utf8");
  assert.doesNotMatch(source, /saved SID will be used/);
  assert.match(source, /workspaceSidStatus/);
});

test("interactive startup does not force SID setup before workflow selection", () => {
  const interactiveSource = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "interactive.js"), "utf8");
  const startupBranch = interactiveSource.match(/const generatedTaskId = helpers\.makeTaskId[\s\S]*?const choice = await askWorkflow\(rl, activeWorkspace\)/);
  assert.ok(startupBranch, "interactive startup branch should be present");
  assert.doesNotMatch(startupBranch[0], /askSidFromBrowserOrManual/);
  assert.doesNotMatch(startupBranch[0], /helpers\.saveSid/);
});

test("interactive WOS workflows set up SID on demand and continue current flow", () => {
  const interactiveSource = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "interactive.js"), "utf8");
  const menuSource = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const sidBranch = interactiveSource.match(/const sourceFlag[\s\S]*?if \(sid\) result\.push\("--sid", sid\);/);
  const helperBranch = menuSource.match(/readBrowserSid: \(\) => readSidFromBrowser\(menuArgs\)[\s\S]*?setCurrentTask/);
  assert.ok(sidBranch, "interactive on-demand SID branch should be present");
  assert.ok(helperBranch, "interactive saveSid helper should be present");
  assert.match(sidBranch[0], /helpers\.saveSid/);
  assert.match(sidBranch[0], /helpers\.waitForSidPool/);
  assert.match(sidBranch[0], /workspaceSidStatus\(activeWorkspace\) !== "valid"/);
  assert.match(sidBranch[0], /askSidFromBrowserOrManual/);
  assert.match(sidBranch[0], /saved\./);
  assert.doesNotMatch(sidBranch[0], /Refreshing workspace panel/);
  assert.doesNotMatch(sidBranch[0], /saved[\s\S]*?return \{ refresh: true \}/);
  assert.match(helperBranch[0], /addSidsToConfig\(menuArgs, \[sid\], \{ activate: true \}\)/);
  assert.match(helperBranch[0], /waitForSavedSidPool\(menuArgs\)/);
  assert.match(helperBranch[0], /quickValidateSid\(menuArgs\)/);
  assert.match(helperBranch[0], /workspaceStatus\(menuArgs, refreshedSidCheck\)/);
});

test("interactive startup no longer auto-opens a browser when SID is invalid", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/async function runInteractiveMenu[\s\S]*?\n}\n\nasync function main/);
  assert.ok(match, "runInteractiveMenu source should be present");
  assert.match(match[0], /const sidCheck = await quickValidateSid\(menuArgs\)/);
  assert.doesNotMatch(match[0], /prepareWosSession\(menuArgs, \{ keepAlive: true, visible: true \}\)/);
});

test("prepareWosSession rotates to the next saved SID when a kept-alive session switches UUID", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/async function prepareWosSession[\s\S]*?\n}\n\nasync function waitForUsableWosSession/);
  assert.ok(match, "prepareWosSession should be present");
  assert.match(match[0], /sharedWosSession\.lastUuid/);
  assert.match(match[0], /advanceSavedSid\(args\)/);
  assert.match(match[0], /WOS UUID changed from/);
});

test("interactive update restarts the CLI after a successful update", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/async function runInteractiveMenu[\s\S]*?\n}\n\nasync function main/);
  assert.ok(match, "runInteractiveMenu source should be present");
  assert.match(source, /function restartCurrentCli/);
  assert.match(match[0], /selectedArgs\[0\] === "update"/);
  assert.match(match[0], /await closeSharedWosSession\(\)/);
  assert.match(match[0], /return await restartCurrentCli\(argv\)/);
});

test("terminal status helpers use plain text outside a TTY", async () => {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk;
  });

  const spinner = createSpinner("Checking auth", { stream });
  spinner.succeed("Auth ready");
  const progress = createProgress("Authors", 2, { stream });
  progress.increment("first");
  progress.increment("second", true);
  progress.stop();
  const dynamic = createProgress("BibTeX", 1, { stream });
  dynamic.setTotal(2);
  dynamic.update(1, "first");
  dynamic.increment("second");
  dynamic.stop("BibTeX done");
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(output, /Checking auth\.\.\./);
  assert.match(output, /OK Auth ready/);
  assert.match(output, /Authors: 2\/2, 1 failed/);
  assert.match(output, /BibTeX: 0\/1/);
  assert.match(output, /BibTeX done: 2\/2/);
  assert.doesNotMatch(output, /\x1b/);
});
