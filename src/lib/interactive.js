const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { Writable } = require("node:stream");
const { color, isInteractive } = require("./terminal");

const ORANGE = "33";
const CLI_AUTHOR = "lyj";
const CLI_VERSION_UPDATED_AT = "2026-06-10";
const CONTROL_BACK = Symbol.for("iiaide-wos.interactive.back");
const CONTROL_QUIT = Symbol.for("iiaide-wos.interactive.quit");

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function fit(value, width) {
  const text = String(value || "");
  const visibleLength = stripAnsi(text).length;
  if (visibleLength <= width) return `${text}${" ".repeat(width - visibleLength)}`;
  const plain = stripAnsi(text);
  return width <= 3 ? plain.slice(0, width) : `${plain.slice(0, width - 3)}...`;
}

function border(width, title = "") {
  const label = title ? ` ${title} ` : "";
  return `+${label}${"-".repeat(Math.max(0, width - label.length - 2))}+`;
}

function line(text, width) {
  return `| ${fit(text, width - 4)} |`;
}

function centerLine(value, width) {
  const text = String(value || "");
  const space = Math.max(0, width - text.length);
  const left = Math.floor(space / 2);
  return `${" ".repeat(left)}${text}`;
}

function centerHighlightedLine(value, width) {
  const text = String(value || "");
  const space = Math.max(0, width - text.length);
  const left = Math.floor(space / 2);
  const right = space - left;
  return `${" ".repeat(left)}${color("1;30;43", text, stdout)}${" ".repeat(right)}`;
}

function highlightTaskId(value) {
  return color("1;30;46", value, stdout);
}

function centerBlock(lines, height) {
  const body = [...lines];
  const gap = Math.max(0, height - body.length);
  const top = Math.floor(gap / 2);
  const bottom = gap - top;
  return [
    ...Array(top).fill(""),
    ...body,
    ...Array(bottom).fill(""),
  ];
}

function isUserAbortError(error) {
  const message = String(error?.message || error || "");
  return error?.name === "AbortError" || error?.code === "ABORT_ERR" || /Ctrl\+C|aborted/i.test(message);
}

function kvLine(label, value, labelWidth = 10) {
  return `${String(label || "").padEnd(labelWidth)} ${String(value || "")}`;
}

function sidOkLabel(status) {
  if (status === "valid") return "yes";
  if (status === "invalid" || status === "missing" || status === "unknown") return "no";
  return "no";
}

function sidCheckLine(status, sidValue) {
  return `SID check: Auth ${sidOkLabel(status)} | SID ${sidValue || "none"}`;
}

function maskSid(value) {
  const sid = String(value || "").trim();
  if (!sid) return "";
  if (sid.length <= 8) return `${sid.slice(0, 1)}***${sid.slice(-1)}`;
  return `${sid.slice(0, 4)}...${sid.slice(-4)}`;
}

function workspaceSidStatus(workspace = {}) {
  const sidCheck = workspace.sidCheck || {};
  return sidCheck.status || (workspace.hasSavedSid ? "unknown" : "missing");
}

function formatRuntime(value = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (value) => String(value).padStart(2, "0");
  if (hours) return `${hours}h ${pad(minutes)}m`;
  if (minutes) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

function formatBytes(value = 0) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  return `${(mib / 1024).toFixed(1)} GiB`;
}

function panel(title, lines, width, minLines = lines.length) {
  const body = [...lines];
  while (body.length < minLines) body.push("");
  return [
    color(ORANGE, border(width, title), stdout),
    ...body.map((item) => line(item, width)),
    color(ORANGE, border(width), stdout),
  ];
}

function printHeader(version, workspace = {}) {
  const terminalWidth = Math.max(36, Math.min(stdout.columns || 100, 140));
  const twoColumns = terminalWidth >= 108;
  const panelWidth = twoColumns ? 52 : terminalWidth;
  const workspacePath = workspace.tasksRoot || `${process.cwd()}/tasks`;
  const currentTask = workspace.currentTask || workspace.latestTask || "";
  const sidCheck = workspace.sidCheck || {};
  const sidStatus = workspaceSidStatus(workspace);
  const sidValue = sidCheck.sidMasked || sidCheck.sid || workspace.sidMasked || maskSid(workspace.sid) || "";
  const sidOrigin = sidCheck.origin || workspace.wosOrigin || "";
  const originUrl = sidOrigin || workspace.baseUrl || "https://www.webofscience.com";
  const wosDataDb = workspace.wosDataDb || {};
  const sidPoolCount = Number(workspace.sidPoolCount || 0);
  const sidPoolIndex = Number(workspace.sidPoolIndex || -1);
  const activeSidNumber = sidPoolIndex >= 0 ? sidPoolIndex + 1 : 0;
  const rightLines = [
    kvLine("Workspace", workspacePath),
    kvLine("Task ID", currentTask ? highlightTaskId(currentTask) : "none"),
    "",
    kvLine("WOS DB", wosDataDb.dbPath || "none"),
    kvLine("WOS IDs", String(wosDataDb.recordCount || 0)),
    kvLine("Blacklist DB", wosDataDb.blacklistDbPath || "none"),
    kvLine("Blacklist", String(wosDataDb.blacklistCount || 0)),
    kvLine("DB Size", formatBytes(wosDataDb.sizeBytes || 0)),
    "",
    kvLine("Auth", sidOkLabel(sidStatus)),
    kvLine("SID Value", sidValue || "none"),
    kvLine("SID Pool", sidPoolCount ? `${activeSidNumber}/${sidPoolCount}` : "0"),
    kvLine("SID Producer", workspace.authMonitor?.label || "off"),
    "",
    kvLine("Playwright", workspace.wosBrowserMode || "background"),
    kvLine("Parse Tabs", String(workspace.parseConcurrency || 1)),
    kvLine("Profile", workspace.wosProfileName || ".browser-profile"),
    kvLine("Runtime", formatRuntime(workspace.runtimeMs)),
  ];
  const leftContentWidth = panelWidth - 4;
  const leftBlock = [
    centerHighlightedLine("[ W O S - C L I ]", leftContentWidth),
    "",
    "",
    centerLine("iiaide-wos CLI", leftContentWidth),
    centerLine(originUrl, leftContentWidth),
    centerLine(CLI_AUTHOR, leftContentWidth),
    centerLine(CLI_VERSION_UPDATED_AT, leftContentWidth),
  ];
  const panelLines = Math.max(leftBlock.length, rightLines.length);
  const leftLines = centerBlock(leftBlock, panelLines);
  const left = panel(`iiaide-wos CLI v${version}`, leftLines, panelWidth, panelLines);
  const right = panel("Current workspace", rightLines, twoColumns ? terminalWidth - 55 : panelWidth, panelLines);

  stdout.write("\n");
  stdout.write(`${color("32", ">", stdout)} ${color("1;32", "iiaide-wos", stdout)}\n\n`);
  stdout.write(`${color("36", sidCheckLine(sidStatus, sidValue), stdout)}\n\n`);
  if (!sidOrigin && sidValue) {
    stdout.write(`${color("33", "Origin not confirmed:", stdout)} open WOS and refresh SID with ${workspace.baseUrl || "https://www.webofscience.com"}/wos/?Init=Yes&SrcApp=CR&SID=<SID>\n\n`);
  }
  if (twoColumns) {
    const rows = Math.max(left.length, right.length);
    for (let index = 0; index < rows; index += 1) {
      stdout.write(`${left[index] || " ".repeat(52)}  ${right[index] || ""}\n`);
    }
  } else {
    stdout.write(`${left.join("\n")}\n`);
    stdout.write(`${right.join("\n")}\n`);
  }
  stdout.write("\n");
  stdout.write(`${color(ORANGE, "|", stdout)} ${color("1;33", "Choose a workflow", stdout)}\n\n`);
}

async function ask(rl, message, fallback = "") {
  const hint = fallback ? ` ${color("2", `[${fallback}]`, stdout)}` : "";
  const answer = (await rl.question(`${message}${hint}: `)).trim();
  return answer || fallback;
}

async function askRequired(rl, message, help) {
  for (;;) {
    const answer = await ask(rl, message);
    if (answer) return answer;
    stdout.write(`${color("33", "Required:", stdout)} ${help}\n`);
  }
}

async function askRequiredWithFallback(rl, message, fallback, help) {
  for (;;) {
    const answer = await ask(rl, message, fallback);
    if (answer) return answer;
    stdout.write(`${color("33", "Required:", stdout)} ${help}\n`);
  }
}

async function askParameterOrCancel(rl, message, help, fallback = "") {
  const hint = fallback ? "(Enter uses saved, B back, q quit)" : "(B back, q quit)";
  for (;;) {
    const answer = (await rl.question(`${message} ${color("2", hint, stdout)}: `)).trim();
    if (isBackInput(answer)) return CONTROL_BACK;
    if (isQuitInput(answer)) return CONTROL_QUIT;
    if (!answer && fallback) return fallback;
    if (!answer) {
      stdout.write(`${color("33", "Required:", stdout)} ${help}; B goes back, q quits\n`);
      continue;
    }
    if (answer) return answer;
    stdout.write(`${color("33", "Required:", stdout)} ${help}\n`);
  }
}

async function askOptionalBoolean(rl, message, fallback = false) {
  const fallbackText = fallback ? "y" : "n";
  for (;;) {
    const answer = (await ask(rl, message, fallbackText)).toLowerCase();
    if (isBackInput(answer)) return CONTROL_BACK;
    if (isQuitInput(answer)) return CONTROL_QUIT;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    stdout.write(`${color("33", "Required:", stdout)} enter y, n, B to go back, or q to quit\n`);
  }
}

async function askIntegerInRange(rl, message, fallback, minimum, maximum) {
  for (;;) {
    const answer = (await ask(rl, message, String(fallback))).trim();
    if (isBackInput(answer)) return CONTROL_BACK;
    if (isQuitInput(answer)) return CONTROL_QUIT;
    if (/^-?\d+$/.test(answer)) {
      const value = Number(answer);
      if (Number.isSafeInteger(value) && value >= minimum && value <= maximum) return value;
    }
    stdout.write(`${color("33", "Required:", stdout)} enter an integer from ${minimum} to ${maximum}, B to go back, or q to quit\n`);
  }
}

function isBackInput(value) {
  return /^(b|back)$/i.test(String(value || "").trim());
}

function isQuitInput(value) {
  return /^(q|quit|exit)$/i.test(String(value || "").trim());
}

function isControlInput(value) {
  return isBackInput(value) || isQuitInput(value);
}

function isBackResult(value) {
  return value === CONTROL_BACK;
}

function isQuitResult(value) {
  return value === CONTROL_QUIT;
}

function isWosSourceLike(value) {
  const text = String(value || "").trim();
  if (!text || isControlInput(text)) return false;
  return /^https?:\/\//i.test(text) ||
    /(?:^|\/)wos\/woscc\/summary\//i.test(text) ||
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[0-9a-f]{10})?/i.test(text);
}

function classifyWosIdsToSqlInput(value) {
  const input = String(value || "").trim();
  if (!input) return { kind: "", value: "" };
  if (/\.csv$/i.test(input)) return { kind: "csv", value: input };
  if (isWosSourceLike(input)) return { kind: "wos-source", value: input };
  return { kind: "unknown", value: input };
}

function defaultTaskId() {
  const date = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [
    "TID",
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function listTaskHints(workspace) {
  const tasks = Array.isArray(workspace.tasks) ? workspace.tasks : [];
  if (!tasks.length) {
    stdout.write(`${color("2", "No tasks in this directory yet. Enter creates a new task.", stdout)}\n\n`);
    return;
  }
  stdout.write(`${color("1", "Tasks in this directory", stdout)}\n`);
  const indexWidth = String(tasks.length).length;
  const taskIdWidth = Math.max(7, ...tasks.map((task) => String(task.taskId || "").length));
  stdout.write(`  ${"#".padStart(indexWidth)}  ${"Task ID".padEnd(taskIdWidth)}\n`);
  stdout.write(`  ${"-".repeat(indexWidth)}  ${"-".repeat(taskIdWidth)}\n`);
  const currentTask = workspace.currentTask || workspace.latestTask || "";
  for (const [index, task] of tasks.entries()) {
    const isCurrent = task.taskId === currentTask;
    const marker = isCurrent ? " *" : "";
    const taskId = isCurrent ? highlightTaskId(task.taskId) : color("36", task.taskId, stdout);
    stdout.write(`  ${String(index + 1).padStart(indexWidth)}  ${taskId}${marker}\n`);
  }
  stdout.write("\n");
}

function findTask(workspace, taskId) {
  return (Array.isArray(workspace.tasks) ? workspace.tasks : []).find((task) => task.taskId === taskId);
}

function currentTaskSelection(workspace) {
  const taskId = workspace?.currentTask || workspace?.latestTask || "";
  return { taskId, task: taskId ? findTask(workspace, taskId) : null };
}

function canResumeWosIdsToSqlTask(task = {}) {
  return Number(task?.uniqueCount || 0) > 0;
}

function resolveTaskSelection(workspace, value, fallback = "", newTaskId = "") {
  const tasks = Array.isArray(workspace?.tasks) ? workspace.tasks : [];
  const raw = String(value || "").trim();
  if (isBackInput(raw)) {
    return { taskId: "", task: null, fromIndex: false, isNew: false, invalidIndex: false, back: true };
  }
  if (isQuitInput(raw)) {
    return { taskId: "", task: null, fromIndex: false, isNew: false, invalidIndex: false, quit: true };
  }
  if (/^new$/i.test(raw) && String(newTaskId || "").trim()) {
    return { taskId: String(newTaskId).trim(), task: null, fromIndex: false, isNew: true, invalidIndex: false };
  }
  const selected = raw || String(fallback || "").trim();
  if (!selected) return { taskId: "", task: null, fromIndex: false, isNew: false, invalidIndex: false };
  if (/^\d+$/.test(selected)) {
    const index = Number(selected);
    if (index >= 1 && index <= tasks.length) {
      const task = tasks[index - 1];
      return { taskId: task.taskId, task, fromIndex: true, isNew: false, invalidIndex: false };
    }
    if (tasks.length) {
      return { taskId: selected, task: null, fromIndex: false, isNew: false, invalidIndex: true };
    }
  }
  const task = findTask(workspace, selected);
  return { taskId: selected, task, fromIndex: false, isNew: !task, invalidIndex: false };
}

function taskPromptHelp(mode, fallback, generatedTaskId, taskCount) {
  if (mode === "new") {
    return `Enter creates ${generatedTaskId}; type a custom task id; B goes back; q quits`;
  }
  if (mode === "existing") {
    return taskCount
      ? `Enter keeps ${fallback}; type 1-${taskCount} to select an existing task; type an exact task id; B goes back; q quits`
      : "no existing tasks are available";
  }
  if (taskCount) {
    return `Enter keeps ${fallback}; type 1-${taskCount} to switch; type new to create ${generatedTaskId}; type a custom task id; B goes back; q quits`;
  }
  return `Enter creates ${generatedTaskId}; type new or a custom task id to create another task; B goes back; q quits`;
}

function taskHintLine(command, description) {
  return `  ${String(command).padEnd(7)}${description}`;
}

function taskSelectionHint(mode, fallback, generatedTaskId, taskCount) {
  if (mode === "new") {
    return [
      taskHintLine("Enter", `create ${generatedTaskId}`),
      taskHintLine("custom", "type a custom task id"),
      taskHintLine("B", "back"),
      taskHintLine("q", "quit"),
    ].join("\n");
  }
  if (mode === "existing") {
    if (!taskCount) return "  no existing tasks are available";
    return [
      taskHintLine("Enter", `keep ${fallback}`),
      taskHintLine(`1-${taskCount}`, "select an existing task"),
      taskHintLine("custom", "type an exact task id"),
      taskHintLine("B", "back"),
      taskHintLine("q", "quit"),
    ].join("\n");
  }
  if (taskCount) {
    return [
      taskHintLine("Enter", `keep ${fallback}`),
      taskHintLine(`1-${taskCount}`, "switch to a listed task"),
      taskHintLine("new", `create ${generatedTaskId}`),
      taskHintLine("custom", "type a custom task id"),
      taskHintLine("B", "back"),
      taskHintLine("q", "quit"),
    ].join("\n");
  }
  return [
    taskHintLine("Enter", `create ${generatedTaskId}`),
    taskHintLine("new", `create ${generatedTaskId}`),
    taskHintLine("custom", "type a custom task id"),
    taskHintLine("B", "back"),
    taskHintLine("q", "quit"),
  ].join("\n");
}

async function askTaskSelection(rl, workspace, options = {}) {
  const mode = options.mode || "any";
  const tasks = Array.isArray(workspace?.tasks) ? workspace.tasks : [];
  const generatedTaskId = options.generatedTaskId || defaultTaskId();
  const fallback = mode === "new"
    ? generatedTaskId
    : mode === "existing"
    ? (workspace.latestTask || tasks[0]?.taskId || "")
    : (workspace.latestTask || generatedTaskId);

  if (mode === "existing" && !tasks.length) {
    stdout.write(`${color("33", "No existing tasks.", stdout)} create one with Task manager 3.1 first.\n\n`);
    return null;
  }

  stdout.write(`${color("36", "Task selection:", stdout)}\n${taskSelectionHint(mode, fallback, generatedTaskId, tasks.length)}\n\n`);

  for (;;) {
    const taskInput = await askRequiredWithFallback(
      rl,
      mode === "existing" ? "Task" : "Task",
      fallback,
      taskPromptHelp(mode, fallback, generatedTaskId, tasks.length)
    );
    const selection = resolveTaskSelection(mode === "new" ? { tasks: [] } : workspace, taskInput, fallback, generatedTaskId);
    if (selection.back) return CONTROL_BACK;
    if (selection.quit) return CONTROL_QUIT;
    if (selection.invalidIndex) {
      stdout.write(`${color("33", "Invalid task number:", stdout)} choose 1-${tasks.length}, or type a custom task id.\n`);
      continue;
    }
    if (mode === "existing" && !selection.task) {
      stdout.write(`${color("33", "Task not found:", stdout)} ${selection.taskId}\n`);
      continue;
    }
    return selection;
  }
}

function workflowGroup(value, label) {
  stdout.write(`  ${color("36", value, stdout)}  ${label}\n`);
}

function workflowTopItem(value, label, description) {
  stdout.write(`  ${color("36", value, stdout)}  ${label}\n`);
  if ((stdout.columns || 100) >= 60) {
    stdout.write(`     ${color("2", description, stdout)}\n`);
  }
}

function workflowItem(value, label, description) {
  stdout.write(`     ${color("36", value.padEnd(3), stdout)} ${label}\n`);
  if ((stdout.columns || 100) >= 60) {
    stdout.write(`         ${color("2", description, stdout)}\n`);
  }
}

function shortcutRow(items) {
  const separator = `  ${color("2", "|", stdout)}  `;
  const text = items.map(([value, label]) => `${color("36", value, stdout)} ${label}`).join(separator);
  stdout.write(`  ${text}\n`);
}

function printWosDataDbStatus(workspace) {
  const db = workspace?.wosDataDb || {};
  stdout.write(`${color("32", "WOS data SQLite:", stdout)} ${db.dbPath || "none"}\n`);
  stdout.write(`  WOS IDs ${Number(db.recordCount || 0)}\n`);
  stdout.write(`  Sources ${Number(db.sourceCount || 0)}\n`);
  stdout.write(`  Blacklist DB ${db.blacklistDbPath || "none"}\n`);
  stdout.write(`  Blacklist ${Number(db.blacklistCount || 0)}\n`);
  stdout.write(`  Blacklist Size ${formatBytes(db.blacklistSizeBytes || 0)}\n`);
  stdout.write(`  Size    ${formatBytes(db.sizeBytes || 0)}\n\n`);
}

function appendWosDataDbArg(result, workspace) {
  const dbPath = workspace?.wosDataDb?.dbPath;
  const blacklistDbPath = workspace?.wosDataDb?.blacklistDbPath;
  if (dbPath) result.push("--db", dbPath);
  if (blacklistDbPath) result.push("--blacklist-db", blacklistDbPath);
  return result;
}

async function askWorkflow(rl) {
  workflowGroup("1", "Download literature");
  workflowItem("1.1", "UUID - TXT format", "URL/UUID -> raw/<uuid>/full-record/*.txt and WOS IDs");
  workflowItem("1.2", "UUID - BIB format", "URL/UUID -> raw/<uuid>/bib/*.bib");
  workflowTopItem("2", "WOS IDs to SQL", "CSV path or URL/UUID -> WOS IDs -> SQLite");
  workflowItem("2.1", "Resume", "Current task WOS IDs -> SQLite");
  workflowGroup("3", "Task manager");
  workflowItem("3.1", "New", "Create a fresh current task");
  workflowItem("3.2", "Switch", "Select an existing current task");
  workflowItem("3.3", "Clear", "Remove a managed task");
  workflowGroup("4", "SQL database");
  workflowItem("4.1", "Status", "Show global SQLite path, WOSID count, source count, and size");
  workflowItem("4.2", "Merge database", "Merge another WOS SQLite database into the global database");
  workflowItem("4.3", "Query WOSID", "Enter one WOSID and print its SQLite record");
  workflowGroup("5", "Settings");
  workflowItem("5.1", "Playwright visible", "Choose whether WOS browser work opens a visible window");
  workflowItem("5.2", "Parse tabs", "Set default reusable WOS tabs for WOSID parsing");
  workflowItem("5.3", "Add SIDs", "Paste one or more SIDs into the saved SID pool");
  workflowGroup("6", "Auth producer");
  workflowItem("6.1", "MUST login", "Run one MUST SSO login and save the produced SID");
  workflowItem("6.2", "MUST monitor", "Keep this CLI running to refill the SID pool");
  shortcutRow([["c", "Check SID"], ["u", "Update"], ["B", "Back"], ["q", "Exit"]]);
  stdout.write("\n");

  for (;;) {
    const choice = (await ask(rl, "Select workflow")).toLowerCase();
    if (isBackInput(choice)) return CONTROL_BACK;
    if (isQuitInput(choice)) return CONTROL_QUIT;
    if (choice === "c") return "c";
    if (choice === "u") return "u";
    if (["1.1", "1.2", "2", "2.1", "3.1", "3.2", "3.3", "4.1", "4.2", "4.3", "5.1", "5.2", "5.3", "6.1", "6.2"].includes(choice)) return choice;
    stdout.write(`${color("33", "Required:", stdout)} choose 1.1, 1.2, 2, 2.1, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 6.1, 6.2, c to check SID, u to update, B to go back, or q to quit\n`);
  }
}

async function promptSid(message = "Enter a current WOS SID") {
  if (!isInteractive(stdout) || !stdin.isTTY) {
    throw new Error("SID input requires an interactive terminal. Pass --sid or set WOS_SID.");
  }
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = readline.createInterface({ input: stdin, output: mutedOutput, terminal: true });
  stdout.write(`${message} (B back, q quit): `);
  try {
    const sid = (await rl.question("")).trim();
    stdout.write("\n");
    if (isBackInput(sid)) return CONTROL_BACK;
    if (isQuitInput(sid)) return CONTROL_QUIT;
    return sid;
  } finally {
    rl.close();
  }
}

async function promptSidBatch(message = "Paste WOS SIDs") {
  if (!isInteractive(stdout) || !stdin.isTTY) {
    throw new Error("SID input requires an interactive terminal. Pass --add-sids to iiaide-wos settings.");
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const lines = [];
  stdout.write(`${message}. Use spaces or one SID per line. Submit an empty line to finish. B back, q quit.\n`);
  try {
    for (;;) {
      const line = (await rl.question(lines.length ? "> " : "SIDs: ")).trim();
      if (isBackInput(line)) return CONTROL_BACK;
      if (isQuitInput(line)) return CONTROL_QUIT;
      if (!line) break;
      lines.push(line);
    }
    return lines.join("\n");
  } finally {
    rl.close();
  }
}

async function promptConfirmationText(message) {
  if (!isInteractive(stdout) || !stdin.isTTY) return "";
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${message}: `)).trim();
    if (isBackInput(answer)) return CONTROL_BACK;
    if (isQuitInput(answer)) return CONTROL_QUIT;
    return answer;
  } finally {
    rl.close();
  }
}

async function askSidFromBrowserOrManual(getRl, readBrowserSid, promptManualSid, waitForSidPool) {
  if (typeof readBrowserSid !== "function") return "";
  const canWaitForSidPool = typeof waitForSidPool === "function";

  for (;;) {
    stdout.write(`${color("1", "SID setup", stdout)}\n`);
    option("1", "Manual input", "Paste a current WOS SID");
    option("2", "Open browser login", "Log in to WOS, then auto-detect SID");
    if (canWaitForSidPool) option("3", "Wait for SID pool", "Keep checking until auth monitor adds a SID");
    option("B", "Back", "Return to workflow selection");
    option("q", "Exit", "Close without running a command");
    stdout.write("\n");
    const action = (await ask(getRl(), "Select SID method")).toLowerCase();
    if (isBackInput(action)) return CONTROL_BACK;
    if (isQuitInput(action)) return CONTROL_QUIT;
    if (action === "1" || action === "m" || action === "manual") {
      const sid = await promptManualSid();
      if (isBackResult(sid)) continue;
      if (isQuitResult(sid)) return CONTROL_QUIT;
      if (sid) {
        stdout.write(`${color("32", "SID:", stdout)} received manually.\n\n`);
        return sid;
      }
      stdout.write(`${color("33", "Required:", stdout)} SID must not be empty\n`);
      continue;
    }
    if (action === "2" || action === "auto" || action === "browser") {
      stdout.write(`${color("32", "SID:", stdout)} opening a WOS login browser...\n`);
      try {
        const sid = await readBrowserSid();
        if (sid) {
          stdout.write(`${color("32", "SID:", stdout)} detected from browser.\n\n`);
          return sid;
        }
        stdout.write(`${color("33", "SID:", stdout)} browser tab did not expose a SID.\n`);
      } catch (error) {
        stdout.write(`${color("33", "SID auto-detect failed:", stdout)} ${error.message || error}\n`);
      }
      stdout.write("Choose browser login again, or use manual input.\n\n");
      continue;
    }
    if (canWaitForSidPool && (action === "3" || action === "pool" || action === "wait")) {
      stdout.write(`${color("32", "SID pool:", stdout)} waiting for a saved SID...\n`);
      try {
        const sid = await waitForSidPool();
        if (sid) {
          stdout.write(`${color("32", "SID:", stdout)} loaded from SID pool.\n\n`);
          return sid;
        }
        stdout.write(`${color("33", "SID pool:", stdout)} no SID was returned.\n`);
      } catch (error) {
        stdout.write(`${color("33", "SID pool wait failed:", stdout)} ${error.message || error}\n`);
      }
      stdout.write("Choose SID pool wait again, browser login, or manual input.\n\n");
      continue;
    }
    stdout.write(`${color("33", "Required:", stdout)} choose 1, 2${canWaitForSidPool ? ", 3" : ""}, B to go back, or q to quit\n`);
  }
}

function option(value, label, description) {
  stdout.write(`  ${color("36", value, stdout)}  ${label}\n`);
  if ((stdout.columns || 100) >= 60) {
    stdout.write(`     ${color("2", description, stdout)}\n`);
  }
}

async function interactiveArgs(version, workspace, helpers = {}) {
  if (!isInteractive(stdout) || !stdin.isTTY) {
    throw new Error("Interactive menu requires a TTY. Use --help to see scriptable commands.");
  }

  let activeWorkspace = workspace;
  const refreshWorkspace = async (taskId) => {
    if (typeof helpers.setCurrentTask !== "function") return activeWorkspace;
    activeWorkspace = await helpers.setCurrentTask(taskId);
    return activeWorkspace;
  };
  const printWorkspace = () => {
    printHeader(version, activeWorkspace);
    listTaskHints(activeWorkspace);
  };
  printWorkspace();

  let rl;
  let closed = true;
  const openRl = () => {
    if (closed) {
      rl = readline.createInterface({ input: stdin, output: stdout });
      closed = false;
    }
  };
  const closeRl = () => {
    if (!closed) {
      rl.close();
      closed = true;
    }
  };
  openRl();
  const promptManualSid = async () => {
    closeRl();
    try {
      return await promptSid("Enter WOS SID manually");
    } finally {
      openRl();
    }
  };
  const promptBatchSids = async () => {
    closeRl();
    try {
      return await promptSidBatch("Paste WOS SIDs");
    } finally {
      openRl();
    }
  };

  try {
    const generatedTaskId = helpers.makeTaskId?.() || defaultTaskId();
    const choice = await askWorkflow(rl);
    if (isBackResult(choice)) return { refresh: true };
    if (isQuitResult(choice)) return null;

    if (choice === "c") {
      return ["check", "--tasks-root", activeWorkspace.tasksRoot];
    }

    if (choice === "u") {
      return ["update"];
    }

    if (choice === "3.1") {
      const selection = await askTaskSelection(rl, activeWorkspace, { mode: "new", generatedTaskId });
      if (isBackResult(selection)) return { refresh: true };
      if (isQuitResult(selection)) return null;
      const nextWorkspace = await refreshWorkspace(selection.taskId);
      stdout.write(`${color("32", "Current task:", stdout)} ${selection.taskId}\n\n`);
      printHeader(version, nextWorkspace);
      listTaskHints(nextWorkspace);
      return { refresh: true };
    }

    if (choice === "3.2") {
      const selection = await askTaskSelection(rl, activeWorkspace, { mode: "existing", generatedTaskId });
      if (isBackResult(selection)) return { refresh: true };
      if (isQuitResult(selection)) return null;
      if (!selection) return { refresh: true };
      const nextWorkspace = await refreshWorkspace(selection.taskId);
      stdout.write(`${color("32", "Current task:", stdout)} ${selection.taskId}\n\n`);
      printHeader(version, nextWorkspace);
      listTaskHints(nextWorkspace);
      return { refresh: true };
    }

    if (choice === "3.3") {
      const selection = await askTaskSelection(rl, activeWorkspace, { mode: "existing", generatedTaskId });
      if (isBackResult(selection)) return { refresh: true };
      if (isQuitResult(selection)) return null;
      if (!selection) return { refresh: true };
      stdout.write(`${color("32", "Clearing task:", stdout)} ${selection.taskId}\n\n`);
      return ["clear", "--task", selection.taskId, "--tasks-root", activeWorkspace.tasksRoot];
    }

    if (choice === "4.1") {
      printWosDataDbStatus(activeWorkspace);
      return { refresh: true };
    }

    if (choice === "4.2") {
      const sourceDb = await askParameterOrCancel(
        rl,
        "Source SQLite database",
        "enter a local .sqlite database file to merge"
      );
      if (isBackResult(sourceDb)) return { refresh: true };
      if (isQuitResult(sourceDb)) return null;
      const result = appendWosDataDbArg(
        ["wosdata", "--merge-db", sourceDb, "--tasks-root", activeWorkspace.tasksRoot],
        activeWorkspace
      );
      const force = await askOptionalBoolean(rl, "Force overwrite existing SQL rows", false);
      if (isBackResult(force)) return { refresh: true };
      if (isQuitResult(force)) return null;
      if (force) result.push("--force");
      return result;
    }

    if (choice === "4.3") {
      const wosid = await askParameterOrCancel(
        rl,
        "WOSID",
        "enter one WOSID, for example WOS:000000000000001"
      );
      if (isBackResult(wosid)) return { refresh: true };
      if (isQuitResult(wosid)) return null;
      const result = appendWosDataDbArg(
        ["wosdata", "--wosid", wosid, "--tasks-root", activeWorkspace.tasksRoot],
        activeWorkspace
      );
      return result;
    }

    if (choice === "5.1") {
      const visible = await askOptionalBoolean(
        rl,
        "Run WOS Playwright in a visible browser window",
        Boolean(activeWorkspace.playwrightVisible)
      );
      if (isBackResult(visible)) return { refresh: true };
      if (isQuitResult(visible)) return null;
      if (typeof helpers.setPlaywrightVisible === "function") {
        activeWorkspace = await helpers.setPlaywrightVisible(visible);
        stdout.write(`${color("32", "Playwright:", stdout)} ${visible ? "visible" : "background"} saved. Refreshing workspace panel.\n\n`);
        return { refresh: true };
      }
      return { refresh: true };
    }

    if (choice === "5.2") {
      const parseConcurrency = await askIntegerInRange(
        rl,
        "Default WOS parse tabs",
        Number(activeWorkspace.parseConcurrency || 1),
        1,
        10
      );
      if (isBackResult(parseConcurrency)) return { refresh: true };
      if (isQuitResult(parseConcurrency)) return null;
      if (typeof helpers.setParseConcurrency === "function") {
        activeWorkspace = await helpers.setParseConcurrency(parseConcurrency);
        stdout.write(`${color("32", "Parse tabs:", stdout)} ${parseConcurrency} saved. Refreshing workspace panel.\n\n`);
        return { refresh: true };
      }
      return { refresh: true };
    }

    if (choice === "5.3") {
      const sids = await promptBatchSids();
      if (isBackResult(sids)) return { refresh: true };
      if (isQuitResult(sids)) return null;
      if (!String(sids || "").trim()) return { refresh: true };
      if (typeof helpers.addSids === "function") {
        activeWorkspace = await helpers.addSids(sids);
        stdout.write(`${color("32", "SID pool:", stdout)} added. Refreshing workspace panel.\n\n`);
        return { refresh: true };
      }
      return { refresh: true };
    }

    if (choice === "6.1") {
      return ["auth", "login", "--provider", "must", "--tasks-root", activeWorkspace.tasksRoot];
    }

    if (choice === "6.2") {
      stdout.write(`${color("33", "MUST auth monitor:", stdout)} this command keeps running until you stop it with Ctrl-C.\n\n`);
      return ["auth", "monitor", "--provider", "must", "--tasks-root", activeWorkspace.tasksRoot];
    }

    let selection = currentTaskSelection(activeWorkspace);
    if (!selection.taskId) {
      await refreshWorkspace(generatedTaskId);
      printHeader(version, activeWorkspace);
      listTaskHints(activeWorkspace);
      selection = currentTaskSelection(activeWorkspace);
    }
    const taskId = selection.taskId;
    const task = selection.task;
    stdout.write(`${color("32", "Using task:", stdout)} ${taskId}\n\n`);

    let sid = "";
    if (workspaceSidStatus(activeWorkspace) !== "valid") {
      sid = await askSidFromBrowserOrManual(() => rl, helpers.readBrowserSid, promptManualSid, helpers.waitForSidPool);
      if (isBackResult(sid)) return { refresh: true };
      if (isQuitResult(sid)) return null;
      if (!sid) return { refresh: true };
      if (typeof helpers.saveSid === "function") {
        activeWorkspace = await helpers.saveSid(sid);
        stdout.write(`${color("32", "SID:", stdout)} saved.\n\n`);
      }
    }

    const sourceFallback = [task?.url, task?.uuid].find(isWosSourceLike) || "";
    if (sourceFallback) {
      stdout.write(`${color("2", "Saved source:", stdout)} ${sourceFallback}\n`);
    }

    if (choice === "2.1") {
      const result = appendWosDataDbArg(
        ["parse", "--task", taskId, "--tasks-root", activeWorkspace.tasksRoot],
        activeWorkspace
      );
      if (sid) result.push("--sid", sid);
      return result;
    }

    if (choice === "2") {
      if (sid && canResumeWosIdsToSqlTask(task)) {
        stdout.write(`${color("32", "SID ready:", stdout)} resuming current WOS IDs to SQL task.\n\n`);
        const result = appendWosDataDbArg(
          ["parse", "--task", taskId, "--tasks-root", activeWorkspace.tasksRoot],
          activeWorkspace
        );
        result.push("--sid", sid);
        return result;
      }
      const input = await askParameterOrCancel(
        rl,
        "CSV path, WOS URL, or UUID",
        "enter a .csv file, WOS summary URL, or WOS result-set UUID",
        sourceFallback
      );
      if (isBackResult(input)) return { refresh: true };
      if (isQuitResult(input)) return null;
      const parsed = classifyWosIdsToSqlInput(input);
      if (parsed.kind === "csv") {
        const result = appendWosDataDbArg(
          ["parse", "--csv", parsed.value, "--task", taskId, "--tasks-root", activeWorkspace.tasksRoot],
          activeWorkspace
        );
        if (sid) result.push("--sid", sid);
        return result;
      }
      if (parsed.kind !== "wos-source") {
        stdout.write(`${color("33", "Required:", stdout)} enter a .csv file, WOS summary URL, or WOS result-set UUID.\n\n`);
        return { refresh: true };
      }
      const sourceFlag = /^https?:\/\//i.test(parsed.value) ? "--url" : "--uuid";
      const result = [
        "parse-pipeline",
        sourceFlag,
        parsed.value,
        "--task",
        taskId,
        "--tasks-root",
        activeWorkspace.tasksRoot,
        "--reuse-raw",
      ];
      appendWosDataDbArg(result, activeWorkspace);
      if (sid) result.push("--sid", sid);
      return result;
    }

    const source = await askParameterOrCancel(
      rl,
      "WOS summary URL or UUID",
      "paste a WOS summary URL or result-set UUID",
      sourceFallback
    );
    if (isBackResult(source)) return { refresh: true };
    if (isQuitResult(source)) return null;
    if (!source) {
      stdout.write(`${color("33", "Required:", stdout)} WOS summary URL or UUID is required.\n\n`);
      return { refresh: true };
    }
    const sourceFlag = /^https?:\/\//i.test(source) ? "--url" : "--uuid";
    const command = choice === "1.2" ? "bib" : "run";
    const result = [command, sourceFlag, source, "--task", taskId, "--tasks-root", activeWorkspace.tasksRoot];
    if (command !== "bib") result.push("--reuse-raw");
    if (sid) result.push("--sid", sid);
    return result;
  } finally {
    closeRl();
  }
}

module.exports = {
  promptConfirmationText,
  interactiveArgs,
  isUserAbortError,
  askParameterOrCancel,
  formatBytes,
  formatRuntime,
  currentTaskSelection,
  canResumeWosIdsToSqlTask,
  isWosSourceLike,
  classifyWosIdsToSqlInput,
  askTaskSelection,
  listTaskHints,
  printHeader,
  promptSid,
  promptSidBatch,
  askSidFromBrowserOrManual,
  resolveTaskSelection,
  isBackResult,
  isQuitResult,
  taskSelectionHint,
  taskPromptHelp,
};
