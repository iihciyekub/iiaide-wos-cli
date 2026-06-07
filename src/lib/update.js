const { spawnSync } = require("node:child_process");

const DEFAULT_REPOSITORY = "iihciyekub/wos-aide-cli";

function parseVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

async function fetchLatestRelease(repository = DEFAULT_REPOSITORY, request = fetch) {
  const response = await request(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "wos-aide-cli",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub release check failed: HTTP ${response.status} ${response.statusText}`);
  }
  const release = await response.json();
  if (!release.tag_name) throw new Error("Latest GitHub release does not have a tag");
  return {
    tag: release.tag_name,
    version: String(release.tag_name).replace(/^v/, ""),
    url: release.html_url || `https://github.com/${repository}/releases/latest`,
  };
}

function installRelease(repository, tag, run = spawnSync) {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = run(executable, ["install", "--global", `github:${repository}#${tag}`], {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm install failed with exit code ${result.status}`);
}

async function updateCli(options = {}) {
  const currentVersion = options.currentVersion;
  const repository = options.repository || DEFAULT_REPOSITORY;
  const release = await fetchLatestRelease(repository, options.request || fetch);
  const comparison = compareVersions(currentVersion, release.version);
  if (comparison >= 0) {
    return { status: "up-to-date", currentVersion, latestVersion: release.version, releaseUrl: release.url };
  }
  if (options.checkOnly) {
    return { status: "update-available", currentVersion, latestVersion: release.version, releaseUrl: release.url };
  }
  options.onInstall?.({ repository, tag: release.tag, version: release.version });
  installRelease(repository, release.tag, options.run || spawnSync);
  return { status: "updated", currentVersion, latestVersion: release.version, releaseUrl: release.url };
}

module.exports = {
  DEFAULT_REPOSITORY,
  compareVersions,
  fetchLatestRelease,
  installRelease,
  parseVersion,
  updateCli,
};
