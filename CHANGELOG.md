# Changelog

All notable changes are documented here. The version in `package.json` is the
authoritative CLI version.

## 0.2.0 - 2026-06-07

- Reject unsafe task IDs and malformed CLI option values.
- Make JSON and aggregate output writes atomic and report corrupt JSON files.
- Keep validation read-only and store new task paths relative to `tasks/`.
- Filter reused raw batches by UUID and reject overlapping batches.
- Preserve expected counts while rebuilding from raw files.
- Record failed run states and support `WOS_SID`.
- Add automated tests, CI, Node.js version metadata, and `--version`.
