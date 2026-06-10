const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { Writable } = require("node:stream");
const { color, isInteractive } = require("./terminal");

const ORANGE = "33";
const CLI_AUTHOR = "lyj";
const CLI_VERSION_UPDATED_AT = "2026-06-10";
const DEFAULT_AUTHOR_OPTIONS = {
  concurrency: 2,
  cooldownMs: 250,
  fromIndex: 1,
  limit: 0,
  retryFailed: false,
  failedOnly: false,
};

function fit(value, width) {
  const text = String(value || "");
  if (text.length <= width) return text.padEnd(width);
  return width <= 3 ? text.slice(0, width) : `${text.slice(0, width - 3)}...`;
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
  if (status === "invalid" || status === "missing") return "no";
  if (status === "unknown") return "unknown";
  return "no";
}

function sidCheckLine(status, sidMasked) {
  return `SID check: Auth ${sidOkLabel(status)} | SID ${sidMasked || "none"}`;
}

function sidOriginHint(origin) {
  return origin || "login needed";
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
  const sidStatus = sidCheck.status || (workspace.hasSavedSid ? "unknown" : "missing");
  const sidMasked = sidCheck.sidMasked || workspace.sidMasked || "";
  const sidOrigin = sidCheck.origin || workspace.wosOrigin || "";
  const rightLines = [
    kvLine("Workspace", workspacePath),
    kvLine("Task ID", currentTask || "none"),
    "",
    kvLine("Auth", sidOkLabel(sidStatus)),
    kvLine("SID Value", sidMasked || "none"),
    kvLine("Origin", sidOriginHint(sidOrigin)),
    "",
    kvLine("Playwright", workspace.wosBrowserMode || "background"),
    kvLine("Profile", workspace.wosProfileName || ".browser-profile"),
    kvLine("Runtime", formatRuntime(workspace.runtimeMs)),
  ];
  const leftContentWidth = panelWidth - 4;
  const leftBlock = [
    centerLine("[ W O S - C L I ]", leftContentWidth),
    "",
    "",
    centerLine("iiaide-wos CLI", leftContentWidth),
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
  const hint = fallback ? "(Enter uses saved)" : "(Enter cancels)";
  for (;;) {
    const answer = (await rl.question(`${message} ${color("2", hint, stdout)}: `)).trim();
    const lowered = answer.toLowerCase();
    if (lowered === "q" || lowered === "quit" || lowered === "exit" || lowered === "cancel") return "";
    if (!answer) return fallback || "";
    if (answer) return answer;
    stdout.write(`${color("33", "Required:", stdout)} ${help}\n`);
  }
}

async function askOptionalInteger(rl, message, fallback, minimum = 0, maximum = Infinity) {
  for (;;) {
    const answer = await ask(rl, message, String(fallback));
    if (!/^\d+$/.test(answer)) {
      stdout.write(`${color("33", "Required:", stdout)} enter an integer\n`);
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
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    stdout.write(`${color("33", "Required:", stdout)} enter y or n\n`);
  }
}

function formatAuthorOptions(options = {}) {
  const values = { ...DEFAULT_AUTHOR_OPTIONS, ...options };
  return [
    `concurrency=${values.concurrency}`,
    `cooldown=${values.cooldownMs}ms`,
    `from=${values.fromIndex}`,
    `limit=${values.limit || "all"}`,
    `retryFailed=${values.retryFailed ? "yes" : "no"}`,
    `failedOnly=${values.failedOnly ? "yes" : "no"}`,
  ].join(" | ");
}

function authorOptionsToArgs(options = {}) {
  const values = { ...DEFAULT_AUTHOR_OPTIONS, ...options };
  const args = [
    "--concurrency", String(values.concurrency),
    "--cooldown-ms", String(values.cooldownMs),
    "--from-index", String(values.fromIndex),
  ];
  if (values.limit) args.push("--limit", String(values.limit));
  if (values.retryFailed) args.push("--retry-failed");
  if (values.failedOnly) args.push("--failed-only");
  return args;
}

async function askAuthorOptions(rl, defaults = DEFAULT_AUTHOR_OPTIONS) {
  const base = { ...DEFAULT_AUTHOR_OPTIONS, ...defaults };
  stdout.write(`${color("36", "Author options:", stdout)} ${formatAuthorOptions(base)}\n`);
  const change = await askOptionalBoolean(rl, "Change author download options? Enter uses defaults", false);
  if (!change) return [];
  const options = {
    concurrency: await askOptionalInteger(rl, "Concurrency", base.concurrency, 1, 10),
    cooldownMs: await askOptionalInteger(rl, "Cooldown ms", base.cooldownMs, 0),
    fromIndex: await askOptionalInteger(rl, "From WOS ID index", base.fromIndex, 1),
    limit: await askOptionalInteger(rl, "Limit 0=all", base.limit, 0),
    retryFailed: await askOptionalBoolean(rl, "Retry failed records", base.retryFailed),
    failedOnly: await askOptionalBoolean(rl, "Only failed records", base.failedOnly),
  };
  return authorOptionsToArgs(options);
}

function isControlInput(value) {
  return /^(q|quit|exit|cancel)$/i.test(String(value || "").trim());
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
    "WOS",
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
    const marker = task.taskId === currentTask ? " *" : "";
    stdout.write(`  ${String(index + 1).padStart(indexWidth)}  ${color("36", task.taskId, stdout)}${marker}\n`);
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
  if (mode === "existing") {
    return taskCount
      ? `Enter=${fallback}, number=select existing task, or type an exact task id`
      : "no existing tasks are available";
  }
  if (taskCount) {
    return `Enter=${fallback}, number=resume existing task, new=${generatedTaskId}, or type a new custom task id`;
  }
  return `Enter=${generatedTaskId}, new=${generatedTaskId}, or type a custom task id`;
}

function taskSelectionHint(mode, fallback, generatedTaskId, taskCount) {
  if (mode === "existing") {
    return taskCount
      ? `Enter keeps ${fallback}; type 1-${taskCount} or an exact task id.`
      : "No existing tasks are available.";
  }
  if (taskCount) {
    return `Enter keeps ${fallback}; type 1-${taskCount} to switch, new to create ${generatedTaskId}, or type a custom task id.`;
  }
  return `Enter creates ${generatedTaskId}; type new or a custom task id to create another task.`;
}

async function askTaskSelection(rl, workspace, options = {}) {
  const mode = options.mode || "any";
  const tasks = Array.isArray(workspace?.tasks) ? workspace.tasks : [];
  const generatedTaskId = options.generatedTaskId || defaultTaskId();
  const fallback = mode === "existing"
    ? (workspace.latestTask || tasks[0]?.taskId || "")
    : (workspace.latestTask || generatedTaskId);

  if (mode === "existing" && !tasks.length) {
    stdout.write(`${color("33", "No tasks to clear.", stdout)} create one with any download workflow first.\n\n`);
    return null;
  }

  stdout.write(`${color("36", "Task selection:", stdout)} ${taskSelectionHint(mode, fallback, generatedTaskId, tasks.length)}\n`);

  for (;;) {
    const taskInput = await askRequiredWithFallback(
      rl,
      mode === "existing" ? "Task to clear" : "Task",
      fallback,
      taskPromptHelp(mode, fallback, generatedTaskId, tasks.length)
    );
    const selection = resolveTaskSelection(workspace, taskInput, fallback, generatedTaskId);
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

async function askWorkflow(rl) {
  option("1", "Download WOS IDs", "URL/UUID -> full-record txt -> data/<uuid>_wosid.csv");
  option("2", "Download WOS literature txt", "URL/UUID -> raw/full-record/*.txt and derived WOS IDs");
  option("3", "Export author information", "URL/UUID -> txt -> WOS IDs -> authors pipeline");
  option("4", "Download WOS BibTeX", "URL/UUID -> raw/bib/*.bib");
  option("5", "Switch task", "Select or create the current task without running a download");
  option("6", "Clear task", "Remove the selected managed task directory and index entry");
  option("q", "Exit", "Close without running a command");
  stdout.write("\n");

  for (;;) {
    const choice = (await ask(rl, "Select workflow")).toLowerCase();
    if (choice === "q" || choice === "quit" || choice === "exit") return "";
    if (["1", "2", "3", "4", "5", "6"].includes(choice)) return choice;
    stdout.write(`${color("33", "Required:", stdout)} choose 1, 2, 3, 4, 5, 6, or q\n`);
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
  stdout.write(`${message}: `);
  try {
    const sid = (await rl.question("")).trim();
    stdout.write("\n");
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
      if (answer === "n" || answer === "no" || answer === "q" || answer === "quit" || answer === "cancel") return false;
      stdout.write(`${color("33", "Required:", stdout)} enter y or n\n`);
    }
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
    option("q", "Exit", "Close without running a command");
    stdout.write("\n");
    const action = (await ask(getRl(), "Select SID method")).toLowerCase();
    if (action === "q" || action === "quit" || action === "exit") return "";
    if (action === "1" || action === "m" || action === "manual") {
      const sid = await promptManualSid();
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
    stdout.write(`${color("33", "Required:", stdout)} choose 1, 2, or q\n`);
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
    const choice = await askWorkflow(rl);
    if (!choice) return null;

    if (choice === "5") {
      const selection = await askTaskSelection(rl, activeWorkspace, { mode: "any", generatedTaskId });
      if (!selection) return null;
      const nextWorkspace = await refreshWorkspace(selection.taskId);
      stdout.write(`${color("32", "Current task:", stdout)} ${selection.taskId}\n\n`);
      printHeader(version, nextWorkspace);
      listTaskHints(nextWorkspace);
      return { refresh: true };
    }

    if (choice === "6") {
      const selection = await askTaskSelection(rl, activeWorkspace, { mode: "existing", generatedTaskId });
      if (!selection) return null;
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
    if (!workspace.hasSavedSid) {
      sid = await askSidFromBrowserOrManual(() => rl, helpers.readBrowserSid, promptManualSid);
      if (!sid) return null;
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
    if (!source) {
      stdout.write(`${color("33", "Cancelled:", stdout)} no WOS summary URL or UUID entered.\n\n`);
      return { refresh: true };
    }
    const sourceFlag = /^https?:\/\//i.test(source) ? "--url" : "--uuid";
    const command = choice === "3" ? "pipeline" : (choice === "4" ? "bib" : "run");
    const result = [command, sourceFlag, source, "--task", taskId, "--tasks-root", activeWorkspace.tasksRoot];
    if (command !== "bib") result.push("--reuse-raw");
    if (choice === "3") result.push(...await askAuthorOptions(rl));
    if (sid) result.push("--sid", sid);
    return result;
  } finally {
    closeRl();
  }
}

module.exports = {
  confirmAction,
  interactiveArgs,
  isUserAbortError,
  askParameterOrCancel,
  askAuthorOptions,
  authorOptionsToArgs,
  formatAuthorOptions,
  formatRuntime,
  currentTaskSelection,
  isWosSourceLike,
  askTaskSelection,
  listTaskHints,
  printHeader,
  promptSid,
  resolveTaskSelection,
  taskSelectionHint,
  taskPromptHelp,
};
