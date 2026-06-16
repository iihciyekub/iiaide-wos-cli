const fs = require("node:fs");
const path = require("node:path");

function loadDatabaseSync() {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function emitWarningWithoutSqliteExperimentalNoise(warning, ...args) {
    const warningType = typeof args[0] === "string" ? args[0] : args[0]?.type;
    const message = String(warning?.message || warning || "");
    if (warningType === "ExperimentalWarning" && /SQLite/i.test(message)) return;
    return originalEmitWarning.call(this, warning, ...args);
  };
  try {
    return require("node:sqlite").DatabaseSync;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

const DatabaseSync = loadDatabaseSync();

function openWosDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS ingest_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_wosid TEXT NOT NULL DEFAULT '',
      query_text TEXT NOT NULL DEFAULT '',
      semantic_description TEXT NOT NULL DEFAULT '',
      uuid TEXT NOT NULL,
      is_ref_query INTEGER NOT NULL DEFAULT 0,
      sort_by TEXT NOT NULL DEFAULT 'relevance',
      export_mode TEXT NOT NULL DEFAULT 'uuid-export',
      uuid_direct_export INTEGER NOT NULL DEFAULT 1,
      requested_limit INTEGER NOT NULL DEFAULT 500,
      available_count INTEGER NOT NULL DEFAULT 0,
      ingested_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resultsets (
      uuid TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_wosid TEXT NOT NULL DEFAULT '',
      query_text TEXT NOT NULL DEFAULT '',
      semantic_description TEXT NOT NULL DEFAULT '',
      is_ref_query INTEGER NOT NULL DEFAULT 0,
      sort_by TEXT NOT NULL DEFAULT 'relevance',
      export_mode TEXT NOT NULL DEFAULT 'uuid-export',
      uuid_direct_export INTEGER NOT NULL DEFAULT 1,
      available_count INTEGER NOT NULL DEFAULT 0,
      last_ingested_count INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resultset_items (
      uuid TEXT NOT NULL,
      run_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      wosid TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (uuid, run_id, position),
      UNIQUE (uuid, run_id, wosid),
      FOREIGN KEY (run_id) REFERENCES ingest_runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS records (
      wosid TEXT PRIMARY KEY,
      doi TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      year TEXT NOT NULL DEFAULT '',
      source_title TEXT NOT NULL DEFAULT '',
      raw_json TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_resultsets_task_kind ON resultsets(task_id, kind, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_resultset_items_wosid ON resultset_items(wosid);
    CREATE INDEX IF NOT EXISTS idx_ingest_runs_task_time ON ingest_runs(task_id, started_at);

    CREATE TABLE IF NOT EXISTS audit_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      subcommand TEXT NOT NULL DEFAULT '',
      operation TEXT NOT NULL DEFAULT '',
      ok INTEGER NOT NULL DEFAULT 0,
      uuid TEXT NOT NULL DEFAULT '',
      count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT '',
      summary_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS search_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      subcommand TEXT NOT NULL DEFAULT '',
      operation TEXT NOT NULL DEFAULT '',
      query_text TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL DEFAULT '',
      source_wosid TEXT NOT NULL DEFAULT '',
      relation_type TEXT NOT NULL DEFAULT '',
      semantic_description TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL DEFAULT '{}',
      uuid TEXT NOT NULL DEFAULT '',
      result_count INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE (run_id, command, subcommand, operation, query_text, uuid, relation_type)
    );

    CREATE TABLE IF NOT EXISTS artifact_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      uuid TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, role, path)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_runs_task_time ON audit_runs(task_id, finished_at);
    CREATE INDEX IF NOT EXISTS idx_search_queries_task_time ON search_queries(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_search_queries_uuid ON search_queries(uuid);
    CREATE INDEX IF NOT EXISTS idx_artifact_events_task_time ON artifact_events(task_id, created_at);
  `);
  ensureColumn(db, "ingest_runs", "export_mode", "TEXT NOT NULL DEFAULT 'uuid-export'");
  ensureColumn(db, "ingest_runs", "uuid_direct_export", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "resultsets", "export_mode", "TEXT NOT NULL DEFAULT 'uuid-export'");
  ensureColumn(db, "resultsets", "uuid_direct_export", "INTEGER NOT NULL DEFAULT 1");
  return db;
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function asText(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function recordTitle(record = {}) {
  return asText(record?.wos_data?.title || record?.title || "");
}

function recordYear(record = {}) {
  return asText(record?.wos_data?.publication_year || record?.wos_data?.year || record?.year || "");
}

function recordSourceTitle(record = {}) {
  return asText(record?.wos_data?.source_title || record?.source_title || "");
}

function canonicalWosId(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^[A-Z][A-Z0-9_-]*:/i.test(text)) return text.replace(/^wos:/i, "WOS:");
  return `WOS:${text}`;
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function normalizeRelationType(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (["citation", "citations", "cited-by", "citedby"].includes(text)) return "citations";
  if (["ref", "refs", "reference", "references"].includes(text)) return "references";
  if (["related", "relead", "rel"].includes(text)) return "related";
  if (["self", "record"].includes(text)) return "self";
  return text;
}

function recordAuthors(record = {}) {
  const names = record?.wos_data?.author_full_names || record?.wos_data?.authors || record?.authors || [];
  if (Array.isArray(names)) return names;
  return asText(names).split(";").map((name) => name.trim()).filter(Boolean);
}

function recordAbstract(record = {}) {
  return asText(record?.wos_data?.abstract || record?.abstract || "");
}

function recordKeywords(record = {}) {
  const keywords = [
    ...(Array.isArray(record?.wos_data?.author_keywords) ? record.wos_data.author_keywords : []),
    ...(Array.isArray(record?.wos_data?.keywords_plus) ? record.wos_data.keywords_plus : []),
  ];
  return [...new Set(keywords.map(asText).filter(Boolean))];
}

function rowToResultset(row = {}) {
  return {
    uuid: row.uuid || "",
    taskId: row.taskId || row.task_id || "",
    kind: row.kind || "",
    sourceWosId: row.sourceWosId || row.source_wosid || "",
    queryText: row.queryText || row.query_text || "",
    semanticDescription: row.semanticDescription || row.semantic_description || "",
    isRefQuery: Boolean(row.isRefQuery ?? row.is_ref_query),
    sortBy: row.sortBy || row.sort_by || "relevance",
    exportMode: row.exportMode || row.export_mode || "uuid-export",
    uuidDirectExport: Boolean(row.uuidDirectExport ?? row.uuid_direct_export ?? true),
    availableCount: Number(row.availableCount ?? row.available_count) || 0,
    lastIngestedCount: Number(row.lastIngestedCount ?? row.last_ingested_count) || 0,
    firstSeenAt: row.firstSeenAt || row.first_seen_at || "",
    lastSeenAt: row.lastSeenAt || row.last_seen_at || "",
    itemCount: Number(row.itemCount) || 0,
    firstPosition: Number(row.firstPosition) || 0,
    lastPosition: Number(row.lastPosition) || 0,
  };
}

function rowToRecord(row = {}) {
  if (!row) return null;
  const raw = parseJson(row.raw_json || "", {});
  return {
    wosid: row.wosid || canonicalWosId(raw?.wos_id || raw?.wosid || ""),
    doi: row.doi || asText(raw?.meta_info?.doi || raw?.doi || ""),
    title: row.title || recordTitle(raw),
    year: row.year || recordYear(raw),
    sourceTitle: row.source_title || recordSourceTitle(raw),
    authors: recordAuthors(raw),
    abstract: recordAbstract(raw),
    keywords: recordKeywords(raw),
    firstSeenAt: row.first_seen_at || "",
    lastSeenAt: row.last_seen_at || "",
  };
}

function getResultsetMetadata(db, uuid = "") {
  const id = String(uuid || "").trim();
  if (!id) return null;
  const row = db.prepare(`
    SELECT
      r.uuid,
      r.task_id AS taskId,
      r.kind,
      r.source_wosid AS sourceWosId,
      r.query_text AS queryText,
      r.semantic_description AS semanticDescription,
      r.is_ref_query AS isRefQuery,
      r.sort_by AS sortBy,
      r.export_mode AS exportMode,
      r.uuid_direct_export AS uuidDirectExport,
      r.available_count AS availableCount,
      r.last_ingested_count AS lastIngestedCount,
      r.first_seen_at AS firstSeenAt,
      r.last_seen_at AS lastSeenAt,
      COUNT(i.wosid) AS itemCount,
      MIN(i.position) AS firstPosition,
      MAX(i.position) AS lastPosition
    FROM resultsets r
    LEFT JOIN resultset_items i ON i.uuid = r.uuid
    WHERE r.uuid = ?
    GROUP BY r.uuid
  `).get(id);
  return row ? rowToResultset(row) : null;
}

function getRecordByWosId(db, wosid = "") {
  const id = canonicalWosId(wosid);
  if (!id) return null;
  const row = db.prepare("SELECT * FROM records WHERE wosid = ?").get(id);
  return rowToRecord(row);
}

function getRelationMetadataForWosId(db, wosid = "") {
  const id = canonicalWosId(wosid);
  if (!id) return [];
  return db.prepare(`
    SELECT
      r.uuid,
      r.task_id AS taskId,
      r.kind,
      r.source_wosid AS sourceWosId,
      r.query_text AS queryText,
      r.semantic_description AS semanticDescription,
      r.is_ref_query AS isRefQuery,
      r.sort_by AS sortBy,
      r.export_mode AS exportMode,
      r.uuid_direct_export AS uuidDirectExport,
      r.available_count AS availableCount,
      r.last_ingested_count AS lastIngestedCount,
      r.first_seen_at AS firstSeenAt,
      r.last_seen_at AS lastSeenAt,
      COUNT(i.wosid) AS itemCount,
      MIN(i.position) AS firstPosition,
      MAX(i.position) AS lastPosition
    FROM resultsets r
    LEFT JOIN resultset_items i ON i.uuid = r.uuid
    WHERE r.source_wosid = ?
      AND r.kind IN ('citations', 'references', 'related')
    GROUP BY r.uuid
    ORDER BY r.kind, r.last_seen_at DESC
  `).all(id).map(rowToResultset);
}

function getLatestRelationMetadata(db, options = {}) {
  const sourceWosId = canonicalWosId(options.sourceWosId || "");
  const kind = normalizeRelationType(options.kind || "");
  if (!sourceWosId || !["citations", "references", "related"].includes(kind)) return null;
  const row = db.prepare(`
    SELECT
      r.uuid,
      r.task_id AS taskId,
      r.kind,
      r.source_wosid AS sourceWosId,
      r.query_text AS queryText,
      r.semantic_description AS semanticDescription,
      r.is_ref_query AS isRefQuery,
      r.sort_by AS sortBy,
      r.export_mode AS exportMode,
      r.uuid_direct_export AS uuidDirectExport,
      r.available_count AS availableCount,
      r.last_ingested_count AS lastIngestedCount,
      r.first_seen_at AS firstSeenAt,
      r.last_seen_at AS lastSeenAt,
      COUNT(i.wosid) AS itemCount,
      MIN(i.position) AS firstPosition,
      MAX(i.position) AS lastPosition
    FROM resultsets r
    LEFT JOIN resultset_items i ON i.uuid = r.uuid
    WHERE r.source_wosid = ?
      AND r.kind = ?
    GROUP BY r.uuid
    ORDER BY r.last_seen_at DESC
    LIMIT 1
  `).get(sourceWosId, kind);
  return row ? rowToResultset(row) : null;
}

function getResultsetContext(db, uuid = "", options = {}) {
  const id = String(uuid || "").trim();
  if (!id) return [];
  const limit = Math.max(0, Number(options.limit) || 0);
  const rows = db.prepare(`
    SELECT
      i.position,
      r.*
    FROM resultset_items i
    JOIN records r ON r.wosid = i.wosid
    WHERE i.uuid = ?
    ORDER BY i.position
    ${limit ? `LIMIT ${limit}` : ""}
  `).all(id);
  return rows.map((row) => ({
    position: Number(row.position) || 0,
    ...rowToRecord(row),
  }));
}

function latestIngestRunIdForResultset(db, uuid = "") {
  const id = String(uuid || "").trim();
  if (!id) return "";
  const row = db.prepare(`
    SELECT run_id AS runId
    FROM ingest_runs
    WHERE uuid = ?
    ORDER BY finished_at DESC, started_at DESC, run_id DESC
    LIMIT 1
  `).get(id);
  return row?.runId || "";
}

function getResultsetItems(db, uuid = "", options = {}) {
  const id = String(uuid || "").trim();
  if (!id) return [];
  const limit = Math.max(0, Number(options.limit) || 0);
  const runId = String(options.runId || latestIngestRunIdForResultset(db, id) || "");
  const clauses = ["i.uuid = ?"];
  const params = [id];
  if (runId) {
    clauses.push("i.run_id = ?");
    params.push(runId);
  }
  const rows = db.prepare(`
    SELECT
      i.position,
      i.run_id AS runId,
      i.wosid,
      i.observed_at AS observedAt,
      r.doi,
      r.title,
      r.year,
      r.source_title,
      r.raw_json,
      r.first_seen_at,
      r.last_seen_at
    FROM resultset_items i
    LEFT JOIN records r ON r.wosid = i.wosid
    WHERE ${clauses.join(" AND ")}
    ORDER BY i.position
    ${limit ? `LIMIT ${limit}` : ""}
  `).all(...params);
  return rows.map((row) => {
    const record = row.raw_json ? rowToRecord(row) : null;
    return {
      position: Number(row.position) || 0,
      runId: row.runId || "",
      wosid: canonicalWosId(row.wosid || ""),
      observedAt: row.observedAt || "",
      record,
    };
  });
}

function getSearchQueries(db, options = {}) {
  const limit = Math.max(0, Number(options.limit) || 0);
  const uuid = String(options.uuid || "").trim();
  const wosid = canonicalWosId(options.wosid || "");
  const clauses = [];
  const params = [];
  if (uuid) {
    clauses.push("uuid = ?");
    params.push(uuid);
  }
  if (wosid) {
    clauses.push("source_wosid = ?");
    params.push(wosid);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT
      id,
      run_id AS runId,
      task_id AS taskId,
      command,
      subcommand,
      operation,
      query_text AS queryText,
      source_kind AS sourceKind,
      source_wosid AS sourceWosId,
      relation_type AS relationType,
      semantic_description AS semanticDescription,
      source_json AS sourceJson,
      uuid,
      result_count AS resultCount,
      ok,
      error_message AS errorMessage,
      created_at AS createdAt
    FROM search_queries
    ${where}
    ORDER BY created_at DESC, id DESC
    ${limit ? `LIMIT ${limit}` : ""}
  `).all(...params);
  return rows.map((row) => ({
    id: Number(row.id) || 0,
    runId: row.runId || "",
    taskId: row.taskId || "",
    command: row.command || "",
    subcommand: row.subcommand || "",
    operation: row.operation || "",
    queryText: row.queryText || "",
    sourceKind: row.sourceKind || "",
    sourceWosId: row.sourceWosId || "",
    relationType: row.relationType || "",
    semanticDescription: row.semanticDescription || "",
    source: parseJson(row.sourceJson || "", {}),
    uuid: row.uuid || "",
    resultCount: Number(row.resultCount) || 0,
    ok: Boolean(row.ok),
    errorMessage: row.errorMessage || "",
    createdAt: row.createdAt || "",
  }));
}

function getLatestSuccessfulQueryBuild(db, options = {}) {
  const taskId = String(options.taskId || "");
  const queryText = String(options.queryText || "");
  if (!taskId || !queryText) return null;
  const row = db.prepare(`
    SELECT
      sq.uuid,
      sq.result_count AS count,
      sq.query_text AS rowText,
      sq.source_kind AS sourceKind,
      sq.source_json AS sourceJson,
      sq.created_at AS createdAt,
      rs.sort_by AS sortBy
    FROM search_queries sq
    LEFT JOIN resultsets rs ON rs.uuid = sq.uuid
    WHERE sq.task_id = ?
      AND sq.command = 'query'
      AND sq.subcommand = 'build'
      AND sq.query_text = ?
      AND sq.ok = 1
      AND sq.uuid <> ''
    ORDER BY sq.created_at DESC, sq.id DESC
    LIMIT 1
  `).get(taskId, queryText);
  if (!row) return null;
  return {
    uuid: row.uuid || "",
    count: Number(row.count || 0),
    rowText: row.rowText || "",
    sourceKind: row.sourceKind || "",
    source: parseJson(row.sourceJson || "", {}),
    sortBy: row.sortBy || "relevance",
    createdAt: row.createdAt || "",
  };
}

function getArtifactEvents(db, options = {}) {
  const limit = Math.max(0, Number(options.limit) || 0);
  const uuid = String(options.uuid || "").trim();
  const clauses = [];
  const params = [];
  if (uuid) {
    clauses.push("uuid = ?");
    params.push(uuid);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT
      id,
      run_id AS runId,
      task_id AS taskId,
      uuid,
      role,
      path,
      created_at AS createdAt
    FROM artifact_events
    ${where}
    ORDER BY created_at DESC, id DESC
    ${limit ? `LIMIT ${limit}` : ""}
  `).all(...params);
  return rows.map((row) => ({
    id: Number(row.id) || 0,
    runId: row.runId || "",
    taskId: row.taskId || "",
    uuid: row.uuid || "",
    role: row.role || "",
    path: row.path || "",
    createdAt: row.createdAt || "",
  }));
}

function getAuditRuns(db, options = {}) {
  const limit = Math.max(0, Number(options.limit) || 0);
  const uuid = String(options.uuid || "").trim();
  const clauses = [];
  const params = [];
  if (uuid) {
    clauses.push("uuid = ?");
    params.push(uuid);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT
      run_id AS runId,
      task_id AS taskId,
      command,
      subcommand,
      operation,
      ok,
      uuid,
      count,
      created_at AS createdAt,
      finished_at AS finishedAt,
      summary_json AS summaryJson
    FROM audit_runs
    ${where}
    ORDER BY finished_at DESC, created_at DESC, run_id DESC
    ${limit ? `LIMIT ${limit}` : ""}
  `).all(...params);
  return rows.map((row) => ({
    runId: row.runId || "",
    taskId: row.taskId || "",
    command: row.command || "",
    subcommand: row.subcommand || "",
    operation: row.operation || "",
    ok: Boolean(row.ok),
    uuid: row.uuid || "",
    count: Number(row.count) || 0,
    createdAt: row.createdAt || "",
    finishedAt: row.finishedAt || "",
    summary: parseJson(row.summaryJson || "", {}),
  }));
}

function getAuditTimeline(db, options = {}) {
  const limit = Math.max(0, Number(options.limit) || 0);
  const uuid = String(options.uuid || "").trim();
  const wosid = canonicalWosId(options.wosid || "");
  const items = [];
  for (const run of getAuditRuns(db, { limit: 0, uuid })) {
    items.push({
      type: "run",
      timestamp: run.finishedAt || run.createdAt || "",
      runId: run.runId,
      uuid: run.uuid,
      command: run.command,
      subcommand: run.subcommand,
      operation: run.operation,
      ok: run.ok,
      count: run.count,
      data: run,
    });
  }
  for (const search of getSearchQueries(db, { limit: 0, uuid, wosid })) {
    items.push({
      type: "search",
      timestamp: search.createdAt || "",
      runId: search.runId,
      uuid: search.uuid,
      command: search.command,
      subcommand: search.subcommand,
      operation: search.operation,
      ok: search.ok,
      count: search.resultCount,
      data: search,
    });
  }
  for (const artifact of getArtifactEvents(db, { limit: 0, uuid })) {
    items.push({
      type: "artifact",
      timestamp: artifact.createdAt || "",
      runId: artifact.runId,
      uuid: artifact.uuid,
      command: "",
      subcommand: "",
      operation: artifact.role || "artifact",
      ok: true,
      count: 0,
      data: artifact,
    });
  }
  items.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
  return limit ? items.slice(0, limit) : items;
}

function insertWosIngest(db, payload = {}) {
  const now = payload.finishedAt || new Date().toISOString();
  const startedAt = payload.startedAt || now;
  const finishedAt = payload.finishedAt || now;
  const records = Array.isArray(payload.records) ? payload.records : [];
  const items = records
    .map((record, index) => ({
      position: index + 1,
      wosid: canonicalWosId(record?.wos_id || record?.wosid || record?.UT || ""),
      record,
    }))
    .filter((item) => item.wosid);

  const transaction = db.prepare(`
    INSERT INTO ingest_runs (
      run_id, task_id, kind, source_wosid, query_text, semantic_description,
      uuid, is_ref_query, sort_by, export_mode, uuid_direct_export, requested_limit, available_count,
      ingested_count, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      ingested_count = excluded.ingested_count,
      finished_at = excluded.finished_at
  `);
  const upsertResultset = db.prepare(`
    INSERT INTO resultsets (
      uuid, task_id, kind, source_wosid, query_text, semantic_description,
      is_ref_query, sort_by, export_mode, uuid_direct_export, available_count, last_ingested_count,
      first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uuid) DO UPDATE SET
      task_id = excluded.task_id,
      kind = excluded.kind,
      source_wosid = excluded.source_wosid,
      query_text = excluded.query_text,
      semantic_description = excluded.semantic_description,
      is_ref_query = excluded.is_ref_query,
      sort_by = excluded.sort_by,
      export_mode = excluded.export_mode,
      uuid_direct_export = excluded.uuid_direct_export,
      available_count = excluded.available_count,
      last_ingested_count = excluded.last_ingested_count,
      last_seen_at = excluded.last_seen_at
  `);
  const insertItem = db.prepare(`
    INSERT OR REPLACE INTO resultset_items (uuid, run_id, position, wosid, observed_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const upsertRecord = db.prepare(`
    INSERT INTO records (wosid, doi, title, year, source_title, raw_json, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wosid) DO UPDATE SET
      doi = COALESCE(NULLIF(excluded.doi, ''), records.doi),
      title = COALESCE(NULLIF(excluded.title, ''), records.title),
      year = COALESCE(NULLIF(excluded.year, ''), records.year),
      source_title = COALESCE(NULLIF(excluded.source_title, ''), records.source_title),
      raw_json = excluded.raw_json,
      last_seen_at = excluded.last_seen_at
  `);

  db.exec("BEGIN");
  try {
    transaction.run(
      payload.runId,
      payload.taskId,
      payload.kind,
      payload.sourceWosId || "",
      payload.queryText || "",
      payload.semanticDescription || "",
      payload.uuid,
      payload.isRefQuery ? 1 : 0,
      payload.sortBy || "relevance",
      payload.exportMode || "uuid-export",
      payload.uuidDirectExport === false ? 0 : 1,
      Number(payload.requestedLimit) || 500,
      Number(payload.availableCount) || 0,
      items.length,
      startedAt,
      finishedAt
    );
    upsertResultset.run(
      payload.uuid,
      payload.taskId,
      payload.kind,
      payload.sourceWosId || "",
      payload.queryText || "",
      payload.semanticDescription || "",
      payload.isRefQuery ? 1 : 0,
      payload.sortBy || "relevance",
      payload.exportMode || "uuid-export",
      payload.uuidDirectExport === false ? 0 : 1,
      Number(payload.availableCount) || 0,
      items.length,
      startedAt,
      finishedAt
    );
    for (const item of items) {
      const record = item.record || {};
      insertItem.run(payload.uuid, payload.runId, item.position, item.wosid, finishedAt);
      upsertRecord.run(
        item.wosid,
        asText(record?.meta_info?.doi || record?.doi || ""),
        recordTitle(record),
        recordYear(record),
        recordSourceTitle(record),
        JSON.stringify(record),
        finishedAt,
        finishedAt
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    dbPath: db.location || "",
    runId: payload.runId,
    uuid: payload.uuid,
    ingestedCount: items.length,
  };
}

function findExistingRecordIngest(db, options = {}) {
  const taskId = String(options.taskId || "");
  const kind = String(options.kind || "");
  const sourceWosId = canonicalWosId(options.sourceWosId || "");
  if (!taskId || !kind || !sourceWosId) return null;
  const row = db.prepare(`
    SELECT
      r.uuid,
      r.task_id AS taskId,
      r.kind,
      r.source_wosid AS sourceWosId,
      r.query_text AS queryText,
      r.semantic_description AS semanticDescription,
      r.is_ref_query AS isRefQuery,
      r.sort_by AS sortBy,
      r.export_mode AS exportMode,
      r.uuid_direct_export AS uuidDirectExport,
      r.available_count AS availableCount,
      r.last_ingested_count AS lastIngestedCount,
      r.last_seen_at AS lastSeenAt,
      ir.run_id AS sourceRunId,
      ir.ingested_count AS ingestedCount,
      ir.started_at AS startedAt,
      ir.finished_at AS finishedAt,
      (
        SELECT COUNT(*)
        FROM resultset_items i
        WHERE i.uuid = r.uuid AND i.run_id = ir.run_id
      ) AS itemCount
    FROM resultsets r
    JOIN ingest_runs ir
      ON ir.uuid = r.uuid
     AND ir.task_id = r.task_id
     AND ir.kind = r.kind
     AND ir.source_wosid = r.source_wosid
    WHERE r.task_id = ?
      AND r.kind = ?
      AND r.source_wosid = ?
      AND (ir.ingested_count > 0 OR ir.available_count = 0)
    ORDER BY ir.finished_at DESC, ir.started_at DESC
    LIMIT 1
  `).get(taskId, kind, sourceWosId);
  if (!row) return null;
  const itemCount = Number(row.itemCount) || 0;
  const availableCount = Number(row.availableCount) || 0;
  if (itemCount <= 0 && availableCount > 0) return null;
  return {
    uuid: row.uuid || "",
    taskId: row.taskId || taskId,
    kind: row.kind || kind,
    sourceWosId: row.sourceWosId || sourceWosId,
    queryText: row.queryText || "",
    semanticDescription: row.semanticDescription || "",
    isRefQuery: Boolean(row.isRefQuery),
    sortBy: row.sortBy || "relevance",
    exportMode: row.exportMode || "uuid-export",
    uuidDirectExport: Boolean(row.uuidDirectExport ?? true),
    availableCount,
    ingestedCount: Number(row.ingestedCount) || Number(row.itemCount) || 0,
    itemCount,
    sourceRunId: row.sourceRunId || "",
    startedAt: row.startedAt || "",
    finishedAt: row.finishedAt || "",
    lastSeenAt: row.lastSeenAt || "",
  };
}

function upsertObservedResultset(db, payload = {}) {
  const uuid = String(payload.uuid || "").trim();
  if (!uuid) return;
  const kind = String(payload.kind || "").trim();
  const now = payload.observedAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO resultsets (
      uuid, task_id, kind, source_wosid, query_text, semantic_description,
      is_ref_query, sort_by, export_mode, uuid_direct_export, available_count, last_ingested_count,
      first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(uuid) DO UPDATE SET
      task_id = COALESCE(NULLIF(excluded.task_id, ''), resultsets.task_id),
      kind = CASE
        WHEN excluded.kind = '' THEN resultsets.kind
        WHEN resultsets.kind IN ('normal', 'citations', 'references', 'related') AND excluded.kind NOT IN ('normal', 'citations', 'references', 'related') THEN resultsets.kind
        ELSE excluded.kind
      END,
      source_wosid = COALESCE(NULLIF(excluded.source_wosid, ''), resultsets.source_wosid),
      query_text = COALESCE(NULLIF(excluded.query_text, ''), resultsets.query_text),
      semantic_description = COALESCE(NULLIF(excluded.semantic_description, ''), resultsets.semantic_description),
      is_ref_query = CASE WHEN excluded.is_ref_query = 1 THEN 1 ELSE resultsets.is_ref_query END,
      sort_by = COALESCE(NULLIF(excluded.sort_by, ''), resultsets.sort_by),
      export_mode = COALESCE(NULLIF(excluded.export_mode, ''), resultsets.export_mode),
      uuid_direct_export = CASE WHEN excluded.uuid_direct_export = 0 THEN 0 ELSE resultsets.uuid_direct_export END,
      available_count = MAX(resultsets.available_count, excluded.available_count),
      last_ingested_count = CASE
        WHEN excluded.last_ingested_count > 0 THEN excluded.last_ingested_count
        ELSE resultsets.last_ingested_count
      END,
      last_seen_at = excluded.last_seen_at
  `).run(
    uuid,
    String(payload.taskId || ""),
    kind,
    canonicalWosId(payload.sourceWosId || ""),
    String(payload.queryText || ""),
    String(payload.semanticDescription || ""),
    payload.isRefQuery ? 1 : 0,
    String(payload.sortBy || "relevance"),
    String(payload.exportMode || "uuid-export"),
    payload.uuidDirectExport === false ? 0 : 1,
    Number(payload.availableCount) || 0,
    Number(payload.lastIngestedCount) || 0,
    now,
    now
  );
}

function writeAuditRecords(db, payload = {}) {
  const finishedAt = payload.finishedAt || new Date().toISOString();
  const createdAt = payload.createdAt || finishedAt;
  const taskId = String(payload.taskId || "");
  const runId = String(payload.runId || "");
  const command = String(payload.command || "");
  const subcommand = String(payload.subcommand || "");
  const operation = String(payload.operation || "");
  const uuid = String(payload.uuid || "");
  const count = Number(payload.count || 0);
  const ok = payload.ok ? 1 : 0;
  const searches = Array.isArray(payload.searches) ? payload.searches : [];
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  const resultsets = Array.isArray(payload.resultsets) ? payload.resultsets : [];

  const insertRun = db.prepare(`
    INSERT INTO audit_runs (
      run_id, task_id, command, subcommand, operation, ok, uuid, count, created_at, finished_at, summary_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      task_id = excluded.task_id,
      command = excluded.command,
      subcommand = excluded.subcommand,
      operation = excluded.operation,
      ok = excluded.ok,
      uuid = excluded.uuid,
      count = excluded.count,
      created_at = excluded.created_at,
      finished_at = excluded.finished_at,
      summary_json = excluded.summary_json
  `);
  const insertSearch = db.prepare(`
    INSERT OR REPLACE INTO search_queries (
      run_id, task_id, command, subcommand, operation, query_text, source_kind,
      source_wosid, relation_type, semantic_description, source_json, uuid,
      result_count, ok, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertArtifact = db.prepare(`
    INSERT OR REPLACE INTO artifact_events (
      run_id, task_id, uuid, role, path, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    if (runId) {
      insertRun.run(
        runId,
        taskId,
        command,
        subcommand,
        operation,
        ok,
        uuid,
        count,
        createdAt,
        finishedAt,
        JSON.stringify(payload.summary || {})
      );
    }
    for (const item of searches) {
      insertSearch.run(
        runId,
        taskId,
        command,
        subcommand,
        String(item.operation || operation || ""),
        String(item.queryText || ""),
        String(item.sourceKind || ""),
        canonicalWosId(item.sourceWosId || ""),
        normalizeRelationType(item.relationType || ""),
        String(item.semanticDescription || ""),
        JSON.stringify(item.source || {}),
        String(item.uuid || ""),
        Number(item.count || 0),
        item.ok ? 1 : 0,
        String(item.error || ""),
        String(item.createdAt || finishedAt)
      );
    }
    for (const item of resultsets) {
      upsertObservedResultset(db, {
        ...item,
        taskId,
        observedAt: item.observedAt || finishedAt,
      });
    }
    for (const item of artifacts) {
      const artifactPath = String(item.path || "");
      if (!artifactPath) continue;
      insertArtifact.run(
        runId,
        taskId,
        String(item.uuid || uuid || ""),
        String(item.role || ""),
        artifactPath,
        String(item.createdAt || finishedAt)
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

module.exports = {
  canonicalWosId,
  findExistingRecordIngest,
  getArtifactEvents,
  getAuditRuns,
  getAuditTimeline,
  getLatestRelationMetadata,
  getLatestSuccessfulQueryBuild,
  getRecordByWosId,
  getRelationMetadataForWosId,
  getResultsetContext,
  getResultsetItems,
  getResultsetMetadata,
  getSearchQueries,
  insertWosIngest,
  normalizeRelationType,
  openWosDatabase,
  upsertObservedResultset,
  writeAuditRecords,
};
