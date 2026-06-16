function commandName(args = {}) {
  const command = String(args.command || "").trim();
  if (command === "auth") return `auth ${args.authCommand || "login"}`.trim();
  if (command === "query") return `query ${args.queryCommand || ""}`.trim();
  if (command === "record") return `record ${args.recordCommand || ""}`.trim();
  return command || "run";
}

function errorCode(error) {
  const rawCode = String(error?.code || "").trim();
  if (rawCode && rawCode !== "CLI_MESSAGE") return rawCode;
  const message = String(error?.message || error || "");
  if (/missing .*sid|no saved sid|sid pool empty/i.test(message)) return "SID_MISSING";
  if (/invalid .*sid|sid .*invalid|expired|logged out/i.test(message)) return "SID_INVALID";
  if (/wos\.js .*missing|browser API missing/i.test(message)) return "WOS_API_MISSING";
  if (/query.*failed|unknown query command|missing --expr|missing --text/i.test(message)) return "WOS_QUERY_FAILED";
  if (/did not return a UUID|uuid.*missing|missing.*uuid/i.test(message)) return "WOS_UUID_MISSING";
  if (/playwright|chromium|browser.*missing/i.test(message)) return "PLAYWRIGHT_MISSING";
  if (/task not found/i.test(message)) return "TASK_NOT_FOUND";
  if (/incomplete|missing batches/i.test(message)) return "TASK_INCOMPLETE";
  if (/output directory is not empty|already exists/i.test(message)) return "ARTIFACT_EXISTS";
  if (/unknown argument|missing value|invalid .* for|missing --|file not found|no query expressions|unsupported|unknown .*command/i.test(message)) return "INVALID_ARGS";
  return "UNKNOWN_ERROR";
}

function nextActionForCode(code) {
  if (code === "SID_MISSING" || code === "SID_INVALID") return "Run iiaide-wos sid --from-browser --json, or start iiaide-wos auth monitor.";
  if (code === "SID_POOL_EMPTY") return "Add a SID with iiaide-wos settings --add-sids, or run auth monitor.";
  if (code === "PLAYWRIGHT_MISSING") return "Run iiaide-wos install-browser.";
  if (code === "WOS_API_MISSING") return "Verify --wosjs points to import/wos.js and retry.";
  if (code === "TASK_NOT_FOUND") return "Run iiaide-wos list --json or pass an existing --task.";
  if (code === "ARTIFACT_EXISTS") return "Use a new --task or rerun with --force if replacement is intended.";
  return "";
}

function llmResult(args = {}, fields = {}) {
  const code = fields.code || (fields.ok === false ? "UNKNOWN_ERROR" : "OK");
  return {
    ok: fields.ok !== false,
    code,
    command: fields.command || commandName(args),
    taskId: fields.taskId || args.taskId || "",
    artifact: fields.artifact || "",
    uuid: fields.uuid || "",
    count: Number(fields.count || 0),
    message: fields.message || "",
    data: fields.data || {},
    ...(fields.nextAction ? { nextAction: fields.nextAction } : {}),
  };
}

function llmErrorResult(args = {}, error) {
  const code = errorCode(error);
  return llmResult(args, {
    ok: false,
    code,
    message: error?.message || String(error || "Unknown error"),
    nextAction: nextActionForCode(code),
  });
}

module.exports = {
  commandName,
  errorCode,
  llmErrorResult,
  llmResult,
  nextActionForCode,
};
