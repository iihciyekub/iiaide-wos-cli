const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { Writable } = require("node:stream");
const { color, isInteractive } = require("./terminal");

const ORANGE = "33";

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

function panel(title, lines, width) {
  return [
    color(ORANGE, border(width, title), stdout),
    ...lines.map((item) => line(item, width)),
    color(ORANGE, border(width), stdout),
  ];
}

function printHeader(version, workspace = {}) {
  const terminalWidth = Math.max(36, Math.min(stdout.columns || 100, 140));
  const twoColumns = terminalWidth >= 108;
  const panelWidth = twoColumns ? 52 : terminalWidth;
  const workspacePath = workspace.tasksRoot || `${process.cwd()}/tasks`;
  const taskStatus = workspace.initialized
    ? `${workspace.taskCount || 0} tasks${workspace.latestTask ? ` | latest: ${workspace.latestTask}` : ""}`
    : "Not initialized | run wos-aide init";
  const authStatus = workspace.hasSavedSid ? "Saved SID available" : "No saved SID";
  const gettingStarted = workspace.initialized
    ? "Select an action or run wos-aide workspace."
    : "Run wos-aide init, then select an action.";
  const left = panel(`WOS Aide CLI v${version}`, [
    "",
    "              [ W O S ]",
    "",
    "Web of Science task workspace",
    "URL / UUID / CSV -> reusable data package",
    "",
  ], panelWidth);
  const right = panel("Current workspace", [
    workspacePath,
    taskStatus,
    authStatus,
    "",
    "Getting started",
    gettingStarted,
  ], twoColumns ? terminalWidth - 55 : panelWidth);

  stdout.write("\n");
  stdout.write(`${color("32", ">", stdout)} ${color("1;32", "wos-aide", stdout)}\n\n`);
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

function option(value, label, description) {
  stdout.write(`  ${color("36", value, stdout)}  ${label}\n`);
  if ((stdout.columns || 100) >= 60) {
    stdout.write(`     ${color("2", description, stdout)}\n`);
  }
}

async function interactiveArgs(version, workspace) {
  if (!isInteractive(stdout) || !stdin.isTTY) {
    throw new Error("Interactive menu requires a TTY. Use --help to see scriptable commands.");
  }

  printHeader(version, workspace);
  option("1", "Export WOS IDs", "Create a task from a WOS summary URL or UUID");
  option("2", "Import WOS ID CSV", "Create a task from an existing CSV");
  option("3", "Fetch author information", "Continue the latest task");
  option("4", "List tasks", "Show task status and record counts");
  option("5", "Workspace status", "Show the active task workspace");
  option("6", "Validate latest task", "Check generated files and counts");
  option("7", "Validate and save SID", "Verify authentication for later commands");
  option("8", "Help", "Show all commands and options");
  option("9", "Check for updates", "Check the latest stable GitHub Release");
  option("q", "Exit", "Close without running a command");
  stdout.write("\n");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const choice = (await ask(rl, "Select an action")).toLowerCase();
    if (choice === "q" || choice === "quit" || choice === "exit") return null;
    if (choice === "3") return ["authors", "--latest"];
    if (choice === "4") return ["list"];
    if (choice === "5") return ["workspace"];
    if (choice === "6") return ["validate", "--latest"];
    if (choice === "8") return ["--help"];
    if (choice === "9") return ["update", "--check"];
    if (choice === "7") return ["sid"];
    if (choice === "2") {
      const csvPath = await ask(rl, "Path to WOS ID CSV");
      if (!csvPath) throw new Error("A CSV path is required");
      const taskId = await ask(rl, "Task id (optional)");
      const taskLabel = await ask(rl, "Task label (optional)");
      const result = ["import", "--csv", csvPath];
      if (taskId) result.push("--task", taskId);
      if (taskLabel) result.push("--task-label", taskLabel);
      return result;
    }
    if (choice !== "1") throw new Error(`Unknown menu selection: ${choice}`);

    const source = await ask(rl, "WOS summary URL or UUID");
    if (!source) throw new Error("A WOS summary URL or UUID is required");
    const taskId = await ask(rl, "Task id (optional)");
    const taskLabel = await ask(rl, "Task label (optional)");
    const sourceFlag = /^https?:\/\//i.test(source) ? "--url" : "--uuid";
    const result = ["run", sourceFlag, source];
    if (taskId) result.push("--task", taskId);
    if (taskLabel) result.push("--task-label", taskLabel);
    return result;
  } finally {
    rl.close();
  }
}

module.exports = {
  interactiveArgs,
  printHeader,
  promptSid,
};
