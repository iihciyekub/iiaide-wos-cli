const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { version: PLAYWRIGHT_VERSION } = require("playwright/package.json");

function bundledPlaywrightCliPath(resolvePackage = require.resolve) {
  const packageJsonPath = resolvePackage("playwright/package.json");
  const cliPath = path.join(path.dirname(packageJsonPath), "cli.js");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`Bundled Playwright CLI not found at ${cliPath}`);
  }
  return cliPath;
}

function bundledPlaywrightInstallCommand(options = {}) {
  return `iiaide-wos install-browser${options.withDeps ? " --with-deps" : ""}`;
}

function isMissingPlaywrightBrowserError(error) {
  const message = String(error?.message || error || "");
  return (
    /browserType\.launchPersistentContext: Executable doesn't exist/i.test(message) ||
    /Executable doesn't exist at .*playwright/i.test(message) ||
    /Please run the following command to download new browsers/i.test(message)
  );
}

function installBundledPlaywrightBrowser(options = {}) {
  const cliPath = options.cliPath || bundledPlaywrightCliPath(options.resolvePackage || require.resolve);
  const browser = options.browser || "chromium";
  const argv = [cliPath, "install"];
  if (options.withDeps) argv.push("--with-deps");
  argv.push(browser);
  const result = (options.run || spawnSync)(process.execPath, argv, {
    encoding: "utf8",
    env: options.env || process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Bundled Playwright browser install failed with exit code ${result.status}`);
  }
  return {
    browser,
    cliPath,
    version: options.version || PLAYWRIGHT_VERSION,
    withDeps: Boolean(options.withDeps),
  };
}

module.exports = {
  PLAYWRIGHT_VERSION,
  bundledPlaywrightCliPath,
  bundledPlaywrightInstallCommand,
  installBundledPlaywrightBrowser,
  isMissingPlaywrightBrowserError,
};
