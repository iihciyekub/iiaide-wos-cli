const readline = require("node:readline");

function isInteractive(stream = process.stderr) {
  return Boolean(stream?.isTTY) && process.env.TERM !== "dumb" && !process.env.CI;
}

function useColor(stream = process.stderr) {
  return isInteractive(stream) && !process.env.NO_COLOR;
}

function color(code, text, stream = process.stderr) {
  return useColor(stream) ? `\x1b[${code}m${text}\x1b[0m` : String(text);
}

function formatDuration(startedAt) {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function createSpinner(text, options = {}) {
  const stream = options.stream || process.stderr;
  const enabled = isInteractive(stream);
  const frames = ["-", "\\", "|", "/"];
  const startedAt = Date.now();
  let frame = 0;
  let currentText = text;
  let timer = null;
  let stopped = false;

  const render = () => {
    if (!enabled || stopped) return;
    readline.clearLine(stream, 0);
    readline.cursorTo(stream, 0);
    stream.write(`${color("36", frames[frame++ % frames.length], stream)} ${currentText}`);
  };

  if (enabled) {
    render();
    timer = setInterval(render, 80);
    timer.unref?.();
  } else if (!options.quiet) {
    stream.write(`${currentText}...\n`);
  }

  const finish = (status, message) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (enabled) {
      readline.clearLine(stream, 0);
      readline.cursorTo(stream, 0);
    }
    if (!options.quiet) {
      const marker = status === "ok" ? color("32", "OK", stream) : color("31", "FAIL", stream);
      stream.write(`${marker} ${message || currentText} (${formatDuration(startedAt)})\n`);
    }
  };

  return {
    update(message) {
      currentText = message;
      render();
    },
    succeed(message) {
      finish("ok", message);
    },
    fail(message) {
      finish("fail", message);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      if (enabled) {
        readline.clearLine(stream, 0);
        readline.cursorTo(stream, 0);
      }
    },
  };
}

function createProgress(label, total, options = {}) {
  const stream = options.stream || process.stderr;
  const enabled = isInteractive(stream);
  const width = Math.max(10, Math.min(30, Number(options.width) || 24));
  const startedAt = Date.now();
  let totalSteps = Math.max(0, Number(total) || 0);
  let completed = 0;
  let failed = 0;
  let detail = "";
  let stopped = false;

  const fitDetail = (value, baseLength) => {
    const text = String(value || "");
    const columns = Number(stream.columns) || 0;
    if (!columns || !text) return text;
    const available = Math.max(12, columns - baseLength - 2);
    if (text.length <= available) return text;
    return `${text.slice(0, Math.max(0, available - 3))}...`;
  };

  const render = () => {
    if (!enabled || stopped) return;
    const ratio = totalSteps ? Math.min(1, completed / totalSteps) : 1;
    const filled = Math.round(width * ratio);
    const bar = `${"=".repeat(filled)}${" ".repeat(width - filled)}`;
    const failures = failed ? color("31", ` ${failed} failed`, stream) : "";
    const prefix = `${color("36", label, stream)} [${bar}] ${completed}/${totalSteps}${failures}`;
    const plainPrefix = `${label} [${bar}] ${completed}/${totalSteps}${failed ? ` ${failed} failed` : ""}`;
    const fittedDetail = fitDetail(detail, plainPrefix.length);
    readline.clearLine(stream, 0);
    readline.cursorTo(stream, 0);
    stream.write(`${prefix}${fittedDetail ? `  ${fittedDetail}` : ""}`);
  };

  if (!enabled && !options.quiet) stream.write(`${label}: 0/${totalSteps}\n`);
  else render();

  return {
    setTotal(nextTotal) {
      totalSteps = Math.max(completed, Number(nextTotal) || 0);
      render();
    },
    update(value, nextDetail = "", nextFailed = failed) {
      completed = Math.max(0, Math.min(totalSteps, Number(value) || 0));
      failed = Math.max(0, Number(nextFailed) || 0);
      detail = nextDetail;
      render();
    },
    increment(nextDetail = "", wasFailure = false) {
      completed += 1;
      if (completed > totalSteps) totalSteps = completed;
      if (wasFailure) failed += 1;
      detail = nextDetail;
      render();
    },
    stop(message) {
      if (stopped) return;
      stopped = true;
      if (enabled) {
        readline.clearLine(stream, 0);
        readline.cursorTo(stream, 0);
      }
      if (!options.quiet) {
        const suffix = failed ? `, ${failed} failed` : "";
        stream.write(`${message || label}: ${completed}/${totalSteps}${suffix} (${formatDuration(startedAt)})\n`);
      }
    },
  };
}

module.exports = {
  color,
  createProgress,
  createSpinner,
  isInteractive,
};
