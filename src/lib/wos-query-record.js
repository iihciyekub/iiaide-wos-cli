const fs = require("node:fs");
const { callWosBrowserApi, jsonSafe } = require("./wos-browser-bridge");

function debug(args, message, details = {}) {
  if (!args?.debug) return false;
  const parts = [];
  for (const [key, value] of Object.entries(details || {})) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}=${String(value)}`);
  }
  const suffix = parts.length ? ` ${parts.join(" ")}` : "";
  console.error(`[debug] ${message}${suffix}`);
  return true;
}

async function callBrowserApi(args, page, apiPath, callArgs = []) {
  let heartbeat = null;
  if (args?.debug) {
    const started = Date.now();
    heartbeat = setInterval(() => {
      debug(args, "waiting for WOS browser API", {
        api: apiPath,
        elapsedMs: Date.now() - started,
      });
    }, 5000);
    heartbeat.unref?.();
  }
  try {
    return await callWosBrowserApi(page, apiPath, callArgs);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

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

const RECORD_RELATION_TYPES = ["citations", "references", "related"];

function relationMethod(type) {
  return {
    citations: "record.collectCitationsByWosId",
    references: "record.collectReferencesByWosId",
    related: "record.collectRelatedRecordsByWosId",
  }[type] || "";
}

function relationPages(args) {
  const pages = Math.min(Math.max(Number(args?.pages) || 20, 1), 20);
  return Array.from({ length: pages }, (_, index) => index + 1);
}

function normalizeRelationRows(rows = []) {
  const seen = new Set();
  const result = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const wosid = normalizeWosIdInput(row?.wosid || row);
    if (!wosid || seen.has(wosid)) continue;
    seen.add(wosid);
    result.push({
      wosid,
      citations_count: row?.citations_count || "",
      ref_count: row?.ref_count || "",
      related_count: row?.related_count || "",
    });
  }
  return result;
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

function formatUuidDebug(debug = {}) {
  if (!debug || typeof debug !== "object") return "";
  const parts = [];
  if (debug.pathname) parts.push(`path=${debug.pathname}`);
  if (debug.inputReady === false || debug.inputVisible === false) {
    parts.push(`inputReady=${Boolean(debug.inputReady)}`);
    parts.push(`inputVisible=${Boolean(debug.inputVisible)}`);
  }
  if (debug.inputValue) parts.push(`input=${JSON.stringify(debug.inputValue)}`);
  if (Number.isFinite(Number(debug.historyCount))) parts.push(`history=${Number(debug.historyCount)}`);
  if (Array.isArray(debug.buttonLabels) && debug.buttonLabels.length) {
    parts.push(`buttons=${debug.buttonLabels.join("|")}`);
  }
  if (debug.errorText) parts.push(`pageError=${debug.errorText}`);
  return parts.length ? ` Browser state: ${parts.join("; ")}.` : "";
}

function normalizeUuidError(rawError, defaults = {}) {
  const message = String(rawError || defaults.error || "").trim();
  const compactMessage = message.replace(/\s+/g, " ").trim();
  if (/^Your search found no results/i.test(compactMessage)) {
    return "Your search found no results";
  }
  const debugText = formatUuidDebug(defaults.debug);
  if (message && !/^unknown error$/i.test(message)) return `${message}.${debugText}`.replace(/\.\./g, ".");
  const operation = defaults.operation || "WOS query";
  const rowText = defaults.rowText ? ` for ${JSON.stringify(defaults.rowText)}` : "";
  return `${operation} failed${rowText}: WOS did not create a result-set UUID or expose a detailed error.${debugText} Check the query in Web of Science advanced search, or retry with --headed/--from-browser if the page needs attention.`;
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
    sortBy: data.sortBy || data.debug?.sortBy || "",
    href: data.href || data.debug?.href || "",
    source,
  };
  if (!result.ok) {
    result.error = normalizeUuidError(data.error_code || data.message, { ...defaults, debug: data.debug || defaults.debug });
  }
  return result;
}

async function fetchCurrentPageUuidInfo(page, note = "") {
  return callWosBrowserApi(page, "results.fetchCurrentPageInfo", [note]);
}

async function runQueryBrowserCommand(page, args) {
  if (args.queryCommand === "build") {
    debug(args, "query build: opening WOS advanced search and submitting expression", { expr: args.queryExpr });
    const raw = await callBrowserApi(args, page, "query.buildQuery", [args.queryExpr]);
    debug(args, "query build: WOS browser API returned", {
      uuid: raw?.uuid || raw?.QueryID || "",
      status: raw?.status || "",
      error: raw?.error_code || raw?.message || "",
    });
    return normalizeUuidResult(raw, {
      taskId: args.taskId,
      operation: "query build",
      rowText: args.queryExpr,
      source: { kind: "expr", value: args.queryExpr },
    });
  }
  if (args.queryCommand === "parse") {
    debug(args, "query parse: opening WOS basic search and parsing text");
    const rowText = await callBrowserApi(args, page, "query.parseQueryWithSearchEngine", [args.queryText]);
    debug(args, "query parse: opening generated result page", { rowText: rowText || args.queryText });
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
    debug(args, "query ids: opening generated WOS result page", { wosIds: wosIds.length, dois: dois.length });
    await callBrowserApi(args, page, "query.openQueryByWosIdsOrDois", [wosIds, dois]);
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
    const method = relationMethod(args.relationType);
    if (!method) throw new Error(`Invalid relation type: ${args.relationType}`);
    debug(args, "record relations: opening WOS relation page", { type: args.relationType, wosid: args.wosId });
    await callBrowserApi(args, page, method, [args.wosId]);
    const raw = await fetchCurrentPageUuidInfo(page, `${args.relationType} of ${args.wosId}`);
    return normalizeUuidResult(raw, {
      taskId: args.taskId,
      operation: `record ${args.relationType}`,
      source: { kind: "record-relation", wosid: args.wosId, type: args.relationType },
    });
  }
  if (args.recordCommand === "collect") {
    const types = (args.relationTypes?.length ? args.relationTypes : RECORD_RELATION_TYPES)
      .filter((type) => RECORD_RELATION_TYPES.includes(type));
    const pages = relationPages(args);
    const relations = [];
    for (const type of types) {
      const method = relationMethod(type);
      debug(args, "record collect: opening WOS relation page", {
        type,
        wosid: args.wosId,
        pages: pages.length,
      });
      await callBrowserApi(args, page, method, [args.wosId]);
      const raw = await fetchCurrentPageUuidInfo(page, `${type} of ${args.wosId}`);
      const uuidResult = normalizeUuidResult(raw, {
        taskId: args.taskId,
        operation: `record ${type}`,
        source: { kind: "record-relation", wosid: args.wosId, type },
      });
      let rows = [];
      if (uuidResult.ok && uuidResult.uuid && uuidResult.count > 0) {
        debug(args, "record collect: collecting WOS IDs from relation result set", {
          type,
          uuid: uuidResult.uuid,
          pages: pages.length,
        });
        rows = normalizeRelationRows(await callBrowserApi(args, page, "results.collectWosIdsByUuidPages", [uuidResult.uuid, pages, args.sortBy]));
      }
      relations.push({
        type,
        ok: uuidResult.ok,
        uuid: uuidResult.uuid,
        count: uuidResult.count,
        rowText: uuidResult.rowText,
        error: uuidResult.error || "",
        pagesRequested: pages.length,
        wosids: rows,
        uniqueCount: rows.length,
      });
    }
    const first = relations.find((item) => item.ok && item.uuid) || relations[0] || {};
    const failed = relations.filter((item) => !item.ok).length;
    return {
      ok: Boolean(relations.length) && failed === 0,
      taskId: args.taskId,
      operation: "record collect",
      uuid: first.uuid || "",
      count: relations.reduce((sum, item) => sum + Number(item.uniqueCount || 0), 0),
      rowText: `${types.join(",")} relations for ${args.wosId}`,
      source: {
        kind: "record-relation-collection",
        wosid: args.wosId,
        types,
        pages: pages.length,
      },
      relations,
      error: failed ? `${failed} relation collection(s) failed` : "",
    };
  }
  if (args.recordCommand === "shared") {
    debug(args, "record shared: opening WOS shared-reference page", { wosid: args.wosId, with: args.withWosId });
    await callBrowserApi(args, page, "record.collectSharedReferencesBetweenWosIds", [args.wosId, args.withWosId]);
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
  callBrowserApi,
  csvEscape,
  formatUuidDebug,
  normalizeUuidResult,
  normalizeUuidError,
  publicResult,
  queryTextForIds,
  readIdsCsv,
  RECORD_RELATION_TYPES,
  runQueryBrowserCommand,
  runRecordBrowserCommand,
};
