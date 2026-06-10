const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { readJson, writeFileAtomic, writeJson } = require("./lib/io");
const { confirmAction, interactiveArgs, isUserAbortError, promptSid } = require("./lib/interactive");
const { createProgress, createSpinner, isInteractive } = require("./lib/terminal");
const { updateCli } = require("./lib/update");
const { exportBibBatchesViaWosJs, exportTxtBatchesViaWosJs } = require("./lib/wos-browser-export");
const { version: VERSION } = require("../package.json");

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_WOS_PROTOCOL = "https";
const DEFAULT_WOS_DOMAIN = "www.webofscience.com";
const DEFAULT_BASE_URL = `${DEFAULT_WOS_PROTOCOL}://${DEFAULT_WOS_DOMAIN}`;
const DEFAULT_WOSJS_PATH = path.resolve(__dirname, "..", "import", "wos.js");
const HIDDEN_BROWSER_POSITION = "-32000,0";
const DEFAULT_TASK_ID_CONFIG = {
  prefix: "WOS",
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

function isUserCancelledError(error) {
  return error?.code === "USER_CANCELLED" || error?.name === "UserCancelledError";
}

function usage() {
  return `
Usage:
  iiaide-wos menu
  iiaide-wos init [--tasks-root <dir>]
  iiaide-wos workspace [--tasks-root <dir>]
  iiaide-wos update [--check]
  iiaide-wos run [--sid <SID>] (--url <summary-url> | --uuid <uuid>) [options]
  iiaide-wos bib [--sid <SID>] (--url <summary-url> | --uuid <uuid>) [options]
  iiaide-wos pipeline [--sid <SID>] (--url <summary-url> | --uuid <uuid>) [options]
  iiaide-wos [--sid <SID>] (--url <summary-url> | --uuid <uuid>) [options]
  iiaide-wos import --csv <wosids.csv> [--task <task-id>] [options]
  iiaide-wos list [--tasks-root <dir>]
  iiaide-wos show (--task <task-id> | --latest) [--tasks-root <dir>]
  iiaide-wos path (--task <task-id> | --latest) [--tasks-root <dir>]
  iiaide-wos validate (--task <task-id> | --latest) [--tasks-root <dir>]
  iiaide-wos clear (--task <task-id> | --latest) [--tasks-root <dir>]
  iiaide-wos sid [--sid <SID> | --from-browser] [--tasks-root <dir>] [--wos-domain <domain>] [--base-url <url>] [--headed]
  iiaide-wos authors [--sid <SID>] (--task <task-id> | --latest) [options]
  iiaide-wos authors --rebuild-only (--task <task-id> | --latest) [--tasks-root <dir>]

Inputs:
  --sid <SID>             Web of Science SID. Interactive commands prompt when missing or expired
  --from-browser          Open a browser login window and auto-detect WOS SID
  --url <summary-url>     WOS summary URL
  --uuid <uuid>           WOS result-set UUID; used when --url is not provided
  --csv <file>            Existing CSV containing a wosid/UT column or WOS IDs in its first column

Output management:
  --task <task-id>        Stable task id. If omitted, creates a timestamp-based task id
  --task-label <label>    Human label stored in task metadata
  --tasks-root <dir>      Parent directory for tasks. Default: ./tasks
  --out-dir <dir>         Exact task directory override
  --force                 Allow writing into a non-empty --out-dir
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

Author options:
  --concurrency <n>       Parallel full-record pages. Default: 2
  --retry-failed          Retry failed WOS IDs
  --failed-only           Process only failed WOS IDs
  --rebuild-only          Rebuild normalized JSON and authors.csv/authors.jsonl from existing JSON only
  --cooldown-ms <n>       Delay after each record. Default: 250

Task directory layout:
  raw/full-record/        WOS fullRecord text batches as <uuid>_<start>_<end>.txt
  raw/bib/                BibTeX batches as <uuid>_<start>_<end>.bib
  data/<uuid>.bib         Combined BibTeX file
  data/<uuid>_wosid.csv   One-column WOSID CSV
  authors/raw-json/       One raw author extraction JSON per WOSID
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
    fromBrowser: false,
    url: "",
    urlHadProtocol: false,
    uuid: "",
    csvPath: "",
    taskId: "",
    taskLabel: "",
    outDir: "",
    tasksRoot: path.resolve(process.cwd(), "tasks"),
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
    concurrency: 2,
    limit: 0,
    fromIndex: 1,
    retryFailed: false,
    failedOnly: false,
    rebuildOnly: false,
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
    else if (arg === "--task") args.taskId = normalizeTaskId(readValue(arg, i++));
    else if (arg === "--latest") args.latest = true;
    else if (arg === "--task-label" || arg === "--label") args.taskLabel = readValue(arg, i++);
    else if (arg === "--out-dir" || arg === "--download-dir") args.outDir = readValue(arg, i++);
    else if (arg === "--tasks-root" || arg === "--output-root") args.tasksRoot = readValue(arg, i++);
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
    else if (arg === "--retry-failed") args.retryFailed = true;
    else if (arg === "--failed-only") args.failedOnly = true;
    else if (arg === "--rebuild-only") args.rebuildOnly = true;
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
  assertIntegerRange("--concurrency", args.concurrency, 1, 10);
  assertIntegerRange("--limit", args.limit, 0);
  assertIntegerRange("--from-index", args.fromIndex, 1);
  assertIntegerRange("--cooldown-ms", args.cooldownMs, 0);
  args.tasksRoot = path.resolve(args.tasksRoot);
  if (args.csvPath) args.csvPath = path.resolve(args.csvPath);
  if (!args.taskId && args.uuid) args.taskId = makeTaskId();
  if (!args.taskId && command === "import" && args.csvPath) args.taskId = makeTaskId();
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
    bibDir: path.join(outDir, "raw", "bib"),
    dataDir: path.join(outDir, "data"),
    logsDir: path.join(outDir, "logs"),
    manifest: path.join(outDir, "manifest.json"),
    summary: path.join(outDir, "summary.json"),
    progressLog: path.join(outDir, "logs", "progress.jsonl"),
    authorsDir: path.join(outDir, "authors"),
    authorRawJsonDir: path.join(outDir, "authors", "raw-json"),
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
      const manifest = readJson(path.join(args.outDir, "manifest.json"), null);
      if (manifest?.command !== "iiaide-wos") {
        throw new Error(`Output directory is not empty: ${args.outDir}. Use --force or choose another --out-dir.`);
      }
    }
  }

  const paths = getRunPaths(args.outDir);
  for (const dir of [
    paths.rawDir,
    paths.bibDir,
    paths.dataDir,
    paths.logsDir,
    paths.authorsDir,
    paths.authorRawJsonDir,
  ]) fs.mkdirSync(dir, { recursive: true });
  return paths;
}

function sameTaskUuid(summary, args) {
  return !summary?.uuid || !args.uuid || summary.uuid === args.uuid;
}

function readCompletedRunSummary(paths, args) {
  const summary = readJson(paths.summary, null);
  if (!summary?.ok || summary.method !== "wos-js-export-fetchTxtBatches" || !sameTaskUuid(summary, args)) return null;
  const csvPath = summary.files?.wosidsCsv || wosIdsCsvPath(paths, summary.uuid || args.uuid || args.taskId);
  return fs.existsSync(csvPath) ? summary : null;
}

function readCompletedBibSummary(paths, args) {
  const summary = readJson(paths.summary, null);
  if (!summary?.ok || summary.method !== "wos-js-export-fetchBibBatches" || !sameTaskUuid(summary, args)) return null;
  const bibPath = summary.files?.bibFile || bibFilePath(paths, summary.uuid || args.uuid);
  return fs.existsSync(bibPath) ? summary : null;
}

function readCompletedArtifactSummary(args) {
  if (args.force || !args.outDir) return null;
  const paths = getRunPaths(args.outDir);
  if (args.command === "bib") return readCompletedBibSummary(paths, args);
  if (args.command === "run" || args.command === "pipeline") return readCompletedRunSummary(paths, args);
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

function assertNoTaskUuidConflict(paths, args) {
  const summary = readJson(paths.summary, null);
  if (summary?.uuid && args.uuid && summary.uuid !== args.uuid && !args.force) {
    throw new Error(
      `Task ${args.taskId} already contains UUID ${summary.uuid}. Switch task, create a new task, or rerun with --force to replace it.`
    );
  }
}

function cleanRunLayout(paths) {
  const manifest = readJson(paths.manifest, null);
  if (manifest?.command !== "iiaide-wos") {
    throw new Error(`Refusing to clean unmanaged output directory: ${paths.taskDir}`);
  }
  for (const directory of [path.dirname(paths.rawDir), paths.dataDir, paths.authorsDir, paths.logsDir]) {
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
  return path.join(paths.dataDir, `${safeFilePart(identifier)}_wosid.csv`);
}

function bibFilePath(paths, uuid) {
  if (!uuid) throw new Error("Missing BibTeX UUID");
  return path.join(paths.dataDir, `${safeFilePart(uuid)}.bib`);
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
  if (!confirmed) throw new UserCancelledError(`${label} download cancelled by user`);
  return { batches };
}

function safeWosIdFileName(wosid) {
  return safeFilePart(String(wosid || "").replace(/^WOS:/i, "WOS_")) + ".json";
}

function readWosIdsCsv(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  if (!rows.length) return [];
  const headerIndex = rows[0].findIndex((cell) => /^(wos[\s_-]*id|ut)$/i.test(cell.trim()));
  const start = headerIndex >= 0 ? 1 : 0;
  const columnIndex = headerIndex >= 0 ? headerIndex : 0;
  const seen = new Set();
  return rows.slice(start).map((row) => {
    const match = String(row[columnIndex] || "").match(/WOS:[A-Z0-9]+/i);
    return match ? match[0].toUpperCase() : "";
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

function storedArtifactPath(paths, filePath) {
  const relative = path.relative(paths.taskDir, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

function resolvedArtifactPath(paths, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(paths.taskDir, filePath);
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
  const records = fs.readdirSync(paths.authorRawJsonDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const raw = readJson(path.join(paths.authorRawJsonDir, name), null);
      if (!raw) return null;
      const wosid = raw.wosid || raw.url?.match(/full-record\/(WOS:[^/?#]+)/i)?.[1] || "";
      return wosid ? normalizeAuthorRecord(wosid, raw) : null;
    })
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

function rebuildAuthorsFromRaw(paths) {
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
    normalizeAuthorRecord(wosid, raw);
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

function batchFileName(uuid, markFrom, markTo, extension = "txt") {
  return `${safeFilePart(uuid)}_${markFrom}_${markTo}.${extension}`;
}

function rawBatchFiles(paths, uuid) {
  if (!uuid) throw new Error("Missing raw batch UUID");
  const prefix = `${safeFilePart(uuid)}_`;
  return fs
    .readdirSync(paths.rawDir)
    .filter((name) => name.startsWith(prefix) && /_(\d+)_(\d+)\.txt$/.test(name))
    .sort((a, b) => Number(a.match(/_(\d+)_(\d+)\.txt$/)[1]) - Number(b.match(/_(\d+)_(\d+)\.txt$/)[1]));
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

  const csvPath = wosIdsCsvPath(paths, meta.uuid || meta.taskId);
  writeFileAtomic(csvPath, toCsv(uniqueRows.map((row) => ({ wosid: row.wosid })), ["wosid"]));

  const summary = {
    ok: !meta.expectedCount || uniqueRows.length === meta.expectedCount,
    method: "wos-js-export-fetchTxtBatches",
    ...meta,
    parsedCount: rows.length,
    uniqueCount: uniqueRows.length,
    files: {
      wosidsCsv: csvPath,
      rawDir: paths.rawDir,
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
      const rawPath = path.join(paths.rawDir, batchFileName(info.uuid, batch.markFrom, batch.markTo));
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
      const bibPath = path.join(paths.bibDir, batchFileName(uuid, batch.markFrom, markTo, "bib"));
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
  const combinedPath = bibFilePath(paths, uuid);
  const combined = files
    .map((filePath) => fs.readFileSync(filePath, "utf8").trim())
    .filter(Boolean)
    .join("\n\n");
  writeFileAtomic(combinedPath, combined + (combined ? "\n" : ""));
  return combinedPath;
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

function currentAuthorStats(wosids, checkpoint) {
  const states = wosids.map((wosid) => checkpoint.records[wosid]?.status || "");
  return {
    completed: states.filter((status) => status === "completed").length,
    failed: states.filter((status) => status === "failed").length,
  };
}

function authorWorkSummary(wosids, checkpoint, work, args) {
  const stats = currentAuthorStats(wosids, checkpoint);
  const firstIndex = work[0]?.index || 0;
  const lastIndex = work[work.length - 1]?.index || 0;
  return {
    total: wosids.length,
    completed: stats.completed,
    failed: stats.failed,
    selected: work.length,
    firstIndex,
    lastIndex,
    concurrency: args.concurrency,
  };
}

function printAuthorWorkSummary(summary, write = console.error) {
  const range = summary.selected ? `${summary.firstIndex}-${summary.lastIndex}` : "none";
  write(
    `Author records: total=${summary.total}, completed=${summary.completed}, failed=${summary.failed}, selected=${summary.selected}, range=${range}, concurrency=${summary.concurrency}`
  );
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
  args.uuid = args.uuid || task.uuid;
  args.url = args.url || task.url || (args.uuid ? buildSummaryUrl(args.baseUrl, args.uuid, args.sortBy) : "");
  const paths = createRunLayout({ ...args, force: true });
  if (args.rebuildOnly) {
    const normalized = rebuildAuthorsFromRaw(paths);
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

  const wosidsPath = args.wosidsCsv || wosIdsCsvPath(paths, args.uuid || task.uuid || task.taskId);
  if (!fs.existsSync(wosidsPath)) throw new Error(`Missing WOSID CSV: ${wosidsPath}`);
  const wosids = readWosIdsCsv(wosidsPath);
  if (!wosids.length) throw new Error(`No WOS IDs found in ${wosidsPath}`);

  const checkpoint = readAuthorCheckpoint(paths);
  if (!checkpoint.startedAt) checkpoint.startedAt = new Date().toISOString();
  checkpoint.total = wosids.length;
  const work = selectAuthorWork(wosids, checkpoint, args);
  if (!work.length) {
    printAuthorWorkSummary(authorWorkSummary(wosids, checkpoint, work, args));
    const aggregate = writeAuthorAggregates(paths);
    const stats = currentAuthorStats(wosids, checkpoint);
    const failures = wosids
      .map((wosid) => checkpoint.records[wosid])
      .filter((item) => item?.status === "failed");
    writeJson(paths.authorFailures, failures);
    writeAuthorCheckpoint(paths, checkpoint);
    upsertTaskIndex(args, {
      status: stats.completed === wosids.length ? "authors-completed" : "authors-incomplete",
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
      completed: stats.completed,
      failed: stats.failed,
      authorRows: aggregate.authorRows,
      authorsCsv: paths.authorsCsv,
      checkpoint: paths.authorCheckpoint,
    };
  }
  printAuthorWorkSummary(authorWorkSummary(wosids, checkpoint, work, args));
  if (!args.sid) {
    await prepareWosExport(args);
  }
  appendProgress(paths, { phase: "authors-start", total: wosids.length, selected: work.length });
  upsertTaskIndex(args, {
    status: "authors-running",
    lastError: "",
    uuid: args.uuid || task.uuid,
    url: args.url || task.url,
    expectedCount: task.expectedCount,
    uniqueCount: task.uniqueCount,
  });

  const authSpinner = createSpinner("Validating WOS authentication");
  let authorProgress = null;
  let session = null;
  let processed = 0;
  let failed = 0;
  try {
    session = await prepareWosSession(args);
    authSpinner.succeed("WOS authentication validated");
    authorProgress = createProgress("Fetching authors", work.length);
    await runPool(work, args.concurrency, async (item) => {
      const { wosid, index } = item;
      const startedAt = new Date().toISOString();
      appendProgress(paths, { phase: "authors-record-start", wosid, index, total: wosids.length });
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
        const raw = await extractOneAuthorRecord(session.context, args, wosid);
        const normalized = normalizeAuthorRecord(wosid, raw);
        const rawPath = rawAuthorJsonPath(paths, wosid);
        writeJson(rawPath, raw);
        checkpoint.records[wosid] = {
          ...checkpoint.records[wosid],
          status: "completed",
          authorCount: normalized.authors.length,
          rawJsonPath: storedArtifactPath(paths, rawPath),
          error: "",
          updatedAt: new Date().toISOString(),
        };
        writeAuthorCheckpoint(paths, checkpoint);
        appendProgress(paths, { phase: "authors-record", status: "completed", wosid, index, authorCount: normalized.authors.length });
        if (!isInteractive()) {
          console.error(`authors OK ${index}/${wosids.length} ${wosid} authors=${normalized.authors.length}`);
        }
      } catch (error) {
        failed += 1;
        checkpoint.records[wosid] = {
          ...checkpoint.records[wosid],
          status: "failed",
          error: error && error.stack ? error.stack : String(error),
          updatedAt: new Date().toISOString(),
        };
        writeAuthorCheckpoint(paths, checkpoint);
        appendProgress(paths, { phase: "authors-record", status: "failed", wosid, index, error: error.message || String(error) });
        if (!isInteractive()) {
          console.error(`authors FAIL ${index}/${wosids.length} ${wosid}: ${error.message || error}`);
        }
      }
      processed += 1;
      authorProgress.update(processed, `${index}/${wosids.length} ${wosid}`, failed);
      if (args.cooldownMs) await sleep(args.cooldownMs);
    });
    authorProgress.stop("Author fetch complete");
  } finally {
    authSpinner.stop();
    authorProgress?.stop("Author fetch stopped");
    await session?.close?.();
  }

  const aggregate = writeAuthorAggregates(paths);
  const failures = Object.values(checkpoint.records).filter((item) => item.status === "failed");
  writeJson(paths.authorFailures, failures);
  const finalCheckpoint = readAuthorCheckpoint(paths);
  writeAuthorCheckpoint(paths, finalCheckpoint);
  const stats = currentAuthorStats(wosids, finalCheckpoint);
  const status = stats.completed === wosids.length ? "authors-completed" : "authors-incomplete";
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
    completed: stats.completed,
    failed: stats.failed,
    authorRows: aggregate.authorRows,
    authorsCsv: paths.authorsCsv,
    checkpoint: paths.authorCheckpoint,
  };
}

function validateTask(args) {
  const task = resolveTask(args);
  const paths = getRunPaths(task.taskDir);
  const summary = readJson(paths.summary, {});
  const isBibTask = summary.method === "wos-js-export-fetchBibBatches";
  const wosidsCsv = wosIdsCsvPath(paths, summary.uuid || task.uuid || task.taskId);
  const combinedBib = isBibTask ? bibFilePath(paths, summary.uuid || task.uuid) : "";
  const wosids = !isBibTask && fs.existsSync(wosidsCsv) ? readWosIdsCsv(wosidsCsv) : [];
  const rawFiles = fs.existsSync(paths.rawDir) ? fs.readdirSync(paths.rawDir).filter((name) => name.endsWith(".txt")) : [];
  const bibFiles = fs.existsSync(paths.bibDir) ? fs.readdirSync(paths.bibDir).filter((name) => name.endsWith(".bib")) : [];
  const checkpoint = readAuthorCheckpoint(paths);
  const aggregateRows = fs.existsSync(paths.authorsCsv)
    ? Math.max(0, fs.readFileSync(paths.authorsCsv, "utf8").split(/\r?\n/).filter(Boolean).length - 1)
    : 0;
  const issues = [];
  if (!fs.existsSync(paths.manifest)) issues.push("missing manifest.json");
  if (!fs.existsSync(paths.summary)) issues.push("missing summary.json");
  if (isBibTask && !bibFiles.length) issues.push("missing raw/bib batches");
  if (isBibTask && !fs.existsSync(combinedBib)) issues.push(`missing combined BibTeX file: ${path.relative(paths.taskDir, combinedBib)}`);
  if (!isBibTask && !fs.existsSync(wosidsCsv)) issues.push(`missing WOSID CSV: ${path.relative(paths.taskDir, wosidsCsv)}`);
  if (!isBibTask && summary.expectedCount && summary.uniqueCount !== summary.expectedCount) {
    issues.push(`wosid count mismatch: expected=${summary.expectedCount} unique=${summary.uniqueCount}`);
  }
  if (!isBibTask && summary.uniqueCount && wosids.length !== summary.uniqueCount) {
    issues.push(`WOSID CSV rows mismatch: csv=${wosids.length} summary.uniqueCount=${summary.uniqueCount}`);
  }
  if (!isBibTask && summary.method !== "imported-wosid-csv" && !rawFiles.length) issues.push("missing raw/full-record batches");
  const completed = Object.values(checkpoint.records || {}).filter((item) => item.status === "completed");
  for (const item of completed) {
    if (!item.rawJsonPath || !fs.existsSync(resolvedArtifactPath(paths, item.rawJsonPath))) {
      issues.push(`missing raw author json: ${item.wosid}`);
    }
  }
  return {
    ok: issues.length === 0,
    taskId: task.taskId,
    taskDir: task.taskDir,
    wosids: wosids.length,
    rawBatches: rawFiles.length,
    bibBatches: bibFiles.length,
    bibFile: combinedBib,
    authorCheckpoint: {
      total: checkpoint.total || 0,
      completed: checkpoint.completed || 0,
      failed: checkpoint.failed || 0,
      aggregateRows,
    },
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

async function run(args) {
  const initialPaths = getRunPaths(args.outDir);
  const completedSummary = !args.force ? readCompletedRunSummary(initialPaths, args) : null;
  if (completedSummary) {
    console.error("WOS ID CSV already exists; skipping download.");
    return completedSummary;
  }
  assertNoTaskUuidConflict(initialPaths, args);
  const priorSummary = readJson(initialPaths.summary, {});
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

  if (args.reuseRaw && fs.existsSync(paths.rawDir) && fs.readdirSync(paths.rawDir).some((name) => name.endsWith(".txt"))) {
    if (!info.expectedCount) {
      throw new Error("Cannot reuse raw batches without a known WOS record count. Re-run without --reuse-raw to refresh from WOS.");
    }
    const coverage = rawBatchCoverage(paths, args.uuid);
    if (!coverage.files.length) throw new Error(`No raw batches found for UUID: ${args.uuid}`);
    if (coverage.firstStart !== 1 || coverage.lastEnd < info.expectedCount) {
      throw new Error(
        `Incomplete raw batches for UUID ${args.uuid}: have ${coverage.firstStart || 0}-${coverage.lastEnd || 0}, expected 1-${info.expectedCount}. Re-run without --reuse-raw to refresh from WOS.`
      );
    }
    rows = parseExistingRawBatches(paths, args.uuid);
    appendProgress(paths, { phase: "reuse-raw", parsed: rows.length });
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
  assertNoTaskUuidConflict(initialPaths, args);
  const outputHasFiles = fs.existsSync(args.outDir) &&
    fs.readdirSync(args.outDir).some((name) => name !== ".DS_Store");
  if (args.force && outputHasFiles) {
    cleanRunLayout(initialPaths);
  }
  const paths = createRunLayout(args);
  upsertTaskIndex(args, { status: "bib-running", lastError: "" });
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
  await prepareWosExport(args);
  const result = await exportBibFromWos(args, paths);
  const uuid = result.info.uuid || args.uuid;
  const combinedBib = combineBibFiles(paths, uuid, result.files);
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
      bibDir: paths.bibDir,
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

async function runPipeline(args) {
  const summary = await run(args);
  if (!summary.ok) {
    return {
      ok: false,
      taskId: summary.taskId,
      run: summary,
      authors: null,
    };
  }
  const authors = await runAuthors({
    ...args,
    force: false,
    uuid: summary.uuid || args.uuid,
    url: summary.summaryHref || summary.inputUrl || args.url,
    wosidsCsv: summary.files?.wosidsCsv,
  });
  return {
    ok: !authors.failed,
    taskId: summary.taskId,
    run: summary,
    authors,
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
    const result = clearTask(args);
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
  if (args.command === "authors") {
    if (!args.rebuildOnly) loadSavedSid(args);
    const result = await runAuthors(args);
    console.log(result.authorsCsv || "");
    return result.failed ? 1 : 0;
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
  if (args.command === "pipeline") {
    if (!args.url || !args.uuid || !args.outDir) {
      console.error(usage());
      return 2;
    }
    const result = await runPipeline(args);
    console.log(result.authors?.authorsCsv || result.run.files.wosidsCsv);
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
    ["run", "import", "authors", "pipeline", "bib"].includes(args.command)
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

async function runInteractiveMenu(argv = process.argv) {
  const menuArgs = parseArgs([argv[0], argv[1], "workspace", ...argv.slice(3)]);
  menuArgs.keepWosSession = true;
  initializeWorkspace(menuArgs);
  ensureCurrentTask(menuArgs);

  try {
    for (;;) {
      ensureCurrentTask(menuArgs);
      let sidCheck = await quickValidateSid(menuArgs);
      if (sidCheck.status === "invalid") {
        await prepareWosSession(menuArgs, { keepAlive: true, visible: true });
        sidCheck = await quickValidateSid(menuArgs);
      }
      const selectedArgs = await interactiveArgs(VERSION, workspaceStatus(menuArgs, sidCheck), {
        makeTaskId,
        readBrowserSid: () => readSidFromBrowser(menuArgs),
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
        if (exitCode) {
          console.error(`Command exited with code ${exitCode}. Returning to menu.`);
        }
      } catch (error) {
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
  runPipeline,
  importWosIds,
  initializeWorkspace,
  workspaceStatus,
  ensureCurrentTask,
  setCurrentTaskId,
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
  runAuthors,
  validateTask,
  clearTask,
  parseArgs,
  makeTaskId,
  parseExportText,
  parseBibEntryCount,
  parseWosCount,
  downloadBatchCount,
  boundedRecordCount,
  confirmDownloadPlan,
  isUserCancelledError,
  isUserAbortError,
  runPool,
  prepareWosRequestContext,
  pageContextUuid,
  readWosIdsCsv,
  flattenAuthorRows,
  extractUuid,
  maskSid,
  announceResolvedWosUuid,
  prepareWosExport,
  readTaskIndex,
  normalizeTaskId,
  getRunPaths,
  cleanRunLayout,
  rawBatchFiles,
  parseExistingRawBatches,
  readJson,
  writeJson,
};
