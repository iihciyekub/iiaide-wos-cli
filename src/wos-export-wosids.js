const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { readJson, writeFileAtomic, writeJson } = require("./lib/io");
const { version: VERSION } = require("../package.json");

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_BASE_URL = "https://www.webofscience.com";

function usage() {
  return `
Usage:
  wos-export-wosids run [--sid <SID>] (--url <summary-url> | --uuid <uuid>) [options]
  wos-export-wosids [--sid <SID>] (--url <summary-url> | --uuid <uuid>) [options]
  wos-export-wosids list [--tasks-root <dir>]
  wos-export-wosids show (--task <task-id> | --latest) [--tasks-root <dir>]
  wos-export-wosids path (--task <task-id> | --latest) [--tasks-root <dir>]
  wos-export-wosids validate (--task <task-id> | --latest) [--tasks-root <dir>]
  wos-export-wosids sid [--sid <SID>] [--tasks-root <dir>] [--base-url <url>] [--headed]
  wos-export-wosids authors [--sid <SID>] (--task <task-id> | --latest) [options]
  wos-export-wosids authors --rebuild-only (--task <task-id> | --latest) [--tasks-root <dir>]

Inputs:
  --sid <SID>             Web of Science SID. Valid SIDs are saved to ./tasks/config.json
  --url <summary-url>     WOS summary URL
  --uuid <uuid>           WOS result-set UUID; used when --url is not provided

Output management:
  --task <task-id>        Stable task id. If omitted, creates <timestamp>_<uuid-short>
  --task-label <label>    Human label stored in task metadata
  --tasks-root <dir>      Parent directory for tasks. Default: ./tasks
  --out-dir <dir>         Exact task directory override
  --force                 Allow writing into a non-empty --out-dir
  --reuse-raw             Rebuild CSV from existing raw batches when present

Export options:
  --sort-by <sort>        Summary sort key. Default: relevance
  --batch-size <n>        WOS export API batch size. Default: 200, max: 500
  --timeout-ms <n>        Navigation/API timeout. Default: 120000
  --base-url <url>        Default: https://www.webofscience.com
  --headed                Show browser instead of headless mode
  --version               Show CLI version
  --help                  Show this help

Author options:
  --concurrency <n>       Parallel full-record pages. Default: 2
  --limit <n>             Process only n WOS IDs
  --from-index <n>        Start from 1-based WOSID index
  --retry-failed          Retry failed WOS IDs
  --failed-only           Process only failed WOS IDs
  --rebuild-only          Rebuild normalized JSON and authors.csv/authors.jsonl from existing JSON only
  --cooldown-ms <n>       Delay after each record. Default: 250

Task directory layout:
  raw/full-record/        WOS fullRecord text batches downloaded from export API
  data/wosids.csv         One-column WOSID CSV
  data/wosids_detailed.csv
  data/wosids.json
  data/full_records.txt   Combined raw fullRecord text
  authors/raw-json/       One raw author extraction JSON per WOSID
  authors/normalized-json/
  authors/authors.csv
  authors/authors.jsonl
  authors/checkpoint.json
  authors/failures.json
  logs/progress.jsonl
  manifest.json
  summary.json
`.trim();
}

function parseArgs(argv) {
  const command = argv[2] && !argv[2].startsWith("--") ? argv[2] : "run";
  const startIndex = command === "run" ? (argv[2] === "run" ? 3 : 2) : 3;
  const args = {
    command,
    sid: "",
    sidSource: "",
    url: "",
    uuid: "",
    taskId: "",
    taskLabel: "",
    outDir: "",
    tasksRoot: path.resolve(process.cwd(), "tasks"),
    sortBy: "relevance",
    batchSize: DEFAULT_BATCH_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    baseUrl: DEFAULT_BASE_URL,
    headed: false,
    force: false,
    reuseRaw: false,
    concurrency: 2,
    limit: 0,
    fromIndex: 1,
    retryFailed: false,
    failedOnly: false,
    rebuildOnly: false,
    cooldownMs: 250,
    help: false,
    version: false,
  };

  const readValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    return value;
  };

  for (let i = startIndex; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--version" || arg === "-V") args.version = true;
    else if (arg === "--sid") {
      args.sid = readValue(arg, i++);
      args.sidSource = "cli";
    }
    else if (arg === "--url") args.url = readValue(arg, i++);
    else if (arg === "--uuid") args.uuid = readValue(arg, i++);
    else if (arg === "--task") args.taskId = normalizeTaskId(readValue(arg, i++));
    else if (arg === "--latest") args.latest = true;
    else if (arg === "--task-label" || arg === "--label") args.taskLabel = readValue(arg, i++);
    else if (arg === "--out-dir" || arg === "--download-dir") args.outDir = readValue(arg, i++);
    else if (arg === "--tasks-root" || arg === "--output-root") args.tasksRoot = readValue(arg, i++);
    else if (arg === "--sort-by") args.sortBy = readValue(arg, i++);
    else if (arg === "--batch-size") args.batchSize = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--timeout-ms" || arg === "--timeout") args.timeoutMs = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--base-url") args.baseUrl = stripTrailingSlash(readValue(arg, i++));
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--reuse-raw") args.reuseRaw = true;
    else if (arg === "--concurrency") args.concurrency = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--limit") args.limit = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--from-index") args.fromIndex = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--retry-failed") args.retryFailed = true;
    else if (arg === "--failed-only") args.failedOnly = true;
    else if (arg === "--rebuild-only") args.rebuildOnly = true;
    else if (arg === "--cooldown-ms") args.cooldownMs = parseIntegerFlag(arg, readValue(arg, i++));
    else throw new Error(`Unknown argument: ${arg}`);
  }

  args.baseUrl = stripTrailingSlash(args.baseUrl);
  if (args.url && !args.uuid) args.uuid = extractUuid(args.url);
  if (!args.url && args.uuid) args.url = buildSummaryUrl(args.baseUrl, args.uuid, args.sortBy);
  assertIntegerRange("--batch-size", args.batchSize, 1, 500);
  assertIntegerRange("--timeout-ms", args.timeoutMs, 5000);
  assertIntegerRange("--concurrency", args.concurrency, 1, 10);
  assertIntegerRange("--limit", args.limit, 0);
  assertIntegerRange("--from-index", args.fromIndex, 1);
  assertIntegerRange("--cooldown-ms", args.cooldownMs, 0);
  args.tasksRoot = path.resolve(args.tasksRoot);
  if (!args.taskId && args.uuid) args.taskId = makeTaskId();
  if (args.outDir) {
    args.outDir = path.resolve(args.outDir);
  } else if (args.taskId) {
    args.outDir = taskDirectory(args.tasksRoot, args.taskId);
  }
  return args;
}

function parseIntegerFlag(flag, value) {
  if (!/^-?\d+$/.test(String(value))) throw new Error(`Invalid integer for ${flag}: ${value}`);
  return Number(value);
}

function assertIntegerRange(flag, value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Value for ${flag} must be an integer between ${minimum} and ${maximum}`);
  }
}

function stripTrailingSlash(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function extractUuid(value) {
  const text = String(value || "");
  const match =
    text.match(/\/summary\/([^/?#]+)\//i) ||
    text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]+)/i) ||
    text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : "";
}

function buildSummaryUrl(baseUrl, uuid, sortBy) {
  return `${stripTrailingSlash(baseUrl)}/wos/woscc/summary/${encodeURIComponent(uuid)}/${encodeURIComponent(sortBy)}/1`;
}

function timestampForPath(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "_",
    pad(date.getMilliseconds(), 3),
  ].join("");
}

function makeTaskId(date = new Date()) {
  return normalizeTaskId(timestampForPath(date));
}

function normalizeTaskId(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Task id must not be empty");
  const taskId = safeFilePart(raw).replace(/:+/g, "-").slice(0, 120);
  if (taskId === "." || taskId === "..") throw new Error(`Invalid task id: ${raw}`);
  return taskId;
}

function safeFilePart(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "wos";
}

function taskIndexPath(tasksRoot) {
  return path.join(tasksRoot, "index.json");
}

function latestTaskPath(tasksRoot) {
  return path.join(tasksRoot, "latest");
}

function configPath(tasksRoot) {
  return path.join(tasksRoot, "config.json");
}

function taskDirectory(tasksRoot, taskId) {
  const root = path.resolve(tasksRoot);
  const target = path.resolve(root, taskId);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Task directory must be inside tasks root: ${taskId}`);
  }
  return target;
}

function storedTaskDirectory(tasksRoot, taskDir) {
  const relative = path.relative(path.resolve(tasksRoot), path.resolve(taskDir));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : path.resolve(taskDir);
}

function resolvedTaskDirectory(tasksRoot, taskDir) {
  return path.isAbsolute(taskDir) ? taskDir : path.resolve(tasksRoot, taskDir);
}

function readTaskIndex(tasksRoot) {
  return readJson(taskIndexPath(tasksRoot), { version: 1, tasks: [] });
}

function readConfig(tasksRoot) {
  return readJson(configPath(tasksRoot), { version: 1 });
}

function writeConfig(tasksRoot, config) {
  fs.mkdirSync(tasksRoot, { recursive: true });
  writeJson(
    configPath(tasksRoot),
    { version: 1, ...config, updatedAt: new Date().toISOString() },
    { mode: 0o600, backup: true }
  );
}

function saveSidConfig(args, observedSid) {
  writeConfig(args.tasksRoot, {
    ...(args.sidSource === "env" ? {} : { sid: observedSid || args.sid }),
    baseUrl: args.baseUrl,
  });
}

function loadSavedSid(args) {
  if (args.sid) return args.sid;
  if (process.env.WOS_SID) {
    args.sid = process.env.WOS_SID;
    args.sidSource = "env";
    return args.sid;
  }
  const config = readConfig(args.tasksRoot);
  if (config.sid) {
    args.sid = config.sid;
    args.sidSource = "config";
  }
  return args.sid;
}

function writeTaskIndex(tasksRoot, index) {
  fs.mkdirSync(tasksRoot, { recursive: true });
  writeJson(taskIndexPath(tasksRoot), index, { backup: true });
}

function upsertTaskIndex(args, patch = {}) {
  const index = readTaskIndex(args.tasksRoot);
  if (!Array.isArray(index.tasks)) index.tasks = [];
  const now = new Date().toISOString();
  const existing = index.tasks.find((task) => task.taskId === args.taskId);
  const entry = {
    taskId: args.taskId,
    label: args.taskLabel || existing?.label || "",
    uuid: patch.uuid || args.uuid || existing?.uuid || "",
    url: patch.url || args.url || existing?.url || "",
    sortBy: args.sortBy,
    taskDir: storedTaskDirectory(args.tasksRoot, args.outDir),
    status: patch.status || existing?.status || "created",
    expectedCount: patch.expectedCount ?? existing?.expectedCount ?? 0,
    uniqueCount: patch.uniqueCount ?? existing?.uniqueCount ?? 0,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastError: patch.lastError ?? existing?.lastError ?? "",
  };
  const nextTasks = index.tasks.filter((task) => task.taskId !== args.taskId);
  nextTasks.push(entry);
  nextTasks.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  index.tasks = nextTasks;
  writeTaskIndex(args.tasksRoot, index);
  writeFileAtomic(latestTaskPath(args.tasksRoot), args.taskId + "\n");
  return entry;
}

function resolveTask(args) {
  const index = readTaskIndex(args.tasksRoot);
  const taskId = args.taskId || (args.latest ? readLatestTaskId(args.tasksRoot) : "");
  if (!taskId) throw new Error("Missing --task or --latest");
  const task = (index.tasks || []).find((entry) => entry.taskId === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return { ...task, taskDir: resolvedTaskDirectory(args.tasksRoot, task.taskDir) };
}

function readLatestTaskId(tasksRoot) {
  try {
    return fs.readFileSync(latestTaskPath(tasksRoot), "utf8").trim();
  } catch (_) {
    return "";
  }
}

function getRunPaths(outDir) {
  return {
    taskDir: outDir,
    runDir: outDir,
    rawDir: path.join(outDir, "raw", "full-record"),
    dataDir: path.join(outDir, "data"),
    logsDir: path.join(outDir, "logs"),
    manifest: path.join(outDir, "manifest.json"),
    summary: path.join(outDir, "summary.json"),
    progressLog: path.join(outDir, "logs", "progress.jsonl"),
    simpleCsv: path.join(outDir, "data", "wosids.csv"),
    detailedCsv: path.join(outDir, "data", "wosids_detailed.csv"),
    json: path.join(outDir, "data", "wosids.json"),
    combinedFullRecords: path.join(outDir, "data", "full_records.txt"),
    authorsDir: path.join(outDir, "authors"),
    authorRawJsonDir: path.join(outDir, "authors", "raw-json"),
    authorNormalizedJsonDir: path.join(outDir, "authors", "normalized-json"),
    authorsCsv: path.join(outDir, "authors", "authors.csv"),
    authorsJsonl: path.join(outDir, "authors", "authors.jsonl"),
    authorFailures: path.join(outDir, "authors", "failures.json"),
    authorCheckpoint: path.join(outDir, "authors", "checkpoint.json"),
  };
}

function createRunLayout(args) {
  if (fs.existsSync(args.outDir) && !args.force) {
    const entries = fs.readdirSync(args.outDir).filter((name) => name !== ".DS_Store");
    if (entries.length) {
      throw new Error(`Output directory is not empty: ${args.outDir}. Use --force or choose another --out-dir.`);
    }
  }

  const paths = getRunPaths(args.outDir);
  for (const dir of [
    paths.rawDir,
    paths.dataDir,
    paths.logsDir,
    paths.authorsDir,
    paths.authorRawJsonDir,
    paths.authorNormalizedJsonDir,
  ]) fs.mkdirSync(dir, { recursive: true });
  return paths;
}

function cleanRunLayout(paths, tasksRoot) {
  const relative = path.relative(path.resolve(tasksRoot), path.resolve(paths.taskDir));
  const isTaskDirectory = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  const manifest = readJson(paths.manifest, null);
  const isManagedDirectory = manifest?.command === "wos-export-wosids";
  if (!isTaskDirectory && !isManagedDirectory) {
    throw new Error(`Refusing to clean unmanaged output directory: ${paths.taskDir}`);
  }
  for (const directory of [path.dirname(paths.rawDir), paths.dataDir, paths.authorsDir, paths.logsDir]) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  for (const filePath of [paths.manifest, paths.summary]) {
    fs.rmSync(filePath, { force: true });
  }
}

function appendProgress(paths, event) {
  fs.appendFileSync(paths.progressLog, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", "utf8");
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ].join("\n") + "\n";
}

function parseExportText(text, batchStart, batchEnd) {
  const ids = [];
  const seen = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match =
      line.match(/^\s*UT\s+(.+?)\s*$/i) ||
      line.match(/^\s*UT\s*[:=]\s*(.+?)\s*$/i) ||
      line.match(/(WOS:[A-Z0-9]+)/i);
    if (!match) continue;
    const raw = String(match[1] || "").trim();
    const idMatch = raw.match(/WOS:[A-Z0-9]+/i);
    const wosid = (idMatch ? idMatch[0] : raw).trim().toUpperCase();
    if (!/^WOS:[A-Z0-9]+$/i.test(wosid) || seen.has(wosid)) continue;
    seen.add(wosid);
    ids.push({ batchStart, batchEnd, batchPosition: ids.length + 1, wosid });
  }
  return ids;
}

function safeWosIdFileName(wosid) {
  return safeFilePart(String(wosid || "").replace(/^WOS:/i, "WOS_")) + ".json";
}

function readWosIdsCsv(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const start = /^wosid$/i.test(lines[0].replace(/^"|"$/g, "")) ? 1 : 0;
  return lines.slice(start).map((line) => {
    const cell = line.split(",")[0].replace(/^"|"$/g, "").trim();
    return cell;
  }).filter(Boolean);
}

function emptyAuthorCheckpoint() {
  return {
    version: 1,
    startedAt: "",
    updatedAt: "",
    total: 0,
    completed: 0,
    failed: 0,
    records: {},
  };
}

function readAuthorCheckpoint(paths) {
  const checkpoint = readJson(paths.authorCheckpoint, emptyAuthorCheckpoint());
  if (!checkpoint.records || typeof checkpoint.records !== "object") checkpoint.records = {};
  return checkpoint;
}

function writeAuthorCheckpoint(paths, checkpoint) {
  checkpoint.updatedAt = new Date().toISOString();
  const values = Object.values(checkpoint.records || {});
  checkpoint.completed = values.filter((item) => item.status === "completed").length;
  checkpoint.failed = values.filter((item) => item.status === "failed").length;
  writeJson(paths.authorCheckpoint, checkpoint, { backup: true });
}

function rawAuthorJsonPath(paths, wosid) {
  return path.join(paths.authorRawJsonDir, safeWosIdFileName(wosid));
}

function normalizedAuthorJsonPath(paths, wosid) {
  return path.join(paths.authorNormalizedJsonDir, safeWosIdFileName(wosid));
}

function splitAuthorField(value, delimiterPattern) {
  return String(value || "")
    .split(delimiterPattern)
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickExpandedValue(values, index) {
  if (!values.length) return "";
  if (values[index]) return values[index];
  return values.length === 1 ? values[0] : "";
}

function cleanRorId(value) {
  return String(value || "").replace(/open_in_new/g, "").trim();
}

function addressAffiliationRows(addressItem) {
  if (Array.isArray(addressItem?.affiliationItems) && addressItem.affiliationItems.length) {
    return addressItem.affiliationItems.map((item) => ({
      affiliation: item.affiliation || item.name || "",
      rorId: cleanRorId(item.rorId || item.ror || ""),
    }));
  }
  if (Array.isArray(addressItem?.affiliations) && addressItem.affiliations.length) {
    return addressItem.affiliations.map((item) => {
      if (typeof item === "string") return { affiliation: item, rorId: "" };
      return {
        affiliation: item.affiliation || item.name || "",
        rorId: cleanRorId(item.rorId || item.ror || ""),
      };
    });
  }
  const affiliations = splitAuthorField(addressItem?.affiliations, /;/);
  const rorIds = splitAuthorField(addressItem?.rorIds, /;/).map(cleanRorId);
  const rowCount = Math.max(affiliations.length, rorIds.length);
  if (!rowCount) return [{ affiliation: "", rorId: "" }];
  return Array.from({ length: rowCount }, (_, index) => ({
    affiliation: pickExpandedValue(affiliations, index),
    rorId: pickExpandedValue(rorIds, index),
  }));
}

function buildAuthorAddressDetails(author, rawAddresses = {}) {
  if (Array.isArray(author.addressDetails) && author.addressDetails.length) return author.addressDetails;
  const addressNumbers = splitAuthorField(author.addressNumbers, /;/);
  if (addressNumbers.length) {
    return addressNumbers.map((number) => {
      const addressItem = rawAddresses[number] || {};
      return {
        addressNumber: number,
        address: addressItem.address || "",
        affiliations: addressAffiliationRows(addressItem),
      };
    });
  }

  const addresses = splitAuthorField(author.addresses, /\s+\|\s+|\|/);
  if (addresses.length) {
    const affiliations = splitAuthorField(author.affiliations, /;/);
    const rorIds = splitAuthorField(author.rorIds, /;/).map(cleanRorId);
    return addresses.map((address, index) => ({
      addressNumber: "",
      address,
      affiliations: [{
        affiliation: pickExpandedValue(affiliations, index),
        rorId: pickExpandedValue(rorIds, index),
      }],
    }));
  }

  return [];
}

function flattenAuthorRows(normalizedRecords) {
  const rows = [];
  for (const record of normalizedRecords) {
    for (const author of record.authors || []) {
      const addressDetails = buildAuthorAddressDetails(author);
      const expandedItems = addressDetails.length
        ? addressDetails.flatMap((addressItem, addressIndex) => {
          const affiliations = addressAffiliationRows(addressItem);
          return affiliations.map((affiliationItem, affiliationIndex) => ({
            addressIndex,
            affiliationIndex,
            addressCount: addressDetails.length,
            affiliationCount: affiliations.length,
            addressNumber: addressItem.addressNumber || "",
            address: addressItem.address || "",
            affiliation: affiliationItem.affiliation || "",
            rorId: cleanRorId(affiliationItem.rorId || ""),
          }));
        })
        : [{
          addressIndex: 0,
          affiliationIndex: 0,
          addressCount: 0,
          affiliationCount: 0,
          addressNumber: "",
          address: "",
          affiliation: "",
          rorId: "",
        }];
      for (const item of expandedItems) {
        rows.push({
          wosid: record.wosid || "",
          recordTitle: record.recordTitle || "",
          recordUrl: record.recordUrl || "",
          authorIndex: author.authorIndex || "",
          authorAddressIndex: item.addressCount ? item.addressIndex + 1 : "",
          authorInstitutionIndex: item.affiliationCount ? item.affiliationIndex + 1 : "",
          displayName: author.displayName || "",
          fullName: author.fullName || "",
          email: author.email || "",
          webOfScienceResearcherID: author.webOfScienceResearcherID || "",
          orcidNumber: author.orcidNumber || "",
          addressNumber: item.addressNumber,
          address: item.address,
          affiliation: item.affiliation,
          rorId: item.rorId,
          isCorrespondingAuthor: author.isCorrespondingAuthor || "",
          correspondingAddress: author.correspondingAddress || "",
          authorRecordId: author.authorRecordId || "",
          authorRecordUrl: author.authorRecordUrl || "",
        });
      }
    }
  }
  return rows;
}

function writeAuthorAggregates(paths) {
  const records = fs.readdirSync(paths.authorNormalizedJsonDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(paths.authorNormalizedJsonDir, name), null))
    .filter(Boolean);
  const rows = flattenAuthorRows(records);
  const columns = [
    "wosid",
    "recordTitle",
    "recordUrl",
    "authorIndex",
    "authorAddressIndex",
    "authorInstitutionIndex",
    "displayName",
    "fullName",
    "email",
    "webOfScienceResearcherID",
    "orcidNumber",
    "addressNumber",
    "address",
    "affiliation",
    "rorId",
    "isCorrespondingAuthor",
    "correspondingAddress",
    "authorRecordId",
    "authorRecordUrl",
  ];
  writeFileAtomic(paths.authorsCsv, toCsv(rows, columns));
  writeFileAtomic(paths.authorsJsonl, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  return { recordCount: records.length, authorRows: rows.length };
}

function rebuildNormalizedAuthorsFromRaw(paths) {
  if (!fs.existsSync(paths.authorRawJsonDir)) return { rawRecords: 0, normalizedRecords: 0 };
  const rawFiles = fs.readdirSync(paths.authorRawJsonDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  let normalizedRecords = 0;
  for (const name of rawFiles) {
    const rawPath = path.join(paths.authorRawJsonDir, name);
    const raw = readJson(rawPath, null);
    if (!raw) continue;
    const wosid = raw.wosid || raw.url?.match(/full-record\/(WOS:[^/?#]+)/i)?.[1] || "";
    if (!wosid) continue;
    const normalized = normalizeAuthorRecord(wosid, raw);
    writeJson(normalizedAuthorJsonPath(paths, wosid), normalized);
    normalizedRecords += 1;
  }
  return { rawRecords: rawFiles.length, normalizedRecords };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

function batchFileName(uuid, markFrom, markTo) {
  return `${safeFilePart(uuid)}_${markFrom}_${markTo}.txt`;
}

function rawBatchFiles(paths, uuid = "") {
  const prefix = uuid ? `${safeFilePart(uuid)}_` : "";
  return fs
    .readdirSync(paths.rawDir)
    .filter((name) => name.startsWith(prefix) && /_(\d+)_(\d+)\.txt$/.test(name))
    .sort((a, b) => Number(a.match(/_(\d+)_/)[1]) - Number(b.match(/_(\d+)_/)[1]));
}

function parseExistingRawBatches(paths, uuid = "") {
  const rows = [];
  const files = rawBatchFiles(paths, uuid);
  let previousEnd = 0;
  for (const fileName of files) {
    const match = fileName.match(/_(\d+)_(\d+)\.txt$/);
    const batchStart = Number(match[1]);
    const batchEnd = Number(match[2]);
    if (batchStart <= previousEnd) throw new Error(`Overlapping raw batches detected: ${fileName}`);
    previousEnd = batchEnd;
    const text = fs.readFileSync(path.join(paths.rawDir, fileName), "utf8");
    rows.push(...parseExportText(text, batchStart, batchEnd));
  }
  return rows;
}

function writeOutputs(paths, rows, meta) {
  const seen = new Set();
  const uniqueRows = rows
    .filter((row) => {
      if (seen.has(row.wosid)) return false;
      seen.add(row.wosid);
      return true;
    })
    .map((row, index) => ({ index: index + 1, ...row }));

  writeFileAtomic(paths.simpleCsv, toCsv(uniqueRows.map((row) => ({ wosid: row.wosid })), ["wosid"]));
  writeFileAtomic(paths.detailedCsv, toCsv(uniqueRows, ["index", "batchStart", "batchEnd", "batchPosition", "wosid"]));
  writeJson(paths.json, uniqueRows);

  const rawFiles = rawBatchFiles(paths, meta.uuid);
  const combined = rawFiles.map((name) => fs.readFileSync(path.join(paths.rawDir, name), "utf8")).join("\n");
  writeFileAtomic(paths.combinedFullRecords, combined);

  const summary = {
    ok: !meta.expectedCount || uniqueRows.length === meta.expectedCount,
    method: "wos-export-api-saveToFieldTagged",
    ...meta,
    parsedCount: rows.length,
    uniqueCount: uniqueRows.length,
    files: {
      wosidsCsv: paths.simpleCsv,
      detailedCsv: paths.detailedCsv,
      wosidsJson: paths.json,
      combinedFullRecords: paths.combinedFullRecords,
      rawDir: paths.rawDir,
      progressLog: paths.progressLog,
    },
    finishedAt: new Date().toISOString(),
  };
  writeJson(paths.summary, summary);
  return summary;
}

async function validateSid(page, args) {
  const initUrl = `${args.baseUrl}/wos/?Init=Yes&SrcApp=CR&SID=${encodeURIComponent(args.sid)}`;
  await page.goto(initUrl, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  const status = await page.evaluate(() => ({
    href: location.href,
    sid: window.sessionData?.BasicProperties?.SID || "",
  }));
  if (!status.sid || status.sid !== args.sid) {
    if (args.sidSource === "config") {
      throw new Error(
        `Saved SID is invalid or expired. Pass a fresh SID with --sid, or run: node bin/wos-export-wosids.js sid --sid "<SID>". observedSid=${status.sid || "(missing)"} href=${status.href}`
      );
    }
    throw new Error(`SID validation failed. observedSid=${status.sid || "(missing)"} href=${status.href}`);
  }
  saveSidConfig(args, status.sid);
  return status;
}

async function readSummaryInfo(page, args) {
  await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForSelector('div[data-ta="search-info"]', { state: "attached", timeout: args.timeoutMs });
  return page.evaluate(() => {
    const searchInfo = document.querySelector('div[data-ta="search-info"]');
    const uuid = searchInfo?.getAttribute("data-ta-search-info-qid") || "";
    const countText = searchInfo?.getAttribute("data-ta-search-info-count") || "";
    const rowText = document.querySelector(".search-text")?.textContent?.trim() || "";
    const expectedCount = Number(String(countText).replace(/,/g, "")) || 0;
    return { uuid, expectedCount, countText, rowText, href: location.href };
  });
}

async function fetchExportBatch(page, args, uuid, markFrom, markTo) {
  return page.evaluate(
    async ({ sid, sortBy, uuid, markFrom, markTo }) => {
      const requestBody = {
        action: "saveToFieldTagged",
        colName: "WOS",
        displayTimesCited: "true",
        displayUsageInfo: "true",
        displayCitedRefs: "true",
        filters: "fullRecord",
        fileOpt: "othersoftware",
        locale: "en_US",
        parentQid: uuid,
        sortBy,
        product: "UA",
        markFrom: String(markFrom),
        markTo: String(markTo),
        view: "summary",
        isRefQuery: "false",
      };
      const response = await fetch(`${location.origin}/api/wosnx/indic/export/saveToFile`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/json",
          "x-1p-wos-sid": sid,
        },
        body: JSON.stringify(requestBody),
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, statusText: response.statusText, text };
    },
    { sid: args.sid, sortBy: args.sortBy, uuid, markFrom, markTo }
  );
}

const EXTRACT_AUTHOR_INFO = async () => {
  const wosClean = (value) =>
    String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+([,;:])/g, "$1")
      .trim();
  const wosUnique = (items) => [...new Set(items.map(wosClean).filter(Boolean))];
  const textOf = (el) => wosClean(el?.innerText || el?.textContent || "");
  const sleepInPage = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const absUrl = (href) => {
    if (!href || href.startsWith("javascript:") || href.startsWith("mailto:")) return href || "";
    try {
      return new URL(href, location.origin).href;
    } catch {
      return href;
    }
  };
  async function clickButton(button) {
    button.scrollIntoView({ block: "center", inline: "nearest" });
    button.click();
    await sleepInPage(500);
  }
  for (const selector of [
    'button.onetrust-close-btn-handler.onetrust-close-btn-ui.banner-close-button.ot-close-icon',
    '#onetrust-close-btn-container button',
    'button._pendo-close-guide[aria-label="Close"]',
    'button[id^="pendo-close-guide-"]',
  ]) {
    const button = document.querySelector(selector);
    if (button && !button.disabled) {
      try {
        button.click();
      } catch (_) {}
    }
  }

  const idButton = [...document.querySelectorAll("button")].find((button) =>
    /View Web of Science ResearcherID and ORCID/i.test(textOf(button) || button.getAttribute("aria-label") || "")
  );
  if (idButton) await clickButton(idButton);

  const expandButtons = [...document.querySelectorAll("button")].filter((button) => {
    const icon = button.querySelector(
      "mat-icon.notranslate.font-size-26.material-icons.mat-ligature-font.mat-icon-no-color"
    );
    return icon && /arrow_drop_down|expand_more/i.test(textOf(icon));
  });
  for (const button of expandButtons) await clickButton(button);

  const authors = [...document.querySelectorAll('#SumAuthTa-MainDiv-author-en [id^="author-"]')].map((node, index) => {
    const link = node.querySelector('a[id^="SumAuthTa-DisplayName-author"]');
    const fullNameNode = node.querySelector('[id^="SumAuthTa-FrAuthStandard-author"] .value');
    const addressNumbers = [...node.querySelectorAll('[id*="FrAddrNbr"]')]
      .map((a) => textOf(a).replace(/[^\d,]/g, ""))
      .flatMap((value) => value.split(","))
      .map(wosClean)
      .filter(Boolean);
    const authorRecordUrl = absUrl(link?.getAttribute("href") || "");
    return {
      index: index + 1,
      displayName: textOf(link),
      fullName: textOf(fullNameNode).replace(/^\(|\)$/g, ""),
      addressNumbers: wosUnique(addressNumbers).join("; "),
      authorRecordId: authorRecordUrl.match(/\/author\/record\/([^/?#]+)/)?.[1] || "",
      authorRecordUrl,
    };
  });

  const idTables = [...document.querySelectorAll("table")].filter((table) =>
    /Author Identifiers Table|Web of Science ResearcherID|ORCID Number/i.test(textOf(table))
  );
  const idsByName = new Map();
  for (const table of idTables) {
    const headers = [...table.querySelectorAll("thead th, tr:first-child th")].map(textOf);
    for (const row of table.querySelectorAll("tbody tr")) {
      const cells = [...row.querySelectorAll("td")].map((td) => textOf(td).replace(/open_in_new/g, "").trim());
      if (!cells.length) continue;
      const item = {};
      headers.forEach((header, i) => {
        item[header || `column_${i + 1}`] = cells[i] || "";
      });
      const name = wosClean(item.Author || cells[0]);
      if (name) idsByName.set(name.toLowerCase(), item);
    }
  }

  const addresses = {};
  for (const addr of document.querySelectorAll('[id^="address_"]')) {
    const number = addr.id.replace("address_", "");
    const addressText = textOf(addr).replace(new RegExp(`^${number}\\s*`), "");
    const orgSelector = `[id^="FRAOrgTa-RepOrgEnhancedName-addresses-${Number(number) - 1}-"]`;
    const affiliationItems = [...document.querySelectorAll(orgSelector)].map((org) => {
      const affiliation = textOf(org);
      let rorId = "";
      let node = org.nextElementSibling;
      for (let i = 0; node && i < 6; i += 1, node = node.nextElementSibling) {
        const ror = node.matches?.('a[href^="https://ror.org/"]')
          ? node
          : node.querySelector?.('a[href^="https://ror.org/"]');
        if (ror) {
          rorId = textOf(ror).replace(/open_in_new/g, "");
          break;
        }
      }
      return { affiliation, rorId };
    }).filter((item) => item.affiliation || item.rorId);
    const seenAffiliations = new Set();
    const uniqueAffiliationItems = affiliationItems.filter((item) => {
      const key = `${item.affiliation}\u0000${item.rorId}`;
      if (seenAffiliations.has(key)) return false;
      seenAffiliations.add(key);
      return true;
    });
    const orgs = wosUnique(uniqueAffiliationItems.map((item) => item.affiliation));
    const rors = wosUnique(uniqueAffiliationItems.map((item) => item.rorId));
    if (!uniqueAffiliationItems.length) {
      const fallbackRors = wosUnique(
        [...document.querySelectorAll(orgSelector)].map((org) => {
        let node = org.nextElementSibling;
        for (let i = 0; node && i < 6; i += 1, node = node.nextElementSibling) {
          const ror = node.matches?.('a[href^="https://ror.org/"]')
            ? node
            : node.querySelector?.('a[href^="https://ror.org/"]');
          if (ror) return textOf(ror).replace(/open_in_new/g, "");
        }
        return "";
      })
      );
      for (const rorId of fallbackRors) uniqueAffiliationItems.push({ affiliation: "", rorId });
    }
    addresses[number] = {
      addressNumber: number,
      address: addressText,
      affiliations: orgs.join("; "),
      rorIds: rors.join("; "),
      affiliationItems: uniqueAffiliationItems,
    };
  }

  const emailsByIndex = {};
  for (const email of document.querySelectorAll('[id^="FRAiinTa-AuthRepEmailAddr-"]')) {
    const zeroBased = Number(email.id.match(/-(\d+)$/)?.[1]);
    if (Number.isFinite(zeroBased)) emailsByIndex[zeroBased + 1] = textOf(email);
  }

  const corresponding = [...document.querySelectorAll('[id^="FRAiinTa-RepAddrTitle-"]')].map((node) => ({
    name: textOf(node.querySelector(".author-display-name")),
    address: textOf(node.querySelector('[id^="FRAOrgTa-RepAddressFull"]')),
    affiliations: wosUnique([...node.querySelectorAll('[id^="FRAOrgTa-RepOrgEnhancedName-reprint"]')].map(textOf)).join("; "),
    rorIds: wosUnique(
      [...node.querySelectorAll('a[href^="https://ror.org/"]')].map((a) => textOf(a).replace(/open_in_new/g, ""))
    ).join("; "),
    emails: wosUnique([...node.querySelectorAll('a[href^="mailto:"]')].map(textOf)).join("; "),
  }));

  const merged = authors.map((author) => {
    const ids =
      idsByName.get(author.fullName.toLowerCase()) ||
      idsByName.get(author.displayName.toLowerCase()) ||
      {};
    const matchedAddresses = author.addressNumbers
      .split(";")
      .map(wosClean)
      .filter(Boolean)
      .map((number) => addresses[number])
      .filter(Boolean);
    const correspondingItem = corresponding.find(
      (item) => item.name && item.name.toLowerCase() === author.fullName.toLowerCase()
    );
    return {
      ...author,
      email: emailsByIndex[author.index] || "",
      webOfScienceResearcherID: ids["Web of Science ResearcherID"] || "",
      orcidNumber: ids["ORCID Number"] || "",
      addresses: matchedAddresses.map((item) => item.address).join(" | "),
      affiliations: wosUnique(matchedAddresses.flatMap((item) => item.affiliations.split(";"))).join("; "),
      rorIds: wosUnique(matchedAddresses.flatMap((item) => item.rorIds.split(";"))).join("; "),
      addressDetails: matchedAddresses.map((item) => ({
        addressNumber: item.addressNumber || "",
        address: item.address || "",
        affiliations: item.affiliationItems || [],
      })),
      isCorrespondingAuthor: correspondingItem ? "yes" : "",
      correspondingAddress: correspondingItem?.address || "",
    };
  });

  return {
    url: location.href,
    title: wosClean(document.querySelector('[id^="FullRTa-fullRecordtitle"]')?.textContent || document.title),
    authors: merged,
    addresses,
    corresponding,
  };
};

function normalizeAuthorRecord(wosid, raw) {
  return {
    wosid,
    recordTitle: raw.title || "",
    recordUrl: raw.url || "",
    fetchedAt: raw.fetchedAt || new Date().toISOString(),
    authors: (raw.authors || []).map((author) => {
      const addressDetails = buildAuthorAddressDetails(author, raw.addresses || {});
      return {
        wosid,
        recordTitle: raw.title || "",
        recordUrl: raw.url || "",
        authorIndex: author.index,
        displayName: author.displayName || "",
        fullName: author.fullName || "",
        email: author.email || "",
        webOfScienceResearcherID: author.webOfScienceResearcherID || "",
        orcidNumber: author.orcidNumber || "",
        addressNumbers: author.addressNumbers || "",
        addresses: addressDetails.map((item) => item.address).filter(Boolean).join(" | ") || author.addresses || "",
        affiliations: addressDetails
          .flatMap((item) => addressAffiliationRows(item).map((affiliationItem) => affiliationItem.affiliation))
          .filter(Boolean)
          .join("; ") || author.affiliations || "",
        rorIds: addressDetails
          .flatMap((item) => addressAffiliationRows(item).map((affiliationItem) => affiliationItem.rorId))
          .filter(Boolean)
          .join("; ") || cleanRorId(author.rorIds || ""),
        addressDetails,
        isCorrespondingAuthor: author.isCorrespondingAuthor || "",
        correspondingAddress: author.correspondingAddress || "",
        authorRecordId: author.authorRecordId || "",
        authorRecordUrl: author.authorRecordUrl || "",
      };
    }),
  };
}

async function exportFromWos(args, paths) {
  const browser = await chromium.launch({ headless: !args.headed });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(args.timeoutMs);

  const rows = [];
  let info = null;
  try {
    await validateSid(page, args);
    appendProgress(paths, { phase: "sid-validated" });
    info = await readSummaryInfo(page, args);
    if (!info.uuid || !info.expectedCount) {
      throw new Error(`Could not read summary uuid/count: ${JSON.stringify(info)}`);
    }
    appendProgress(paths, { phase: "summary-info", ...info });
    console.error(`summary uuid=${info.uuid} count=${info.expectedCount}`);

    for (let markFrom = 1; markFrom <= info.expectedCount; markFrom += args.batchSize) {
      const markTo = Math.min(markFrom + args.batchSize - 1, info.expectedCount);
      const rawPath = path.join(paths.rawDir, batchFileName(info.uuid, markFrom, markTo));
      let text = "";
      if (args.reuseRaw && fs.existsSync(rawPath)) {
        text = fs.readFileSync(rawPath, "utf8");
      } else {
        const result = await fetchExportBatch(page, args, info.uuid, markFrom, markTo);
        if (!result.ok) {
          throw new Error(
            `Export API failed ${markFrom}-${markTo}: HTTP ${result.status} ${result.statusText}\n${result.text.slice(0, 500)}`
          );
        }
        text = result.text;
        writeFileAtomic(rawPath, text);
      }
      const ids = parseExportText(text, markFrom, markTo);
      rows.push(...ids);
      appendProgress(paths, { phase: "batch", markFrom, markTo, parsed: ids.length, rawPath });
      console.error(`export ${markFrom}-${markTo}: parsed ${ids.length} WOS IDs`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return {
    rows,
    info,
  };
}

function selectAuthorWork(wosids, checkpoint, args) {
  let indexed = wosids.map((wosid, index) => ({ wosid, index: index + 1 }));
  indexed = indexed.filter((item) => item.index >= args.fromIndex);
  if (args.failedOnly) {
    indexed = indexed.filter((item) => checkpoint.records[item.wosid]?.status === "failed");
  } else if (!args.force) {
    indexed = indexed.filter((item) => {
      const state = checkpoint.records[item.wosid];
      if (!state) return true;
      if (state.status === "completed") return false;
      if (state.status === "failed" && !args.retryFailed) return false;
      return true;
    });
  }
  if (args.limit) indexed = indexed.slice(0, args.limit);
  return indexed;
}

async function extractOneAuthorRecord(context, args, wosid) {
  const page = await context.newPage();
  page.setDefaultTimeout(args.timeoutMs);
  const url = `${args.baseUrl}/wos/woscc/full-record/${encodeURI(wosid)}`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(
      () =>
        Boolean(document.querySelector('#SumAuthTa-MainDiv-author-en [id^="author-"]')) ||
        /Author Information/i.test(document.body?.innerText || ""),
      null,
      { timeout: args.timeoutMs }
    );
    const raw = await page.evaluate(EXTRACT_AUTHOR_INFO);
    raw.wosid = wosid;
    raw.fetchedAt = new Date().toISOString();
    if (!raw.authors || !raw.authors.length) throw new Error("No authors extracted");
    return raw;
  } finally {
    await page.close().catch(() => {});
  }
}

async function runAuthors(args) {
  const task = resolveTask(args);
  args.taskId = task.taskId;
  args.outDir = task.taskDir;
  args.uuid = task.uuid || args.uuid;
  args.url = task.url || args.url || (args.uuid ? buildSummaryUrl(args.baseUrl, args.uuid, args.sortBy) : "");
  const paths = createRunLayout({ ...args, force: true });
  if (args.rebuildOnly) {
    const normalized = rebuildNormalizedAuthorsFromRaw(paths);
    const aggregate = writeAuthorAggregates(paths);
    appendProgress(paths, {
      phase: "authors-rebuild",
      rawRecords: normalized.rawRecords,
      normalizedRecords: normalized.normalizedRecords,
      records: aggregate.recordCount,
      rows: aggregate.authorRows,
    });
    return {
      taskId: task.taskId,
      taskDir: task.taskDir,
      mode: "rebuild-only",
      rawRecords: normalized.rawRecords,
      rebuiltNormalizedRecords: normalized.normalizedRecords,
      normalizedRecords: aggregate.recordCount,
      authorRows: aggregate.authorRows,
      authorsCsv: paths.authorsCsv,
      authorsJsonl: paths.authorsJsonl,
    };
  }

  const wosidsPath = paths.simpleCsv;
  if (!fs.existsSync(wosidsPath)) throw new Error(`Missing WOSID CSV: ${wosidsPath}`);
  const wosids = readWosIdsCsv(wosidsPath);
  if (!wosids.length) throw new Error(`No WOS IDs found in ${wosidsPath}`);

  const checkpoint = readAuthorCheckpoint(paths);
  if (!checkpoint.startedAt) checkpoint.startedAt = new Date().toISOString();
  checkpoint.total = wosids.length;
  const work = selectAuthorWork(wosids, checkpoint, args);
  appendProgress(paths, { phase: "authors-start", total: wosids.length, selected: work.length });
  upsertTaskIndex(args, { status: "authors-running", lastError: "", uuid: task.uuid, url: task.url, expectedCount: task.expectedCount, uniqueCount: task.uniqueCount });

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  try {
    const control = await context.newPage();
    await validateSid(control, args);
    await control.close().catch(() => {});
    await runPool(work, args.concurrency, async (item) => {
      const { wosid, index } = item;
      const startedAt = new Date().toISOString();
      const prior = checkpoint.records[wosid] || {};
      checkpoint.records[wosid] = {
        ...prior,
        wosid,
        index,
        status: "running",
        attempts: Number(prior.attempts || 0) + 1,
        startedAt,
        updatedAt: startedAt,
      };
      writeAuthorCheckpoint(paths, checkpoint);
      try {
        const raw = await extractOneAuthorRecord(context, args, wosid);
        const normalized = normalizeAuthorRecord(wosid, raw);
        const rawPath = rawAuthorJsonPath(paths, wosid);
        const normalizedPath = normalizedAuthorJsonPath(paths, wosid);
        writeJson(rawPath, raw);
        writeJson(normalizedPath, normalized);
        checkpoint.records[wosid] = {
          ...checkpoint.records[wosid],
          status: "completed",
          authorCount: normalized.authors.length,
          rawJsonPath: rawPath,
          normalizedJsonPath: normalizedPath,
          error: "",
          updatedAt: new Date().toISOString(),
        };
        writeAuthorCheckpoint(paths, checkpoint);
        appendProgress(paths, { phase: "authors-record", status: "completed", wosid, index, authorCount: normalized.authors.length });
        console.error(`authors OK ${index}/${wosids.length} ${wosid} authors=${normalized.authors.length}`);
      } catch (error) {
        checkpoint.records[wosid] = {
          ...checkpoint.records[wosid],
          status: "failed",
          error: error && error.stack ? error.stack : String(error),
          updatedAt: new Date().toISOString(),
        };
        writeAuthorCheckpoint(paths, checkpoint);
        appendProgress(paths, { phase: "authors-record", status: "failed", wosid, index, error: error.message || String(error) });
        console.error(`authors FAIL ${index}/${wosids.length} ${wosid}: ${error.message || error}`);
      }
      if (args.cooldownMs) await sleep(args.cooldownMs);
    });
  } finally {
    await browser.close().catch(() => {});
  }

  const aggregate = writeAuthorAggregates(paths);
  const failures = Object.values(checkpoint.records).filter((item) => item.status === "failed");
  writeJson(paths.authorFailures, failures);
  const finalCheckpoint = readAuthorCheckpoint(paths);
  writeAuthorCheckpoint(paths, finalCheckpoint);
  const status = finalCheckpoint.completed === wosids.length ? "authors-completed" : "authors-incomplete";
  upsertTaskIndex(args, { status, lastError: "", uuid: task.uuid, url: task.url, expectedCount: task.expectedCount, uniqueCount: task.uniqueCount });
  return {
    taskId: task.taskId,
    taskDir: task.taskDir,
    totalWosIds: wosids.length,
    selected: work.length,
    completed: finalCheckpoint.completed,
    failed: finalCheckpoint.failed,
    authorRows: aggregate.authorRows,
    authorsCsv: paths.authorsCsv,
    checkpoint: paths.authorCheckpoint,
  };
}

function validateTask(args) {
  const task = resolveTask(args);
  const paths = getRunPaths(task.taskDir);
  const summary = readJson(paths.summary, {});
  const wosids = fs.existsSync(paths.simpleCsv) ? readWosIdsCsv(paths.simpleCsv) : [];
  const rawFiles = fs.existsSync(paths.rawDir) ? fs.readdirSync(paths.rawDir).filter((name) => name.endsWith(".txt")) : [];
  const checkpoint = readAuthorCheckpoint(paths);
  const normalizedFiles = fs.existsSync(paths.authorNormalizedJsonDir)
    ? fs.readdirSync(paths.authorNormalizedJsonDir).filter((name) => name.endsWith(".json"))
    : [];
  const aggregateRows = fs.existsSync(paths.authorsCsv)
    ? Math.max(0, fs.readFileSync(paths.authorsCsv, "utf8").split(/\r?\n/).filter(Boolean).length - 1)
    : 0;
  const issues = [];
  if (!fs.existsSync(paths.manifest)) issues.push("missing manifest.json");
  if (!fs.existsSync(paths.summary)) issues.push("missing summary.json");
  if (!fs.existsSync(paths.simpleCsv)) issues.push("missing data/wosids.csv");
  if (summary.expectedCount && summary.uniqueCount !== summary.expectedCount) {
    issues.push(`wosid count mismatch: expected=${summary.expectedCount} unique=${summary.uniqueCount}`);
  }
  if (summary.uniqueCount && wosids.length !== summary.uniqueCount) {
    issues.push(`wosids.csv rows mismatch: csv=${wosids.length} summary.uniqueCount=${summary.uniqueCount}`);
  }
  if (!rawFiles.length) issues.push("missing raw/full-record batches");
  const completed = Object.values(checkpoint.records || {}).filter((item) => item.status === "completed");
  for (const item of completed) {
    if (!item.rawJsonPath || !fs.existsSync(item.rawJsonPath)) issues.push(`missing raw author json: ${item.wosid}`);
    if (!item.normalizedJsonPath || !fs.existsSync(item.normalizedJsonPath)) issues.push(`missing normalized author json: ${item.wosid}`);
  }
  return {
    ok: issues.length === 0,
    taskId: task.taskId,
    taskDir: task.taskDir,
    wosids: wosids.length,
    rawBatches: rawFiles.length,
    authorCheckpoint: {
      total: checkpoint.total || 0,
      completed: checkpoint.completed || 0,
      failed: checkpoint.failed || 0,
      normalizedFiles: normalizedFiles.length,
      aggregateRows,
    },
    issues,
  };
}

async function run(args) {
  const initialPaths = getRunPaths(args.outDir);
  const priorSummary = readJson(initialPaths.summary, {});
  const outputHasFiles = fs.existsSync(args.outDir) &&
    fs.readdirSync(args.outDir).some((name) => name !== ".DS_Store");
  if (args.force && !args.reuseRaw && outputHasFiles) {
    cleanRunLayout(initialPaths, args.tasksRoot);
  }
  const paths = createRunLayout(args);
  upsertTaskIndex(args, { status: "running", lastError: "" });
  writeJson(paths.manifest, {
    command: "wos-export-wosids",
    args: { ...args, sid: args.sid ? "[redacted]" : "" },
    task: {
      taskId: args.taskId,
      label: args.taskLabel,
      taskDir: paths.taskDir,
      tasksRoot: args.tasksRoot,
    },
    createdAt: new Date().toISOString(),
  });

  let rows = [];
  let info = {
    uuid: args.uuid,
    expectedCount: priorSummary.expectedCount || 0,
    href: priorSummary.summaryHref || args.url,
    rowText: priorSummary.rowText || "",
  };

  if (args.reuseRaw && fs.existsSync(paths.rawDir) && fs.readdirSync(paths.rawDir).some((name) => name.endsWith(".txt"))) {
    rows = parseExistingRawBatches(paths, args.uuid);
    if (!rows.length) throw new Error(`No raw batches found for UUID: ${args.uuid}`);
    appendProgress(paths, { phase: "reuse-raw", parsed: rows.length });
  } else {
    const result = await exportFromWos(args, paths);
    rows = result.rows;
    info = result.info;
  }

  const summary = writeOutputs(paths, rows, {
    taskId: args.taskId,
    taskLabel: args.taskLabel,
    inputUrl: args.url,
    inputUuid: args.uuid,
    uuid: info.uuid || args.uuid,
    sortBy: args.sortBy,
    expectedCount: info.expectedCount || 0,
    rowText: info.rowText || "",
    summaryHref: info.href || args.url,
    runDir: paths.runDir,
  });
  upsertTaskIndex(args, {
    status: summary.ok ? "completed" : "incomplete",
    lastError: "",
    uuid: summary.uuid,
    url: summary.inputUrl,
    expectedCount: summary.expectedCount,
    uniqueCount: summary.uniqueCount,
  });
  return summary;
}

function listTasks(args) {
  const index = readTaskIndex(args.tasksRoot);
  const rows = Array.isArray(index.tasks) ? index.tasks : [];
  if (!rows.length) {
    console.log(`No tasks in ${args.tasksRoot}`);
    return;
  }
  const columns = ["updatedAt", "status", "taskId", "uniqueCount", "expectedCount", "label", "uuid"];
  console.log(toCsv(rows, columns).trim());
}

function showTask(args) {
  const task = resolveTask(args);
  const summaryPath = path.join(task.taskDir, "summary.json");
  const summary = readJson(summaryPath, null);
  console.log(JSON.stringify({ task, summary }, null, 2));
}

function printTaskPath(args) {
  const task = resolveTask(args);
  console.log(task.taskDir);
}

async function validateAndSaveSid(args) {
  loadSavedSid(args);
  if (!args.sid) {
    throw new Error(`Missing SID. Pass --sid, for example: node bin/wos-export-wosids.js sid --sid "<SID>"`);
  }
  const browser = await chromium.launch({ headless: !args.headed });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(args.timeoutMs);
  try {
    const status = await validateSid(page, args);
    return {
      ok: true,
      sidSource: args.sidSource || "cli",
      config: configPath(args.tasksRoot),
      href: status.href,
      sid: "[saved]",
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
    if (args.help) {
      console.log(usage());
      return;
    }
    if (args.version) {
      console.log(VERSION);
      return;
    }
    if (args.command === "list") {
      listTasks(args);
      return;
    }
    if (args.command === "show") {
      showTask(args);
      return;
    }
    if (args.command === "path") {
      printTaskPath(args);
      return;
    }
    if (args.command === "validate") {
      const result = validateTask(args);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (args.command === "sid") {
      const result = await validateAndSaveSid(args);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (args.command === "authors") {
      if (!args.rebuildOnly) loadSavedSid(args);
      if (!args.sid && !args.rebuildOnly) {
        console.error(`Missing SID for authors command. Pass --sid once, or save it with: node bin/wos-export-wosids.js sid --sid "<SID>"`);
        process.exitCode = 2;
        return;
      }
      const result = await runAuthors(args);
      console.log(JSON.stringify(result, null, 2));
      if (result.failed) process.exitCode = 1;
      return;
    }
    if (args.command === "latest") {
      const latest = readLatestTaskId(args.tasksRoot);
      if (!latest) {
        console.error(`No latest task in ${args.tasksRoot}`);
        process.exitCode = 1;
        return;
      }
      console.log(latest);
      return;
    }
    if (args.command !== "run") {
      throw new Error(`Unknown command: ${args.command}`);
    }
    loadSavedSid(args);
    if (!args.sid || !args.url || !args.uuid || !args.outDir) {
      if (!args.sid) {
        console.error(`Missing SID. Pass --sid once, or save it with: node bin/wos-export-wosids.js sid --sid "<SID>"`);
        process.exitCode = 2;
        return;
      }
      console.error(usage());
      process.exitCode = 2;
      return;
    }
    const summary = await run(args);
    console.log(JSON.stringify({
      ok: summary.ok,
      expectedCount: summary.expectedCount,
      parsedCount: summary.parsedCount,
      uniqueCount: summary.uniqueCount,
      taskId: summary.taskId,
      runDir: summary.runDir,
      wosidsCsv: summary.files.wosidsCsv,
      summary: path.join(summary.runDir, "summary.json"),
    }, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    if (args?.taskId && args?.outDir && ["run", "authors"].includes(args.command)) {
      try {
        upsertTaskIndex(args, {
          status: "failed",
          lastError: error?.message || String(error),
        });
      } catch (_) {}
    }
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  run,
  runAuthors,
  validateTask,
  parseArgs,
  parseExportText,
  flattenAuthorRows,
  extractUuid,
  readTaskIndex,
  normalizeTaskId,
  getRunPaths,
  cleanRunLayout,
  rawBatchFiles,
  parseExistingRawBatches,
  readJson,
  writeJson,
};
