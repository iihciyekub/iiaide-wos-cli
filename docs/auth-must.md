# MUST SID Producer Spec

## Goal

Integrate the existing MUST SSO SID producer into `iiaide-wos` without changing
the WOS download and parse contract. WOS workflows continue to consume only the
global saved SID pool. MUST account login is a separate producer that writes
fresh SIDs into that pool.

## Commands

```bash
iiaide-wos auth login --provider must
iiaide-wos auth monitor --provider must --min-sids 2 --interval-ms 3000
```

`auth login` performs one browser login, extracts a WOS SID, and saves it into
the global SID pool unless `--no-save` is supplied.

`auth monitor` polls the current global SID pool and runs the same login/save
step whenever `sidPoolCount <= min-sids`. `--min-sids` is a low-water mark, not
a target count; because each refresh adds one SID, a quiet pool usually settles
at `min-sids + 1`. `--threshold` remains a compatibility alias.

One account is enough to run the producer. Repeating account/password pairs is
only for rotation; each refresh still adds one SID at a time.

## Boundaries

- The producer uses its own short-lived Playwright browser context.
- WOS export, parse, validation, and browser-profile work keep using
  `<tasksRoot>/.browser-profile`.
- The global SID pool remains the handoff boundary between producers and WOS
  consumers.
- The producer must not store account usernames or passwords in task artifacts,
  SQLite, or the SID config.
- Routine output masks SID values. Full SID values are saved to config, not
  printed.
- The monitor writes a lightweight heartbeat to
  `~/.iiaide-wos/auth-monitor.json`; dashboards read this file as
  `SID Producer` and mark it stale when updates stop.
- WOS workflows can choose `Wait for SID pool` during SID setup to consume a SID
  produced by `auth monitor` without manual paste or browser login in that
  workflow.

## Credential Inputs

Supported sources, in priority order:

1. Repeated `--account <email>` and `--password <secret>` pairs.
2. `WOS_ACCOUNT` and `WOS_PASSWORD`.
3. Interactive prompts when stdin/stdout are TTYs.

Repeated pairs are used round-robin. Each retry advances to the next configured
account.

Prefer interactive prompts or environment variables. `--password` is supported
for automation but is less safe because process lists and shell history can
expose command arguments.

## MUST Flow

The default login URL is the MUST Shibboleth entry into Web of Science.

The browser flow:

1. Open the login URL.
2. Fill visible username and password fields.
3. Check the MUST privacy-policy checkbox when present.
4. Submit the login form.
5. Advance SAML/intermediate consent pages.
6. Extract `sessionData.BasicProperties.SID` from the WOS page or WOS session
   JSON responses.
7. Close the short-lived browser context.
8. Save the SID with the existing `addSidsToConfig()` pool helper.

## Output Contract

Plain output is one-line/milestone oriented:

```text
Auth login saved: SID ABCD...WXYZ pool=3
```

JSON output is safe by default and masks SID values:

```json
{
  "ok": true,
  "mode": "auth-login",
  "provider": "must",
  "saved": true,
  "sidMasked": "ABCD...WXYZ",
  "sidPoolCount": 3
}
```

Monitor output only reports pool counts, account indexes, and masked SID
summaries.

## Tests

- Argument parsing for `auth login` and `auth monitor`.
- Credential normalization, including repeated account/password pairs.
- `auth login` saves through the main SID pool helper.
- `auth monitor` triggers login when the pool count is at or below min-sids.
- Routine auth output does not print the full SID.
