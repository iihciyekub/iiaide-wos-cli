const assert = require("node:assert/strict");
const test = require("node:test");

const { compareVersions, updateCli } = require("../src/lib/update");

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

test("checks for updates without installing", async () => {
  let installed = false;
  const result = await updateCli({
    currentVersion: "0.2.0",
    checkOnly: true,
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
    request: releaseResponse(),
    run() {
      assert.fail("up-to-date version should not install");
    },
  });

  assert.equal(result.status, "up-to-date");
});
