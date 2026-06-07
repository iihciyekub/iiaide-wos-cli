# Changelog

All notable changes are documented here. The version in `package.json` is the
authoritative CLI version.

## 0.3.1 - 2026-06-07

- Make the GitHub repository and all Releases private.
- Authenticate private Release checks with `GH_TOKEN`, `GITHUB_TOKEN`, or
  credentials from `gh auth login`.
- Prevent accidental publication to the public npm Registry.

## 0.3.0 - 2026-06-07

- Rename the project to `wos-aide-cli` and make `wos-aide` the primary command.
- Remove the old command aliases and old CLI source entrypoints.
- Add a dependency-free, responsive startup dashboard inspired by modern interactive CLIs.
- Add TTY-aware spinners and progress bars for SID validation, exports, and author fetching.
- Add CSV-to-task import for existing WOS ID lists.
- Reframe documentation around WOS interaction and complete task-package delivery.
- Add a complete Chinese user demo for URL/UUID and CSV workflows.
- Remove the unused legacy `runs/` output directory convention.
- Add `init` and `workspace` commands for explicit cwd-scoped Task workspaces.
- Prevent invalid imports from leaving an empty Task workspace behind.
- Redact SID values from manifests and restrict `--force` cleanup to managed Task directories.
- Store new author checkpoint artifact paths relative to the Task for portability.
- Allow completed author Tasks to finish locally without launching Chromium or requiring a SID.
- Prompt securely for missing SIDs and allow expired SIDs to be replaced and revalidated immediately.
- Add `wos-aide update` and `wos-aide update --check` using stable GitHub Releases.
- Verify the test suite on Windows, macOS, and Linux.
- Allow npm packaging and document GitHub checkout installation.

## 0.2.0 - 2026-06-07

- Reject unsafe task IDs and malformed CLI option values.
- Make JSON and aggregate output writes atomic and report corrupt JSON files.
- Keep validation read-only and store new task paths relative to `tasks/`.
- Filter reused raw batches by UUID and reject overlapping batches.
- Preserve expected counts while rebuilding from raw files.
- Record failed run states and support `WOS_SID`.
- Add automated tests, CI, Node.js version metadata, and `--version`.
