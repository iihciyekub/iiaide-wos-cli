const fs = require("node:fs");
const { callWosBrowserApi, jsonSafe } = require("./wos-browser-bridge");

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const input = String(text || "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function dedupe(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const item = String(value || "").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function normalizeWosIdInput(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const fullRecordMatch = text.match(/\/full-record\/([^/?#\s]+)/i);
  if (!fullRecordMatch) return text;
  try {
    return decodeURIComponent(fullRecordMatch[1]).trim();
  } catch (_) {
    return String(fullRecordMatch[1] || "").trim();
  }
}

function readIdsCsv(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  if (!rows.length) return { wosIds: [], dois: [] };
  const headers = rows[0].map((cell) => cell.trim());
  const wosIndex = headers.findIndex((cell) => /^(wos[\s_-]*id|ut)$/i.test(cell));
  const doiIndex = headers.findIndex((cell) => /^doi$/i.test(cell));
  const hasHeader = wosIndex >= 0 || doiIndex >= 0;
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const fallbackIndex = hasHeader ? -1 : 0;
  return {
    wosIds: dedupe(dataRows.map((row) => normalizeWosIdInput(row[wosIndex >= 0 ? wosIndex : fallbackIndex])).filter(Boolean)),
    dois: dedupe(dataRows.map((row) => String(row[doiIndex] || "").trim()).filter(Boolean)),
  };
}

function queryTextForIds(wosIds = [], dois = []) {
  const parts = [];
  if (wosIds.length) parts.push(`UT=(${wosIds.join(" OR ")})`);
  if (dois.length) parts.push(`DO=(${dois.join(" OR ")})`);
  return parts.join(" OR ");
}

function normalizeCount(value) {
  return Number(String(value ?? "").replace(/,/g, "").match(/\d+/)?.[0] || 0);
}

function normalizeUuidResult(raw, defaults = {}) {
  const source = defaults.source || {};
  const data = raw && typeof raw === "object" ? raw : {};
  const uuid = data.uuid || data.QueryID || defaults.uuid || "";
  const count = normalizeCount(data.ref_count ?? data.expectedCount ?? data.count ?? data.total ?? defaults.count);
  const rowText = data.rowText || data.queryText || defaults.rowText || "";
  const status = data.status || (uuid ? "success" : "failed");
  const result = {
    ok: status !== "failed" && Boolean(uuid),
    taskId: defaults.taskId || "",
    operation: defaults.operation || "",
    uuid,
    count,
    rowText,
    source,
  };
  if (!result.ok) {
    result.error = data.error_code || data.message || defaults.error || "WOS command did not return a UUID";
  }
  return result;
}

async function fetchCurrentPageUuidInfo(page, note = "") {
  return callWosBrowserApi(page, "results.fetchCurrentPageInfo", [note]);
}

async function runQueryBrowserCommand(page, args) {
  if (args.queryCommand === "build") {
    const raw = await callWosBrowserApi(page, "query.buildQuery", [args.queryExpr]);
    return normalizeUuidResult(raw, {
      taskId: args.taskId,
      operation: "query build",
      rowText: args.queryExpr,
      source: { kind: "expr", value: args.queryExpr },
    });
  }
  if (args.queryCommand === "parse") {
    const rowText = await callWosBrowserApi(page, "query.parseQueryWithSearchEngine", [args.queryText]);
    const raw = await fetchCurrentPageUuidInfo(page, rowText || args.queryText);
    return normalizeUuidResult(raw, {
      taskId: args.taskId,
      operation: "query parse",
      rowText: rowText || args.queryText,
      source: { kind: "text", value: args.queryText },
    });
  }
  if (args.queryCommand === "ids") {
    const csvIds = args.csvPath ? readIdsCsv(args.csvPath) : { wosIds: [], dois: [] };
    const wosIds = dedupe([...(args.wosIds || []).map(normalizeWosIdInput), ...csvIds.wosIds]);
    const dois = dedupe([...(args.dois || []), ...csvIds.dois]);
    if (!wosIds.length && !dois.length) {
      throw new Error("Missing query ids input. Use --wosid, --doi, or --csv.");
    }
    await callWosBrowserApi(page, "query.openQueryByWosIdsOrDois", [wosIds, dois]);
    const rowText = queryTextForIds(wosIds, dois);
    const raw = await fetchCurrentPageUuidInfo(page, rowText);
    return normalizeUuidResult(raw, {
      taskId: args.taskId,
      operation: "query ids",
      rowText,
      source: {
        kind: "ids",
        wosIdCount: wosIds.length,
        doiCount: dois.length,
        csv: args.csvPath || "",
      },
    });
  }
  throw new Error(`Unknown query command: ${args.queryCommand}`);
}

async function runRecordBrowserCommand(page, args) {
  if (args.recordCommand === "relations") {
    const methods = {
      citations: "record.collectCitationsByWosId",
      references: "record.collectReferencesByWosId",
      related: "record.collectRelatedRecordsByWosId",
    };
    const method = methods[args.relationType];
    if (!method) throw new Error(`Invalid relation type: ${args.relationType}`);
    await callWosBrowserApi(page, method, [args.wosId]);
    const raw = await fetchCurrentPageUuidInfo(page, `${args.relationType} of ${args.wosId}`);
    return normalizeUuidResult(raw, {
      taskId: args.taskId,
      operation: `record ${args.relationType}`,
      source: { kind: "record-relation", wosid: args.wosId, type: args.relationType },
    });
  }
  if (args.recordCommand === "shared") {
    await callWosBrowserApi(page, "record.collectSharedReferencesBetweenWosIds", [args.wosId, args.withWosId]);
    const raw = await fetchCurrentPageUuidInfo(page, `shared references between ${args.wosId} and ${args.withWosId}`);
    return normalizeUuidResult(raw, {
      taskId: args.taskId,
      operation: "record shared",
      source: { kind: "record-shared", wosid: args.wosId, with: args.withWosId },
    });
  }
  throw new Error(`Unknown record command: ${args.recordCommand}`);
}

function publicResult(result) {
  return jsonSafe({
    ok: Boolean(result?.ok),
    taskId: result?.taskId || "",
    operation: result?.operation || "",
    uuid: result?.uuid || "",
    count: Number(result?.count || 0),
    rowText: result?.rowText || "",
    source: result?.source || {},
  });
}

module.exports = {
  csvEscape,
  normalizeUuidResult,
  publicResult,
  queryTextForIds,
  readIdsCsv,
  runQueryBrowserCommand,
  runRecordBrowserCommand,
};
