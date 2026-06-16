const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { auditCommandDocs } = require("./command-docs");
const {
  canonicalWosId,
  getArtifactEvents,
  getAuditRuns,
  getAuditTimeline,
  getResultsetContext,
  getResultsetMetadata,
  getSearchQueries,
  getRecordByWosId,
  getRelationMetadataForWosId,
  openWosDatabase,
} = require("./wos-sqlite");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3760;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const DEFAULT_EXPORT_STEM = "audit-report";

function auditHtmlTemplatePath() {
  return path.resolve(__dirname, "..", "..", "docs", "audit-view.html");
}

function readAuditHtmlTemplate() {
  return fs.readFileSync(auditHtmlTemplatePath(), "utf8");
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), MAX_LIMIT);
}

function normalizeAuditFilters(input = {}, defaults = {}) {
  return {
    uuid: String(input.uuid || defaults.uuid || "").trim(),
    wosid: canonicalWosId(input.wosid || defaults.wosid || ""),
    limit: clampLimit(input.limit || defaults.limit || DEFAULT_LIMIT),
  };
}

function readAuditOverview(db, options = {}) {
  const filters = normalizeAuditFilters(options);
  const timeline = getAuditTimeline(db, filters);
  const runs = getAuditRuns(db, {
    uuid: filters.uuid,
    limit: filters.limit,
  });
  const searches = getSearchQueries(db, {
    uuid: filters.uuid,
    wosid: filters.wosid,
    limit: filters.limit,
  });
  const artifacts = getArtifactEvents(db, {
    uuid: filters.uuid,
    limit: filters.limit,
  });
  return {
    filters,
    stats: {
      timeline: timeline.length,
      runs: runs.length,
      searches: searches.length,
      artifacts: artifacts.length,
    },
    timeline,
    runs,
    searches,
    artifacts,
  };
}

function buildAuditSnapshot(options = {}) {
  const {
    taskId = "",
    projectDir = "",
    sqlitePath = "",
    filters = {},
  } = options;
  const db = openWosDatabase(sqlitePath);
  try {
    return {
      ok: true,
      taskId,
      projectDir,
      sqlite: sqlitePath,
      generatedAt: new Date().toISOString(),
      commandDocs: auditCommandDocs(),
      ...readAuditOverview(db, filters),
    };
  } finally {
    db.close();
  }
}

function readAuditUuidDetail(db, uuid = "", options = {}) {
  const resultset = getResultsetMetadata(db, uuid);
  const records = resultset
    ? getResultsetContext(db, uuid, { limit: clampLimit(options.limit || 100, 100) })
    : [];
  return {
    uuid: String(uuid || "").trim(),
    resultset,
    count: resultset?.itemCount || 0,
    records,
  };
}

function readAuditWosidDetail(db, wosid = "") {
  const id = canonicalWosId(wosid);
  const record = getRecordByWosId(db, id);
  const relations = getRelationMetadataForWosId(db, id);
  return {
    wosid: id,
    record,
    relations: {
      citations: relations.filter((item) => item.kind === "citations"),
      references: relations.filter((item) => item.kind === "references"),
      related: relations.filter((item) => item.kind === "related"),
    },
  };
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function textResponse(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(text);
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const DISPLAY_TIME_KEYS = new Set([
  "createdAt",
  "finishedAt",
  "timestamp",
  "startedAt",
  "generatedAt",
  "observedAt",
  "firstSeenAt",
  "lastSeenAt",
  "updatedAt",
  "completedAt",
]);

function formatLocalDateTime(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, "0");
  const tzName = Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value || "";
  const localDate = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-");
  return `${localDate} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${tzName ? ` ${tzName}` : ""}`;
}

function localizeDisplayTimes(value, key = "") {
  if (typeof value === "string" && DISPLAY_TIME_KEYS.has(key)) return formatLocalDateTime(value);
  if (Array.isArray(value)) return value.map((item) => localizeDisplayTimes(item));
  if (!value || typeof value !== "object") return value;
  const copy = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    copy[entryKey] = localizeDisplayTimes(entryValue, entryKey);
  }
  return copy;
}

function wosSummaryUrl(uuid, sortBy = "relevance") {
  return `https://www.webofscience.com/wos/woscc/summary/${encodeURIComponent(uuid)}/${encodeURIComponent(sortBy || "relevance")}/1`;
}

function renderAuditSnapshotHtml(snapshot = {}) {
  const stats = snapshot.stats || {};
  const filters = snapshot.filters || {};
  const timeline = Array.isArray(snapshot.timeline) ? snapshot.timeline : [];
  const runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
  const searches = Array.isArray(snapshot.searches) ? snapshot.searches : [];
  const artifacts = Array.isArray(snapshot.artifacts) ? snapshot.artifacts : [];
  const commandDocs = Array.isArray(snapshot.commandDocs) ? snapshot.commandDocs : [];
  const commandWosid = filters.wosid || "WOS:000000000000001";
  const renderCommandTemplate = (command = "") => String(command || "").replaceAll("WOS:000000000000001", commandWosid);
  const commandNav = commandDocs.map((page, index) => `
    <button type="button" data-command-page="${index}" class="${index === 0 ? "active" : ""}">
      ${escapeHtml(page.title || "")}
    </button>
  `).join("");
  const copyIcon = () => `
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
    <span class="sr-only">Copy command</span>
  `;
  const checkIcon = () => `
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5"></path>
    </svg>
    <span class="sr-only">Copied</span>
  `;
  const runPill = (item = {}) => item.runId ? `<div class="run-pill mono"><span class="run-pill-label">Run ID</span><span class="run-pill-value">${escapeHtml(item.runId)}</span></div>` : "";
  const commandPages = commandDocs.map((page, index) => `
    <div class="command-page ${index === 0 ? "active" : ""}" data-command-panel="${index}">
      <div class="commands-head panel">
        <div class="commands-head-top">
          <div>
            <div class="commands-eyebrow">${escapeHtml(page.eyebrow || "")}</div>
            <div class="commands-doc-title">${escapeHtml(page.title || "")}</div>
          </div>
          <div class="commands-page-indicator">${escapeHtml(String(index + 1))} / ${escapeHtml(String(commandDocs.length || 1))}</div>
        </div>
        <div class="commands-summary">${escapeHtml(page.summary || "")}</div>
        <div class="commands-vars">
          <label class="commands-var-label">WOSID</label>
          <input class="commands-var-input" data-command-wosid value="${escapeHtml(commandWosid)}" spellcheck="false">
        </div>
      </div>
      <div class="commands-sections">${(page.sections || []).map((section) => `
        <section class="panel command-card">
          <div class="command-card-head">
            <div class="command-card-title">${escapeHtml(section.title || "")}</div>
          </div>
          <div class="command-blocks">${(section.commands || []).map((command) => `
            <div class="command-line">
              <code>${escapeHtml(renderCommandTemplate(command))}</code>
              <button type="button" class="copy-icon" data-copy-command="${escapeHtml(renderCommandTemplate(command))}" data-command-template="${escapeHtml(command)}" aria-label="Copy command" title="Copy command">${copyIcon()}</button>
            </div>
          `).join("")}</div>
          <div class="command-notes">${(section.notes || []).map((note) => `<div class="command-note">${escapeHtml(note)}</div>`).join("")}</div>
        </section>
      `).join("")}</div>
    </div>
  `).join("");
  const itemUuid = (item = {}) => item.uuid || item.resultset?.uuid || item.data?.uuid || "";
  const itemSortBy = (item = {}) => item.sortBy || item.data?.sortBy || item.data?.summary?.sortBy || "relevance";
  const itemSourceWosId = (item = {}) => item.sourceWosId || item.source_wosid || item.data?.sourceWosId || item.data?.source_wosid || item.data?.summary?.sourceWosId || "";
  const itemQueryText = (item = {}) => item.queryText || item.data?.queryText || item.data?.summary?.queryText || item.data?.summary?.rowText || item.data?.summary?.source?.value || "";
  const uuidLink = (uuid, sortBy = "relevance") => uuid ? `<a class="mini mono" href="${escapeHtml(wosSummaryUrl(uuid, sortBy))}" data-uuid="${escapeHtml(uuid)}" target="_blank" rel="noreferrer noopener">${escapeHtml(uuid)}</a>` : "";
  const wosidLink = (wosid) => wosid ? `<span class="mini mono">${escapeHtml(wosid)}</span>` : "";
  const itemMeta = (item = {}) => {
    const uuid = itemUuid(item);
    const sortBy = itemSortBy(item);
    const sourceWosId = itemSourceWosId(item);
    const parts = [];
    if (uuid) parts.push(`<div class="key">UUID</div><div>${uuidLink(uuid, sortBy)}</div>`);
    if (sourceWosId) parts.push(`<div class="key">WOSID</div><div>${wosidLink(sourceWosId)}</div>`);
    if (Object.prototype.hasOwnProperty.call(item, "count")) parts.push(`<div class="key">Count</div><div>${escapeHtml(item.count ?? "")}</div>`);
    if (item.runId) parts.push(`<div class="key">Run ID</div><div class="mono">${escapeHtml(item.runId || "")}</div>`);
    if (item.role) parts.push(`<div class="key">Role</div><div>${escapeHtml(item.role || "")}</div>`);
    if (item.path) parts.push(`<div class="key">Path</div><div class="mono">${escapeHtml(item.path || "")}</div>`);
    return parts.length ? `<div class="kv">${parts.join("")}</div>` : "";
  };
  const itemBlock = (title, items) => {
    if (!items.length) return `<section class="panel"><h2>${escapeHtml(title)}</h2><div class="empty">No rows</div></section>`;
    return `<section class="panel"><h2>${escapeHtml(title)}</h2>${items.map((item) => `
      <article class="item">
        ${runPill(item)}
        <div class="item-head">
          <div class="item-badges">
            <span class="badge">${escapeHtml(item.type || item.command || item.role || item.kind || title)}</span>
            ${item.ok === true ? '<span class="badge ok">ok</span>' : ""}
            ${item.ok === false ? '<span class="badge fail">failed</span>' : ""}
          </div>
        <span class="time">${escapeHtml(formatLocalDateTime(item.timestamp || item.finishedAt || item.createdAt || ""))}</span>
        </div>
        <div class="item-summary">${escapeHtml(item.operation || item.queryText || item.path || item.command || title)}</div>
        ${itemMeta(item)}
        <pre>${escapeHtml(JSON.stringify(localizeDisplayTimes(item), null, 2))}</pre>
      </article>
    `).join("")}</section>`;
  };
  const timelineBlock = !timeline.length
    ? `<section class="panel"><h2>Timeline</h2><div class="empty">No rows</div></section>`
    : `<section class="panel"><h2>Timeline</h2>${timeline.map((item) => `
      <details class="item timeline-item">
        <summary>
          <div class="timeline-summary">
            <div class="item-head">
              <div class="item-badges">
                <span class="badge">${escapeHtml(item.type || item.command || "Timeline")}</span>
                ${item.ok === true ? '<span class="badge ok">ok</span>' : ""}
                ${item.ok === false ? '<span class="badge fail">failed</span>' : ""}
              </div>
              <span class="time">${escapeHtml(formatLocalDateTime(item.timestamp || item.finishedAt || item.createdAt || ""))}</span>
            </div>
            <div class="item-summary">${escapeHtml(item.operation || item.queryText || item.path || item.command || "Timeline")}</div>
            ${itemMeta(item)}
            ${itemQueryText(item) ? `<div class="timeline-field"><div class="key">Query text</div><div class="value mono">${escapeHtml(itemQueryText(item))}</div></div>` : ""}
            <div class="timeline-toggle">Expand details</div>
          </div>
        </summary>
        <div class="timeline-body">
          <pre>${escapeHtml(JSON.stringify(localizeDisplayTimes(item), null, 2))}</pre>
        </div>
      </details>
    `).join("")}</section>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WOS Audit Report</title>
  <style>
    :root { color-scheme: light; --bg:#ffffff; --panel:#ffffff; --panel-2:#f7f7f8; --text:#202123; --muted:#6e6e80; --line:#ececf1; --line-strong:#d9d9e3; --accent:#111111; --accent-soft:#f4f4f6; --ok:#0f766e; --bad:#b42318; --shadow:none; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font:13px/1.42 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { max-width:1280px; margin:0 auto; padding:16px 20px 28px; display:grid; gap:12px; }
    h1,h2,p { margin:0; }
    h1 { font-size:20px; font-weight:600; letter-spacing:0; }
    h2 { font-size:15px; font-weight:600; }
    .hero,.panel,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:10px; box-shadow:var(--shadow); }
    .hero { display:grid; gap:4px; }
    .meta { color:var(--muted); word-break:break-all; font-size:12px; }
    .stats { display:grid; gap:10px; grid-template-columns:repeat(4,minmax(0,1fr)); }
    .stat span { color:var(--muted); font-size:12px; text-transform:uppercase; }
    .stat strong { display:block; font-size:20px; font-weight:600; margin-top:4px; }
    .grid { display:grid; gap:12px; grid-template-columns:minmax(0,1.75fr) minmax(280px,.75fr); }
    .stack { display:grid; gap:12px; align-content:start; }
    .panel h2 { margin-bottom:8px; }
    .timeline-panel { position:relative; }
    .timeline-panel::before { content:""; position:absolute; left:20px; top:48px; bottom:14px; width:1px; background:var(--line-strong); }
    .timeline-panel .item { position:relative; margin-left:28px; }
    .timeline-panel .item::before { content:""; position:absolute; left:-24px; top:16px; width:9px; height:9px; border-radius:999px; background:#fff; border:2px solid var(--accent); }
    .timeline-panel .item.is-open::before { background:var(--accent); }
    .item { border-top:1px solid var(--line); padding-top:10px; margin-top:10px; }
    .item:first-of-type { border-top:0; padding-top:0; margin-top:0; }
    .run-pill { display:inline-flex; align-items:center; gap:6px; width:fit-content; max-width:100%; padding:3px 9px; border-radius:999px; border:1px solid var(--line-strong); background:#fafafa; color:var(--text); font-size:12px; font-weight:600; }
    .run-pill .run-pill-label { color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:0; font-size:11px; }
    .run-pill .run-pill-value { min-width:0; }
    .item-head { display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
    .item-badges { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
    .badge { display:inline-flex; padding:2px 7px; border-radius:999px; background:var(--accent-soft); color:var(--muted); border:1px solid var(--line); }
    .badge.ok { color:var(--ok); }
    .badge.fail { color:var(--bad); }
    .time { color:var(--muted); }
    .item-summary { font-size:13px; color:var(--text); margin-bottom:6px; }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; color:#353740; background:#f7f7f8; border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
    .empty { color:var(--muted); background:#fbfbfd; border:1px dashed var(--line); border-radius:8px; padding:16px; }
    details.item { padding:0; overflow:hidden; }
    details.item summary { list-style:none; cursor:pointer; display:grid; gap:8px; padding:10px; }
    details.item summary::-webkit-details-marker { display:none; }
    .timeline-summary { display:grid; gap:8px; }
    .timeline-field { display:grid; grid-template-columns:96px minmax(0,1fr); gap:4px 8px; align-items:start; font-size:12px; }
    .timeline-field .key { color:var(--muted); }
    .timeline-field .value { min-width:0; }
    .timeline-body { padding:0 10px 10px; display:grid; gap:8px; border-top:1px solid var(--line); background:linear-gradient(to bottom, rgba(247,247,248,.78), rgba(255,255,255,0)); }
    .timeline-toggle { color:var(--muted); font-size:12px; font-weight:600; }
    .manual-grid { display:grid; gap:12px; grid-template-columns:220px minmax(0,1fr); align-items:start; }
    .commands-head, .command-card { background:var(--panel); border:1px solid var(--line); border-radius:8px; box-shadow:var(--shadow); }
    .commands-nav { display:grid; gap:8px; position:sticky; top:16px; padding:2px 0 2px 12px; border-left:1px solid var(--line-strong); background:transparent; box-shadow:none; }
    .commands-main, .commands-sections { display:grid; gap:10px; }
    .commands-head { padding:10px; }
    .commands-head-top { display:flex; justify-content:space-between; gap:10px; align-items:center; flex-wrap:nowrap; }
    .commands-eyebrow { color:var(--muted); font-size:12px; }
    .commands-title, .commands-doc-title { font-size:18px; font-weight:600; }
    .commands-nav .commands-title { font-size:13px; }
    .commands-nav .commands-summary { display:none; }
    .commands-summary { color:var(--muted); font-size:12px; }
    .commands-vars { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding-top:8px; }
    .commands-var-label { color:var(--muted); font-size:12px; font-weight:600; }
    .commands-var-input { min-width:min(360px, 100%); height:30px; border:1px solid var(--line); border-radius:6px; background:#fff; color:var(--text); padding:0 9px; font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .commands-page-list { display:grid; gap:6px; padding-bottom:0; }
    .commands-page-list button { width:100%; justify-content:flex-start; border:0; border-radius:6px; background:transparent; box-shadow:var(--shadow); padding:5px 8px; color:var(--muted); font-size:13px; text-align:left; }
    .commands-page-list button.active { background:var(--accent-soft); color:var(--accent); box-shadow:var(--shadow); font-weight:600; }
    .commands-page-indicator { color:var(--muted); font-size:13px; }
    .command-page { display:none; }
    .command-page.active { display:grid; gap:10px; }
    .command-card { padding:10px; display:grid; gap:10px; }
    .command-card-head { display:flex; justify-content:space-between; gap:10px; align-items:center; flex-wrap:wrap; }
    .command-card-title { font-size:14px; font-weight:600; }
    .command-blocks { display:grid; gap:8px; }
    .command-line { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px; align-items:center; border:1px solid var(--line); border-radius:8px; background:#f7f7f8; padding:7px 7px 7px 10px; }
    .command-line code { white-space:pre-wrap; word-break:break-word; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; color:#202123; }
    .copy-icon { width:28px; height:28px; padding:0; display:inline-grid; place-items:center; border-radius:6px; color:var(--muted); background:transparent; }
    .copy-icon:hover { background:#fff; color:var(--text); }
    .copy-icon svg { width:14px; height:14px; stroke:currentColor; }
    .nav-icon { width:14px; height:14px; stroke:currentColor; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
    .command-notes { display:grid; gap:6px; }
    .command-note { color:var(--muted); font-size:13px; padding-left:14px; position:relative; }
    .command-note::before { content:""; position:absolute; left:0; top:8px; width:5px; height:5px; border-radius:999px; background:var(--line-strong); }
    button { border:1px solid var(--line-strong); background:var(--panel); color:var(--text); border-radius:8px; padding:7px 10px; box-shadow:var(--shadow); cursor:pointer; font:inherit; white-space:nowrap; }
    .mini { color:#0f172a; text-decoration:none; cursor:pointer; }
    button.mini { border:0; background:transparent; padding:0; box-shadow:none; }
    .mini:hover { text-decoration:underline; }
    .time { color:var(--muted); font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid rgba(217,217,227,.8); background:rgba(255,255,255,.7); white-space:nowrap; }
    .segmented { display:inline-flex; align-items:center; gap:4px; padding:4px; background:#f0f0f2; border:1px solid var(--line); border-radius:999px; box-shadow:inset 0 1px 0 rgba(255,255,255,.8); width:fit-content; max-width:100%; }
    .segmented button { width:auto; min-width:0; border:0; border-radius:999px; background:transparent; box-shadow:none; padding:7px 13px; color:var(--muted); font-weight:600; }
    .segmented button.active { background:#fff; color:var(--accent); box-shadow:0 1px 2px rgba(16,24,40,.08), inset 0 1px 0 rgba(255,255,255,.95); }
    .segmented button:hover:not(.active) { background:rgba(255,255,255,.4); }
    @media (max-width:960px) { .stats,.grid,.manual-grid { grid-template-columns:1fr; } .commands-nav { position:static; } }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>WOS Audit Report</h1>
      <p class="meta">${escapeHtml(snapshot.taskId || "")}</p>
      <p class="meta">${escapeHtml(snapshot.projectDir || "")}</p>
      <p class="meta">${escapeHtml(snapshot.sqlite || "")}</p>
      <p class="meta">Generated at ${escapeHtml(formatLocalDateTime(snapshot.generatedAt || ""))}</p>
    </section>
    <section class="stats">
      <div class="stat"><span>Timeline</span><strong>${escapeHtml(stats.timeline || 0)}</strong></div>
      <div class="stat"><span>Runs</span><strong>${escapeHtml(stats.runs || 0)}</strong></div>
      <div class="stat"><span>Searches</span><strong>${escapeHtml(stats.searches || 0)}</strong></div>
      <div class="stat"><span>Artifacts</span><strong>${escapeHtml(stats.artifacts || 0)}</strong></div>
    </section>
    <section class="grid">
      <div class="stack">
        <div class="timeline-panel">${timelineBlock}</div>
        ${itemBlock("Runs", runs)}
      </div>
      <div class="stack">
        <section class="panel"><h2>Filters</h2><pre>${escapeHtml(JSON.stringify(localizeDisplayTimes(filters), null, 2))}</pre></section>
        ${itemBlock("Searches", searches)}
        ${itemBlock("Artifacts", artifacts)}
      </div>
    </section>
    <section class="manual-grid">
      <div class="commands-nav">
        <div class="commands-eyebrow">Command Manual</div>
        <div class="commands-title">CLI Help</div>
        <div class="commands-summary">The same workflow manual used in the live audit workspace is archived here for later review.</div>
        <div class="commands-page-list">${commandNav}</div>
      </div>
      <div class="commands-main">${commandPages}</div>
    </section>
  </main>
  <script>
    function escapeHtml(text) {
      return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }
    function checkIcon() {
      return '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg><span class="sr-only">Copied</span>';
    }
    function commandWosid() {
      return document.querySelector("[data-command-wosid]")?.value.trim() || "WOS:000000000000001";
    }
    function renderCommandTemplate(command) {
      return String(command || "").replaceAll("WOS:000000000000001", commandWosid());
    }
    function refreshCommands() {
      const current = commandWosid();
      for (const input of document.querySelectorAll("[data-command-wosid]")) {
        if (input.value !== current) input.value = current;
      }
      for (const button of document.querySelectorAll("[data-command-template]")) {
        const command = renderCommandTemplate(button.getAttribute("data-command-template") || "");
        button.setAttribute("data-copy-command", command);
        const code = button.closest(".command-line")?.querySelector("code");
        if (code) code.textContent = command;
      }
    }
    document.body.addEventListener("input", (event) => {
      if (event.target.closest("[data-command-wosid]")) refreshCommands();
    });
    document.body.addEventListener("click", (event) => {
      const pageButton = event.target.closest("[data-command-page]");
      if (pageButton) {
        const nextPage = pageButton.getAttribute("data-command-page");
        for (const button of document.querySelectorAll("[data-command-page]")) {
          button.classList.toggle("active", button.getAttribute("data-command-page") === nextPage);
        }
        for (const panel of document.querySelectorAll("[data-command-panel]")) {
          panel.classList.toggle("active", panel.getAttribute("data-command-panel") === nextPage);
        }
        return;
      }
      const commandNode = event.target.closest("[data-copy-command]");
      if (commandNode) {
        const previous = commandNode.innerHTML;
        navigator.clipboard.writeText(commandNode.getAttribute("data-copy-command") || "");
        commandNode.innerHTML = checkIcon();
        setTimeout(() => { commandNode.innerHTML = previous; }, 900);
        return;
      }
      const details = event.target.closest("details.timeline-item");
      if (details && event.target.closest("summary")) {
        queueMicrotask(() => {
          details.classList.toggle("is-open", details.open);
          const toggle = details.querySelector(".timeline-toggle");
          if (toggle) toggle.textContent = details.open ? "Collapse details" : "Expand details";
        });
      }
    });
  </script>
</body>
</html>`;
}

function auditExportFilePaths(outputDir, stem = DEFAULT_EXPORT_STEM) {
  return {
    html: path.join(outputDir, `${stem}.html`),
    json: path.join(outputDir, `${stem}.json`),
  };
}

function exportAuditSnapshot(options = {}) {
  const {
    taskId = "",
    projectDir = "",
    sqlitePath = "",
    outputDir,
    format = "both",
    filters = {},
    writeFile = fs.writeFileSync,
  } = options;
  if (!outputDir) throw new Error("Missing outputDir for audit snapshot export");
  const normalizedFormat = String(format || "both").trim().toLowerCase();
  if (!["html", "json", "both"].includes(normalizedFormat)) {
    throw new Error(`Unsupported audit export format: ${format}`);
  }
  const snapshot = buildAuditSnapshot({
    taskId,
    projectDir,
    sqlitePath,
    filters,
  });
  fs.mkdirSync(outputDir, { recursive: true });
  const files = auditExportFilePaths(outputDir);
  if (normalizedFormat === "html" || normalizedFormat === "both") {
    writeFile(files.html, renderAuditSnapshotHtml(snapshot), "utf8");
  }
  if (normalizedFormat === "json" || normalizedFormat === "both") {
    writeFile(files.json, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
  return {
    snapshot,
    outputDir,
    files: {
      html: normalizedFormat === "json" ? "" : files.html,
      json: normalizedFormat === "html" ? "" : files.json,
    },
    format: normalizedFormat,
  };
}

function createAuditHtmlServer(options = {}) {
  const {
    taskId = "",
    sqlitePath,
    projectDir = "",
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    defaultFilters = {},
  } = options;

  if (!sqlitePath) throw new Error("Missing sqlitePath for audit HTML server");
  const html = readAuditHtmlTemplate().replace(
    "\"__COMMAND_DOCS_JSON__\"",
    JSON.stringify(auditCommandDocs())
  );

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${host}`);
    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
      return textResponse(res, 200, html, "text/html; charset=utf-8");
    }
    if (requestUrl.pathname === "/api/overview") {
      const db = openWosDatabase(sqlitePath);
      try {
        return jsonResponse(res, 200, {
          ok: true,
          taskId,
          projectDir,
          sqlite: sqlitePath,
          generatedAt: new Date().toISOString(),
          ...readAuditOverview(db, {
            ...defaultFilters,
            uuid: requestUrl.searchParams.get("uuid"),
            wosid: requestUrl.searchParams.get("wosid"),
            limit: requestUrl.searchParams.get("limit"),
          }),
        });
      } finally {
        db.close();
      }
    }
    if (requestUrl.pathname === "/api/commands") {
      return jsonResponse(res, 200, {
        ok: true,
        pages: auditCommandDocs(),
      });
    }
    if (requestUrl.pathname === "/api/uuid") {
      const uuid = String(requestUrl.searchParams.get("uuid") || "").trim();
      const db = openWosDatabase(sqlitePath);
      try {
        return jsonResponse(res, 200, {
          ok: true,
          taskId,
          sqlite: sqlitePath,
          ...readAuditUuidDetail(db, uuid, {
            limit: requestUrl.searchParams.get("limit"),
          }),
        });
      } finally {
        db.close();
      }
    }
    if (requestUrl.pathname === "/api/wosid") {
      const wosid = String(requestUrl.searchParams.get("wosid") || "").trim();
      const db = openWosDatabase(sqlitePath);
      try {
        return jsonResponse(res, 200, {
          ok: true,
          taskId,
          sqlite: sqlitePath,
          ...readAuditWosidDetail(db, wosid),
        });
      } finally {
        db.close();
      }
    }
    return jsonResponse(res, 404, {
      ok: false,
      error: "Not found",
      path: requestUrl.pathname,
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const resolvedPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        host,
        port: resolvedPort,
        url: `http://${host}:${resolvedPort}/`,
      });
    });
  });
}

module.exports = {
  DEFAULT_AUDIT_HTML_HOST: DEFAULT_HOST,
  DEFAULT_AUDIT_HTML_PORT: DEFAULT_PORT,
  DEFAULT_AUDIT_HTML_LIMIT: DEFAULT_LIMIT,
  DEFAULT_AUDIT_EXPORT_STEM: DEFAULT_EXPORT_STEM,
  MAX_AUDIT_HTML_LIMIT: MAX_LIMIT,
  auditHtmlTemplatePath,
  auditExportFilePaths,
  buildAuditSnapshot,
  exportAuditSnapshot,
  normalizeAuditFilters,
  readAuditOverview,
  readAuditUuidDetail,
  readAuditWosidDetail,
  renderAuditSnapshotHtml,
  createAuditHtmlServer,
};
