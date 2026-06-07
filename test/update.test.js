const assert = require("node:assert/strict");
const test = require("node:test");

const { compareVersions, fetchLatestRelease, resolveGitHubToken, updateCli } = require("../src/lib/update");

function releaseResponse(tag = "v0.3.0") {
  return async () => ({
    ok: true,
    async json() {
      return { tag_name: tag, html_url: `https://example.test/releases/${tag}` };
    },
  });
}

test("compares semantic versions", () => {
  assert.equal(compareVersions("0.3.0", "0.2.0"), 1);
  assert.equal(compareVersions("v0.3.0", "0.3.0"), 0);
  assert.equal(compareVersions("0.2.9", "0.3.0"), -1);
  assert.throws(() => compareVersions("latest", "0.3.0"), /Invalid semantic version/);
});

test("resolves GitHub credentials from environment or gh auth", () => {
  assert.equal(resolveGitHubToken({ env: { GH_TOKEN: "env-token" } }), "env-token");
  assert.equal(resolveGitHubToken({
    env: {},
    run(command, args) {
      assert.equal(command, "gh");
      assert.deepEqual(args, ["auth", "token"]);
      return { status: 0, stdout: "cli-token\n" };
    },
  }), "cli-token");
});

test("authenticates private GitHub release requests", async () => {
  let authorization = "";
  await fetchLatestRelease("owner/private-repo", async (_url, options) => {
    authorization = options.headers.authorization;
    return {
      ok: true,
      async json() {
        return { tag_name: "v0.3.1" };
      },
    };
  }, "private-token");
  assert.equal(authorization, "Bearer private-token");
});

test("explains private GitHub release access failures", async () => {
  await assert.rejects(
    fetchLatestRelease("owner/private-repo", async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
    })),
    /gh auth login/
  );
});

test("checks for updates without installing", async () => {
  let installed = false;
  const result = await updateCli({
    currentVersion: "0.2.0",
    checkOnly: true,
    token: "",
    request: releaseResponse(),
    run() {
      installed = true;
    },
  });

  assert.equal(result.status, "update-available");
  assert.equal(result.latestVersion, "0.3.0");
  assert.equal(installed, false);
});

test("installs the latest GitHub release tag", async () => {
  let command = null;
  let args = null;
  const result = await updateCli({
    currentVersion: "0.2.0",
    token: "",
    request: releaseResponse(),
    run(nextCommand, nextArgs) {
      command = nextCommand;
      args = nextArgs;
      return { status: 0 };
    },
  });

  assert.equal(result.status, "updated");
  assert.match(command, /^npm(?:\.cmd)?$/);
  assert.deepEqual(args, ["install", "--global", "github:iihciyekub/wos-aide-cli#v0.3.0"]);
});

test("does not reinstall an up-to-date version", async () => {
  const result = await updateCli({
    currentVersion: "0.3.0",
    token: "",
    request: releaseResponse(),
    run() {
      assert.fail("up-to-date version should not install");
    },
  });

  assert.equal(result.status, "up-to-date");
});
