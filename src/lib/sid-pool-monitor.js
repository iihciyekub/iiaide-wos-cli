function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createProgressLogger(args, stream = process.stderr) {
  if (args.authQuiet || args.json) return () => {};
  return (message) => {
    stream.write(`${message}\n`);
  };
}

function normalizeAuthCredentials(args) {
  const accounts = args.authAccounts.length ? args.authAccounts : [args.authAccount];
  const passwords = args.authPasswords.length ? args.authPasswords : [args.authPassword];
  if (accounts.length !== passwords.length) {
    throw new Error("Repeated --account/--password values must be paired in the same order.");
  }
  const credentials = accounts
    .map((account, index) => ({
      account: String(account || "").trim(),
      password: String(passwords[index] || ""),
    }))
    .filter((credential) => credential.account && credential.password);
  if (!credentials.length) {
    throw new Error("Missing account. Use --account/--password, WOS_ACCOUNT/WOS_PASSWORD, or an interactive terminal.");
  }
  return credentials;
}

async function loginWithRetries(args, dependencies, progress = () => {}) {
  const credentials = normalizeAuthCredentials(args);
  const totalAttempts = args.authRetries + 1;
  let lastError = null;
  let nextCredentialIndex = Number.isInteger(args.authNextCredentialIndex) ? args.authNextCredentialIndex : 0;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const credentialIndex = nextCredentialIndex % credentials.length;
    const credential = credentials[credentialIndex];
    nextCredentialIndex = (credentialIndex + 1) % credentials.length;
    args.authNextCredentialIndex = nextCredentialIndex;
    const credentialHint = credentials.length > 1 ? ` with account ${credentialIndex + 1}/${credentials.length}` : "";

    try {
      progress(`progress auth ${attempt}/${totalAttempts}: starting MUST login${credentialHint}`);
      const result = await dependencies.login({
        account: credential.account,
        password: credential.password,
        url: args.authLoginUrl,
        headed: args.headed,
        timeoutMs: args.timeoutMs,
        onProgress: progress,
      });
      return {
        ...result,
        credentialIndex,
        credentialCount: credentials.length,
      };
    } catch (error) {
      lastError = error;
      progress(`progress auth ${attempt}/${totalAttempts}: login failed: ${error.message || error}`);
    }
  }

  throw lastError;
}

async function runAuthLogin(args, dependencies, options = {}) {
  const progress = options.progress || createProgressLogger(args, options.stream || process.stderr);
  const result = await loginWithRetries(args, dependencies, progress);
  let saveResult = null;
  if (args.authSave) {
    saveResult = dependencies.saveSid(result.sid);
    progress(`progress auth: saved SID ${dependencies.maskSid(result.sid)}`);
  }
  return {
    ok: true,
    mode: "auth-login",
    provider: args.authProvider,
    saved: Boolean(saveResult),
    sidMasked: dependencies.maskSid(result.sid),
    finalUrl: result.finalUrl,
    sidPoolCount: saveResult?.sidPoolCount || dependencies.currentSidPoolStatus().sidPoolCount,
    added: saveResult?.added || 0,
    credentialIndex: result.credentialIndex,
    credentialCount: result.credentialCount,
  };
}

function formatMonitorSnapshot(snapshot) {
  return `sidPoolCount=${snapshot.sidPoolCount} activeSid=${snapshot.activeSid || "none"}`;
}

async function monitorSidPool(args, dependencies, options = {}) {
  const progress = options.progress || createProgressLogger(args, options.stream || process.stderr);
  const sleepImpl = options.sleep || sleep;
  let checks = 0;
  let triggered = 0;
  let lastSnapshotText = "";
  let stopped = false;
  const stop = () => {
    stopped = true;
  };

  if (options.installSignalHandlers !== false) {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }

  progress(`progress auth monitor: checking SID pool every ${args.authIntervalMs}ms, min-sids <= ${args.authMinSids}`);
  dependencies.writeMonitorStatus?.({ status: "running", checks, triggered });
  try {
    while (!stopped) {
      checks += 1;
      const snapshot = dependencies.currentSidPoolStatus();
      dependencies.writeMonitorStatus?.({ status: "running", checks, triggered });
      const snapshotText = formatMonitorSnapshot(snapshot);
      if (snapshotText !== lastSnapshotText) {
        progress(`progress auth monitor: ${snapshotText}`);
        lastSnapshotText = snapshotText;
      }

      if (Number(snapshot.sidPoolCount || 0) <= args.authMinSids) {
        progress("progress auth monitor: SID pool low-water mark reached, refreshing SID");
        await runAuthLogin(args, dependencies, { progress });
        triggered += 1;
        dependencies.writeMonitorStatus?.({ status: "running", checks, triggered });
      }

      if (args.authMaxChecks && checks >= args.authMaxChecks) {
        progress(`progress auth monitor: reached max checks ${args.authMaxChecks}`);
        break;
      }

      await sleepImpl(args.authIntervalMs);
    }
  } finally {
    if (options.installSignalHandlers !== false) {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    dependencies.writeMonitorStatus?.({ status: "stopped", checks, triggered });
    if (stopped) progress("progress auth monitor: stopped");
  }

  return {
    ok: true,
    mode: "auth-monitor",
    provider: args.authProvider,
    checks,
    triggered,
    sidPool: dependencies.currentSidPoolStatus(),
  };
}

module.exports = {
  createProgressLogger,
  formatMonitorSnapshot,
  loginWithRetries,
  monitorSidPool,
  normalizeAuthCredentials,
  runAuthLogin,
  sleep,
};
