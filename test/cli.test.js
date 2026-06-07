const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const cli = require("../src/wos-export-wosids");
const { readJson, writeJson } = require("../src/lib/io");

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wos-export-test-"));
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
});

test("places named tasks inside tasks root", () => {
  const root = temporaryDirectory();
  const args = cli.parseArgs(["node", "cli", "run", "--uuid", "abc", "--task", "safe", "--tasks-root", root]);
  assert.equal(args.outDir, path.join(root, "safe"));
});

test("parses and deduplicates WOS IDs from field-tagged text", () => {
  const rows = cli.parseExportText("UT WOS:ABC\nUT: WOS:DEF\nUT WOS:ABC\n", 1, 3);
  assert.deepEqual(rows.map((row) => row.wosid), ["WOS:ABC", "WOS:DEF"]);
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

test("force cleanup preserves unrelated files in an output directory", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  fs.mkdirSync(paths.rawDir, { recursive: true });
  fs.mkdirSync(paths.authorsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.rawDir, "batch.txt"), "data");
  fs.writeFileSync(path.join(root, "keep-me.txt"), "user data");
  writeJson(paths.summary, { ok: true });
  writeJson(paths.manifest, { command: "wos-export-wosids" });

  cli.cleanRunLayout(paths, path.join(root, "other-tasks-root"));
  assert.equal(fs.existsSync(paths.rawDir), false);
  assert.equal(fs.existsSync(paths.authorsDir), false);
  assert.equal(fs.existsSync(paths.summary), false);
  assert.equal(fs.readFileSync(path.join(root, "keep-me.txt"), "utf8"), "user data");
});

test("force cleanup rejects an unmanaged custom output directory", () => {
  const root = temporaryDirectory();
  const paths = cli.getRunPaths(root);
  assert.throws(
    () => cli.cleanRunLayout(paths, path.join(root, "other-tasks-root")),
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
    path.join(__dirname, "..", "bin", "wos-export-wosids.js"),
    "run", "--sid", "unused", "--uuid", "query", "--task", "broken",
    "--tasks-root", tasksRoot, "--reuse-raw", "--force",
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  const task = cli.readTaskIndex(tasksRoot).tasks.find((item) => item.taskId === "broken");
  assert.equal(task.status, "failed");
  assert.match(task.lastError, /Overlapping raw batches/);
});
