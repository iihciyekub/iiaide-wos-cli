const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("node:readline/promises");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { readJson, writeFileAtomic, writeJson } = require("./lib/io");
const {
  DEFAULT_AUDIT_HTML_HOST,
  DEFAULT_AUDIT_HTML_LIMIT,
  DEFAULT_AUDIT_HTML_PORT,
  createAuditHtmlServer,
  exportAuditSnapshot,
} = require("./lib/audit-html");
const { askSidFromBrowserOrManual, interactiveArgs, isBackResult, isQuitResult, isUserAbortError, promptConfirmationText, promptSid } = require("./lib/interactive");
const { llmErrorResult, llmResult } = require("./lib/llm-output");
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
const { normalizeWosId } = require("./lib/wos-ids");
const { DEFAULT_MUST_LOGIN_URL, loginAndExtractMustSid } = require("./lib/wos-must-auth");
const {
  canonicalWosId,
  findExistingRecordIngest,
  getArtifactEvents,
  getAuditRuns,
  getAuditTimeline,
  getLatestRelationMetadata,
  getLatestSuccessfulQueryBuild,
  getRecordByWosId,
  getRelationMetadataForWosId,
  getResultsetContext,
  getResultsetItems,
  getResultsetMetadata,
  getSearchQueries,
  insertWosIngest,
  normalizeRelationType,
  openWosDatabase,
  writeAuditRecords,
} = require("./lib/wos-sqlite");
const {
  RECORD_RELATION_TYPES,
  callBrowserApi,
  queryTextForIds,
  runQueryBrowserCommand,
  runRecordBrowserCommand,
} = require("./lib/wos-query-record");
const { toStandardJson } = require("../import/wos-import");
const { version: VERSION } = require("../package.json");

const DEFAULT_BATCH_SIZE = 500;
const MAX_WOS_EXPORT_BATCHES = 200;
const MAX_WOS_EXPORT_RECORDS = MAX_WOS_EXPORT_BATCHES * DEFAULT_BATCH_SIZE;
const MAX_WOS_DUAL_SORT_RECORDS = MAX_WOS_EXPORT_RECORDS * 2;
const WOS_LARGE_EXPORT_SORTS = ["author-ascending", "author-descending"];
const WOS_EXPORT_WINDOW_MARKER_FILE = "_wos_export_window.json";
const DEFAULT_TIMEOUT_MS = 120000;
const SID_POOL_WAIT_INTERVAL_MS = 10000;
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
const DEFAULT_PROJECT_DIRNAME = ".iiaide-wos-cli";
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
  iiaide-wos <command> [options]
  iiw <command> [options]

Command groups:
  Interactive:
    iiaide-wos menu
    iiaide-wos

  Query UUID discovery:
    iiaide-wos query build --expr <query> [--json]
    iiaide-wos query parse --text <text> [--json]
    iiaide-wos query ids [--wosid <id>...] [--doi <doi>...] [--csv <file>] [--json]
    iiaide-wos query batch (--expr <query>... | --expr-file <file>) [--jsonl|--json]
    iiaide-wos query ingest (--expr <query> | --text <text> | --wosid <id>... | --doi <doi>... | --csv <file>) [--description <text>] [--json]

  Record relation UUID discovery:
    iiaide-wos record relations --wosid <id> --type <citations|references|related> [--json]
    iiaide-wos record shared --wosid <id> --with <id> [--json]
    iiaide-wos record collect --wosid <id> [--types citations,references,related] [--pages 20] [--json]
    iiaide-wos record ingest --wosid <id> --type <citations|references|related> [--description <text>] [--json]

  Raw export:
    iiaide-wos run (--url <summary-url> | --uuid <uuid>) [--sid <SID>] [options]
    iiaide-wos bib (--url <summary-url> | --uuid <uuid>) [--sid <SID>] [options]
    iiaide-wos batch-run [--search-root <dir>] [options]

  Import:
    iiaide-wos import --csv <wosids.csv> [options]

  SQLite lookup:
    iiaide-wos db uuid --uuid <uuid> [--json]
    iiaide-wos db wosid --wosid <id> [--json]
    iiaide-wos db list (--uuid <uuid> | --wosid <id> --type <self|citations|references|related>) [--context] [--json]
    iiaide-wos db context --wosid <id> --type <self|citations|references|related> [--json]
    iiaide-wos db searches [--limit <n>] [--uuid <uuid>] [--wosid <id>] [--json]
    iiaide-wos db artifacts [--limit <n>] [--uuid <uuid>] [--json]
    iiaide-wos db runs [--limit <n>] [--uuid <uuid>] [--json]
    iiaide-wos db timeline [--limit <n>] [--uuid <uuid>] [--wosid <id>] [--json]
    iiaide-wos db audit-html [--port <n>] [--limit <n>] [--uuid <uuid>] [--wosid <id>]
    iiaide-wos db audit-export [--format <html|json|both>] [--report-dir <dir>] [--limit <n>] [--uuid <uuid>] [--wosid <id>]

  Project workspace:
    iiaide-wos init [--tasks-root <dir>]
    iiaide-wos workspace [--tasks-root <dir>]
    iiaide-wos tasks [--tasks-root <dir>] [--json]
    iiaide-wos list [--tasks-root <dir>]
    iiaide-wos latest [--tasks-root <dir>]
    iiaide-wos show [--tasks-root <dir>]
    iiaide-wos path [--tasks-root <dir>]
    iiaide-wos validate [--tasks-root <dir>]
    iiaide-wos clear [--tasks-root <dir>]

  Authentication and settings:
    iiaide-wos check [--sid <SID> | --from-browser] [--tasks-root <dir>] [--headed]
    iiaide-wos sid [--sid <SID> | --from-browser] [--tasks-root <dir>] [--headed]
    iiaide-wos sid-pool [--tasks-root <dir>]
    iiaide-wos auth login [--provider must] [--account <email>] [--password <secret>] [options]
    iiaide-wos auth monitor [--provider must] [--account <email>] [--password <secret>] [options]
    iiaide-wos settings [--playwright-visible <on|off>] [--add-sid <SID>] [--add-sids "<SID...>"] [--clear-sids] [--clear-dead-sids]

  Maintenance:
    iiaide-wos update [--check]
    iiaide-wos install-browser [--with-deps]
    iiaide-wos --help
    iiaide-wos --version

Output conventions:
  --json             Prints { ok, code, command, taskId, artifact, uuid, count, message, data } where supported.
  --debug            Print WOS navigation/session debug steps to stderr.
  query/record       Prints UUID by default.
  run                Prints raw TXT batch directory on success.
  bib                Prints raw BibTeX batch directory on success.
  import             Prints managed WOSID CSV path on success.
  project/status cmds Print JSON or the requested project id/path.

Common inputs:
  --sid <SID>             Web of Science SID. Interactive commands prompt when missing or expired
  --from-browser          Open a browser login window and auto-detect WOS SID
  --url <summary-url>     WOS summary URL
  --uuid <uuid>           WOS result-set UUID; used when --url is not provided
  --csv <file>            Existing CSV containing a wosid/UT column or WOS IDs in its first column
  --expr <query>          WOS advanced-search query expression for query build
  --expr-file <file>      Text file with one WOS advanced-search query per line
                          For query batch, may be replaced or supplemented by repeated --expr
  --text <text>           Search text for query parse
  --description <text>    Semantic description for SQLite ingest result sets
  --wosid <id>            WOS record id; repeat for query ids
  --doi <doi>             DOI; repeat for query ids
  --type <name>           Record relation type: citations, references, or related
                          For db context, also supports self
  --types <list>          Record relation types for record collect. Default: citations,references,related
  --pages <n>             Result pages to collect for record collect. Max: 20
  --with <id>             Second WOS ID for shared-reference queries
  --search-root <dir>     Batch UUID search root. Default: current working directory
  --json                  Machine-readable output where supported
  --jsonl                 Machine-readable JSON Lines output for batch commands
  --context               For db list, include title/abstract/keywords/authors
  --quiet                 Suppress progress lines where supported

Output management:
  --task <task-id>        Legacy multi-task mode only. Default project mode uses the current directory name
  --task-label <label>    Human label stored in project metadata
  --tasks-root <dir>      Legacy multi-task root override. Default: ./.iiaide-wos-cli
  --out-dir <dir>         Exact output directory override; also enables legacy mode
  --force                 Allow managed task replacement
  --reuse-raw             Rebuild CSV from existing raw batches when present

Export options:
  --sort-by <sort>        Summary sort key. Default: relevance
  --ref-query             Export a references/citations/related result-set UUID with WOS ref-query request mode
  --batch-size <n>        WOS export API batch size. Default: 500, max: 500
  --allow-large-export    For UUID result sets over 100,000 records, use author ascending/descending windows up to 200,000 records
  --timeout-ms <n>        Navigation/API timeout. Default: 120000
  --wos-domain <domain>   WOS domain. Default: www.webofscience.com
  --wosjs <file>          Browser-side wos.js injection file. Default: ./import/wos.js
  --base-url <url>        WOS origin URL. Default: https://www.webofscience.com
  --headed                Show browser instead of headless mode
  --headless              Run browser in background mode for this command
  --playwright-visible <on|off>
                          Save whether WOS Playwright work opens a visible browser
  --add-sid <SID>         Add one SID to the saved SID pool; compatibility alias
  --add-sids <text>       Add multiple SIDs separated by spaces, newlines, or commas
  --clear-sids            Remove every saved SID from the global SID pool
  --clear-dead-sids       Remove saved invalid-SID history without changing the active SID pool
  --version               Show CLI version
  --help                  Show this help
  --check                 Check for an update without installing it
  --with-deps             Install Playwright Linux system packages with Chromium

Auth producer options:
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

Range options:
  --from-index <n>        Start from 1-based WOS record/WOSID index
  --limit <n>             Process only n records/WOS IDs
                          query/record ingest always stores at most 500 records

Task directory layout:
  project.json                         Project identity and layout metadata.
  state.json                           Latest task state.
  audit/activity.jsonl                 User-facing audit timeline.
  audit/searches.jsonl                 Search/query outcomes.
  audit/resultsets.jsonl               UUID/result-set registry.
  audit/artifacts.jsonl                File artifact registry.
  runs/<run-id>/command.json           Per-command sanitized inputs.
  runs/<run-id>/runtime.jsonl          CLI runtime/debug/progress events.
  runs/<run-id>/summary.json           Per-command result summary.
  wosData.sqlite                       Task-level SQLite database for query/record ingest.
  resultsets/<uuid>/raw/full-record/   TXT batches as <uuid>_<start>_<end>.txt
  resultsets/<uuid>/raw/bib/           BibTeX batches as <uuid>_<start>_<end>.bib
  resultsets/<uuid>/<uuid>_wosid.csv   Normalized WOS ID CSV.

Detailed command reference:
  docs/commands.md
`.trim();
}

function parseArgs(argv) {
  const command = argv[2] && !argv[2].startsWith("--") ? argv[2] : "run";
  const authCommand = command === "auth" && argv[3] && !argv[3].startsWith("--") ? argv[3] : "login";
  const queryCommand = command === "query" && argv[3] && !argv[3].startsWith("--") ? argv[3] : "";
  const recordCommand = command === "record" && argv[3] && !argv[3].startsWith("--") ? argv[3] : "";
  const dbCommand = command === "db" && argv[3] && !argv[3].startsWith("--") ? argv[3] : "";
  const startIndex = command === "run"
    ? (argv[2] === "run" ? 3 : 2)
    : (command === "auth" && argv[3] === authCommand ? 4 : ((command === "query" && queryCommand) || (command === "record" && recordCommand) || (command === "db" && dbCommand) ? 4 : 3));
  const args = {
    command,
    authCommand,
    queryCommand,
    recordCommand,
    dbCommand,
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
    queryExpr: "",
    queryExprs: [],
    queryExprFile: "",
    queryText: "",
    semanticDescription: "",
    wosIds: [],
    dois: [],
    relationType: "",
    relationTypes: [],
    pages: 20,
    withWosId: "",
    searchRoot: path.resolve(process.cwd()),
    taskId: "",
    taskLabel: "",
    outDir: "",
    tasksRoot: path.resolve(process.cwd(), "tasks"),
    sortBy: "relevance",
    refQuery: null,
    batchSize: DEFAULT_BATCH_SIZE,
    allowLargeExport: false,
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
    addSidInputs: [],
    clearSids: false,
    clearDeadSids: false,
    force: false,
    reuseRaw: false,
    concurrency: 1,
    concurrencySource: "",
    limit: 0,
    port: DEFAULT_AUDIT_HTML_PORT,
    outputFormat: "",
    reportDir: "",
    fromIndex: 1,
    fromIndexSource: "",
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
    quiet: false,
    debug: false,
    json: false,
    jsonl: false,
    context: false,
    help: false,
    version: false,
  };
  let sawAuthAccountArg = false;
  let sawAuthPasswordArg = false;
  let explicitTasksRoot = false;
  let explicitOutDir = false;
  let explicitTaskId = false;

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
    else if (arg === "--quiet") {
      args.authQuiet = true;
      args.quiet = true;
    }
    else if (arg === "--debug") args.debug = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--jsonl") args.jsonl = true;
    else if (arg === "--context") args.context = true;
    else if (arg === "--url") {
      args.url = readValue(arg, i++);
      args.urlHadProtocol = /^https?:\/\//i.test(args.url);
    }
    else if (arg === "--uuid") args.uuid = readValue(arg, i++);
    else if (arg === "--csv") args.csvPath = readValue(arg, i++);
    else if (arg === "--expr" || arg === "--query") {
      const value = readValue(arg, i++);
      args.queryExpr = value;
      args.queryExprs.push(value);
    }
    else if (arg === "--expr-file" || arg === "--query-file") args.queryExprFile = readValue(arg, i++);
    else if (arg === "--text") args.queryText = readValue(arg, i++);
    else if (arg === "--description" || arg === "--semantic-description") args.semanticDescription = readValue(arg, i++);
    else if (arg === "--wosid" || arg === "--wos-id") args.wosIds.push(readValue(arg, i++));
    else if (arg === "--doi") args.dois.push(readValue(arg, i++));
    else if (arg === "--type") args.relationType = readValue(arg, i++);
    else if (arg === "--types") args.relationTypes = readValue(arg, i++).split(",").map((value) => value.trim()).filter(Boolean);
    else if (arg === "--pages") args.pages = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--with") args.withWosId = readValue(arg, i++);
    else if (arg === "--search-root") args.searchRoot = path.resolve(readValue(arg, i++));
    else if (arg === "--task") {
      args.taskId = normalizeTaskId(readValue(arg, i++));
      explicitTaskId = true;
    }
    else if (arg === "--latest") args.latest = true;
    else if (arg === "--task-label" || arg === "--label") args.taskLabel = readValue(arg, i++);
    else if (arg === "--out-dir" || arg === "--download-dir") {
      args.outDir = readValue(arg, i++);
      explicitOutDir = true;
    }
    else if (arg === "--tasks-root" || arg === "--output-root") {
      args.tasksRoot = readValue(arg, i++);
      explicitTasksRoot = true;
    }
    else if (arg === "--sort-by") args.sortBy = readValue(arg, i++);
    else if (arg === "--ref-query") args.refQuery = true;
    else if (arg === "--no-ref-query") args.refQuery = false;
    else if (arg === "--batch-size") args.batchSize = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--allow-large-export") args.allowLargeExport = true;
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
    else if (arg === "--clear-sids") args.clearSids = true;
    else if (arg === "--clear-dead-sids") args.clearDeadSids = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--reuse-raw") args.reuseRaw = true;
    else if (arg === "--concurrency") {
      args.concurrency = parseIntegerFlag(arg, readValue(arg, i++));
      args.concurrencySource = "cli";
    }
    else if (arg === "--limit") args.limit = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--port") args.port = parseIntegerFlag(arg, readValue(arg, i++));
    else if (arg === "--format") args.outputFormat = readValue(arg, i++);
    else if (arg === "--report-dir") args.reportDir = path.resolve(readValue(arg, i++));
    else if (arg === "--from-index") {
      args.fromIndex = parseIntegerFlag(arg, readValue(arg, i++));
      args.fromIndexSource = "cli";
    }
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
  assertIntegerRange("--concurrency", args.concurrency, 1, 10);
  assertIntegerRange("--limit", args.limit, 0);
  assertIntegerRange("--from-index", args.fromIndex, 1);
  args.projectMode = !explicitTasksRoot && !explicitOutDir;
  args.tasksRoot = path.resolve(
    args.projectMode
      ? path.join(process.cwd(), DEFAULT_PROJECT_DIRNAME)
      : args.tasksRoot
  );
  applySavedRuntimeSettings(args);
  assertIntegerRange("--concurrency", args.concurrency, 1, 10);
  if (args.csvPath) args.csvPath = path.resolve(args.csvPath);
  if (args.queryExprFile) args.queryExprFile = path.resolve(args.queryExprFile);
  if (args.projectMode) {
    const defaultProjectId = normalizeTaskId(path.basename(process.cwd()) || "project");
    if (explicitTaskId && args.taskId !== defaultProjectId && !args.taskLabel) {
      args.taskLabel = args.taskId;
    }
    args.taskId = defaultProjectId;
  } else {
    if (!args.taskId && args.uuid) args.taskId = makeTaskId();
    if (!args.taskId && command === "import" && args.csvPath) args.taskId = makeTaskId();
    if (!args.taskId && command === "batch-run") args.taskId = makeTaskId();
    if (!args.taskId && (command === "query" || command === "record")) args.taskId = makeTaskId();
  }
  if (args.outDir) {
    args.outDir = path.resolve(args.outDir);
  } else if (args.projectMode) {
    args.outDir = args.tasksRoot;
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

function extractUuidsFromText(value) {
  const text = String(value || "");
  const matches = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[0-9a-f]{10})?/ig) || [];
  return dedupeSidValues(matches.map((item) => String(item || "").trim().toLowerCase()));
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
  if (args?.quiet) return false;
  if (!args?.uuid || typeof write !== "function") return false;
  write(`Resolved WOS UUID: ${args.uuid}`);
  return true;
}

function assertUuidDirectExportable(args) {
  const uuid = String(args?.uuid || "").trim();
  if (!uuid) return;
  const paths = getRunPaths(args.outDir);
  if (!fs.existsSync(paths.sqlitePath)) return;
  const db = openWosDatabase(paths.sqlitePath);
  try {
    const resultset = getResultsetMetadata(db, uuid);
    if (!resultset || resultset.uuidDirectExport !== false) return;
    const kind = resultset.kind || "relation";
    throw new CliMessageError(
      `UUID ${uuid} is marked as front-end WOSID collection only (${resultset.exportMode}). ` +
      `Use: iiaide-wos record ingest --wosid "${resultset.sourceWosId || "<source-wosid>"}" --type ${kind}`
    );
  } finally {
    db.close();
  }
}

async function prepareWosExport(args) {
  announceResolvedWosUuid(args);
  assertUuidDirectExportable(args);
  loadSavedSid(args);
  return args.sid;
}

function reportForArgs(args, write = console.error) {
  return (message) => {
    const text = String(message || "");
    if (args?.quiet && /^WOS UUID changed from /.test(text)) return;
    write(text);
  };
}

function debugForArgs(args, write = console.error) {
  return (message, details = {}) => {
    if (!args?.debug) return false;
    const parts = [];
    for (const [key, value] of Object.entries(details || {})) {
      if (value === undefined || value === null || value === "") continue;
      const safeValue = /^(sid|observedSid)$/i.test(key) ? maskSid(value) : redactSidInUrl(String(value));
      parts.push(`${key}=${safeValue}`);
    }
    const suffix = parts.length ? ` ${parts.join(" ")}` : "";
    write(`[debug] ${message}${suffix}`);
    return true;
  };
}

function shortUuid(value) {
  const text = String(value || "");
  if (text.length <= 18) return text;
  return `${text.slice(0, 8)}...${text.slice(-8)}`;
}

function txtExportProgressLabel(sortBy) {
  if (sortBy === "author-ascending") return "A-Z TXT";
  if (sortBy === "author-descending") return "Z-A TXT";
  return "Exporting records";
}

function batchOrdinalInRange(markTo, rangeStart, batchSize = DEFAULT_BATCH_SIZE) {
  const start = Math.max(1, Number(rangeStart) || 1);
  const end = Number(markTo) || 0;
  if (end < start) return 0;
  const size = Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE);
  return Math.max(1, Math.ceil((end - start + 1) / size));
}

function formatDownloadWindowDetail(currentWindow, totalWindows, detail = "") {
  const total = Math.max(0, Number(totalWindows) || 0);
  const current = Math.max(0, Math.min(total || Infinity, Number(currentWindow) || 0));
  const suffix = detail ? ` ${detail}` : "";
  return `download ${current}/${total}${suffix}`;
}

function formatUuidRemainingDetail(completedUuids, totalUuids) {
  const total = Math.max(0, Number(totalUuids) || 0);
  const completed = Math.max(0, Math.min(total || Infinity, Number(completedUuids) || 0));
  return `uuids ${completed}/${total} done, ${Math.max(0, total - completed)} left`;
}

function formatBatchUuidDownloadDetail(args, detail = "") {
  const context = args?.batchUuidProgress;
  if (!context) return detail;
  const uuidDetail = formatUuidRemainingDetail(context.completed || 0, context.total || 0);
  return detail ? `${uuidDetail} | ${detail}` : uuidDetail;
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

function formatRunIdDate(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "T",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    pad(date.getUTCMilliseconds(), 3),
    "Z",
  ].join("");
}

function operationSlug(args = {}) {
  if (args.command === "query") return `query-${args.queryCommand || "run"}`;
  if (args.command === "record") return `record-${args.recordCommand || "run"}`;
  if (args.command === "auth") return `auth-${args.authCommand || "login"}`;
  return args.command || "run";
}

function makeRunId(args = {}, date = new Date()) {
  return safeFilePart(`RUN${formatRunIdDate(date)}-${operationSlug(args)}`);
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

function isSingleProjectMode(args) {
  return Boolean(args?.projectMode);
}

function projectStorageDir(args) {
  return path.resolve(args.tasksRoot);
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

function clearDeadSidHistory(args) {
  const config = readSidConfig(args);
  if (!Array.isArray(config.deadSids) || !config.deadSids.length) return false;
  const { deadSids: _deadSids, ...rest } = config;
  writeGlobalConfig(rest);
  return true;
}

function advanceSavedSid(args, options = {}) {
  const config = readSidConfig(args);
  const pool = sidPoolFromConfig(config);
  if (pool.sids.length < 2) return false;
  if (options.requireCurrent !== false && args.sid && pool.activeSid && args.sid !== pool.activeSid) return false;
  const nextCursor = (pool.activeIndex + 1) % pool.sids.length;
  const { sid: _sid, ...rest } = config;
  writeGlobalConfig({
    ...rest,
    sids: pool.sids,
    sidCursor: nextCursor,
  });
  args.sid = pool.sids[nextCursor];
  args.sidSource = "config";
  args.sidPoolIndex = nextCursor;
  args.sidPoolCount = pool.sids.length;
  return {
    ok: true,
    activeSid: args.sid,
    sidPoolCount: pool.sids.length,
    sidPoolIndex: nextCursor,
  };
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

function authValidationMessage(args, prefix = "Validating WOS authentication") {
  const badge = sidBadge(args);
  return badge ? `${prefix} ${badge}` : prefix;
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
    const originDomain = urlDomain(origin);
    const haystack = `${href}\n${text}`.toLowerCase();
    const shellExposesUndefinedSession = /window\.sessiondata\s*=\s*undefined\b/i.test(text);
    const shellExposesSid = text.includes(sid) && /sessionData|BasicProperties|SID/.test(text);
    const hostShiftedAwayFromWos = Boolean(originDomain) && originDomain !== normalizeWosDomain(args.wosDomain || DEFAULT_WOS_DOMAIN);
    if (
      [401, 403].includes(response.status)
      || /\b(logged out|session expired)\b/i.test(haystack)
      || shellExposesUndefinedSession
      || hostShiftedAwayFromWos
    ) {
      return { status: "invalid", sidSource, sid, sidMasked, ok: false, href, origin, httpStatus: response.status, message: "SID was rejected by WOS" };
    }
    if (response.ok && shellExposesSid) {
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

function managedProjectEntryFromDir(tasksRoot, taskDir) {
  try {
    const projectPath = path.join(taskDir, "project.json");
    if (!fs.existsSync(projectPath)) return null;
    const project = readJson(projectPath, null);
    if (!project || project.command !== "iiaide-wos" || project.kind !== "wos-project") return null;
    const taskId = normalizeTaskId(project.task?.taskId || path.basename(taskDir));
    const statePath = path.join(taskDir, "state.json");
    const state = readJson(statePath, null) || {};
    const projectStat = fs.statSync(projectPath);
    const stateStat = fs.existsSync(statePath) ? fs.statSync(statePath) : null;
    const updatedMs = Math.max(projectStat.mtimeMs, stateStat?.mtimeMs || 0);
    return {
      taskId,
      label: state.taskLabel || project.task?.label || "",
      uuid: state.uuid || project.source?.uuid || "",
      url: state.inputUrl || project.source?.url || "",
      sortBy: state.sortBy || "",
      taskDir: storedTaskDirectory(tasksRoot, taskDir),
      status: state.status || state.method || "created",
      expectedCount: state.expectedCount || state.count || 0,
      uniqueCount: state.uniqueCount || 0,
      createdAt: project.createdAt || new Date(projectStat.birthtimeMs || projectStat.ctimeMs).toISOString(),
      updatedAt: new Date(updatedMs || projectStat.mtimeMs).toISOString(),
      lastError: state.lastError || "",
    };
  } catch (_) {
    return null;
  }
}

function discoverManagedTaskEntries(tasksRoot) {
  if (!fs.existsSync(tasksRoot)) return [];
  return fs.readdirSync(tasksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => managedProjectEntryFromDir(tasksRoot, path.join(tasksRoot, entry.name)))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function restoreDiscoveredTasks(args, existingTasks = []) {
  const discovered = discoverManagedTaskEntries(args.tasksRoot);
  if (!discovered.length) return [];
  const byId = new Map();
  for (const task of existingTasks) byId.set(task.taskId, task);
  for (const task of discovered) byId.set(task.taskId, { ...byId.get(task.taskId), ...task });
  const tasks = Array.from(byId.values())
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  writeTaskIndex(args.tasksRoot, { version: 1, tasks });
  return tasks;
}

function initializeWorkspace(args) {
  const indexPath = taskIndexPath(args.tasksRoot);
  const initialized = !fs.existsSync(indexPath);
  fs.mkdirSync(args.tasksRoot, { recursive: true });
  if (!fs.existsSync(indexPath)) writeJson(indexPath, { version: 1, tasks: [] });
  if (isSingleProjectMode(args)) {
    const projectPath = path.join(projectStorageDir(args), "project.json");
    if (!fs.existsSync(projectPath)) {
      writeJson(projectPath, {
        command: "iiaide-wos",
        kind: "wos-project",
        task: {
          taskId: args.taskId,
          taskDir: projectStorageDir(args),
          tasksRoot: args.tasksRoot,
        },
        createdAt: new Date().toISOString(),
      });
    }
  }
  return {
    ok: true,
    initialized,
    cwd: process.cwd(),
    tasksRoot: args.tasksRoot,
    index: indexPath,
  };
}

function createTaskPlaceholder(args, taskId = makeTaskId()) {
  const normalizedTaskId = isSingleProjectMode(args)
    ? args.taskId
    : normalizeTaskId(taskId);
  const taskDir = isSingleProjectMode(args)
    ? projectStorageDir(args)
    : taskDirectory(args.tasksRoot, normalizedTaskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const project = path.join(taskDir, "project.json");
  if (!fs.existsSync(project)) {
    writeJson(project, {
      command: "iiaide-wos",
      kind: "wos-project",
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
  if (isSingleProjectMode(args)) {
    return createTaskPlaceholder(args, args.taskId);
  }
  const index = readTaskIndex(args.tasksRoot);
  let tasks = Array.isArray(index.tasks) ? index.tasks : [];
  const latest = readLatestTaskId(args.tasksRoot);
  const latestTask = latest ? tasks.find((task) => task.taskId === latest) : null;
  if (latestTask) return latestTask;
  if (tasks.length) {
    writeCurrentTaskId(args.tasksRoot, tasks[0].taskId);
    return tasks[0];
  }
  tasks = restoreDiscoveredTasks(args, tasks);
  if (tasks.length) {
    const restoredLatestTask = latest ? tasks.find((task) => task.taskId === latest) : null;
    const task = restoredLatestTask || tasks[0];
    writeCurrentTaskId(args.tasksRoot, task.taskId);
    return task;
  }
  return createTaskPlaceholder(args);
}

function setCurrentTaskId(args, taskId) {
  if (isSingleProjectMode(args)) {
    return createTaskPlaceholder(args, args.taskId);
  }
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
  const tasks = isSingleProjectMode(args)
    ? [createTaskPlaceholder(args, args.taskId)]
    : (Array.isArray(index.tasks) ? index.tasks : []);
  const currentTask = isSingleProjectMode(args)
    ? args.taskId
    : (readLatestTaskId(args.tasksRoot) || "");
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
    wosBrowserMode: wosBrowserMode(args),
    wosProfileName: wosProfileName(args),
    wosProfilePath: wosUserDataDir(args),
    runtimeMs: Date.now() - CLI_STARTED_AT,
    taskCount: tasks.length,
    currentTask,
    latestTask: currentTask,
    projectMode: isSingleProjectMode(args),
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
  const entryId = isSingleProjectMode(args) ? args.taskId : args.taskId;
  const existing = index.tasks.find((task) => task.taskId === entryId);
  const entry = {
    taskId: entryId,
    label: args.taskLabel || existing?.label || "",
    uuid: patch.uuid !== undefined ? patch.uuid : (args.uuid || existing?.uuid || ""),
    url: patch.url !== undefined ? patch.url : (args.url || existing?.url || ""),
    sortBy: args.sortBy,
    taskDir: isSingleProjectMode(args) ? projectStorageDir(args) : storedTaskDirectory(args.tasksRoot, args.outDir),
    status: patch.status || existing?.status || "created",
    expectedCount: patch.expectedCount ?? existing?.expectedCount ?? 0,
    uniqueCount: patch.uniqueCount ?? existing?.uniqueCount ?? 0,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastError: patch.lastError ?? existing?.lastError ?? "",
  };
  const nextTasks = isSingleProjectMode(args)
    ? index.tasks.filter((task) => task.taskId !== entryId)
    : index.tasks.filter((task) => task.taskId !== args.taskId);
  nextTasks.push(entry);
  nextTasks.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  index.tasks = nextTasks;
  writeTaskIndex(args.tasksRoot, index);
  writeFileAtomic(latestTaskPath(args.tasksRoot), entryId + "\n");
  return entry;
}

function resolveTask(args) {
  if (isSingleProjectMode(args)) {
    const task = createTaskPlaceholder(args, args.taskId);
    return { ...task, taskDir: projectStorageDir(args) };
  }
  const index = readTaskIndex(args.tasksRoot);
  const taskId = args.taskId || (args.latest ? readLatestTaskId(args.tasksRoot) : "");
  if (!taskId) throw new Error("Missing --task or --latest");
  const task = (index.tasks || []).find((entry) => entry.taskId === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return { ...task, taskDir: resolvedTaskDirectory(args.tasksRoot, task.taskDir) };
}

function assertManagedTaskDirectory(taskDir) {
  if (!fs.existsSync(taskDir)) return;
  const project = readJson(path.join(taskDir, "project.json"), null);
  if (project?.command !== "iiaide-wos" || project?.kind !== "wos-project") {
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
  if (isSingleProjectMode(args)) {
    const taskDir = projectStorageDir(args);
    assertManagedTaskDirectory(taskDir);
    fs.rmSync(taskDir, { recursive: true, force: true });
    return {
      ok: true,
      taskId: args.taskId,
      taskDir,
      latestTask: "",
    };
  }
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
  const taskDir = outDir;
  const runId = "";
  const auditDir = path.join(taskDir, "audit");
  const runsRoot = path.join(taskDir, "runs");
  const resultsetsRoot = path.join(taskDir, "resultsets");
  return {
    taskDir,
    runId,
    runDir: "",
    auditDir,
    runsRoot,
    resultsetsRoot,
    rawRoot: resultsetsRoot,
    exportRoot: resultsetsRoot,
    pdfRoot: path.join(taskDir, "pdf"),
    sqlitePath: path.join(taskDir, "wosData.sqlite"),
    rawDir: resultsetsRoot,
    bibDir: resultsetsRoot,
    dataDir: resultsetsRoot,
    logsDir: "",
    project: path.join(taskDir, "project.json"),
    state: path.join(taskDir, "state.json"),
    manifest: path.join(taskDir, "project.json"),
    summary: path.join(taskDir, "state.json"),
    activityLog: path.join(auditDir, "activity.jsonl"),
    artifactsLog: path.join(auditDir, "artifacts.jsonl"),
    searchesLog: path.join(auditDir, "searches.jsonl"),
    resultsetsLog: path.join(auditDir, "resultsets.jsonl"),
    progressLog: path.join(taskDir, "runs", "unassigned", "runtime.jsonl"),
    commandJson: path.join(taskDir, "runs", "unassigned", "command.json"),
    runSummary: path.join(taskDir, "runs", "unassigned", "summary.json"),
  };
}

function withRawSource(paths, sourceId) {
  const source = safeFilePart(sourceId || "task");
  const rawSourceDir = path.join(paths.resultsetsRoot || paths.rawRoot || path.join(paths.taskDir, "resultsets"), source);
  const exportSourceDir = path.join(rawSourceDir, "exports");
  const fullRecordDir = path.join(rawSourceDir, "raw", "full-record");
  const bibExportDir = path.join(exportSourceDir, "bib");
  return {
    ...paths,
    rawSourceId: source,
    rawSourceDir,
    exportSourceDir,
    wosIdsDir: rawSourceDir,
    bibExportDir,
    rawDir: fullRecordDir,
    bibDir: path.join(rawSourceDir, "raw", "bib"),
    dataDir: rawSourceDir,
    parseFailures: path.join(fullRecordDir, `${source}_parse_failures.json`),
  };
}

function writeProjectFile(paths, args) {
  if (fs.existsSync(paths.project)) return readJson(paths.project, {});
  const project = {
    command: "iiaide-wos",
    kind: "wos-project",
    version: 2,
    task: {
      taskId: args.taskId,
      label: args.taskLabel,
      taskDir: paths.taskDir,
      tasksRoot: args.tasksRoot,
    },
    layout: {
      audit: "audit/",
      runs: "runs/",
      resultsets: "resultsets/",
      pdf: "pdf/",
      state: "state.json",
    },
    createdAt: new Date().toISOString(),
  };
  writeJson(paths.project, project);
  return project;
}

function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n", "utf8");
}

function appendAudit(paths, stream, event) {
  const targets = {
    activity: paths.activityLog,
    artifacts: paths.artifactsLog,
    searches: paths.searchesLog,
    resultsets: paths.resultsetsLog,
  };
  const filePath = targets[stream];
  if (!filePath) throw new Error(`Unknown audit stream: ${stream}`);
  appendJsonl(filePath, { runId: paths.runId || "", ...event });
}

function operationSummaryEvent(summary = {}) {
  if (summary.command === "query") return summary.ok ? "search.completed" : "search.failed";
  if (summary.command === "record") return summary.ok ? "record-query.completed" : "record-query.failed";
  if (summary.method === "wos-js-export-fetchTxtBatches") return summary.ok ? "export.txt.completed" : "export.txt.failed";
  if (summary.method === "wos-js-export-fetchBibBatches") return summary.ok ? "export.bib.completed" : "export.bib.failed";
  if (summary.method === "batch-uuid-csv-txt") return summary.ok ? "batch-export.completed" : "batch-export.failed";
  if (summary.method === "imported-wosid-csv") return summary.ok ? "import.completed" : "import.failed";
  return summary.ok === false ? "operation.failed" : "operation.completed";
}

function auditFileEntries(files = {}) {
  const entries = [];
  const add = (role, value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) add(role, item);
      return;
    }
    if (value && typeof value === "object") {
      add(role, value.path || value.file || value.dir || value.marker || "");
      return;
    }
    entries.push({ role, path: String(value) });
  };
  for (const [key, value] of Object.entries(files || {})) add(key, value);
  return entries;
}

function writeOperationSummary(paths, summary) {
  const enriched = {
    ...summary,
    runId: summary.runId || paths.runId || "",
  };
  writeJson(paths.state, enriched);
  writeJson(paths.runSummary, enriched);
  appendAudit(paths, "activity", {
    event: operationSummaryEvent(enriched),
    taskId: enriched.taskId || "",
    operation: enriched.operation || enriched.method || enriched.command || "",
    uuid: enriched.uuid || "",
    count: enriched.expectedCount || enriched.count || enriched.uniqueCount || 0,
    ok: Boolean(enriched.ok !== false),
  });
  if (enriched.command === "query" || enriched.command === "record") {
    appendAudit(paths, "searches", {
      event: enriched.ok ? "search.resultset" : "search.failed",
      taskId: enriched.taskId || "",
      operation: enriched.operation || "",
      query: enriched.rowText || "",
      source: enriched.source || {},
      uuid: enriched.uuid || "",
      count: enriched.count || enriched.expectedCount || 0,
      ok: Boolean(enriched.ok),
    });
  }
  if (enriched.uuid) {
    appendAudit(paths, "resultsets", {
      event: "resultset.observed",
      taskId: enriched.taskId || "",
      uuid: enriched.uuid,
      count: enriched.expectedCount || enriched.count || 0,
      url: enriched.summaryHref || enriched.inputUrl || "",
      rowText: enriched.rowText || "",
    });
  }
  for (const file of auditFileEntries(enriched.files)) {
    appendAudit(paths, "artifacts", {
      event: "artifact.recorded",
      taskId: enriched.taskId || "",
      uuid: enriched.uuid || "",
      ...file,
    });
  }
  writeSqliteAuditSummary(paths, enriched);
  return enriched;
}

function inferResultsetKind(summary = {}, item = {}) {
  if (item.kind) return item.kind;
  if (summary.kind) return summary.kind;
  if (summary.command === "query") return "normal";
  if (summary.command === "record") {
    const type = normalizeRelationType(item.relationType || summary.source?.type || summary.subcommand || "");
    if (["citations", "references", "related"].includes(type)) return type;
  }
  return "";
}

function sqliteAuditSearches(summary = {}) {
  if (summary.command === "query" && summary.subcommand === "batch" && Array.isArray(summary.results)) {
    return summary.results.map((item) => ({
      operation: item.operation || "query build",
      queryText: item.rowText || item.expr || "",
      sourceKind: item.source?.kind || "expr",
      source: item.source || {},
      uuid: item.uuid || "",
      count: Number(item.count || 0),
      ok: Boolean(item.ok),
      error: item.error || "",
      semanticDescription: "",
      relationType: "",
      sourceWosId: "",
    }));
  }
  if (summary.command === "record" && summary.subcommand === "collect" && Array.isArray(summary.relations)) {
    return summary.relations.map((relation) => ({
      operation: `record ${relation.type || ""}`.trim(),
      queryText: relation.rowText || "",
      sourceKind: "record-relation",
      source: { kind: "record-relation", wosid: summary.source?.wosid || "", type: relation.type || "" },
      uuid: relation.uuid || "",
      count: Number(relation.count || 0),
      ok: Boolean(relation.ok),
      error: relation.error || "",
      semanticDescription: "",
      relationType: relation.type || "",
      sourceWosId: summary.source?.wosid || "",
    }));
  }
  if (!["query", "record"].includes(summary.command || "")) return [];
  return [{
    operation: summary.operation || "",
    queryText: summary.rowText || "",
    sourceKind: summary.source?.kind || "",
    source: summary.source || {},
    uuid: summary.uuid || "",
    count: Number(summary.count || summary.expectedCount || 0),
    ok: Boolean(summary.ok),
    error: summary.error || "",
    semanticDescription: summary.semanticDescription || "",
    relationType: normalizeRelationType(summary.source?.type || summary.kind || ""),
    sourceWosId: summary.sourceWosId || summary.source?.wosid || "",
  }];
}

function sqliteAuditResultsets(summary = {}) {
  const searches = sqliteAuditSearches(summary);
  const resultsets = searches
    .filter((item) => item.uuid)
    .map((item) => ({
      uuid: item.uuid,
      kind: inferResultsetKind(summary, item),
      sourceWosId: item.sourceWosId || "",
      queryText: item.queryText || "",
      semanticDescription: item.semanticDescription || summary.semanticDescription || "",
      isRefQuery: Boolean(summary.isRefQuery),
      sortBy: summary.sortBy || "relevance",
      exportMode: summary.exportMode || "uuid-export",
      uuidDirectExport: summary.uuidDirectExport !== false,
      availableCount: Number(item.count || 0),
      lastIngestedCount: Number(summary.ingestedCount || 0),
    }));
  if (!resultsets.length && summary.uuid) {
    resultsets.push({
      uuid: summary.uuid,
      kind: inferResultsetKind(summary),
      sourceWosId: summary.sourceWosId || summary.source?.wosid || "",
      queryText: summary.rowText || "",
      semanticDescription: summary.semanticDescription || "",
      isRefQuery: Boolean(summary.isRefQuery),
      sortBy: summary.sortBy || "relevance",
      exportMode: summary.exportMode || "uuid-export",
      uuidDirectExport: summary.uuidDirectExport !== false,
      availableCount: Number(summary.count || summary.expectedCount || 0),
      lastIngestedCount: Number(summary.ingestedCount || 0),
    });
  }
  return resultsets;
}

function sqliteAuditArtifacts(summary = {}) {
  return auditFileEntries(summary.files).map((file) => ({
    role: file.role,
    path: file.path,
    uuid: summary.uuid || "",
  }));
}

function writeSqliteAuditSummary(paths, summary) {
  const db = openWosDatabase(paths.sqlitePath);
  try {
    writeAuditRecords(db, {
      runId: summary.runId || paths.runId || "",
      taskId: summary.taskId || "",
      command: summary.command || "",
      subcommand: summary.subcommand || "",
      operation: summary.operation || summary.method || summary.command || "",
      ok: Boolean(summary.ok !== false),
      uuid: summary.uuid || "",
      count: Number(summary.expectedCount || summary.count || summary.uniqueCount || 0),
      createdAt: summary.startedAt || summary.finishedAt || new Date().toISOString(),
      finishedAt: summary.finishedAt || new Date().toISOString(),
      summary,
      searches: sqliteAuditSearches(summary),
      resultsets: sqliteAuditResultsets(summary),
      artifacts: sqliteAuditArtifacts(summary),
    });
  } finally {
    db.close();
  }
}

function createRunLayout(args) {
  if (fs.existsSync(args.outDir) && !args.force) {
    const entries = fs.readdirSync(args.outDir).filter((name) => name !== ".DS_Store");
    if (entries.length) {
      const project = readJson(path.join(args.outDir, "project.json"), null);
      if (project?.command !== "iiaide-wos" || project?.kind !== "wos-project") {
        throw new Error(`Output directory is not empty: ${args.outDir}. Use --force or choose another --out-dir.`);
      }
    }
  }

  const paths = getRunPaths(args.outDir);
  args.runId = args.runId || makeRunId(args);
  paths.runId = args.runId;
  paths.runDir = path.join(paths.runsRoot, args.runId);
  paths.logsDir = paths.runDir;
  paths.progressLog = path.join(paths.runDir, "runtime.jsonl");
  paths.commandJson = path.join(paths.runDir, "command.json");
  paths.runSummary = path.join(paths.runDir, "summary.json");
  paths.manifest = paths.commandJson;
  for (const dir of [
    paths.auditDir,
    paths.runsRoot,
    paths.resultsetsRoot,
    paths.pdfRoot,
    paths.runDir,
  ]) fs.mkdirSync(dir, { recursive: true });
  writeProjectFile(paths, args);
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
  const rangeStart = Math.max(1, Number(summary.rangeStart) || Number(summary.fromIndex) || 1);
  const rangeEnd = Math.max(0, Number(summary.rangeEnd) || 0) ||
    (summary.expectedCount ? rangeStart + Math.max(0, Number(summary.expectedCount) || 0) - 1 : 0);
  if (!rangeEnd) return null;
  if (Array.isArray(summary.exportWindows) && summary.exportWindows.length) {
    for (const window of summary.exportWindows) {
      const sortOptions = isLargeExportSort(window.sortBy) ? { sortBy: window.sortBy } : {};
      const plan = rawBatchPlanForRange(paths, identifier, window.startIndex || 1, window.endIndex || 0, DEFAULT_BATCH_SIZE, sortOptions);
      if (plan.missingBatches.length) return null;
    }
  } else {
    const plan = rawBatchPlanForRange(paths, identifier, rangeStart, rangeEnd, DEFAULT_BATCH_SIZE);
    if (plan.missingBatches.length) return null;
  }
  return {
    ...summary,
    files: {
      ...(summary.files || {}),
      rawDir: rawBatchDir(paths, identifier),
      wosIdsDir: withRawSource(paths, identifier).wosIdsDir,
    },
  };
}

function readCompletedBibSummary(paths, args) {
  const summary = readJson(paths.summary, null);
  if (!summary?.ok || summary.method !== "wos-js-export-fetchBibBatches" || !sameTaskUuid(summary, args)) return null;
  const uuid = summary.uuid || args.uuid || "";
  const rangeStart = Math.max(1, Number(summary.rangeStart) || Number(summary.fromIndex) || 1);
  const rangeEnd = Math.max(0, Number(summary.rangeEnd) || 0) ||
    (summary.expectedCount ? rangeStart + Math.max(0, Number(summary.expectedCount) || 0) - 1 : 0);
  if (!uuid || !rangeEnd) return null;
  const plan = bibBatchPlanForRange(paths, uuid, rangeStart, rangeEnd, DEFAULT_BATCH_SIZE);
  if (plan.missingBatches.length) return null;
  return {
    ...summary,
    files: {
      ...(summary.files || {}),
      bibDir: bibBatchDir(paths, uuid),
    },
  };
}

function readCompletedArtifactSummary(args) {
  if (args.force || !args.outDir) return null;
  const paths = getRunPaths(args.outDir);
  if (args.command === "bib") return readCompletedBibSummary(paths, args);
  if (args.command === "run") return readCompletedRunSummary(paths, args);
  return null;
}

function printCompletedArtifactPath(command, summary) {
  if (command === "bib") {
    console.error("BibTeX raw batches already exist; skipping download.");
    console.log(summary.files.bibDir);
    return summary.ok ? 0 : 1;
  }
  console.error("WOS raw TXT batches already exist; skipping download.");
  console.log(summary.files.rawDir);
  return summary.ok ? 0 : 1;
}

function cleanRunLayout(paths) {
  const project = readJson(paths.project, null);
  if (project?.command !== "iiaide-wos" || project?.kind !== "wos-project") {
    throw new Error(`Refusing to clean unmanaged output directory: ${paths.taskDir}`);
  }
  for (const directory of [
    paths.resultsetsRoot || path.join(paths.taskDir, "resultsets"),
    paths.runsRoot || path.join(paths.taskDir, "runs"),
    paths.auditDir || path.join(paths.taskDir, "audit"),
    paths.pdfRoot || path.join(paths.taskDir, "pdf"),
  ].filter(Boolean)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  for (const filePath of [paths.state]) {
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
  appendJsonl(paths.progressLog, event);
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

function planWosExportWindows(totalRecords, batchSize = DEFAULT_BATCH_SIZE, options = {}) {
  const selectedCount = Math.max(0, Number(totalRecords) || 0);
  const size = Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE);
  const preferredSortBy = options.sortBy || "relevance";
  if (!selectedCount) return [];
  if (selectedCount <= MAX_WOS_EXPORT_RECORDS) {
    return [{
      sortBy: preferredSortBy,
      startIndex: 1,
      endIndex: selectedCount,
      selectedCount,
      batchCount: downloadBatchCount(selectedCount, size),
      limitedByWosWindow: false,
    }];
  }

  const totalBatches = downloadBatchCount(selectedCount, size);
  const firstBatchCount = MAX_WOS_EXPORT_BATCHES;
  const remainingBatchCount = Math.max(0, totalBatches - MAX_WOS_EXPORT_BATCHES);
  const overlapBatchCount = remainingBatchCount ? 1 : 0;
  const secondBatchCount = Math.min(MAX_WOS_EXPORT_BATCHES, remainingBatchCount + overlapBatchCount);
  const coveredCount = Math.min(selectedCount, MAX_WOS_DUAL_SORT_RECORDS);

  return [
    {
      sortBy: WOS_LARGE_EXPORT_SORTS[0],
      startIndex: 1,
      endIndex: MAX_WOS_EXPORT_RECORDS,
      selectedCount: MAX_WOS_EXPORT_RECORDS,
      batchCount: firstBatchCount,
      limitedByWosWindow: true,
    },
    {
      sortBy: WOS_LARGE_EXPORT_SORTS[1],
      startIndex: 1,
      endIndex: secondBatchCount * size,
      selectedCount: secondBatchCount * size,
      batchCount: secondBatchCount,
      overlapBatchCount,
      limitedByWosWindow: true,
    },
  ].filter((window) => window.selectedCount > 0).map((window, index) => ({
    ...window,
    windowIndex: index + 1,
    coveredCount,
    incompleteBeyondWosLimit: selectedCount > MAX_WOS_DUAL_SORT_RECORDS,
  }));
}

function usesLargeExportWindows(windows = []) {
  return windows.length > 1 || windows.some((window) => window.limitedByWosWindow);
}

function largeExportWarningLines(totalRecords, windows = []) {
  const total = Math.max(0, Number(totalRecords) || 0);
  const plannedRecords = windows.reduce((sum, window) => sum + Math.max(0, Number(window.selectedCount) || 0), 0);
  const plannedBatches = windows.reduce((sum, window) => sum + Math.max(0, Number(window.batchCount) || 0), 0);
  return [
    `WOS UUID result set has ${total} records, over the ${MAX_WOS_EXPORT_RECORDS} record single-sort export window.`,
    `A normal 500-record batch export would be incomplete after ${MAX_WOS_EXPORT_BATCHES} files.`,
    `Large-export mode will download at most ${MAX_WOS_DUAL_SORT_RECORDS} records using ${WOS_LARGE_EXPORT_SORTS.join(" + ")}.`,
    `Planned request windows: ${plannedBatches} files / ${plannedRecords} requested records, including one overlap batch when needed.`,
    total > MAX_WOS_DUAL_SORT_RECORDS
      ? `This UUID still exceeds ${MAX_WOS_DUAL_SORT_RECORDS}; records beyond that limit cannot be guaranteed.`
      : "",
  ].filter(Boolean);
}

async function confirmLargeWosExport(args, totalRecords, windows, options = {}) {
  if (args.allowLargeExport) return true;
  const message = largeExportWarningLines(totalRecords, windows).join("\n");
  if (options.skipInsteadOfThrow) {
    if (options.quiet) {
      console.error(`Skipping large UUID: ${totalRecords} records exceeds ${MAX_WOS_EXPORT_RECORDS}; re-run with --allow-large-export.`);
    } else {
      console.error(message);
      console.error(`Skipping this UUID. Re-run with --allow-large-export to download up to the ${MAX_WOS_DUAL_SORT_RECORDS}-record maximum.`);
    }
    return false;
  }
  if (!process.stdin.isTTY || !isInteractive(process.stdout)) {
    throw new CliMessageError(`${message}\nRe-run with --allow-large-export to download up to the ${MAX_WOS_DUAL_SORT_RECORDS}-record maximum, or reduce the query/range.`);
  }
  console.error(message);
  const answer = String(await (options.prompt || promptConfirmationText)(`Type max to continue up to ${MAX_WOS_DUAL_SORT_RECORDS} records, or skip to cancel`)).trim().toLowerCase();
  if (["max", "yes", "y"].includes(answer)) {
    args.allowLargeExport = true;
    return true;
  }
  if (["skip", "cancel", "c", ""].includes(answer)) return false;
  throw new CliMessageError("Large WOS export cancelled. Type max to continue or skip to cancel.");
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

function readUuidCsv(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  return extractUuidsFromText(text);
}

function findUuidCsvFiles(searchRoot) {
  const root = path.resolve(searchRoot || process.cwd());
  const results = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && /^uuid\.csv$/i.test(entry.name)) results.push(fullPath);
    }
  };
  visit(root);
  return results.sort();
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

function formatRuntime(ms) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

const DISPLAY_TIME_KEYS = new Set([
  "createdAt",
  "finishedAt",
  "timestamp",
  "startedAt",
  "generatedAt",
  "observedAt",
  "firstSeenAt",
  "lastSeenAt",
  "updatedAt",
  "completedAt",
]);

function formatLocalDateTime(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, "0");
  const tzName = Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value || "";
  const localDate = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-");
  return `${localDate} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${tzName ? ` ${tzName}` : ""}`;
}

function localizeDisplayTimes(value, key = "") {
  if (typeof value === "string" && DISPLAY_TIME_KEYS.has(key)) return formatLocalDateTime(value);
  if (Array.isArray(value)) return value.map((item) => localizeDisplayTimes(item));
  if (!value || typeof value !== "object") return value;
  const copy = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    copy[entryKey] = localizeDisplayTimes(entryValue, entryKey);
  }
  return copy;
}

function batchFileName(uuid, markFrom, markTo, extension = "txt") {
  return `${safeFilePart(uuid)}_${markFrom}_${markTo}.${extension}`;
}

function batchKey(markFrom, markTo) {
  return `${markFrom}-${markTo}`;
}

function isLargeExportSort(sortBy) {
  return WOS_LARGE_EXPORT_SORTS.includes(String(sortBy || ""));
}

function rawBatchDir(paths, uuid, options = {}) {
  if (!uuid) throw new Error("Missing raw batch UUID");
  const safeUuid = safeFilePart(uuid);
  const baseDir = path.join(paths.resultsetsRoot || path.join(paths.taskDir, "resultsets"), safeUuid, "raw", "full-record");
  return isLargeExportSort(options.sortBy) ? path.join(baseDir, safeFilePart(options.sortBy)) : baseDir;
}

function rawBatchPath(paths, uuid, markFrom, markTo, options = {}) {
  return path.join(rawBatchDir(paths, uuid, options), batchFileName(uuid, markFrom, markTo));
}

function rawUuidCompleteMarkerPath(paths, uuid) {
  return path.join(rawBatchDir(paths, uuid), `${safeFilePart(uuid)}_complete.json`);
}

function rawWindowDirs(paths, uuid, exportWindows = []) {
  if (!uuid || !Array.isArray(exportWindows)) return [];
  return exportWindows
    .filter((window) => isLargeExportSort(window.sortBy))
    .map((window) => ({
      sortBy: window.sortBy,
      dir: rawBatchDir(paths, uuid, { sortBy: window.sortBy }),
      marker: path.join(rawBatchDir(paths, uuid, { sortBy: window.sortBy }), WOS_EXPORT_WINDOW_MARKER_FILE),
      rangeStart: Number(window.startIndex) || 1,
      rangeEnd: Number(window.endIndex) || 0,
    }));
}

function writeRawWindowMarkers(paths, uuid, exportWindows = []) {
  for (const entry of rawWindowDirs(paths, uuid, exportWindows)) {
    writeJson(entry.marker, {
      ok: true,
      uuid,
      sortBy: entry.sortBy,
      direction: entry.sortBy === "author-ascending" ? "a-z" : "z-a",
      rangeStart: entry.rangeStart,
      rangeEnd: entry.rangeEnd,
      batchSize: DEFAULT_BATCH_SIZE,
      marker: "wos-export-window",
      updatedAt: new Date().toISOString(),
    });
  }
}

function bibBatchDir(paths, uuid) {
  if (!uuid) throw new Error("Missing BibTeX batch UUID");
  const safeUuid = safeFilePart(uuid);
  return path.join(paths.resultsetsRoot || path.join(paths.taskDir, "resultsets"), safeUuid, "raw", "bib");
}

function bibBatchPath(paths, uuid, markFrom, markTo) {
  return path.join(bibBatchDir(paths, uuid), batchFileName(uuid, markFrom, markTo, "bib"));
}

function batchFileStart(fileName) {
  return Number(String(fileName || "").match(/_(\d+)_(\d+)\.[^.]+$/)?.[1] || 0);
}

function parseBatchFileName(fileName, extension) {
  const pattern = new RegExp(`_(\\d+)_(\\d+)\\.${extension}$`);
  const match = String(fileName || "").match(pattern);
  if (!match) return null;
  return {
    fileName,
    batchStart: Number(match[1]),
    batchEnd: Number(match[2]),
  };
}

function parseRawBatchFileName(fileName) {
  return parseBatchFileName(fileName, "txt");
}

function parseBibBatchFileName(fileName) {
  return parseBatchFileName(fileName, "bib");
}

function rawBatchFiles(paths, uuid, options = {}) {
  if (!uuid) throw new Error("Missing raw batch UUID");
  const prefix = `${safeFilePart(uuid)}_`;
  const readDirectory = (directory, relativePrefix = "", sortBy = "") => {
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const fullPath = path.join(directory, entry.name);
        const relativeName = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
        if (entry.isDirectory() && !options.sortBy && options.includeSortDirs !== false && isLargeExportSort(entry.name)) {
          return readDirectory(fullPath, relativeName, entry.name);
        }
        if (!entry.isFile() || !entry.name.startsWith(prefix) || !/_(\d+)_(\d+)\.txt$/.test(entry.name)) return [];
        return [{ fileName: relativeName, sortBy }];
      });
  };
  const files = readDirectory(rawBatchDir(paths, uuid, options), "", options.sortBy || "");
  if (options.detailed) {
    return files.sort((a, b) => batchFileStart(a.fileName) - batchFileStart(b.fileName) || a.fileName.localeCompare(b.fileName));
  }
  return files
    .map((file) => file.fileName)
    .sort((a, b) => batchFileStart(a) - batchFileStart(b) || a.localeCompare(b));
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

function batchPlanForRange(paths, uuid, startIndex, endIndex, batchSize, fileList, fileParser, options = {}) {
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

  const ranges = fileList(paths, uuid, options)
    .map(fileParser)
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

function rawBatchPlanForRange(paths, uuid, startIndex = 1, endIndex = 0, batchSize = DEFAULT_BATCH_SIZE, options = {}) {
  const planOptions = options.sortBy ? options : { ...options, includeSortDirs: false };
  return batchPlanForRange(paths, uuid, startIndex, endIndex, batchSize, rawBatchFiles, parseRawBatchFileName, planOptions);
}

function bibBatchPlanForRange(paths, uuid, startIndex = 1, endIndex = 0, batchSize = DEFAULT_BATCH_SIZE) {
  return batchPlanForRange(paths, uuid, startIndex, endIndex, batchSize, bibBatchFiles, parseBibBatchFileName);
}

function parseExistingRawBatches(paths, uuid, options = {}) {
  const rows = [];
  const files = options.files || rawBatchCoverage(paths, uuid).files;
  const startIndex = Math.max(1, Number(options.startIndex) || 1);
  const endIndex = Math.max(0, Number(options.endIndex) || 0);
  for (const fileEntry of files) {
    const fileName = typeof fileEntry === "string" ? fileEntry : fileEntry.fileName;
    const sortBy = typeof fileEntry === "string" ? options.sortBy : fileEntry.sortBy;
    const { batchStart, batchEnd } = parseRawBatchFileName(fileName);
    const filePath = sortBy && !String(fileName).includes(path.sep)
      ? path.join(rawBatchDir(paths, uuid, { sortBy }), fileName)
      : path.join(rawBatchDir(paths, uuid), fileName);
    const text = fs.readFileSync(filePath, "utf8");
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

function writeRunSummary(paths, meta) {
  const outputId = meta.uuid || meta.taskId;
  const outputPaths = withRawSource(paths, outputId);
  const windowDirs = rawWindowDirs(paths, outputId, meta.exportWindows);
  const summary = {
    ok: true,
    method: "wos-js-export-fetchTxtBatches",
    ...meta,
    files: {
      rawDir: rawBatchDir(paths, outputId),
      rawWindowDirs: windowDirs,
      wosIdsDir: outputPaths.wosIdsDir,
      progressLog: paths.progressLog,
    },
    finishedAt: new Date().toISOString(),
  };
  writeOperationSummary(paths, summary);
  return summary;
}

function writeRawUuidCompleteMarker(paths, meta = {}) {
  const uuid = meta.uuid || "";
  if (!uuid) return "";
  const markerPath = rawUuidCompleteMarkerPath(paths, uuid);
  const exportWindows = Array.isArray(meta.exportWindows) ? meta.exportWindows : [];
  writeRawWindowMarkers(paths, uuid, exportWindows);
  writeJson(markerPath, {
    ok: true,
    uuid,
    expectedCount: Number(meta.expectedCount) || 0,
    availableCount: Number(meta.availableCount) || Number(meta.expectedCount) || 0,
    selectedCount: Number(meta.selectedCount) || Number(meta.expectedCount) || 0,
    fromIndex: Number(meta.fromIndex) || 1,
    rangeStart: Number(meta.rangeStart) || Number(meta.fromIndex) || 1,
    rangeEnd: Number(meta.rangeEnd) || 0,
    largeExport: Boolean(meta.largeExport),
    limitedByWosWindow: Boolean(meta.limitedByWosWindow),
    incompleteBeyondWosLimit: Boolean(meta.incompleteBeyondWosLimit),
    exportIsRefQuery: Boolean(meta.exportIsRefQuery),
    exportWindows,
    completedAt: new Date().toISOString(),
  });
  return markerPath;
}

function readRawUuidCompleteMarker(paths, uuid) {
  if (!uuid) return null;
  return readJson(rawUuidCompleteMarkerPath(paths, uuid), null);
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
  writeOperationSummary(paths, summary);
  return summary;
}

async function waitForWosSidSessionSignal(page, args) {
  const timeout = Math.min(Math.max(args.timeoutMs || 0, 15000), 60000);
  return page.waitForFunction(
    () => {
      const sid = window.sessionData?.BasicProperties?.SID || "";
      const href = location.href;
      if (sid) return { type: "sid", sid, href };
      if (/\/login|signin|shibboleth|sso|auth/i.test(href)) return { type: "login", sid: "", href };
      return false;
    },
    null,
    { timeout }
  ).then((handle) => handle.jsonValue()).catch(() => ({
    type: "timeout",
    sid: "",
    href: page.url?.() || "",
  }));
}

async function validateSid(page, args) {
  const debug = debugForArgs(args);
  const loginStartedAt = Date.now();
  const initUrl = buildSidInitUrl(args.sid);
  debug("wos sid: opening initialization URL", { url: initUrl, sidSource: args.sidSource });
  await page.goto(initUrl, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
  debug("wos sid: domcontentloaded", { url: page.url?.() || "" });
  await dismissWosPopups(page);
  debug("wos sid: popup guard complete");
  const signal = await waitForWosSidSessionSignal(page, args);
  debug("wos sid: session signal wait complete", {
    signal: signal.type,
    href: signal.href,
    observedSid: signal.sid,
  });
  await ensureWosJsOnPage(page, args);
  debug("wos sid: wos.js injected", { wosjs: args.wosJsPath });
  const status = await page.evaluate(() => ({
    href: location.href,
    origin: location.origin,
    sid: window.sessionData?.BasicProperties?.SID || "",
  }));
  debug("wos sid: evaluated browser session", { href: status.href, origin: status.origin, observedSid: status.sid });
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
  debug("wos sid: validation accepted", {
    origin: status.origin,
    sidSource: args.sidSource,
    loginElapsedMs: Date.now() - loginStartedAt,
  });
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
  const debug = debugForArgs(args);
  const keepAlive = Boolean(options.keepAlive || args.keepWosSession);
  const report = options.report || console.error;
  const visible = Boolean(options.visible || args.headed);
  const recoverSid = options.recoverSid !== false;
  const requestedUuid = String(args.uuid || "").trim();
  debug("wos session: preparing", {
    visible,
    keepAlive,
    recoverSid,
    sidSource: args.sidSource,
    sidPool: args.sidPoolCount ? `${Number(args.sidPoolIndex) + 1}/${args.sidPoolCount}` : "",
  });
  if (
    keepAlive
    && sharedWosSession?.context
    && requestedUuid
    && sharedWosSession.lastUuid
    && sharedWosSession.lastUuid !== requestedUuid
    && args.sidSource === "config"
  ) {
    const rotated = advanceSavedSid(args);
    if (rotated) {
      report(`WOS UUID changed from ${sharedWosSession.lastUuid} to ${requestedUuid}; switched to next saved SID (${rotated.sidPoolIndex + 1}/${rotated.sidPoolCount}).`);
      await closeSharedWosSession();
    }
  }
  if (keepAlive && sharedWosSession?.context) {
    debug("wos session: reusing shared browser context");
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
    debug("wos session: launching persistent browser context", { visible });
    let context = await launchWosPersistentContext(args, visible);
    let page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(args.timeoutMs);
    let status = null;
    if (!args.sid) {
      debug("wos session: no SID available, entering SID acquisition");
      await releaseWosContext(context);
      if (!recoverSid) throw new Error("No saved SID is available for WOS session preparation.");
      report("No saved SID found. Choose manual SID input, wait for SID pool, or browser login to continue.");
      await acquireFreshSid(args, report);
      context = await launchWosPersistentContext(args, visible);
      page = context.pages()[0] || await context.newPage();
      page.setDefaultTimeout(args.timeoutMs);
    }
    try {
      debug("wos session: validating SID");
      status = await validateSid(page, args);
    } catch (error) {
      debug("wos session: SID validation failed", { error: error.message || error });
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
    debug("wos session: ready", { origin: status?.origin, visible });
    if (keepAlive) {
      sharedWosSession = { context, page, lastUuid: requestedUuid };
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
  const runHook = async (name, hook, payload) => {
    if (!hook) return;
    try {
      await hook(payload);
    } catch (hookError) {
      report(`WOS SID supervisor ${name} hook failed: ${hookError?.message || hookError}`);
    }
  };

  if (options.ignoreEnvSid !== false) delete process.env.WOS_SID;

  for (;;) {
    if (!args.sid && !loadSavedSidFromConfig(args)) {
      const resumedSid = await waitForSavedSidPool(args, {
        intervalMs,
        report,
        onPoll,
      });
      await runHook("onSidLoaded", onSidLoaded, resumedSid);
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
      await runHook("onValidationFailure", onValidationFailure, {
        error,
        message,
        sidSource: args.sidSource,
        sidPoolCount: args.sidPoolCount,
        sidPoolIndex: args.sidPoolIndex,
      });
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
      sortBy: info?.sortBy || "",
      status: info?.status || "",
    });
    if (!window.asy_uuid?.fetchCurrentPageInfo) {
      throw new Error("wos.js summary API missing: window.asy_uuid.fetchCurrentPageInfo");
    }
    return window.asy_uuid.fetchCurrentPageInfo("iiaide-wos summary").then(normalizeInfo);
  });
}

async function openSummaryPageForExport(page, args, options = {}) {
  const uuid = String(options.uuid || "").trim();
  const sortBy = String(options.sortBy || "relevance").trim() || "relevance";
  if (!uuid) throw new Error("Missing UUID for WOS summary page");
  const currentOrigin = urlOrigin(page.url?.() || "") || DEFAULT_BASE_URL;
  const targetUrl = buildSummaryUrl(currentOrigin, uuid, sortBy);
  const debug = debugForArgs(args);
  debug("wos ingest: opening export summary page", { url: targetUrl, uuid, sortBy });
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
  await dismissWosPopups(page);
  await ensureWosJsOnPage(page, args);
  const info = await readSummaryInfo(page, args);
  debug("wos ingest: export summary page ready", {
    uuid: info.uuid,
    expectedCount: info.expectedCount,
    sortBy: info.sortBy,
    href: info.href,
  });
  if (info.uuid && info.uuid !== uuid) {
    throw new Error(`WOS summary page opened the wrong UUID: expected ${uuid}, got ${info.uuid}`);
  }
  if (!info.uuid) {
    throw new Error(`WOS summary page did not expose UUID after opening ${targetUrl}`);
  }
  return info;
}

function randomUppercaseLetters(length = 4) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

async function prepareWosRequestContext(page, args) {
  const debug = debugForArgs(args);
  debug("wos request context: opening summary URL", { url: args.url });
  await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: args.timeoutMs });
  await dismissWosPopups(page);
  await ensureWosJsOnPage(page, args);
  debug("wos request context: reading summary API", { url: page.url?.() || "" });
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

function initialExportRefQuery(args = {}, context = {}, info = {}) {
  if (typeof args.refQuery === "boolean") return args.refQuery;
  const text = [context.rowText, info.rowText, context.href, info.href, args.url]
    .filter(Boolean)
    .join(" ");
  return /cited[-\s]?references|references|related[-\s]?records|citing[-\s]?articles|shared[-\s]?references/i.test(text);
}

async function exportFromWos(args, paths) {
  const quiet = Boolean(args.quiet);
  const progressQuiet = quiet && !args.showDownloadProgress;
  const authSpinner = createSpinner(authValidationMessage(args), { quiet });
  let session = null;
  let page = null;
  let info = null;
  let exportRefQuery = Boolean(args.refQuery);
  let batchProgress = null;
  let summarySpinner = null;
  try {
    session = await prepareWosSession(args, { report: reportForArgs(args) });
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
    summarySpinner = createSpinner("Reading WOS summary information", { quiet });
    info = await readSummaryInfo(page, args);
    if (!info.uuid || !info.expectedCount) {
      summarySpinner.fail("Could not read WOS summary information");
      throw new Error(`Could not read summary uuid/count: ${JSON.stringify(info)}`);
    }
    summarySpinner.succeed(`Found ${info.expectedCount} records`);
    exportRefQuery = initialExportRefQuery(args, context, info);
    appendProgress(paths, { phase: "summary-info", ...info });
    appendProgress(paths, {
      phase: "txt-export-context",
      uuid: info.uuid,
      isRefQuery: exportRefQuery,
      refQuerySource: typeof args.refQuery === "boolean" ? "cli" : "auto",
    });
    const batchSize = DEFAULT_BATCH_SIZE;
    const firstRawRange = firstRawBatchRange(paths, info.uuid);
    if (!quiet && args.reuseRaw && !firstRawRange && shouldInferTxtRangeStartFromRaw(args)) {
      console.error(`WOS raw resume: no TXT batches found in ${rawBatchDir(paths, info.uuid)}`);
    }
    const rangeStart = inferTxtRangeStart(paths, info.uuid, args, args.fromIndex);
    const range = selectedRecordRange(info.expectedCount, rangeStart, args.limit);
    if (!range.selectedCount) {
      throw new Error(`WOS record range starts after available records: start=${range.startIndex} total=${range.availableCount}`);
    }
    if (!quiet && range.startIndex !== args.fromIndex) {
      console.error(`WOS record start inferred from raw batches: ${range.startIndex}`);
    }
    const largeWindowPlan = range.selectedCount > MAX_WOS_EXPORT_RECORDS;
    if (largeWindowPlan && (range.startIndex !== 1 || args.limit)) {
      throw new CliMessageError(
        `WOS UUID has ${range.selectedCount} selected records, which exceeds the ${MAX_WOS_EXPORT_RECORDS} single-sort export window. Large dual-sort export is only supported for full UUID downloads without --from-index/--limit.`
      );
    }
    const plannedWindows = largeWindowPlan
      ? planWosExportWindows(range.selectedCount, batchSize, { sortBy: args.sortBy })
      : [{
        sortBy: args.sortBy,
        startIndex: range.startIndex,
        endIndex: range.endIndex,
        selectedCount: range.selectedCount,
        batchCount: downloadBatchCount(range.selectedCount, batchSize),
      }];
    if (largeWindowPlan) {
      const proceed = await confirmLargeWosExport(args, info.expectedCount, plannedWindows);
      if (!proceed) throw new CliMessageError("Large WOS export skipped by user.");
    }
    const useSortWindowDirs = usesLargeExportWindows(plannedWindows);
    const windowPlans = plannedWindows.map((window) => {
      const sortOptions = useSortWindowDirs ? { sortBy: window.sortBy } : {};
      const plan = rawBatchPlanForRange(paths, info.uuid, window.startIndex, window.endIndex, batchSize, sortOptions);
      return { ...window, sortOptions, plan };
    });
    const resumedCount = windowPlans.reduce((total, window) => total + window.plan.coveredCount, 0);
    const remainingCount = windowPlans.reduce((total, window) => total + window.plan.missingCount, 0);
    const plannedBatchCount = windowPlans.reduce((total, window) => total + window.plan.plannedBatchCount, 0);
    const presentBatchCount = windowPlans.reduce((total, window) => total + window.plan.presentFiles.length, 0);
    const missingBatchCount = windowPlans.reduce((total, window) => total + window.plan.missingBatches.length, 0);
    const firstMissingWindow = windowPlans.find((window) => window.plan.missingBatches.length);
    const exportWindowsForSummary = windowPlans.map(({ plan, sortOptions, ...window }) => ({
      ...window,
      presentBatches: plan.presentFiles.length,
      missingBatchCount: plan.missingBatches.length,
      coveredCount: plan.coveredCount,
    }));
    writeRawWindowMarkers(paths, info.uuid, exportWindowsForSummary);
    if (presentBatchCount) {
      appendProgress(paths, {
        phase: "resume-raw",
        uuid: info.uuid,
        startIndex: range.startIndex,
        endIndex: range.endIndex,
        files: presentBatchCount,
        plannedBatches: plannedBatchCount,
        missingBatchCount,
        coveredCount: resumedCount,
        exportWindows: exportWindowsForSummary,
      });
      if (!quiet) console.error(`WOS raw resume: ${presentBatchCount}/${plannedBatchCount} TXT batches present; ${missingBatchCount} missing`);
    }
    const persistedBatchKeys = new Set();
    const persistTxtBatch = (batch, sourcePhase = "batch", sortOptions = {}) => {
      const markFrom = Number(batch.markFrom) || 0;
      const markTo = Number(batch.markTo) || 0;
      if (!markFrom || !markTo) return { saved: false };
      const key = `${sortOptions.sortBy || ""}:${batchKey(markFrom, markTo)}`;
      if (persistedBatchKeys.has(key)) return { saved: false };
      const rawPath = rawBatchPath(paths, info.uuid, markFrom, markTo, sortOptions);
      writeFileAtomic(rawPath, String(batch.text || ""));
      persistedBatchKeys.add(key);
      appendProgress(paths, { phase: sourcePhase, sortBy: sortOptions.sortBy || args.sortBy, markFrom, markTo, rawPath });
      if (!quiet && !isInteractive()) console.error(`export ${markFrom}-${markTo}: saved ${rawPath}`);
      return { saved: true };
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
      const switchSpinner = createSpinner(authValidationMessage(args, "Validating WOS authentication after SID switch"));
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
    if (!quiet) {
      reportDownloadPlan(
        "WOS records",
        info.expectedCount,
        remainingCount,
        batchSize
      );
    }
    const batchCount = missingBatchCount;
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
      plannedBatches: plannedBatchCount,
      presentBatches: presentBatchCount,
      missingBatchCount,
      firstMissingBatch: firstMissingWindow?.plan.missingBatches[0] || null,
      batchSize,
      exportWindows: exportWindowsForSummary,
    });
    if (remainingCount) {
      const useWindowProgress = useSortWindowDirs;
      if (!useWindowProgress) {
        batchProgress = createProgress("Exporting records", batchCount, { quiet: progressQuiet });
      }
      let completedMissingBatches = 0;
      let currentWindowStartIndex = 1;
      let currentDownloadWindow = 1;
      const downloadWindowCount = windowPlans.filter((window) => window.plan.missingBatches.length).length || 1;
      const updateMissingProgress = (result, markFrom, markTo) => {
        if (!result.saved) return;
        if (useWindowProgress) {
          const currentBatch = batchOrdinalInRange(markTo, currentWindowStartIndex, batchSize);
          batchProgress?.update(
            currentBatch,
            formatBatchUuidDownloadDetail(args, formatDownloadWindowDetail(currentDownloadWindow, downloadWindowCount, `${markFrom}-${markTo}`))
          );
        } else {
          completedMissingBatches += 1;
          batchProgress.update(
            completedMissingBatches,
            formatBatchUuidDownloadDetail(args, formatDownloadWindowDetail(1, 1, `${markFrom}-${markTo}`))
          );
        }
      };
      const consumeExistingMissingBatch = (missingBatch, sortOptions = {}, sourcePhase = "resume-raw-before-request") => {
        const targetRawPath = rawBatchPath(paths, info.uuid, missingBatch.markFrom, missingBatch.markTo, sortOptions);
        if (!fs.existsSync(targetRawPath)) return false;
        const key = `${sortOptions.sortBy || ""}:${batchKey(missingBatch.markFrom, missingBatch.markTo)}`;
        if (persistedBatchKeys.has(key)) return true;
        appendProgress(paths, {
          phase: sourcePhase,
          uuid: info.uuid,
          sortBy: sortOptions.sortBy || args.sortBy,
          markFrom: missingBatch.markFrom,
          markTo: missingBatch.markTo,
          rawPath: targetRawPath,
        });
        updateMissingProgress({ saved: true }, missingBatch.markFrom, missingBatch.markTo);
        return true;
      };
      let downloadWindowIndex = 0;
      for (const window of windowPlans) {
        const windowLabel = txtExportProgressLabel(window.sortBy);
        if (useWindowProgress && window.plan.missingBatches.length) {
          downloadWindowIndex += 1;
          currentDownloadWindow = downloadWindowIndex;
          currentWindowStartIndex = window.startIndex || 1;
          const firstMissing = window.plan.missingBatches[0];
          const resumeOrdinal = firstMissing
            ? batchOrdinalInRange(firstMissing.markFrom - 1, currentWindowStartIndex, batchSize)
            : 0;
          batchProgress = createProgress(windowLabel, window.plan.plannedBatchCount, { quiet: progressQuiet });
          if (resumeOrdinal) {
            batchProgress.update(
              resumeOrdinal,
              formatBatchUuidDownloadDetail(args, formatDownloadWindowDetail(currentDownloadWindow, downloadWindowCount, "resume"))
            );
          }
        }
        for (const missingBatch of window.plan.missingBatches) {
          if (consumeExistingMissingBatch(missingBatch, window.sortOptions)) continue;
          let exportResult = null;
          for (;;) {
            if (consumeExistingMissingBatch(missingBatch, window.sortOptions, "resume-raw-after-export-error")) {
              exportResult = { batches: [] };
              break;
            }
            try {
              exportResult = await exportTxtBatchesViaWosJs(page, {
                uuid: info.uuid,
                markFrom: missingBatch.markFrom,
                markTo: missingBatch.markTo,
                batchSize,
                sortBy: window.sortBy,
                isRefQuery: exportRefQuery,
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
                    }, "batch", window.sortOptions);
                    if (markFrom && markTo) progressEvent.rawPath = rawBatchPath(paths, info.uuid, markFrom, markTo, window.sortOptions);
                    progressEvent.parsed = result.parsed;
                    updateMissingProgress(result, markFrom, markTo);
                  }
                  appendProgress(paths, { phase: "wosjs-export-progress", sidSwitchCount, sortBy: window.sortBy, isRefQuery: exportRefQuery, ...progressEvent });
                },
              });
              break;
            } catch (error) {
              if (args.refQuery === null && !exportRefQuery) {
                exportRefQuery = true;
                appendProgress(paths, {
                  phase: "txt-export-ref-query-retry",
                  uuid: info.uuid,
                  markFrom: missingBatch.markFrom,
                  markTo: missingBatch.markTo,
                  sortBy: window.sortBy,
                  message: error?.message || String(error),
                });
                continue;
              }
              await switchSidAfterTxtExportFailure(missingBatch, error);
            }
          }
          if (!exportResult) {
            throw new Error(`Export request failed for ${window.sortBy} records ${missingBatch.markFrom}-${missingBatch.markTo}`);
          }

          for (const batch of exportResult.batches) {
            const result = persistTxtBatch(batch, "batch", window.sortOptions);
            updateMissingProgress(result, Number(batch.markFrom) || 0, Number(batch.markTo) || 0);
          }
        }
        if (useWindowProgress && batchProgress) {
          batchProgress.stop(`${windowLabel} complete`);
          batchProgress = null;
        }
      }
      const incompleteWindow = windowPlans
        .map((window) => ({
          ...window,
          plan: rawBatchPlanForRange(paths, info.uuid, window.startIndex, window.endIndex, batchSize, window.sortOptions),
        }))
        .find((window) => window.plan.missingBatches.length);
      if (incompleteWindow) {
        const firstMissing = incompleteWindow.plan.missingBatches[0];
        throw new Error(`Incomplete raw TXT batches after export: missing ${incompleteWindow.sortBy} ${firstMissing.markFrom}-${firstMissing.markTo}`);
      }
      if (batchProgress) {
        batchProgress.stop("Export complete");
        batchProgress = null;
      }
    } else if (!quiet && !isInteractive()) {
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
      rangeEnd: largeWindowPlan ? Math.min(range.selectedCount, MAX_WOS_DUAL_SORT_RECORDS) : range.endIndex,
      resumedCount,
      largeExport: largeWindowPlan,
      limitedByWosWindow: largeWindowPlan,
      incompleteBeyondWosLimit: largeWindowPlan && range.selectedCount > MAX_WOS_DUAL_SORT_RECORDS,
      exportWindows: exportWindowsForSummary,
      exportIsRefQuery: exportRefQuery,
    };
  } finally {
    authSpinner.stop();
    summarySpinner?.stop();
    batchProgress?.stop("Export stopped");
    await session?.close?.();
  }
  return {
    info,
  };
}

async function exportBibFromWos(args, paths) {
  const authSpinner = createSpinner(authValidationMessage(args));
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
  let resumedCount = 0;
  let exportRefQuery = Boolean(args.refQuery);
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
    exportRefQuery = initialExportRefQuery(args, context);
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
      isRefQuery: exportRefQuery,
      refQuerySource: typeof args.refQuery === "boolean" ? "cli" : "auto",
    });
    const batchSize = DEFAULT_BATCH_SIZE;
    const resumePlan = bibBatchPlanForRange(paths, uuid, startIndex, finalIndex, batchSize);
    resumedCount = resumePlan.coveredCount;
    const resumedFiles = resumePlan.presentFiles.map((fileName) => path.join(bibBatchDir(paths, uuid), fileName));
    const fileKeys = new Set();
    for (const filePath of resumedFiles) {
      files.push(filePath);
      fileKeys.add(path.basename(filePath));
      downloadedEntries += parseBibEntryCount(fs.readFileSync(filePath, "utf8"));
    }
    if (resumePlan.presentFiles.length) {
      appendProgress(paths, {
        phase: "resume-bib-raw",
        uuid,
        startIndex,
        endIndex: finalIndex,
        files: resumePlan.presentFiles.length,
        plannedBatches: resumePlan.plannedBatchCount,
        missingBatchCount: resumePlan.missingBatches.length,
        coveredCount: resumePlan.coveredCount,
        entries: downloadedEntries,
      });
      console.error(`WOS BibTeX resume: ${resumePlan.presentFiles.length}/${resumePlan.plannedBatchCount} BibTeX batches present; ${resumePlan.missingBatches.length} missing`);
    }
    const remainingCount = resumePlan.missingCount;
    const { batches: totalBatches } = reportDownloadPlan(
      "WOS BibTeX records",
      expectedCount,
      remainingCount,
      batchSize
    );
    appendProgress(paths, {
      phase: "download-plan",
      label: "WOS BibTeX records",
      availableCount: expectedCount,
      selectedCount,
      resumedCount,
      remainingCount,
      batchCount: resumePlan.missingBatches.length,
      plannedBatches: resumePlan.plannedBatchCount,
      presentBatches: resumePlan.presentFiles.length,
      missingBatchCount: resumePlan.missingBatches.length,
      firstMissingBatch: resumePlan.missingBatches[0] || null,
      batchSize,
    });
    if (remainingCount) {
      progress = createProgress(
        "Downloading WOS BibTeX",
        totalBatches || resumePlan.missingBatches.length || 1
      );
      const persistBibBatch = (batch) => {
        const entryCount = parseBibEntryCount(batch.text);
        if (!entryCount) {
          appendProgress(paths, { phase: "bib-empty-batch", markFrom: batch.markFrom, requestedMarkTo: batch.markTo });
          if (!files.length) throw new Error(`No BibTeX entries returned for UUID ${uuid} at ${batch.markFrom}-${batch.markTo}`);
          if (!isInteractive()) console.error(`bib export ${batch.markFrom}-${batch.markTo}: no entries`);
          return false;
        }
        const markTo = batch.markFrom + entryCount - 1;
        const fileName = batchFileName(uuid, batch.markFrom, markTo, "bib");
        const bibPath = bibBatchPath(paths, uuid, batch.markFrom, markTo);
        if (!fileKeys.has(fileName)) {
          writeFileAtomic(bibPath, batch.text);
          files.push(bibPath);
          fileKeys.add(fileName);
          downloadedEntries += entryCount;
          completedBatches += 1;
        }
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
        return true;
      };
      const consumeExistingMissingBatch = (missingBatch) => {
        const targetPath = bibBatchPath(paths, uuid, missingBatch.markFrom, missingBatch.markTo);
        if (!fs.existsSync(targetPath)) return false;
        const fileName = path.basename(targetPath);
        if (!fileKeys.has(fileName)) {
          files.push(targetPath);
          fileKeys.add(fileName);
          downloadedEntries += parseBibEntryCount(fs.readFileSync(targetPath, "utf8"));
          completedBatches += 1;
        }
        appendProgress(paths, {
          phase: "resume-bib-raw-before-request",
          uuid,
          markFrom: missingBatch.markFrom,
          markTo: missingBatch.markTo,
          bibPath: targetPath,
        });
        progress.update(completedBatches, `${missingBatch.markFrom}-${missingBatch.markTo}`);
        return true;
      };
      for (const missingBatch of resumePlan.missingBatches) {
        if (consumeExistingMissingBatch(missingBatch)) continue;
        const exportResult = await exportBibBatchesViaWosJs(page, {
          uuid,
          markFrom: missingBatch.markFrom,
          markTo: missingBatch.markTo,
          batchSize,
          sortBy: args.sortBy,
          filters: "authorTitleSource",
          isRefQuery: exportRefQuery,
          onProgress(event) {
            appendProgress(paths, { phase: "wosjs-bib-progress", isRefQuery: exportRefQuery, ...event });
            if (event.phase === "batch") {
              progress.update(completedBatches + (event.completedBatches || 0), `${event.current}-${event.batchEnd}`);
            }
          },
        });
        if (!expectedCount && exportResult.totalRecords) expectedCount = exportResult.totalRecords;
        for (const batch of exportResult.batches) persistBibBatch(batch);
      }
      const finalPlan = bibBatchPlanForRange(paths, uuid, startIndex, finalIndex, batchSize);
      if (finalPlan.missingBatches.length) {
        const firstMissing = finalPlan.missingBatches[0];
        throw new Error(`Incomplete raw BibTeX batches after export: missing ${firstMissing.markFrom}-${firstMissing.markTo}`);
      }
      progress.stop("WOS BibTeX download complete");
      progress = null;
    } else if (!isInteractive()) {
      console.error("WOS BibTeX records already covered by raw batches.");
    }
    if (selectedCount && downloadedEntries < selectedCount) {
      throw new Error(`Incomplete BibTeX export for UUID ${uuid}: downloaded ${downloadedEntries}/${selectedCount} records`);
    }
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
      fromIndex: startIndex,
      rangeStart: startIndex,
      rangeEnd: finalIndex,
      resumedCount,
      requestMode: true,
      completedBatches,
      exportIsRefQuery: exportRefQuery,
    },
    files,
  };
}

async function inspectWosUuid(args) {
  await prepareWosExport(args);
  const session = await prepareWosSession(args, { report: reportForArgs(args) });
  try {
    const context = await prepareWosRequestContext(session.page, args);
    const info = await readSummaryInfo(session.page, args);
    const expectedCount = info.expectedCount || context.expectedCount || 0;
    const rangeStart = args.fromIndex || 1;
    const rangeEnd = args.limit
      ? Math.min(rangeStart + Math.max(0, Number(args.limit) || 0) - 1, expectedCount)
      : expectedCount;
    return {
      uuid: info.uuid || context.uuid || args.uuid,
      expectedCount,
      availableCount: expectedCount,
      selectedCount: Math.max(0, rangeEnd - rangeStart + 1),
      fromIndex: rangeStart,
      rangeStart,
      rangeEnd,
      href: info.href || args.url,
      rowText: info.rowText || "",
    };
  } finally {
    await session.close?.();
  }
}

function plannedTxtRangeFromMeta(meta = {}) {
  const rangeStart = Math.max(1, Number(meta.rangeStart) || Number(meta.fromIndex) || 1);
  const rangeEnd = Math.max(0, Number(meta.rangeEnd) || 0)
    || (meta.expectedCount ? rangeStart + Math.max(0, Number(meta.expectedCount) || 0) - 1 : 0);
  return { rangeStart, rangeEnd };
}

function rawUuidDownloadState(paths, uuid, meta = {}, options = {}) {
  if (Array.isArray(meta.exportWindows) && meta.exportWindows.length) {
    const plans = meta.exportWindows.map((window) => {
      const sortOptions = isLargeExportSort(window.sortBy) ? { sortBy: window.sortBy } : {};
      return {
        ...window,
        plan: rawBatchPlanForRange(paths, uuid, window.startIndex || 1, window.endIndex || 0, DEFAULT_BATCH_SIZE, sortOptions),
      };
    });
    return {
      complete: plans.every((window) => window.plan.complete),
      rangeStart: Math.min(...plans.map((window) => Math.max(1, Number(window.startIndex) || 1))),
      rangeEnd: Math.max(...plans.map((window) => Math.max(0, Number(window.endIndex) || 0))),
      plan: {
        exportWindows: plans,
        complete: plans.every((window) => window.plan.complete),
        missingBatches: plans.flatMap((window) => window.plan.missingBatches.map((batch) => ({ ...batch, sortBy: window.sortBy }))),
      },
    };
  }
  if (Number(meta.expectedCount) > MAX_WOS_EXPORT_RECORDS) {
    const windows = planWosExportWindows(Number(meta.expectedCount), DEFAULT_BATCH_SIZE, { sortBy: options.sortBy || meta.sortBy || "relevance" });
    return rawUuidDownloadState(paths, uuid, { ...meta, exportWindows: windows }, options);
  }
  const { rangeStart, rangeEnd } = plannedTxtRangeFromMeta(meta);
  if (!uuid || !rangeEnd) return { complete: false, rangeStart, rangeEnd, plan: null };
  const plan = rawBatchPlanForRange(paths, uuid, rangeStart, rangeEnd, DEFAULT_BATCH_SIZE);
  return { complete: plan.complete, rangeStart, rangeEnd, plan };
}

function downloadWindowCountForState(state) {
  if (!state || state.complete) return 0;
  if (Array.isArray(state.plan?.exportWindows)) {
    return state.plan.exportWindows.filter((window) => window.plan?.missingBatches?.length).length;
  }
  return state.plan?.missingBatches?.length ? 1 : 0;
}

async function runBatchUuidTxt(args) {
  const csvFiles = findUuidCsvFiles(args.searchRoot);
  if (!csvFiles.length) {
    throw new CliMessageError(`No uuid.csv files found under ${args.searchRoot}`);
  }
  const uuids = dedupeSidValues(csvFiles.flatMap(readUuidCsv));
  if (!uuids.length) {
    throw new CliMessageError(`No UUIDs found in uuid.csv files under ${args.searchRoot}`);
  }

  const paths = createRunLayout(args);
  const batchManifest = {
    command: "iiaide-wos",
    operation: "batch-run",
    args: manifestArgs(args),
    task: {
      taskId: args.taskId,
      label: args.taskLabel,
      taskDir: paths.taskDir,
      tasksRoot: args.tasksRoot,
    },
    batch: {
      searchRoot: args.searchRoot,
      csvFiles,
      totalUuids: uuids.length,
    },
    createdAt: new Date().toISOString(),
  };
  writeJson(paths.manifest, batchManifest);
  upsertTaskIndex(args, { status: "batch-running", lastError: "" });
  appendProgress(paths, { phase: "batch-uuid-discovered", searchRoot: args.searchRoot, csvFiles, totalUuids: uuids.length });

  const prepareProgress = createProgress("Planning UUID downloads", uuids.length);
  const results = [];
  let completed = 0;
  let skipped = 0;
  let resumed = 0;
  const jobs = [];
  let progress = null;
  let totalDownloadBatches = 0;

  try {
    for (const [index, uuid] of uuids.entries()) {
      const step = `${index + 1}/${uuids.length}`;
      prepareProgress.update(index);
      const marker = readRawUuidCompleteMarker(paths, uuid);
      let meta = marker || {};
      let state = rawUuidDownloadState(paths, uuid, meta, { sortBy: args.sortBy });
      appendProgress(paths, { phase: "batch-uuid-start", uuid, index: index + 1, total: uuids.length, marker: Boolean(marker) });

      if (marker && state.complete) {
        skipped += 1;
        completed += 1;
        prepareProgress.update(index + 1);
        appendProgress(paths, { phase: "batch-uuid-skip-complete", uuid, index: index + 1, total: uuids.length });
        results.push({ uuid, status: "skipped" });
        continue;
      }

      if (!meta.expectedCount || !state.complete) {
        const inspectArgs = {
          ...args,
          command: "run",
          uuid,
          url: buildSummaryUrl(args.baseUrl, uuid, args.sortBy),
          force: false,
          outDir: args.outDir,
          quiet: true,
        };
        meta = await inspectWosUuid(inspectArgs);
        if (meta.expectedCount > MAX_WOS_EXPORT_RECORDS && !args.allowLargeExport) {
          const windows = planWosExportWindows(meta.expectedCount, DEFAULT_BATCH_SIZE, { sortBy: args.sortBy });
          await confirmLargeWosExport(args, meta.expectedCount, windows, { skipInsteadOfThrow: true, quiet: true });
          skipped += 1;
          completed += 1;
          prepareProgress.update(index + 1);
          appendProgress(paths, {
            phase: "batch-uuid-skip-large-export",
            uuid,
            index: index + 1,
            total: uuids.length,
            expectedCount: meta.expectedCount,
            maxSingleSortRecords: MAX_WOS_EXPORT_RECORDS,
            maxDualSortRecords: MAX_WOS_DUAL_SORT_RECORDS,
          });
          results.push({ uuid, status: "skipped-large", expectedCount: meta.expectedCount });
          continue;
        }
        state = rawUuidDownloadState(paths, uuid, meta, { sortBy: args.sortBy });
        if (state.complete) {
          writeRawUuidCompleteMarker(paths, { ...meta, uuid });
          skipped += 1;
          completed += 1;
          prepareProgress.update(index + 1);
          appendProgress(paths, { phase: "batch-uuid-verified-complete", uuid, index: index + 1, total: uuids.length });
          results.push({ uuid, status: "skipped" });
          continue;
        }
      }

      const hadRaw = rawBatchFiles(paths, uuid).length > 0;
      const downloadWindowCount = downloadWindowCountForState(state);
      jobs.push({ uuid, meta, hadRaw, downloadWindowCount, index });
      prepareProgress.update(index + 1);
    }
    prepareProgress.stop("Planning UUID downloads complete");

    totalDownloadBatches = jobs.reduce((total, job) => total + job.downloadWindowCount, 0);
    appendProgress(paths, { phase: "batch-uuid-download-plan", totalDownloadBatches, jobs: jobs.length });
    if (totalDownloadBatches) progress = createProgress("Batch UUID TXT", totalDownloadBatches);
    let completedDownloadBatches = 0;
    let completedDownloadUuids = 0;
    const totalDownloadUuids = jobs.length;

    for (const job of jobs) {
      const { uuid, meta, hadRaw, downloadWindowCount, index } = job;
      const runArgs = {
        ...args,
        command: "run",
        uuid,
        url: buildSummaryUrl(args.baseUrl, uuid, args.sortBy),
        force: false,
        outDir: args.outDir,
        quiet: true,
        showDownloadProgress: true,
        batchUuidProgress: {
          completed: completedDownloadUuids,
          total: totalDownloadUuids,
        },
      };
      progress?.update(completedDownloadBatches, formatUuidRemainingDetail(completedDownloadUuids, totalDownloadUuids));
      const summary = await run(runArgs);
      writeRawUuidCompleteMarker(paths, summary);
      completed += 1;
      if (hadRaw) resumed += 1;
      completedDownloadBatches += downloadWindowCount;
      completedDownloadUuids += 1;
      progress?.update(completedDownloadBatches, formatUuidRemainingDetail(completedDownloadUuids, totalDownloadUuids));
      appendProgress(paths, {
        phase: "batch-uuid-complete",
        uuid,
        index: index + 1,
        total: uuids.length,
        resumed: hadRaw,
        expectedCount: summary.expectedCount,
      });
      results.push({ uuid, status: hadRaw ? "resumed" : "downloaded" });
    }
    progress?.stop("Batch UUID TXT complete");
  } catch (error) {
    prepareProgress.stop("Planning UUID downloads stopped");
    progress?.stop("Batch UUID TXT stopped");
    appendProgress(paths, { phase: "batch-uuid-failed", message: error?.message || String(error), completed, skipped, resumed });
    upsertTaskIndex(args, { status: "batch-failed", lastError: error?.message || String(error) });
    throw error;
  }

  const summary = {
    ok: true,
    method: "batch-uuid-csv-txt",
    taskId: args.taskId,
    taskLabel: args.taskLabel,
    searchRoot: args.searchRoot,
    csvFiles,
    totalUuids: uuids.length,
    totalDownloadBatches,
    completed,
    skipped,
    resumed,
    files: {
      rawRoot: paths.rawRoot,
      progressLog: paths.progressLog,
    },
    results,
    finishedAt: new Date().toISOString(),
  };
  writeJson(paths.manifest, batchManifest);
  writeOperationSummary(paths, summary);
  upsertTaskIndex(args, { status: "batch-completed", lastError: "" });
  return summary;
}

function combineBibFiles(paths, uuid, files) {
  const outputPaths = withRawSource(paths, uuid);
  const combinedPath = bibFilePath(outputPaths, uuid);
  const combined = [...files]
    .sort((a, b) => batchFileStart(path.basename(a)) - batchFileStart(path.basename(b)))
    .map((filePath) => fs.readFileSync(filePath, "utf8").trim())
    .filter(Boolean)
    .join("\n\n");
  writeFileAtomic(combinedPath, combined + (combined ? "\n" : ""));
  return combinedPath;
}

function validateTask(args) {
  const task = resolveTask(args);
  if (isSingleProjectMode(args) && !fs.existsSync(task.taskDir)) {
    return {
      ok: false,
      taskId: task.taskId,
      taskDir: task.taskDir,
      issues: ["missing managed project directory"],
    };
  }
  const basePaths = getRunPaths(task.taskDir);
  const initialSummary = readJson(basePaths.summary, {});
  const rawSource = initialSummary.uuid || task.uuid || task.taskId;
  const paths = withRawSource(basePaths, rawSource);
  const summary = initialSummary;
  const isBibTask = summary.method === "wos-js-export-fetchBibBatches";
  const isImportedCsvTask = summary.method === "imported-wosid-csv";
  const isBatchTxtTask = summary.method === "batch-uuid-csv-txt";
  const isSqliteIngestTask = summary.method === "wos-sqlite-ingest";
  const wosidsCsv = wosIdsCsvPath(paths, summary.uuid || task.uuid || task.taskId);
  const wosids = isImportedCsvTask && fs.existsSync(wosidsCsv) ? readWosIdsCsv(wosidsCsv) : [];
  const batchResults = isBatchTxtTask && Array.isArray(summary.results) ? summary.results : [];
  const rawUuid = summary.uuid || task.uuid || "";
  const rawFiles = rawUuid ? rawBatchFiles(paths, rawUuid) : [];
  const bibUuid = isBibTask ? (summary.uuid || task.uuid || "") : "";
  const bibFiles = bibUuid && fs.existsSync(bibBatchDir(paths, bibUuid))
    ? fs.readdirSync(bibBatchDir(paths, bibUuid)).filter((name) => name.endsWith(".bib"))
    : [];
  const txtRangeStart = Math.max(1, Number(summary.rangeStart) || Number(summary.fromIndex) || 1);
  const txtRangeEnd = Math.max(0, Number(summary.rangeEnd) || 0) ||
    (summary.expectedCount ? txtRangeStart + Math.max(0, Number(summary.expectedCount) || 0) - 1 : 0);
  const bibRangeStart = Math.max(1, Number(summary.rangeStart) || Number(summary.fromIndex) || 1);
  const bibRangeEnd = Math.max(0, Number(summary.rangeEnd) || 0) ||
    (summary.expectedCount ? bibRangeStart + Math.max(0, Number(summary.expectedCount) || 0) - 1 : 0);
  const issues = [];
  if (!fs.existsSync(paths.project)) issues.push("missing project.json");
  if (!fs.existsSync(paths.state)) issues.push("missing state.json");
  if (isBatchTxtTask && !batchResults.length) issues.push("missing batch UUID results");
  if (isSqliteIngestTask && !fs.existsSync(basePaths.sqlitePath)) issues.push("missing wosData.sqlite");
  if (isBatchTxtTask) {
    for (const item of batchResults) {
      const marker = readRawUuidCompleteMarker(basePaths, item.uuid);
      if (!marker) {
        issues.push(`missing batch completion marker: ${item.uuid}`);
        continue;
      }
      const state = rawUuidDownloadState(basePaths, item.uuid, marker);
      if (!state.complete && state.plan?.missingBatches?.length) {
        const firstMissing = state.plan.missingBatches[0];
        issues.push(`incomplete batch UUID ${item.uuid}: missing ${firstMissing.sortBy ? `${firstMissing.sortBy} ` : ""}${firstMissing.markFrom}-${firstMissing.markTo}`);
      }
    }
  }
  if (isBibTask && !bibFiles.length) issues.push("missing resultsets/<uuid>/raw/bib batches");
  if (isBibTask && bibRangeEnd) {
    const plan = bibBatchPlanForRange(paths, bibUuid, bibRangeStart, bibRangeEnd, DEFAULT_BATCH_SIZE);
    if (plan.missingBatches.length) {
      const firstMissing = plan.missingBatches[0];
      issues.push(`missing raw BibTeX batch: ${firstMissing.markFrom}-${firstMissing.markTo}`);
    }
  }
  if (isImportedCsvTask && !fs.existsSync(wosidsCsv)) issues.push(`missing WOSID CSV: ${path.relative(paths.taskDir, wosidsCsv)}`);
  if (isImportedCsvTask && summary.expectedCount && summary.uniqueCount !== summary.expectedCount) {
    issues.push(`wosid count mismatch: expected=${summary.expectedCount} unique=${summary.uniqueCount}`);
  }
  if (isImportedCsvTask && summary.uniqueCount && wosids.length !== summary.uniqueCount) {
    issues.push(`WOSID CSV rows mismatch: csv=${wosids.length} summary.uniqueCount=${summary.uniqueCount}`);
  }
  if (!isBibTask && !isImportedCsvTask && !isBatchTxtTask && !isSqliteIngestTask && !rawFiles.length) issues.push("missing resultsets/<uuid>/raw/full-record batches");
  if (!isBibTask && !isImportedCsvTask && !isBatchTxtTask && !isSqliteIngestTask && Array.isArray(summary.exportWindows) && summary.exportWindows.length) {
    for (const window of summary.exportWindows) {
      const sortOptions = isLargeExportSort(window.sortBy) ? { sortBy: window.sortBy } : {};
      const plan = rawBatchPlanForRange(paths, rawUuid, window.startIndex || 1, window.endIndex || 0, DEFAULT_BATCH_SIZE, sortOptions);
      if (plan.missingBatches.length) {
        const firstMissing = plan.missingBatches[0];
        issues.push(`missing raw TXT batch: ${window.sortBy} ${firstMissing.markFrom}-${firstMissing.markTo}`);
      }
    }
  } else if (!isBibTask && !isImportedCsvTask && !isBatchTxtTask && !isSqliteIngestTask && txtRangeEnd) {
    const plan = rawBatchPlanForRange(paths, rawUuid, txtRangeStart, txtRangeEnd, DEFAULT_BATCH_SIZE);
    if (plan.missingBatches.length) {
      const firstMissing = plan.missingBatches[0];
      issues.push(`missing raw TXT batch: ${firstMissing.markFrom}-${firstMissing.markTo}`);
    }
  }
  return {
    ok: issues.length === 0,
    taskId: task.taskId,
    taskDir: task.taskDir,
    wosids: wosids.length,
    rawBatches: rawFiles.length,
    bibBatches: bibFiles.length,
    sqlite: isSqliteIngestTask ? basePaths.sqlitePath : "",
    rawDir: !isBibTask && !isImportedCsvTask && rawUuid ? rawBatchDir(paths, rawUuid) : "",
    bibDir: isBibTask && bibUuid ? bibBatchDir(paths, bibUuid) : "",
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

function queryRecordOperation(args) {
  if (args.command === "query") return `query ${args.queryCommand || ""}`.trim();
  if (args.command === "record") return `record ${args.recordCommand || ""}`.trim();
  return args.command;
}

function writeQueryRecordManifest(paths, args) {
  writeJson(paths.manifest, {
    command: "iiaide-wos",
    operation: queryRecordOperation(args),
    args: manifestArgs(args),
    task: {
      taskId: args.taskId,
      label: args.taskLabel,
      taskDir: paths.taskDir,
      tasksRoot: args.tasksRoot,
    },
    createdAt: new Date().toISOString(),
  });
}

function writeRecordCollectArtifacts(paths, args, result) {
  if (args.command !== "record" || args.recordCommand !== "collect" || !Array.isArray(result.relations)) {
    return { relations: result.relations || null, files: {} };
  }
  const sourceId = safeFilePart(args.wosId || "record");
  const relationDir = path.join(paths.taskDir, "record-relations", sourceId);
  const relations = [];
  const relationJsons = [];
  const relationCsvs = [];
  fs.mkdirSync(relationDir, { recursive: true });
  for (const relation of result.relations) {
    const rows = Array.isArray(relation.wosids) ? relation.wosids : [];
    let csvPath = "";
    if (relation.uuid) {
      const outputPaths = withRawSource(paths, relation.uuid);
      csvPath = wosIdsCsvPath(outputPaths, relation.uuid);
      writeFileAtomic(csvPath, toCsv(rows.map((row) => ({ wosid: row.wosid })), ["wosid"]));
      relationCsvs.push(csvPath);
    }
    const jsonPath = path.join(relationDir, `${safeFilePart(relation.type)}.json`);
    const payload = {
      ok: Boolean(relation.ok),
      sourceWosId: args.wosId,
      type: relation.type,
      uuid: relation.uuid || "",
      count: Number(relation.count || 0),
      pagesRequested: Number(relation.pagesRequested || args.pages || 0),
      uniqueCount: Number(relation.uniqueCount || rows.length),
      rowText: relation.rowText || "",
      error: relation.error || "",
      files: {
        wosidsCsv: csvPath,
      },
      wosids: rows.map((row, index) => ({ index: index + 1, ...row })),
      finishedAt: new Date().toISOString(),
    };
    writeJson(jsonPath, payload);
    relationJsons.push(jsonPath);
    relations.push({ ...payload, wosids: undefined });
  }
  return {
    relations,
    files: {
      relationsDir: relationDir,
      relationJsons,
      relationCsvs,
    },
  };
}

function writeQueryRecordSummary(paths, args, result) {
  const collectArtifacts = writeRecordCollectArtifacts(paths, args, result);
  const sortBy = result.sortBy || args.sortBy || "relevance";
  const summaryUrl = result.href || (result.uuid ? buildSummaryUrl(args.baseUrl, result.uuid, sortBy) : "");
  const summary = {
    ok: Boolean(result.ok),
    method: result.method || "wos-js-browser-api",
    command: args.command,
    subcommand: args.command === "query" ? args.queryCommand : args.recordCommand,
    taskId: args.taskId,
    taskLabel: args.taskLabel,
    operation: result.operation || queryRecordOperation(args),
    uuid: result.uuid || "",
    sortBy,
    summaryUrl,
    summaryHref: summaryUrl,
    cached: Boolean(result.cached),
    cachedAt: result.cachedAt || "",
    expectedCount: Number(result.count || 0),
    count: Number(result.count || 0),
    rowText: result.rowText || "",
    source: result.source || {},
    files: {
      ...collectArtifacts.files,
      progressLog: paths.progressLog,
    },
    finishedAt: new Date().toISOString(),
  };
  if (collectArtifacts.relations) summary.relations = collectArtifacts.relations;
  if (result.error) summary.error = result.error;
  writeOperationSummary(paths, summary);
  return summary;
}

function readCachedQueryBuildResult(paths, args) {
  if (args.force || args.command !== "query" || args.queryCommand !== "build" || !args.queryExpr) return null;
  const db = openWosDatabase(paths.sqlitePath);
  try {
    const cached = getLatestSuccessfulQueryBuild(db, {
      taskId: args.taskId,
      queryText: args.queryExpr,
    });
    if (!cached?.uuid) return null;
    const sortBy = cached.sortBy || args.sortBy || "relevance";
    return {
      ok: true,
      method: "wos-sqlite-cache",
      operation: "query build",
      uuid: cached.uuid,
      count: cached.count,
      rowText: cached.rowText || args.queryExpr,
      source: cached.source && Object.keys(cached.source).length
        ? cached.source
        : { kind: "expr", value: args.queryExpr },
      sortBy,
      href: buildSummaryUrl(args.baseUrl, cached.uuid, sortBy),
      cached: true,
      cachedAt: cached.createdAt || "",
    };
  } finally {
    db.close();
  }
}

function assertQueryRecordArgs(args) {
  if (args.command === "query") {
    if (!["build", "parse", "ids", "batch", "ingest"].includes(args.queryCommand)) {
      throw new CliMessageError(`Unknown query command: ${args.queryCommand || "(missing)"}`);
    }
    if (args.queryCommand === "build" && !args.queryExpr) throw new CliMessageError("Missing --expr for query build");
    if (args.queryCommand === "parse" && !args.queryText) throw new CliMessageError("Missing --text for query parse");
    if (args.queryCommand === "batch" && !args.queryExprFile && !args.queryExprs.length) {
      throw new CliMessageError("Missing query expressions for query batch. Use repeated --expr or --expr-file.");
    }
    if (args.queryCommand === "ingest" && !args.queryExpr && !args.queryText && !args.csvPath && !args.wosIds.length && !args.dois.length) {
      throw new CliMessageError("Missing query ingest input. Use --expr, --text, --wosid, --doi, or --csv.");
    }
    if (args.queryCommand === "ids" && !args.csvPath && !args.wosIds.length && !args.dois.length) {
      throw new CliMessageError("Missing query ids input. Use --wosid, --doi, or --csv.");
    }
    return;
  }
  if (args.command === "record") {
    args.wosId = args.wosIds[0] || "";
    if (!["relations", "shared", "collect", "ingest"].includes(args.recordCommand)) {
      throw new CliMessageError(`Unknown record command: ${args.recordCommand || "(missing)"}`);
    }
    if (!args.wosId) throw new CliMessageError(`Missing --wosid for record ${args.recordCommand}`);
    if ((args.recordCommand === "relations" || args.recordCommand === "ingest") && !["citations", "references", "related"].includes(args.relationType)) {
      throw new CliMessageError(`Missing or invalid --type for record ${args.recordCommand}. Use citations, references, or related.`);
    }
    if (args.recordCommand === "collect") {
      const badType = (args.relationTypes || []).find((type) => !RECORD_RELATION_TYPES.includes(type));
      if (badType) throw new CliMessageError(`Invalid --types value for record collect: ${badType}`);
      if (!Number.isInteger(args.pages) || args.pages < 1 || args.pages > 20) {
        throw new CliMessageError("Missing or invalid --pages for record collect. Use 1-20.");
      }
    }
    if (args.recordCommand === "shared" && !args.withWosId) {
      throw new CliMessageError("Missing --with for record shared");
    }
  }
}

function readQueryExprFile(filePath) {
  if (!filePath) throw new CliMessageError("Missing --expr-file for query batch");
  if (!fs.existsSync(filePath)) throw new CliMessageError(`Query expression file not found: ${filePath}`);
  return fs.readFileSync(filePath, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function readQueryBatchExpressions(args) {
  const expressions = [];
  if (args.queryExprFile) expressions.push(...readQueryExprFile(args.queryExprFile));
  for (const expr of args.queryExprs || []) {
    const text = String(expr || "").trim();
    if (text) expressions.push(text);
  }
  return expressions;
}

function queryBatchItemEnvelope(args, item) {
  return llmResult(args, {
    ok: Boolean(item.ok),
    code: item.ok ? "OK" : (item.code || "WOS_UUID_MISSING"),
    taskId: args.taskId,
    artifact: item.url || "",
    uuid: item.uuid || "",
    count: item.count || 0,
    message: item.ok
      ? (item.cached ? "WOS UUID resolved from SQLite cache" : "WOS UUID resolved")
      : (item.error || item.message || "WOS command did not return a UUID"),
    data: {
      index: item.index,
      total: item.total,
      expr: item.expr,
      queryText: item.queryText || item.rowText || item.expr || "",
      url: item.url || "",
      sortBy: item.sortBy || args.sortBy || "relevance",
      cached: Boolean(item.cached),
      cachedAt: item.cachedAt || undefined,
      operation: item.operation || "query build",
      rowText: item.rowText || "",
      source: item.source || {},
      error: item.error || undefined,
    },
  });
}

function queryBatchJsonResult(args, summary) {
  return llmResult(args, {
    ok: Boolean(summary.ok),
    code: summary.ok ? "OK" : "WOS_QUERY_FAILED",
    taskId: summary.taskId,
    count: summary.completed,
    message: summary.ok
      ? `Resolved ${summary.completed}/${summary.total} query UUIDs`
      : `Resolved ${summary.completed}/${summary.total} query UUIDs; ${summary.failed} failed`,
    data: {
      total: summary.total,
      completed: summary.completed,
      failed: summary.failed,
      inputExprFile: summary.inputExprFile,
      inputExprs: summary.inputExprs || [],
      output: "jsonl",
      results: summary.results,
      files: summary.files || {},
    },
  });
}

const INGEST_RECORD_LIMIT = 500;
const RECORD_RELATION_INGEST_PAGES = 6;
const RECORD_RELATION_EXPORT_MODE = "front-scroll-wosid";

function ingestQueryCommandFromArgs(args) {
  if (args.queryExpr) return "build";
  if (args.queryText) return "parse";
  return "ids";
}

function ingestQueryText(args, result = {}) {
  if (args.queryExpr) return args.queryExpr;
  if (args.queryText) return result.rowText || args.queryText;
  return result.rowText || queryTextForIds(args.wosIds || [], args.dois || []);
}

function semanticDescriptionForIngest(args, result = {}, kind = "normal") {
  if (args.semanticDescription) return args.semanticDescription;
  if (kind === "normal") return `WOS query ingest: ${ingestQueryText(args, result)}`.trim();
  return `${kind} of ${args.wosId || args.wosIds?.[0] || ""}`.trim();
}

async function exportIngestRecordsFromUuid(page, args, options = {}) {
  const availableCount = Math.max(0, Number(options.count) || 0);
  const requestedLimit = INGEST_RECORD_LIMIT;
  const markTo = Math.min(availableCount || requestedLimit, requestedLimit);
  const sortBy = options.sortBy || "relevance";
  if (!options.uuid) throw new Error("Missing UUID for WOS ingest export");
  if (!markTo) {
    return { records: [], requestedLimit, exportedCount: 0, textBytes: 0 };
  }
  appendProgress(options.paths, {
    phase: "wos-ingest-open-summary",
    kind: options.kind,
    uuid: options.uuid,
    sortBy,
    isRefQuery: Boolean(options.isRefQuery),
  });
  const pageInfo = await openSummaryPageForExport(page, args, { uuid: options.uuid, sortBy });
  appendProgress(options.paths, {
    phase: "wos-ingest-summary-ready",
    kind: options.kind,
    uuid: pageInfo.uuid,
    count: pageInfo.expectedCount,
    sortBy: pageInfo.sortBy || sortBy,
    href: pageInfo.href,
    isRefQuery: Boolean(options.isRefQuery),
  });
  const exportResult = await exportTxtBatchesViaWosJs(page, {
    uuid: options.uuid,
    markFrom: 1,
    markTo,
    batchSize: Math.min(DEFAULT_BATCH_SIZE, markTo),
    sortBy,
    isRefQuery: Boolean(options.isRefQuery),
    onProgress(event) {
      appendProgress(options.paths, {
        phase: "wos-ingest-export-progress",
        kind: options.kind,
        uuid: options.uuid,
        sortBy,
        isRefQuery: Boolean(options.isRefQuery),
        ...(event || {}),
        text: undefined,
      });
    },
  });
  const text = (exportResult.batches || []).map((batch) => batch.text || "").join("\n");
  return {
    records: toStandardJson(text),
    requestedLimit,
    exportedCount: markTo,
    textBytes: Buffer.byteLength(text, "utf8"),
  };
}

function recordWosId(record = {}) {
  return canonicalWosId(record?.wos_id || record?.wosid || record?.UT || "");
}

function orderedRecordsForWosIds(records = [], wosIds = []) {
  const byId = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const id = recordWosId(record);
    if (id && !byId.has(id)) byId.set(id, record);
  }
  return (Array.isArray(wosIds) ? wosIds : [])
    .map((wosid) => byId.get(canonicalWosId(wosid)))
    .filter(Boolean);
}

async function collectRelationWosIdsForIngest(page, args, options = {}) {
  const uuid = String(options.uuid || "").trim();
  if (!uuid) throw new Error("Missing relation UUID for WOSID collection");
  const pages = Array.from({ length: RECORD_RELATION_INGEST_PAGES }, (_, index) => index + 1);
  const sortBy = "relevance";
  appendProgress(options.paths, {
    phase: "record-ingest-front-scroll-start",
    type: options.kind,
    sourceWosId: options.sourceWosId || "",
    uuid,
    pages,
    sortBy,
  });
  const rows = await callBrowserApi(args, page, "results.collectWosIdsByUuidPages", [uuid, pages, sortBy]);
  const seen = new Set();
  const collected = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const wosid = canonicalWosId(row?.wosid || row);
    if (!wosid || seen.has(wosid)) continue;
    seen.add(wosid);
    collected.push({ ...row, wosid });
    if (collected.length >= INGEST_RECORD_LIMIT) break;
  }
  appendProgress(options.paths, {
    phase: "record-ingest-front-scroll-complete",
    type: options.kind,
    sourceWosId: options.sourceWosId || "",
    uuid,
    pagesRequested: pages.length,
    collectedCount: collected.length,
    sortBy,
  });
  return {
    rows: collected,
    wosIds: collected.map((row) => row.wosid),
    pagesRequested: pages.length,
    sortBy,
  };
}

async function exportIngestRecordsByWosIds(page, args, options = {}) {
  const wosIds = (Array.isArray(options.wosIds) ? options.wosIds : [])
    .map((wosid) => canonicalWosId(wosid))
    .filter(Boolean)
    .slice(0, INGEST_RECORD_LIMIT);
  if (!wosIds.length) {
    return {
      records: [],
      requestedLimit: INGEST_RECORD_LIMIT,
      exportedCount: 0,
      textBytes: 0,
      queryUuid: "",
      queryCount: 0,
    };
  }
  appendProgress(options.paths, {
    phase: "record-ingest-wosid-query-start",
    type: options.kind,
    sourceWosId: options.sourceWosId || "",
    relationUuid: options.relationUuid || "",
    wosidCount: wosIds.length,
  });
  await callBrowserApi(args, page, "query.openQueryByWosIdsOrDois", [wosIds, []]);
  const rawInfo = await callBrowserApi(args, page, "results.fetchCurrentPageInfo", [`${options.kind || "records"} WOSID query`]);
  const queryUuid = rawInfo?.uuid || rawInfo?.QueryID || "";
  if (!queryUuid) {
    throw new Error("WOSID query did not expose a UUID for relation ingest");
  }
  const queryCount = parseWosCount(rawInfo?.ref_count || rawInfo?.countText || rawInfo?.count || "");
  appendProgress(options.paths, {
    phase: "record-ingest-wosid-query-ready",
    type: options.kind,
    sourceWosId: options.sourceWosId || "",
    relationUuid: options.relationUuid || "",
    queryUuid,
    queryCount,
  });
  const exported = await exportIngestRecordsFromUuid(page, args, {
    paths: options.paths,
    kind: options.kind,
    uuid: queryUuid,
    count: queryCount || wosIds.length,
    sortBy: "relevance",
    isRefQuery: false,
  });
  return {
    ...exported,
    records: orderedRecordsForWosIds(exported.records, wosIds),
    queryUuid,
    queryCount,
  };
}

function writeWosIngestSummary(paths, args, meta = {}) {
  const startedAt = meta.startedAt || new Date().toISOString();
  const finishedAt = meta.finishedAt || new Date().toISOString();
  const sortBy = meta.sortBy || "relevance";
  const db = openWosDatabase(paths.sqlitePath);
  try {
    insertWosIngest(db, {
      runId: paths.runId,
      taskId: args.taskId,
      kind: meta.kind,
      sourceWosId: meta.sourceWosId || "",
      queryText: meta.queryText || "",
      semanticDescription: meta.semanticDescription || "",
      uuid: meta.uuid,
      isRefQuery: Boolean(meta.isRefQuery),
      sortBy,
      exportMode: meta.exportMode || "uuid-export",
      uuidDirectExport: meta.uuidDirectExport !== false,
      requestedLimit: INGEST_RECORD_LIMIT,
      availableCount: Number(meta.availableCount) || 0,
      records: meta.records || [],
      startedAt,
      finishedAt,
    });
  } finally {
    db.close();
  }
  const summary = {
    ok: true,
    method: "wos-sqlite-ingest",
    command: args.command,
    subcommand: args.command === "query" ? args.queryCommand : args.recordCommand,
    taskId: args.taskId,
    taskLabel: args.taskLabel,
    operation: meta.operation || queryRecordOperation(args),
    uuid: meta.uuid,
    kind: meta.kind,
    sourceWosId: meta.sourceWosId || "",
    queryText: meta.queryText || "",
    rowText: meta.queryText || "",
    semanticDescription: meta.semanticDescription || "",
    isRefQuery: Boolean(meta.isRefQuery),
    sortBy,
    exportMode: meta.exportMode || "uuid-export",
    uuidDirectExport: meta.uuidDirectExport !== false,
    sourceQueryUuid: meta.sourceQueryUuid || "",
    collectedPages: Number(meta.collectedPages) || 0,
    requestedLimit: INGEST_RECORD_LIMIT,
    expectedCount: Number(meta.availableCount) || 0,
    count: Number(meta.availableCount) || 0,
    ingestedCount: Array.isArray(meta.records) ? meta.records.length : 0,
    emptyResult: Boolean(meta.emptyResult),
    startedAt,
    finishedAt,
    files: {
      sqlite: paths.sqlitePath,
      progressLog: paths.progressLog,
    },
  };
  writeOperationSummary(paths, summary);
  return summary;
}

function readExistingRecordIngest(paths, args) {
  if (args.force || !fs.existsSync(paths.sqlitePath)) return null;
  const db = openWosDatabase(paths.sqlitePath);
  try {
    return findExistingRecordIngest(db, {
      taskId: args.taskId,
      kind: args.relationType,
      sourceWosId: args.wosId,
    });
  } finally {
    db.close();
  }
}

function writeReusedRecordIngestSummary(paths, args, existing = {}) {
  const now = new Date().toISOString();
  const summary = {
    ok: true,
    method: "wos-sqlite-ingest",
    command: "record",
    subcommand: "ingest",
    taskId: args.taskId,
    taskLabel: args.taskLabel,
    operation: `record ingest ${args.relationType}`,
    uuid: existing.uuid || "",
    kind: existing.kind || args.relationType,
    sourceWosId: existing.sourceWosId || canonicalWosId(args.wosId),
    queryText: existing.queryText || "",
    rowText: existing.queryText || "",
    semanticDescription: existing.semanticDescription || semanticDescriptionForIngest(args, existing, args.relationType),
    isRefQuery: true,
    sortBy: existing.sortBy || "relevance",
    exportMode: existing.exportMode || RECORD_RELATION_EXPORT_MODE,
    uuidDirectExport: existing.uuidDirectExport !== false,
    requestedLimit: INGEST_RECORD_LIMIT,
    expectedCount: Number(existing.availableCount) || 0,
    count: Number(existing.availableCount) || 0,
    ingestedCount: Number(existing.ingestedCount) || Number(existing.itemCount) || 0,
    emptyResult: (Number(existing.availableCount) || 0) === 0 && (Number(existing.ingestedCount) || Number(existing.itemCount) || 0) === 0,
    reused: true,
    reusedFromRunId: existing.sourceRunId || "",
    startedAt: now,
    finishedAt: now,
    files: {
      sqlite: paths.sqlitePath,
      progressLog: paths.progressLog,
    },
  };
  writeOperationSummary(paths, summary);
  return summary;
}

function openTaskWosDatabaseForLookup(args) {
  const task = resolveTask(args);
  const paths = getRunPaths(task.taskDir);
  if (!fs.existsSync(paths.sqlitePath)) {
    throw new CliMessageError(`Task SQLite database not found: ${paths.sqlitePath}`);
  }
  return {
    task,
    paths,
    db: openWosDatabase(paths.sqlitePath),
  };
}

function assertDbArgs(args) {
  if (!["uuid", "wosid", "list", "context", "searches", "artifacts", "runs", "timeline", "audit-html", "audit-export"].includes(args.dbCommand)) {
    throw new CliMessageError(`Unknown db command: ${args.dbCommand || "(missing)"}`);
  }
  if (args.dbCommand === "uuid" && !args.uuid) throw new CliMessageError("Missing --uuid for db uuid");
  if ((args.dbCommand === "wosid" || args.dbCommand === "context") && !args.wosIds.length) {
    throw new CliMessageError(`Missing --wosid for db ${args.dbCommand}`);
  }
  if (args.dbCommand === "list" && !args.uuid && !args.wosIds.length) {
    throw new CliMessageError("Missing input for db list. Use --uuid <uuid> or --wosid <id> --type <self|citations|references|related>.");
  }
  if (args.dbCommand === "list" && args.wosIds.length && !args.relationType) {
    throw new CliMessageError("Missing --type for db list --wosid. Use self, citations, references, or related.");
  }
  if (args.dbCommand === "context" || args.dbCommand === "list") {
    const type = normalizeRelationType(args.relationType);
    if (args.dbCommand === "context" || args.wosIds.length || type) {
      if (!["self", "citations", "references", "related"].includes(type)) {
        throw new CliMessageError(`Missing or invalid --type for db ${args.dbCommand}. Use self, citations, references, or related.`);
      }
      args.relationType = type;
    }
  }
  if (args.dbCommand === "audit-export" && args.outputFormat && !["html", "json", "both"].includes(String(args.outputFormat).toLowerCase())) {
    throw new CliMessageError("Invalid --format for db audit-export. Use html, json, or both.");
  }
}

function compactTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const part = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

function defaultAuditReportDir(taskDir) {
  return path.join(taskDir, "audit", "reports", compactTimestamp());
}

async function runAuditHtml(args) {
  const task = resolveTask(args);
  const paths = getRunPaths(task.taskDir);
  if (!fs.existsSync(paths.sqlitePath)) {
    throw new CliMessageError(`Task SQLite database not found: ${paths.sqlitePath}`);
  }
  const filters = {
    uuid: args.uuid || "",
    wosid: args.wosIds[0] || "",
    limit: args.limit || DEFAULT_AUDIT_HTML_LIMIT,
  };
  try {
    return await createAuditHtmlServer({
      taskId: task.taskId,
      projectDir: task.taskDir,
      sqlitePath: paths.sqlitePath,
      host: DEFAULT_AUDIT_HTML_HOST,
      port: Number(args.port || DEFAULT_AUDIT_HTML_PORT),
      defaultFilters: filters,
    });
  } catch (error) {
    if (error?.code === "EADDRINUSE" && Number(args.port || DEFAULT_AUDIT_HTML_PORT) === DEFAULT_AUDIT_HTML_PORT) {
      return createAuditHtmlServer({
        taskId: task.taskId,
        projectDir: task.taskDir,
        sqlitePath: paths.sqlitePath,
        host: DEFAULT_AUDIT_HTML_HOST,
        port: 0,
        defaultFilters: filters,
      });
    }
    throw error;
  }
}

function runAuditExport(args) {
  const task = resolveTask(args);
  const paths = getRunPaths(task.taskDir);
  if (!fs.existsSync(paths.sqlitePath)) {
    throw new CliMessageError(`Task SQLite database not found: ${paths.sqlitePath}`);
  }
  const format = String(args.outputFormat || "both").toLowerCase();
  const outputDir = args.reportDir || defaultAuditReportDir(task.taskDir);
  const exported = exportAuditSnapshot({
    taskId: task.taskId,
    projectDir: task.taskDir,
    sqlitePath: paths.sqlitePath,
    outputDir,
    format,
    filters: {
      uuid: args.uuid || "",
      wosid: args.wosIds[0] || "",
      limit: args.limit || DEFAULT_AUDIT_HTML_LIMIT,
    },
  });
  return {
    ok: true,
    command: "db audit-export",
    taskId: task.taskId,
    sqlite: paths.sqlitePath,
    outputDir,
    format: exported.format,
    files: exported.files,
    stats: exported.snapshot.stats || {},
    filters: exported.snapshot.filters || {},
  };
}

function dbLookupUuid(args) {
  const { task, paths, db } = openTaskWosDatabaseForLookup(args);
  try {
    const resultset = getResultsetMetadata(db, args.uuid);
    const records = resultset ? getResultsetContext(db, args.uuid, { limit: args.limit }) : [];
    return {
      ok: Boolean(resultset),
      command: "db uuid",
      taskId: task.taskId,
      sqlite: paths.sqlitePath,
      uuid: args.uuid,
      resultset,
      count: resultset?.itemCount || 0,
      records,
    };
  } finally {
    db.close();
  }
}

function dbLookupSearches(args) {
  const { task, paths, db } = openTaskWosDatabaseForLookup(args);
  try {
    const searches = getSearchQueries(db, {
      limit: args.limit,
      uuid: args.uuid,
      wosid: args.wosIds[0] || "",
    });
    return {
      ok: true,
      command: "db searches",
      taskId: task.taskId,
      sqlite: paths.sqlitePath,
      count: searches.length,
      filters: {
        uuid: args.uuid || "",
        wosid: canonicalWosId(args.wosIds[0] || ""),
        limit: Number(args.limit || 0),
      },
      searches,
    };
  } finally {
    db.close();
  }
}

function dbLookupArtifacts(args) {
  const { task, paths, db } = openTaskWosDatabaseForLookup(args);
  try {
    const artifacts = getArtifactEvents(db, {
      limit: args.limit,
      uuid: args.uuid,
    });
    return {
      ok: true,
      command: "db artifacts",
      taskId: task.taskId,
      sqlite: paths.sqlitePath,
      count: artifacts.length,
      filters: {
        uuid: args.uuid || "",
        limit: Number(args.limit || 0),
      },
      artifacts,
    };
  } finally {
    db.close();
  }
}

function dbLookupRuns(args) {
  const { task, paths, db } = openTaskWosDatabaseForLookup(args);
  try {
    const runs = getAuditRuns(db, {
      limit: args.limit,
      uuid: args.uuid,
    });
    return {
      ok: true,
      command: "db runs",
      taskId: task.taskId,
      sqlite: paths.sqlitePath,
      count: runs.length,
      filters: {
        uuid: args.uuid || "",
        limit: Number(args.limit || 0),
      },
      runs,
    };
  } finally {
    db.close();
  }
}

function dbLookupTimeline(args) {
  const { task, paths, db } = openTaskWosDatabaseForLookup(args);
  try {
    const items = getAuditTimeline(db, {
      limit: args.limit,
      uuid: args.uuid,
      wosid: args.wosIds[0] || "",
    });
    return {
      ok: true,
      command: "db timeline",
      taskId: task.taskId,
      sqlite: paths.sqlitePath,
      count: items.length,
      filters: {
        uuid: args.uuid || "",
        wosid: canonicalWosId(args.wosIds[0] || ""),
        limit: Number(args.limit || 0),
      },
      items,
    };
  } finally {
    db.close();
  }
}

function dbLookupWosId(args) {
  const { task, paths, db } = openTaskWosDatabaseForLookup(args);
  const wosid = canonicalWosId(args.wosIds[0]);
  try {
    const record = getRecordByWosId(db, wosid);
    const relations = getRelationMetadataForWosId(db, wosid);
    return {
      ok: Boolean(record || relations.length),
      command: "db wosid",
      taskId: task.taskId,
      sqlite: paths.sqlitePath,
      wosid,
      record,
      relations: {
        citations: relations.filter((item) => item.kind === "citations"),
        references: relations.filter((item) => item.kind === "references"),
        related: relations.filter((item) => item.kind === "related"),
      },
    };
  } finally {
    db.close();
  }
}

function recordSummaryForList(record = null) {
  if (!record) return null;
  return {
    wosid: record.wosid,
    doi: record.doi,
    title: record.title,
    year: record.year,
    sourceTitle: record.sourceTitle,
    authors: record.authors,
    abstract: record.abstract,
    keywords: record.keywords,
  };
}

function listPayloadFromItems(items = [], includeContext = false) {
  return items.map((item) => {
    const base = {
      position: Number(item.position) || 0,
      wosid: canonicalWosId(item.wosid || ""),
    };
    if (item.runId) base.runId = item.runId;
    if (item.observedAt) base.observedAt = item.observedAt;
    if (includeContext) base.record = recordSummaryForList(item.record);
    return base;
  });
}

function dbLookupListByUuid(args, db, task, paths) {
  const resultset = getResultsetMetadata(db, args.uuid);
  const items = resultset ? getResultsetItems(db, args.uuid, { limit: args.limit }) : [];
  return {
    ok: Boolean(resultset),
    command: "db list",
    taskId: task.taskId,
    sqlite: paths.sqlitePath,
    input: { kind: "uuid", uuid: args.uuid },
    uuid: args.uuid,
    type: resultset?.kind || "",
    resultset,
    totalCount: resultset?.itemCount || 0,
    count: items.length,
    wosids: items.map((item) => canonicalWosId(item.wosid || "")),
    items: listPayloadFromItems(items, Boolean(args.context)),
    nextAction: resultset ? "" : `Run an ingest first, for example: iiaide-wos query ingest --expr '<query>'`,
  };
}

function dbLookupListByWosId(args, db, task, paths) {
  const wosid = canonicalWosId(args.wosIds[0]);
  const type = normalizeRelationType(args.relationType);
  if (type === "self") {
    const record = getRecordByWosId(db, wosid);
    return {
      ok: Boolean(record),
      command: "db list",
      taskId: task.taskId,
      sqlite: paths.sqlitePath,
      input: { kind: "wosid", wosid, type },
      wosid,
      type,
      totalCount: record ? 1 : 0,
      count: record ? 1 : 0,
      wosids: record ? [wosid] : [],
      items: record ? [{
        position: 1,
        wosid,
        ...(args.context ? { record: recordSummaryForList(record) } : {}),
      }] : [],
      nextAction: record ? "" : `Run: iiaide-wos query ingest --wosid "${wosid}"`,
    };
  }
  const relation = getLatestRelationMetadata(db, { sourceWosId: wosid, kind: type });
  const items = relation ? getResultsetItems(db, relation.uuid, { limit: args.limit }) : [];
  return {
    ok: Boolean(relation),
    command: "db list",
    taskId: task.taskId,
    sqlite: paths.sqlitePath,
    input: { kind: "wosid", wosid, type },
    wosid,
    type,
    uuid: relation?.uuid || "",
    resultset: relation,
    totalCount: relation?.itemCount || 0,
    count: items.length,
    wosids: items.map((item) => canonicalWosId(item.wosid || "")),
    items: listPayloadFromItems(items, Boolean(args.context)),
    nextAction: relation ? "" : `Run: iiaide-wos record ingest --wosid "${wosid}" --type ${type}`,
  };
}

function dbLookupList(args) {
  const { task, paths, db } = openTaskWosDatabaseForLookup(args);
  try {
    if (args.uuid) return dbLookupListByUuid(args, db, task, paths);
    return dbLookupListByWosId(args, db, task, paths);
  } finally {
    db.close();
  }
}

function dbLookupContext(args) {
  const { task, paths, db } = openTaskWosDatabaseForLookup(args);
  const wosid = canonicalWosId(args.wosIds[0]);
  const type = normalizeRelationType(args.relationType);
  try {
    if (type === "self") {
      const record = getRecordByWosId(db, wosid);
      return {
        ok: Boolean(record),
        command: "db context",
        taskId: task.taskId,
        sqlite: paths.sqlitePath,
        wosid,
        type,
        count: record ? 1 : 0,
        records: record ? [{ position: 1, ...record }] : [],
        nextAction: record
          ? ""
          : (isSingleProjectMode(args)
            ? `Run: iiaide-wos query ingest --wosid "${wosid}"`
            : `Run: iiaide-wos query ingest --wosid "${wosid}" --task "${task.taskId}"`),
      };
    }
    const relation = getLatestRelationMetadata(db, { sourceWosId: wosid, kind: type });
    if (!relation) {
      return {
        ok: false,
        command: "db context",
        taskId: task.taskId,
        sqlite: paths.sqlitePath,
        wosid,
        type,
        count: 0,
        resultset: null,
        records: [],
        nextAction: isSingleProjectMode(args)
          ? `Run: iiaide-wos record ingest --wosid "${wosid}" --type ${type}`
          : `Run: iiaide-wos record ingest --wosid "${wosid}" --type ${type} --task "${task.taskId}"`,
      };
    }
    const records = getResultsetContext(db, relation.uuid, { limit: args.limit });
    return {
      ok: true,
      command: "db context",
      taskId: task.taskId,
      sqlite: paths.sqlitePath,
      wosid,
      type,
      uuid: relation.uuid,
      count: records.length,
      resultset: relation,
      records,
    };
  } finally {
    db.close();
  }
}

function runDbLookup(args) {
  assertDbArgs(args);
  if (args.dbCommand === "uuid") return dbLookupUuid(args);
  if (args.dbCommand === "wosid") return dbLookupWosId(args);
  if (args.dbCommand === "list") return dbLookupList(args);
  if (args.dbCommand === "searches") return dbLookupSearches(args);
  if (args.dbCommand === "artifacts") return dbLookupArtifacts(args);
  if (args.dbCommand === "runs") return dbLookupRuns(args);
  if (args.dbCommand === "timeline") return dbLookupTimeline(args);
  return dbLookupContext(args);
}

function formatDbLookup(result = {}) {
  if (result.command === "db uuid") {
    if (!result.resultset) return `UUID not found: ${result.uuid}`;
    return JSON.stringify({
      resultset: result.resultset,
      records: result.records || [],
    }, null, 2);
  }
  if (result.command === "db wosid") {
    return JSON.stringify({
      wosid: result.wosid,
      record: result.record,
      relations: result.relations,
    }, null, 2);
  }
  if (result.command === "db list") {
    return JSON.stringify({
      input: result.input || {},
      uuid: result.uuid || "",
      wosid: result.wosid || "",
      type: result.type || "",
      count: result.count || 0,
      totalCount: result.totalCount || 0,
      resultset: result.resultset || null,
      nextAction: result.nextAction || "",
      wosids: result.wosids || [],
      items: result.items || [],
    }, null, 2);
  }
  if (result.command === "db searches") {
    return JSON.stringify({
      count: result.count || 0,
      filters: result.filters || {},
      searches: localizeDisplayTimes(result.searches || []),
    }, null, 2);
  }
  if (result.command === "db artifacts") {
    return JSON.stringify({
      count: result.count || 0,
      filters: result.filters || {},
      artifacts: localizeDisplayTimes(result.artifacts || []),
    }, null, 2);
  }
  if (result.command === "db runs") {
    return JSON.stringify({
      count: result.count || 0,
      filters: result.filters || {},
      runs: localizeDisplayTimes(result.runs || []),
    }, null, 2);
  }
  if (result.command === "db timeline") {
    return JSON.stringify({
      count: result.count || 0,
      filters: result.filters || {},
      items: localizeDisplayTimes(result.items || []),
    }, null, 2);
  }
  return JSON.stringify({
    wosid: result.wosid,
    type: result.type,
    uuid: result.uuid || "",
    count: result.count || 0,
    resultset: result.resultset || null,
    nextAction: result.nextAction || "",
    records: result.records || [],
  }, null, 2);
}

async function runQueryIngest(args, dependencies = {}) {
  assertQueryRecordArgs(args);
  const startedAt = new Date().toISOString();
  const paths = createRunLayout(args);
  writeQueryRecordManifest(paths, args);
  upsertTaskIndex(args, { status: "query-ingesting", lastError: "" });
  appendProgress(paths, { phase: "query-ingest-start", limit: INGEST_RECORD_LIMIT, sortBy: "relevance" });
  const prepareSession = dependencies.prepareWosSession || prepareWosSession;
  const runner = dependencies.runQueryBrowserCommand || runQueryBrowserCommand;
  let session = null;
  try {
    session = await prepareSession(args, { report: reportForArgs(args) });
    appendProgress(paths, { phase: "sid-validated" });
    const queryCommand = ingestQueryCommandFromArgs(args);
    const itemArgs = { ...args, queryCommand, sortBy: "relevance" };
    const uuidResult = await runner(session.page, itemArgs);
    if (!uuidResult.ok || !uuidResult.uuid) {
      throw new CliMessageError(uuidResult.error || "WOS query ingest did not return a UUID");
    }
    appendProgress(paths, {
      phase: "query-ingest-uuid",
      uuid: uuidResult.uuid,
      count: uuidResult.count,
      queryCommand,
    });
    const exported = await exportIngestRecordsFromUuid(session.page, args, {
      paths,
      kind: "normal",
      uuid: uuidResult.uuid,
      count: uuidResult.count,
      sortBy: uuidResult.sortBy || "relevance",
      isRefQuery: false,
    });
    const queryText = ingestQueryText(args, uuidResult);
    const summary = writeWosIngestSummary(paths, args, {
      startedAt,
      finishedAt: new Date().toISOString(),
      operation: `query ingest ${queryCommand}`,
      kind: "normal",
      sourceWosId: "",
      queryText,
      semanticDescription: semanticDescriptionForIngest(args, uuidResult, "normal"),
      uuid: uuidResult.uuid,
      isRefQuery: false,
      sortBy: uuidResult.sortBy || "relevance",
      availableCount: uuidResult.count,
      records: exported.records,
    });
    appendProgress(paths, {
      phase: "query-ingest-complete",
      uuid: summary.uuid,
      availableCount: summary.expectedCount,
      ingestedCount: summary.ingestedCount,
      sqlite: paths.sqlitePath,
    });
    upsertTaskIndex(args, {
      status: "completed",
      lastError: "",
      uuid: summary.uuid,
      url: buildSummaryUrl(args.baseUrl, summary.uuid, summary.sortBy || "relevance"),
      expectedCount: summary.expectedCount,
      uniqueCount: summary.ingestedCount,
    });
    return summary;
  } finally {
    await session?.close?.();
  }
}

async function runRecordIngest(args, dependencies = {}) {
  assertQueryRecordArgs(args);
  const startedAt = new Date().toISOString();
  const paths = createRunLayout(args);
  writeQueryRecordManifest(paths, args);
  upsertTaskIndex(args, { status: "record-ingesting", lastError: "" });
  appendProgress(paths, { phase: "record-ingest-start", type: args.relationType, limit: INGEST_RECORD_LIMIT, sortBy: "relevance" });
  const existing = readExistingRecordIngest(paths, args);
  if (existing) {
    appendProgress(paths, {
      phase: "record-ingest-reuse-sqlite",
      type: args.relationType,
      sourceWosId: canonicalWosId(args.wosId),
      uuid: existing.uuid,
      sourceRunId: existing.sourceRunId,
      ingestedCount: existing.ingestedCount,
    });
    const summary = writeReusedRecordIngestSummary(paths, args, existing);
    upsertTaskIndex(args, {
      status: "completed",
      lastError: "",
      uuid: summary.uuid,
      url: buildSummaryUrl(args.baseUrl, summary.uuid, summary.sortBy || "relevance"),
      expectedCount: summary.expectedCount,
      uniqueCount: summary.ingestedCount,
    });
    return summary;
  }
  const prepareSession = dependencies.prepareWosSession || prepareWosSession;
  const runner = dependencies.runRecordBrowserCommand || runRecordBrowserCommand;
  let session = null;
  try {
    session = await prepareSession(args, { report: reportForArgs(args) });
    appendProgress(paths, { phase: "sid-validated" });
    const relationArgs = { ...args, recordCommand: "relations", sortBy: "relevance" };
    const uuidResult = await runner(session.page, relationArgs);
    if (!uuidResult.ok || !uuidResult.uuid) {
      throw new CliMessageError(uuidResult.error || "WOS record ingest did not return a relation UUID");
    }
    appendProgress(paths, {
      phase: "record-ingest-uuid",
      type: args.relationType,
      sourceWosId: args.wosId,
      uuid: uuidResult.uuid,
      count: uuidResult.count,
    });
    const relationCount = Number(uuidResult.count);
    if (Number.isFinite(relationCount) && relationCount === 0) {
      const summary = writeWosIngestSummary(paths, args, {
        startedAt,
        finishedAt: new Date().toISOString(),
        operation: `record ingest ${args.relationType}`,
        kind: args.relationType,
        sourceWosId: args.wosId,
        queryText: uuidResult.rowText || "",
        semanticDescription: semanticDescriptionForIngest(args, uuidResult, args.relationType),
        uuid: uuidResult.uuid,
        isRefQuery: true,
        sortBy: "relevance",
        exportMode: RECORD_RELATION_EXPORT_MODE,
        uuidDirectExport: false,
        collectedPages: 0,
        availableCount: 0,
        records: [],
        emptyResult: true,
      });
      appendProgress(paths, {
        phase: "record-ingest-empty-result",
        type: args.relationType,
        sourceWosId: args.wosId,
        uuid: summary.uuid,
        availableCount: 0,
        ingestedCount: 0,
        sqlite: paths.sqlitePath,
      });
      upsertTaskIndex(args, {
        status: "completed",
        lastError: "",
        uuid: summary.uuid,
        url: buildSummaryUrl(args.baseUrl, summary.uuid, summary.sortBy || "relevance"),
        expectedCount: 0,
        uniqueCount: 0,
      });
      return summary;
    }
    const collectWosIds = dependencies.collectRelationWosIdsForIngest || collectRelationWosIdsForIngest;
    const exportByWosIds = dependencies.exportIngestRecordsByWosIds || exportIngestRecordsByWosIds;
    const collected = await collectWosIds(session.page, args, {
      paths,
      kind: args.relationType,
      sourceWosId: args.wosId,
      uuid: uuidResult.uuid,
    });
    if (!collected.wosIds.length) {
      const summary = writeWosIngestSummary(paths, args, {
        startedAt,
        finishedAt: new Date().toISOString(),
        operation: `record ingest ${args.relationType}`,
        kind: args.relationType,
        sourceWosId: args.wosId,
        queryText: uuidResult.rowText || "",
        semanticDescription: semanticDescriptionForIngest(args, uuidResult, args.relationType),
        uuid: uuidResult.uuid,
        isRefQuery: true,
        sortBy: "relevance",
        exportMode: RECORD_RELATION_EXPORT_MODE,
        uuidDirectExport: false,
        collectedPages: collected.pagesRequested,
        availableCount: 0,
        records: [],
        emptyResult: true,
      });
      appendProgress(paths, {
        phase: "record-ingest-empty-result",
        type: args.relationType,
        sourceWosId: args.wosId,
        uuid: summary.uuid,
        availableCount: 0,
        collectedPages: collected.pagesRequested,
        ingestedCount: 0,
        sqlite: paths.sqlitePath,
      });
      upsertTaskIndex(args, {
        status: "completed",
        lastError: "",
        uuid: summary.uuid,
        url: buildSummaryUrl(args.baseUrl, summary.uuid, summary.sortBy || "relevance"),
        expectedCount: 0,
        uniqueCount: 0,
      });
      return summary;
    }
    const exported = await exportByWosIds(session.page, args, {
      paths,
      kind: args.relationType,
      sourceWosId: args.wosId,
      relationUuid: uuidResult.uuid,
      wosIds: collected.wosIds,
    });
    const summary = writeWosIngestSummary(paths, args, {
      startedAt,
      finishedAt: new Date().toISOString(),
      operation: `record ingest ${args.relationType}`,
      kind: args.relationType,
      sourceWosId: args.wosId,
      queryText: uuidResult.rowText || "",
      semanticDescription: semanticDescriptionForIngest(args, uuidResult, args.relationType),
      uuid: uuidResult.uuid,
      isRefQuery: true,
      sortBy: "relevance",
      exportMode: RECORD_RELATION_EXPORT_MODE,
      uuidDirectExport: false,
      sourceQueryUuid: exported.queryUuid || "",
      collectedPages: collected.pagesRequested,
      availableCount: uuidResult.count,
      records: exported.records,
    });
    appendProgress(paths, {
      phase: "record-ingest-complete",
      type: args.relationType,
      sourceWosId: args.wosId,
      uuid: summary.uuid,
      availableCount: summary.expectedCount,
      ingestedCount: summary.ingestedCount,
      sqlite: paths.sqlitePath,
    });
    upsertTaskIndex(args, {
      status: "completed",
      lastError: "",
      uuid: summary.uuid,
      url: buildSummaryUrl(args.baseUrl, summary.uuid, summary.sortBy || "relevance"),
      expectedCount: summary.expectedCount,
      uniqueCount: summary.ingestedCount,
    });
    return summary;
  } finally {
    await session?.close?.();
  }
}

async function runQueryBatch(args, dependencies = {}) {
  assertQueryRecordArgs(args);
  const debug = debugForArgs(args);
  const expressions = readQueryBatchExpressions(args);
  if (!expressions.length) {
    const source = args.queryExprFile ? `--expr-file: ${args.queryExprFile}` : "repeated --expr";
    throw new CliMessageError(`No query expressions found in ${source}`);
  }

  const initialPaths = getRunPaths(args.outDir);
  const outputHasFiles = fs.existsSync(args.outDir) &&
    fs.readdirSync(args.outDir).some((name) => name !== ".DS_Store");
  if (args.force && outputHasFiles) cleanRunLayout(initialPaths);
  const paths = createRunLayout(args);
  writeQueryRecordManifest(paths, args);
  upsertTaskIndex(args, { status: "query-running", lastError: "" });
  appendProgress(paths, {
    phase: "query-batch-start",
    inputExprFile: args.queryExprFile,
    inputExprs: args.queryExprs || [],
    total: expressions.length,
  });

  const writeStdout = dependencies.writeStdout || ((line) => console.log(line));
  const writeStderr = dependencies.writeStderr || ((line) => console.error(line));
  const prepareSession = dependencies.prepareWosSession || prepareWosSession;
  const runner = dependencies.runQueryBrowserCommand || runQueryBrowserCommand;
  const results = [];
  let session = null;
  try {
    for (let index = 0; index < expressions.length; index += 1) {
      const expr = expressions[index];
      const itemArgs = {
        ...args,
        queryCommand: "build",
        queryExpr: expr,
      };
      let item;
      try {
        const cachedResult = readCachedQueryBuildResult(paths, itemArgs);
        if (cachedResult) {
          debug("query batch: using cached SQLite result", {
            index: index + 1,
            total: expressions.length,
            uuid: cachedResult.uuid,
            count: cachedResult.count,
            cachedAt: cachedResult.cachedAt,
          });
          item = {
            index: index + 1,
            total: expressions.length,
            expr,
            ok: true,
            uuid: cachedResult.uuid || "",
            url: cachedResult.href || "",
            count: Number(cachedResult.count || 0),
            queryText: cachedResult.rowText || expr,
            rowText: cachedResult.rowText || expr,
            source: cachedResult.source || { kind: "expr", value: expr },
            sortBy: cachedResult.sortBy || args.sortBy || "relevance",
            cached: true,
            cachedAt: cachedResult.cachedAt || "",
            operation: cachedResult.operation || "query build",
            error: "",
            code: "OK",
          };
        } else {
          if (!session) {
            debug("query batch: preparing WOS session", { total: expressions.length });
            session = await prepareSession(args, { report: reportForArgs(args) });
            debug("query batch: WOS session ready");
            appendProgress(paths, { phase: "sid-validated" });
          }
          debug("query batch: running item", { index: index + 1, total: expressions.length, expr });
          const result = await runner(session.page, itemArgs);
          const sortBy = result.sortBy || args.sortBy || "relevance";
          item = {
            index: index + 1,
            total: expressions.length,
            expr,
            ok: Boolean(result.ok),
            uuid: result.uuid || "",
            url: result.href || (result.uuid ? buildSummaryUrl(args.baseUrl, result.uuid, sortBy) : ""),
            count: Number(result.count || 0),
            queryText: result.rowText || expr,
            rowText: result.rowText || "",
            source: result.source || { kind: "expr", value: expr },
            sortBy,
            cached: false,
            operation: result.operation || "query build",
            error: result.error || "",
            code: result.ok ? "OK" : "WOS_UUID_MISSING",
          };
        }
      } catch (error) {
        const envelope = llmErrorResult(itemArgs, error);
        item = {
          index: index + 1,
          total: expressions.length,
          expr,
          ok: false,
          uuid: "",
          url: "",
          count: 0,
          queryText: expr,
          rowText: expr,
          source: { kind: "expr", value: expr },
          sortBy: args.sortBy || "relevance",
          cached: false,
          operation: "query build",
          error: envelope.message,
          code: envelope.code,
        };
      }
      results.push(item);
      appendProgress(paths, {
        phase: item.ok ? "query-batch-item-complete" : "query-batch-item-failed",
        index: item.index,
        total: item.total,
        uuid: item.uuid,
        url: item.url,
        count: item.count,
        cached: Boolean(item.cached),
        ok: item.ok,
        error: item.error || "",
      });
      if (!args.json) writeStdout(JSON.stringify(queryBatchItemEnvelope(args, item)));
      if (!item.ok) writeStderr(`Query ${item.index}/${item.total} failed: ${item.error || "WOS command did not return a UUID"}`);
    }

    const completed = results.filter((item) => item.ok).length;
    const failed = results.length - completed;
    const summary = {
      ok: failed === 0,
      method: "wos-js-query-batch",
      command: "query",
      subcommand: "batch",
      taskId: args.taskId,
      taskLabel: args.taskLabel,
      inputExprFile: args.queryExprFile,
      inputExprs: args.queryExprs || [],
      total: expressions.length,
      completed,
      failed,
      results,
      files: {
        progressLog: paths.progressLog,
      },
      finishedAt: new Date().toISOString(),
    };
    writeOperationSummary(paths, summary);
    appendProgress(paths, {
      phase: "query-batch-complete",
      ok: summary.ok,
      total: summary.total,
      completed: summary.completed,
      failed: summary.failed,
    });
    const firstUuid = results.find((item) => item.ok)?.uuid || "";
    upsertTaskIndex(args, {
      status: summary.ok ? "completed" : "failed",
      lastError: summary.ok ? "" : `${failed} query batch item(s) failed`,
      uuid: firstUuid,
      url: firstUuid ? buildSummaryUrl(args.baseUrl, firstUuid, args.sortBy) : "",
      expectedCount: summary.total,
      uniqueCount: summary.completed,
    });
    return summary;
  } finally {
    await session?.close?.();
  }
}

async function runQueryRecord(args, dependencies = {}) {
  assertQueryRecordArgs(args);
  const debug = debugForArgs(args);
  const initialPaths = getRunPaths(args.outDir);
  const outputHasFiles = fs.existsSync(args.outDir) &&
    fs.readdirSync(args.outDir).some((name) => name !== ".DS_Store");
  if (args.force && outputHasFiles) cleanRunLayout(initialPaths);
  const paths = createRunLayout(args);
  writeQueryRecordManifest(paths, args);
  upsertTaskIndex(args, { status: `${args.command}-running`, lastError: "" });
  appendProgress(paths, { phase: `${args.command}-start`, operation: queryRecordOperation(args) });

  const cachedResult = readCachedQueryBuildResult(paths, args);
  if (cachedResult) {
    debug("query build: using cached SQLite result", {
      uuid: cachedResult.uuid,
      count: cachedResult.count,
      cachedAt: cachedResult.cachedAt,
    });
    appendProgress(paths, {
      phase: "query-cache-hit",
      uuid: cachedResult.uuid,
      count: cachedResult.count,
      cachedAt: cachedResult.cachedAt,
    });
    const summary = writeQueryRecordSummary(paths, args, cachedResult);
    appendProgress(paths, {
      phase: `${args.command}-complete`,
      uuid: summary.uuid,
      count: summary.count,
      ok: summary.ok,
      cached: true,
    });
    upsertTaskIndex(args, {
      status: "completed",
      lastError: "",
      uuid: summary.uuid,
      url: summary.summaryUrl || buildSummaryUrl(args.baseUrl, summary.uuid, summary.sortBy || args.sortBy),
      expectedCount: summary.count,
      uniqueCount: summary.count,
    });
    return summary;
  }

  let session = null;
  try {
    const prepareSession = dependencies.prepareWosSession || prepareWosSession;
    debug(`${args.command}: preparing WOS session`, { operation: queryRecordOperation(args) });
    session = await prepareSession(args, { report: reportForArgs(args) });
    debug(`${args.command}: WOS session ready`);
    appendProgress(paths, { phase: "sid-validated" });
    const runner = args.command === "query"
      ? (dependencies.runQueryBrowserCommand || runQueryBrowserCommand)
      : (dependencies.runRecordBrowserCommand || runRecordBrowserCommand);
    debug(`${args.command}: running browser command`, { operation: queryRecordOperation(args) });
    const result = await runner(session.page, args);
    debug(`${args.command}: browser command complete`, { ok: result.ok, uuid: result.uuid, count: result.count });
    const summary = writeQueryRecordSummary(paths, args, result);
    appendProgress(paths, {
      phase: `${args.command}-complete`,
      uuid: summary.uuid,
      count: summary.count,
      ok: summary.ok,
    });
    upsertTaskIndex(args, {
      status: summary.ok ? "completed" : "failed",
      lastError: summary.ok ? "" : (summary.error || "WOS command did not return a UUID"),
      uuid: summary.uuid,
      url: summary.uuid ? buildSummaryUrl(args.baseUrl, summary.uuid, args.sortBy) : "",
      expectedCount: summary.count,
      uniqueCount: summary.count,
    });
    if (!summary.ok) throw new CliMessageError(summary.error || "WOS command did not return a UUID");
    return summary;
  } finally {
    await session?.close?.();
  }
}

async function run(args) {
  const initialPaths = getRunPaths(args.outDir);
  const completedSummary = !args.force ? readCompletedRunSummary(initialPaths, args) : null;
  if (completedSummary) {
    if (!args.quiet) console.error("WOS raw TXT batches already exist; skipping download.");
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
    largeExport: Boolean(priorSummary.largeExport),
    limitedByWosWindow: Boolean(priorSummary.limitedByWosWindow),
    incompleteBeyondWosLimit: Boolean(priorSummary.incompleteBeyondWosLimit),
    exportIsRefQuery: Boolean(priorSummary.exportIsRefQuery),
    exportWindows: Array.isArray(priorSummary.exportWindows) ? priorSummary.exportWindows : [],
    href: priorSummary.summaryHref || args.url,
    rowText: priorSummary.rowText || "",
  };
  if (!info.rangeEnd && info.expectedCount) {
    info.rangeEnd = (info.rangeStart || 1) + info.expectedCount - 1;
  }
  const priorRawState = rawUuid ? rawUuidDownloadState(paths, rawUuid, info) : { complete: false, plan: null };
  const canRepairFromRaw = !args.force &&
    rawUuid &&
    rawBatchFiles(paths, rawUuid).length &&
    (priorRawState.complete || canRepairWosIdsFromRaw(paths, rawUuid, info.expectedCount, info.rangeStart, info.rangeEnd));

  if (((args.reuseRaw && !priorRunFailed && !priorRunUnverifiedPartial) || canRepairFromRaw) && rawUuid && rawBatchFiles(paths, rawUuid).length) {
    info.uuid = rawUuid;
    if (!info.expectedCount) {
      throw new Error("Cannot reuse raw batches without a known WOS record count. Re-run without --reuse-raw to refresh from WOS.");
    }
    const expectedEnd = info.rangeEnd || (info.rangeStart || 1) + info.expectedCount - 1;
    const state = rawUuidDownloadState(paths, rawUuid, info);
    const flatPlan = state.plan?.exportWindows ? null : rawBatchPlanForRange(paths, rawUuid, info.rangeStart || 1, expectedEnd, DEFAULT_BATCH_SIZE);
    const plan = state.plan || flatPlan;
    const presentFiles = state.plan?.exportWindows
      ? state.plan.exportWindows.reduce((total, window) => total + window.plan.presentFiles.length, 0)
      : plan.presentFiles.length;
    if (!presentFiles) throw new Error(`No raw batches found for UUID: ${rawUuid}`);
    if (!state.complete) {
      const firstMissing = plan.missingBatches[0];
      throw new Error(
        `Incomplete raw batches for UUID ${rawUuid}: missing ${firstMissing.sortBy ? `${firstMissing.sortBy} ` : ""}${firstMissing.markFrom}-${firstMissing.markTo}, expected ${info.rangeStart || 1}-${expectedEnd}. Re-run without --reuse-raw to resume from WOS.`
      );
    }
    info.resumedCount = state.plan?.exportWindows
      ? state.plan.exportWindows.reduce((total, window) => total + window.plan.coveredCount, 0)
      : plan.coveredCount;
    appendProgress(paths, {
      phase: canRepairFromRaw && !args.reuseRaw ? "repair-run-from-raw" : "reuse-raw",
      uuid: rawUuid,
      rawDir: rawBatchDir(paths, rawUuid),
      batches: presentFiles,
      coveredCount: info.resumedCount,
      exportWindows: info.exportWindows,
    });
    if (!isInteractive()) {
      if (!args.quiet) {
        console.error(args.reuseRaw
          ? "WOS raw TXT batches already cover the selected range."
          : "WOS raw TXT batches already exist; marking task complete from raw batches.");
      }
    }
  } else {
    await prepareWosExport(args);
    const result = await exportFromWos(args, paths);
    info = result.info;
  }

  const summary = writeRunSummary(paths, {
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
    largeExport: Boolean(info.largeExport),
    limitedByWosWindow: Boolean(info.limitedByWosWindow),
    incompleteBeyondWosLimit: Boolean(info.incompleteBeyondWosLimit),
    exportIsRefQuery: Boolean(info.exportIsRefQuery),
    exportWindows: Array.isArray(info.exportWindows) ? info.exportWindows : [],
    rowText: info.rowText || "",
    summaryHref: info.href || args.url,
    runDir: paths.runDir,
  });
  writeRawUuidCompleteMarker(paths, summary);
  upsertTaskIndex(args, {
    status: summary.ok ? "completed" : "incomplete",
    lastError: "",
    uuid: summary.uuid,
    url: summary.inputUrl,
    expectedCount: summary.expectedCount,
    uniqueCount: 0,
  });
  return summary;
}

async function runBib(args) {
  const initialPaths = getRunPaths(args.outDir);
  const completedSummary = !args.force ? readCompletedBibSummary(initialPaths, args) : null;
  if (completedSummary) {
    console.error("BibTeX raw batches already exist; skipping download.");
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
  const priorRangeStart = Math.max(1, Number(priorSummary.fromIndex) || Number(priorSummary.rangeStart) || 1);
  const priorExpectedEnd = priorSummary.rangeEnd ||
    (priorSummary.expectedCount ? priorRangeStart + Math.max(0, Number(priorSummary.expectedCount) || 0) - 1 : 0);
  const priorBibPlan = rawUuid && priorExpectedEnd
    ? bibBatchPlanForRange(paths, rawUuid, priorRangeStart, priorExpectedEnd, DEFAULT_BATCH_SIZE)
    : null;
  if (!args.force && rawUuid && rawBibFiles.length && priorBibPlan?.complete) {
    const summary = {
      ok: true,
      method: "wos-js-export-fetchBibBatches",
      taskId: args.taskId,
      taskLabel: args.taskLabel,
      inputUrl: args.url,
      inputUuid: args.uuid,
      uuid: rawUuid,
      sortBy: args.sortBy,
      expectedCount: priorSummary.expectedCount || priorBibPlan.coveredCount,
      batchCount: rawBibFiles.length,
      rowText: priorSummary.rowText || "",
      summaryHref: priorSummary.summaryHref || args.url,
      runDir: paths.runDir,
      fromIndex: priorRangeStart,
      rangeStart: priorRangeStart,
      rangeEnd: priorExpectedEnd,
      resumedCount: priorBibPlan.coveredCount,
      files: {
        bibFiles: rawBibFiles,
        bibDir: bibBatchDir(paths, rawUuid),
        progressLog: paths.progressLog,
      },
      finishedAt: new Date().toISOString(),
    };
    appendProgress(paths, { phase: "repair-bib-from-raw", uuid: rawUuid, bibDir: bibBatchDir(paths, rawUuid), batches: rawBibFiles.length });
    writeOperationSummary(paths, summary);
    upsertTaskIndex(args, {
      status: "bib-completed",
      lastError: "",
      uuid: summary.uuid,
      url: summary.inputUrl,
      expectedCount: summary.expectedCount,
      uniqueCount: 0,
    });
    if (!isInteractive()) console.error("WOS raw BibTeX batches already exist; marking task complete from raw batches.");
    return summary;
  }
  await prepareWosExport(args);
  const result = await exportBibFromWos(args, paths);
  const uuid = result.info.uuid || args.uuid;
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
    fromIndex: result.info.fromIndex || args.fromIndex || 1,
    rangeStart: result.info.rangeStart || args.fromIndex || 1,
    rangeEnd: result.info.rangeEnd || result.info.expectedCount || 0,
    resumedCount: result.info.resumedCount || 0,
    files: {
      bibFiles: result.files,
      bibDir: bibBatchDir(paths, uuid),
      progressLog: paths.progressLog,
    },
    finishedAt: new Date().toISOString(),
  };
  writeOperationSummary(paths, summary);
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

function listTasks(args) {
  if (isSingleProjectMode(args)) {
    const task = createTaskPlaceholder(args, args.taskId);
    return {
      rows: [task],
      columns: ["updatedAt", "status", "taskId", "uniqueCount", "expectedCount", "label", "uuid"],
    };
  }
  const index = readTaskIndex(args.tasksRoot);
  const rows = Array.isArray(index.tasks) ? index.tasks : [];
  const columns = ["updatedAt", "status", "taskId", "uniqueCount", "expectedCount", "label", "uuid"];
  if (!rows.length) {
    return { rows, columns };
  }
  return { rows, columns };
}

function taskNameRows(args) {
  if (isSingleProjectMode(args)) {
    const task = createTaskPlaceholder(args, args.taskId);
    return [{
      taskId: task.taskId,
      status: task.status || "",
      updatedAt: task.updatedAt || "",
      label: task.label || "",
      uuid: task.uuid || "",
    }];
  }
  const index = readTaskIndex(args.tasksRoot);
  const byId = new Map();
  for (const task of Array.isArray(index.tasks) ? index.tasks : []) {
    if (task?.taskId) byId.set(task.taskId, task);
  }
  for (const task of discoverManagedTaskEntries(args.tasksRoot)) {
    if (task?.taskId) byId.set(task.taskId, { ...byId.get(task.taskId), ...task });
  }
  return Array.from(byId.values())
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .map((task) => ({
      taskId: task.taskId,
      status: task.status || "",
      updatedAt: task.updatedAt || "",
      label: task.label || "",
      uuid: task.uuid || "",
    }));
}

function listTaskNames(args) {
  const rows = taskNameRows(args);
  return {
    ok: true,
    tasksRoot: args.tasksRoot,
    count: rows.length,
    taskIds: rows.map((task) => task.taskId),
    tasks: rows,
  };
}

function showTask(args) {
  const task = resolveTask(args);
  const summaryPath = path.join(task.taskDir, "state.json");
  const summary = readJson(summaryPath, null);
  return { task, summary };
}

function taskPathResult(args) {
  const task = resolveTask(args);
  return task;
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
    if (args.json) printJsonResult(llmResult(args, {
      ok: true,
      code: "OK",
      message: formatAuthMonitorResult(result),
      data: safeAuthResult(result),
    }));
    else console.log(formatAuthMonitorResult(result));
    return 0;
  }
  const result = await runAuthLogin(args, dependencies, options);
  if (args.json) printJsonResult(llmResult(args, {
    ok: true,
    code: "OK",
    message: formatAuthLoginResult(result),
    data: safeAuthResult(result),
  }));
  else console.log(formatAuthLoginResult(result));
  return 0;
}

async function validateAndSaveSid(args) {
  const spinner = createSpinner(authValidationMessage(args, "Validating and saving WOS SID"));
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
  const poolStatus = sidPoolFromConfig(readSidConfig(args));
  const checkingSid = args.sid || process.env.WOS_SID || poolStatus.activeSid || "";
  if (checkingSid) report(authValidationMessage({ ...args, sid: checkingSid, sidSource: args.sidSource || (checkingSid === poolStatus.activeSid ? "config" : "") }));
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

function printJsonResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

function queryRecordJsonResult(args, summary) {
  return llmResult(args, {
    ok: Boolean(summary.ok),
    code: summary.ok ? "OK" : "WOS_UUID_MISSING",
    taskId: summary.taskId,
    uuid: summary.uuid,
    count: summary.ingestedCount ?? summary.count,
    message: summary.method === "wos-sqlite-ingest"
      ? `Ingested ${summary.ingestedCount || 0} WOS records into SQLite`
      : summary.method === "wos-sqlite-cache"
        ? "WOS UUID resolved from SQLite cache"
      : (summary.ok ? "WOS UUID resolved" : (summary.error || "WOS command did not return a UUID")),
    data: {
      operation: summary.operation,
      rowText: summary.rowText,
      summaryUrl: summary.summaryUrl,
      sortBy: summary.sortBy,
      cached: Boolean(summary.cached),
      cachedAt: summary.cachedAt || undefined,
      source: summary.source,
      kind: summary.kind || undefined,
      isRefQuery: summary.isRefQuery,
      requestedLimit: summary.requestedLimit,
      ingestedCount: summary.ingestedCount,
      emptyResult: Boolean(summary.emptyResult),
      relations: summary.relations || undefined,
      summary: summary.files || {},
    },
  });
}

function formatQueryBuildOutput(args, summary) {
  const sortBy = summary.sortBy || args.sortBy || "relevance";
  const summaryUrl = summary.summaryUrl || (summary.uuid ? buildSummaryUrl(args.baseUrl, summary.uuid, sortBy) : "");
  const count = Number.isFinite(Number(summary.count)) ? Number(summary.count) : Number(summary.expectedCount || 0);
  return JSON.stringify({
    uuid: summary.uuid || "",
    url: summaryUrl,
    count,
    queryText: summary.rowText || args.queryExpr || "",
    cached: Boolean(summary.cached),
  });
}

function formatQueryRecordOutput(args, summary) {
  if (args.command === "query" && args.queryCommand === "build") {
    return formatQueryBuildOutput(args, summary);
  }
  if (args.command === "record" && args.recordCommand === "collect") {
    return summary.files?.relationsDir || summary.uuid;
  }
  return summary.uuid;
}

function artifactJsonResult(args, summary, artifact, message = "Artifact ready") {
  return llmResult(args, {
    ok: Boolean(summary?.ok !== false),
    taskId: summary?.taskId || args.taskId,
    artifact,
    uuid: summary?.uuid || args.uuid || "",
    count: summary?.expectedCount || summary?.uniqueCount || summary?.count || 0,
    message,
    data: {
      method: summary?.method || "",
      files: summary?.files || {},
      rowText: summary?.rowText || "",
    },
  });
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
    const result = listTasks(args);
    if (args.json) {
      printJsonResult(llmResult(args, {
        ok: true,
        message: result.rows.length ? (isSingleProjectMode(args) ? "Project listed" : "Tasks listed") : (isSingleProjectMode(args) ? "No project" : "No tasks"),
        count: result.rows.length,
        data: {
          tasksRoot: args.tasksRoot,
          columns: result.columns,
          tasks: result.rows,
        },
      }));
    } else if (!result.rows.length) {
      console.log(isSingleProjectMode(args) ? `No project in ${args.tasksRoot}` : `No tasks in ${args.tasksRoot}`);
    } else {
      console.log(toCsv(result.rows, result.columns).trim());
    }
    return 0;
  }
  if (args.command === "tasks") {
    const result = listTaskNames(args);
    if (args.json) {
      printJsonResult(llmResult(args, {
        ok: true,
        message: result.count ? (isSingleProjectMode(args) ? "Project listed" : "Task names listed") : (isSingleProjectMode(args) ? "No project" : "No tasks"),
        count: result.count,
        data: result,
      }));
    } else {
      console.log(result.taskIds.join("\n"));
    }
    return 0;
  }
  if (args.command === "init") {
    console.log(JSON.stringify(initializeWorkspace(args), null, 2));
    return 0;
  }
  if (args.command === "check") {
    const result = await checkSid(args);
    if (args.json) {
      printJsonResult(llmResult(args, {
        ok: Boolean(result.ok),
        code: result.ok ? "OK" : "SID_INVALID",
        message: result.message || formatCheckSidResult(result),
        data: result,
      }));
    } else {
      console.log(formatCheckSidResult(result));
    }
    return 0;
  }
  if (args.command === "auth") {
    return executeAuthCommand(args);
  }
  if (args.command === "db") {
    if (args.dbCommand === "audit-html") {
      const auditServer = await runAuditHtml(args);
      const payload = {
        ok: true,
        command: "db audit-html",
        taskId: args.taskId,
        artifact: path.join(args.outDir, "wosData.sqlite"),
        count: 0,
        message: "Audit HTML server started",
        data: {
          host: auditServer.host,
          port: auditServer.port,
          url: auditServer.url,
          sqlite: path.join(args.outDir, "wosData.sqlite"),
          filters: {
            uuid: args.uuid || "",
            wosid: canonicalWosId(args.wosIds[0] || ""),
            limit: args.limit || DEFAULT_AUDIT_HTML_LIMIT,
          },
        },
      };
      if (args.json) printJsonResult(payload);
      else console.log(auditServer.url);
      return await new Promise((resolve) => {
        const stop = () => {
          auditServer.server.close(() => resolve(0));
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    }
    if (args.dbCommand === "audit-export") {
      const result = runAuditExport(args);
      if (args.json) {
        printJsonResult(llmResult(args, {
          ok: true,
          code: "OK",
          command: "db audit-export",
          taskId: result.taskId,
          artifact: result.outputDir,
          message: "Audit snapshot exported",
          data: result,
        }));
      } else {
        console.log(result.outputDir);
      }
      return 0;
    }
    const result = runDbLookup(args);
    if (args.json) {
      printJsonResult(llmResult(args, {
        ok: Boolean(result.ok),
        code: result.ok ? "OK" : "SQLITE_LOOKUP_EMPTY",
        taskId: result.taskId,
        artifact: result.sqlite,
        uuid: result.uuid || result.resultset?.uuid || "",
        count: result.count || result.resultset?.itemCount || 0,
        message: result.ok ? "SQLite lookup complete" : (result.nextAction || "SQLite lookup found no rows"),
        data: result,
      }));
    } else {
      console.log(formatDbLookup(result));
    }
    return result.ok ? 0 : 1;
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
    if (args.playwrightVisible === null && !args.addSidInputs.length && !args.clearSids && !args.clearDeadSids) {
      console.error(usage());
      return 2;
    }
    const result = { ok: true, config: configPath(args.tasksRoot) };
    if (args.playwrightVisible !== null) {
      Object.assign(result, setPlaywrightVisibleSetting(args, args.playwrightVisible));
    }
    if (args.clearSids) {
      result.clearedSids = clearSavedSidConfig(args);
    }
    if (args.clearDeadSids) {
      result.clearedDeadSids = clearDeadSidHistory(args);
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
  if (args.command === "query" || args.command === "record") {
    if (!args.taskId || !args.outDir) {
      console.error(usage());
      return 2;
    }
    if (args.command === "query" && args.queryCommand === "ingest") {
      const summary = await runQueryIngest(args);
      const result = queryRecordJsonResult(args, summary);
      console.log(args.json ? JSON.stringify(result, null, 2) : summary.files?.sqlite);
      return summary.ok ? 0 : 1;
    }
    if (args.command === "record" && args.recordCommand === "ingest") {
      const summary = await runRecordIngest(args);
      const result = queryRecordJsonResult(args, summary);
      console.log(args.json ? JSON.stringify(result, null, 2) : summary.files?.sqlite);
      return summary.ok ? 0 : 1;
    }
    if (args.command === "query" && args.queryCommand === "batch") {
      const summary = await runQueryBatch(args);
      if (args.json) printJsonResult(queryBatchJsonResult(args, summary));
      return summary.ok ? 0 : 1;
    }
    const summary = await runQueryRecord(args);
    const result = queryRecordJsonResult(args, summary);
    const output = formatQueryRecordOutput(args, summary);
    console.log(args.json ? JSON.stringify(result, null, 2) : output);
    return summary.ok ? 0 : 1;
  }
  if (args.command === "show") {
    const result = showTask(args);
    if (args.json) {
      printJsonResult(llmResult(args, {
        ok: true,
        taskId: result.task.taskId,
        artifact: result.task.taskDir,
        uuid: result.task.uuid || result.summary?.uuid || "",
        count: result.task.expectedCount || result.summary?.expectedCount || 0,
        message: isSingleProjectMode(args) ? "Project shown" : "Task shown",
        data: result,
      }));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return 0;
  }
  if (args.command === "path") {
    const task = taskPathResult(args);
    if (args.json) {
      printJsonResult(llmResult(args, {
        ok: true,
        taskId: task.taskId,
        artifact: task.taskDir,
        uuid: task.uuid || "",
        count: task.expectedCount || 0,
        message: "Task path resolved",
        data: { task },
      }));
    } else {
      console.log(task.taskDir);
    }
    return 0;
  }
  if (args.command === "clear") {
    const result = await confirmAndClearTask(args);
    console.log(result.taskDir);
    return 0;
  }
  if (args.command === "validate") {
    const result = validateTask(args);
    if (args.json) {
      printJsonResult(llmResult(args, {
        ok: Boolean(result.ok),
        code: result.ok ? "OK" : "TASK_INCOMPLETE",
        taskId: result.taskId || args.taskId,
        uuid: result.uuid || "",
        count: result.expectedCount || result.uniqueCount || 0,
        message: result.ok ? "Task validation passed" : "Task validation failed",
        data: result,
      }));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return result.ok ? 0 : 1;
  }
  if (args.command === "sid") {
    const result = await validateAndSaveSid(args);
    if (args.json) {
      printJsonResult(llmResult(args, {
        ok: true,
        code: "OK",
        message: "WOS SID validated and saved",
        data: result,
      }));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return 0;
  }
  if (args.command === "import") {
    if (!args.csvPath || !args.taskId || !args.outDir) {
      console.error(usage());
      return 2;
    }
    const summary = importWosIds(args);
    if (args.json) printJsonResult(artifactJsonResult(args, summary, summary.files.wosidsCsv, "WOSID CSV imported"));
    else console.log(summary.files.wosidsCsv);
    return 0;
  }
  if (args.command === "batch-run") {
    if (!args.taskId || !args.outDir) {
      console.error(usage());
      return 2;
    }
    const summary = await runBatchUuidTxt(args);
    if (args.json) printJsonResult(artifactJsonResult(args, summary, summary.files.rawRoot, "Batch UUID TXT export ready"));
    else console.log(summary.files.rawRoot);
    return summary.ok ? 0 : 1;
  }
  if (args.command === "bib") {
    if (!args.url || !args.uuid || !args.outDir) {
      console.error(usage());
      return 2;
    }
    const completed = readCompletedArtifactSummary(args);
    if (completed) {
      if (args.json) printJsonResult(artifactJsonResult(args, completed, completed.files.bibDir, "BibTeX raw batches already complete"));
      else return printCompletedArtifactPath(args.command, completed);
      return completed.ok ? 0 : 1;
    }
    const summary = await runBib(args);
    if (args.json) printJsonResult(artifactJsonResult(args, summary, summary.files.bibDir, "BibTeX raw batches ready"));
    else console.log(summary.files.bibDir);
    return summary.ok ? 0 : 1;
  }
  if (args.command === "latest") {
    if (isSingleProjectMode(args)) {
      console.log(args.taskId);
      return 0;
    }
    const latest = readLatestTaskId(args.tasksRoot);
    if (!latest) {
      if (args.json) printJsonResult(llmResult(args, {
        ok: false,
        code: "TASK_NOT_FOUND",
        message: `No latest task in ${args.tasksRoot}`,
        data: { tasksRoot: args.tasksRoot },
      }));
      console.error(`No latest task in ${args.tasksRoot}`);
      return 1;
    }
    if (args.json) printJsonResult(llmResult(args, {
      ok: true,
      taskId: latest,
      message: "Latest task resolved",
      data: { latestTask: latest, tasksRoot: args.tasksRoot },
    }));
    else console.log(latest);
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
  if (completed) {
    if (args.json) printJsonResult(artifactJsonResult(args, completed, completed.files.rawDir, "TXT raw batches already complete"));
    else return printCompletedArtifactPath(args.command, completed);
    return completed.ok ? 0 : 1;
  }
  const summary = await run(args);
  if (args.json) printJsonResult(artifactJsonResult(args, summary, summary.files.rawDir, "TXT raw batches ready"));
  else console.log(summary.files.rawDir);
  return summary.ok ? 0 : 1;
}

function recordCommandFailure(args, error) {
  if (
    args?.taskId &&
    args?.outDir &&
    fs.existsSync(args.outDir) &&
    ["run", "import", "bib", "batch-run", "query", "record"].includes(args.command)
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
      if (args?.json) printJsonResult(llmErrorResult(args, error));
      console.error(error.message || "Quit by user");
      return 130;
    }
    if (isUserCancelledError(error)) {
      if (args?.json) printJsonResult(llmErrorResult(args, error));
      console.error(error.message || "Cancelled by user");
      return 0;
    }
    if (isUserAbortError(error)) {
      console.error("");
      return 130;
    }
    if (isCliMessageError(error)) {
      recordCommandFailure(args, error);
      if (args?.json) printJsonResult(llmErrorResult(args, error));
      console.error(error.message || String(error));
      return error.exitCode || 1;
    }
    recordCommandFailure(args, error);
    if (args?.json) printJsonResult(llmErrorResult(args, error));
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
        clearSids() {
          clearSavedSidConfig(menuArgs);
          menuArgs.sid = "";
          menuArgs.sidSource = "";
          return workspaceStatus(menuArgs);
        },
        clearDeadSids() {
          clearDeadSidHistory(menuArgs);
          return workspaceStatus(menuArgs);
        },
        setCurrentTask(taskId) {
          setCurrentTaskId(menuArgs, taskId);
          return workspaceStatus(menuArgs, sidCheck);
        },
        setPlaywrightVisible(visible) {
          setPlaywrightVisibleSetting(menuArgs, visible);
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
  runBatchUuidTxt,
  readQueryExprFile,
  runQueryBatch,
  runQueryRecord,
  importWosIds,
  initializeWorkspace,
  workspaceStatus,
  ensureCurrentTask,
  setCurrentTaskId,
  checkSid,
  formatCheckSidResult,
  formatQueryBuildOutput,
  formatQueryRecordOutput,
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
  clearDeadSidHistory,
  advanceSavedSid,
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
  readQueryBatchExpressions,
  isFailedTxtRunSummary,
  isUnverifiedPartialTxtSummary,
  parseBibEntryCount,
  parseWosCount,
  downloadBatchCount,
  planWosExportWindows,
  usesLargeExportWindows,
  formatDownloadWindowDetail,
  formatUuidRemainingDetail,
  formatBatchUuidDownloadDetail,
  downloadWindowCountForState,
  MAX_WOS_EXPORT_BATCHES,
  MAX_WOS_EXPORT_RECORDS,
  MAX_WOS_DUAL_SORT_RECORDS,
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
  chunkItemsByCount,
  formatRuntime,
  formatLocalDateTime,
  formatDbLookup,
  prepareWosRequestContext,
  exportIngestRecordsFromUuid,
  collectRelationWosIdsForIngest,
  exportIngestRecordsByWosIds,
  orderedRecordsForWosIds,
  writeWosIngestSummary,
  runDbLookup,
  runQueryIngest,
  runRecordIngest,
  randomUppercaseLetters,
  pageContextUuid,
  readWosIdsCsv,
  readUuidCsv,
  findUuidCsvFiles,
  normalizeWosId,
  extractUuid,
  extractUuidsFromText,
  maskSid,
  announceResolvedWosUuid,
  prepareWosExport,
  readTaskIndex,
  listTaskNames,
  normalizeTaskId,
  getRunPaths,
  withRawSource,
  cleanRunLayout,
  rawBatchDir,
  bibBatchDir,
  rawWindowDirs,
  rawBatchFiles,
  rawUuidCompleteMarkerPath,
  readRawUuidCompleteMarker,
  writeRawUuidCompleteMarker,
  rawUuidDownloadState,
  firstRawBatchRange,
  inferTxtRangeStart,
  rawBatchCoverageFromStart,
  rawBatchPlanForRange,
  bibBatchFiles,
  bibBatchPlanForRange,
  parseExistingRawBatches,
  readJson,
  writeJson,
  runAuditHtml,
  runAuditExport,
  defaultAuditReportDir,
};
