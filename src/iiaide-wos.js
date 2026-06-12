const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("node:readline/promises");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { readJson, writeFileAtomic, writeJson } = require("./lib/io");
const { askSidFromBrowserOrManual, interactiveArgs, isBackResult, isQuitResult, isUserAbortError, promptConfirmationText, promptSid } = require("./lib/interactive");
const {
  PLAYWRIGHT_VERSION,
  bundledPlaywrightInstallCommand,
  installBundledPlaywrightBrowser,
  isMissingPlaywrightBrowserError,
} = require("./lib/playwright-install");
const {
  monitorSidPool,
  normalizeAuthCredentials,
  runAuthLogin,
} = require("./lib/sid-pool-monitor");
const { color, createProgress, createSpinner, isInteractive } = require("./lib/terminal");
const { updateCli } = require("./lib/update");
const { exportBibBatchesViaWosJs, exportTxtBatchesViaWosJs } = require("./lib/wos-browser-export");
const { normalizeWosId, reconcileWosId } = require("./lib/wos-ids");
const { DEFAULT_MUST_LOGIN_URL, loginAndExtractMustSid } = require("./lib/wos-must-auth");
const {
  defaultWosDataDbPath,
  defaultWosBlacklistDbPath,
  clearWosDataBlacklist,
  existingWosDataBlacklistedIds,
  existingWosDataIds,
  importWosDataRecord,
  linkExistingWosDataSources,
  mergeWosDataDatabase,
  queryWosDataBlacklist,
  queryWosDataByWosId,
  queryWosDataDatabase,
  recordWosDataBlacklist,
  removeWosDataBlacklist,
  wosDataRecordExists,
  wosDataDbStats,
} = require("./lib/wos-sqlite");
const { version: VERSION } = require("../package.json");

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_RECORD_TIMEOUT_MS = 20000;
const DEFAULT_BROWSER_RESTART_EVERY = 600;
const DEFAULT_PARSE_MEMORY_CHECK_EVERY = 200;
const DEFAULT_PARSE_MAX_RSS_MB = 4096;
const PARSE_RECOVERY_CONSECUTIVE_FAILURES = 20;
const SID_POOL_WAIT_INTERVAL_MS = 10000;
const DEFAULT_PARSE_CONNECTIVITY_QUERY = "PY=2000";
const DEFAULT_WOS_PROTOCOL = "https";
const DEFAULT_WOS_DOMAIN = "www.webofscience.com";
const DEFAULT_BASE_URL = `${DEFAULT_WOS_PROTOCOL}://${DEFAULT_WOS_DOMAIN}`;
const DEFAULT_WOSJS_PATH = path.resolve(__dirname, "..", "import", "wos.js");
const HIDDEN_BROWSER_POSITION = "-32000,0";
const WOS_POPUP_DISMISS_SELECTORS = [
  "#onetrust-accept-btn-handler",
  'button[aria-label="Accept all"]',
  'button[aria-label*="Accept"]#onetrust-accept-btn-handler',
  'button.onetrust-close-btn-handler.onetrust-close-btn-ui.banner-close-button.ot-close-icon',
  'button[aria-label="Close"].onetrust-close-btn-handler',
  "#onetrust-close-btn-container button",
  'button._pendo-close-guide[aria-label="Close"]',
  'button[id^="pendo-close-guide-"]',
];
const WOS_POPUP_DIALOG_SELECTORS = [
  'div[role="dialog"][aria-label="Privacy"]',
  "#onetrust-banner-sdk",
  ".ot-sdk-container",
];
const WOS_POPUP_GUARD_OPTIONS = {
  intervalMs: 2500,
  minClickGapMs: 500,
  observeMs: 30000,
  observeAttributes: false,
};
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

class CliRestartRequestedError extends Error {
  constructor(message = "Restarting CLI", options = {}) {
    super(message);
    this.name = "CliRestartRequestedError";
    this.code = "CLI_RESTART_REQUESTED";
    this.omitSidArgs = Boolean(options.omitSidArgs);
  }
}

class CliMessageError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "CliMessageError";
    this.code = options.code || "CLI_MESSAGE";
    this.exitCode = Number.isInteger(options.exitCode) ? options.exitCode : 1;
    this.showStack = false;
  }
}

function isUserCancelledError(error) {
  return error?.code === "USER_CANCELLED" || error?.name === "UserCancelledError";
}

function isUserQuitError(error) {
  return error?.code === "USER_QUIT" || error?.name === "UserQuitError";
}

function isCliRestartRequestedError(error) {
  return error?.code === "CLI_RESTART_REQUESTED" || error?.name === "CliRestartRequestedError";
}

function isCliMessageError(error) {
  return error?.code === "CLI_MESSAGE" || error?.name === "CliMessageError" || error?.showStack === false;
}

function usage() {
  return `
Usage:
  iiaide-wos menu
  iiaide-wos init [--tasks-root <dir>]
  iiaide-wos check [--sid <SID> | --from-browser] [--tasks-root <dir>] [--wos-domain <domain>] [--base-url <url>] [--headed]
  iiaide-wos auth login [--provider must] [--account <email>] [--password <secret>] [options]
  iiaide-wos auth monitor [--provider must] [--account <email>] [--password <secret>] [options]
  iiaide-wos sid-pool [--tasks-root <dir>]
  iiaide-wos workspace [--tasks-root <dir>]
  iiaide-wos settings [--playwright-visible <on|off>] [--parse-concurrency <n>] [--add-sid <SID>] [--add-sids "<SID...>"] [--tasks-root <dir>]
  iiaide-wos update [--check]
  iiaide-wos install-browser [--with-deps]
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
  iiaide-wos wosdata (--merge-db <file> | --wosid <WOSID> | --query <sql> | --blacklist | --unblacklist <WOSID> | --clear-blacklist) [--db <file>] [--blacklist-db <file>] [--tasks-root <dir>]

Inputs:
  --sid <SID>             Web of Science SID. Interactive commands prompt when missing or expired
  --from-browser          Open a browser login window and auto-detect WOS SID
  --provider <name>       Auth provider for auth commands. Default: must
  --account <value>       MUST account email; repeat with --password for rotation
  --password <value>      Matching MUST password; prefer prompt/env when possible
  --auth-url <url>        Override the MUST SSO login URL
  --no-save               Auth login only: do not save the captured SID
  --retries <n>           Auth login retry count. Default: 1
  --interval-ms <n>       Auth monitor interval. Default: 3000
  --min-sids <n>          Auth monitor low-water mark; refresh when pool <= n. Default: 2
  --threshold <n>         Alias for --min-sids
  --retry-delay-ms <n>    Auth monitor delay after a refresh failure. Default: 60000
  --max-checks <n>        Auth monitor stop after n checks. Default: 0 = infinite
  --quiet                 Auth commands: suppress progress lines
  --json                  Auth commands: print machine-readable JSON
  --url <summary-url>     WOS summary URL
  --uuid <uuid>           WOS result-set UUID; used when --url is not provided
  --csv <file>            Existing CSV containing a wosid/UT column or WOS IDs in its first column
  --merge-db <file>       Merge records from another WOS SQLite database into --db
  --wosid <WOSID>         Query one WOS record from the SQLite database
  --query <sql>           Run a read-only SELECT query against the WOS SQLite database
  --blacklist             List WOSIDs skipped by parse because record-level parsing failed
  --unblacklist <WOSID>   Remove one WOSID from the parse blacklist
  --clear-blacklist       Remove all WOSIDs from the parse blacklist

Output management:
  --task <task-id>        Stable task id. If omitted, creates a timestamp-based task id
  --task-label <label>    Human label stored in task metadata
  --tasks-root <dir>      Parent directory for tasks. Default: ./tasks
  --db <file>             SQLite WOS data database. Default: ~/.iiaide-wos/wosdata.sqlite
  --blacklist-db <file>   SQLite parse blacklist database. Default: ~/.iiaide-wos/wos-blacklist.sqlite
  --out-dir <dir>         Exact task directory override
  --force                 Allow managed task replacement
  --reuse-raw             Rebuild CSV from existing raw batches when present

Export options:
  --sort-by <sort>        Summary sort key. Default: relevance
  --batch-size <n>        WOS export API batch size. Default: 200, max: 500
  --timeout-ms <n>        Navigation/API timeout. Default: 120000
  --wos-domain <domain>   WOS domain. Default: www.webofscience.com
  --wosjs <file>          Browser-side wos.js injection file. Default: ./import/wos.js
  --base-url <url>        WOS origin URL. Default: https://www.webofscience.com
  --headed                Show browser instead of headless mode
  --headless              Run browser in background mode for this command
  --playwright-visible <on|off>
                          Save whether WOS Playwright work opens a visible browser
  --parse-concurrency <n> Save default parse reusable WOS tabs. 1-10
  --add-sid <SID>         Add one SID to the saved SID pool; compatibility alias
  --add-sids <text>       Add multiple SIDs separated by spaces, newlines, or commas
  --version               Show CLI version
  --help                  Show this help
  --check                 Check for an update without installing it
  --with-deps             Install Playwright Linux system packages with Chromium

Range options:
  --from-index <n>        Start from 1-based WOS record/WOSID index
  --limit <n>             Process only n records/WOS IDs

Parse options:
  --concurrency <n>       Parallel full-record pages. Default: 1
  --record-timeout-ms <n> Per-record full-page timeout. Default: 20000
  --cooldown-ms <n>       Delay after each record. Default: 250
  --browser-restart-every <n>
                          Restart Playwright after n parsed WOSIDs. Default: 600, 0 disables
  --max-rss-mb <n>        Restart Playwright between parse chunks when RSS exceeds n MB. Default: 4096, 0 disables
  --retry-blacklist       Include blacklisted parse-failed WOSIDs in this parse run
  --reparse-existing      Visit WOSIDs that already exist in SQLite and overwrite them

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
  const authCommand = command === "auth" && argv[3] && !argv[3].startsWith("--") ? argv[3] : "login";
  const startIndex = command === "run" ? (argv[2] === "run" ? 3 : 2) : (command === "auth" && argv[3] === authCommand ? 4 : 3);
  const args = {
    command,
    authCommand,
    sid: "",
    sidSource: "",
    sidPoolIndex: -1,
    sidPoolCount: 0,
    invalidatedSids: [],
    fromBrowser: false,
    url: "",
    urlHadProtocol: false,
    uuid: "",
    csvPath: "",
    mergeDbPath: "",
    queryWosId: "",
    unblacklistWosId: "",
    sqlQuery: "",
    blacklistQuery: false,
    clearBlacklist: false,
    taskId: "",
    taskLabel: "",
    outDir: "",
    tasksRoot: path.resolve(process.cwd(), "tasks"),
    dbPath: "",
    blacklistDbPath: "",
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
    headedSource: "",
    playwrightVisible: null,
    parseConcurrencySetting: null,
    addSidInputs: [],
    force: false,
    reuseRaw: false,
    retryBlacklist: false,
    reparseExisting: false,
    concurrency: 1,
    concurrencySource: "",
    recordTimeoutMs: DEFAULT_RECORD_TIMEOUT_MS,
    browserRestartEvery: DEFAULT_BROWSER_RESTART_EVERY,
    memoryCheckEvery: DEFAULT_PARSE_MEMORY_CHECK_EVERY,
    maxRssMb: DEFAULT_PARSE_MAX_RSS_MB,
    limit: 0,
    fromIndex: 1,
    fromIndexSource: "",
    cooldownMs: 250,
    checkOnly: false,
    withDeps: false,
    authProvider: "must",
    authLoginUrl: process.env.WOS_LOGIN_URL || DEFAULT_MUST_LOGIN_URL,
    authAccount: process.env.WOS_ACCOUNT || "",
    authPassword: process.env.WOS_PASSWORD || "",
    authAccounts: [],
    authPasswords: [],
    authSave: true,
    authRetries: 1,
    authIntervalMs: 3000,
    authMinSids: 2,
    authRetryDelayMs: 60000,
    authMaxChecks: 0,
    authQuiet: false,
    json: false,
    help: false,
    version: false,
  };
  let sawAuthAccountArg = false;
  let sawAuthPasswordArg = false;

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
    else if (arg === "--provider") args.authProvider = readValue(arg, i++);
    else if (arg === "--account") {
      if (!sawAuthAccountArg) {
        args.authAccounts = [];
        sawAuthAccountArg = true;
      }
      args.authAccounts.push(readValue(arg, i++));
    }
    else if (arg === "--password") {
      if (!sawAuthPasswordArg) {
        args.authPasswords = [];
        sawAuthPasswordArg = true;
      }
      args.authPasswords.push(readValue(arg, i++));
    }
    else if (arg === "--auth-url" || arg === "--login-url") args.authLoginUrl = readValue(arg, i++);
    else if (arg === "--no-save") args.authSave = false;
    else if (arg === "--retries") args.authRetries = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--interval-ms") args.authIntervalMs = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--min-sids" || arg === "--threshold") args.authMinSids = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--retry-delay-ms") args.authRetryDelayMs = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--max-checks") args.authMaxChecks = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--quiet") args.authQuiet = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--url") {
      args.url = readValue(arg, i++);
      args.urlHadProtocol = /^https?:\/\//i.test(args.url);
    }
    else if (arg === "--uuid") args.uuid = readValue(arg, i++);
    else if (arg === "--csv") args.csvPath = readValue(arg, i++);
    else if (arg === "--merge-db") args.mergeDbPath = readValue(arg, i++);
    else if (arg === "--wosid" || arg === "--wos-id") args.queryWosId = readValue(arg, i++);
    else if (arg === "--unblacklist" || arg === "--remove-blacklist") args.unblacklistWosId = readValue(arg, i++);
    else if (arg === "--query" || arg === "--sql") args.sqlQuery = readValue(arg, i++);
    else if (arg === "--blacklist" || arg === "--list-blacklist") args.blacklistQuery = true;
    else if (arg === "--clear-blacklist") args.clearBlacklist = true;
    else if (arg === "--task") args.taskId = normalizeTaskId(readValue(arg, i++));
    else if (arg === "--latest") args.latest = true;
    else if (arg === "--task-label" || arg === "--label") args.taskLabel = readValue(arg, i++);
    else if (arg === "--out-dir" || arg === "--download-dir") args.outDir = readValue(arg, i++);
    else if (arg === "--tasks-root" || arg === "--output-root") args.tasksRoot = readValue(arg, i++);
    else if (arg === "--db") args.dbPath = readValue(arg, i++);
    else if (arg === "--blacklist-db") args.blacklistDbPath = readValue(arg, i++);
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
    else if (arg === "--headed") {
      args.headed = true;
      args.headedSource = "cli";
    }
    else if (arg === "--headless") {
      args.headed = false;
      args.headedSource = "cli";
    }
    else if (arg === "--playwright-visible") args.playwrightVisible = parseBooleanFlag(arg, readValue(arg, i++));
    else if (arg === "--add-sid") args.addSidInputs.push(readValue(arg, i++));
    else if (arg === "--add-sids") args.addSidInputs.push(readValue(arg, i++));
    else if (arg === "--force") args.force = true;
    else if (arg === "--reuse-raw") args.reuseRaw = true;
    else if (arg === "--retry-blacklist") args.retryBlacklist = true;
    else if (arg === "--reparse-existing" || arg === "--overwrite-existing") args.reparseExisting = true;
    else if (arg === "--concurrency") {
      args.concurrency = parseIntegerFlag(arg, readValue(arg, i++));
      args.concurrencySource = "cli";
    }
    else if (arg === "--parse-concurrency" || arg === "--parse-tabs") {
      const value = parseIntegerFlag(arg, readValue(arg, i++));
      args.parseConcurrencySetting = value;
      if (!args.concurrencySource && command !== "settings") {
        args.concurrency = value;
        args.concurrencySource = "cli";
      }
    }
    else if (arg === "--limit") args.limit = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--from-index") {
      args.fromIndex = parseIntegerFlag(arg, readValue(arg, i++));
      args.fromIndexSource = "cli";
    }
    else if (arg === "--record-timeout-ms" || arg === "--record-timeout" || arg === "--page-timeout-ms") args.recordTimeoutMs = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--cooldown-ms") args.cooldownMs = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--browser-restart-every" || arg === "--parse-restart-every" || arg === "--restart-every") args.browserRestartEvery = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--max-rss-mb" || arg === "--memory-restart-mb") args.maxRssMb = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--check") args.checkOnly = true;
    else if (arg === "--with-deps") args.withDeps = true;
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
  assertIntegerRange("--retries", args.authRetries, 0);
  assertIntegerRange("--interval-ms", args.authIntervalMs, 1000);
  assertIntegerRange("--min-sids", args.authMinSids, 0);
  assertIntegerRange("--retry-delay-ms", args.authRetryDelayMs, 1000);
  assertIntegerRange("--max-checks", args.authMaxChecks, 0);
  assertIntegerRange("--record-timeout-ms", args.recordTimeoutMs, 5000);
  assertIntegerRange("--concurrency", args.concurrency, 1, 10);
  if (args.parseConcurrencySetting !== null) assertIntegerRange("--parse-concurrency", args.parseConcurrencySetting, 1, 10);
  assertIntegerRange("--limit", args.limit, 0);
  assertIntegerRange("--from-index", args.fromIndex, 1);
  assertIntegerRange("--cooldown-ms", args.cooldownMs, 0);
  assertIntegerRange("--browser-restart-every", args.browserRestartEvery, 0);
  assertIntegerRange("--max-rss-mb", args.maxRssMb, 0);
  args.tasksRoot = path.resolve(args.tasksRoot);
  applySavedRuntimeSettings(args);
  assertIntegerRange("--concurrency", args.concurrency, 1, 10);
  if (args.csvPath) args.csvPath = path.resolve(args.csvPath);
  if (args.mergeDbPath) args.mergeDbPath = path.resolve(args.mergeDbPath);
  args.dbPath = args.dbPath ? path.resolve(args.dbPath) : defaultWosDataDbPath();
  args.blacklistDbPath = args.blacklistDbPath ? path.resolve(args.blacklistDbPath) : defaultWosBlacklistDbPath();
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

function parseBooleanFlag(flag, value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "y", "on", "visible", "headed"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off", "background", "headless"].includes(normalized)) return false;
  throw new Error(`Invalid boolean for ${flag}: ${value}`);
}

function omitSidArgs(argv = []) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--sid") {
      index += 1;
      continue;
    }
    result.push(argv[index]);
  }
  return result;
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

function isSessionRecoveryError(error) {
  const message = String(error?.message || error || "");
  return /query limit|session expired|invalid session|invalid sid|sid .*invalid|logged out|sign[ -]?in|login page/i.test(message) ||
    /browser .*closed|context .*closed|target .*closed|page .*closed|execution context was destroyed|protocol error|websocket.*closed/i.test(message) ||
    /WOS parse session is not available|wos\.js .*missing/i.test(message);
}

function isWosIdNoResultError(error) {
  const message = String(error?.message || error || "");
  return /No full-record JSON parsed|Failed to open full record|Full record timeout|full record page navigation|full-record route|current route=.*page=unknown/i.test(message);
}

function isWosIdBlacklistableError(error) {
  const message = String(error?.message || error || "");
  return Boolean(message);
}

function isSidInvalidRecoveryErrorCode(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/^unknown error$/i.test(text)) return false;
  if (/failed to read (current query page|query result page) info/i.test(text)) return false;
  return /query limit|session|sid|logged out|sign[ -]?in|login|expired|invalid/i.test(text);
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

function globalConfigPath() {
  if (process.env.IIAIDE_WOS_CONFIG) return path.resolve(process.env.IIAIDE_WOS_CONFIG);
  return path.join(os.homedir(), ".iiaide-wos", "config.json");
}

function authMonitorStatusPath() {
  return path.join(path.dirname(globalConfigPath()), "auth-monitor.json");
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

function readGlobalConfig() {
  return readJson(globalConfigPath(), { version: 1 });
}

function readAuthMonitorStatus(options = {}) {
  const statusPath = authMonitorStatusPath();
  const raw = readJson(statusPath, null);
  if (!raw) {
    return {
      status: "off",
      label: "off",
      path: statusPath,
    };
  }
  const provider = raw.provider || "must";
  const updatedAt = raw.updatedAt || "";
  const updatedMs = Date.parse(updatedAt);
  const nowMs = Number(options.nowMs ?? Date.now());
  const ageMs = Number.isFinite(updatedMs) ? Math.max(0, nowMs - updatedMs) : Number.MAX_SAFE_INTEGER;
  const intervalMs = Math.max(0, Number(raw.intervalMs || 0));
  const staleAfterMs = Math.max(intervalMs * 3, 15000);
  const status = raw.status === "running" && ageMs <= staleAfterMs
    ? "running"
    : (raw.status === "running" ? "stale" : "off");
  const minSids = Number(raw.minSids || 0);
  const label = status === "running"
    ? `${provider} monitor running, min-sids ${minSids}`
    : (status === "stale" ? `${provider} monitor stale` : "off");
  return {
    status,
    label,
    provider,
    minSids,
    intervalMs,
    staleAfterMs,
    ageMs,
    pid: raw.pid || 0,
    checks: Number(raw.checks || 0),
    triggered: Number(raw.triggered || 0),
    startedAt: raw.startedAt || "",
    updatedAt,
    path: statusPath,
  };
}

function applySavedRuntimeSettings(args) {
  const config = readConfig(args.tasksRoot);
  if (!args.headedSource && typeof config.playwrightVisible === "boolean") {
    args.headed = config.playwrightVisible;
  }
  if (!args.concurrencySource && Number.isSafeInteger(config.parseConcurrency)) {
    args.concurrency = config.parseConcurrency;
  }
  return config;
}

function writeConfig(tasksRoot, config) {
  fs.mkdirSync(tasksRoot, { recursive: true });
  writeJson(
    configPath(tasksRoot),
    { version: 1, ...config, updatedAt: new Date().toISOString() },
    { mode: 0o600, backup: true }
  );
}

function writeGlobalConfig(config) {
  fs.mkdirSync(path.dirname(globalConfigPath()), { recursive: true });
  writeJson(
    globalConfigPath(),
    { version: 1, ...config, updatedAt: new Date().toISOString() },
    { mode: 0o600, backup: true }
  );
}

function writeAuthMonitorStatus(args, patch = {}) {
  const now = new Date().toISOString();
  const existing = readJson(authMonitorStatusPath(), {});
  const status = patch.status || existing.status || "running";
  const next = {
    version: 1,
    provider: args.authProvider || patch.provider || existing.provider || "must",
    command: "auth monitor",
    status,
    pid: process.pid,
    minSids: Number(args.authMinSids ?? patch.minSids ?? existing.minSids ?? 0),
    intervalMs: Number(args.authIntervalMs ?? patch.intervalMs ?? existing.intervalMs ?? 0),
    checks: Number(patch.checks ?? existing.checks ?? 0),
    triggered: Number(patch.triggered ?? existing.triggered ?? 0),
    startedAt: patch.startedAt || existing.startedAt || now,
    updatedAt: now,
  };
  fs.mkdirSync(path.dirname(authMonitorStatusPath()), { recursive: true });
  writeJson(authMonitorStatusPath(), next, { mode: 0o600, backup: true });
  return next;
}

function parseSidValues(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupeSidValues(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const sid = String(value || "").trim();
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    result.push(sid);
  }
  return result;
}

function sidPoolFromConfig(config = {}) {
  const sids = dedupeSidValues([
    ...(Array.isArray(config.sids) ? config.sids : []),
    ...(config.sid ? [config.sid] : []),
  ]);
  const sidCursor = Number.isSafeInteger(config.sidCursor) && config.sidCursor >= 0
    ? config.sidCursor
    : 0;
  const activeIndex = sids.length ? sidCursor % sids.length : -1;
  return {
    sids,
    activeIndex,
    activeSid: activeIndex >= 0 ? sids[activeIndex] : "",
  };
}

function currentSidPoolStatus(args) {
  const config = readSidConfig(args);
  const pool = sidPoolFromConfig(config);
  const activeNumber = pool.activeIndex >= 0 ? pool.activeIndex + 1 : 0;
  return {
    ok: true,
    config: globalConfigPath(),
    sidPoolCount: pool.sids.length,
    sidPoolIndex: pool.activeIndex,
    sidPoolPosition: activeNumber,
    activeSid: maskSid(pool.activeSid),
    sids: pool.sids.map(maskSid),
  };
}

function migrateLegacyWorkspaceSidConfig(args) {
  const workspaceConfig = readConfig(args.tasksRoot);
  const workspacePool = sidPoolFromConfig(workspaceConfig);
  const hasWorkspaceSidConfig = Boolean(
    workspaceConfig.sid ||
    workspacePool.sids.length ||
    Number.isSafeInteger(workspaceConfig.sidCursor) ||
    Array.isArray(workspaceConfig.deadSids)
  );
  const globalConfig = readGlobalConfig();
  if (!hasWorkspaceSidConfig) return globalConfig;

  const globalPool = sidPoolFromConfig(globalConfig);
  const mergedSids = dedupeSidValues([...globalPool.sids, ...workspacePool.sids]);
  const activeSid = globalPool.activeSid || workspacePool.activeSid || mergedSids[0] || "";
  const sidCursor = activeSid ? Math.max(0, mergedSids.indexOf(activeSid)) : 0;
  const deadSids = [
    ...(Array.isArray(globalConfig.deadSids) ? globalConfig.deadSids : []),
    ...(Array.isArray(workspaceConfig.deadSids) ? workspaceConfig.deadSids : []),
  ].slice(-50);
  const { sid: _globalSid, ...globalRest } = globalConfig;
  const nextGlobalConfig = {
    ...globalRest,
    sids: mergedSids,
    sidCursor,
    ...(deadSids.length ? { deadSids } : {}),
  };
  writeGlobalConfig(nextGlobalConfig);

  const {
    sid: _workspaceSid,
    sids: _workspaceSids,
    sidCursor: _workspaceSidCursor,
    deadSids: _workspaceDeadSids,
    ...workspaceRest
  } = workspaceConfig;
  writeConfig(args.tasksRoot, workspaceRest);
  return nextGlobalConfig;
}

function readSidConfig(args) {
  return migrateLegacyWorkspaceSidConfig(args);
}

function addSidsToConfig(args, values, options = {}) {
  const inputs = Array.isArray(values) ? values : [values];
  const incoming = dedupeSidValues(inputs.flatMap(parseSidValues));
  const config = readSidConfig(args);
  const pool = sidPoolFromConfig(config);
  const merged = dedupeSidValues([...pool.sids, ...incoming]);
  const { sid: _sid, ...rest } = config;
  const activeSid = options.activate
    ? (incoming[0] || pool.activeSid || merged[0] || "")
    : (pool.activeSid || incoming[0] || merged[0] || "");
  const sidCursor = activeSid ? Math.max(0, merged.indexOf(activeSid)) : 0;
  writeGlobalConfig({
    ...rest,
    sids: merged,
    sidCursor,
  });
  if (!args.sid && activeSid) {
    args.sid = activeSid;
    args.sidSource = "config";
    args.sidPoolIndex = sidCursor;
    args.sidPoolCount = merged.length;
  }
  return {
    ok: true,
    config: globalConfigPath(),
    added: incoming.filter((sid) => !pool.sids.includes(sid)).length,
    sidPoolCount: merged.length,
    activeSid,
  };
}

function rememberInvalidatedSid(args, sid) {
  const value = String(sid || "").trim();
  if (!value) return;
  if (!Array.isArray(args.invalidatedSids)) args.invalidatedSids = [];
  if (!args.invalidatedSids.includes(value)) args.invalidatedSids.push(value);
}

function rememberDeadConfigSids(args, config = {}) {
  const deadSids = Array.isArray(config.deadSids) ? config.deadSids : [];
  for (const entry of deadSids) {
    rememberInvalidatedSid(args, entry?.sid || entry);
  }
}

function discardActiveConfigSid(args, reason = "invalid", options = {}) {
  if ((!options.force && args.sidSource !== "config") || !args.sid) return false;
  const config = readSidConfig(args);
  const pool = sidPoolFromConfig(config);
  if (!pool.sids.length) return false;
  const removeIndex = pool.activeIndex >= 0 && pool.sids[pool.activeIndex] === args.sid
    ? pool.activeIndex
    : pool.sids.indexOf(args.sid);
  if (removeIndex < 0) return false;
  const removedSid = pool.sids[removeIndex];
  const nextSids = pool.sids.filter((_, index) => index !== removeIndex);
  const nextCursor = nextSids.length ? removeIndex % nextSids.length : 0;
  const deadSids = [
    ...(Array.isArray(config.deadSids) ? config.deadSids : []),
    {
      sid: removedSid,
      reason: String(reason || "invalid"),
      removedAt: new Date().toISOString(),
    },
  ].slice(-50);
  const { sid: _sid, ...rest } = config;
  writeGlobalConfig({
    ...rest,
    sids: nextSids,
    sidCursor: nextCursor,
    deadSids,
  });
  rememberInvalidatedSid(args, removedSid);
  args.sid = "";
  args.sidSource = "";
  args.sidPoolIndex = -1;
  args.sidPoolCount = nextSids.length;
  return {
    removedSid,
    sidPoolCount: nextSids.length,
    nextIndex: nextCursor,
  };
}

function saveSidConfig(args, observedSid) {
  const sidConfig = readSidConfig(args);
  rememberDeadConfigSids(args, sidConfig);
  const pool = sidPoolFromConfig(sidConfig);
  const sidValue = String(observedSid || args.sid || "").trim();
  const nextSids = args.sidSource === "env" || !sidValue
    ? pool.sids
    : dedupeSidValues([...pool.sids, sidValue]);
  const nextCursor = sidValue && nextSids.includes(sidValue)
    ? nextSids.indexOf(sidValue)
    : Math.max(0, pool.activeIndex);
  const { sid: _sid, ...rest } = sidConfig;
  writeGlobalConfig({
    ...rest,
    ...(nextSids.length ? { sids: nextSids, sidCursor: nextCursor } : { sids: [], sidCursor: 0 }),
  });
  const config = readConfig(args.tasksRoot);
  writeConfig(args.tasksRoot, {
    ...config,
    wosDomain: args.wosDomain || urlDomain(args.baseUrl) || DEFAULT_WOS_DOMAIN,
    baseUrl: args.baseUrl,
  });
  if (sidValue && args.sidSource !== "env") {
    args.sid = sidValue;
    args.sidPoolIndex = nextCursor;
    args.sidPoolCount = nextSids.length;
  }
}

function loadSavedSidFromConfig(args) {
  const sidConfig = readSidConfig(args);
  rememberDeadConfigSids(args, sidConfig);
  const pool = sidPoolFromConfig(sidConfig);
  args.sidPoolCount = pool.sids.length;
  args.sidPoolIndex = pool.activeIndex;
  if (pool.activeSid) {
    args.sid = pool.activeSid;
    args.sidSource = "config";
    return args.sid;
  }
  return "";
}

function setPlaywrightVisibleSetting(args, visible) {
  const config = readConfig(args.tasksRoot);
  const playwrightVisible = Boolean(visible);
  writeConfig(args.tasksRoot, {
    ...config,
    playwrightVisible,
  });
  if (!args.headedSource) args.headed = playwrightVisible;
  return {
    ok: true,
    config: configPath(args.tasksRoot),
    playwrightVisible,
    wosBrowserMode: playwrightVisible ? "visible" : "background",
  };
}

function setParseConcurrencySetting(args, value) {
  assertIntegerRange("--parse-concurrency", value, 1, 10);
  const config = readConfig(args.tasksRoot);
  writeConfig(args.tasksRoot, {
    ...config,
    parseConcurrency: value,
  });
  if (!args.concurrencySource) args.concurrency = value;
  return {
    ok: true,
    config: configPath(args.tasksRoot),
    parseConcurrency: value,
  };
}

function clearSavedSidConfig(args) {
  const config = readSidConfig(args);
  const pool = sidPoolFromConfig(config);
  if (!config.sid && !pool.sids.length && !args.sid) return false;
  const { sid: _sid, sids: _sids, sidCursor: _sidCursor, deadSids: _deadSids, ...rest } = config;
  writeGlobalConfig(rest);
  args.sid = "";
  args.sidSource = "";
  args.sidPoolIndex = -1;
  args.sidPoolCount = 0;
  return true;
}

function loadSavedSid(args) {
  const config = applySavedRuntimeSettings(args);
  if (args.sid) return args.sid;
  if (process.env.WOS_SID) {
    args.sid = process.env.WOS_SID;
    args.sidSource = "env";
    return args.sid;
  }
  if (config.baseUrl && !args.baseUrlSource) {
    args.baseUrl = stripTrailingSlash(config.baseUrl);
    args.wosDomain = config.wosDomain || urlDomain(args.baseUrl) || args.wosDomain;
  } else if (config.wosDomain && !args.baseUrlSource) {
    args.wosDomain = normalizeWosDomain(config.wosDomain);
    args.baseUrl = wosOriginFromDomain(args.wosDomain);
  }
  loadSavedSidFromConfig(args);
  return args.sid;
}

function maskSid(value) {
  const sid = String(value || "").trim();
  if (!sid) return "";
  if (sid.length <= 8) return `${sid.slice(0, 1)}***${sid.slice(-1)}`;
  return `${sid.slice(0, 4)}...${sid.slice(-4)}`;
}

function redactSidInUrl(value) {
  return String(value || "").replace(/([?&]SID=)[^&#\s]+/gi, "$1[redacted]");
}

function sidBadge(args, stream = process.stderr) {
  const sid = String(args?.sid || "").trim();
  if (!sid) return "";
  const source = args?.sidSource ? ` ${args.sidSource}` : "";
  const pool = args?.sidPoolCount
    ? ` ${Math.max(0, Number(args.sidPoolIndex) + 1)}/${args.sidPoolCount}`
    : "";
  return color("30;46;1", ` SID${source}${pool}: ${maskSid(sid)} `, stream);
}

function authValidatedMessage(args) {
  const badge = sidBadge(args);
  return badge ? `WOS authentication validated ${badge}` : "WOS authentication validated";
}

function writeRuntimeNotice(title, lines = [], stream = process.stderr) {
  const prefix = isInteractive(stream) ? "\n" : "";
  const heading = color("33;1", title, stream);
  const body = lines.filter(Boolean).map((line) => `  ${line}`).join("\n");
  stream.write(`${prefix}${heading}${body ? `\n${body}` : ""}\n`);
}

async function quickValidateCurrentSid(args, options = {}) {
  const sid = args.sid;
  const sidSource = args.sidSource || "";
  if (!sid) {
    return { status: "missing", sidSource, sid, sidMasked: maskSid(sid), ok: false, message: "No SID configured" };
  }
  const sidMasked = maskSid(sid);

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { status: "unknown", sidSource, sid, sidMasked, ok: false, message: "fetch is not available" };
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
      return { status: "invalid", sidSource, sid, sidMasked, ok: false, href, origin, httpStatus: response.status, message: "SID was rejected by WOS" };
    }
    if (response.ok && text.includes(sid) && /sessionData|BasicProperties|SID/.test(text)) {
      return { status: "valid", sidSource, sid, sidMasked, ok: true, href, origin, httpStatus: response.status, message: "SID accepted by WOS" };
    }
    return {
      status: "unknown",
      sidSource,
      sid,
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
      sid,
      sidMasked,
      ok: false,
      message: error?.name === "AbortError" ? "SID check timed out" : `SID check failed: ${error.message || error}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function quickValidateSid(args, options = {}) {
  loadSavedSid(args);
  for (;;) {
    const result = await quickValidateCurrentSid(args, options);
    if (result.status !== "invalid" || args.sidSource !== "config") return result;
    const discarded = discardActiveConfigSid(args, result.message || "SID was rejected by WOS");
    if (!discarded) return result;
    if (!discarded.sidPoolCount) {
      return {
        ...result,
        status: "missing",
        ok: false,
        sid: "",
        sidMasked: "",
        sidSource: "",
        sidPoolCount: 0,
        discardedSid: discarded.removedSid,
        message: "All saved SIDs were rejected by WOS",
      };
    }
    loadSavedSid(args);
  }
}

function wosUserDataDir(args) {
  return path.join(args.tasksRoot, ".browser-profile");
}

function wosProfileName(args) {
  return path.basename(wosUserDataDir(args));
}

function wosBrowserMode(args) {
  return args.headed ? "visible" : "background";
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

async function installWosPopupGuard(context) {
  await context.addInitScript(({ selectors, dialogSelectors, options }) => {
    if (window.__IIAIDE_WOS_POPUP_GUARD__) return;
    window.__IIAIDE_WOS_POPUP_GUARD__ = true;

    let lastClickAt = 0;
    const isVisible = (element) => {
      if (!element || element.disabled) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
    };

    const findVisibleElement = (selectorList, root = document) => {
      for (const selector of selectorList) {
        const element = root.querySelector(selector);
        if (isVisible(element)) return { selector, element };
      }
      return null;
    };

    const dismissOneTrustDialog = () => {
      const dialogMatch = findVisibleElement(dialogSelectors);
      if (!dialogMatch) return false;
      const dialogRoot = dialogMatch.element;
      const preferredButton = findVisibleElement([
        "#onetrust-accept-btn-handler",
        'button[aria-label="Accept all"]',
        'button[aria-label*="Accept"]',
        "#onetrust-close-btn-container button",
        'button[aria-label="Close"].onetrust-close-btn-handler',
        'button.onetrust-close-btn-handler',
      ], dialogRoot);
      if (!preferredButton) return false;
      preferredButton.element.click();
      return true;
    };

    const dismissKnownPopups = () => {
      const now = Date.now();
      if (now - lastClickAt < options.minClickGapMs) return false;
      if (dismissOneTrustDialog()) {
        lastClickAt = now;
        return true;
      }
      for (const selector of selectors) {
        const button = document.querySelector(selector);
        if (!isVisible(button)) continue;
        button.click();
        lastClickAt = now;
        return true;
      }
      return false;
    };

    const startWosGuard = () => {
      if (typeof window.wos?.guard?.startWosPopupGuard === "function") {
        try {
          window.wos.guard.startWosPopupGuard(options);
          return true;
        } catch (_) {
          return false;
        }
      }
      if (typeof window.asy_webFuncs?.startWosPopupGuard === "function") {
        try {
          window.asy_webFuncs.startWosPopupGuard(options);
          return true;
        } catch (_) {
          return false;
        }
      }
      return false;
    };

    const observer = new MutationObserver(() => {
      dismissKnownPopups();
      startWosGuard();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    dismissKnownPopups();
    startWosGuard();
    const interval = options.intervalMs > 0 ? window.setInterval(() => {
      dismissKnownPopups();
      startWosGuard();
    }, options.intervalMs) : 0;
    const timeout = options.observeMs > 0 ? window.setTimeout(() => {
      observer.disconnect();
      if (interval) window.clearInterval(interval);
      window.__IIAIDE_WOS_POPUP_GUARD__ = false;
    }, options.observeMs) : 0;
    window.__IIAIDE_WOS_POPUP_GUARD_STOP__ = () => {
      observer.disconnect();
      if (interval) window.clearInterval(interval);
      if (timeout) window.clearTimeout(timeout);
      window.__IIAIDE_WOS_POPUP_GUARD__ = false;
    };
  }, {
    selectors: WOS_POPUP_DISMISS_SELECTORS,
    dialogSelectors: WOS_POPUP_DIALOG_SELECTORS,
    options: WOS_POPUP_GUARD_OPTIONS,
  });
}

async function dismissWosPopups(page) {
  return page.evaluate(({ selectors, dialogSelectors, options }) => {
    const isVisible = (element) => {
      if (!element || element.disabled) return false;
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
    };

    const findVisibleElement = (selectorList, root = document) => {
      for (const selector of selectorList) {
        const element = root.querySelector(selector);
        if (isVisible(element)) return { selector, element };
      }
      return null;
    };

    let clickedSelector = "";
    const dialogMatch = findVisibleElement(dialogSelectors);
    if (dialogMatch) {
      const preferredButton = findVisibleElement([
        "#onetrust-accept-btn-handler",
        'button[aria-label="Accept all"]',
        'button[aria-label*="Accept"]',
        "#onetrust-close-btn-container button",
        'button[aria-label="Close"].onetrust-close-btn-handler',
        'button.onetrust-close-btn-handler',
      ], dialogMatch.element);
      if (preferredButton) {
        preferredButton.element.click();
        clickedSelector = `${dialogMatch.selector} ${preferredButton.selector}`;
      }
    }

    if (!clickedSelector) {
    for (const selector of selectors) {
      const button = document.querySelector(selector);
      if (!isVisible(button)) continue;
      button.click();
      clickedSelector = selector;
      break;
    }
    }

    if (typeof window.wos?.guard?.startWosPopupGuard === "function") {
      window.wos.guard.startWosPopupGuard(options);
    } else if (typeof window.asy_webFuncs?.startWosPopupGuard === "function") {
      window.asy_webFuncs.startWosPopupGuard(options);
    }

    return {
      clickedSelector,
      hasDialog: Boolean(findVisibleElement(dialogSelectors)),
    };
  }, {
    selectors: WOS_POPUP_DISMISS_SELECTORS,
    dialogSelectors: WOS_POPUP_DIALOG_SELECTORS,
    options: WOS_POPUP_GUARD_OPTIONS,
  }).catch(() => ({
    clickedSelector: "",
    hasDialog: false,
  }));
}

async function injectWosJs(context, args) {
  const filePath = requireWosJsPath(args);
  await installWosPopupGuard(context);
  await context.addInitScript({ path: filePath });
  for (const page of context.pages()) {
    await ensureWosJsOnPage(page, args);
    await dismissWosPopups(page);
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

function missingPlaywrightBrowserMessage(args, command = bundledPlaywrightInstallCommand()) {
  const hint = args?.withDeps
    ? ` If Linux is still missing shared libraries, rerun with ${bundledPlaywrightInstallCommand({ withDeps: true })}.`
    : ` On Linux, if shared libraries are also missing, rerun with ${bundledPlaywrightInstallCommand({ withDeps: true })}.`;
  return [
    `Playwright Chromium for iiaide-wos is not installed for bundled Playwright ${PLAYWRIGHT_VERSION}.`,
    `Run ${command} and then retry your WOS command.`,
    hint.trim(),
  ].join(" ");
}

async function ensurePlaywrightBrowserInstalledForLaunch(args, error, options = {}) {
  if (!isMissingPlaywrightBrowserError(error)) return false;
  const prompt = options.prompt || promptConfirmationText;
  const report = options.report || console.error;
  const install = options.install || installBundledPlaywrightBrowser;
  const canPrompt = options.canPrompt || (() => process.stdin.isTTY && isInteractive(process.stdout));
  const installCommand = bundledPlaywrightInstallCommand();

  if (!canPrompt()) {
    throw new CliMessageError(missingPlaywrightBrowserMessage(args, installCommand), { code: "PLAYWRIGHT_BROWSER_MISSING" });
  }

  const answer = await prompt(`Playwright Chromium is missing. Type install to run ${installCommand}, B back, or q quit`);
  if (isQuitResult(answer)) throw new UserQuitError("Playwright browser install quit by user");
  if (isBackResult(answer)) throw new UserCancelledError("Playwright browser install cancelled");
  if (!/^install$/i.test(String(answer || "").trim())) {
    throw new CliMessageError(missingPlaywrightBrowserMessage(args, installCommand), { code: "PLAYWRIGHT_BROWSER_MISSING" });
  }

  report(`Installing Playwright Chromium ${PLAYWRIGHT_VERSION} for iiaide-wos...`);
  try {
    install({ withDeps: Boolean(args?.withDeps) });
  } catch (installError) {
    const reason = installError?.message || String(installError);
    throw new CliMessageError(`${missingPlaywrightBrowserMessage(args, installCommand)} Install failed: ${reason}`, {
      code: "PLAYWRIGHT_BROWSER_INSTALL_FAILED",
    });
  }
  report("Playwright Chromium install completed. Reopening the WOS browser...");
  return true;
}

function installPlaywrightBrowserCommand(args, options = {}) {
  const install = options.install || installBundledPlaywrightBrowser;
  const report = options.report || console.error;
  report(`Installing Playwright Chromium ${PLAYWRIGHT_VERSION} for iiaide-wos...`);
  const result = install({ withDeps: Boolean(args.withDeps) });
  report("Playwright Chromium install completed.");
  return result;
}

async function hideWosWindow(page) {
  await page.evaluate((position) => {
    const [x, y] = position.split(",").map((item) => Number(item));
    window.moveTo(Number.isFinite(x) ? x : -32000, Number.isFinite(y) ? y : 0);
  }, HIDDEN_BROWSER_POSITION).catch(() => {});
}

async function launchWosPersistentContext(args, visible = false) {
  fs.mkdirSync(args.tasksRoot, { recursive: true });
  let context = null;
  try {
    context = await chromium.launchPersistentContext(wosUserDataDir(args), wosBrowserLaunchOptions(args, visible));
  } catch (error) {
    const repaired = await ensurePlaywrightBrowserInstalledForLaunch(args, error);
    if (!repaired) throw error;
    context = await chromium.launchPersistentContext(wosUserDataDir(args), wosBrowserLaunchOptions(args, visible));
  }
  context.setDefaultTimeout(args.timeoutMs);
  await injectWosJs(context, args);
  return context;
}

async function releaseWosPage(page) {
  if (!page || page.isClosed?.()) return;
  await page.evaluate(() => {
    try {
      window.stop?.();
    } catch (_) {}
    try {
      window.__IIAIDE_WOS_POPUP_GUARD_STOP__?.();
    } catch (_) {}
  }).catch(() => {});
  await page.goto("about:blank", {
    waitUntil: "domcontentloaded",
    timeout: 1000,
  }).catch(() => {});
  await page.close({ runBeforeUnload: false }).catch(() => {});
}

async function releaseWosContext(context) {
  if (!context) return;
  const pages = typeof context.pages === "function" ? [...context.pages()] : [];
  await Promise.allSettled(pages.map((page) => releaseWosPage(page)));
  await context.close().catch(() => {});
  await sleep(50);
}

async function closeSharedWosSession() {
  const session = sharedWosSession;
  sharedWosSession = null;
  await releaseWosContext(session?.context);
}

async function forceCloseWosSession(session = null) {
  if (sharedWosSession && (!session || session.context === sharedWosSession.context)) {
    await closeSharedWosSession();
    return;
  }
  const context = session?.context || null;
  if (context) {
    await releaseWosContext(context);
    return;
  }
  await session?.close?.().catch(() => {});
}

async function readSidFromLoginBrowser(args) {
  await closeSharedWosSession();
  const context = await launchWosPersistentContext(args, true);
  try {
    const page = context.pages()[0] || await context.newPage();
    const loginUrl = args.sid ? buildSidInitUrl(args.sid) : `${DEFAULT_BASE_URL}/wos/`;
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
    await dismissWosPopups(page);
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
    await releaseWosContext(context);
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
  applySavedRuntimeSettings(args);
  const index = readTaskIndex(args.tasksRoot);
  const tasks = Array.isArray(index.tasks) ? index.tasks : [];
  const currentTask = readLatestTaskId(args.tasksRoot) || "";
  const config = readConfig(args.tasksRoot);
  const sidConfig = readSidConfig(args);
  const pool = sidPoolFromConfig(sidConfig);
  const sid = args.sid || process.env.WOS_SID || pool.activeSid || "";
  const sidSource = args.sidSource || (process.env.WOS_SID ? "env" : (pool.activeSid ? "config" : ""));
  const baseUrl = args.baseUrlSource ? args.baseUrl : (config.baseUrl || args.baseUrl || DEFAULT_BASE_URL);
  const wosDomain = args.baseUrlSource
    ? (args.wosDomain || urlDomain(args.baseUrl) || DEFAULT_WOS_DOMAIN)
    : (config.wosDomain || urlDomain(baseUrl) || args.wosDomain || DEFAULT_WOS_DOMAIN);
  const maskedSid = maskSid(sid);
  const safeSidCheck = sidCheck
    ? {
      ...sidCheck,
      sid: maskSid(sidCheck.sid),
      sidMasked: sidCheck.sidMasked || maskSid(sidCheck.sid),
      href: redactSidInUrl(sidCheck.href || ""),
    }
    : null;
  return {
    initialized: fs.existsSync(args.tasksRoot) && fs.existsSync(taskIndexPath(args.tasksRoot)),
    cwd: process.cwd(),
    tasksRoot: args.tasksRoot,
    baseUrl,
    wosDomain,
    wosOrigin: sidCheck?.origin || "",
    playwrightVisible: Boolean(args.headed),
    parseConcurrency: args.concurrency,
    wosBrowserMode: wosBrowserMode(args),
    wosProfileName: wosProfileName(args),
    wosProfilePath: wosUserDataDir(args),
    runtimeMs: Date.now() - CLI_STARTED_AT,
    taskCount: tasks.length,
    currentTask,
    latestTask: currentTask,
    hasSavedSid: Boolean(sid),
    sid: maskedSid,
    sidMasked: maskedSid,
    sidSource,
    sidPoolCount: pool.sids.length,
    sidPoolIndex: pool.activeIndex,
    sidConfig: globalConfigPath(),
    authMonitor: readAuthMonitorStatus(),
    deadSidCount: Array.isArray(sidConfig.deadSids) ? sidConfig.deadSids.length : 0,
    sidCheck: safeSidCheck,
    wosDataDb: wosDataDbStats(args.dbPath, args.blacklistDbPath),
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
  if (isUnverifiedPartialTxtSummary(summary, args)) return null;
  const identifier = summary.uuid || args.uuid || args.taskId;
  const sourcePaths = withRawSource(paths, identifier);
  const csvPath = resolveWosIdsCsvPath(sourcePaths, identifier);
  if (!fs.existsSync(csvPath)) return null;
  const rangeStart = Math.max(1, Number(summary.rangeStart) || Number(summary.fromIndex) || 1);
  const rangeEnd = Math.max(0, Number(summary.rangeEnd) || 0) ||
    (summary.expectedCount ? rangeStart + Math.max(0, Number(summary.expectedCount) || 0) - 1 : 0);
  if (!rangeEnd) return null;
  const plan = rawBatchPlanForRange(paths, identifier, rangeStart, rangeEnd, DEFAULT_BATCH_SIZE);
  if (plan.missingBatches.length) return null;
  return { ...summary, files: { ...(summary.files || {}), wosidsCsv: csvPath } };
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
      line.match(/^\s*UT\s*[:=]\s*(.+?)\s*$/i);
    if (!match) continue;
    const raw = String(match[1] || "").trim();
    const wosid = normalizeWosId(raw);
    if (!wosid || seen.has(wosid)) continue;
    seen.add(wosid);
    ids.push({ batchStart, batchEnd, batchPosition: ids.length + 1, wosid });
  }
  return ids;
}

function appendRows(target, source) {
  for (const row of source) target.push(row);
  return target;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function isFailedTxtRunSummary(summary = {}) {
  return Boolean(summary?.ok === false && summary.method === "wos-js-export-fetchTxtBatches");
}

function isUnverifiedPartialTxtSummary(summary = {}, args = {}) {
  if (!summary || summary.method !== "wos-js-export-fetchTxtBatches") return false;
  if (Number(summary.limit || 0)) return false;
  if (String(summary.rowText || "").trim()) return false;
  if (!(args.url || args.uuid)) return false;
  const rangeStart = Math.max(1, Number(summary.rangeStart) || Number(summary.fromIndex) || 1);
  const rangeEnd = Math.max(0, Number(summary.rangeEnd) || 0);
  const expectedCount = Math.max(0, Number(summary.expectedCount) || 0);
  const availableCount = Math.max(0, Number(summary.availableCount) || 0);
  return Boolean(rangeEnd && expectedCount && availableCount && rangeStart === 1 && rangeEnd === expectedCount && availableCount === expectedCount);
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

function selectedRecordRange(totalRecords, startIndex = 1, limit = 0) {
  const availableCount = Math.max(0, Number(totalRecords) || 0);
  const start = Math.max(1, Number(startIndex) || 1);
  if (!availableCount || start > availableCount) {
    return {
      availableCount,
      startIndex: start,
      endIndex: 0,
      selectedCount: 0,
      bounded: Boolean(Number(limit) || 0),
    };
  }
  const bounded = Boolean(Number(limit) || 0);
  const endIndex = bounded
    ? Math.min(start + Math.max(0, Number(limit) || 0) - 1, availableCount)
    : availableCount;
  return {
    availableCount,
    startIndex: start,
    endIndex,
    selectedCount: Math.max(0, endIndex - start + 1),
    bounded,
  };
}

function reportDownloadPlan(label, availableCount, selectedCount, batchSize = DEFAULT_BATCH_SIZE) {
  const batches = downloadBatchCount(selectedCount, batchSize);
  console.error(`${label} available: ${availableCount}`);
  console.error(`${label} to download: ${selectedCount}`);
  console.error(`${label} batches: ${batches} x ${batchSize} records`);
  return { batches };
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
  const blacklistIds = existingWosDataBlacklistedIds({ blacklistDbPath: args.blacklistDbPath }, wosids);
  return { globalIds, blacklistIds };
}

function hasExistingWosData(state, wosid) {
  const normalized = normalizeWosId(wosid);
  return Boolean(normalized && state.globalIds.has(normalized));
}

function hasBlacklistedWosData(state, wosid) {
  const normalized = normalizeWosId(wosid);
  return Boolean(normalized && state.blacklistIds.has(normalized));
}

function selectParseWork(paths, wosids, args) {
  let indexed = wosids.map((wosid, index) => ({ wosid, index: index + 1 }));
  indexed = indexed.filter((item) => item.index >= args.fromIndex);
  const state = existingWosDataState(paths, wosids, args);
  if (!args.reparseExisting) {
    indexed = indexed.filter((item) => !hasExistingWosData(state, item.wosid));
  }
  if (!args.retryBlacklist) {
    indexed = indexed.filter((item) => !hasBlacklistedWosData(state, item.wosid));
  }
  if (args.limit) indexed = indexed.slice(0, args.limit);
  return indexed;
}

function parseStats(paths, wosids, args = {}) {
  const state = existingWosDataState(paths, wosids, args);
  const completed = wosids.filter((wosid) => hasExistingWosData(state, wosid)).length;
  const blacklisted = wosids.filter((wosid) => !hasExistingWosData(state, wosid) && hasBlacklistedWosData(state, wosid)).length;
  const skippedExisting = args.reparseExisting ? 0 : completed;
  const skippedBlacklist = args.retryBlacklist ? 0 : blacklisted;
  return {
    completed,
    skippedExisting,
    blacklisted,
    skippedBlacklist,
    missing: Math.max(0, wosids.length - completed - skippedBlacklist),
  };
}

function parseWorkSummary(paths, wosids, work, args) {
  const stats = parseStats(paths, wosids, args);
  const dbStats = wosDataDbStats(args.dbPath, args.blacklistDbPath);
  const firstIndex = work[0]?.index || 0;
  const lastIndex = work[work.length - 1]?.index || 0;
  return {
    dbPath: args.dbPath,
    blacklistDbPath: args.blacklistDbPath,
    dbRecordCount: dbStats.recordCount || 0,
    dbBlacklistCount: dbStats.blacklistCount || 0,
    total: wosids.length,
    completed: stats.completed,
    skipped: stats.skippedExisting + stats.skippedBlacklist,
    skippedExisting: stats.skippedExisting,
    skippedBlacklist: stats.skippedBlacklist,
    blacklisted: stats.blacklisted,
    missing: stats.missing,
    selected: work.length,
    firstIndex,
    lastIndex,
    concurrency: args.concurrency,
    browserRestartEvery: args.browserRestartEvery,
    memoryCheckEvery: args.memoryCheckEvery,
    maxRssMb: args.maxRssMb,
  };
}

function printParseWorkSummary(summary, write = console.error) {
  const range = summary.selected ? `${summary.firstIndex}-${summary.lastIndex}` : "none";
  const label = (value) => color("1;36", value.padEnd(20), process.stderr);
  write([
    "WOS data records:",
    `  ${label("total")}${summary.total}`,
    `  ${label("skipped")}${summary.skipped}`,
    `  ${label("blacklisted")}${summary.blacklisted}`,
    `  ${label("missing")}${summary.missing}`,
    `  ${label("selected")}${summary.selected}`,
    `  ${label("range")}${range}`,
    `  ${label("dbRecords")}${summary.dbRecordCount}`,
    `  ${label("dbBlacklist")}${summary.dbBlacklistCount}`,
    `  ${label("db")}${summary.dbPath}`,
    `  ${label("blacklistDb")}${summary.blacklistDbPath}`,
    `  ${label("concurrency")}${summary.concurrency}`,
    `  ${label("browserRestartEvery")}${summary.browserRestartEvery || "off"}`,
    `  ${label("memoryCheckEvery")}${summary.memoryCheckEvery || "off"}`,
    `  ${label("maxRssMb")}${summary.maxRssMb || "off"}`,
  ].join("\n"));
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
  if (args.clearBlacklist) {
    return clearWosDataBlacklist({
      dbPath: args.dbPath,
      blacklistDbPath: args.blacklistDbPath,
    });
  }
  if (args.unblacklistWosId) {
    return removeWosDataBlacklist({
      dbPath: args.dbPath,
      blacklistDbPath: args.blacklistDbPath,
      wosid: args.unblacklistWosId,
    });
  }
  if (args.blacklistQuery) {
    return queryWosDataBlacklist({
      dbPath: args.dbPath,
      blacklistDbPath: args.blacklistDbPath,
      limit: args.limit || 50,
    });
  }
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
  throw new Error("Missing wosdata operation: use --merge-db, --wosid, --query, --blacklist, --unblacklist, or --clear-blacklist");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSavedSidPool(args, options = {}) {
  const intervalMs = Math.max(1, Number(options.intervalMs) || SID_POOL_WAIT_INTERVAL_MS);
  const report = options.report || console.error;
  const onPoll = typeof options.onPoll === "function" ? options.onPoll : null;
  let attempts = 0;
  let waitedMs = 0;
  args.sid = "";
  args.sidSource = "";

  for (;;) {
    const sid = loadSavedSidFromConfig(args);
    if (sid) {
      return {
        sid,
        sidSource: args.sidSource,
        sidPoolCount: args.sidPoolCount,
        sidPoolIndex: args.sidPoolIndex,
        attempts,
        waitedMs,
      };
    }
    attempts += 1;
    if (onPoll) {
      await onPoll({
        attempts,
        waitedMs,
        intervalMs,
        sidPoolCount: args.sidPoolCount,
        sidPoolIndex: args.sidPoolIndex,
      });
    }
    report(`Saved SID pool is empty. Waiting ${Math.ceil(intervalMs / 1000)}s before checking again.`);
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }
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

function chunkItemsByCount(items, count) {
  const size = Math.max(0, Number(count) || 0);
  if (!size || items.length <= size) return [items];
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function currentProcessRssMb() {
  const rss = Number(process.memoryUsage?.().rss || 0);
  return rss > 0 ? Math.round(rss / (1024 * 1024)) : 0;
}

function effectiveParseChunkSize(args) {
  const restartSize = Math.max(0, Number(args?.browserRestartEvery) || 0);
  const memoryCheckSize = Math.max(0, Number(args?.memoryCheckEvery) || 0);
  const size = [restartSize, memoryCheckSize].filter((value) => value > 0).reduce((min, value) => Math.min(min, value), Infinity);
  return Number.isFinite(size) ? size : 0;
}

function shouldRestartParseForMemory(args, rssMb = currentProcessRssMb()) {
  const maxRssMb = Math.max(0, Number(args?.maxRssMb) || 0);
  return Boolean(maxRssMb && rssMb >= maxRssMb);
}

function batchFileName(uuid, markFrom, markTo, extension = "txt") {
  return `${safeFilePart(uuid)}_${markFrom}_${markTo}.${extension}`;
}

function batchKey(markFrom, markTo) {
  return `${markFrom}-${markTo}`;
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

function parseRawBatchFileName(fileName) {
  const match = String(fileName || "").match(/_(\d+)_(\d+)\.txt$/);
  if (!match) return null;
  return {
    fileName,
    batchStart: Number(match[1]),
    batchEnd: Number(match[2]),
  };
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

function firstRawBatchRange(paths, uuid) {
  if (!uuid) return null;
  const firstFile = rawBatchFiles(paths, uuid)[0];
  if (!firstFile) return null;
  return parseRawBatchFileName(firstFile);
}

function shouldInferTxtRangeStartFromRaw(args = {}) {
  return Boolean(!args.fromIndexSource && !args.limit);
}

function inferTxtRangeStart(paths, uuid, args = {}, fallbackStart = 1) {
  const fallback = Math.max(1, Number(fallbackStart) || Number(args.fromIndex) || 1);
  if (!shouldInferTxtRangeStartFromRaw(args)) return fallback;
  const firstRange = firstRawBatchRange(paths, uuid);
  return firstRange?.batchStart || fallback;
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
    const { batchStart, batchEnd } = parseRawBatchFileName(fileName);
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

function rawBatchCoverageFromStart(paths, uuid, startIndex = 1, endIndex = 0) {
  const start = Math.max(1, Number(startIndex) || 1);
  const end = Math.max(0, Number(endIndex) || 0);
  if (end && start > end) return { files: [], firstStart: 0, lastEnd: start - 1, parsedUntil: start - 1 };

  const ranges = rawBatchFiles(paths, uuid)
    .map(parseRawBatchFileName)
    .filter(Boolean)
    .filter((range) => range.batchEnd >= start && (!end || range.batchStart <= end));

  if (!ranges.length) return { files: [], firstStart: 0, lastEnd: start - 1, parsedUntil: start - 1 };

  let previousEnd = start - 1;
  let firstStart = 0;
  const files = [];
  for (const range of ranges) {
    if (!files.length) {
      if (range.batchStart > start) {
        throw new Error(`Non-contiguous raw batches detected: ${range.fileName}`);
      }
      if (range.batchEnd < start) continue;
    } else if (range.batchStart !== previousEnd + 1) {
      throw new Error(`Non-contiguous raw batches detected: ${range.fileName}`);
    }

    if (range.batchEnd < range.batchStart) {
      throw new Error(`Invalid raw batch range detected: ${range.fileName}`);
    }
    if (!firstStart) firstStart = range.batchStart;
    files.push(range.fileName);
    previousEnd = end ? Math.min(range.batchEnd, end) : range.batchEnd;
    if (end && previousEnd >= end) break;
  }

  return { files, firstStart, lastEnd: previousEnd, parsedUntil: previousEnd };
}

function splitBatchRanges(startIndex, endIndex, batchSize = DEFAULT_BATCH_SIZE) {
  const start = Math.max(1, Number(startIndex) || 1);
  const end = Math.max(0, Number(endIndex) || 0);
  const size = Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE);
  if (!end || start > end) return [];
  const batches = [];
  for (let markFrom = start; markFrom <= end; markFrom += size) {
    batches.push({ markFrom, markTo: Math.min(markFrom + size - 1, end) });
  }
  return batches;
}

function rawBatchPlanForRange(paths, uuid, startIndex = 1, endIndex = 0, batchSize = DEFAULT_BATCH_SIZE) {
  const start = Math.max(1, Number(startIndex) || 1);
  const end = Math.max(0, Number(endIndex) || 0);
  const selectedCount = end && end >= start ? end - start + 1 : 0;
  const plannedBatchCount = downloadBatchCount(selectedCount, batchSize);
  const empty = {
    startIndex: start,
    endIndex: end,
    selectedCount,
    plannedBatchCount,
    presentFiles: [],
    presentRanges: [],
    missingBatches: selectedCount ? splitBatchRanges(start, end, batchSize) : [],
    coveredCount: 0,
    missingCount: selectedCount,
    complete: !selectedCount,
  };
  if (!uuid || !selectedCount) return empty;

  const ranges = rawBatchFiles(paths, uuid)
    .map(parseRawBatchFileName)
    .filter(Boolean)
    .filter((range) => range.batchEnd >= start && range.batchStart <= end)
    .sort((a, b) => a.batchStart - b.batchStart || a.batchEnd - b.batchEnd);

  let cursor = start;
  let coveredCount = 0;
  const presentFiles = [];
  const presentRanges = [];
  const missingBatches = [];
  const addMissing = (from, to) => {
    appendRows(missingBatches, splitBatchRanges(from, to, batchSize));
  };

  for (const range of ranges) {
    if (range.batchEnd < range.batchStart) {
      throw new Error(`Invalid raw batch range detected: ${range.fileName}`);
    }
    const clippedStart = Math.max(range.batchStart, start);
    const clippedEnd = Math.min(range.batchEnd, end);
    if (clippedStart < cursor) {
      throw new Error(`Overlapping raw batches detected: ${range.fileName}`);
    }
    if (clippedStart > cursor) {
      addMissing(cursor, clippedStart - 1);
    }
    presentFiles.push(range.fileName);
    presentRanges.push({ ...range, clippedStart, clippedEnd });
    coveredCount += clippedEnd - clippedStart + 1;
    cursor = clippedEnd + 1;
  }

  if (cursor <= end) addMissing(cursor, end);

  return {
    startIndex: start,
    endIndex: end,
    selectedCount,
    plannedBatchCount,
    presentFiles,
    presentRanges,
    missingBatches,
    coveredCount,
    missingCount: missingBatches.reduce((total, batch) => total + batch.markTo - batch.markFrom + 1, 0),
    complete: missingBatches.length === 0,
  };
}

function parseExistingRawBatches(paths, uuid, options = {}) {
  const rows = [];
  const files = options.files || rawBatchCoverage(paths, uuid).files;
  const startIndex = Math.max(1, Number(options.startIndex) || 1);
  const endIndex = Math.max(0, Number(options.endIndex) || 0);
  for (const fileName of files) {
    const { batchStart, batchEnd } = parseRawBatchFileName(fileName);
    const text = fs.readFileSync(path.join(rawBatchDir(paths, uuid), fileName), "utf8");
    appendRows(rows, parseExportText(text, batchStart, batchEnd).filter((row) => {
      const recordIndex = batchStart + row.batchPosition - 1;
      if (recordIndex < startIndex) return false;
      if (endIndex && recordIndex > endIndex) return false;
      return true;
    }));
  }
  return rows;
}

function canRepairWosIdsFromRaw(paths, uuid, expectedCount, startIndex = 1, endIndex = 0) {
  if (!uuid || !rawBatchFiles(paths, uuid).length || !expectedCount) return false;
  const start = Math.max(1, Number(startIndex) || 1);
  const end = Math.max(0, Number(endIndex) || 0) || start + Math.max(0, Number(expectedCount) || 0) - 1;
  const plan = rawBatchPlanForRange(paths, uuid, start, end, DEFAULT_BATCH_SIZE);
  return Boolean(plan.presentFiles.length && plan.complete);
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
  await dismissWosPopups(page);
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(
    () => window.sessionData?.BasicProperties?.SID || "",
    null,
    { timeout: Math.min(Math.max(args.timeoutMs || 0, 15000), 60000) }
  ).catch(() => {});
  await ensureWosJsOnPage(page, args);
  const status = await page.evaluate(() => ({
    href: location.href,
    origin: location.origin,
    sid: window.sessionData?.BasicProperties?.SID || "",
  }));
  if (!status.sid || status.sid !== args.sid) {
    const observedSid = maskSid(status.sid);
    const safeHref = redactSidInUrl(status.href);
    if (args.sidSource === "config") {
      throw new Error(
        `Saved SID is invalid or expired. Pass a fresh SID with --sid, or run: iiaide-wos sid --sid "<SID>". observedSid=${observedSid || "(missing)"} href=${safeHref}`
      );
    }
    throw new Error(`SID validation failed. observedSid=${observedSid || "(missing)"} href=${safeHref}`);
  }
  if (status.origin) args.baseUrl = stripTrailingSlash(status.origin);
  saveSidConfig(args, status.sid);
  return status;
}

async function detectSidFromPage(page, args) {
  const invalidatedSids = Array.isArray(args.invalidatedSids) ? args.invalidatedSids : [];
  const sid = await page.waitForFunction(
    (rejectedSids) => {
      const value = window.sessionData?.BasicProperties?.SID || "";
      return value && !rejectedSids.includes(value) ? value : "";
    },
    invalidatedSids,
    { timeout: Math.max(args.timeoutMs, 600000) }
  ).then((handle) => handle.jsonValue());
  return String(sid || "").trim();
}

async function clearWosBrowserAuthState(context, page, args) {
  await context.clearCookies().catch(() => {});
  const origin = stripTrailingSlash(args.baseUrl || DEFAULT_BASE_URL);
  await page.goto(`${origin}/wos/`, { waitUntil: "domcontentloaded", timeout: args.timeoutMs }).catch(() => {});
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  }).catch(() => {});
}

async function loginForFreshSid(args, report = console.error) {
  await closeSharedWosSession();
  const visibleContext = await launchWosPersistentContext(args, true);
  try {
    const page = visibleContext.pages()[0] || await visibleContext.newPage();
    page.setDefaultTimeout(args.timeoutMs);
    if (Array.isArray(args.invalidatedSids) && args.invalidatedSids.length) {
      await clearWosBrowserAuthState(visibleContext, page, args);
    }
    const loginUrl = args.sid ? buildSidInitUrl(args.sid) : `${DEFAULT_BASE_URL}/wos/`;
    report("WOS SID is missing or invalid. A visible WOS browser window is open; log in there and iiaide-wos will continue automatically.");
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
    await dismissWosPopups(page);
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

async function chooseFreshSidInteractively(args, report = console.error, options = {}) {
  const chooseSid = options.chooseSid || (async () => {
    let rl = null;
    const getRl = () => {
      if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return rl;
    };

    try {
      return await askSidFromBrowserOrManual(
        getRl,
        async () => {
          args.sid = "";
          args.sidSource = "";
          return (options.readBrowserSid || readSidFromBrowser)(args);
        },
        () => (options.promptManualSid || promptSid)("Enter WOS SID manually"),
        async () => {
          const result = await waitForSavedSidPool(args, { report });
          return result.sid;
        }
      );
    } finally {
      rl?.close();
    }
  });

  if (!(options.canPrompt || canPromptForSid)()) {
    return (options.readBrowserSid || ((nextArgs) => loginForFreshSid(nextArgs, report)))(args);
  }

  const sid = await chooseSid(args);
  if (isQuitResult(sid)) throw new UserQuitError("SID setup quit by user");
  if (isBackResult(sid)) throw new UserCancelledError("SID setup cancelled by user");
  const value = String(sid || "").trim();
  if (!value) throw new Error("SID must not be empty");
  if (!args.sid) {
    args.sid = value;
    args.sidSource = "prompt";
  }
  return value;
}

async function acquireFreshSid(args, report = console.error, options = {}) {
  if ((options.canPrompt || canPromptForSid)()) {
    return chooseFreshSidInteractively(args, report, options);
  }
  return (options.readBrowserSid || ((nextArgs) => loginForFreshSid(nextArgs, report)))(args);
}

async function prepareWosSession(args, options = {}) {
  loadSavedSid(args);
  const keepAlive = Boolean(options.keepAlive || args.keepWosSession);
  const report = options.report || console.error;
  const visible = Boolean(options.visible || args.headed);
  const recoverSid = options.recoverSid !== false;
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

  for (;;) {
    let context = await launchWosPersistentContext(args, visible);
    let page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(args.timeoutMs);
    let status = null;
    if (!args.sid) {
      await releaseWosContext(context);
      if (!recoverSid) throw new Error("No saved SID is available for WOS session preparation.");
      report("No saved SID found. Choose manual SID input, wait for SID pool, or browser login to continue.");
      await acquireFreshSid(args, report);
      context = await launchWosPersistentContext(args, visible);
      page = context.pages()[0] || await context.newPage();
      page.setDefaultTimeout(args.timeoutMs);
    }
    try {
      status = await validateSid(page, args);
    } catch (error) {
      await releaseWosContext(context);
      if (args.sidSource === "config") {
        const discarded = discardActiveConfigSid(args, error.message || "SID validation failed");
        if (discarded?.sidPoolCount) {
          report(`Saved SID was invalid and removed from the pool; trying next saved SID (${discarded.sidPoolCount} left).`);
          loadSavedSid(args);
          continue;
        }
        if (discarded) {
          report("All saved SIDs were invalid. Choose manual SID input, wait for SID pool, or browser login to refresh authentication.");
        }
      }
      if (args.sidSource === "browser") {
        throw new Error(`Browser-detected WOS SID could not be validated after reopening the WOS profile. ${error.message || error}`);
      }
      if (!recoverSid) throw error;
      report(`WOS SID validation failed. Choose manual SID input, wait for SID pool, or browser login to continue. ${error.message || error}`);
      await acquireFreshSid(args, report);
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
    return { context, page, status, close: async () => releaseWosContext(context) };
  }
}

async function waitForUsableWosSession(args, options = {}) {
  const report = options.report || console.error;
  const intervalMs = Math.max(1, Number(options.intervalMs) || SID_POOL_WAIT_INTERVAL_MS);
  const onPoll = typeof options.onPoll === "function" ? options.onPoll : null;
  const onSidLoaded = typeof options.onSidLoaded === "function" ? options.onSidLoaded : null;
  const onValidationFailure = typeof options.onValidationFailure === "function" ? options.onValidationFailure : null;
  const openSession = options.openSession || (() => prepareWosSession(args, {
    report,
    visible: options.visible,
    keepAlive: options.keepAlive,
    recoverSid: false,
  }));
  const validate = options.validate || (async (nextSession) => nextSession);
  const isFatal = typeof options.isFatal === "function" ? options.isFatal : () => false;

  if (options.ignoreEnvSid !== false) delete process.env.WOS_SID;

  for (;;) {
    if (!args.sid && !loadSavedSidFromConfig(args)) {
      const resumedSid = await waitForSavedSidPool(args, {
        intervalMs,
        report,
        onPoll,
      });
      if (onSidLoaded) await onSidLoaded(resumedSid);
    }

    let nextSession = null;
    try {
      nextSession = await openSession();
      const value = await validate(nextSession);
      return { session: nextSession, value };
    } catch (error) {
      await forceCloseWosSession(nextSession);
      if (isFatal(error)) throw error;
      const message = error?.message || String(error);
      if (onValidationFailure) {
        await onValidationFailure({
          error,
          message,
          sidSource: args.sidSource,
          sidPoolCount: args.sidPoolCount,
          sidPoolIndex: args.sidPoolIndex,
        });
      }
      const discarded = discardActiveConfigSid(args, message || "WOS session could not be prepared", { force: true });
      if (discarded?.sidPoolCount) {
        report(`Saved SID could not reopen WOS and was removed; trying next saved SID (${discarded.sidPoolCount} left).`);
        loadSavedSidFromConfig(args);
        continue;
      }
      args.sid = "";
      args.sidSource = "";
    }
  }
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
    if (args.sidSource === "config") {
      const discarded = discardActiveConfigSid(args, error.message || "SID validation failed");
      if (discarded?.sidPoolCount) {
        report(`Saved SID was invalid and removed from the pool; trying next saved SID (${discarded.sidPoolCount} left).`);
        loadSavedSid(args);
        return validateSid(page, args);
      }
    }
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

async function warmUpWosQueryPage(page, args, rowText = DEFAULT_PARSE_CONNECTIVITY_QUERY) {
  await ensureWosJsOnPage(page, args);
  const probe = await page.evaluate(async (queryText) => {
    if (!window.wos?.query?.openQueryPage) {
      throw new Error("wos.js query API missing: window.wos.query.openQueryPage");
    }
    await window.wos.query.openQueryPage(queryText);
    return {
      rowText: queryText,
      href: window.location.href,
      status: window.location.pathname.includes("/wos/woscc/general-summary") ? "routed" : "unknown",
      sid: window.sessionData?.BasicProperties?.SID || "",
    };
  }, rowText);
  const searchInfoReady = await page.waitForSelector('div[data-ta="search-info"]', {
    state: "attached",
    timeout: Math.min(args.recordTimeoutMs || args.timeoutMs, 5000),
  }).then(() => true).catch(() => false);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  let info = null;
  if (searchInfoReady) {
    try {
      info = await readSummaryInfo(page, { ...args, timeoutMs: Math.min(args.timeoutMs, 5000) });
    } catch (_) {
      info = null;
    }
  }
  return {
    rowText,
    href: info?.href || probe.href,
    countText: info?.countText || "",
    expectedCount: info?.expectedCount || 0,
    status: info?.status || probe.status,
    searchInfoReady,
  };
}

function randomUppercaseLetters(length = 4) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

async function runWosRecoveryBuildQuery(page, args, expr = `AB=${randomUppercaseLetters(4)}`) {
  await ensureWosJsOnPage(page, args);
  const result = await page.evaluate(async (queryText) => {
    if (!window.wos?.query?.buildQuery) {
      throw new Error("wos.js query API missing: window.wos.query.buildQuery");
    }
    return window.wos.query.buildQuery(queryText);
  }, expr);
  return {
    expr,
    uuid: result?.uuid || "",
    ref_count: Number(result?.ref_count || 0) || 0,
    rowText: result?.rowText || expr,
    status: result?.status || "",
    error_code: result?.error_code || "",
  };
}

async function prepareWosRequestContext(page, args) {
  await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
  await dismissWosPopups(page);
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
  let page = null;
  const rows = [];
  let info = null;
  let batchProgress = null;
  let summarySpinner = null;
  try {
    session = await prepareWosSession(args);
    page = session.page;
    authSpinner.succeed(authValidatedMessage(args));
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
    const firstRawRange = firstRawBatchRange(paths, info.uuid);
    if (args.reuseRaw && !firstRawRange && shouldInferTxtRangeStartFromRaw(args)) {
      console.error(`WOS raw resume: no TXT batches found in ${rawBatchDir(paths, info.uuid)}`);
    }
    const rangeStart = inferTxtRangeStart(paths, info.uuid, args, args.fromIndex);
    const range = selectedRecordRange(info.expectedCount, rangeStart, args.limit);
    if (!range.selectedCount) {
      throw new Error(`WOS record range starts after available records: start=${range.startIndex} total=${range.availableCount}`);
    }
    if (range.startIndex !== args.fromIndex) {
      console.error(`WOS record start inferred from raw batches: ${range.startIndex}`);
    }
    const resumePlan = rawBatchPlanForRange(paths, info.uuid, range.startIndex, range.endIndex, batchSize);
    const resumedCount = resumePlan.coveredCount;
    if (resumePlan.presentFiles.length) {
      appendRows(rows, parseExistingRawBatches(paths, info.uuid, {
        files: resumePlan.presentFiles,
        startIndex: range.startIndex,
        endIndex: range.endIndex,
      }));
      appendProgress(paths, {
        phase: "resume-raw",
        uuid: info.uuid,
        startIndex: range.startIndex,
        endIndex: range.endIndex,
        files: resumePlan.presentFiles.length,
        plannedBatches: resumePlan.plannedBatchCount,
        missingBatchCount: resumePlan.missingBatches.length,
        coveredCount: resumePlan.coveredCount,
        parsed: rows.length,
      });
      console.error(`WOS raw resume: ${resumePlan.presentFiles.length}/${resumePlan.plannedBatchCount} TXT batches present; ${resumePlan.missingBatches.length} missing`);
    }
    const remainingCount = resumePlan.missingCount;
    const persistedBatchKeys = new Set();
    const persistTxtBatch = (batch, sourcePhase = "batch") => {
      const markFrom = Number(batch.markFrom) || 0;
      const markTo = Number(batch.markTo) || 0;
      if (!markFrom || !markTo) return { parsed: 0, saved: false };
      const key = batchKey(markFrom, markTo);
      if (persistedBatchKeys.has(key)) return { parsed: 0, saved: false };
      const rawPath = rawBatchPath(paths, info.uuid, markFrom, markTo);
      writeFileAtomic(rawPath, String(batch.text || ""));
      const ids = parseExportText(batch.text, markFrom, markTo);
      appendRows(rows, ids);
      persistedBatchKeys.add(key);
      appendProgress(paths, { phase: sourcePhase, markFrom, markTo, parsed: ids.length, rawPath });
      if (!isInteractive()) console.error(`export ${markFrom}-${markTo}: parsed ${ids.length} WOS IDs`);
      return { parsed: ids.length, saved: true };
    };
    let sidSwitchCount = 0;
    const switchSidAfterTxtExportFailure = async (missingBatch, error) => {
      const failedSidMasked = maskSid(args.sid);
      sidSwitchCount += 1;
      appendProgress(paths, {
        phase: "txt-export-sid-switch",
        uuid: info.uuid,
        markFrom: missingBatch.markFrom,
        markTo: missingBatch.markTo,
        switchCount: sidSwitchCount,
        failedSid: failedSidMasked,
        message: error?.message || String(error),
      });
      writeRuntimeNotice("WOS TXT export request failed", [
        `records ${missingBatch.markFrom}-${missingBatch.markTo}`,
        "Treating the current SID as expired and switching to the next saved SID.",
        failedSidMasked ? `Failed SID: ${failedSidMasked}` : "",
      ]);
      await forceCloseWosSession(session);
      session = null;
      page = null;
      const discarded = discardActiveConfigSid(args, `WOS TXT export failed for records ${missingBatch.markFrom}-${missingBatch.markTo}`, { force: true });
      if (discarded?.sidPoolCount) {
        console.error(`Saved SID was removed after TXT export failure; trying next saved SID (${discarded.sidPoolCount} left).`);
      } else {
        args.sid = "";
        args.sidSource = "";
        writeRuntimeNotice("WOS SID pool empty", [
          "No saved SID remains after removing the failed SID.",
          `Waiting for a new saved SID and checking again every ${Math.ceil(SID_POOL_WAIT_INTERVAL_MS / 1000)} seconds.`,
        ]);
      }
      const switchSpinner = createSpinner("Validating WOS authentication after SID switch");
      let refreshedContext = null;
      let refreshedUuid = "";
      try {
        const usable = await waitForUsableWosSession(args, {
          intervalMs: SID_POOL_WAIT_INTERVAL_MS,
          report: console.error,
          onPoll: ({ attempts, waitedMs, intervalMs, sidPoolCount }) => {
            appendProgress(paths, {
              phase: "txt-export-sid-pool-wait",
              attempts,
              waitedMs,
              intervalMs,
              sidPoolCount,
            });
          },
          onSidLoaded: (resumedSid) => {
            writeRuntimeNotice("WOS SID pool refilled", [
              `Detected a new saved SID after ${formatRuntime(resumedSid.waitedMs)}.`,
              "Reopening WOS and resuming TXT export.",
              sidBadge(args) ? `Current ${sidBadge(args)}` : "",
            ]);
          },
          onValidationFailure: ({ message }) => {
            appendProgress(paths, {
              phase: "txt-export-sid-switch-validation-failed",
              message,
              sidSource: args.sidSource,
            });
            writeRuntimeNotice("WOS SID switch failed", [
              "A saved SID was detected, but WOS could not resume TXT export with it.",
              "Removing that SID and waiting for another saved SID.",
              message,
            ]);
          },
          validate: async (nextSession) => {
            const nextContext = await prepareWosRequestContext(nextSession.page, args);
            const nextUuid = pageContextUuid(nextContext, info.uuid);
            if (nextUuid !== info.uuid) {
              throw new Error(`WOS UUID changed after SID switch: expected ${info.uuid}, got ${nextUuid || "(missing)"}`);
            }
            if (nextContext.expectedCount && nextContext.expectedCount !== info.expectedCount) {
              throw new Error(`WOS record count changed after SID switch: expected ${info.expectedCount}, got ${nextContext.expectedCount}`);
            }
            refreshedContext = nextContext;
            refreshedUuid = nextUuid;
            return nextContext;
          },
          isFatal: (nextError) => /^WOS (UUID|record count) changed after SID switch/.test(nextError?.message || String(nextError)),
        });
        session = usable.session;
        page = session.page;
        switchSpinner.succeed(authValidatedMessage(args));
      } catch (switchError) {
        switchSpinner.fail("WOS authentication failed after SID switch");
        throw switchError;
      }
      appendProgress(paths, { phase: "txt-export-sid-switch-validated", sidSource: args.sidSource, sidPoolCount: args.sidPoolCount, sidPoolIndex: args.sidPoolIndex });
      appendProgress(paths, {
        phase: "txt-export-sid-switch-context",
        href: refreshedContext.href,
        uuid: refreshedUuid,
        countText: refreshedContext.countText,
        expectedCount: refreshedContext.expectedCount,
      });
    };
    reportDownloadPlan(
      "WOS records",
      info.expectedCount,
      remainingCount,
      batchSize
    );
    const batchCount = resumePlan.missingBatches.length;
    appendProgress(paths, {
      phase: "download-plan",
      label: "WOS records",
      availableCount: info.expectedCount,
      selectedCount: range.selectedCount,
      startIndex: range.startIndex,
      endIndex: range.endIndex,
      resumedCount,
      remainingCount,
      batchCount,
      plannedBatches: resumePlan.plannedBatchCount,
      presentBatches: resumePlan.presentFiles.length,
      missingBatchCount: resumePlan.missingBatches.length,
      firstMissingBatch: resumePlan.missingBatches[0] || null,
      batchSize,
    });
    if (remainingCount) {
      batchProgress = createProgress("Exporting records", batchCount);
      let completedMissingBatches = 0;
      const updateMissingProgress = (result, markFrom, markTo) => {
        if (!result.saved) return;
        completedMissingBatches += 1;
        batchProgress.update(completedMissingBatches, `${markFrom}-${markTo}`);
      };
      const consumeExistingMissingBatch = (missingBatch, sourcePhase = "resume-raw-before-request") => {
        const targetRawPath = rawBatchPath(paths, info.uuid, missingBatch.markFrom, missingBatch.markTo);
        if (!fs.existsSync(targetRawPath)) return false;
        const key = batchKey(missingBatch.markFrom, missingBatch.markTo);
        if (persistedBatchKeys.has(key)) return true;
        const fileName = batchFileName(info.uuid, missingBatch.markFrom, missingBatch.markTo);
        const parsedRows = parseExistingRawBatches(paths, info.uuid, {
          files: [fileName],
          startIndex: missingBatch.markFrom,
          endIndex: missingBatch.markTo,
        });
        appendRows(rows, parsedRows);
        appendProgress(paths, {
          phase: sourcePhase,
          uuid: info.uuid,
          markFrom: missingBatch.markFrom,
          markTo: missingBatch.markTo,
          parsed: parsedRows.length,
          rawPath: targetRawPath,
        });
        updateMissingProgress({ saved: true }, missingBatch.markFrom, missingBatch.markTo);
        return true;
      };
      for (const missingBatch of resumePlan.missingBatches) {
        if (consumeExistingMissingBatch(missingBatch)) continue;
        let exportResult = null;
        for (;;) {
          if (consumeExistingMissingBatch(missingBatch, "resume-raw-after-export-error")) {
            exportResult = { batches: [] };
            break;
          }
          try {
            exportResult = await exportTxtBatchesViaWosJs(page, {
              uuid: info.uuid,
              markFrom: missingBatch.markFrom,
              markTo: missingBatch.markTo,
              batchSize,
              sortBy: args.sortBy,
              onProgress(event) {
                const { text, ...progressEvent } = event || {};
                if (progressEvent.phase === "batch" && typeof text === "string") {
                  const markFrom = Number(progressEvent.current) || 0;
                  const markTo = Number(progressEvent.batchEnd) || 0;
                  const result = persistTxtBatch({
                    uuid: progressEvent.uuid || info.uuid,
                    markFrom,
                    markTo,
                    text,
                  }, "batch");
                  if (markFrom && markTo) progressEvent.rawPath = rawBatchPath(paths, info.uuid, markFrom, markTo);
                  progressEvent.parsed = result.parsed;
                  updateMissingProgress(result, markFrom, markTo);
                }
                appendProgress(paths, { phase: "wosjs-export-progress", sidSwitchCount, ...progressEvent });
              },
            });
            break;
          } catch (error) {
            await switchSidAfterTxtExportFailure(missingBatch, error);
          }
        }
        if (!exportResult) {
          throw new Error(`Export request failed for records ${missingBatch.markFrom}-${missingBatch.markTo}`);
        }

        for (const batch of exportResult.batches) {
          const result = persistTxtBatch(batch, "batch");
          updateMissingProgress(result, Number(batch.markFrom) || 0, Number(batch.markTo) || 0);
        }
      }
      const finalPlan = rawBatchPlanForRange(paths, info.uuid, range.startIndex, range.endIndex, batchSize);
      if (finalPlan.missingBatches.length) {
        const firstMissing = finalPlan.missingBatches[0];
        throw new Error(`Incomplete raw TXT batches after export: missing ${firstMissing.markFrom}-${firstMissing.markTo}`);
      }
      batchProgress.stop("Export complete");
      batchProgress = null;
    } else if (!isInteractive()) {
      console.error("WOS records already covered by raw batches; rebuilding WOS ID CSV.");
    }
    info = {
      ...info,
      availableCount: range.availableCount,
      expectedCount: range.selectedCount,
      selectedCount: range.selectedCount,
      fromIndex: range.startIndex,
      limit: args.limit || 0,
      rangeStart: range.startIndex,
      rangeEnd: range.endIndex,
      resumedCount,
    };
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
    authSpinner.succeed(authValidatedMessage(args));
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
    const { batches: totalBatches } = reportDownloadPlan(
      "WOS BibTeX records",
      expectedCount,
      selectedCount,
      batchSize
    );
    appendProgress(paths, {
      phase: "download-plan",
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

async function createReusableRecordPage(context, args) {
  const timeoutMs = args.recordTimeoutMs || args.timeoutMs;
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  await page.goto(`${args.baseUrl}/wos/`, {
    waitUntil: "domcontentloaded",
    timeout: Math.min(10000, timeoutMs),
  });
  await dismissWosPopups(page);
  await ensureWosJsOnPage(page, args);
  return page;
}

async function extractOneRecordInfo(page, args, wosid) {
  const timeoutMs = args.recordTimeoutMs || args.timeoutMs;
  const deadline = Date.now() + timeoutMs;
  page.setDefaultTimeout(timeoutMs);
  try {
    await ensureWosJsOnPage(page, args);
    const raw = await page.evaluate(async (targetWosId) => {
      if (!window.wos?.record?.viewFullRecordByWosId || !window.wos?.record?.parseCurrentFullRecordPage) {
        throw new Error("wos.js record parser API missing: window.wos.record.parseCurrentFullRecordPage");
      }

      const objectValues = (value) => Object.values(value || {}).filter((item) => (
        item && typeof item === "object" && !Array.isArray(item)
      ));
      const hasRecordContent = (record) => {
        if (!record || typeof record !== "object" || Array.isArray(record)) return false;
        if (record.wosid || record.UT || record.AccessionNumber || record.identifiers?.accessionNumber) return true;
        if (record.title || record.articleTitle || record.abstract) return true;
        if (Array.isArray(record.authors) && record.authors.length) return true;
        return Object.keys(record).length > 2;
      };
      const pickRecord = (parsed, preferredWosId) => {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const candidates = [
          parsed[preferredWosId],
          parsed[targetWosId],
          ...objectValues(parsed),
          parsed,
        ];
        return candidates.find(hasRecordContent) || null;
      };

      const diagnostics = [];
      let openedWosId = "";
      try {
        openedWosId = await window.wos.record.viewFullRecordByWosId(targetWosId);
      } catch (error) {
        diagnostics.push(`viewFullRecordByWosId: ${error?.message || error}`);
      }

      const currentWosId = () => window.wos.record.currentWosId || openedWosId || targetWosId;
      let record = null;
      let parseMethod = "";
      try {
        const parsed = await window.wos.record.parseCurrentFullRecordPage(targetWosId);
        record = pickRecord(parsed, currentWosId());
        if (record) parseMethod = "dom";
      } catch (error) {
        diagnostics.push(`parseCurrentFullRecordPage: ${error?.message || error}`);
      }

      if (!record && typeof window.wos.record.fetchFullRecordJsonByWosId === "function") {
        try {
          const fetched = await window.wos.record.fetchFullRecordJsonByWosId(targetWosId);
          record = pickRecord(fetched, currentWosId());
          if (record) parseMethod = "export-api";
        } catch (error) {
          diagnostics.push(`fetchFullRecordJsonByWosId: ${error?.message || error}`);
        }
      }

      if (!record) {
        throw new Error(`No full-record JSON parsed for ${targetWosId}${diagnostics.length ? ` (${diagnostics.join("; ")})` : ""}`);
      }
      return {
        ...record,
        wosid: currentWosId(),
        _parseMethod: parseMethod,
        url: location.href,
      };
    }, wosid);
    raw.wosid = reconcileWosId(wosid, raw.wosid || raw.identifiers?.accessionNumber || raw.url) || wosid;
    raw.fetchedAt = new Date().toISOString();
    return raw;
  } catch (error) {
    if (/timeout/i.test(error?.message || "")) {
      throw new Error(`Full record timeout after ${timeoutMs}ms: ${wosid}`);
    }
    throw error;
  }
}

async function runPoolWithReusableRecordPages(items, concurrency, getSessionState, args, worker, beforeItem = null) {
  let cursor = 0;
  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    let page = null;
    let pageGeneration = 0;
    try {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        if (typeof beforeItem === "function") await beforeItem(items[index], index);
        const state = getSessionState();
        if (!state?.session?.context) throw new Error("WOS parse session is not available");
        if (!page || pageGeneration !== state.generation || page.isClosed?.()) {
          await releaseWosPage(page);
          page = await createReusableRecordPage(state.session.context, args);
          pageGeneration = state.generation;
        }
        await worker(items[index], index, page);
      }
    } finally {
      await releaseWosPage(page);
    }
  });
  await Promise.all(workers);
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
      blacklisted: beforeStats.blacklisted,
      skippedBlacklist: beforeStats.skippedBlacklist,
      failed: 0,
      dbPath: args.dbPath,
      sqlite,
      failures: paths.parseFailures,
    };
  }

  if (!args.sid) {
    await prepareWosExport(args);
  }
  appendProgress(paths, { phase: "parse-start", total: wosids.length, selected: work.length, completed: beforeStats.completed, skippedExisting: beforeStats.skippedExisting, blacklisted: beforeStats.blacklisted, skippedBlacklist: beforeStats.skippedBlacklist, retryBlacklist: args.retryBlacklist, reparseExisting: args.reparseExisting, wosidsCsv: wosidsPath });
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
  let sessionGeneration = 0;
  let processed = 0;
  let parsed = 0;
  let consecutiveParseFailures = 0;
  let sidRecovery = null;
  const failures = [];
  const startParseSession = async (reason, chunkIndex = 0, chunksLength = 0, sessionOptions = {}) => {
    const nextSession = await prepareWosSession(args, { report: console.error, ...sessionOptions });
    try {
      sessionGeneration += 1;
      const warmup = await warmUpWosQueryPage(nextSession.page, args);
      appendProgress(paths, {
        phase: "parse-connectivity-query",
        reason,
        rowText: warmup.rowText,
        href: warmup.href,
        countText: warmup.countText,
        status: warmup.status,
        searchInfoReady: warmup.searchInfoReady,
        chunk: chunkIndex || undefined,
        chunks: chunksLength || undefined,
      });
      return nextSession;
    } catch (error) {
      await forceCloseWosSession(nextSession);
      throw error;
    }
  };
  const refreshSidAfterConsecutiveFailures = async (reasonText = `${PARSE_RECOVERY_CONSECUTIVE_FAILURES} consecutive WOSID page parses failed.`) => {
    if (sidRecovery) return sidRecovery;
    sidRecovery = (async () => {
      writeRuntimeNotice("WOS parse recovery", [
        reasonText,
        "Closing Playwright and testing the current SID with a WOS query.",
        sidBadge(args) ? `Current ${sidBadge(args)}` : "",
      ]);
      appendProgress(paths, { phase: "parse-sid-reconnect-start", consecutiveParseFailures, reason: reasonText });
      await forceCloseWosSession(session);
      session = null;
      session = await prepareWosSession(args, { report: console.error });
      sessionGeneration += 1;
      const recoveryQuery = await runWosRecoveryBuildQuery(session.page, args);
      appendProgress(paths, {
        phase: "parse-recovery-build-query",
        expr: recoveryQuery.expr,
        status: recoveryQuery.status,
        errorCode: recoveryQuery.error_code,
        uuid: recoveryQuery.uuid,
        refCount: recoveryQuery.ref_count,
      });
      if (recoveryQuery.error_code) {
        if (isSidInvalidRecoveryErrorCode(recoveryQuery.error_code)) {
          writeRuntimeNotice("WOS SID invalid", [
            `error_code: ${recoveryQuery.error_code}`,
            "Closing Playwright, removing this SID, and continuing with the next available saved SID.",
          ]);
          await forceCloseWosSession(session);
          session = null;
          const discarded = discardActiveConfigSid(args, `WOS recovery query failed: ${recoveryQuery.error_code}`, { force: true });
          if (discarded && !discarded.sidPoolCount) {
            writeRuntimeNotice("WOS SID pool empty", [
              "No saved SID remains after removing the invalid SID.",
              `Waiting for a new saved SID and checking again every ${Math.ceil(SID_POOL_WAIT_INTERVAL_MS / 1000)} seconds.`,
            ]);
            appendProgress(paths, {
              phase: "parse-sid-pool-wait-start",
              errorCode: recoveryQuery.error_code,
              intervalMs: SID_POOL_WAIT_INTERVAL_MS,
            });
            const usable = await waitForUsableWosSession(args, {
              intervalMs: SID_POOL_WAIT_INTERVAL_MS,
              report: console.error,
              openSession: () => startParseSession("sid-pool-refilled", 0, 0, { recoverSid: false }),
              onPoll: ({ attempts, waitedMs, intervalMs, sidPoolCount }) => {
                appendProgress(paths, {
                  phase: "parse-sid-pool-wait",
                  attempts,
                  waitedMs,
                  intervalMs,
                  sidPoolCount,
                });
              },
              onSidLoaded: (resumedSid) => {
                writeRuntimeNotice("WOS SID pool refilled", [
                  `Detected a new saved SID after ${formatRuntime(resumedSid.waitedMs)}.`,
                  "Reopening WOS and continuing parse.",
                  sidBadge(args) ? `Current ${sidBadge(args)}` : "",
                ]);
                appendProgress(paths, {
                  phase: "parse-sid-pool-wait-completed",
                  waitedMs: resumedSid.waitedMs,
                  attempts: resumedSid.attempts,
                  sidPoolCount: resumedSid.sidPoolCount,
                  sidSource: resumedSid.sidSource,
                });
              },
              onValidationFailure: ({ message }) => {
                appendProgress(paths, {
                  phase: "parse-sid-pool-refill-validation-failed",
                  sidSource: args.sidSource,
                  message,
                });
                writeRuntimeNotice("WOS SID pool refill failed", [
                  "A new saved SID was detected, but WOS could not reopen with it.",
                  "Removing that SID and waiting for another saved SID instead of returning to the menu.",
                  message,
                ]);
              },
            });
            session = usable.session;
            consecutiveParseFailures = 0;
            appendProgress(paths, { phase: "parse-sid-reconnect-completed", sidSource: args.sidSource });
            return;
          }
          args.sid = "";
          args.sidSource = "";
          delete process.env.WOS_SID;
          throw new CliRestartRequestedError(`WOS recovery query failed: ${recoveryQuery.error_code}`, { omitSidArgs: true });
        }
        writeRuntimeNotice("WOS recovery inconclusive", [
          `error_code: ${recoveryQuery.error_code}`,
          "Reconnecting with the current SID and continuing parse.",
        ]);
        appendProgress(paths, {
          phase: "parse-recovery-build-query-inconclusive",
          errorCode: recoveryQuery.error_code,
          action: "reconnect-current-sid",
        });
        await forceCloseWosSession(session);
        session = null;
        session = await startParseSession("recovery-query-inconclusive");
      }
      consecutiveParseFailures = 0;
      appendProgress(paths, { phase: "parse-sid-reconnect-completed", sidSource: args.sidSource });
    })().finally(() => {
      sidRecovery = null;
    });
    return sidRecovery;
  };
  try {
    session = await prepareWosSession(args);
    sessionGeneration += 1;
    authSpinner.succeed(authValidatedMessage(args));
    parseProgress = createProgress("Parsing WOS data", work.length);
    const chunkSize = effectiveParseChunkSize(args);
    const chunks = chunkItemsByCount(work, chunkSize);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      if (!session) {
        session = await startParseSession("browser-restart", chunkIndex + 1, chunks.length);
        appendProgress(paths, { phase: "parse-browser-session-start", chunk: chunkIndex + 1, chunks: chunks.length });
      }
      await runPoolWithReusableRecordPages(chunk, args.concurrency, () => ({
        session,
        generation: sessionGeneration,
      }), args, async (item, _workerIndex, page) => {
        const { wosid, index } = item;
        let recordProgressStatus = "ok";
        if (!args.reparseExisting && wosDataRecordExists(args.dbPath, wosid)) {
          recordProgressStatus = "skipped";
          consecutiveParseFailures = 0;
          appendProgress(paths, { phase: "parse-record", status: "skipped-existing", wosid, index, dbPath: args.dbPath });
          if (!isInteractive()) {
            console.error(`parse SKIP ${index}/${wosids.length} ${wosid}: already exists in ${args.dbPath}`);
          }
          return;
        }
        appendProgress(paths, { phase: "parse-record-start", wosid, index, total: wosids.length });
        try {
          const raw = await extractOneRecordInfo(page, args, wosid);
          const sqliteResult = importWosDataRecord({
            dbPath: args.dbPath,
            record: raw,
            taskId: task.taskId,
            source: raw.url || `wos:${wosid}`,
            expectedWosId: wosid,
            force: args.reparseExisting,
          });
          const blacklistRemoval = removeWosDataBlacklist({ dbPath: args.dbPath, blacklistDbPath: args.blacklistDbPath, wosid });
          parsed += 1;
          consecutiveParseFailures = 0;
          appendProgress(paths, { phase: "parse-record", status: "completed", wosid, index, dbPath: args.dbPath, imported: sqliteResult.imported, skipped: sqliteResult.skipped, blacklistRemoved: blacklistRemoval.removed });
          if (!isInteractive()) {
            console.error(`parse OK ${index}/${wosids.length} ${wosid} -> ${args.dbPath}`);
          }
        } catch (error) {
          const sessionRecoveryError = isSessionRecoveryError(error);
          const blacklisted = !sessionRecoveryError;
          let blacklistError = "";
          if (blacklisted) {
            try {
              recordWosDataBlacklist({
                dbPath: args.dbPath,
                blacklistDbPath: args.blacklistDbPath,
                wosid,
                taskId: task.taskId,
                source: `parse:${task.taskId}`,
                reason: "parse-failed",
                error: error.message || String(error),
              });
            } catch (blacklistWriteError) {
              blacklistError = blacklistWriteError.message || String(blacklistWriteError);
            }
          }
          recordProgressStatus = sessionRecoveryError ? "deferred" : "failed";
          consecutiveParseFailures += 1;
          appendProgress(paths, {
            phase: "parse-record",
            status: "failed",
            wosid,
            index,
            sessionRecoveryError,
            blacklisted,
            deferred: sessionRecoveryError,
            blacklistError,
            consecutiveParseFailures,
            error: error.message || String(error),
          });
          if (!isInteractive()) {
            console.error(`parse FAIL ${index}/${wosids.length} ${wosid}${blacklisted ? " blacklisted" : ""}: ${error.message || error}`);
            if (blacklistError) console.error(`parse blacklist write failed for ${wosid}: ${blacklistError}`);
          }
          const failure = {
            wosid,
            index,
            blacklisted,
            deferred: sessionRecoveryError,
            blacklistError,
            error: error && error.stack ? error.stack : String(error),
            failedAt: new Date().toISOString(),
          };
          failures.push(failure);
          if (sessionRecoveryError || consecutiveParseFailures >= PARSE_RECOVERY_CONSECUTIVE_FAILURES) {
            await refreshSidAfterConsecutiveFailures(
              sessionRecoveryError
                ? `WOS session error while parsing ${wosid}.`
                : `${PARSE_RECOVERY_CONSECUTIVE_FAILURES} consecutive WOSID page parses failed.`
            );
          }
        }
        processed += 1;
        parseProgress.update(processed, `${recordProgressStatus} ${wosid}`, failures.length);
        if (args.cooldownMs) await sleep(args.cooldownMs);
      }, async () => {
        if (sidRecovery) await sidRecovery;
      });
      const rssMb = currentProcessRssMb();
      const restartForMemory = shouldRestartParseForMemory(args, rssMb);
      const restartForCount = Boolean(args.browserRestartEvery && chunkIndex < chunks.length - 1 && ((chunkIndex + 1) * chunkSize) % args.browserRestartEvery === 0);
      if ((restartForCount || restartForMemory) && chunkIndex < chunks.length - 1) {
        appendProgress(paths, {
          phase: restartForMemory ? "parse-memory-restart" : "parse-browser-restart",
          processed,
          selected: work.length,
          browserRestartEvery: args.browserRestartEvery,
          maxRssMb: args.maxRssMb,
          rssMb,
        });
        if (!isInteractive()) {
          if (restartForMemory) {
            console.error(`parse memory restart ${processed}/${work.length}; rss=${rssMb}MB reached max-rss-mb=${args.maxRssMb}. Reconnecting with current SID and testing WOS query routing with ${DEFAULT_PARSE_CONNECTIVITY_QUERY}`);
          } else {
            console.error(`parse browser restart ${processed}/${work.length}; reconnecting with current SID and testing WOS query routing with ${DEFAULT_PARSE_CONNECTIVITY_QUERY}`);
          }
        }
        await session?.close?.();
        session = null;
      }
    }
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
    blacklisted: finalStats.blacklisted,
    skippedBlacklist: finalStats.skippedBlacklist,
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
  const samePriorSummary = sameTaskUuid(priorSummaryRaw, args) ? priorSummaryRaw : {};
  const priorRunFailed = isFailedTxtRunSummary(samePriorSummary);
  const priorRunUnverifiedPartial = isUnverifiedPartialTxtSummary(samePriorSummary, args);
  const priorSummary = (priorRunFailed || priorRunUnverifiedPartial) ? {} : samePriorSummary;
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
  const rawUuid = args.uuid || priorSummary.uuid || "";
  const inferredRangeStart = priorSummary.rangeStart ||
    priorSummary.fromIndex ||
    inferTxtRangeStart(paths, rawUuid, args, args.fromIndex || 1);
  let info = {
    uuid: args.uuid,
    expectedCount: priorSummary.expectedCount || 0,
    availableCount: priorSummary.availableCount || priorSummary.expectedCount || 0,
    selectedCount: priorSummary.selectedCount || priorSummary.expectedCount || 0,
    fromIndex: priorSummary.fromIndex || inferredRangeStart,
    limit: priorSummary.limit || args.limit || 0,
    rangeStart: inferredRangeStart,
    rangeEnd: priorSummary.rangeEnd || 0,
    href: priorSummary.summaryHref || args.url,
    rowText: priorSummary.rowText || "",
  };
  if (!info.rangeEnd && info.expectedCount) {
    info.rangeEnd = (info.rangeStart || 1) + info.expectedCount - 1;
  }
  const canRepairFromRaw = !args.force &&
    rawUuid &&
    !finalWosIdsCsvExists(paths, rawUuid) &&
    canRepairWosIdsFromRaw(paths, rawUuid, info.expectedCount, info.rangeStart, info.rangeEnd);

  if (((args.reuseRaw && !priorRunFailed && !priorRunUnverifiedPartial) || canRepairFromRaw) && rawUuid && rawBatchFiles(paths, rawUuid).length) {
    info.uuid = rawUuid;
    if (!info.expectedCount) {
      throw new Error("Cannot reuse raw batches without a known WOS record count. Re-run without --reuse-raw to refresh from WOS.");
    }
    const expectedEnd = info.rangeEnd || (info.rangeStart || 1) + info.expectedCount - 1;
    const plan = rawBatchPlanForRange(paths, rawUuid, info.rangeStart || 1, expectedEnd, DEFAULT_BATCH_SIZE);
    if (!plan.presentFiles.length) throw new Error(`No raw batches found for UUID: ${rawUuid}`);
    if (!plan.complete) {
      const firstMissing = plan.missingBatches[0];
      throw new Error(
        `Incomplete raw batches for UUID ${rawUuid}: missing ${firstMissing.markFrom}-${firstMissing.markTo}, expected ${info.rangeStart || 1}-${expectedEnd}. Re-run without --reuse-raw to resume from WOS.`
      );
    }
    rows = parseExistingRawBatches(paths, rawUuid, {
      files: plan.presentFiles,
      startIndex: info.rangeStart || 1,
      endIndex: expectedEnd,
    });
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
    availableCount: info.availableCount || info.expectedCount || 0,
    selectedCount: info.selectedCount || info.expectedCount || 0,
    fromIndex: info.fromIndex || args.fromIndex || 1,
    limit: info.limit || args.limit || 0,
    rangeStart: info.rangeStart || args.fromIndex || 1,
    rangeEnd: info.rangeEnd || info.expectedCount || 0,
    resumedCount: info.resumedCount || 0,
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

async function promptLine(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

async function promptHidden(message) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    const wasRaw = Boolean(input.isRaw);
    let value = "";

    function cleanup() {
      input.removeListener("data", onData);
      if (input.isTTY) input.setRawMode(wasRaw);
      output.write("\n");
      input.pause();
    }

    function onData(chunk) {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Password input cancelled."));
          return;
        }
        if (char === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }

    output.write(message);
    input.resume();
    if (input.isTTY) input.setRawMode(true);
    input.on("data", onData);
  });
}

async function prepareAuthCredentials(args, options = {}) {
  if (args.authAccounts.length || args.authPasswords.length) {
    normalizeAuthCredentials(args);
    return args;
  }
  if (args.authAccount && args.authPassword) {
    normalizeAuthCredentials(args);
    return args;
  }
  const canPrompt = options.canPrompt || (() => process.stdin.isTTY && process.stdout.isTTY);
  if (!canPrompt()) {
    normalizeAuthCredentials(args);
    return args;
  }
  if (!args.authAccount) args.authAccount = await (options.promptLine || promptLine)("MUST account: ");
  if (!args.authPassword) args.authPassword = await (options.promptHidden || promptHidden)("MUST password: ");
  normalizeAuthCredentials(args);
  return args;
}

function authDependencies(args) {
  return {
    login: loginAndExtractMustSid,
    saveSid: (sid) => addSidsToConfig(args, [sid], { activate: true }),
    currentSidPoolStatus: () => currentSidPoolStatus(args),
    writeMonitorStatus: (patch) => writeAuthMonitorStatus(args, patch),
    maskSid,
  };
}

function safeAuthResult(result) {
  const { sid, ...safe } = result || {};
  return safe;
}

function formatAuthLoginResult(result) {
  const saved = result.saved ? "saved" : "captured";
  const pool = result.saved ? ` pool=${result.sidPoolCount}` : "";
  return `Auth login ${saved}: SID ${result.sidMasked || "none"}${pool}`;
}

function formatAuthMonitorResult(result) {
  return `Auth monitor stopped: checks=${result.checks} triggered=${result.triggered} sidPoolCount=${result.sidPool?.sidPoolCount ?? 0}`;
}

async function executeAuthCommand(args, dependencies = authDependencies(args), options = {}) {
  if (!["login", "monitor"].includes(args.authCommand)) {
    throw new CliMessageError(`Unknown auth command: ${args.authCommand}`);
  }
  if (args.authProvider !== "must") {
    throw new CliMessageError(`Unsupported auth provider: ${args.authProvider}`);
  }
  if (args.authCommand === "monitor" && !args.authSave) {
    throw new CliMessageError("auth monitor requires saving. Remove --no-save.");
  }
  await prepareAuthCredentials(args, options);
  if (args.authCommand === "monitor") {
    const result = await monitorSidPool(args, dependencies, options);
    if (args.json) console.log(JSON.stringify(safeAuthResult(result), null, 2));
    else console.log(formatAuthMonitorResult(result));
    return 0;
  }
  const result = await runAuthLogin(args, dependencies, options);
  if (args.json) console.log(JSON.stringify(safeAuthResult(result), null, 2));
  else console.log(formatAuthLoginResult(result));
  return 0;
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
      config: globalConfigPath(),
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
      config: globalConfigPath(),
      href: quick.href || "",
      sid: "[saved]",
      message: quick.message || "SID accepted by WOS",
    };
  }

  if (quick.status === "invalid") {
    report("Saved SID is invalid. Choose manual SID input, wait for SID pool, or browser login to refresh it.");
  } else if (quick.status === "missing") {
    report("No saved SID found. Choose manual SID input, wait for SID pool, or browser login to create one.");
  } else {
    report("SID could not be confirmed with the lightweight check. Choose manual SID input, wait for SID pool, or browser login to continue validation.");
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
  if (args.command === "auth") {
    return executeAuthCommand(args);
  }
  if (args.command === "sid-pool") {
    console.log(JSON.stringify(currentSidPoolStatus(args), null, 2));
    return 0;
  }
  if (args.command === "workspace") {
    console.log(JSON.stringify(workspaceStatus(args), null, 2));
    return 0;
  }
  if (args.command === "settings") {
    if (args.playwrightVisible === null && args.parseConcurrencySetting === null && !args.addSidInputs.length) {
      console.error(usage());
      return 2;
    }
    const result = { ok: true, config: configPath(args.tasksRoot) };
    if (args.playwrightVisible !== null) {
      Object.assign(result, setPlaywrightVisibleSetting(args, args.playwrightVisible));
    }
    if (args.parseConcurrencySetting !== null) {
      Object.assign(result, setParseConcurrencySetting(args, args.parseConcurrencySetting));
    }
    if (args.addSidInputs.length) {
      Object.assign(result, addSidsToConfig(args, args.addSidInputs, { activate: true }));
    }
    console.log(JSON.stringify(result, null, 2));
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
  if (args.command === "install-browser") {
    installPlaywrightBrowserCommand(args);
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
    if (!args.queryWosId && !args.sqlQuery && !args.mergeDbPath && !args.blacklistQuery && !args.unblacklistWosId && !args.clearBlacklist) {
      console.error(usage());
      return 2;
    }
    const result = runWosDataImport(args);
    if (args.queryWosId || args.sqlQuery || args.blacklistQuery || args.unblacklistWosId || args.clearBlacklist) {
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

async function runParsedCommand(args, options = {}) {
  try {
    return await executeCommand(args);
  } catch (error) {
    if (isCliRestartRequestedError(error)) {
      console.error(error.message || "Restarting CLI");
      await closeSharedWosSession();
      const argv = options.argv || process.argv;
      return restartCurrentCli(error.omitSidArgs ? omitSidArgs(argv) : argv);
    }
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
    if (isCliMessageError(error)) {
      recordCommandFailure(args, error);
      console.error(error.message || String(error));
      return error.exitCode || 1;
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
        async waitForSidPool() {
          const result = await waitForSavedSidPool(menuArgs);
          return result.sid;
        },
        async saveSid(sid) {
          addSidsToConfig(menuArgs, [sid], { activate: true });
          menuArgs.sid = "";
          menuArgs.sidSource = "";
          const refreshedSidCheck = await quickValidateSid(menuArgs);
          return workspaceStatus(menuArgs, refreshedSidCheck);
        },
        addSids(sids) {
          addSidsToConfig(menuArgs, [sids], { activate: true });
          menuArgs.sid = "";
          menuArgs.sidSource = "";
          return workspaceStatus(menuArgs, sidCheck);
        },
        setCurrentTask(taskId) {
          setCurrentTaskId(menuArgs, taskId);
          return workspaceStatus(menuArgs, sidCheck);
        },
        setPlaywrightVisible(visible) {
          setPlaywrightVisibleSetting(menuArgs, visible);
          return workspaceStatus(menuArgs, sidCheck);
        },
        setParseConcurrency(value) {
          setParseConcurrencySetting(menuArgs, value);
          return workspaceStatus(menuArgs, sidCheck);
        },
      });
      if (!selectedArgs) return 0;
      if (selectedArgs.refresh) continue;

      try {
        const args = parseArgs([argv[0], argv[1], ...selectedArgs]);
        args.keepWosSession = true;
        const exitCode = await runParsedCommand(args, { argv: [argv[0], argv[1], ...selectedArgs] });
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
    if (isCliMessageError(error)) {
      console.error(error.message || String(error));
      process.exitCode = error.exitCode || 1;
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
  executeAuthCommand,
  prepareAuthCredentials,
  authDependencies,
  formatAuthLoginResult,
  formatAuthMonitorResult,
  authMonitorStatusPath,
  readAuthMonitorStatus,
  writeAuthMonitorStatus,
  currentSidPoolStatus,
  ensureSid,
  quickValidateSid,
  quickValidateCurrentSid,
  validateSidWithRetry,
  prepareWosSession,
  waitForUsableWosSession,
  clearSavedSidConfig,
  discardActiveConfigSid,
  addSidsToConfig,
  waitForSavedSidPool,
  globalConfigPath,
  readGlobalConfig,
  parseSidValues,
  sidPoolFromConfig,
  buildSidInitUrl,
  wosUserDataDir,
  wosProfileName,
  wosBrowserMode,
  wosBrowserLaunchOptions,
  releaseWosPage,
  releaseWosContext,
  forceCloseWosSession,
  setPlaywrightVisibleSetting,
  setParseConcurrencySetting,
  applySavedRuntimeSettings,
  resolveWosJsPath,
  requireWosJsPath,
  WOS_POPUP_DISMISS_SELECTORS,
  WOS_POPUP_DIALOG_SELECTORS,
  WOS_POPUP_GUARD_OPTIONS,
  installWosPopupGuard,
  dismissWosPopups,
  chooseFreshSidInteractively,
  acquireFreshSid,
  applyValidatedWosOrigin,
  isWosRootRecordRedirect,
  isSessionRecoveryError,
  isWosIdNoResultError,
  isWosIdBlacklistableError,
  isSidInvalidRecoveryErrorCode,
  validateTask,
  clearTask,
  confirmAndClearTask,
  parseArgs,
  omitSidArgs,
  makeTaskId,
  parseExportText,
  isFailedTxtRunSummary,
  isUnverifiedPartialTxtSummary,
  parseBibEntryCount,
  parseWosCount,
  downloadBatchCount,
  boundedRecordCount,
  selectedRecordRange,
  reportDownloadPlan,
  isUserCancelledError,
  isUserQuitError,
  isCliRestartRequestedError,
  isCliMessageError,
  isUserAbortError,
  CliMessageError,
  missingPlaywrightBrowserMessage,
  ensurePlaywrightBrowserInstalledForLaunch,
  installPlaywrightBrowserCommand,
  runPool,
  runPoolWithReusableRecordPages,
  chunkItemsByCount,
  currentProcessRssMb,
  effectiveParseChunkSize,
  shouldRestartParseForMemory,
  prepareWosRequestContext,
  warmUpWosQueryPage,
  runWosRecoveryBuildQuery,
  randomUppercaseLetters,
  pageContextUuid,
  readWosIdsCsv,
  normalizeWosId,
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
  firstRawBatchRange,
  inferTxtRangeStart,
  rawBatchCoverageFromStart,
  rawBatchPlanForRange,
  bibBatchFiles,
  parseExistingRawBatches,
  defaultWosBlacklistDbPath,
  importWosDataRecord,
  mergeWosDataDatabase,
  clearWosDataBlacklist,
  queryWosDataBlacklist,
  queryWosDataByWosId,
  queryWosDataDatabase,
  recordWosDataBlacklist,
  removeWosDataBlacklist,
  readJson,
  writeJson,
};
