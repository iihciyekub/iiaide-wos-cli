const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const cli = require("../src/wos-aide");
const { readJson, writeJson } = require("../src/lib/io");
const { createProgress, createSpinner } = require("../src/lib/terminal");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wos-aide-test-"));
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
    path.join(__dirname, "..", "bin", "wos-aide.js"),
    "import", "--csv", csvPath, "--task", "invalid", "--tasks-root", tasksRoot,
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(tasksRoot), false);
});

test("no-argument non-interactive invocation prints help without creating a workspace", () => {
  const root = temporaryDirectory();
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "wos-aide.js")], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:\s+wos-aide menu/);
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

test("SID preparation fails clearly outside an interactive terminal", async () => {
  const args = cli.parseArgs(["node", "cli", "sid", "--tasks-root", temporaryDirectory()]);
  await assert.rejects(
    () => cli.ensureSid(args, "SID", async () => "unused", () => false),
    /Pass --sid, set WOS_SID, or run: wos-aide sid/
  );
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
  fs.mkdirSync(paths.rawDir, { recursive: true });
  fs.writeFileSync(path.join(paths.rawDir, "first_1_2.txt"), "UT WOS:A\nUT WOS:B\n");
  fs.writeFileSync(path.join(paths.rawDir, "other_1_1.txt"), "UT WOS:OTHER\n");
  assert.deepEqual(cli.rawBatchFiles(paths, "first"), ["first_1_2.txt"]);
  assert.deepEqual(cli.parseExistingRawBatches(paths, "first").map((row) => row.wosid), ["WOS:A", "WOS:B"]);

  fs.writeFileSync(path.join(paths.rawDir, "first_2_3.txt"), "UT WOS:C\n");
  assert.throws(() => cli.parseExistingRawBatches(paths, "first"), /Overlapping raw batches/);
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

test("validate resolves portable relative author checkpoint paths", () => {
  const root = temporaryDirectory();
  const tasksRoot = path.join(root, "tasks");
  const taskDir = path.join(tasksRoot, "portable");
  const paths = cli.getRunPaths(taskDir);
  fs.mkdirSync(paths.authorRawJsonDir, { recursive: true });
  fs.mkdirSync(paths.authorNormalizedJsonDir, { recursive: true });
  fs.mkdirSync(paths.dataDir, { recursive: true });
  writeJson(path.join(tasksRoot, "index.json"), {
    version: 1,
    tasks: [{ taskId: "portable", taskDir: "portable" }],
  });
  writeJson(paths.manifest, { command: "wos-aide" });
  writeJson(paths.summary, { method: "imported-wosid-csv", expectedCount: 1, uniqueCount: 1 });
  fs.writeFileSync(paths.simpleCsv, "wosid\nWOS:ABC\n");
  fs.writeFileSync(path.join(paths.authorRawJsonDir, "WOS_ABC.json"), "{}");
  fs.writeFileSync(path.join(paths.authorNormalizedJsonDir, "WOS_ABC.json"), "{}");
  writeJson(paths.authorCheckpoint, {
    records: {
      "WOS:ABC": {
        status: "completed",
        wosid: "WOS:ABC",
        rawJsonPath: "authors/raw-json/WOS_ABC.json",
        normalizedJsonPath: "authors/normalized-json/WOS_ABC.json",
      },
    },
  });

  const result = cli.validateTask(cli.parseArgs([
    "node", "cli", "validate", "--task", "portable", "--tasks-root", tasksRoot,
  ]));
  assert.equal(result.ok, true);
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
  const paths = cli.getRunPaths(importArgs.outDir);
  writeJson(path.join(paths.authorNormalizedJsonDir, "WOS_ABC.json"), { wosid: "WOS:ABC", authors: [] });
  writeJson(paths.authorCheckpoint, {
    total: 1,
    records: {
      "WOS:ABC": {
        status: "completed",
        wosid: "WOS:ABC",
        rawJsonPath: "authors/raw-json/WOS_ABC.json",
        normalizedJsonPath: "authors/normalized-json/WOS_ABC.json",
      },
    },
  });

  const result = await cli.runAuthors(cli.parseArgs([
    "node", "cli", "authors", "--task", "complete", "--tasks-root", tasksRoot,
  ]));

  assert.equal(result.selected, 0);
  assert.equal(result.completed, 1);
  assert.equal(cli.readTaskIndex(tasksRoot).tasks[0].status, "authors-completed");
});

test("force cleanup preserves unrelated files in a managed output directory", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  fs.mkdirSync(paths.rawDir, { recursive: true });
  fs.mkdirSync(paths.authorsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.rawDir, "batch.txt"), "data");
  fs.writeFileSync(path.join(root, "keep-me.txt"), "user data");
  writeJson(paths.summary, { ok: true });
  writeJson(paths.manifest, { command: "wos-aide" });

  cli.cleanRunLayout(paths);
  assert.equal(fs.existsSync(paths.rawDir), false);
  assert.equal(fs.existsSync(paths.authorsDir), false);
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
  writeJson(path.join(taskDir, "manifest.json"), { command: "wos-aide" });
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
  fs.mkdirSync(paths.rawDir, { recursive: true });
  fs.mkdirSync(paths.dataDir, { recursive: true });
  writeJson(paths.summary, { expectedCount: 2, rowText: "2 results", summaryHref: args.url });
  fs.writeFileSync(path.join(paths.rawDir, "query_1_2.txt"), "UT WOS:A\nUT WOS:B\n");

  const result = await cli.run(args);
  assert.equal(result.ok, true);
  assert.equal(result.expectedCount, 2);
  assert.equal(result.uniqueCount, 2);
  assert.equal(cli.readTaskIndex(tasksRoot).tasks[0].taskDir, "reuse");
});

test("failed runs are recorded as failed", () => {
  const tasksRoot = temporaryDirectory();
  const taskDir = path.join(tasksRoot, "broken");
  const rawDir = path.join(taskDir, "raw", "full-record");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, "query_1_2.txt"), "UT WOS:A\n");
  fs.writeFileSync(path.join(rawDir, "query_2_3.txt"), "UT WOS:B\n");
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "..", "bin", "wos-aide.js"),
    "run", "--sid", "unused", "--uuid", "query", "--task", "broken",
    "--tasks-root", tasksRoot, "--reuse-raw", "--force",
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  const task = cli.readTaskIndex(tasksRoot).tasks.find((item) => item.taskId === "broken");
  assert.equal(task.status, "failed");
  assert.match(task.lastError, /Overlapping raw batches/);
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
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(output, /Checking auth\.\.\./);
  assert.match(output, /OK Auth ready/);
  assert.match(output, /Authors: 2\/2, 1 failed/);
  assert.doesNotMatch(output, /\x1b/);
});
