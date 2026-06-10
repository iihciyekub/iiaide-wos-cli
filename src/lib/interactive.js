const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { Writable } = require("node:stream");
const { color, isInteractive } = require("./terminal");

const ORANGE = "33";
const CLI_AUTHOR = "lyj";
const CLI_VERSION_UPDATED_AT = "2026-06-10";
const DEFAULT_PARSE_OPTIONS = {
  concurrency: 1,
  recordTimeoutMs: 20000,
  cooldownMs: 250,
  fromIndex: 1,
  limit: 0,
};
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

function sidCheckLine(status, sidMasked) {
  return `SID check: Auth ${sidOkLabel(status)} | SID ${sidMasked || "none"}`;
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
  const sidMasked = sidCheck.sidMasked || workspace.sidMasked || "";
  const sidOrigin = sidCheck.origin || workspace.wosOrigin || "";
  const originUrl = sidOrigin || workspace.baseUrl || "https://www.webofscience.com";
  const rightLines = [
    kvLine("Workspace", workspacePath),
    kvLine("Task ID", currentTask ? highlightTaskId(currentTask) : "none"),
    "",
    kvLine("Auth", sidOkLabel(sidStatus)),
    kvLine("SID Value", sidMasked || "none"),
    "",
    kvLine("Playwright", workspace.wosBrowserMode || "background"),
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
  stdout.write(`${color("36", sidCheckLine(sidStatus, sidMasked), stdout)}\n\n`);
  if (!sidOrigin && sidMasked) {
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

async function askOptionalInteger(rl, message, fallback, minimum = 0, maximum = Infinity) {
  for (;;) {
    const answer = await ask(rl, message, String(fallback));
    if (isBackInput(answer)) return CONTROL_BACK;
    if (isQuitInput(answer)) return CONTROL_QUIT;
    if (!/^\d+$/.test(answer)) {
      stdout.write(`${color("33", "Required:", stdout)} enter an integer, B to go back, or q to quit\n`);
      continue;
    }
    const value = Number(answer);
    if (value < minimum || value > maximum) {
      const range = Number.isFinite(maximum) ? `${minimum}-${maximum}` : `>= ${minimum}`;
      stdout.write(`${color("33", "Required:", stdout)} enter ${range}\n`);
      continue;
    }
    return value;
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

function formatParseOptions(options = {}) {
  const values = { ...DEFAULT_PARSE_OPTIONS, ...options };
  return [
    `concurrency=${values.concurrency}`,
    `timeout=${values.recordTimeoutMs}ms`,
    `cooldown=${values.cooldownMs}ms`,
    `from=${values.fromIndex}`,
    `limit=${values.limit || "all"}`,
  ].join(" | ");
}

function parseOptionsToArgs(options = {}) {
  const values = { ...DEFAULT_PARSE_OPTIONS, ...options };
  const args = [
    "--concurrency", String(values.concurrency),
    "--record-timeout-ms", String(values.recordTimeoutMs),
    "--cooldown-ms", String(values.cooldownMs),
    "--from-index", String(values.fromIndex),
  ];
  if (values.limit) args.push("--limit", String(values.limit));
  return args;
}

async function askParseOptions(rl, defaults = DEFAULT_PARSE_OPTIONS) {
  const base = { ...DEFAULT_PARSE_OPTIONS, ...defaults };
  stdout.write(`${color("36", "Parse options:", stdout)} ${formatParseOptions(base)}\n`);
  const change = await askOptionalBoolean(rl, "Change parse options? Enter uses defaults", false);
  if (isBackResult(change) || isQuitResult(change)) return change;
  if (!change) return [];
  const concurrency = await askOptionalInteger(rl, "Concurrency", base.concurrency, 1, 10);
  if (isBackResult(concurrency) || isQuitResult(concurrency)) return concurrency;
  const recordTimeoutMs = await askOptionalInteger(rl, "Record timeout ms", base.recordTimeoutMs, 5000);
  if (isBackResult(recordTimeoutMs) || isQuitResult(recordTimeoutMs)) return recordTimeoutMs;
  const cooldownMs = await askOptionalInteger(rl, "Cooldown ms", base.cooldownMs, 0);
  if (isBackResult(cooldownMs) || isQuitResult(cooldownMs)) return cooldownMs;
  const fromIndex = await askOptionalInteger(rl, "From WOS ID index", base.fromIndex, 1);
  if (isBackResult(fromIndex) || isQuitResult(fromIndex)) return fromIndex;
  const limit = await askOptionalInteger(rl, "Limit 0=all", base.limit, 0);
  if (isBackResult(limit) || isQuitResult(limit)) return limit;
  const options = {
    concurrency,
    recordTimeoutMs,
    cooldownMs,
    fromIndex,
    limit,
  };
  return parseOptionsToArgs(options);
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

function workflowItem(value, label, description) {
  stdout.write(`     ${color("36", value.padEnd(3), stdout)} ${label}\n`);
  if ((stdout.columns || 100) >= 60) {
    stdout.write(`         ${color("2", description, stdout)}\n`);
  }
}

async function askWorkflow(rl) {
  workflowGroup("1", "Download literature");
  workflowItem("1.1", "UUID - TXT format", "URL/UUID -> raw/<uuid>/full-record/*.txt and WOS IDs");
  workflowItem("1.2", "UUID - BIB format", "URL/UUID -> raw/<uuid>/bib/*.bib");
  workflowGroup("2", "Parse");
  workflowItem("2.1", "WOS data", "URL/UUID -> TXT -> WOS IDs -> raw/wosdata JSON");
  workflowItem("2.2", "WOSID CSV", "Local CSV -> WOS IDs -> raw/wosdata JSON");
  workflowGroup("3", "Task manager");
  workflowItem("3.1", "New", "Create a fresh current task");
  workflowItem("3.2", "Switch", "Select an existing current task");
  workflowItem("3.3", "Clear", "Remove a managed task");
  option("c", "Check SID", "Probe the saved SID and refresh it through browser login when needed");
  option("u", "Update", "Install the latest release and restart the interactive CLI");
  option("B", "Back", "Return to the workspace menu");
  option("q", "Exit", "Close without running a command");
  stdout.write("\n");

  for (;;) {
    const choice = (await ask(rl, "Select workflow")).toLowerCase();
    if (isBackInput(choice)) return CONTROL_BACK;
    if (isQuitInput(choice)) return CONTROL_QUIT;
    if (choice === "c") return "c";
    if (choice === "u") return "u";
    if (["1.1", "1.2", "2.1", "2.2", "3.1", "3.2", "3.3"].includes(choice)) return choice;
    stdout.write(`${color("33", "Required:", stdout)} choose 1.1, 1.2, 2.1, 2.2, 3.1, 3.2, 3.3, c to check SID, u to update, B to go back, or q to quit\n`);
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

async function confirmAction(message, defaultYes = true) {
  if (!isInteractive(stdout) || !stdin.isTTY) return defaultYes;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";
  try {
    for (;;) {
      const answer = (await rl.question(`${message}${suffix}: `)).trim().toLowerCase();
      if (!answer) return defaultYes;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no" || isBackInput(answer)) return false;
      if (isQuitInput(answer)) return CONTROL_QUIT;
      stdout.write(`${color("33", "Required:", stdout)} enter y, n, B to go back, or q to quit\n`);
    }
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

async function askSidFromBrowserOrManual(getRl, readBrowserSid, promptManualSid) {
  if (typeof readBrowserSid !== "function") return "";

  for (;;) {
    stdout.write(`${color("1", "SID setup", stdout)}\n`);
    option("1", "Manual input", "Paste a current WOS SID");
    option("2", "Open browser login", "Log in to WOS, then auto-detect SID");
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
    stdout.write(`${color("33", "Required:", stdout)} choose 1, 2, B to go back, or q to quit\n`);
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

  try {
    const generatedTaskId = helpers.makeTaskId?.() || defaultTaskId();
    const sidStatus = workspaceSidStatus(activeWorkspace);
    if (sidStatus !== "valid") {
      const sid = await askSidFromBrowserOrManual(() => rl, helpers.readBrowserSid, promptManualSid);
      if (isQuitResult(sid)) return null;
      if (sid && typeof helpers.saveSid === "function") {
        activeWorkspace = await helpers.saveSid(sid);
        stdout.write(`${color("32", "SID:", stdout)} saved. Refreshing workspace panel.\n\n`);
        return { refresh: true };
      }
    }
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
      sid = await askSidFromBrowserOrManual(() => rl, helpers.readBrowserSid, promptManualSid);
      if (isBackResult(sid)) return { refresh: true };
      if (isQuitResult(sid)) return null;
      if (!sid) return { refresh: true };
      if (typeof helpers.saveSid === "function") {
        activeWorkspace = await helpers.saveSid(sid);
        stdout.write(`${color("32", "SID:", stdout)} saved. Refreshing workspace panel.\n\n`);
        return { refresh: true };
      }
    }

    if (choice === "2.2") {
      const csvPath = await askParameterOrCancel(
        rl,
        "WOSID CSV path",
        "enter a local CSV file containing a wosid or UT column"
      );
      if (isBackResult(csvPath)) return { refresh: true };
      if (isQuitResult(csvPath)) return null;
      if (!csvPath) {
        stdout.write(`${color("33", "Required:", stdout)} WOSID CSV path is required.\n\n`);
        return { refresh: true };
      }
      const result = ["parse", "--csv", csvPath, "--task", taskId, "--tasks-root", activeWorkspace.tasksRoot];
      const parseArgs = await askParseOptions(rl);
      if (isBackResult(parseArgs)) return { refresh: true };
      if (isQuitResult(parseArgs)) return null;
      result.push(...parseArgs);
      if (sid) result.push("--sid", sid);
      return result;
    }

    const sourceFallback = [task?.url, task?.uuid].find(isWosSourceLike) || "";
    if (sourceFallback) {
      stdout.write(`${color("2", "Saved source:", stdout)} ${sourceFallback}\n`);
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
    const command = choice === "2.1" ? "parse-pipeline" : (choice === "1.2" ? "bib" : "run");
    const result = [command, sourceFlag, source, "--task", taskId, "--tasks-root", activeWorkspace.tasksRoot];
    if (command !== "bib") result.push("--reuse-raw");
    if (choice === "2.1") {
      const parseArgs = await askParseOptions(rl);
      if (isBackResult(parseArgs)) return { refresh: true };
      if (isQuitResult(parseArgs)) return null;
      result.push(...parseArgs);
    }
    if (sid) result.push("--sid", sid);
    return result;
  } finally {
    closeRl();
  }
}

module.exports = {
  confirmAction,
  promptConfirmationText,
  interactiveArgs,
  isUserAbortError,
  askParameterOrCancel,
  askParseOptions,
  parseOptionsToArgs,
  formatParseOptions,
  formatRuntime,
  currentTaskSelection,
  isWosSourceLike,
  askTaskSelection,
  listTaskHints,
  printHeader,
  promptSid,
  resolveTaskSelection,
  isBackResult,
  isQuitResult,
  taskSelectionHint,
  taskPromptHelp,
};
