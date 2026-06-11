const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const Database = require("better-sqlite3");

const cli = require("../src/iiaide-wos");
const { readJson, writeJson } = require("../src/lib/io");
const { classifyWosIdsToSqlInput, currentTaskSelection, formatBytes, formatRuntime, isWosSourceLike, listTaskHints, printHeader, resolveTaskSelection, taskPromptHelp, taskSelectionHint } = require("../src/lib/interactive");
const { createProgress, createSpinner } = require("../src/lib/terminal");
const { normalizeBatchResult } = require("../src/lib/wos-browser-export");
const { wosIdsEquivalent } = require("../src/lib/wos-ids");
const { existingWosDataBlacklistedIds } = require("../src/lib/wos-sqlite");

function temporaryDirectory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iiaide-wos-test-"));
  process.env.IIAIDE_WOS_CONFIG = path.join(root, "global-config.json");
  return root;
}

function seedWosDataRecord(dbPath, taskId, record, options = {}) {
  return cli.importWosDataRecord({
    dbPath,
    taskId,
    record,
    source: options.source || `test:${taskId}:${record.wosid || "record"}`,
    expectedWosId: options.expectedWosId || "",
    force: Boolean(options.force),
  });
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

test("parses BibTeX export tasks", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "bib", "--uuid", "abc", "--task", "refs", "--tasks-root", root]);
  assert.equal(args.command, "bib");
  assert.equal(args.url, "https://www.webofscience.com/wos/woscc/summary/abc/relevance/1");
  assert.equal(args.outDir, path.join(root, "refs"));
});

test("parses WOS data SQLite management tasks", () => {
  const root = temporaryDirectory();
  const sourceDb = path.join(root, "source.sqlite");
  const dbPath = path.join(root, "custom.sqlite");
  const blacklistDbPath = path.join(root, "blacklist.sqlite");
  const args = cli.parseArgs([
    "node", "cli", "wosdata", "--merge-db", sourceDb, "--db", dbPath, "--blacklist-db", blacklistDbPath, "--tasks-root", root,
  ]);

  assert.equal(args.command, "wosdata");
  assert.equal(args.mergeDbPath, sourceDb);
  assert.equal(args.dbPath, dbPath);
  assert.equal(args.blacklistDbPath, blacklistDbPath);
  assert.equal(
    cli.parseArgs(["node", "cli", "wosdata", "--query", "SELECT wosid FROM wos_records", "--tasks-root", root]).dbPath,
    path.join(os.homedir(), ".iiaide-wos", "wosdata.sqlite")
  );
  assert.equal(
    cli.parseArgs(["node", "cli", "wosdata", "--blacklist", "--tasks-root", root]).blacklistDbPath,
    path.join(os.homedir(), ".iiaide-wos", "wos-blacklist.sqlite")
  );
  assert.equal(
    cli.parseArgs(["node", "cli", "wosdata", "--wosid", "WOS:ABC", "--tasks-root", root]).queryWosId,
    "WOS:ABC"
  );
  assert.equal(
    cli.parseArgs(["node", "cli", "wosdata", "--query", "SELECT wosid FROM wos_records", "--tasks-root", root]).sqlQuery,
    "SELECT wosid FROM wos_records"
  );
  assert.equal(
    cli.parseArgs(["node", "cli", "wosdata", "--blacklist", "--tasks-root", root]).blacklistQuery,
    true
  );
  assert.equal(
    cli.parseArgs(["node", "cli", "wosdata", "--unblacklist", "WOS:BAD", "--tasks-root", root]).unblacklistWosId,
    "WOS:BAD"
  );
  assert.equal(
    cli.parseArgs(["node", "cli", "wosdata", "--clear-blacklist", "--tasks-root", root]).clearBlacklist,
    true
  );
  assert.equal(
    cli.parseArgs(["node", "cli", "parse", "--task", "demo", "--retry-blacklist", "--tasks-root", root]).retryBlacklist,
    true
  );
  assert.equal(
    cli.parseArgs(["node", "cli", "parse", "--task", "demo", "--reparse-existing", "--tasks-root", root]).reparseExisting,
    true
  );
});

test("parses SID check tasks", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "check", "--tasks-root", root]);
  assert.equal(args.command, "check");
  assert.equal(args.tasksRoot, root);
});

test("package exposes iiw as the short CLI alias", () => {
  const pkg = require("../package.json");
  assert.equal(pkg.bin["iiaide-wos"], "bin/iiaide-wos.js");
  assert.equal(pkg.bin.iiw, "bin/iiaide-wos.js");
});

test("parse browser restart interval is configurable", () => {
  const root = temporaryDirectory();
  const defaults = cli.parseArgs(["node", "cli", "parse", "--task", "demo", "--tasks-root", root]);
  assert.equal(defaults.browserRestartEvery, 0);

  const disabled = cli.parseArgs(["node", "cli", "parse", "--task", "demo", "--browser-restart-every", "0", "--tasks-root", root]);
  assert.equal(disabled.browserRestartEvery, 0);

  const tuned = cli.parseArgs(["node", "cli", "parse", "--task", "demo", "--restart-every", "50", "--tasks-root", root]);
  assert.equal(tuned.browserRestartEvery, 50);

  assert.throws(
    () => cli.parseArgs(["node", "cli", "parse", "--task", "demo", "--parse-max-attempts", "4", "--tasks-root", root]),
    /Unknown argument/
  );
});

test("parse concurrency default can be saved in settings", () => {
  const root = temporaryDirectory();
  const settingsArgs = cli.parseArgs(["node", "cli", "settings", "--parse-concurrency", "3", "--tasks-root", root]);
  const saved = cli.setParseConcurrencySetting(settingsArgs, settingsArgs.parseConcurrencySetting);

  assert.equal(saved.parseConcurrency, 3);
  assert.equal(readJson(path.join(root, "config.json")).parseConcurrency, 3);

  const configured = cli.parseArgs(["node", "cli", "parse", "--task", "demo", "--tasks-root", root]);
  assert.equal(configured.concurrency, 3);
  assert.equal(cli.workspaceStatus(configured).parseConcurrency, 3);

  const oneOff = cli.parseArgs(["node", "cli", "parse", "--task", "demo", "--concurrency", "5", "--tasks-root", root]);
  assert.equal(oneOff.concurrency, 5);
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

test("parse failure recovery probes buildQuery and restarts CLI only on SID query errors", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/const refreshSidAfterConsecutiveFailures = async \(\) => \{[\s\S]*?\n  \};\n  try/);
  assert.ok(match, "parse SID recovery source should be present");
  assert.match(match[0], /testing WOS buildQuery recovery/);
  assert.match(match[0], /await forceCloseWosSession\(session\)/);
  assert.match(match[0], /runWosRecoveryBuildQuery\(session\.page, args\)/);
  assert.match(match[0], /if \(recoveryQuery\.error_code\)/);
  assert.match(match[0], /isSidInvalidRecoveryErrorCode\(recoveryQuery\.error_code\)/);
  assert.match(match[0], /await forceCloseWosSession\(session\)/);
  assert.match(match[0], /discardActiveConfigSid\(args/);
  assert.doesNotMatch(match[0], /clearSavedSidConfig\(args\)/);
  assert.match(match[0], /delete process\.env\.WOS_SID/);
  assert.match(match[0], /omitSidArgs: true/);
  assert.match(match[0], /parse-recovery-build-query-inconclusive/);
  assert.match(match[0], /startParseSession\("recovery-query-inconclusive"\)/);
  assert.doesNotMatch(match[0], /startParseSession\("consecutive-failures"\)/);
  assert.doesNotMatch(match[0], /loginForFreshSid/);
});

test("parse failures are recorded once without retrying individual WOSIDs", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/let recordProgressStatus = "ok"[\s\S]*?parseProgress\.update\(processed, `\$\{recordProgressStatus\} \$\{wosid\}`, failures\.length\);/);
  assert.ok(match, "parse failure source should be present");
  assert.doesNotMatch(source, /DEFAULT_PARSE_MAX_ATTEMPTS/);
  assert.doesNotMatch(source, /parseMaxAttempts/);
  assert.doesNotMatch(source, /willRetry/);
  assert.doesNotMatch(source, /chunk\.push\(\{ \.\.\.item/);
  assert.match(source, /const PARSE_RECOVERY_CONSECUTIVE_FAILURES = 20/);
  assert.match(match[0], /const sessionRecoveryError = isSessionRecoveryError\(error\)/);
  assert.match(match[0], /const blacklisted = true/);
  assert.match(match[0], /recordProgressStatus = "failed"/);
  assert.match(match[0], /consecutiveParseFailures \+= 1/);
  assert.match(match[0], /consecutiveParseFailures >= PARSE_RECOVERY_CONSECUTIVE_FAILURES/);
  assert.match(match[0], /failures\.push\(failure\)/);
  assert.match(match[0], /processed \+= 1/);
});

test("SID recovery classifies parse errors for diagnostics only", () => {
  assert.equal(cli.isSessionRecoveryError(new Error("No full-record JSON parsed for WOS:BAD")), false);
  assert.equal(cli.isSessionRecoveryError(new Error("Full record timeout after 20000ms: WOS:BAD")), false);
  assert.equal(cli.isSessionRecoveryError(new Error("Expected WOSID WOS:A but parsed WOS:B")), false);
  assert.equal(cli.isSessionRecoveryError(new Error("You’ve reached the query limit for your session.")), true);
  assert.equal(cli.isSessionRecoveryError(new Error("WOS returned a login page")), true);
  assert.equal(cli.isSessionRecoveryError(new Error("Target page, context or browser has been closed")), true);
});

test("WOSID parse failures are blacklistable without error-type filtering", () => {
  assert.equal(cli.isWosIdNoResultError(new Error("No full-record JSON parsed for WOS:BAD")), true);
  assert.equal(cli.isWosIdNoResultError(new Error("[WOS] Failed to open full record for WOS:BAD; current route=unknown, page=unknown")), true);
  assert.equal(cli.isWosIdNoResultError(new Error("Full record timeout after 20000ms: WOS:BAD")), true);
  assert.equal(cli.isWosIdNoResultError(new Error("You’ve reached the query limit for your session.")), false);
  assert.equal(cli.isWosIdNoResultError(new Error("WOS data record mismatch: expected=WOS:A actual=WOS:B")), false);
  assert.equal(cli.isWosIdBlacklistableError(new Error("No full-record JSON parsed for WOS:BAD")), true);
  assert.equal(cli.isWosIdBlacklistableError(new Error("Full record timeout after 20000ms: WOS:BAD")), true);
  assert.equal(cli.isWosIdBlacklistableError(new Error("Cannot read properties of undefined while parsing WOS:BAD")), true);
  assert.equal(cli.isWosIdBlacklistableError(new Error("WOS data record mismatch: expected=WOS:A actual=WOS:B")), true);
  assert.equal(cli.isWosIdBlacklistableError(new Error("SQLite database is locked")), true);
});

test("SID recovery invalidates only explicit WOS session error codes", () => {
  assert.equal(cli.isSidInvalidRecoveryErrorCode("unknown error"), false);
  assert.equal(cli.isSidInvalidRecoveryErrorCode("failed to read current query page info"), false);
  assert.equal(cli.isSidInvalidRecoveryErrorCode("failed to read query result page info"), false);
  assert.equal(cli.isSidInvalidRecoveryErrorCode("You’ve reached the query limit for your session. Please close your session and start a new one."), true);
  assert.equal(cli.isSidInvalidRecoveryErrorCode("session expired"), true);
  assert.equal(cli.isSidInvalidRecoveryErrorCode("WOS returned a login page"), true);
});

test("parse browser restarts are disabled by default and reconnect through a query route when enabled", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/if \(!session\) \{[\s\S]*?\n      \}/);
  assert.ok(match, "parse restart session block should be present");
  assert.match(match[0], /startParseSession\("browser-restart", chunkIndex \+ 1, chunks\.length\)/);
  assert.match(source, /warmUpWosQueryPage\(nextSession\.page, args\)/);
  assert.match(source, /const DEFAULT_BROWSER_RESTART_EVERY = 0/);
});

test("connectivity query uses wos.js openQueryPage and reads search info when available", async () => {
  const calls = [];
  const page = {
    evaluate: async (fn, arg) => {
      const body = fn.toString();
      if (body.includes("Boolean(window.wos")) return true;
      if (body.includes("openQueryPage")) {
        calls.push(["openQueryPage", arg]);
        return null;
      }
      if (body.includes("fetchCurrentPageInfo")) {
        return {
          uuid: "warmup",
          expectedCount: 12,
          countText: "12",
          rowText: "PY=2000",
          href: "https://www.webofscience.com/wos/woscc/general-summary?queryJson=...",
          status: "success",
        };
      }
      return null;
    },
    waitForSelector: async (selector, options) => {
      calls.push(["waitForSelector", selector, options.state]);
    },
    waitForLoadState: async (state) => {
      calls.push(["waitForLoadState", state]);
    },
  };

  const info = await cli.warmUpWosQueryPage(page, { timeoutMs: 120000 }, "PY=2000");
  assert.deepEqual(calls.slice(0, 3), [
    ["openQueryPage", "PY=2000"],
    ["waitForSelector", 'div[data-ta="search-info"]', "attached"],
    ["waitForLoadState", "networkidle"],
  ]);
  assert.equal(info.rowText, "PY=2000");
  assert.equal(info.expectedCount, 12);
  assert.equal(info.searchInfoReady, true);
});

test("connectivity query can continue when search info never renders", async () => {
  const page = {
    evaluate: async (fn, arg) => {
      const body = fn.toString();
      if (body.includes("Boolean(window.wos")) return true;
      if (body.includes("openQueryPage")) {
        assert.equal(arg, "PY=2000");
        return {
          rowText: arg,
          href: "https://www.webofscience.com/wos/woscc/general-summary?queryJson=...",
          status: "routed",
          sid: "sid",
        };
      }
      throw new Error("fetchCurrentPageInfo should not be called without search info");
    },
    waitForSelector: async () => {
      throw new Error("Timeout 5000ms exceeded");
    },
    waitForLoadState: async () => {},
  };

  const info = await cli.warmUpWosQueryPage(page, { timeoutMs: 120000, recordTimeoutMs: 30000 }, "PY=2000");
  assert.equal(info.rowText, "PY=2000");
  assert.equal(info.status, "routed");
  assert.equal(info.searchInfoReady, false);
  assert.equal(info.expectedCount, 0);
});

test("recovery buildQuery uses a random abstract query and surfaces WOS errors", async () => {
  assert.match(cli.randomUppercaseLetters(4), /^[A-Z]{4}$/);
  const calls = [];
  const page = {
    evaluate: async (fn, arg) => {
      const body = fn.toString();
      if (body.includes("Boolean(window.wos")) return true;
      if (body.includes("buildQuery")) {
        calls.push(["buildQuery", arg]);
        return {
          uuid: "random-query",
          ref_count: 0,
          rowText: arg,
          status: "failed",
          error_code: "unknown error",
        };
      }
      return null;
    },
  };

  const result = await cli.runWosRecoveryBuildQuery(page, { timeoutMs: 120000 }, "AB=QWER");
  assert.deepEqual(calls, [["buildQuery", "AB=QWER"]]);
  assert.equal(result.expr, "AB=QWER");
  assert.equal(result.error_code, "unknown error");
  assert.equal(result.status, "failed");
});

test("runParsedCommand restarts the current CLI when parse recovery requests it", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/async function runParsedCommand[\s\S]*?\n}\n\nfunction restartCurrentCli/);
  assert.ok(match, "runParsedCommand source should be present");
  assert.match(match[0], /isCliRestartRequestedError\(error\)/);
  assert.match(match[0], /await closeSharedWosSession\(\)/);
  assert.match(match[0], /error\.omitSidArgs \? omitSidArgs\(argv\) : argv/);
  assert.equal(cli.isCliRestartRequestedError({ code: "CLI_RESTART_REQUESTED" }), true);
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

test("parse progress detail is completion-oriented for concurrent workers", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  assert.match(source, /let recordProgressStatus = "ok"/);
  assert.match(source, /recordProgressStatus = "failed"/);
  assert.doesNotMatch(source, /consecutiveFailures \+= 1/);
  assert.match(source, /parseProgress\.update\(processed, `\$\{recordProgressStatus\} \$\{wosid\}`, failures\.length\)/);
  assert.doesNotMatch(source, /parseProgress\.update\(processed, `source \$\{index\}/);
});

test("detects readline Ctrl+C abort errors", () => {
  assert.equal(cli.isUserAbortError({ name: "AbortError", message: "Aborted with Ctrl+C" }), true);
  assert.equal(cli.isUserAbortError({ code: "ABORT_ERR", message: "aborted" }), true);
  assert.equal(cli.isUserAbortError(new Error("normal failure")), false);
});

test("calculates WOS download batches in 200-record chunks", () => {
  assert.equal(cli.downloadBatchCount(0), 0);
  assert.equal(cli.downloadBatchCount(1), 1);
  assert.equal(cli.downloadBatchCount(200), 1);
  assert.equal(cli.downloadBatchCount(201), 2);
  assert.equal(cli.downloadBatchCount(401), 3);
});

test("calculates bounded WOS record ranges before download planning", () => {
  assert.equal(cli.boundedRecordCount(800, 1, 0), 800);
  assert.equal(cli.boundedRecordCount(800, 1, 200), 200);
  assert.equal(cli.boundedRecordCount(800, 201, 200), 200);
  assert.equal(cli.boundedRecordCount(800, 701, 200), 100);
  assert.equal(cli.boundedRecordCount(800, 900, 200), 0);
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
  assert.match(workflowMatch[0], /workflowTopItem\("2", "WOS IDs to SQL/);
  assert.doesNotMatch(workflowMatch[0], /Parse"\)/);
  assert.doesNotMatch(workflowMatch[0], /2\.2/);
  assert.doesNotMatch(workflowMatch[0], /WOSID CSV/);
  assert.match(workflowMatch[0], /3\.1", "New/);
  assert.match(workflowMatch[0], /3\.2", "Switch/);
  assert.match(workflowMatch[0], /3\.3", "Clear/);
  assert.match(workflowMatch[0], /SQL database/);
  assert.match(workflowMatch[0], /4\.1", "Status/);
  assert.match(workflowMatch[0], /4\.2", "Merge database/);
  assert.match(workflowMatch[0], /4\.3", "Query WOSID/);
  assert.match(workflowMatch[0], /Settings/);
  assert.match(workflowMatch[0], /5\.1", "Playwright visible/);
  assert.match(workflowMatch[0], /5\.2", "Parse tabs/);
  assert.match(workflowMatch[0], /5\.3", "Add SID/);
  assert.match(workflowMatch[0], /5\.4", "Batch add SIDs/);
  assert.match(workflowMatch[0], /shortcutRow/);
  assert.match(workflowMatch[0], /\["c", "Check SID"\]/);
  assert.match(workflowMatch[0], /\["u", "Update"\]/);
  assert.match(workflowMatch[0], /\["B", "Back"\]/);
  assert.match(workflowMatch[0], /\["q", "Exit"\]/);
  assert.doesNotMatch(workflowMatch[0], /Probe the saved SID/);
  assert.doesNotMatch(workflowMatch[0], /Install the latest release/);
  assert.doesNotMatch(workflowMatch[0], /Return to the workspace menu/);
  assert.match(workflowMatch[0], /choose 1\.1, 1\.2, 2, 3\.1, 3\.2, 3\.3, 4\.1, 4\.2, 4\.3, 5\.1, 5\.2, 5\.3, 5\.4, c to check SID, u to update, B to go back/);
  assert.doesNotMatch(workflowMatch[0], /Download WOS IDs/);
  assert.match(argsMatch[0], /choice === "c"/);
  assert.match(argsMatch[0], /return \["check", "--tasks-root", activeWorkspace\.tasksRoot\]/);
  assert.match(argsMatch[0], /choice === "u"/);
  assert.match(argsMatch[0], /return \["update"\]/);
  assert.match(argsMatch[0], /choice === "3\.1"/);
  assert.match(argsMatch[0], /mode: "new"/);
  assert.match(argsMatch[0], /choice === "3\.2"/);
  assert.match(argsMatch[0], /choice === "3\.3"/);
  assert.match(argsMatch[0], /choice === "4\.1"/);
  assert.match(argsMatch[0], /printWosDataDbStatus\(activeWorkspace\)/);
  assert.match(argsMatch[0], /appendWosDataDbArg/);
  assert.match(argsMatch[0], /choice === "4\.2"/);
  assert.match(argsMatch[0], /Source SQLite database/);
  assert.match(argsMatch[0], /\["wosdata", "--merge-db", sourceDb, "--tasks-root", activeWorkspace\.tasksRoot\]/);
  assert.match(argsMatch[0], /choice === "4\.3"/);
  assert.match(argsMatch[0], /WOSID/);
  assert.match(argsMatch[0], /\["wosdata", "--wosid", wosid, "--tasks-root", activeWorkspace\.tasksRoot\]/);
  assert.match(argsMatch[0], /choice === "5\.1"/);
  assert.match(argsMatch[0], /helpers\.setPlaywrightVisible/);
  assert.match(argsMatch[0], /choice === "5\.2"/);
  assert.match(argsMatch[0], /helpers\.setParseConcurrency/);
  assert.match(argsMatch[0], /choice === "5\.3"/);
  assert.match(argsMatch[0], /choice === "5\.4"/);
  assert.match(argsMatch[0], /helpers\.addSids/);
  assert.doesNotMatch(argsMatch[0], /SQL SELECT query/);
  assert.match(argsMatch[0], /Force overwrite existing SQL rows/);
  assert.match(argsMatch[0], /choice === "2"/);
  assert.match(argsMatch[0], /CSV path, WOS URL, or UUID/);
  assert.match(argsMatch[0], /classifyWosIdsToSqlInput\(input\)/);
  assert.match(argsMatch[0], /\["parse", "--csv", parsed\.value, "--task", taskId, "--tasks-root", activeWorkspace\.tasksRoot\]/);
  assert.match(argsMatch[0], /"parse-pipeline"/);
  assert.doesNotMatch(argsMatch[0], /askParseOptions/);
  assert.doesNotMatch(argsMatch[0], /Change parse options/);
  assert.match(argsMatch[0], /choice === "1\.2" \? "bib"/);
});

test("interactive saved source only accepts WOS-like values", () => {
  assert.equal(isWosSourceLike("q"), false);
  assert.equal(isWosSourceLike("c"), false);
  assert.equal(isWosSourceLike("cancel"), false);
  assert.equal(isWosSourceLike("ofscience.com/wos/woscc/summary/01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc/date-descending/1"), true);
  assert.equal(isWosSourceLike("01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc"), true);
});

test("interactive WOS IDs to SQL input detects CSV or WOS source", () => {
  assert.deepEqual(classifyWosIdsToSqlInput("./input/wosids.csv"), {
    kind: "csv",
    value: "./input/wosids.csv",
  });
  assert.deepEqual(classifyWosIdsToSqlInput("01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc"), {
    kind: "wos-source",
    value: "01455913-d57e-4730-aa74-a3cbffe7014c-01b861c2bc",
  });
  assert.deepEqual(classifyWosIdsToSqlInput("not-a-source.txt"), {
    kind: "unknown",
    value: "not-a-source.txt",
  });
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
      sidCheck: { origin: "https://www.webofscience.com" },
    });
  } finally {
    process.stdout.write = originalWrite;
    process.stdout.columns = originalColumns;
  }

  assert.match(output, /Playwright\s+background/);
  assert.match(output, /Parse Tabs\s+1/);
  assert.match(output, /SID Value\s+current-sid/);
  assert.match(output, /SID Pool\s+2\/3/);
  assert.doesNotMatch(output, /Dead SIDs/);
  assert.match(output, /Profile\s+\.browser-profile/);
  assert.match(output, /Task ID\s+TID20260610120000/);
  assert.match(output, /WOS DB\s+none/);
  assert.match(output, /WOS IDs\s+0/);
  assert.match(output, /Blacklist DB\s+none/);
  assert.match(output, /Blacklist\s+0/);
  assert.match(output, /DB Size\s+0 B/);
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
  assert.equal(panelRows.length, 17);
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
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KiB");
});

test("uses one workspace-scoped WOS Playwright profile", () => {
  const root = temporaryDirectory();
  const dbPath = path.join(root, "global.sqlite");
  const blacklistDbPath = path.join(root, "blacklist.sqlite");
  cli.recordWosDataBlacklist({ dbPath, blacklistDbPath, wosid: "WOS:BAD", error: "No full-record JSON parsed" });
  const args = cli.parseArgs(["node", "cli", "workspace", "--tasks-root", root, "--db", dbPath, "--blacklist-db", blacklistDbPath]);
  assert.equal(cli.wosUserDataDir(args), path.join(root, ".browser-profile"));
  assert.equal(cli.wosProfileName(args), ".browser-profile");
  assert.equal(cli.wosBrowserMode(args), "background");

  const status = cli.workspaceStatus(args);
  assert.equal(status.wosProfileName, ".browser-profile");
  assert.equal(status.wosProfilePath, path.join(root, ".browser-profile"));
  assert.equal(status.wosBrowserMode, "background");
  assert.equal(typeof status.runtimeMs, "number");
  assert.ok(status.runtimeMs >= 0);
  assert.equal(status.wosDataDb.dbPath, dbPath);
  assert.equal(status.wosDataDb.blacklistDbPath, blacklistDbPath);
  assert.equal(status.wosDataDb.recordCount, 0);
  assert.equal(status.wosDataDb.blacklistCount, 1);
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

test("record extraction uses injected wos.js page parser", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/async function extractOneRecordInfo[\s\S]*?\n}\n\nasync function runPoolWithReusableRecordPages/);
  assert.ok(match, "extractOneRecordInfo source should be present");
  assert.match(match[0], /window\.wos\.record\.viewFullRecordByWosId\(targetWosId\)/);
  assert.match(match[0], /parseCurrentFullRecordPage\(targetWosId\)/);
  assert.match(match[0], /fetchFullRecordJsonByWosId\(targetWosId\)/);
  assert.match(match[0], /_parseMethod: parseMethod/);
  assert.match(match[0], /diagnostics\.join/);
  assert.doesNotMatch(match[0], /context\.newPage/);
  assert.match(source, /runPoolWithReusableRecordPages\(chunk, args\.concurrency/);
  assert.doesNotMatch(source, /EXTRACT_AUTHOR_INFO/);
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

test("browser-side wos.js does not let stale full-record DOM satisfy another WOSID", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "import", "wos.js"), "utf8");
  const waitMethod = source.match(/async #waitForFullRecordPageByWosId\(wosid\) \{[\s\S]*?\n    \}/);
  assert.ok(waitMethod, "full-record wait helper should be present");
  assert.match(waitMethod[0], /pageWosId && wosRecordIdsMatch\(expectedWosId, pageWosId\)/);
  assert.match(waitMethod[0], /!pageWosId && wosRecordIdsMatch\(expectedWosId, routeWosId\)/);
  assert.match(waitMethod[0], /throw new Error/);
});

test("parse workers reuse one WOS page per worker", async () => {
  const pages = [];
  const context = {
    async newPage() {
      const page = {
        id: pages.length + 1,
        closed: false,
        gotoCalls: 0,
        async goto() {
          this.gotoCalls += 1;
        },
        setDefaultTimeout() {},
        async evaluate(fn) {
          if (fn.toString().includes("Boolean(window.wos")) return true;
          return null;
        },
        isClosed() {
          return this.closed;
        },
        async close() {
          this.closed = true;
        },
      };
      pages.push(page);
      return page;
    },
  };
  const seen = [];

  await cli.runPoolWithReusableRecordPages(
    [1, 2, 3, 4],
    2,
    () => ({ session: { context }, generation: 1 }),
    { baseUrl: "https://www.webofscience.com", timeoutMs: 1000, recordTimeoutMs: 1000 },
    async (item, _index, page) => {
      seen.push([item, page.id]);
      await Promise.resolve();
    }
  );

  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((page) => page.gotoCalls), [1, 1]);
  assert.deepEqual(pages.map((page) => page.closed), [true, true]);
  assert.equal(seen.length, 4);
  assert.ok(new Set(seen.map(([, pageId]) => pageId)).size <= 2);
});

test("WOS data records import into global SQLite without raw TXT or BibTeX", () => {
  const root = temporaryDirectory();
  const dbPath = path.join(root, "global.sqlite");
  const result = seedWosDataRecord(dbPath, "record-source", {
    wosid: "WOS:ABC",
    title: "SQLite Record",
    source: { title: "Journal A", doi: "10.1000/demo", published: "2026" },
    url: "https://www.webofscience.com/wos/woscc/full-record/WOS:ABC",
    fetchedAt: "2026-06-10T00:00:00.000Z",
  });

  assert.equal(result.imported, 1);
  assert.equal(result.dbPath, dbPath);
  const db = new Database(result.dbPath, { readonly: true });
  try {
    assert.deepEqual(
      db.prepare("SELECT wosid, title, year, doi, source_title FROM wos_records").all(),
      [{ wosid: "WOS:ABC", title: "SQLite Record", year: 2026, doi: "10.1000/demo", source_title: "Journal A" }]
    );
    assert.deepEqual(
      db.prepare("SELECT wosid, task_id FROM wos_record_sources").all(),
      [{ wosid: "WOS:ABC", task_id: "record-source" }]
    );
  } finally {
    db.close();
  }
});

test("WOS data validation compares accession IDs without punctuation-only differences", () => {
  const root = temporaryDirectory();
  const dbPath = path.join(root, "global.sqlite");
  const result = seedWosDataRecord(dbPath, "punctuation", {
    wosid: "ALT:12345",
    title: "Equivalent ID",
  }, {
    expectedWosId: "ALT:123-45",
  });

  assert.equal(result.imported, 1);
  assert.equal(wosIdsEquivalent("ALT:123-45", "ALT12345"), true);
});

test("WOS data blacklist records parse-failed WOSIDs and can clear them", () => {
  const root = temporaryDirectory();
  const dbPath = path.join(root, "global.sqlite");
  const blacklistDbPath = path.join(root, "blacklist.sqlite");
  seedWosDataRecord(dbPath, "saved-record", {
    wosid: "WOS:OK",
    title: "Saved",
  });
  const first = cli.recordWosDataBlacklist({
    dbPath,
    blacklistDbPath,
    wosid: "WOS:BAD",
    taskId: "blacklist-task",
    source: "parse:blacklist-task",
    error: "No full-record JSON parsed for WOS:BAD",
  });
  assert.equal(first.wosid, "WOS:BAD");
  assert.equal(first.blacklistDbPath, blacklistDbPath);
  cli.recordWosDataBlacklist({
    dbPath,
    blacklistDbPath,
    wosid: "WOS:BAD",
    taskId: "blacklist-task",
    error: "No full-record JSON parsed for WOS:BAD",
  });

  assert.equal(fs.existsSync(dbPath), true);
  assert.equal(fs.existsSync(blacklistDbPath), true);
  assert.deepEqual([...existingWosDataBlacklistedIds({ blacklistDbPath }, ["WOS:BAD", "WOS:OK"])], ["WOS:BAD"]);
  const listed = cli.queryWosDataBlacklist({ dbPath, blacklistDbPath });
  assert.equal(listed.total, 1);
  assert.equal(listed.blacklistDbPath, blacklistDbPath);
  assert.equal(listed.stats.recordCount, 1);
  assert.equal(listed.stats.blacklistCount, 1);
  assert.equal(listed.rows[0].wosid, "WOS:BAD");
  assert.equal(listed.rows[0].failedCount, 2);

  const removed = cli.removeWosDataBlacklist({ dbPath, blacklistDbPath, wosid: "WOS:BAD" });
  assert.equal(removed.removed, 1);
  assert.equal(removed.stats.blacklistCount, 0);
  assert.equal(cli.queryWosDataBlacklist({ dbPath, blacklistDbPath }).total, 0);

  cli.recordWosDataBlacklist({
    dbPath,
    blacklistDbPath,
    wosid: "WOS:BAD",
    taskId: "blacklist-task",
    reason: "parse-failed",
    error: "Full record timeout after 20000ms: WOS:BAD",
  });
  const cleared = cli.clearWosDataBlacklist({ dbPath, blacklistDbPath });
  assert.equal(cleared.removed, 1);
  assert.equal(cleared.stats.blacklistCount, 0);
  assert.equal(cli.queryWosDataBlacklist({ dbPath, blacklistDbPath }).total, 0);
});

test("wosdata skips existing records by default and force overwrites them", () => {
  const root = temporaryDirectory();
  const dbPath = path.join(root, "global.sqlite");

  assert.equal(seedWosDataRecord(dbPath, "first", {
    wosid: "WOS:ABC",
    title: "Original Title",
  }).imported, 1);
  const skipped = seedWosDataRecord(dbPath, "second", {
    wosid: "WOS:ABC",
    title: "Updated Title",
  });
  assert.equal(skipped.imported, 0);
  assert.equal(skipped.skipped, 1);
  let db = new Database(dbPath, { readonly: true });
  try {
    assert.equal(db.prepare("SELECT title FROM wos_records WHERE wosid = 'WOS:ABC'").get().title, "Original Title");
  } finally {
    db.close();
  }

  const forced = seedWosDataRecord(dbPath, "second", {
    wosid: "WOS:ABC",
    title: "Updated Title",
  }, { force: true });
  assert.equal(forced.imported, 1);
  db = new Database(dbPath, { readonly: true });
  try {
    assert.equal(db.prepare("SELECT title FROM wos_records WHERE wosid = 'WOS:ABC'").get().title, "Updated Title");
  } finally {
    db.close();
  }
});

test("wosdata merges another SQLite database and preserves skip-by-default behavior", () => {
  const root = temporaryDirectory();
  const targetDb = path.join(root, "target.sqlite");
  const sourceDb = path.join(root, "source.sqlite");
  seedWosDataRecord(targetDb, "target", {
    wosid: "WOS:ABC",
    title: "Target Title",
  });
  seedWosDataRecord(sourceDb, "source", {
    wosid: "WOS:ABC",
    title: "Source Title",
  });
  seedWosDataRecord(sourceDb, "source", {
    wosid: "WOS:DEF",
    title: "Source Only",
  });

  const merged = cli.runWosDataImport(cli.parseArgs([
    "node", "cli", "wosdata", "--merge-db", sourceDb, "--db", targetDb, "--tasks-root", root,
  ]));
  assert.equal(merged.total, 2);
  assert.equal(merged.imported, 1);
  assert.equal(merged.skipped, 1);

  let db = new Database(targetDb, { readonly: true });
  try {
    assert.deepEqual(
      db.prepare("SELECT wosid, title FROM wos_records ORDER BY wosid").all(),
      [
        { wosid: "WOS:ABC", title: "Target Title" },
        { wosid: "WOS:DEF", title: "Source Only" },
      ]
    );
    assert.deepEqual(
      db.prepare("SELECT wosid, task_id FROM wos_record_sources ORDER BY wosid, task_id").all(),
      [
        { wosid: "WOS:ABC", task_id: "source" },
        { wosid: "WOS:ABC", task_id: "target" },
        { wosid: "WOS:DEF", task_id: "source" },
      ]
    );
  } finally {
    db.close();
  }

  const forced = cli.runWosDataImport(cli.parseArgs([
    "node", "cli", "wosdata", "--merge-db", sourceDb, "--db", targetDb, "--force", "--tasks-root", root,
  ]));
  assert.equal(forced.imported, 2);
  db = new Database(targetDb, { readonly: true });
  try {
    assert.equal(db.prepare("SELECT title FROM wos_records WHERE wosid = 'WOS:ABC'").get().title, "Source Title");
  } finally {
    db.close();
  }
});

test("wosdata query runs read-only SELECT statements", () => {
  const root = temporaryDirectory();
  const dbPath = path.join(root, "global.sqlite");
  seedWosDataRecord(dbPath, "query-source", {
    wosid: "WOS:ABC",
    title: "Queryable",
    source: { published: "2026" },
  });

  const wosidResult = cli.runWosDataImport(cli.parseArgs([
    "node", "cli", "wosdata", "--wosid", "WOS:ABC", "--db", dbPath, "--tasks-root", root,
  ]));
  assert.equal(wosidResult.found, true);
  assert.equal(wosidResult.row.wosid, "WOS:ABC");
  assert.equal(wosidResult.row.title, "Queryable");
  assert.equal(wosidResult.row.record.wosid, "WOS:ABC");

  const result = cli.runWosDataImport(cli.parseArgs([
    "node", "cli", "wosdata", "--query", "SELECT wosid, title, year FROM wos_records", "--db", dbPath, "--tasks-root", root,
  ]));
  assert.equal(result.rowCount, 1);
  assert.deepEqual(result.rows, [{ wosid: "WOS:ABC", title: "Queryable", year: 2026 }]);
  assert.throws(
    () => cli.runWosDataImport(cli.parseArgs([
      "node", "cli", "wosdata", "--query", "DELETE FROM wos_records", "--db", dbPath, "--tasks-root", root,
    ])),
    /Only SELECT queries are allowed/
  );
});

test("WOS data SQLite writes validate record shape before insert", () => {
  const root = temporaryDirectory();
  const dbPath = path.join(root, "global.sqlite");

  assert.throws(
    () => cli.importWosDataRecord({ dbPath, record: { title: "Missing WOSID" }, taskId: "bad" }),
    /Missing WOS ID/
  );
  assert.equal(fs.existsSync(dbPath), false);

  assert.throws(
    () => cli.importWosDataRecord({
      dbPath,
      record: { wosid: "WOS:OTHER" },
      taskId: "bad",
      expectedWosId: "WOS:EXPECTED",
    }),
    /WOS data record mismatch/
  );
});

test("parse command skips WOS IDs already present in the global SQLite database", async () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const dbPath = path.join(root, "global.sqlite");
  const csvPath = path.join(root, "input.csv");
  seedWosDataRecord(dbPath, "seed", {
    wosid: "WOS:GLOBAL",
    title: "Global Cache Record",
    source: { title: "Shared Journal", published: "2026" },
  });
  fs.writeFileSync(csvPath, "wosid\nWOS:GLOBAL\n");
  const importArgs = cli.parseArgs([
    "node", "cli", "import", "--csv", csvPath, "--task", "global-skip", "--tasks-root", tasksRoot, "--db", dbPath,
  ]);
  cli.importWosIds(importArgs);

  const result = await cli.runParse(cli.parseArgs([
    "node", "cli", "parse", "--task", "global-skip", "--tasks-root", tasksRoot, "--db", dbPath,
  ]));

  assert.equal(result.selected, 0);
  assert.equal(result.completed, 1);
  assert.equal(result.sqlite.imported, 0);
  assert.equal(result.sqlite.sourceLinked, 1);
  assert.equal(fs.existsSync(path.join(tasksRoot, "global-skip", "raw", "wosdata", "WOS_GLOBAL.json")), false);
  const db = new Database(dbPath, { readonly: true });
  try {
    assert.deepEqual(
      db.prepare("SELECT wosid, task_id FROM wos_record_sources ORDER BY task_id").all(),
      [
        { wosid: "WOS:GLOBAL", task_id: "global-skip" },
        { wosid: "WOS:GLOBAL", task_id: "seed" },
      ]
    );
  } finally {
    db.close();
  }

  const forcedTaskResult = await cli.runParse(cli.parseArgs([
    "node", "cli", "parse", "--task", "global-skip", "--tasks-root", tasksRoot, "--db", dbPath, "--force",
  ]));
  assert.equal(forcedTaskResult.selected, 0);
  assert.equal(forcedTaskResult.completed, 1);
  assert.equal(forcedTaskResult.failed, 0);
});

test("parse command skips blacklisted WOS IDs unless retry is requested", async () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const dbPath = path.join(root, "global.sqlite");
  const blacklistDbPath = path.join(root, "blacklist.sqlite");
  const csvPath = path.join(root, "input.csv");
  fs.writeFileSync(csvPath, "wosid\nWOS:BAD\n");
  cli.recordWosDataBlacklist({
    dbPath,
    blacklistDbPath,
    wosid: "WOS:BAD",
    taskId: "prior-task",
    error: "No full-record JSON parsed for WOS:BAD",
  });
  cli.importWosIds(cli.parseArgs([
    "node", "cli", "import", "--csv", csvPath, "--task", "blacklist-skip", "--tasks-root", tasksRoot, "--db", dbPath, "--blacklist-db", blacklistDbPath,
  ]));

  const result = await cli.runParse(cli.parseArgs([
    "node", "cli", "parse", "--task", "blacklist-skip", "--tasks-root", tasksRoot, "--db", dbPath, "--blacklist-db", blacklistDbPath,
  ]));

  assert.equal(result.selected, 0);
  assert.equal(result.completed, 0);
  assert.equal(result.skippedBlacklist, 1);
  assert.equal(result.blacklisted, 1);
  assert.equal(result.failed, 0);
  assert.equal(cli.parseArgs([
    "node", "cli", "parse", "--task", "blacklist-skip", "--retry-blacklist", "--tasks-root", tasksRoot, "--db", dbPath, "--blacklist-db", blacklistDbPath,
  ]).retryBlacklist, true);
});

test("parse command accepts a local WOSID CSV directly", async () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const dbPath = path.join(root, "global.sqlite");
  const csvPath = path.join(root, "input.csv");
  fs.writeFileSync(csvPath, "UT\nWOS:CSV001\n");
  const args = cli.parseArgs([
    "node", "cli", "parse", "--csv", csvPath, "--task", "csv-parse", "--tasks-root", tasksRoot, "--db", dbPath,
  ]);
  seedWosDataRecord(dbPath, "seed", {
    wosid: "WOS:CSV001",
    identifiers: { accessionNumber: "WOS:CSV001" },
  });

  const originalLog = console.log;
  const originalError = console.error;
  let output = "";
  const errors = [];
  console.log = (value = "") => {
    output += `${value}\n`;
  };
  console.error = (message = "") => {
    errors.push(String(message));
  };
  try {
    const exitCode = await cli.executeCommand(args);
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(output.trim(), dbPath);
  assert.equal(
    fs.readFileSync(path.join(tasksRoot, "csv-parse", "raw", "csv-parse", "full-record", "csv-parse_wosid.csv"), "utf8").trim(),
    "wosid\nWOS:CSV001"
  );
  assert.ok(errors.join("\n").includes("  skipped             1"));
  assert.ok(errors.join("\n").includes("  dbBlacklist         "));
  assert.equal(cli.readTaskIndex(tasksRoot).tasks[0].status, "parse-completed");
  assert.equal(fs.existsSync(path.join(tasksRoot, "csv-parse", "raw", "wosdata")), false);
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
  assert.match(match[0], /exportBibBatchesViaWosJs/);
  assert.doesNotMatch(source, /api\/wosnx\/indic\/export\/saveToFile/);
  assert.doesNotMatch(source, /action:\s*["']saveTo(?:Bibtex|FieldTagged)["']/);
});

test("generates alphanumeric TID timestamp task IDs", () => {
  const taskId = cli.makeTaskId(new Date(2026, 5, 9, 20, 30, 40));
  assert.equal(taskId, "TID20260609203040");
  assert.match(cli.parseArgs(["node", "cli", "run", "--uuid", "abc"]).taskId, /^TID\d{14}$/);
  assert.match(cli.parseArgs(["node", "cli", "parse", "--csv", "wosids.csv"]).taskId, /^TID\d{14}$/);
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
  assert.equal(fs.existsSync(path.join(taskDir, "manifest.json")), true);
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
  assert.match(result.stdout, /Usage:\s+iiaide-wos menu/);
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
  assert.equal(status.sid, "legacy");
  assert.equal(status.sidPoolCount, 5);
  assert.equal(status.sidPoolIndex, 1);
  assert.equal(status.playwrightVisible, true);
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

  assert.equal(status.sid, "one");
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
  const result = await cli.checkSid(args, {
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
  assert.match(messages.join("\n"), /Opening a WOS browser login/);
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
  const rows = cli.parseExportText("UT WOS:ABC\nUT: WOS:DEF\nUT ALT:12-34\nUT WOS:ABC\n", 1, 4);
  assert.deepEqual(rows.map((row) => row.wosid), ["WOS:ABC", "WOS:DEF", "ALT:1234"]);
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
  const firstRawDir = path.join(paths.rawRoot, "first", "full-record");
  const otherRawDir = path.join(paths.rawRoot, "other", "full-record");
  fs.mkdirSync(firstRawDir, { recursive: true });
  fs.mkdirSync(otherRawDir, { recursive: true });
  fs.writeFileSync(path.join(firstRawDir, "first_1_2.txt"), "UT WOS:A\nUT WOS:B\n");
  fs.writeFileSync(path.join(otherRawDir, "other_1_1.txt"), "UT WOS:OTHER\n");
  assert.deepEqual(cli.rawBatchFiles(paths, "first"), ["first_1_2.txt"]);
  assert.deepEqual(cli.parseExistingRawBatches(paths, "first").map((row) => row.wosid), ["WOS:A", "WOS:B"]);

  fs.writeFileSync(path.join(firstRawDir, "first_2_3.txt"), "UT WOS:C\n");
  assert.throws(() => cli.parseExistingRawBatches(paths, "first"), /Non-contiguous raw batches/);
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

  assert.equal(output.trim(), path.join(tasksRoot, "imported", "raw", "imported", "full-record", "imported_wosid.csv"));
  assert.doesNotMatch(output, /"ok"|"wosidsCsv"/);
});

test("clear removes a managed task directory and refreshes latest", async () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const oldDir = path.join(tasksRoot, "old-task");
  const nextDir = path.join(tasksRoot, "next-task");
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(nextDir, { recursive: true });
  writeJson(path.join(oldDir, "manifest.json"), { command: "iiaide-wos" });
  writeJson(path.join(nextDir, "manifest.json"), { command: "iiaide-wos" });
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
  writeJson(path.join(taskDir, "manifest.json"), { command: "iiaide-wos" });
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
  writeJson(path.join(taskDir, "manifest.json"), { command: "iiaide-wos" });
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
  const queryBibDir = path.join(paths.rawRoot, "query", "bib");
  fs.mkdirSync(queryBibDir, { recursive: true });
  fs.mkdirSync(paths.bibExportDir, { recursive: true });
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [{ taskId: "bib-task", taskDir: "bib-task", uuid: "query" }],
  });
  writeJson(paths.manifest, { command: "iiaide-wos", operation: "bib" });
  writeJson(paths.summary, {
    method: "wos-js-export-fetchBibBatches",
    taskId: "bib-task",
    uuid: "query",
    expectedCount: 2,
    batchCount: 1,
  });
  fs.writeFileSync(path.join(queryBibDir, "query_1_2.bib"), "@article{demo}\n");
  fs.writeFileSync(path.join(paths.bibExportDir, "query.bib"), "@article{demo}\n");

  const result = cli.validateTask(cli.parseArgs([
    "node", "cli", "validate", "--task", "bib-task", "--tasks-root", tasksRoot,
  ]));

  assert.equal(result.ok, true);
  assert.equal(result.bibBatches, 1);
  assert.equal(result.bibFile, path.join(paths.bibExportDir, "query.bib"));
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
  writeJson(paths.manifest, { command: "iiaide-wos" });

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
  assert.equal(readJson(path.join(args.outDir, "manifest.json")).args.sid, "[redacted]");
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
  writeJson(path.join(taskDir, "manifest.json"), { command: "iiaide-wos" });
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
    "--tasks-root", tasksRoot, "--reuse-raw", "--force",
  ]);
  const paths = cli.getRunPaths(args.outDir);
  const queryPaths = cli.withRawSource(paths, "query");
  const queryRawDir = path.join(paths.rawRoot, "query", "full-record");
  fs.mkdirSync(queryRawDir, { recursive: true });
  writeJson(paths.summary, { expectedCount: 2, rowText: "2 results", summaryHref: args.url });
  fs.writeFileSync(path.join(queryRawDir, "query_1_2.txt"), "UT WOS:A\nUT WOS:B\n");

  const result = await cli.run(args);
  assert.equal(result.ok, true);
  assert.equal(result.expectedCount, 2);
  assert.equal(result.uniqueCount, 2);
  assert.equal(result.files.wosidsCsv, path.join(queryPaths.wosIdsDir, "query_wosid.csv"));
  assert.deepEqual(cli.readWosIdsCsv(result.files.wosidsCsv), ["WOS:A", "WOS:B"]);
  assert.equal(fs.existsSync(path.join(queryPaths.wosIdsDir, "wosids_detailed.csv")), false);
  assert.equal(fs.existsSync(path.join(queryPaths.wosIdsDir, "wosids.json")), false);
  assert.equal(fs.existsSync(path.join(queryPaths.wosIdsDir, "full_records.txt")), false);
  assert.equal(cli.readTaskIndex(tasksRoot).tasks[0].taskDir, "reuse");
});

test("tasks can append a different UUID without force", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "run", "--uuid", "new-query", "--task", "multi-uuid",
    "--tasks-root", tasksRoot, "--reuse-raw",
  ]);
  const paths = cli.getRunPaths(args.outDir);
  const oldPaths = cli.withRawSource(paths, "old-query");
  const newPaths = cli.withRawSource(paths, "new-query");
  const oldRawDir = path.join(paths.rawRoot, "old-query", "full-record");
  const newRawDir = path.join(paths.rawRoot, "new-query", "full-record");
  fs.mkdirSync(oldRawDir, { recursive: true });
  fs.mkdirSync(newRawDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeJson(paths.manifest, { command: "iiaide-wos" });
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

  const result = await cli.run(args);

  assert.equal(result.uuid, "new-query");
  assert.equal(result.expectedCount, 1);
  assert.equal(result.uniqueCount, 1);
  assert.deepEqual(cli.readWosIdsCsv(result.files.wosidsCsv), ["WOS:NEW"]);
  assert.equal(result.files.wosidsCsv, path.join(newPaths.wosIdsDir, "new-query_wosid.csv"));
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
  const queryRawDir = path.join(paths.rawRoot, "query", "full-record");
  fs.mkdirSync(queryRawDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeJson(paths.manifest, { command: "iiaide-wos" });
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchTxtBatches",
    taskId: "repair-run",
    uuid: "query",
    expectedCount: 2,
    uniqueCount: 2,
    summaryHref: args.url,
    files: { wosidsCsv: path.join(queryPaths.wosIdsDir, "query_wosid.csv") },
  });
  fs.writeFileSync(path.join(queryRawDir, "query_1_2.txt"), "UT WOS:A\nUT WOS:B\n");

  const result = await cli.run(args);

  assert.equal(result.ok, true);
  assert.equal(result.files.wosidsCsv, path.join(queryPaths.wosIdsDir, "query_wosid.csv"));
  assert.deepEqual(cli.readWosIdsCsv(result.files.wosidsCsv), ["WOS:A", "WOS:B"]);
});

test("completed WOS ID task is reused without refetching", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "run", "--uuid", "query", "--task", "complete-run",
    "--tasks-root", tasksRoot,
  ]);
  const paths = cli.withRawSource(cli.getRunPaths(args.outDir), "query");
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeJson(paths.manifest, { command: "iiaide-wos" });
  const csvPath = path.join(paths.dataDir, "query_wosid.csv");
  fs.writeFileSync(csvPath, "wosid\nWOS:A\n");
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchTxtBatches",
    taskId: "complete-run",
    uuid: "query",
    expectedCount: 1,
    uniqueCount: 1,
    files: { wosidsCsv: csvPath },
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

  assert.equal(result.files.wosidsCsv, csvPath);
  assert.equal(result.uuid, "query");
  assert.deepEqual(errors, ["WOS ID CSV already exists; skipping download."]);
});

test("completed WOS ID command returns before SID preparation", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "run", "--uuid", "query", "--task", "complete-command",
    "--tasks-root", tasksRoot,
  ]);
  const paths = cli.withRawSource(cli.getRunPaths(args.outDir), "query");
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeJson(paths.manifest, { command: "iiaide-wos" });
  const csvPath = path.join(paths.dataDir, "query_wosid.csv");
  fs.writeFileSync(csvPath, "wosid\nWOS:A\n");
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchTxtBatches",
    taskId: "complete-command",
    uuid: "query",
    expectedCount: 1,
    uniqueCount: 1,
    files: { wosidsCsv: csvPath },
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

  assert.equal(output.trim(), csvPath);
  assert.deepEqual(errors, ["WOS ID CSV already exists; skipping download."]);
});

test("completed BibTeX task is reused without refetching", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "bib", "--uuid", "query", "--task", "complete-bib",
    "--tasks-root", tasksRoot,
  ]);
  const paths = cli.withRawSource(cli.getRunPaths(args.outDir), "query");
  fs.mkdirSync(paths.bibExportDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeJson(paths.manifest, { command: "iiaide-wos", operation: "bib" });
  const bibPath = path.join(paths.bibExportDir, "query.bib");
  fs.writeFileSync(bibPath, "@article{demo}\n");
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchBibBatches",
    taskId: "complete-bib",
    uuid: "query",
    expectedCount: 1,
    files: { bibFile: bibPath },
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

  assert.equal(result.files.bibFile, bibPath);
  assert.equal(result.uuid, "query");
  assert.deepEqual(errors, ["BibTeX already exists; skipping download."]);
});

test("missing combined BibTeX export is rebuilt from existing raw batches", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "bib", "--uuid", "query", "--task", "repair-bib",
    "--tasks-root", tasksRoot,
  ]);
  const paths = cli.getRunPaths(args.outDir);
  const queryPaths = cli.withRawSource(paths, "query");
  const queryBibDir = path.join(paths.rawRoot, "query", "bib");
  fs.mkdirSync(queryBibDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeJson(paths.manifest, { command: "iiaide-wos", operation: "bib" });
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchBibBatches",
    taskId: "repair-bib",
    uuid: "query",
    expectedCount: 1,
    files: { bibFile: path.join(queryPaths.bibExportDir, "query.bib") },
  });
  fs.writeFileSync(path.join(queryBibDir, "query_1_1.bib"), "@article{demo,\n  title={Demo}\n}\n");

  const result = await cli.runBib(args);

  assert.equal(result.files.bibFile, path.join(queryPaths.bibExportDir, "query.bib"));
  assert.equal(fs.readFileSync(result.files.bibFile, "utf8"), "@article{demo,\n  title={Demo}\n}\n");
});

test("completed BibTeX command returns before SID preparation", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "bib", "--uuid", "query", "--task", "complete-bib-command",
    "--tasks-root", tasksRoot,
  ]);
  const paths = cli.withRawSource(cli.getRunPaths(args.outDir), "query");
  fs.mkdirSync(paths.bibExportDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeJson(paths.manifest, { command: "iiaide-wos", operation: "bib" });
  const bibPath = path.join(paths.bibExportDir, "query.bib");
  fs.writeFileSync(bibPath, "@article{demo}\n");
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchBibBatches",
    taskId: "complete-bib-command",
    uuid: "query",
    expectedCount: 1,
    files: { bibFile: bibPath },
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

  assert.equal(output.trim(), bibPath);
  assert.deepEqual(errors, ["BibTeX already exists; skipping download."]);
});

test("managed current task placeholder can be reused without force", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "run", "--uuid", "query", "--task", "current",
    "--tasks-root", tasksRoot, "--reuse-raw",
  ]);
  const paths = cli.getRunPaths(args.outDir);
  const queryPaths = cli.withRawSource(paths, "query");
  const queryRawDir = path.join(paths.rawRoot, "query", "full-record");
  fs.mkdirSync(queryRawDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeJson(paths.manifest, { command: "iiaide-wos", operation: "current-task" });
  writeJson(paths.summary, { expectedCount: 1, rowText: "1 result", summaryHref: args.url });
  fs.writeFileSync(path.join(queryRawDir, "query_1_1.txt"), "UT WOS:A\n");

  const result = await cli.run(args);

  assert.equal(result.ok, true);
  assert.equal(result.files.wosidsCsv, path.join(queryPaths.wosIdsDir, "query_wosid.csv"));
});

test("reuse-raw refuses partial batches without marking complete", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "run", "--uuid", "query", "--task", "partial-raw",
    "--tasks-root", tasksRoot, "--reuse-raw",
  ]);
  const paths = cli.getRunPaths(args.outDir);
  const queryPaths = cli.withRawSource(paths, "query");
  const queryRawDir = path.join(paths.rawRoot, "query", "full-record");
  fs.mkdirSync(queryRawDir, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });
  writeJson(paths.manifest, { command: "iiaide-wos" });
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
  assert.match(match[0], /downloadedEntries < selectedCount/);
  assert.match(match[0], /Incomplete BibTeX export/);
  assert.match(match[0], /throw new Error/);
});

test("failed runs are recorded as failed", () => {
  const tasksRoot = temporaryDirectory();
  const taskDir = path.join(tasksRoot, "broken");
  const rawDir = path.join(taskDir, "raw", "query", "full-record");
  fs.mkdirSync(rawDir, { recursive: true });
  writeJson(path.join(taskDir, "summary.json"), { expectedCount: 3 });
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
  assert.match(task.lastError, /Non-contiguous raw batches/);
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
  const match = source.match(/const result = \[command[\s\S]*?return result;/);
  const branch = source.match(/let selection = currentTaskSelection[\s\S]*?return result;/);
  assert.ok(match, "interactive command result source should be present");
  assert.ok(branch, "interactive download branch should be present");
  assert.doesNotMatch(match[0], /"--force"/);
  assert.match(match[0], /"--reuse-raw"/);
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

test("interactive workflow does not print saved SID noise", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "interactive.js"), "utf8");
  assert.doesNotMatch(source, /saved SID will be used/);
  assert.match(source, /workspaceSidStatus/);
});

test("interactive startup does not force SID setup before workflow selection", () => {
  const interactiveSource = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "interactive.js"), "utf8");
  const startupBranch = interactiveSource.match(/const generatedTaskId = helpers\.makeTaskId[\s\S]*?const choice = await askWorkflow\(rl\)/);
  assert.ok(startupBranch, "interactive startup branch should be present");
  assert.doesNotMatch(startupBranch[0], /askSidFromBrowserOrManual/);
  assert.doesNotMatch(startupBranch[0], /helpers\.saveSid/);
});

test("interactive WOS workflows set up SID on demand and continue current flow", () => {
  const interactiveSource = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "interactive.js"), "utf8");
  const menuSource = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const sidBranch = interactiveSource.match(/let sid = ""[\s\S]*?const sourceFallback/);
  const helperBranch = menuSource.match(/async saveSid\(sid\)[\s\S]*?setCurrentTask/);
  assert.ok(sidBranch, "interactive on-demand SID branch should be present");
  assert.ok(helperBranch, "interactive saveSid helper should be present");
  assert.match(sidBranch[0], /helpers\.saveSid/);
  assert.match(sidBranch[0], /workspaceSidStatus\(activeWorkspace\) !== "valid"/);
  assert.match(sidBranch[0], /askSidFromBrowserOrManual/);
  assert.match(sidBranch[0], /saved\./);
  assert.doesNotMatch(sidBranch[0], /Refreshing workspace panel/);
  assert.doesNotMatch(sidBranch[0], /saved[\s\S]*?return \{ refresh: true \}/);
  assert.match(helperBranch[0], /addSidsToConfig\(menuArgs, \[sid\], \{ activate: true \}\)/);
  assert.match(helperBranch[0], /quickValidateSid\(menuArgs\)/);
  assert.match(helperBranch[0], /workspaceStatus\(menuArgs, refreshedSidCheck\)/);
});

test("interactive parse restart resumes the selected command instead of menu", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/const args = parseArgs\(\[argv\[0\], argv\[1\], \.\.\.selectedArgs\]\);[\s\S]*?const exitCode = await runParsedCommand\(args, \{ argv: \[argv\[0\], argv\[1\], \.\.\.selectedArgs\] \}\);/);
  assert.ok(match, "interactive selected command execution should be present");
  assert.match(match[0], /runParsedCommand\(args, \{ argv: \[argv\[0\], argv\[1\], \.\.\.selectedArgs\] \}\)/);
});

test("interactive startup no longer auto-opens a browser when SID is invalid", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/async function runInteractiveMenu[\s\S]*?\n}\n\nasync function main/);
  assert.ok(match, "runInteractiveMenu source should be present");
  assert.match(match[0], /const sidCheck = await quickValidateSid\(menuArgs\)/);
  assert.doesNotMatch(match[0], /prepareWosSession\(menuArgs, \{ keepAlive: true, visible: true \}\)/);
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
