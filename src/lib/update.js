const { spawnSync } = require("node:child_process");

const DEFAULT_REPOSITORY = "iihciyekub/iiaide-wos-cli";

function resolveGitHubToken(options = {}) {
  const env = options.env || process.env;
  const environmentToken = String(env.GH_TOKEN || env.GITHUB_TOKEN || "").trim();
  if (environmentToken) return environmentToken;

  const run = options.run || spawnSync;
  const result = run("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

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

async function fetchLatestRelease(repository = DEFAULT_REPOSITORY, request = fetch, token = "") {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "iiaide-wos-cli",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await request(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers,
  });
  if (!response.ok) {
    if (response.status === 404) {
      const repoResponse = await request(`https://api.github.com/repos/${repository}`, { headers });
      if (repoResponse.ok) {
        throw new Error(
          `No GitHub Releases found for ${repository}. Create a release tag before running iiaide-wos update.`
        );
      }
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new Error(
        "Private GitHub release access failed. Run `gh auth login` or set GH_TOKEN with repository read access."
      );
    }
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
  const token = Object.hasOwn(options, "token")
    ? options.token
    : resolveGitHubToken({ env: options.env, run: options.authRun });
  const release = await fetchLatestRelease(repository, options.request || fetch, token);
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
  resolveGitHubToken,
  updateCli,
};
