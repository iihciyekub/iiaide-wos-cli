const fs = require("fs");
const path = require("path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { readJson, writeFileAtomic, writeJson } = require("./lib/io");
const { confirmAction, interactiveArgs, isBackResult, isQuitResult, isUserAbortError, promptConfirmationText, promptSid } = require("./lib/interactive");
const { createProgress, createSpinner, isInteractive } = require("./lib/terminal");
const { updateCli } = require("./lib/update");
const { exportBibBatchesViaWosJs, exportTxtBatchesViaWosJs } = require("./lib/wos-browser-export");
const {
  defaultWosDataDbPath,
  existingWosDataIds,
  importWosDataRecord,
  linkExistingWosDataSources,
  mergeWosDataDatabase,
  queryWosDataByWosId,
  queryWosDataDatabase,
  wosDataDbStats,
} = require("./lib/wos-sqlite");
const { version: VERSION } = require("../package.json");

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_RECORD_TIMEOUT_MS = 20000;
const DEFAULT_WOS_PROTOCOL = "https";
const DEFAULT_WOS_DOMAIN = "www.webofscience.com";
const DEFAULT_BASE_URL = `${DEFAULT_WOS_PROTOCOL}://${DEFAULT_WOS_DOMAIN}`;
const DEFAULT_WOSJS_PATH = path.resolve(__dirname, "..", "import", "wos.js");
const HIDDEN_BROWSER_POSITION = "-32000,0";
const DEFAULT_TASK_ID_CONFIG = {
  prefix: "TID",
  pattern: "yyyyMMddHHmmss",
};
const CLI_STARTED_AT = Date.now();
let sharedWosSession = null;

class UserCancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserCancelledError";
    this.code = "USER_CANCELLED";
  }
}

class UserQuitError extends UserCancelledError {
  constructor(message) {
    super(message);
    this.name = "UserQuitError";
    this.code = "USER_QUIT";
  }
}

function isUserCancelledError(error) {
  return error?.code === "USER_CANCELLED" || error?.name === "UserCancelledError";
}

function isUserQuitError(error) {
  return error?.code === "USER_QUIT" || error?.name === "UserQuitError";
}

function usage() {
  return `
Usage:
  iiaide-wos menu
  iiaide-wos init [--tasks-root <dir>]
  iiaide-wos check [--sid <SID> | --from-browser] [--tasks-root <dir>] [--wos-domain <domain>] [--base-url <url>] [--headed]
  iiaide-wos workspace [--tasks-root <dir>]
  iiaide-wos update [--check]
  iiaide-wos run [--sid <SID>] (--url <summary-url> | --uuid <uuid>) [options]
  iiaide-wos bib [--sid <SID>] (--url <summary-url> | --uuid <uuid>) [options]
  iiaide-wos parse-pipeline [--sid <SID>] (--url <summary-url> | --uuid <uuid>) [options]
  iiaide-wos [--sid <SID>] (--url <summary-url> | --uuid <uuid>) [options]
  iiaide-wos import --csv <wosids.csv> [--task <task-id>] [options]
  iiaide-wos list [--tasks-root <dir>]
  iiaide-wos latest [--tasks-root <dir>]
  iiaide-wos show (--task <task-id> | --latest) [--tasks-root <dir>]
  iiaide-wos path (--task <task-id> | --latest) [--tasks-root <dir>]
  iiaide-wos validate (--task <task-id> | --latest) [--tasks-root <dir>]
  iiaide-wos clear (--task <task-id> | --latest) [--tasks-root <dir>]
  iiaide-wos sid [--sid <SID> | --from-browser] [--tasks-root <dir>] [--wos-domain <domain>] [--base-url <url>] [--headed]
  iiaide-wos parse [--sid <SID>] (--task <task-id> | --latest | --csv <wosids.csv>) [options]
  iiaide-wos wosdata (--merge-db <file> | --wosid <WOSID> | --query <sql>) [--db <file>] [--tasks-root <dir>]

Inputs:
  --sid <SID>             Web of Science SID. Interactive commands prompt when missing or expired
  --from-browser          Open a browser login window and auto-detect WOS SID
  --url <summary-url>     WOS summary URL
  --uuid <uuid>           WOS result-set UUID; used when --url is not provided
  --csv <file>            Existing CSV containing a wosid/UT column or WOS IDs in its first column
  --merge-db <file>       Merge records from another WOS SQLite database into --db
  --wosid <WOSID>         Query one WOS record from the SQLite database
  --query <sql>           Run a read-only SELECT query against the WOS SQLite database

Output management:
  --task <task-id>        Stable task id. If omitted, creates a timestamp-based task id
  --task-label <label>    Human label stored in task metadata
  --tasks-root <dir>      Parent directory for tasks. Default: ./tasks
  --db <file>             SQLite WOS data database. Default: ~/.iiaide-wos/wosdata.sqlite
  --out-dir <dir>         Exact task directory override
  --force                 Allow managed task replacement and overwrite existing SQLite WOS records
  --reuse-raw             Rebuild CSV from existing raw batches when present

Export options:
  --sort-by <sort>        Summary sort key. Default: relevance
  --batch-size <n>        WOS export API batch size. Default: 200, max: 500
  --timeout-ms <n>        Navigation/API timeout. Default: 120000
  --wos-domain <domain>   WOS domain. Default: www.webofscience.com
  --wosjs <file>          Browser-side wos.js injection file. Default: ./import/wos.js
  --base-url <url>        WOS origin URL. Default: https://www.webofscience.com
  --headed                Show browser instead of headless mode
  --version               Show CLI version
  --help                  Show this help
  --check                 Check for an update without installing it

Range options:
  --from-index <n>        Start from 1-based WOS record/WOSID index
  --limit <n>             Process only n records/WOS IDs

Parse options:
  --concurrency <n>       Parallel full-record pages. Default: 1
  --record-timeout-ms <n> Per-record full-page timeout. Default: 20000
  --cooldown-ms <n>       Delay after each record. Default: 250

Task directory layout:
  raw/<uuid>/full-record/ WOS fullRecord text batches as <uuid>_<start>_<end>.txt
  raw/<uuid>/full-record/<uuid>_wosid.csv
  raw/<uuid>/bib/         BibTeX batches as <uuid>_<start>_<end>.bib
  ~/.iiaide-wos/wosdata.sqlite
  export/<uuid>/bib/<uuid>.bib
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
    fromBrowser: false,
    url: "",
    urlHadProtocol: false,
    uuid: "",
    csvPath: "",
    mergeDbPath: "",
    queryWosId: "",
    sqlQuery: "",
    taskId: "",
    taskLabel: "",
    outDir: "",
    tasksRoot: path.resolve(process.cwd(), "tasks"),
    dbPath: "",
    sortBy: "relevance",
    batchSize: DEFAULT_BATCH_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    wosDomain: normalizeWosDomain(process.env.WOS_DOMAIN || DEFAULT_WOS_DOMAIN),
    wosJsPath: process.env.WOSJS_PATH || DEFAULT_WOSJS_PATH,
    baseUrl: process.env.WOS_BASE_URL
      ? stripTrailingSlash(process.env.WOS_BASE_URL)
      : wosOriginFromDomain(process.env.WOS_DOMAIN || DEFAULT_WOS_DOMAIN),
    baseUrlSource: process.env.WOS_BASE_URL ? "env" : (process.env.WOS_DOMAIN ? "domain-env" : ""),
    headed: false,
    force: false,
    reuseRaw: false,
    concurrency: 1,
    recordTimeoutMs: DEFAULT_RECORD_TIMEOUT_MS,
    limit: 0,
    fromIndex: 1,
    cooldownMs: 250,
    checkOnly: false,
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
    else if (arg === "--from-browser" || arg === "--browser-sid") args.fromBrowser = true;
    else if (arg === "--url") {
      args.url = readValue(arg, i++);
      args.urlHadProtocol = /^https?:\/\//i.test(args.url);
    }
    else if (arg === "--uuid") args.uuid = readValue(arg, i++);
    else if (arg === "--csv") args.csvPath = readValue(arg, i++);
    else if (arg === "--merge-db") args.mergeDbPath = readValue(arg, i++);
    else if (arg === "--wosid" || arg === "--wos-id") args.queryWosId = readValue(arg, i++);
    else if (arg === "--query" || arg === "--sql") args.sqlQuery = readValue(arg, i++);
    else if (arg === "--task") args.taskId = normalizeTaskId(readValue(arg, i++));
    else if (arg === "--latest") args.latest = true;
    else if (arg === "--task-label" || arg === "--label") args.taskLabel = readValue(arg, i++);
    else if (arg === "--out-dir" || arg === "--download-dir") args.outDir = readValue(arg, i++);
    else if (arg === "--tasks-root" || arg === "--output-root") args.tasksRoot = readValue(arg, i++);
    else if (arg === "--db") args.dbPath = readValue(arg, i++);
    else if (arg === "--sort-by") args.sortBy = readValue(arg, i++);
    else if (arg === "--batch-size") args.batchSize = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--timeout-ms" || arg === "--timeout") args.timeoutMs = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--wos-domain" || arg === "--domain") {
      args.wosDomain = normalizeWosDomain(readValue(arg, i++));
      args.baseUrl = wosOriginFromDomain(args.wosDomain);
      args.baseUrlSource = "domain-cli";
    }
    else if (arg === "--wosjs" || arg === "--wos-js") args.wosJsPath = path.resolve(readValue(arg, i++));
    else if (arg === "--base-url") {
      args.baseUrl = stripTrailingSlash(readValue(arg, i++));
      args.wosDomain = urlDomain(args.baseUrl) || args.wosDomain;
      args.baseUrlSource = "cli";
    }
    else if (arg === "--headed") args.headed = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--reuse-raw") args.reuseRaw = true;
    else if (arg === "--concurrency") args.concurrency = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--limit") args.limit = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--from-index") args.fromIndex = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--record-timeout-ms" || arg === "--record-timeout" || arg === "--page-timeout-ms") args.recordTimeoutMs = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--cooldown-ms") args.cooldownMs = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--check") args.checkOnly = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  args.baseUrl = stripTrailingSlash(args.baseUrl);
  args.wosDomain = urlDomain(args.baseUrl) || args.wosDomain;
  const inputSortBy = extractSummarySortBy(args.url || args.uuid);
  if (inputSortBy && args.sortBy === "relevance") args.sortBy = inputSortBy;
  if (args.uuid) args.uuid = extractUuid(args.uuid) || args.uuid;
  if (args.url && !args.uuid) args.uuid = extractUuid(args.url);
  if (args.url) args.url = normalizeSummaryUrl(args.baseUrl, args.url, args.uuid, args.sortBy);
  if (!args.url && args.uuid) args.url = buildSummaryUrl(args.baseUrl, args.uuid, args.sortBy);
  assertIntegerRange("--batch-size", args.batchSize, 1, 500);
  assertIntegerRange("--timeout-ms", args.timeoutMs, 5000);
  assertIntegerRange("--record-timeout-ms", args.recordTimeoutMs, 5000);
  assertIntegerRange("--concurrency", args.concurrency, 1, 10);
  assertIntegerRange("--limit", args.limit, 0);
  assertIntegerRange("--from-index", args.fromIndex, 1);
  assertIntegerRange("--cooldown-ms", args.cooldownMs, 0);
  args.tasksRoot = path.resolve(args.tasksRoot);
  if (args.csvPath) args.csvPath = path.resolve(args.csvPath);
  if (args.mergeDbPath) args.mergeDbPath = path.resolve(args.mergeDbPath);
  args.dbPath = args.dbPath ? path.resolve(args.dbPath) : defaultWosDataDbPath();
  if (!args.taskId && args.uuid) args.taskId = makeTaskId();
  if (!args.taskId && (command === "import" || command === "parse") && args.csvPath) args.taskId = makeTaskId();
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

function normalizeWosDomain(value) {
  const text = String(value || DEFAULT_WOS_DOMAIN).trim();
  if (!text) return DEFAULT_WOS_DOMAIN;
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `${DEFAULT_WOS_PROTOCOL}://${text}`).hostname;
  } catch (_) {
    return text.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim() || DEFAULT_WOS_DOMAIN;
  }
}

function wosOriginFromDomain(domain) {
  return `${DEFAULT_WOS_PROTOCOL}://${normalizeWosDomain(domain)}`;
}

function buildSidInitUrl(sid) {
  return `${DEFAULT_BASE_URL}/wos/?Init=Yes&SrcApp=CR&SID=${encodeURIComponent(sid || "")}`;
}

function urlOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch (_) {
    return "";
  }
}

function urlDomain(value) {
  try {
    return new URL(String(value || "")).hostname;
  } catch (_) {
    return "";
  }
}

function isWosRootRecordRedirect(value, baseUrl = DEFAULT_BASE_URL) {
  try {
    const current = new URL(String(value || ""));
    const base = new URL(String(baseUrl || DEFAULT_BASE_URL));
    const pathname = current.pathname.replace(/\/+$/, "") || "/";
    return current.origin === base.origin && pathname === "/wos";
  } catch (_) {
    return false;
  }
}

function extractUuid(value) {
  const text = String(value || "");
  const match =
    text.match(/\/summary\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[0-9a-f]{10})?)(?:[/?#]|$)/i) ||
    text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{10})/i) ||
    text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : "";
}

function buildSummaryUrl(baseUrl, uuid, sortBy) {
  return `${stripTrailingSlash(baseUrl)}/wos/woscc/summary/${encodeURIComponent(uuid)}/${encodeURIComponent(sortBy)}/1`;
}

function extractSummarySortBy(value) {
  const text = String(value || "");
  const uuid = extractUuid(text);
  if (!uuid) return "";
  const escapedUuid = uuid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`/summary/${escapedUuid}/([^/?#]+)(?:[/?#]|$)`, "i"));
  return match ? decodeURIComponent(match[1]) : "";
}

function normalizeSummaryUrl(baseUrl, value, uuid, sortBy) {
  const text = String(value || "").trim();
  if (!text) return uuid ? buildSummaryUrl(baseUrl, uuid, sortBy) : "";
  if (/^https?:\/\//i.test(text)) return text;
  if (uuid) return buildSummaryUrl(baseUrl, uuid, sortBy);
  if (text.startsWith("/wos/")) return `${stripTrailingSlash(baseUrl)}${text}`;
  return text;
}

function announceResolvedWosUuid(args, write = (message) => console.error(message)) {
  if (!args?.uuid || typeof write !== "function") return false;
  write(`Resolved WOS UUID: ${args.uuid}`);
  return true;
}

async function prepareWosExport(args) {
  announceResolvedWosUuid(args);
  loadSavedSid(args);
  return args.sid;
}

function formatTaskIdDate(date = new Date(), config = DEFAULT_TASK_ID_CONFIG) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  if (config.pattern !== "yyyyMMddHHmmss") {
    throw new Error(`Unsupported task id date pattern: ${config.pattern}`);
  }
  return [
    config.prefix || "",
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function makeTaskId(date = new Date()) {
  return normalizeTaskId(formatTaskIdDate(date));
}

function normalizeTaskId(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Task id must not be empty");
  const sanitized = raw
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!sanitized) throw new Error(`Invalid task id: ${raw}`);
  const taskId = sanitized.replace(/:+/g, "-").slice(0, 120);
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
    wosDomain: args.wosDomain || urlDomain(args.baseUrl) || DEFAULT_WOS_DOMAIN,
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
  if (config.baseUrl && !args.baseUrlSource) {
    args.baseUrl = stripTrailingSlash(config.baseUrl);
    args.wosDomain = config.wosDomain || urlDomain(args.baseUrl) || args.wosDomain;
  } else if (config.wosDomain && !args.baseUrlSource) {
    args.wosDomain = normalizeWosDomain(config.wosDomain);
    args.baseUrl = wosOriginFromDomain(args.wosDomain);
  }
  if (config.sid) {
    args.sid = config.sid;
    args.sidSource = "config";
  }
  return args.sid;
}

function maskSid(value) {
  const sid = String(value || "").trim();
  if (!sid) return "";
  if (sid.length <= 8) return `${sid.slice(0, 1)}***${sid.slice(-1)}`;
  return `${sid.slice(0, 4)}...${sid.slice(-4)}`;
}

async function quickValidateSid(args, options = {}) {
  loadSavedSid(args);
  const sid = args.sid;
  const sidSource = args.sidSource || "";
  const sidMasked = maskSid(sid);
  if (!sid) {
    return { status: "missing", sidSource, sidMasked, ok: false, message: "No SID configured" };
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { status: "unknown", sidSource, sidMasked, ok: false, message: "fetch is not available" };
  }

  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 3500);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const initUrl = buildSidInitUrl(sid);
  try {
    const response = await fetchImpl(initUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const text = await response.text().catch(() => "");
    const href = response.url || initUrl;
    const origin = urlOrigin(href);
    const haystack = `${href}\n${text}`.toLowerCase();
    if ([401, 403].includes(response.status) || /\b(logged out|session expired)\b/i.test(haystack)) {
      return { status: "invalid", sidSource, sidMasked, ok: false, href, origin, httpStatus: response.status, message: "SID was rejected by WOS" };
    }
    if (response.ok && text.includes(sid) && /sessionData|BasicProperties|SID/.test(text)) {
      return { status: "valid", sidSource, sidMasked, ok: true, href, origin, httpStatus: response.status, message: "SID accepted by WOS" };
    }
    return {
      status: "unknown",
      sidSource,
      sidMasked,
      ok: false,
      href,
      origin,
      httpStatus: response.status,
      message: /sign[ -]?in|login/i.test(haystack)
        ? "WOS returned a login page; startup check cannot confirm SID without browser cookies"
        : "WOS response did not expose enough SID evidence",
    };
  } catch (error) {
    return {
      status: "unknown",
      sidSource,
      sidMasked,
      ok: false,
      message: error?.name === "AbortError" ? "SID check timed out" : `SID check failed: ${error.message || error}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function wosUserDataDir(args) {
  return path.join(args.tasksRoot, ".browser-profile");
}

function wosProfileName(args) {
  return path.basename(wosUserDataDir(args));
}

function wosBrowserMode(args) {
  return args.headed ? "headed" : "background";
}

function resolveWosJsPath(args) {
  return path.resolve(args?.wosJsPath || process.env.WOSJS_PATH || DEFAULT_WOSJS_PATH);
}

function requireWosJsPath(args) {
  const filePath = resolveWosJsPath(args);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing WOSJS injection file: ${filePath}. Set --wosjs <file> or WOSJS_PATH.`);
  }
  return filePath;
}

async function ensureWosJsOnPage(page, args) {
  const loaded = await page.evaluate(() => Boolean(window.wos && window.WosUUID && window.asy_uuid)).catch(() => false);
  if (loaded) return true;
  await page.addScriptTag({ path: requireWosJsPath(args) });
  return page.evaluate(() => Boolean(window.wos && window.WosUUID && window.asy_uuid));
}

async function injectWosJs(context, args) {
  const filePath = requireWosJsPath(args);
  await context.addInitScript({ path: filePath });
  for (const page of context.pages()) {
    await ensureWosJsOnPage(page, args);
  }
  return filePath;
}

function wosBrowserLaunchOptions(args, visible = false) {
  return {
    headless: !visible,
    viewport: { width: 1280, height: 900 },
    args: visible ? [] : [`--window-position=${HIDDEN_BROWSER_POSITION}`],
  };
}

async function hideWosWindow(page) {
  await page.evaluate((position) => {
    const [x, y] = position.split(",").map((item) => Number(item));
    window.moveTo(Number.isFinite(x) ? x : -32000, Number.isFinite(y) ? y : 0);
  }, HIDDEN_BROWSER_POSITION).catch(() => {});
}

async function launchWosPersistentContext(args, visible = false) {
  fs.mkdirSync(args.tasksRoot, { recursive: true });
  const context = await chromium.launchPersistentContext(wosUserDataDir(args), wosBrowserLaunchOptions(args, visible));
  context.setDefaultTimeout(args.timeoutMs);
  await injectWosJs(context, args);
  return context;
}

async function closeSharedWosSession() {
  const session = sharedWosSession;
  sharedWosSession = null;
  await session?.context?.close().catch(() => {});
}

async function readSidFromLoginBrowser(args) {
  await closeSharedWosSession();
  const context = await launchWosPersistentContext(args, true);
  try {
    const page = context.pages()[0] || await context.newPage();
    const loginUrl = args.sid ? buildSidInitUrl(args.sid) : `${DEFAULT_BASE_URL}/wos/`;
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
    console.error("A browser window has opened. Log in to Web of Science there; iiaide-wos will continue after SID is detected.");
    const sid = await page.waitForFunction(
      () => window.sessionData?.BasicProperties?.SID || "",
      null,
      { timeout: Math.max(args.timeoutMs, 600000) }
    ).then((handle) => handle.jsonValue());
    if (!sid) throw new Error("No WOS SID detected after login");
    args.sid = String(sid).trim();
    args.sidSource = "browser";
    await hideWosWindow(page);
    saveSidConfig(args, args.sid);
    return String(sid).trim();
  } finally {
    await context.close().catch(() => {});
  }
}

async function readSidFromBrowser(args) {
  try {
    return await readSidFromLoginBrowser(args);
  } catch (error) {
    throw new Error(`Could not detect SID from the login browser: ${error.message || error}`);
  }
}

function canPromptForSid() {
  return process.stdin.isTTY && isInteractive(process.stdout);
}

async function ensureSid(args, message = "Enter a current WOS SID", prompt = promptSid, canPrompt = canPromptForSid) {
  loadSavedSid(args);
  if (args.sid) return args.sid;
  if (args.fromBrowser) {
    try {
      args.sid = await readSidFromBrowser(args);
      args.sidSource = "browser";
      return args.sid;
    } catch (error) {
      if (!canPrompt()) throw error;
      console.error(error.message || String(error));
    }
  }
  if (!canPrompt()) {
    throw new Error(`Missing SID. Pass --sid, set WOS_SID, or run: iiaide-wos sid`);
  }
  const sid = await prompt(message);
  if (isQuitResult(sid)) throw new UserQuitError("SID input quit by user");
  if (isBackResult(sid)) throw new UserCancelledError("SID input cancelled by user");
  if (!sid) throw new Error("SID must not be empty");
  args.sid = sid;
  args.sidSource = "prompt";
  return sid;
}

function writeTaskIndex(tasksRoot, index) {
  fs.mkdirSync(tasksRoot, { recursive: true });
  writeJson(taskIndexPath(tasksRoot), index, { backup: true });
}

function writeCurrentTaskId(tasksRoot, taskId) {
  writeFileAtomic(latestTaskPath(tasksRoot), taskId + "\n");
}

function initializeWorkspace(args) {
  const indexPath = taskIndexPath(args.tasksRoot);
  const initialized = !fs.existsSync(indexPath);
  fs.mkdirSync(args.tasksRoot, { recursive: true });
  if (!fs.existsSync(indexPath)) writeJson(indexPath, { version: 1, tasks: [] });
  return {
    ok: true,
    initialized,
    cwd: process.cwd(),
    tasksRoot: args.tasksRoot,
    index: indexPath,
  };
}

function createTaskPlaceholder(args, taskId = makeTaskId()) {
  const normalizedTaskId = normalizeTaskId(taskId);
  const taskDir = taskDirectory(args.tasksRoot, normalizedTaskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const manifest = path.join(taskDir, "manifest.json");
  if (!fs.existsSync(manifest)) {
    writeJson(manifest, {
      command: "iiaide-wos",
      operation: "current-task",
      task: {
        taskId: normalizedTaskId,
        taskDir,
        tasksRoot: args.tasksRoot,
      },
      createdAt: new Date().toISOString(),
    });
  }
  return upsertTaskIndex({
    ...args,
    taskId: normalizedTaskId,
    outDir: taskDir,
  }, { status: "created", lastError: "" });
}

function ensureCurrentTask(args) {
  initializeWorkspace(args);
  const index = readTaskIndex(args.tasksRoot);
  const tasks = Array.isArray(index.tasks) ? index.tasks : [];
  const latest = readLatestTaskId(args.tasksRoot);
  const latestTask = latest ? tasks.find((task) => task.taskId === latest) : null;
  if (latestTask) return latestTask;
  if (tasks.length) {
    writeCurrentTaskId(args.tasksRoot, tasks[0].taskId);
    return tasks[0];
  }
  return createTaskPlaceholder(args);
}

function setCurrentTaskId(args, taskId) {
  initializeWorkspace(args);
  const normalizedTaskId = normalizeTaskId(taskId);
  const index = readTaskIndex(args.tasksRoot);
  const existing = (index.tasks || []).find((task) => task.taskId === normalizedTaskId);
  if (existing) {
    writeCurrentTaskId(args.tasksRoot, normalizedTaskId);
    return existing;
  }
  return createTaskPlaceholder(args, normalizedTaskId);
}

function workspaceStatus(args, sidCheck = null) {
  const index = readTaskIndex(args.tasksRoot);
  const tasks = Array.isArray(index.tasks) ? index.tasks : [];
  const currentTask = readLatestTaskId(args.tasksRoot) || "";
  const config = readConfig(args.tasksRoot);
  const sid = args.sid || process.env.WOS_SID || config.sid || "";
  const sidSource = args.sidSource || (process.env.WOS_SID ? "env" : (config.sid ? "config" : ""));
  const baseUrl = args.baseUrlSource ? args.baseUrl : (config.baseUrl || args.baseUrl || DEFAULT_BASE_URL);
  const wosDomain = args.baseUrlSource
    ? (args.wosDomain || urlDomain(args.baseUrl) || DEFAULT_WOS_DOMAIN)
    : (config.wosDomain || urlDomain(baseUrl) || args.wosDomain || DEFAULT_WOS_DOMAIN);
  return {
    initialized: fs.existsSync(args.tasksRoot) && fs.existsSync(taskIndexPath(args.tasksRoot)),
    cwd: process.cwd(),
    tasksRoot: args.tasksRoot,
    baseUrl,
    wosDomain,
    wosOrigin: sidCheck?.origin || "",
    wosBrowserMode: wosBrowserMode(args),
    wosProfileName: wosProfileName(args),
    wosProfilePath: wosUserDataDir(args),
    runtimeMs: Date.now() - CLI_STARTED_AT,
    taskCount: tasks.length,
    currentTask,
    latestTask: currentTask,
    hasSavedSid: Boolean(sid),
    sidMasked: maskSid(sid),
    sidSource,
    sidCheck,
    wosDataDb: wosDataDbStats(args.dbPath),
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      status: task.status || "",
      uniqueCount: task.uniqueCount || 0,
      expectedCount: task.expectedCount || 0,
      uuid: task.uuid || "",
      label: task.label || "",
    })),
  };
}

function upsertTaskIndex(args, patch = {}) {
  const index = readTaskIndex(args.tasksRoot);
  if (!Array.isArray(index.tasks)) index.tasks = [];
  const now = new Date().toISOString();
  const existing = index.tasks.find((task) => task.taskId === args.taskId);
  const entry = {
    taskId: args.taskId,
    label: args.taskLabel || existing?.label || "",
    uuid: patch.uuid !== undefined ? patch.uuid : (args.uuid || existing?.uuid || ""),
    url: patch.url !== undefined ? patch.url : (args.url || existing?.url || ""),
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

function assertManagedTaskDirectory(taskDir) {
  if (!fs.existsSync(taskDir)) return;
  const manifest = readJson(path.join(taskDir, "manifest.json"), null);
  if (manifest?.command !== "iiaide-wos") {
    throw new Error(`Refusing to clear unmanaged task directory: ${taskDir}`);
  }
}

function rewriteLatestAfterTaskRemoval(tasksRoot, removedTaskId, remainingTasks) {
  const latestPath = latestTaskPath(tasksRoot);
  const latest = readLatestTaskId(tasksRoot);
  if (latest && latest !== removedTaskId) return latest;
  const nextLatest = remainingTasks[0]?.taskId || "";
  if (nextLatest) {
    writeFileAtomic(latestPath, nextLatest + "\n");
  } else {
    fs.rmSync(latestPath, { force: true });
  }
  return nextLatest;
}

function clearTask(args) {
  const task = resolveTask(args);
  assertManagedTaskDirectory(task.taskDir);

  const index = readTaskIndex(args.tasksRoot);
  const remainingTasks = (index.tasks || []).filter((entry) => entry.taskId !== task.taskId);
  fs.rmSync(task.taskDir, { recursive: true, force: true });
  index.tasks = remainingTasks;
  writeTaskIndex(args.tasksRoot, index);
  const latestTask = rewriteLatestAfterTaskRemoval(args.tasksRoot, task.taskId, remainingTasks);

  return {
    ok: true,
    taskId: task.taskId,
    taskDir: task.taskDir,
    latestTask,
  };
}

async function confirmAndClearTask(args, prompt = promptConfirmationText, report = console.error) {
  const task = resolveTask(args);
  report(`Task to clear: ${task.taskId}`);
  report(`Task directory: ${task.taskDir}`);
  const answer = await prompt(`Type task id "${task.taskId}" to confirm clear`);
  if (isQuitResult(answer)) throw new UserQuitError("Task clear quit by user");
  if (isBackResult(answer) || answer !== task.taskId) {
    throw new UserCancelledError(`Task clear cancelled: ${task.taskId}`);
  }
  return clearTask(args);
}

function readLatestTaskId(tasksRoot) {
  try {
    return fs.readFileSync(latestTaskPath(tasksRoot), "utf8").trim();
  } catch (_) {
    return "";
  }
}

function getRunPaths(outDir) {
  const rawRoot = path.join(outDir, "raw");
  const exportRoot = path.join(outDir, "export");
  return {
    taskDir: outDir,
    runDir: outDir,
    rawRoot,
    exportRoot,
    rawDir: rawRoot,
    bibDir: rawRoot,
    dataDir: exportRoot,
    logsDir: path.join(outDir, "logs"),
    manifest: path.join(outDir, "manifest.json"),
    summary: path.join(outDir, "summary.json"),
    progressLog: path.join(outDir, "logs", "progress.jsonl"),
  };
}

function withRawSource(paths, sourceId) {
  const source = safeFilePart(sourceId || "task");
  const rawSourceDir = path.join(paths.rawRoot || path.join(paths.taskDir, "raw"), source);
  const exportSourceDir = path.join(paths.exportRoot || path.join(paths.taskDir, "export"), source);
  const fullRecordDir = path.join(rawSourceDir, "full-record");
  const bibExportDir = path.join(exportSourceDir, "bib");
  return {
    ...paths,
    rawSourceId: source,
    rawSourceDir,
    exportSourceDir,
    wosIdsDir: fullRecordDir,
    bibExportDir,
    rawDir: fullRecordDir,
    bibDir: path.join(rawSourceDir, "bib"),
    dataDir: fullRecordDir,
    parseFailures: path.join(fullRecordDir, `${source}_parse_failures.json`),
  };
}

function createRunLayout(args) {
  if (fs.existsSync(args.outDir) && !args.force) {
    const entries = fs.readdirSync(args.outDir).filter((name) => name !== ".DS_Store");
    if (entries.length) {
      const manifest = readJson(path.join(args.outDir, "manifest.json"), null);
      if (manifest?.command !== "iiaide-wos") {
        throw new Error(`Output directory is not empty: ${args.outDir}. Use --force or choose another --out-dir.`);
      }
    }
  }

  const paths = getRunPaths(args.outDir);
  for (const dir of [
    paths.rawRoot,
    paths.exportRoot,
    paths.logsDir,
  ]) fs.mkdirSync(dir, { recursive: true });
  return paths;
}

function sameTaskUuid(summary, args) {
  return !summary?.uuid || !args.uuid || summary.uuid === args.uuid;
}

function readCompletedRunSummary(paths, args) {
  const summary = readJson(paths.summary, null);
  if (!summary?.ok || summary.method !== "wos-js-export-fetchTxtBatches" || !sameTaskUuid(summary, args)) return null;
  const sourcePaths = withRawSource(paths, summary.uuid || args.uuid || args.taskId);
  const csvPath = resolveWosIdsCsvPath(sourcePaths, summary.uuid || args.uuid || args.taskId);
  return fs.existsSync(csvPath)
    ? { ...summary, files: { ...(summary.files || {}), wosidsCsv: csvPath } }
    : null;
}

function readCompletedBibSummary(paths, args) {
  const summary = readJson(paths.summary, null);
  if (!summary?.ok || summary.method !== "wos-js-export-fetchBibBatches" || !sameTaskUuid(summary, args)) return null;
  const sourcePaths = withRawSource(paths, summary.uuid || args.uuid);
  const bibPath = summary.files?.bibFile || bibFilePath(sourcePaths, summary.uuid || args.uuid);
  return fs.existsSync(bibPath) ? summary : null;
}

function readCompletedArtifactSummary(args) {
  if (args.force || !args.outDir) return null;
  const paths = getRunPaths(args.outDir);
  if (args.command === "bib") return readCompletedBibSummary(paths, args);
  if (args.command === "run" || args.command === "parse-pipeline") return readCompletedRunSummary(paths, args);
  return null;
}

function printCompletedArtifactPath(command, summary) {
  if (command === "bib") {
    console.error("BibTeX already exists; skipping download.");
    console.log(summary.files.bibFile);
    return summary.ok ? 0 : 1;
  }
  console.error("WOS ID CSV already exists; skipping download.");
  console.log(summary.files.wosidsCsv);
  return summary.ok ? 0 : 1;
}

function cleanRunLayout(paths) {
  const manifest = readJson(paths.manifest, null);
  if (manifest?.command !== "iiaide-wos") {
    throw new Error(`Refusing to clean unmanaged output directory: ${paths.taskDir}`);
  }
  for (const directory of [
    paths.rawRoot || path.join(paths.taskDir, "raw"),
    paths.exportRoot || path.join(paths.taskDir, "export"),
    paths.logsDir,
  ].filter(Boolean)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  for (const filePath of [paths.manifest, paths.summary]) {
    fs.rmSync(filePath, { force: true });
  }
}

function manifestArgs(args) {
  return {
    ...args,
    sid: args.sid ? "[redacted]" : "",
  };
}

function wosIdsCsvPath(paths, identifier) {
  if (!identifier) throw new Error("Missing WOSID CSV identifier");
  return path.join(paths.wosIdsDir || paths.rawDir || paths.dataDir, `${safeFilePart(identifier)}_wosid.csv`);
}

function resolveWosIdsCsvPath(paths, identifier, explicitPath = "") {
  if (explicitPath) return explicitPath;
  return wosIdsCsvPath(paths, identifier);
}

function bibFilePath(paths, uuid) {
  if (!uuid) throw new Error("Missing BibTeX UUID");
  return path.join(paths.bibExportDir || paths.dataDir, `${safeFilePart(uuid)}.bib`);
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

function parseBibEntryCount(text) {
  const matches = String(text || "").match(/^@(?!comment\b|string\b|preamble\b)[A-Za-z]+\s*\{/gim);
  return matches ? matches.length : 0;
}

function parseWosCount(value) {
  return Number(String(value || "").replace(/,/g, "").match(/\d+/)?.[0] || 0);
}

function downloadBatchCount(recordCount, batchSize = DEFAULT_BATCH_SIZE) {
  const total = Math.max(0, Number(recordCount) || 0);
  const size = Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE);
  return total ? Math.ceil(total / size) : 0;
}

function boundedRecordCount(totalRecords, startIndex = 1, limit = 0) {
  const total = Math.max(0, Number(totalRecords) || 0);
  const start = Math.max(1, Number(startIndex) || 1);
  if (!total || start > total) return 0;
  const end = limit
    ? Math.min(start + Math.max(0, Number(limit) || 0) - 1, total)
    : total;
  return Math.max(0, end - start + 1);
}

async function confirmDownloadPlan(label, availableCount, selectedCount, batchSize = DEFAULT_BATCH_SIZE) {
  const batches = downloadBatchCount(selectedCount, batchSize);
  console.error(`${label} available: ${availableCount}`);
  console.error(`${label} to download: ${selectedCount}`);
  console.error(`${label} batches: ${batches} x ${batchSize} records`);
  const confirmed = await confirmAction(`Continue ${label.toLowerCase()} download?`);
  if (isQuitResult(confirmed)) throw new UserQuitError(`${label} download quit by user`);
  if (!confirmed) throw new UserCancelledError(`${label} download cancelled by user`);
  return { batches };
}

function normalizeWosId(value) {
  const match = String(value || "").match(/WOS:[A-Z0-9]+/i);
  return match ? match[0].toUpperCase() : "";
}

function readWosIdsCsv(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  if (!rows.length) return [];
  const headerIndex = rows[0].findIndex((cell) => /^(wos[\s_-]*id|ut)$/i.test(cell.trim()));
  const start = headerIndex >= 0 ? 1 : 0;
  const columnIndex = headerIndex >= 0 ? headerIndex : 0;
  const seen = new Set();
  return rows.slice(start).map((row) => {
    return normalizeWosId(row[columnIndex]);
  }).filter((wosid) => {
    if (!wosid || seen.has(wosid)) return false;
    seen.add(wosid);
    return true;
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const input = String(text || "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function existingWosDataState(paths, wosids, args = {}) {
  const globalIds = existingWosDataIds(args.dbPath, wosids);
  return { globalIds };
}

function hasExistingWosData(state, wosid) {
  const normalized = normalizeWosId(wosid);
  return Boolean(normalized && state.globalIds.has(normalized));
}

function selectParseWork(paths, wosids, args) {
  let indexed = wosids.map((wosid, index) => ({ wosid, index: index + 1 }));
  indexed = indexed.filter((item) => item.index >= args.fromIndex);
  if (!args.force) {
    const state = existingWosDataState(paths, wosids, args);
    indexed = indexed.filter((item) => !hasExistingWosData(state, item.wosid));
  }
  if (args.limit) indexed = indexed.slice(0, args.limit);
  return indexed;
}

function parseStats(paths, wosids, args = {}) {
  const state = existingWosDataState(paths, wosids, args);
  const completed = wosids.filter((wosid) => hasExistingWosData(state, wosid)).length;
  return { completed, missing: Math.max(0, wosids.length - completed) };
}

function parseWorkSummary(paths, wosids, work, args) {
  const stats = parseStats(paths, wosids, args);
  const firstIndex = work[0]?.index || 0;
  const lastIndex = work[work.length - 1]?.index || 0;
  return {
    total: wosids.length,
    completed: stats.completed,
    skipped: stats.completed,
    missing: stats.missing,
    selected: work.length,
    firstIndex,
    lastIndex,
    concurrency: args.concurrency,
  };
}

function printParseWorkSummary(summary, write = console.error) {
  const range = summary.selected ? `${summary.firstIndex}-${summary.lastIndex}` : "none";
  write(
    `WOS data records: total=${summary.total}, skipped=${summary.skipped}, missing=${summary.missing}, selected=${summary.selected}, range=${range}, concurrency=${summary.concurrency}`
  );
}

function importParsedWosData(args, taskId, wosids = []) {
  const linked = linkExistingWosDataSources({
    dbPath: args.dbPath,
    wosids,
    taskId,
  });
  return {
    ok: true,
    dbPath: args.dbPath,
    taskId,
    total: 0,
    imported: 0,
    skipped: 0,
    linked: linked.linked || 0,
    sourceLinked: linked.linked || 0,
  };
}

function runWosDataImport(args) {
  if (args.queryWosId) {
    return queryWosDataByWosId({
      dbPath: args.dbPath,
      wosid: args.queryWosId,
    });
  }
  if (args.sqlQuery) {
    return queryWosDataDatabase({
      dbPath: args.dbPath,
      sql: args.sqlQuery,
      limit: args.limit || 50,
    });
  }
  if (args.mergeDbPath) {
    return mergeWosDataDatabase({
      dbPath: args.dbPath,
      sourceDbPath: args.mergeDbPath,
      force: args.force,
    });
  }
  throw new Error("Missing wosdata operation: use --merge-db, --wosid, or --query");
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

function batchFileName(uuid, markFrom, markTo, extension = "txt") {
  return `${safeFilePart(uuid)}_${markFrom}_${markTo}.${extension}`;
}

function rawBatchDir(paths, uuid) {
  if (!uuid) throw new Error("Missing raw batch UUID");
  const safeUuid = safeFilePart(uuid);
  return path.join(paths.rawRoot || path.join(paths.taskDir, "raw"), safeUuid, "full-record");
}

function rawBatchPath(paths, uuid, markFrom, markTo) {
  return path.join(rawBatchDir(paths, uuid), batchFileName(uuid, markFrom, markTo));
}

function bibBatchDir(paths, uuid) {
  if (!uuid) throw new Error("Missing BibTeX batch UUID");
  const safeUuid = safeFilePart(uuid);
  return path.join(paths.rawRoot || path.join(paths.taskDir, "raw"), safeUuid, "bib");
}

function bibBatchPath(paths, uuid, markFrom, markTo) {
  return path.join(bibBatchDir(paths, uuid), batchFileName(uuid, markFrom, markTo, "bib"));
}

function batchFileStart(fileName) {
  return Number(String(fileName || "").match(/_(\d+)_(\d+)\.[^.]+$/)?.[1] || 0);
}

function rawBatchFiles(paths, uuid) {
  if (!uuid) throw new Error("Missing raw batch UUID");
  const directory = rawBatchDir(paths, uuid);
  if (!fs.existsSync(directory)) return [];
  const prefix = `${safeFilePart(uuid)}_`;
  return fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && /_(\d+)_(\d+)\.txt$/.test(name))
    .sort((a, b) => batchFileStart(a) - batchFileStart(b));
}

function bibBatchFiles(paths, uuid) {
  if (!uuid) throw new Error("Missing BibTeX batch UUID");
  const directory = bibBatchDir(paths, uuid);
  if (!fs.existsSync(directory)) return [];
  const prefix = `${safeFilePart(uuid)}_`;
  return fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && /_(\d+)_(\d+)\.bib$/.test(name))
    .sort((a, b) => batchFileStart(a) - batchFileStart(b));
}

function rawBatchCoverage(paths, uuid) {
  const files = rawBatchFiles(paths, uuid);
  let previousEnd = 0;
  let firstStart = 0;
  for (const fileName of files) {
    const match = fileName.match(/_(\d+)_(\d+)\.txt$/);
    const batchStart = Number(match[1]);
    const batchEnd = Number(match[2]);
    if (!firstStart) firstStart = batchStart;
    if (batchStart !== previousEnd + 1) {
      throw new Error(`Non-contiguous raw batches detected: ${fileName}`);
    }
    if (batchEnd < batchStart) {
      throw new Error(`Invalid raw batch range detected: ${fileName}`);
    }
    previousEnd = batchEnd;
  }
  return { files, firstStart, lastEnd: previousEnd };
}

function parseExistingRawBatches(paths, uuid) {
  const rows = [];
  const { files } = rawBatchCoverage(paths, uuid);
  for (const fileName of files) {
    const match = fileName.match(/_(\d+)_(\d+)\.txt$/);
    const batchStart = Number(match[1]);
    const batchEnd = Number(match[2]);
    const text = fs.readFileSync(path.join(rawBatchDir(paths, uuid), fileName), "utf8");
    rows.push(...parseExportText(text, batchStart, batchEnd));
  }
  return rows;
}

function canRepairWosIdsFromRaw(paths, uuid, expectedCount) {
  if (!uuid || !rawBatchFiles(paths, uuid).length || !expectedCount) return false;
  const coverage = rawBatchCoverage(paths, uuid);
  return Boolean(coverage.files.length && coverage.firstStart === 1 && coverage.lastEnd >= expectedCount);
}

function finalWosIdsCsvExists(paths, identifier) {
  if (!identifier) return false;
  const sourcePaths = withRawSource(paths, identifier);
  return fs.existsSync(resolveWosIdsCsvPath(sourcePaths, identifier));
}

function finalBibExists(paths, uuid) {
  if (!uuid) return false;
  return fs.existsSync(bibFilePath(withRawSource(paths, uuid), uuid));
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

  const outputId = meta.uuid || meta.taskId;
  const outputPaths = withRawSource(paths, outputId);
  const csvPath = wosIdsCsvPath(outputPaths, outputId);
  writeFileAtomic(csvPath, toCsv(uniqueRows.map((row) => ({ wosid: row.wosid })), ["wosid"]));

  const summary = {
    ok: !meta.expectedCount || uniqueRows.length === meta.expectedCount,
    method: "wos-js-export-fetchTxtBatches",
    ...meta,
    parsedCount: rows.length,
    uniqueCount: uniqueRows.length,
    files: {
      wosidsCsv: csvPath,
      rawDir: rawBatchDir(paths, meta.uuid || meta.taskId),
      wosIdsDir: outputPaths.wosIdsDir,
      progressLog: paths.progressLog,
    },
    finishedAt: new Date().toISOString(),
  };
  writeJson(paths.summary, summary);
  return summary;
}

async function validateSid(page, args) {
  const initUrl = buildSidInitUrl(args.sid);
  await page.goto(initUrl, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await ensureWosJsOnPage(page, args);
  const status = await page.evaluate(() => ({
    href: location.href,
    origin: location.origin,
    sid: window.sessionData?.BasicProperties?.SID || "",
  }));
  if (!status.sid || status.sid !== args.sid) {
    if (args.sidSource === "config") {
      throw new Error(
        `Saved SID is invalid or expired. Pass a fresh SID with --sid, or run: iiaide-wos sid --sid "<SID>". observedSid=${status.sid || "(missing)"} href=${status.href}`
      );
    }
    throw new Error(`SID validation failed. observedSid=${status.sid || "(missing)"} href=${status.href}`);
  }
  if (status.origin) args.baseUrl = stripTrailingSlash(status.origin);
  saveSidConfig(args, status.sid);
  return status;
}

async function detectSidFromPage(page, args) {
  const sid = await page.waitForFunction(
    () => window.sessionData?.BasicProperties?.SID || "",
    null,
    { timeout: Math.max(args.timeoutMs, 600000) }
  ).then((handle) => handle.jsonValue());
  return String(sid || "").trim();
}

async function loginForFreshSid(args, report = console.error) {
  await closeSharedWosSession();
  const visibleContext = await launchWosPersistentContext(args, true);
  try {
    const page = visibleContext.pages()[0] || await visibleContext.newPage();
    page.setDefaultTimeout(args.timeoutMs);
    const loginUrl = args.sid ? buildSidInitUrl(args.sid) : `${DEFAULT_BASE_URL}/wos/`;
    report("WOS SID is missing or invalid. A visible WOS browser window is open; log in there and iiaide-wos will continue automatically.");
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
    const sid = await detectSidFromPage(page, args);
    if (!sid) throw new Error("No WOS SID detected after login");
    args.sid = sid;
    args.sidSource = "browser";
    await hideWosWindow(page);
    saveSidConfig(args, sid);
    return sid;
  } finally {
    await visibleContext.close().catch(() => {});
  }
}

async function prepareWosSession(args, options = {}) {
  loadSavedSid(args);
  const keepAlive = Boolean(options.keepAlive || args.keepWosSession);
  const report = options.report || console.error;
  const visible = Boolean(options.visible || args.headed);
  if (keepAlive && sharedWosSession?.context) {
    const page = sharedWosSession.page || sharedWosSession.context.pages()[0] || await sharedWosSession.context.newPage();
    sharedWosSession.page = page;
    page.setDefaultTimeout(args.timeoutMs);
    try {
      const status = await validateSid(page, args);
      applyValidatedWosOrigin(args, status);
      return { context: sharedWosSession.context, page, status, close: async () => {} };
    } catch (_) {
      await closeSharedWosSession();
    }
  }

  let context = await launchWosPersistentContext(args, visible);
  let page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(args.timeoutMs);
  let status = null;
  try {
    if (!args.sid) {
      await context.close().catch(() => {});
      await loginForFreshSid(args, report);
      context = await launchWosPersistentContext(args, visible);
      page = context.pages()[0] || await context.newPage();
      page.setDefaultTimeout(args.timeoutMs);
    }
    status = await validateSid(page, args);
  } catch (error) {
    await context.close().catch(() => {});
    await loginForFreshSid(args, report);
    context = await launchWosPersistentContext(args, visible);
    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(args.timeoutMs);
    status = await validateSid(page, args);
  }

  applyValidatedWosOrigin(args, status);
  if (!visible) await hideWosWindow(page);
  if (keepAlive) {
    sharedWosSession = { context, page };
    return { context, page, status, close: async () => {} };
  }
  return { context, page, status, close: async () => context.close().catch(() => {}) };
}

function applyValidatedWosOrigin(args, status) {
  const origin = status?.origin || "";
  if (!origin || !args?.uuid || args.urlHadProtocol) return false;
  args.baseUrl = stripTrailingSlash(origin);
  args.url = buildSummaryUrl(args.baseUrl, args.uuid, args.sortBy);
  return true;
}

async function validateSidWithRetry(
  page,
  args,
  prompt = promptSid,
  canPrompt = canPromptForSid,
  report = console.error
) {
  try {
    return await validateSid(page, args);
  } catch (error) {
    if (!canPrompt()) throw error;
    report(`WOS SID is invalid or expired: ${error.message || error}`);
    const sid = await prompt("Enter a new WOS SID to validate and save");
    if (isQuitResult(sid)) throw new UserQuitError("SID update quit by user");
    if (isBackResult(sid)) throw new UserCancelledError("SID update cancelled by user");
    if (!sid) throw new Error("SID update cancelled");
    args.sid = sid;
    args.sidSource = "prompt";
    return validateSid(page, args);
  }
}

async function readSummaryInfo(page, args) {
  await page.waitForSelector('div[data-ta="search-info"]', { state: "attached", timeout: args.timeoutMs });
  await ensureWosJsOnPage(page, args);
  return page.evaluate(() => {
    const normalizeInfo = (info) => ({
      uuid: info?.uuid || "",
      expectedCount: Number(String(info?.ref_count || info?.countText || "").replace(/,/g, "").match(/\d+/)?.[0] || 0),
      countText: info?.ref_count || info?.countText || "",
      rowText: info?.rowText || "",
      href: location.href,
      status: info?.status || "",
    });
    if (!window.asy_uuid?.fetchCurrentPageInfo) {
      throw new Error("wos.js summary API missing: window.asy_uuid.fetchCurrentPageInfo");
    }
    return window.asy_uuid.fetchCurrentPageInfo("iiaide-wos summary").then(normalizeInfo);
  });
}

async function prepareWosRequestContext(page, args) {
  await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await ensureWosJsOnPage(page, args);
  const context = await page.evaluate(() => {
    const normalizeInfo = (info) => ({
      href: location.href,
      origin: location.origin,
      sid: window.sessionData?.BasicProperties?.SID || "",
      uuid: info?.uuid || "",
      countText: info?.ref_count || "",
      rowText: info?.rowText || "",
      status: info?.status || "",
    });
    if (!window.asy_uuid?.fetchCurrentPageInfo) {
      throw new Error("wos.js summary API missing: window.asy_uuid.fetchCurrentPageInfo");
    }
    return window.asy_uuid.fetchCurrentPageInfo("iiaide-wos request context").then(normalizeInfo);
  });
  return { ...context, expectedCount: parseWosCount(context.countText) };
}

function pageContextUuid(context, fallbackUuid) {
  return context?.uuid || fallbackUuid || "";
}

async function exportFromWos(args, paths) {
  const authSpinner = createSpinner("Validating WOS authentication");
  let session = null;
  const rows = [];
  let info = null;
  let batchProgress = null;
  let summarySpinner = null;
  try {
    session = await prepareWosSession(args);
    const page = session.page;
    authSpinner.succeed("WOS authentication validated");
    appendProgress(paths, { phase: "sid-validated" });
    const context = await prepareWosRequestContext(page, args);
    appendProgress(paths, {
      phase: "wos-request-context",
      href: context.href,
      uuid: context.uuid || args.uuid,
      inputUuid: args.uuid,
      countText: context.countText,
    });
    summarySpinner = createSpinner("Reading WOS summary information");
    info = await readSummaryInfo(page, args);
    if (!info.uuid || !info.expectedCount) {
      summarySpinner.fail("Could not read WOS summary information");
      throw new Error(`Could not read summary uuid/count: ${JSON.stringify(info)}`);
    }
    summarySpinner.succeed(`Found ${info.expectedCount} records`);
    appendProgress(paths, { phase: "summary-info", ...info });
    const batchSize = DEFAULT_BATCH_SIZE;
    const { batches: batchCount } = await confirmDownloadPlan(
      "WOS records",
      info.expectedCount,
      info.expectedCount,
      batchSize
    );
    appendProgress(paths, {
      phase: "download-confirmed",
      label: "WOS records",
      availableCount: info.expectedCount,
      selectedCount: info.expectedCount,
      batchCount,
      batchSize,
    });
    batchProgress = createProgress("Exporting records", batchCount);
    const exportResult = await exportTxtBatchesViaWosJs(page, {
      uuid: info.uuid,
      markFrom: 1,
      markTo: info.expectedCount,
      batchSize,
      sortBy: args.sortBy,
      onProgress(event) {
        appendProgress(paths, { phase: "wosjs-export-progress", ...event });
        if (event.phase === "start" && event.totalBatches) {
          batchProgress.setTotal(event.totalBatches);
        }
        if (event.phase === "batch") {
          batchProgress.update(event.completedBatches || 0, `${event.current}-${event.batchEnd}`);
        }
      },
    });

    for (const batch of exportResult.batches) {
      const rawPath = rawBatchPath(paths, info.uuid, batch.markFrom, batch.markTo);
      let text = batch.text;
      if (args.reuseRaw && fs.existsSync(rawPath)) {
        text = fs.readFileSync(rawPath, "utf8");
      } else {
        writeFileAtomic(rawPath, text);
      }
      const ids = parseExportText(text, batch.markFrom, batch.markTo);
      rows.push(...ids);
      appendProgress(paths, { phase: "batch", markFrom: batch.markFrom, markTo: batch.markTo, parsed: ids.length, rawPath });
      if (!isInteractive()) console.error(`export ${batch.markFrom}-${batch.markTo}: parsed ${ids.length} WOS IDs`);
    }
    batchProgress.stop("Export complete");
  } finally {
    authSpinner.stop();
    summarySpinner?.stop();
    batchProgress?.stop("Export stopped");
    await session?.close?.();
  }
  return {
    rows,
    info,
  };
}

async function exportBibFromWos(args, paths) {
  const authSpinner = createSpinner("Validating WOS authentication");
  let session = null;
  let progress = null;
  const files = [];
  let uuid = args.uuid;
  const startIndex = args.fromIndex || 1;
  const requestedCount = args.limit || 0;
  let bounded = requestedCount > 0;
  let finalIndex = bounded ? startIndex + requestedCount - 1 : 0;
  let expectedCount = 0;
  let selectedCount = 0;
  let downloadedEntries = 0;
  let completedBatches = 0;
  try {
    session = await prepareWosSession(args);
    const page = session.page;
    authSpinner.succeed("WOS authentication validated");
    appendProgress(paths, { phase: "sid-validated" });
    const context = await prepareWosRequestContext(page, args);
    uuid = pageContextUuid(context, uuid);
    if (!uuid) throw new Error(`Could not resolve a WOS record-query UUID from ${args.url}`);
    if (context.uuid && context.uuid !== args.uuid) {
      console.error(`Resolved page WOS UUID: ${context.uuid}`);
    }
    expectedCount = context.expectedCount || 0;
    if (!expectedCount) {
      throw new Error(`Could not read WOS summary record count for BibTeX export: ${JSON.stringify(context)}`);
    }
    const lastAvailableIndex = expectedCount;
    finalIndex = requestedCount
      ? Math.min(startIndex + requestedCount - 1, lastAvailableIndex)
      : lastAvailableIndex;
    if (finalIndex < startIndex) {
      throw new Error(`BibTeX range starts after available WOS records: start=${startIndex} total=${expectedCount}`);
    }
    bounded = finalIndex >= startIndex;
    selectedCount = boundedRecordCount(expectedCount, startIndex, requestedCount);
    appendProgress(paths, {
      phase: "wos-request-context",
      href: context.href,
      uuid,
      inputUuid: args.uuid,
      countText: context.countText,
      expectedCount,
    });
    appendProgress(paths, {
      phase: "bib-request-mode",
      uuid,
      markFrom: startIndex,
      markTo: finalIndex || "",
      batchSize: DEFAULT_BATCH_SIZE,
    });
    const batchSize = DEFAULT_BATCH_SIZE;
    const { batches: totalBatches } = await confirmDownloadPlan(
      "WOS BibTeX records",
      expectedCount,
      selectedCount,
      batchSize
    );
    appendProgress(paths, {
      phase: "download-confirmed",
      label: "WOS BibTeX records",
      availableCount: expectedCount,
      selectedCount,
      batchCount: totalBatches,
      batchSize,
    });
    progress = createProgress(
      "Downloading WOS BibTeX",
      totalBatches || 1
    );
    const exportResult = await exportBibBatchesViaWosJs(page, {
      uuid,
      markFrom: startIndex,
      markTo: finalIndex || 0,
      batchSize,
      sortBy: args.sortBy,
      filters: "authorTitleSource",
      onProgress(event) {
        appendProgress(paths, { phase: "wosjs-bib-progress", ...event });
        if (event.phase === "start" && event.totalBatches) {
          progress.setTotal(event.totalBatches);
        }
        if (event.phase === "batch") {
          progress.update(event.completedBatches || 0, `${event.current}-${event.batchEnd}`);
        }
      },
    });
    if (!expectedCount && exportResult.totalRecords) expectedCount = exportResult.totalRecords;

    for (const batch of exportResult.batches) {
      const entryCount = parseBibEntryCount(batch.text);
      if (!entryCount) {
        appendProgress(paths, { phase: "bib-empty-batch", markFrom: batch.markFrom, requestedMarkTo: batch.markTo });
        if (!files.length) throw new Error(`No BibTeX entries returned for UUID ${uuid} at ${batch.markFrom}-${batch.markTo}`);
        if (!isInteractive()) console.error(`bib export ${batch.markFrom}-${batch.markTo}: no entries`);
        break;
      }
      const markTo = batch.markFrom + entryCount - 1;
      const bibPath = bibBatchPath(paths, uuid, batch.markFrom, markTo);
      writeFileAtomic(bibPath, batch.text);
      files.push(bibPath);
      downloadedEntries += entryCount;
      completedBatches += 1;
      appendProgress(paths, {
        phase: "bib-batch",
        markFrom: batch.markFrom,
        markTo,
        requestedMarkTo: batch.markTo,
        entries: entryCount,
        bibPath,
      });
      progress.update(completedBatches, `${batch.markFrom}-${markTo}: ${entryCount} entries`);
      if (!isInteractive()) console.error(`bib export ${batch.markFrom}-${markTo}: ${entryCount} entries -> ${bibPath}`);
    }
    if (selectedCount && downloadedEntries < selectedCount) {
      throw new Error(`Incomplete BibTeX export for UUID ${uuid}: downloaded ${downloadedEntries}/${selectedCount} records`);
    }
    progress.stop("WOS BibTeX download complete");
  } finally {
    authSpinner.stop();
    progress?.stop("WOS BibTeX download stopped");
    await session?.close?.();
  }
  return {
    info: {
      uuid,
      expectedCount: expectedCount || downloadedEntries,
      selectedCount,
      downloadedEntries,
      requestedCount,
      href: args.url,
      rowText: bounded ? `${startIndex}-${finalIndex}` : "",
      requestMode: true,
      completedBatches,
    },
    files,
  };
}

function combineBibFiles(paths, uuid, files) {
  const outputPaths = withRawSource(paths, uuid);
  const combinedPath = bibFilePath(outputPaths, uuid);
  const combined = files
    .map((filePath) => fs.readFileSync(filePath, "utf8").trim())
    .filter(Boolean)
    .join("\n\n");
  writeFileAtomic(combinedPath, combined + (combined ? "\n" : ""));
  return combinedPath;
}

function remainingRecordTimeout(deadline, timeoutMs, wosid) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(`Full record timeout after ${timeoutMs}ms: ${wosid}`);
  }
  return remaining;
}

async function extractOneRecordInfo(context, args, wosid) {
  const timeoutMs = args.recordTimeoutMs || args.timeoutMs;
  const deadline = Date.now() + timeoutMs;
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  try {
    await page.goto(`${args.baseUrl}/wos/`, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(10000, remainingRecordTimeout(deadline, timeoutMs, wosid)),
    });
    await ensureWosJsOnPage(page, args);
    const raw = await page.evaluate(async (targetWosId) => {
      if (!window.wos?.record?.viewFullRecordByWosId || !window.wos?.record?.parseCurrentFullRecordPage) {
        throw new Error("wos.js record parser API missing: window.wos.record.parseCurrentFullRecordPage");
      }
      await window.wos.record.viewFullRecordByWosId(targetWosId);
      const parsed = await window.wos.record.parseCurrentFullRecordPage();
      const normalizedWosId = window.wos.record.currentWosId || targetWosId;
      const record = parsed?.[normalizedWosId] || parsed?.[targetWosId] || parsed;
      if (!record || typeof record !== "object") {
        throw new Error(`No full-record JSON parsed for ${targetWosId}`);
      }
      return {
        ...record,
        wosid: normalizedWosId,
        url: location.href,
      };
    }, wosid);
    raw.wosid = normalizeWosId(raw.wosid) || wosid;
    raw.fetchedAt = new Date().toISOString();
    return raw;
  } catch (error) {
    if (/timeout/i.test(error?.message || "")) {
      throw new Error(`Full record timeout after ${timeoutMs}ms: ${wosid}`);
    }
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

async function runParse(args) {
  const task = resolveTask(args);
  args.taskId = task.taskId;
  args.outDir = task.taskDir;
  args.uuid = args.uuid || task.uuid;
  args.url = args.url || task.url || (args.uuid ? buildSummaryUrl(args.baseUrl, args.uuid, args.sortBy) : "");
  const paths = withRawSource(createRunLayout({ ...args, force: true }), args.uuid || task.uuid || task.taskId);
  const wosidsPath = resolveWosIdsCsvPath(paths, args.uuid || task.uuid || task.taskId, args.wosidsCsv);
  if (!fs.existsSync(wosidsPath)) throw new Error(`Missing WOSID CSV: ${wosidsPath}`);
  const wosids = readWosIdsCsv(wosidsPath);
  if (!wosids.length) throw new Error(`No WOS IDs found in ${wosidsPath}`);

  const work = selectParseWork(paths, wosids, args);
  const beforeStats = parseStats(paths, wosids, args);
  printParseWorkSummary(parseWorkSummary(paths, wosids, work, args));
  if (!work.length) {
    const failures = [];
    writeJson(paths.parseFailures, failures);
    const sqlite = beforeStats.completed ? importParsedWosData(args, task.taskId, wosids) : null;
    upsertTaskIndex(args, {
      status: beforeStats.completed === wosids.length ? "parse-completed" : "parse-incomplete",
      lastError: "",
      uuid: args.uuid || task.uuid,
      url: args.url || task.url,
      expectedCount: task.expectedCount,
      uniqueCount: task.uniqueCount,
    });
    return {
      taskId: task.taskId,
      taskDir: task.taskDir,
      totalWosIds: wosids.length,
      selected: 0,
      parsed: 0,
      completed: beforeStats.completed,
      failed: 0,
      dbPath: args.dbPath,
      sqlite,
      failures: paths.parseFailures,
    };
  }

  if (!args.sid) {
    await prepareWosExport(args);
  }
  appendProgress(paths, { phase: "parse-start", total: wosids.length, selected: work.length, wosidsCsv: wosidsPath });
  upsertTaskIndex(args, {
    status: "parse-running",
    lastError: "",
    uuid: args.uuid || task.uuid,
    url: args.url || task.url,
    expectedCount: task.expectedCount,
    uniqueCount: task.uniqueCount,
  });

  const authSpinner = createSpinner("Validating WOS authentication");
  let parseProgress = null;
  let session = null;
  let processed = 0;
  let parsed = 0;
  const failures = [];
  try {
    session = await prepareWosSession(args);
    authSpinner.succeed("WOS authentication validated");
    parseProgress = createProgress("Parsing WOS data", work.length);
    await runPool(work, args.concurrency, async (item) => {
      const { wosid, index } = item;
      appendProgress(paths, { phase: "parse-record-start", wosid, index, total: wosids.length });
      try {
        const raw = await extractOneRecordInfo(session.context, args, wosid);
        const sqliteResult = importWosDataRecord({
          dbPath: args.dbPath,
          record: raw,
          taskId: task.taskId,
          source: raw.url || `wos:${wosid}`,
          expectedWosId: wosid,
          force: args.force,
        });
        parsed += 1;
        appendProgress(paths, { phase: "parse-record", status: "completed", wosid, index, dbPath: args.dbPath, imported: sqliteResult.imported, skipped: sqliteResult.skipped });
        if (!isInteractive()) {
          console.error(`parse OK ${index}/${wosids.length} ${wosid} -> ${args.dbPath}`);
        }
      } catch (error) {
        const failure = {
          wosid,
          index,
          error: error && error.stack ? error.stack : String(error),
          failedAt: new Date().toISOString(),
        };
        failures.push(failure);
        appendProgress(paths, { phase: "parse-record", status: "failed", wosid, index, error: error.message || String(error) });
        if (!isInteractive()) {
          console.error(`parse FAIL ${index}/${wosids.length} ${wosid}: ${error.message || error}`);
        }
      }
      processed += 1;
      parseProgress.update(processed, `${index}/${wosids.length} ${wosid}`, failures.length);
      if (args.cooldownMs) await sleep(args.cooldownMs);
    });
    parseProgress.stop("WOS data parse complete");
  } finally {
    authSpinner.stop();
    parseProgress?.stop("WOS data parse stopped");
    await session?.close?.();
  }

  writeJson(paths.parseFailures, failures);
  const finalStats = parseStats(paths, wosids, args);
  const status = !failures.length && finalStats.completed === wosids.length ? "parse-completed" : "parse-incomplete";
  const sqlite = finalStats.completed ? importParsedWosData(args, task.taskId, wosids) : null;
  upsertTaskIndex(args, {
    status,
    lastError: "",
    uuid: args.uuid || task.uuid,
    url: args.url || task.url,
    expectedCount: task.expectedCount,
    uniqueCount: task.uniqueCount,
  });
  return {
    taskId: task.taskId,
    taskDir: task.taskDir,
    totalWosIds: wosids.length,
    selected: work.length,
    parsed,
    completed: finalStats.completed,
    failed: failures.length,
    dbPath: args.dbPath,
    sqlite,
    failures: paths.parseFailures,
  };
}

function validateTask(args) {
  const task = resolveTask(args);
  const basePaths = getRunPaths(task.taskDir);
  const initialSummary = readJson(basePaths.summary, {});
  const rawSource = initialSummary.uuid || task.uuid || task.taskId;
  const paths = withRawSource(basePaths, rawSource);
  const summary = initialSummary;
  const isBibTask = summary.method === "wos-js-export-fetchBibBatches";
  const wosidsCsv = wosIdsCsvPath(paths, summary.uuid || task.uuid || task.taskId);
  const combinedBib = isBibTask ? bibFilePath(paths, summary.uuid || task.uuid) : "";
  const wosids = !isBibTask && fs.existsSync(wosidsCsv) ? readWosIdsCsv(wosidsCsv) : [];
  const rawUuid = summary.uuid || task.uuid || "";
  const rawFiles = rawUuid ? rawBatchFiles(paths, rawUuid) : [];
  const bibUuid = isBibTask ? (summary.uuid || task.uuid || "") : "";
  const bibFiles = bibUuid && fs.existsSync(bibBatchDir(paths, bibUuid))
    ? fs.readdirSync(bibBatchDir(paths, bibUuid)).filter((name) => name.endsWith(".bib"))
    : [];
  const wosData = parseStats(paths, wosids, args);
  const issues = [];
  if (!fs.existsSync(paths.manifest)) issues.push("missing manifest.json");
  if (!fs.existsSync(paths.summary)) issues.push("missing summary.json");
  if (isBibTask && !bibFiles.length) issues.push("missing raw/<uuid>/bib batches");
  if (isBibTask && !fs.existsSync(combinedBib)) issues.push(`missing combined BibTeX file: ${path.relative(paths.taskDir, combinedBib)}`);
  if (!isBibTask && !fs.existsSync(wosidsCsv)) issues.push(`missing WOSID CSV: ${path.relative(paths.taskDir, wosidsCsv)}`);
  if (!isBibTask && summary.expectedCount && summary.uniqueCount !== summary.expectedCount) {
    issues.push(`wosid count mismatch: expected=${summary.expectedCount} unique=${summary.uniqueCount}`);
  }
  if (!isBibTask && summary.uniqueCount && wosids.length !== summary.uniqueCount) {
    issues.push(`WOSID CSV rows mismatch: csv=${wosids.length} summary.uniqueCount=${summary.uniqueCount}`);
  }
  if (!isBibTask && summary.method !== "imported-wosid-csv" && !rawFiles.length) issues.push("missing raw/<uuid>/full-record batches");
  return {
    ok: issues.length === 0,
    taskId: task.taskId,
    taskDir: task.taskDir,
    wosids: wosids.length,
    rawBatches: rawFiles.length,
    bibBatches: bibFiles.length,
    bibFile: combinedBib,
    wosData,
    issues,
  };
}

function importWosIds(args) {
  if (!args.csvPath) throw new Error("Missing --csv <file>");
  if (!fs.existsSync(args.csvPath)) throw new Error(`CSV file not found: ${args.csvPath}`);
  const wosids = readWosIdsCsv(args.csvPath);
  if (!wosids.length) {
    throw new Error(`No valid WOS IDs found in CSV: ${args.csvPath}`);
  }

  const initialPaths = getRunPaths(args.outDir);
  const outputHasFiles = fs.existsSync(args.outDir) &&
    fs.readdirSync(args.outDir).some((name) => name !== ".DS_Store");
  if (args.force && outputHasFiles) cleanRunLayout(initialPaths);
  const paths = createRunLayout(args);
  upsertTaskIndex(args, { status: "importing", lastError: "", uuid: "", url: "" });
  writeJson(paths.manifest, {
    command: "iiaide-wos",
    operation: "import",
    args: manifestArgs(args),
    task: {
      taskId: args.taskId,
      label: args.taskLabel,
      taskDir: paths.taskDir,
      tasksRoot: args.tasksRoot,
    },
    createdAt: new Date().toISOString(),
  });
  const rows = wosids.map((wosid, index) => ({
    batchStart: "",
    batchEnd: "",
    batchPosition: index + 1,
    wosid,
  }));
  appendProgress(paths, { phase: "csv-import", source: args.csvPath, imported: rows.length });
  const summary = writeOutputs(paths, rows, {
    method: "imported-wosid-csv",
    taskId: args.taskId,
    taskLabel: args.taskLabel,
    inputCsv: args.csvPath,
    expectedCount: rows.length,
    rowText: `${rows.length} WOS IDs imported from CSV`,
    runDir: paths.runDir,
  });
  upsertTaskIndex(args, {
    status: "completed",
    lastError: "",
    uuid: "",
    url: "",
    expectedCount: summary.expectedCount,
    uniqueCount: summary.uniqueCount,
  });
  return summary;
}

function importWosIdsForParse(args) {
  const summary = importWosIds({
    ...args,
    command: "import",
    force: false,
  });
  args.wosidsCsv = summary.files?.wosidsCsv || args.wosidsCsv;
  return summary;
}

async function run(args) {
  const initialPaths = getRunPaths(args.outDir);
  const completedSummary = !args.force ? readCompletedRunSummary(initialPaths, args) : null;
  if (completedSummary) {
    console.error("WOS ID CSV already exists; skipping download.");
    return completedSummary;
  }
  const priorSummaryRaw = readJson(initialPaths.summary, {});
  const priorSummary = sameTaskUuid(priorSummaryRaw, args) ? priorSummaryRaw : {};
  const outputHasFiles = fs.existsSync(args.outDir) &&
    fs.readdirSync(args.outDir).some((name) => name !== ".DS_Store");
  if (args.force && !args.reuseRaw && outputHasFiles) {
    cleanRunLayout(initialPaths);
  }
  const paths = createRunLayout(args);
  upsertTaskIndex(args, { status: "running", lastError: "" });
  writeJson(paths.manifest, {
    command: "iiaide-wos",
    args: manifestArgs(args),
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
  const rawUuid = args.uuid || priorSummary.uuid || "";
  if (args.reuseRaw && rawUuid && !info.expectedCount) {
    const coverage = rawBatchCoverage(paths, rawUuid);
    if (coverage.files.length && coverage.firstStart === 1) info.expectedCount = coverage.lastEnd;
  }
  const canRepairFromRaw = !args.force &&
    rawUuid &&
    !finalWosIdsCsvExists(paths, rawUuid) &&
    canRepairWosIdsFromRaw(paths, rawUuid, info.expectedCount);

  if ((args.reuseRaw || canRepairFromRaw) && rawUuid && rawBatchFiles(paths, rawUuid).length) {
    info.uuid = rawUuid;
    if (!info.expectedCount) {
      throw new Error("Cannot reuse raw batches without a known WOS record count. Re-run without --reuse-raw to refresh from WOS.");
    }
    const coverage = rawBatchCoverage(paths, rawUuid);
    if (!coverage.files.length) throw new Error(`No raw batches found for UUID: ${rawUuid}`);
    if (coverage.firstStart !== 1 || coverage.lastEnd < info.expectedCount) {
      throw new Error(
        `Incomplete raw batches for UUID ${rawUuid}: have ${coverage.firstStart || 0}-${coverage.lastEnd || 0}, expected 1-${info.expectedCount}. Re-run without --reuse-raw to refresh from WOS.`
      );
    }
    rows = parseExistingRawBatches(paths, rawUuid);
    appendProgress(paths, {
      phase: canRepairFromRaw && !args.reuseRaw ? "repair-export-from-raw" : "reuse-raw",
      uuid: rawUuid,
      parsed: rows.length,
    });
    if (canRepairFromRaw && !args.reuseRaw && !isInteractive()) {
      console.error("WOS raw batches already exist; rebuilding missing WOS ID CSV.");
    }
  } else {
    await prepareWosExport(args);
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

async function runBib(args) {
  const initialPaths = getRunPaths(args.outDir);
  const completedSummary = !args.force ? readCompletedBibSummary(initialPaths, args) : null;
  if (completedSummary) {
    console.error("BibTeX already exists; skipping download.");
    return completedSummary;
  }
  const outputHasFiles = fs.existsSync(args.outDir) &&
    fs.readdirSync(args.outDir).some((name) => name !== ".DS_Store");
  if (args.force && outputHasFiles) {
    cleanRunLayout(initialPaths);
  }
  const paths = createRunLayout(args);
  upsertTaskIndex(args, { status: "bib-running", lastError: "" });
  const priorSummaryRaw = readJson(paths.summary, {});
  const priorSummary = sameTaskUuid(priorSummaryRaw, args) ? priorSummaryRaw : {};
  writeJson(paths.manifest, {
    command: "iiaide-wos",
    operation: "bib",
    args: manifestArgs(args),
    task: {
      taskId: args.taskId,
      label: args.taskLabel,
      taskDir: paths.taskDir,
      tasksRoot: args.tasksRoot,
    },
    createdAt: new Date().toISOString(),
  });
  const rawUuid = args.uuid || priorSummary.uuid || "";
  const rawBibFiles = rawUuid
    ? bibBatchFiles(paths, rawUuid).map((fileName) => path.join(bibBatchDir(paths, rawUuid), fileName))
    : [];
  if (!args.force && rawUuid && rawBibFiles.length && !finalBibExists(paths, rawUuid)) {
    const combinedBib = combineBibFiles(paths, rawUuid, rawBibFiles);
    const outputPaths = withRawSource(paths, rawUuid);
    const entryCount = rawBibFiles.reduce((sum, filePath) => sum + parseBibEntryCount(fs.readFileSync(filePath, "utf8")), 0);
    const summary = {
      ok: true,
      method: "wos-js-export-fetchBibBatches",
      taskId: args.taskId,
      taskLabel: args.taskLabel,
      inputUrl: args.url,
      inputUuid: args.uuid,
      uuid: rawUuid,
      sortBy: args.sortBy,
      expectedCount: priorSummary.expectedCount || entryCount,
      batchCount: rawBibFiles.length,
      rowText: priorSummary.rowText || "",
      summaryHref: priorSummary.summaryHref || args.url,
      runDir: paths.runDir,
      files: {
        bibFile: combinedBib,
        bibFiles: rawBibFiles,
        bibDir: bibBatchDir(paths, rawUuid),
        exportDir: outputPaths.bibExportDir,
        progressLog: paths.progressLog,
      },
      finishedAt: new Date().toISOString(),
    };
    appendProgress(paths, { phase: "repair-bib-export-from-raw", uuid: rawUuid, batches: rawBibFiles.length, entries: entryCount });
    writeJson(paths.summary, summary);
    upsertTaskIndex(args, {
      status: "bib-completed",
      lastError: "",
      uuid: summary.uuid,
      url: summary.inputUrl,
      expectedCount: summary.expectedCount,
      uniqueCount: 0,
    });
    if (!isInteractive()) console.error("BibTeX raw batches already exist; rebuilding missing combined BibTeX.");
    return summary;
  }
  await prepareWosExport(args);
  const result = await exportBibFromWos(args, paths);
  const uuid = result.info.uuid || args.uuid;
  const combinedBib = combineBibFiles(paths, uuid, result.files);
  const outputPaths = withRawSource(paths, uuid);
  const summary = {
    ok: true,
    method: "wos-js-export-fetchBibBatches",
    taskId: args.taskId,
    taskLabel: args.taskLabel,
    inputUrl: args.url,
    inputUuid: args.uuid,
    uuid,
    sortBy: args.sortBy,
    expectedCount: result.info.expectedCount || 0,
    batchCount: result.files.length,
    rowText: result.info.rowText || "",
    summaryHref: result.info.href || args.url,
    runDir: paths.runDir,
    files: {
      bibFile: combinedBib,
      bibFiles: result.files,
      bibDir: bibBatchDir(paths, uuid),
      exportDir: outputPaths.bibExportDir,
      progressLog: paths.progressLog,
    },
    finishedAt: new Date().toISOString(),
  };
  writeJson(paths.summary, summary);
  upsertTaskIndex(args, {
    status: "bib-completed",
    lastError: "",
    uuid: summary.uuid,
    url: summary.inputUrl,
    expectedCount: summary.expectedCount,
    uniqueCount: 0,
  });
  return summary;
}

async function runParsePipeline(args) {
  const summary = await run(args);
  if (!summary.ok) {
    return {
      ok: false,
      taskId: summary.taskId,
      run: summary,
      parse: null,
    };
  }
  const parse = await runParse({
    ...args,
    force: false,
    uuid: summary.uuid || args.uuid,
    url: summary.summaryHref || summary.inputUrl || args.url,
    wosidsCsv: summary.files?.wosidsCsv,
  });
  return {
    ok: !parse.failed,
    taskId: summary.taskId,
    run: summary,
    parse,
  };
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
  const spinner = createSpinner("Validating and saving WOS SID");
  let session = null;
  try {
    session = await prepareWosSession(args, { visible: Boolean(args.headed || args.fromBrowser) });
    const status = session.status;
    spinner.succeed("WOS SID validated and saved");
    return {
      ok: true,
      sidSource: args.sidSource || "browser",
      config: configPath(args.tasksRoot),
      href: status.href,
      sid: "[saved]",
    };
  } catch (error) {
    spinner.fail("WOS SID validation failed");
    throw error;
  } finally {
    spinner.stop();
    await session?.close?.();
  }
}

async function checkSid(args, dependencies = {}) {
  const quickCheck = dependencies.quickValidateSid || quickValidateSid;
  const validateSidFlow = dependencies.validateAndSaveSid || validateAndSaveSid;
  const report = dependencies.report || console.error;
  const quick = await quickCheck(args, dependencies.quickValidateOptions || {});

  if (quick.status === "valid") {
    return {
      ok: true,
      status: "valid",
      checkedWith: "http-probe",
      sidSource: quick.sidSource || args.sidSource || "",
      config: configPath(args.tasksRoot),
      href: quick.href || "",
      sid: "[saved]",
      message: quick.message || "SID accepted by WOS",
    };
  }

  if (quick.status === "invalid") {
    report("Saved SID is invalid. Opening a WOS browser login to refresh it.");
  } else if (quick.status === "missing") {
    report("No saved SID found. Opening a WOS browser login to create one.");
  } else {
    report("SID could not be confirmed with the lightweight check. Running browser validation.");
  }

  const repaired = await validateSidFlow(args);
  return {
    ...repaired,
    status: "refreshed",
    checkedWith: "browser-validation",
    initialStatus: quick.status,
    initialMessage: quick.message || "",
  };
}

function formatCheckSidResult(result = {}) {
  if (result.ok && result.status === "refreshed") {
    return "WOS SID refreshed and saved";
  }
  if (result.ok) {
    return "WOS SID check passed";
  }
  const status = result.status ? `: ${result.status}` : "";
  return `WOS SID check failed${status}`;
}

async function executeCommand(args) {
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.version) {
    console.log(VERSION);
    return 0;
  }
  if (args.command === "list") {
    listTasks(args);
    return 0;
  }
  if (args.command === "init") {
    console.log(JSON.stringify(initializeWorkspace(args), null, 2));
    return 0;
  }
  if (args.command === "check") {
    const result = await checkSid(args);
    console.log(formatCheckSidResult(result));
    return 0;
  }
  if (args.command === "workspace") {
    console.log(JSON.stringify(workspaceStatus(args), null, 2));
    return 0;
  }
  if (args.command === "update") {
    const spinner = createSpinner(args.checkOnly ? "Checking for iiaide-wos updates" : "Checking and updating iiaide-wos");
    try {
      let installing = false;
      const result = await updateCli({
        currentVersion: VERSION,
        checkOnly: args.checkOnly,
        onInstall({ version }) {
          installing = true;
          spinner.stop();
          console.error(`Installing iiaide-wos ${version} from GitHub Release...`);
        },
      });
      if (result.status === "updated") {
        if (installing) console.error(`OK Updated iiaide-wos ${result.currentVersion} -> ${result.latestVersion}`);
        else spinner.succeed(`Updated iiaide-wos ${result.currentVersion} -> ${result.latestVersion}`);
      }
      else if (result.status === "update-available") spinner.succeed(`Update available: ${result.currentVersion} -> ${result.latestVersion}`);
      else spinner.succeed(`iiaide-wos ${result.currentVersion} is up to date`);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      spinner.fail("iiaide-wos update failed");
      throw error;
    }
    return 0;
  }
  if (args.command === "show") {
    showTask(args);
    return 0;
  }
  if (args.command === "path") {
    printTaskPath(args);
    return 0;
  }
  if (args.command === "clear") {
    const result = await confirmAndClearTask(args);
    console.log(result.taskDir);
    return 0;
  }
  if (args.command === "validate") {
    const result = validateTask(args);
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (args.command === "sid") {
    const result = await validateAndSaveSid(args);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (args.command === "import") {
    if (!args.csvPath || !args.taskId || !args.outDir) {
      console.error(usage());
      return 2;
    }
    const summary = importWosIds(args);
    console.log(summary.files.wosidsCsv);
    return 0;
  }
  if (args.command === "parse") {
    if (args.csvPath) {
      if (!args.taskId || !args.outDir) {
        console.error(usage());
        return 2;
      }
      importWosIdsForParse(args);
    }
    loadSavedSid(args);
    const result = await runParse(args);
    console.log(result.sqlite?.dbPath || result.dbPath || "");
    return result.failed ? 1 : 0;
  }
  if (args.command === "wosdata") {
    if (!args.queryWosId && !args.sqlQuery && !args.mergeDbPath) {
      console.error(usage());
      return 2;
    }
    const result = runWosDataImport(args);
    if (args.queryWosId || args.sqlQuery) {
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    console.log(result.dbPath);
    return result.ok ? 0 : 1;
  }
  if (args.command === "bib") {
    if (!args.url || !args.uuid || !args.outDir) {
      console.error(usage());
      return 2;
    }
    const completed = readCompletedArtifactSummary(args);
    if (completed) return printCompletedArtifactPath(args.command, completed);
    const summary = await runBib(args);
    console.log(summary.files.bibFile);
    return summary.ok ? 0 : 1;
  }
  if (args.command === "parse-pipeline") {
    if (!args.url || !args.uuid || !args.outDir) {
      console.error(usage());
      return 2;
    }
    const result = await runParsePipeline(args);
    console.log(result.parse?.sqlite?.dbPath || result.parse?.dbPath || result.run.files.wosidsCsv);
    return result.ok ? 0 : 1;
  }
  if (args.command === "latest") {
    const latest = readLatestTaskId(args.tasksRoot);
    if (!latest) {
      console.error(`No latest task in ${args.tasksRoot}`);
      return 1;
    }
    console.log(latest);
    return 0;
  }
  if (args.command !== "run") {
    throw new Error(`Unknown command: ${args.command}`);
  }
  if (!args.url || !args.uuid || !args.outDir) {
    console.error(usage());
    return 2;
  }
  const completed = readCompletedArtifactSummary(args);
  if (completed) return printCompletedArtifactPath(args.command, completed);
  const summary = await run(args);
  console.log(summary.files.wosidsCsv);
  return summary.ok ? 0 : 1;
}

function recordCommandFailure(args, error) {
  if (
    args?.taskId &&
    args?.outDir &&
    fs.existsSync(args.outDir) &&
    ["run", "import", "parse", "parse-pipeline", "bib"].includes(args.command)
  ) {
    try {
      upsertTaskIndex(args, {
        status: "failed",
        lastError: error?.message || String(error),
      });
    } catch (_) {}
  }
}

async function runParsedCommand(args) {
  try {
    return await executeCommand(args);
  } catch (error) {
    if (isUserQuitError(error)) {
      console.error(error.message || "Quit by user");
      return 130;
    }
    if (isUserCancelledError(error)) {
      console.error(error.message || "Cancelled by user");
      return 0;
    }
    if (isUserAbortError(error)) {
      console.error("");
      return 130;
    }
    recordCommandFailure(args, error);
    console.error(error && error.stack ? error.stack : String(error));
    return 1;
  }
}

function restartCurrentCli(argv = process.argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv.slice(1), {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) resolve(130);
      else resolve(code || 0);
    });
  });
}

async function runInteractiveMenu(argv = process.argv) {
  const menuArgs = parseArgs([argv[0], argv[1], "workspace", ...argv.slice(3)]);
  menuArgs.keepWosSession = true;
  initializeWorkspace(menuArgs);
  ensureCurrentTask(menuArgs);

  try {
    for (;;) {
      ensureCurrentTask(menuArgs);
      const sidCheck = await quickValidateSid(menuArgs);
      const selectedArgs = await interactiveArgs(VERSION, workspaceStatus(menuArgs, sidCheck), {
        makeTaskId,
        readBrowserSid: () => readSidFromBrowser(menuArgs),
        async saveSid(sid) {
          menuArgs.sid = sid;
          menuArgs.sidSource = menuArgs.sidSource || "prompt";
          saveSidConfig(menuArgs, sid);
          const refreshedSidCheck = await quickValidateSid(menuArgs);
          return workspaceStatus(menuArgs, refreshedSidCheck);
        },
        setCurrentTask(taskId) {
          setCurrentTaskId(menuArgs, taskId);
          return workspaceStatus(menuArgs, sidCheck);
        },
      });
      if (!selectedArgs) return 0;
      if (selectedArgs.refresh) continue;

      try {
        const args = parseArgs([argv[0], argv[1], ...selectedArgs]);
        args.keepWosSession = true;
        const exitCode = await runParsedCommand(args);
        if (selectedArgs[0] === "update" && exitCode === 0) {
          console.error("Restarting iiaide-wos...");
          await closeSharedWosSession();
          return await restartCurrentCli(argv);
        }
        if (exitCode === 130) return 0;
        if (exitCode) {
          console.error(`Command exited with code ${exitCode}. Returning to menu.`);
        }
      } catch (error) {
        if (isUserQuitError(error)) return 0;
        if (isUserCancelledError(error)) {
          console.error(error.message || "Cancelled by user");
          continue;
        }
        if (isUserAbortError(error)) return 0;
        console.error(error && error.stack ? error.stack : String(error));
        console.error("Returning to menu.");
      }
    }
  } catch (error) {
    if (isUserAbortError(error)) return 0;
    throw error;
  } finally {
    await closeSharedWosSession();
  }
}

async function main() {
  try {
    const argv = process.argv;
    if (argv.length === 2 && (!process.stdin.isTTY || !isInteractive(process.stdout))) {
      console.log(usage());
      return;
    }
    if (argv.length === 2 || argv[2] === "menu") {
      const exitCode = await runInteractiveMenu(argv);
      if (exitCode) process.exitCode = exitCode;
      return;
    }
    const args = parseArgs(argv);
    const exitCode = await runParsedCommand(args);
    if (exitCode) process.exitCode = exitCode;
  } catch (error) {
    if (isUserAbortError(error)) {
      console.error("");
      process.exitCode = 130;
      return;
    }
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  executeCommand,
  runParsedCommand,
  runInteractiveMenu,
  run,
  runBib,
  runParse,
  runParsePipeline,
  runWosDataImport,
  importWosIds,
  initializeWorkspace,
  workspaceStatus,
  ensureCurrentTask,
  setCurrentTaskId,
  checkSid,
  formatCheckSidResult,
  ensureSid,
  quickValidateSid,
  validateSidWithRetry,
  prepareWosSession,
  buildSidInitUrl,
  wosUserDataDir,
  wosProfileName,
  wosBrowserMode,
  wosBrowserLaunchOptions,
  resolveWosJsPath,
  requireWosJsPath,
  applyValidatedWosOrigin,
  isWosRootRecordRedirect,
  validateTask,
  clearTask,
  confirmAndClearTask,
  parseArgs,
  makeTaskId,
  parseExportText,
  parseBibEntryCount,
  parseWosCount,
  downloadBatchCount,
  boundedRecordCount,
  confirmDownloadPlan,
  isUserCancelledError,
  isUserQuitError,
  isUserAbortError,
  runPool,
  prepareWosRequestContext,
  pageContextUuid,
  readWosIdsCsv,
  extractUuid,
  maskSid,
  announceResolvedWosUuid,
  prepareWosExport,
  readTaskIndex,
  normalizeTaskId,
  getRunPaths,
  withRawSource,
  cleanRunLayout,
  rawBatchFiles,
  bibBatchFiles,
  parseExistingRawBatches,
  importWosDataRecord,
  mergeWosDataDatabase,
  queryWosDataByWosId,
  queryWosDataDatabase,
  readJson,
  writeJson,
};
