const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const cli = require("../src/iiaide-wos");
const { readJson, writeJson } = require("../src/lib/io");
const { authorOptionsToArgs, currentTaskSelection, formatAuthorOptions, formatRuntime, isWosSourceLike, listTaskHints, printHeader, resolveTaskSelection, taskPromptHelp, taskSelectionHint } = require("../src/lib/interactive");
const { createProgress, createSpinner } = require("../src/lib/terminal");
const { normalizeBatchResult } = require("../src/lib/wos-browser-export");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "iiaide-wos-test-"));
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

test("parses SID check tasks", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "check", "--tasks-root", root]);
  assert.equal(args.command, "check");
  assert.equal(args.tasksRoot, root);
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

test("calculates bounded WOS record ranges before download confirmation", () => {
  assert.equal(cli.boundedRecordCount(800, 1, 0), 800);
  assert.equal(cli.boundedRecordCount(800, 1, 200), 200);
  assert.equal(cli.boundedRecordCount(800, 201, 200), 200);
  assert.equal(cli.boundedRecordCount(800, 701, 200), 100);
  assert.equal(cli.boundedRecordCount(800, 900, 200), 0);
});

test("author worker pool honors configured concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  await cli.runPool([1, 2, 3, 4, 5, 6], 3, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  });

  assert.equal(maxActive, 3);
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

  const back = resolveTaskSelection(workspace, "c", "second", "TID20260610120000");
  assert.equal(back.back, true);
  assert.equal(back.taskId, "");

  const quit = resolveTaskSelection(workspace, "q", "second", "TID20260610120000");
  assert.equal(quit.quit, true);
  assert.equal(quit.taskId, "");
});

test("interactive task prompt copy separates resume/create from clear", () => {
  assert.equal(
    taskPromptHelp("new", "TID20260610120000", "TID20260610120000", 2),
    "Enter creates TID20260610120000; type a custom task id; c goes back; q quits"
  );
  assert.equal(
    taskPromptHelp("any", "latest-task", "TID20260610120000", 2),
    "Enter keeps latest-task; type 1-2 to switch; type new to create TID20260610120000; type a custom task id; c goes back; q quits"
  );
  assert.equal(
    taskPromptHelp("existing", "latest-task", "TID20260610120000", 2),
    "Enter keeps latest-task; type 1-2 to select an existing task; type an exact task id; c goes back; q quits"
  );
  assert.equal(
    taskSelectionHint("any", "latest-task", "TID20260610120000", 2),
    [
      "  Enter  keep latest-task",
      "  1-2    switch to a listed task",
      "  new    create TID20260610120000",
      "  custom type a custom task id",
      "  c      back",
      "  q      quit",
    ].join("\n")
  );
  assert.equal(
    taskSelectionHint("new", "TID20260610120000", "TID20260610120000", 2),
    [
      "  Enter  create TID20260610120000",
      "  custom type a custom task id",
      "  c      back",
      "  q      quit",
    ].join("\n")
  );
  assert.equal(
    taskSelectionHint("existing", "latest-task", "TID20260610120000", 2),
    [
      "  Enter  keep latest-task",
      "  1-2    select an existing task",
      "  custom type an exact task id",
      "  c      back",
      "  q      quit",
    ].join("\n")
  );
});

test("interactive workflow menu uses folded command groups", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "interactive.js"), "utf8");
  const workflowMatch = source.match(/async function askWorkflow[\s\S]*?\n}\n\nasync function promptSid/);
  const argsMatch = source.match(/const choice = await askWorkflow[\s\S]*?return result;/);
  assert.ok(workflowMatch, "askWorkflow source should be present");
  assert.ok(argsMatch, "interactiveArgs workflow branch should be present");
  assert.match(workflowMatch[0], /Authentication/);
  assert.match(workflowMatch[0], /0\.1", "Check SID/);
  assert.match(workflowMatch[0], /Download literature/);
  assert.match(workflowMatch[0], /1\.1", "UUID - TXT format/);
  assert.match(workflowMatch[0], /1\.2", "UUID - BIB format/);
  assert.match(workflowMatch[0], /2\.1", "Author & address/);
  assert.match(workflowMatch[0], /3\.1", "New/);
  assert.match(workflowMatch[0], /3\.2", "Switch/);
  assert.match(workflowMatch[0], /3\.3", "Clear/);
  assert.match(workflowMatch[0], /choose 0\.1, 1\.1, 1\.2, 2\.1, 3\.1, 3\.2, 3\.3/);
  assert.doesNotMatch(workflowMatch[0], /Download WOS IDs/);
  assert.match(argsMatch[0], /choice === "0\.1"/);
  assert.match(argsMatch[0], /return \["check", "--tasks-root", activeWorkspace\.tasksRoot\]/);
  assert.match(argsMatch[0], /choice === "3\.1"/);
  assert.match(argsMatch[0], /mode: "new"/);
  assert.match(argsMatch[0], /choice === "3\.2"/);
  assert.match(argsMatch[0], /choice === "3\.3"/);
  assert.match(argsMatch[0], /choice === "2\.1" \? "pipeline"/);
  assert.match(argsMatch[0], /choice === "1\.2" \? "bib"/);
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

test("interactive author options can stay default or become command args", () => {
  assert.equal(
    formatAuthorOptions(),
    "concurrency=1 | timeout=20000ms | cooldown=250ms | failCool=20/60000ms | from=1 | limit=all | retryFailed=no | failedOnly=no"
  );
  assert.deepEqual(authorOptionsToArgs({
    concurrency: 4,
    authorTimeoutMs: 15000,
    cooldownMs: 800,
    failureCooldownThreshold: 7,
    failureCooldownMs: 120000,
    fromIndex: 11,
    limit: 50,
    retryFailed: true,
    failedOnly: true,
  }), [
    "--concurrency", "4",
    "--author-timeout-ms", "15000",
    "--cooldown-ms", "800",
    "--failure-cooldown-threshold", "7",
    "--failure-cooldown-ms", "120000",
    "--from-index", "11",
    "--limit", "50",
    "--retry-failed",
    "--failed-only",
  ]);
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
      sidCheck: { origin: "https://www.webofscience.com" },
    });
  } finally {
    process.stdout.write = originalWrite;
    process.stdout.columns = originalColumns;
  }

  assert.match(output, /Playwright\s+background/);
  assert.match(output, /Profile\s+\.browser-profile/);
  assert.match(output, /Task ID\s+TID20260610120000/);
  assert.doesNotMatch(output, /Tasks\s+\d+ tasks/);
  assert.match(output, /Runtime\s+1m 05s/);
  assert.match(output, /iiaide-wos CLI/);
  assert.match(output, /https:\/\/www\.webofscience\.com/);
  assert.doesNotMatch(output, /Origin\s+https:\/\/www\.webofscience\.com/);
  const titleLine = output.split(/\r?\n/).find((line) => line.includes("iiaide-wos CLI") && line.trim().startsWith("|"));
  const originLine = output.split(/\r?\n/).find((line) => line.includes("https://www.webofscience.com"));
  const authorLine = output.split(/\r?\n/).find((line) => line.includes("lyj"));
  const dateLine = output.split(/\r?\n/).find((line) => line.includes("2026-06-10"));
  assert.ok(titleLine);
  assert.ok(originLine);
  assert.ok(authorLine);
  assert.ok(dateLine);
  assert.ok(titleLine.indexOf("iiaide-wos CLI") > 8);
  assert.ok(originLine.indexOf("https://www.webofscience.com") > 8);
  assert.ok(authorLine.indexOf("lyj") > 8);
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
  assert.equal(panelRows.length, 9);
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

test("author extraction does not wait for networkidle before no-data detection", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/async function extractOneAuthorRecord[\s\S]*?\n}\n\nasync function runAuthors/);
  assert.ok(match, "extractOneAuthorRecord source should be present");
  assert.match(match[0], /waitUntil: "commit"/);
  assert.match(match[0], /pathname === "\/wos"/);
  assert.doesNotMatch(match[0], /networkidle/);
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
  assert.match(match[0], /confirmDownloadPlan/);
  assert.match(match[0], /batchSize = DEFAULT_BATCH_SIZE/);
  assert.match(match[0], /exportBibBatchesViaWosJs/);
  assert.doesNotMatch(source, /api\/wosnx\/indic\/export\/saveToFile/);
  assert.doesNotMatch(source, /action:\s*["']saveTo(?:Bibtex|FieldTagged)["']/);
});

test("WOS downloads use the shared persistent Playwright session helper", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const exportMatch = source.match(/async function exportFromWos[\s\S]*?\n}\n\nasync function exportBibFromWos/);
  const bibMatch = source.match(/async function exportBibFromWos[\s\S]*?\n}\n\nfunction combineBibFiles/);
  const authorsMatch = source.match(/async function runAuthors[\s\S]*?\n}\n\nfunction validateTask/);
  assert.ok(exportMatch, "exportFromWos source should be present");
  assert.ok(bibMatch, "exportBibFromWos source should be present");
  assert.ok(authorsMatch, "runAuthors source should be present");

  assert.match(exportMatch[0], /prepareWosSession/);
  assert.match(bibMatch[0], /prepareWosSession/);
  assert.match(authorsMatch[0], /prepareWosSession/);
  assert.match(source, /launchPersistentContext/);
  assert.match(source, /addInitScript/);
  assert.match(source, /addScriptTag/);
  assert.match(source, /window\.asy_uuid\.fetchCurrentPageInfo/);
  assert.match(exportMatch[0], /exportTxtBatchesViaWosJs/);
  assert.match(exportMatch[0], /confirmDownloadPlan/);
  assert.match(exportMatch[0], /batchSize = DEFAULT_BATCH_SIZE/);
  assert.match(bibMatch[0], /exportBibBatchesViaWosJs/);
  assert.doesNotMatch(source, /chromium\.launch\(/);
  assert.doesNotMatch(source, /\.newContext\(/);
  assert.match(source, /--window-position=/);
});

test("generates alphanumeric TID timestamp task IDs", () => {
  const taskId = cli.makeTaskId(new Date(2026, 5, 9, 20, 30, 40));
  assert.equal(taskId, "TID20260609203040");
  assert.match(cli.parseArgs(["node", "cli", "run", "--uuid", "abc"]).taskId, /^TID\d{14}$/);
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

test("SID preparation fails clearly outside an interactive terminal", async () => {
  const args = cli.parseArgs(["node", "cli", "sid", "--tasks-root", temporaryDirectory()]);
  await assert.rejects(
    () => cli.ensureSid(args, "SID", async () => "unused", () => false),
    /Pass --sid, set WOS_SID, or run: iiaide-wos sid/
  );
});

test("quick SID validation classifies lightweight WOS responses", async () => {
  const root = temporaryDirectory();
  writeJson(path.join(root, "config.json"), { sid: "saved-sid" });
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
  const page = {
    async goto() {},
    async waitForLoadState() {},
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
  assert.equal(readJson(path.join(root, "config.json")).sid, "fresh");
  assert.match(messages[0], /invalid or expired/);
});

test("parses and deduplicates WOS IDs from field-tagged text", () => {
  const rows = cli.parseExportText("UT WOS:ABC\nUT: WOS:DEF\nUT WOS:ABC\n", 1, 3);
  assert.deepEqual(rows.map((row) => row.wosid), ["WOS:ABC", "WOS:DEF"]);
});

test("reads WOS IDs from a named CSV column and deduplicates them", () => {
  const root = temporaryDirectory();
  const csvPath = path.join(root, "input.csv");
  fs.writeFileSync(csvPath, [
    "title,UT,notes",
    '"First, title",WOS:ABC,"quoted, note"',
    "Second,WOS:DEF,",
    "Duplicate,wos:abc,",
  ].join("\n"));

  assert.deepEqual(cli.readWosIdsCsv(csvPath), ["WOS:ABC", "WOS:DEF"]);
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

test("expands author address and affiliation hierarchy", () => {
  const rows = cli.flattenAuthorRows([{
    wosid: "WOS:ABC",
    authors: [{
      authorIndex: 1,
      displayName: "Author",
      addressDetails: [{
        addressNumber: "1",
        address: "Address",
        affiliations: [
          { affiliation: "One", rorId: "https://ror.org/1" },
          { affiliation: "Two", rorId: "https://ror.org/2" },
        ],
      }],
    }],
  }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.affiliation), ["One", "Two"]);
});

test("builds deduplicated simple author rows with address details only", () => {
  const rows = cli.simpleAuthorRows([
    {
      wosid: "WOS:ABC",
      authorIndex: 1,
      address: "Address",
      affiliation: "Affiliation",
      rorId: "https://ror.org/1",
      correspondingAddress: "",
      fullName: "Ignored",
    },
    {
      wosid: "WOS:ABC",
      authorIndex: 1,
      address: "Address",
      affiliation: "Affiliation",
      rorId: "https://ror.org/1",
      correspondingAddress: "",
    },
    {
      wosid: "WOS:DEF",
      authorIndex: 2,
      address: "",
      affiliation: "",
      rorId: "",
      correspondingAddress: "",
    },
    {
      wosid: "WOS:GHI",
      authorIndex: 3,
      address: "",
      affiliation: "",
      rorId: "",
      correspondingAddress: "Corresponding Address",
    },
  ]);

  assert.deepEqual(rows, [
    {
      wosid: "WOS:ABC",
      authorIndex: 1,
      address: "Address",
      affiliation: "Affiliation",
      rorId: "https://ror.org/1",
      correspondingAddress: "",
    },
    {
      wosid: "WOS:GHI",
      authorIndex: 3,
      address: "",
      affiliation: "",
      rorId: "",
      correspondingAddress: "Corresponding Address",
    },
  ]);
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

test("reads legacy raw batch directories for existing tasks", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  const legacyRawDir = path.join(paths.legacyFullRecordDir, "legacy");
  fs.mkdirSync(legacyRawDir, { recursive: true });
  fs.writeFileSync(path.join(legacyRawDir, "legacy_1_1.txt"), "UT WOS:OLD\n");

  assert.deepEqual(cli.rawBatchFiles(paths, "legacy"), ["legacy_1_1.txt"]);
  assert.deepEqual(cli.parseExistingRawBatches(paths, "legacy").map((row) => row.wosid), ["WOS:OLD"]);
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

  assert.equal(output.trim(), path.join(tasksRoot, "imported", "export", "imported", "full-record", "imported_wosid.csv"));
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

test("validate resolves portable relative author checkpoint paths", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const taskDir = path.join(tasksRoot, "portable");
  const paths = cli.withRawSource(cli.getRunPaths(taskDir), "portable");
  fs.mkdirSync(paths.dataDir, { recursive: true });
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [{ taskId: "portable", taskDir: "portable" }],
  });
  writeJson(paths.manifest, { command: "iiaide-wos" });
  writeJson(paths.summary, { method: "imported-wosid-csv", taskId: "portable", expectedCount: 1, uniqueCount: 1 });
  fs.writeFileSync(path.join(paths.dataDir, "portable_wosid.csv"), "wosid\nWOS:ABC\n");
  const portableAuthorRawDir = path.join(paths.rawRoot, "portable", "author");
  fs.mkdirSync(portableAuthorRawDir, { recursive: true });
  fs.writeFileSync(path.join(portableAuthorRawDir, "WOS_ABC.json"), JSON.stringify({ wosid: "WOS:ABC", authors: [] }));
  writeJson(paths.authorCheckpoint, {
    records: {
      "WOS:ABC": {
        status: "completed",
        wosid: "WOS:ABC",
        rawJsonPath: "raw/portable/author/WOS_ABC.json",
      },
    },
  });

  const result = cli.validateTask(cli.parseArgs([
    "node", "cli", "validate", "--task", "portable", "--tasks-root", tasksRoot,
  ]));
  assert.equal(result.ok, true);
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

test("completed author tasks finish locally without a SID", async () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const csvPath = path.join(root, "input.csv");
  fs.writeFileSync(csvPath, "wosid\nWOS:ABC\n");
  const importArgs = cli.parseArgs([
    "node", "cli", "import", "--csv", csvPath, "--task", "complete", "--tasks-root", tasksRoot,
  ]);
  cli.importWosIds(importArgs);
  const paths = cli.withRawSource(cli.getRunPaths(importArgs.outDir), "complete");
  const completeAuthorRawDir = path.join(paths.rawRoot, "complete", "author");
  writeJson(path.join(completeAuthorRawDir, "WOS_ABC.json"), { wosid: "WOS:ABC", authors: [] });
  writeJson(paths.authorCheckpoint, {
    total: 1,
    records: {
      "WOS:ABC": {
        status: "completed",
        wosid: "WOS:ABC",
        rawJsonPath: "raw/complete/author/WOS_ABC.json",
      },
    },
  });

  const result = await cli.runAuthors(cli.parseArgs([
    "node", "cli", "authors", "--task", "complete", "--tasks-root", tasksRoot,
  ]));

  assert.equal(result.selected, 0);
  assert.equal(result.completed, 1);
  assert.equal(fs.existsSync(path.join(paths.authorsDir, "normalized-json")), false);
  assert.equal(fs.existsSync(paths.authorsCsv), true);
  assert.equal(fs.existsSync(paths.authorsSimpleCsv), true);
  assert.equal(path.basename(result.authorsCsv), "complete_authors.csv");
  assert.equal(path.basename(result.authorsSimpleCsv), "complete_authors_simple.csv");
  assert.equal(cli.readTaskIndex(tasksRoot).tasks[0].status, "authors-completed");
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
  assert.equal(result.files.wosidsCsv, path.join(queryPaths.fullRecordExportDir, "query_wosid.csv"));
  assert.deepEqual(cli.readWosIdsCsv(result.files.wosidsCsv), ["WOS:A", "WOS:B"]);
  assert.equal(fs.existsSync(path.join(queryPaths.fullRecordExportDir, "wosids_detailed.csv")), false);
  assert.equal(fs.existsSync(path.join(queryPaths.fullRecordExportDir, "wosids.json")), false);
  assert.equal(fs.existsSync(path.join(queryPaths.fullRecordExportDir, "full_records.txt")), false);
  assert.equal(cli.readTaskIndex(tasksRoot).tasks[0].taskDir, "reuse");
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
  assert.equal(result.files.wosidsCsv, path.join(queryPaths.fullRecordExportDir, "query_wosid.csv"));
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
  assert.equal(fs.existsSync(path.join(queryPaths.fullRecordExportDir, "query_wosid.csv")), false);
});

test("BibTeX export refuses incomplete downloaded record counts", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const match = source.match(/async function exportBibFromWos[\s\S]*?\n}\n\nfunction combineBibFiles/);
  assert.ok(match, "exportBibFromWos source should be present");
  assert.match(match[0], /downloadedEntries < selectedCount/);
  assert.match(match[0], /Incomplete BibTeX export/);
  assert.match(match[0], /throw new Error/);
});

test("pipeline resumes from raw batches and completed author checkpoint", async () => {
  const tasksRoot = temporaryDirectory();
  const args = cli.parseArgs([
    "node", "cli", "pipeline", "--uuid", "query", "--task", "pipe",
    "--tasks-root", tasksRoot, "--reuse-raw", "--force",
  ]);
  const paths = cli.getRunPaths(args.outDir);
  const queryPaths = cli.withRawSource(paths, "query");
  const queryRawDir = path.join(paths.rawRoot, "query", "full-record");
  fs.mkdirSync(queryRawDir, { recursive: true });
  const queryAuthorRawDir = path.join(paths.rawRoot, "query", "author");
  fs.mkdirSync(queryAuthorRawDir, { recursive: true });
  fs.writeFileSync(path.join(queryRawDir, "query_1_1.txt"), "UT WOS:A\n");
  fs.writeFileSync(path.join(queryAuthorRawDir, "WOS_A.json"), JSON.stringify({ wosid: "WOS:A", authors: [] }));
  cli.writeJson(queryPaths.authorCheckpoint, {
    total: 1,
    records: {
      "WOS:A": {
        status: "completed",
        wosid: "WOS:A",
        rawJsonPath: "raw/query/author/WOS_A.json",
      },
    },
  });
  cli.writeJson(paths.summary, { expectedCount: 1, rowText: "1 result", summaryHref: args.url });

  const result = await cli.runPipeline(args);
  assert.equal(result.ok, true);
  assert.equal(result.run.uniqueCount, 1);
  assert.equal(result.authors.completed, 1);
  assert.equal(cli.readTaskIndex(tasksRoot).tasks[0].status, "authors-completed");
});

test("pipeline authors use completed run CSV instead of stale task UUID", async () => {
  const tasksRoot = temporaryDirectory();
  const uuid = "a6ddba9f-a966-4d12-89c9-df5f365e9f23-01b86b9549";
  const args = cli.parseArgs([
    "node", "cli", "pipeline", "--uuid", uuid, "--task", "stale",
    "--tasks-root", tasksRoot,
  ]);
  const paths = cli.getRunPaths(args.outDir);
  const uuidPaths = cli.withRawSource(paths, uuid);
  fs.mkdirSync(uuidPaths.dataDir, { recursive: true });
  const uuidAuthorRawDir = path.join(paths.rawRoot, uuid, "author");
  fs.mkdirSync(uuidAuthorRawDir, { recursive: true });
  writeJson(paths.manifest, { command: "iiaide-wos" });
  const csvPath = path.join(uuidPaths.dataDir, `${uuid}_wosid.csv`);
  fs.writeFileSync(csvPath, "wosid\nWOS:A\n");
  writeJson(paths.summary, {
    ok: true,
    method: "wos-js-export-fetchTxtBatches",
    taskId: "stale",
    uuid,
    expectedCount: 1,
    uniqueCount: 1,
    summaryHref: args.url,
    files: { wosidsCsv: csvPath },
  });
  fs.writeFileSync(path.join(uuidAuthorRawDir, "WOS_A.json"), JSON.stringify({ wosid: "WOS:A", authors: [] }));
  cli.writeJson(uuidPaths.authorCheckpoint, {
    total: 1,
    records: {
      "WOS:A": {
        status: "completed",
        wosid: "WOS:A",
        rawJsonPath: `raw/${uuid}/author/WOS_A.json`,
      },
    },
  });
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [{
      taskId: "stale",
      taskDir: "stale",
      uuid: "q",
      url: "q",
      status: "completed",
      expectedCount: 1,
      uniqueCount: 1,
    }],
  });
  fs.writeFileSync(path.join(tasksRoot, "latest"), "stale\n");

  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  let result;
  try {
    result = await cli.runPipeline(args);
  } finally {
    console.error = originalError;
  }

  assert.equal(result.ok, true);
  assert.equal(result.run.files.wosidsCsv, csvPath);
  assert.equal(result.authors.totalWosIds, 1);
  assert.equal(cli.readTaskIndex(tasksRoot).tasks[0].uuid, uuid);
  assert.deepEqual(errors, [
    "WOS ID CSV already exists; skipping download.",
    "Author records: total=1, completed=1, failed=0, selected=0, range=none, concurrency=1",
  ]);
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
  assert.match(promptMatch[0], /c back, q quit/);
  assert.match(promptMatch[0], /if \(!answer && fallback\) return fallback/);
  assert.match(promptMatch[0], /c goes back, q quits/);
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

test("interactive SID setup saves and refreshes the workspace panel", () => {
  const interactiveSource = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "interactive.js"), "utf8");
  const menuSource = fs.readFileSync(path.join(__dirname, "..", "src", "iiaide-wos.js"), "utf8");
  const sidBranch = interactiveSource.match(/const sidStatus = workspaceSidStatus\(activeWorkspace\)[\s\S]*?const choice = await askWorkflow/);
  const helperBranch = menuSource.match(/async saveSid\(sid\)[\s\S]*?setCurrentTask/);
  assert.ok(sidBranch, "interactive SID validation branch should be present");
  assert.ok(helperBranch, "interactive saveSid helper should be present");
  assert.match(sidBranch[0], /helpers\.saveSid/);
  assert.match(sidBranch[0], /sidStatus !== "valid"/);
  assert.match(sidBranch[0], /saved\. Refreshing workspace panel/);
  assert.match(sidBranch[0], /return \{ refresh: true \}/);
  assert.match(helperBranch[0], /saveSidConfig\(menuArgs, sid\)/);
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
