const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { normalizeWosId, wosIdsEquivalent } = require("./wos-ids");

function defaultWosDataDbPath() {
  return path.join(os.homedir(), ".iiaide-wos", "wosdata.sqlite");
}

function scalar(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(scalar).filter(Boolean).join("; ");
  if (typeof value === "object") return "";
  return String(value).trim();
}

function firstString(record, paths) {
  for (const pathParts of paths) {
    let value = record;
    for (const part of pathParts) {
      value = value?.[part];
    }
    const text = scalar(value);
    if (text) return text;
  }
  return "";
}

function extractYear(record) {
  const text = firstString(record, [
    ["year"],
    ["publicationYear"],
    ["source", "year"],
    ["source", "published"],
    ["source", "earlyAccess"],
  ]);
  const match = text.match(/\b(18|19|20|21)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function recordRow(record, jsonPath) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`Invalid WOS data JSON record: ${jsonPath}`);
  }
  const wosid = normalizeWosId(record.wosid) ||
    normalizeWosId(record.identifiers?.accessionNumber) ||
    normalizeWosId(record.url);
  if (!wosid) throw new Error(`Missing WOS ID in JSON file: ${jsonPath}`);
  const documentType = firstString(record, [
    ["documentType"],
    ["documentTypes"],
    ["source", "documentTypes"],
  ]);
  return {
    wosid,
    title: firstString(record, [["title"], ["articleTitle"]]),
    year: extractYear(record),
    doi: firstString(record, [["doi"], ["source", "doi"], ["identifiers", "doi"], ["links", "doi"]]).replace(/^https?:\/\/doi\.org\//i, ""),
    sourceTitle: firstString(record, [["sourceTitle"], ["source", "title"], ["journal"], ["journalTitle"]]),
    documentType,
    url: firstString(record, [["url"]]),
    fetchedAt: firstString(record, [["fetchedAt"]]),
    rawJson: JSON.stringify(record),
    updatedAt: new Date().toISOString(),
  };
}

function validateWosDataRecord(record, source = "record", expectedWosId = "") {
  const row = recordRow(record, source);
  const expected = normalizeWosId(expectedWosId);
  if (expected && !wosIdsEquivalent(row.wosid, expected)) {
    throw new Error(`WOS data record mismatch: expected=${expected} actual=${row.wosid} source=${source}`);
  }
  return row;
}

function openWosDataDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS wos_records (
      wosid TEXT PRIMARY KEY,
      title TEXT,
      year INTEGER,
      doi TEXT,
      source_title TEXT,
      document_type TEXT,
      url TEXT,
      fetched_at TEXT,
      raw_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wos_record_sources (
      wosid TEXT NOT NULL,
      task_id TEXT NOT NULL,
      json_path TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      PRIMARY KEY (wosid, task_id, json_path),
      FOREIGN KEY (wosid) REFERENCES wos_records(wosid)
    );
  `);
  return db;
}

function safeReadonlyDatabase(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch (_) {
    return null;
  }
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function wosDataRecordExists(dbPath, wosid) {
  const normalized = normalizeWosId(wosid);
  if (!normalized) return false;
  const db = safeReadonlyDatabase(dbPath);
  if (!db) return false;
  try {
    if (!tableExists(db, "wos_records")) return false;
    return Boolean(db.prepare("SELECT 1 FROM wos_records WHERE wosid = ?").get(normalized));
  } finally {
    db.close();
  }
}

function existingWosDataIds(dbPath, wosids) {
  const normalized = [...new Set((wosids || []).map(normalizeWosId).filter(Boolean))];
  const existing = new Set();
  if (!normalized.length) return existing;
  const db = safeReadonlyDatabase(dbPath);
  if (!db) return existing;
  try {
    if (!tableExists(db, "wos_records")) return existing;
    const query = db.prepare("SELECT 1 FROM wos_records WHERE wosid = ?");
    for (const wosid of normalized) {
      if (query.get(wosid)) existing.add(wosid);
    }
  } finally {
    db.close();
  }
  return existing;
}

function wosDataDbStats(dbPath) {
  const stats = {
    dbPath,
    exists: Boolean(dbPath && fs.existsSync(dbPath)),
    sizeBytes: 0,
    recordCount: 0,
    sourceCount: 0,
  };
  if (!stats.exists) return stats;
  stats.sizeBytes = fs.statSync(dbPath).size;
  const db = safeReadonlyDatabase(dbPath);
  if (!db) return stats;
  try {
    if (tableExists(db, "wos_records")) {
      stats.recordCount = db.prepare("SELECT COUNT(*) AS count FROM wos_records").get().count || 0;
    }
    if (tableExists(db, "wos_record_sources")) {
      stats.sourceCount = db.prepare("SELECT COUNT(*) AS count FROM wos_record_sources").get().count || 0;
    }
  } finally {
    db.close();
  }
  return stats;
}

function ensureWosDataSourceDatabase(dbPath) {
  if (!dbPath) throw new Error("Missing source SQLite database path");
  if (!fs.existsSync(dbPath)) throw new Error(`Source SQLite database not found: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  if (!tableExists(db, "wos_records")) {
    db.close();
    throw new Error(`Source SQLite database does not contain wos_records: ${dbPath}`);
  }
  return db;
}

function sourceRowsForWosId(sourceDb, wosid, sourceDbPath) {
  if (!tableExists(sourceDb, "wos_record_sources")) {
    return [{
      wosid,
      task_id: `merge:${path.basename(sourceDbPath)}`,
      json_path: `${path.resolve(sourceDbPath)}#${wosid}`,
      imported_at: new Date().toISOString(),
    }];
  }
  const rows = sourceDb.prepare(`
    SELECT wosid, task_id, json_path, imported_at
    FROM wos_record_sources
    WHERE wosid = ?
    ORDER BY task_id, json_path
  `).all(wosid);
  if (rows.length) return rows;
  return [{
    wosid,
    task_id: `merge:${path.basename(sourceDbPath)}`,
    json_path: `${path.resolve(sourceDbPath)}#${wosid}`,
    imported_at: new Date().toISOString(),
  }];
}

function recordStatements(db) {
  return {
    insertRecord: db.prepare(`
      INSERT OR IGNORE INTO wos_records (
        wosid, title, year, doi, source_title, document_type, url, fetched_at, raw_json, updated_at
      ) VALUES (
        @wosid, @title, @year, @doi, @sourceTitle, @documentType, @url, @fetchedAt, @rawJson, @updatedAt
      )
    `),
    forceRecord: db.prepare(`
      INSERT INTO wos_records (
        wosid, title, year, doi, source_title, document_type, url, fetched_at, raw_json, updated_at
      ) VALUES (
        @wosid, @title, @year, @doi, @sourceTitle, @documentType, @url, @fetchedAt, @rawJson, @updatedAt
      )
      ON CONFLICT(wosid) DO UPDATE SET
        title = excluded.title,
        year = excluded.year,
        doi = excluded.doi,
        source_title = excluded.source_title,
        document_type = excluded.document_type,
        url = excluded.url,
        fetched_at = excluded.fetched_at,
        raw_json = excluded.raw_json,
        updated_at = excluded.updated_at
    `),
    upsertSource: db.prepare(`
      INSERT OR REPLACE INTO wos_record_sources (wosid, task_id, json_path, imported_at)
      VALUES (@wosid, @taskId, @jsonPath, @importedAt)
    `),
  };
}

function sourceInsertStatement(db) {
  return db.prepare(`
    INSERT OR REPLACE INTO wos_record_sources (wosid, task_id, json_path, imported_at)
    VALUES (@wosid, @taskId, @jsonPath, @importedAt)
  `);
}

function writeWosDataRecord(statements, row, { taskId, source, force = false }) {
  const result = force ? statements.forceRecord.run(row) : statements.insertRecord.run(row);
  statements.upsertSource.run({
    wosid: row.wosid,
    taskId,
    jsonPath: source,
    importedAt: new Date().toISOString(),
  });
  return {
    imported: result.changes ? 1 : 0,
    skipped: force || result.changes ? 0 : 1,
    linked: 1,
  };
}

function linkWosDataSource(insertSource, sourceRow, sourceDbPath) {
  insertSource.run({
    wosid: normalizeWosId(sourceRow.wosid),
    taskId: sourceRow.task_id || `merge:${path.basename(sourceDbPath)}`,
    jsonPath: sourceRow.json_path || `${path.resolve(sourceDbPath)}#${normalizeWosId(sourceRow.wosid)}`,
    importedAt: sourceRow.imported_at || new Date().toISOString(),
  });
}

function importWosDataRecord({ dbPath, record, taskId, source = "parse", expectedWosId = "", force = false }) {
  if (!dbPath) throw new Error("Missing SQLite database path");
  if (!taskId) throw new Error("Missing task id for WOS data import");
  const row = validateWosDataRecord(record, source, expectedWosId);
  const db = openWosDataDatabase(dbPath);
  const statements = recordStatements(db);
  try {
    const result = writeWosDataRecord(statements, row, { taskId, source, force });
    return {
      ok: true,
      dbPath,
      taskId,
      wosid: row.wosid,
      total: 1,
      ...result,
    };
  } finally {
    db.close();
  }
}

function mergeWosDataDatabase({ dbPath, sourceDbPath, force = false }) {
  if (!dbPath) throw new Error("Missing SQLite database path");
  if (!sourceDbPath) throw new Error("Missing source SQLite database path");
  const targetPath = path.resolve(dbPath);
  const sourcePath = path.resolve(sourceDbPath);
  if (targetPath === sourcePath) throw new Error("Source and target SQLite database paths are the same");

  const sourceDb = ensureWosDataSourceDatabase(sourcePath);
  const targetDb = openWosDataDatabase(targetPath);
  const statements = recordStatements(targetDb);
  const insertSource = sourceInsertStatement(targetDb);
  const sourceRecords = sourceDb.prepare(`
    SELECT wosid, raw_json
    FROM wos_records
    ORDER BY wosid
  `).all();

  let imported = 0;
  let skipped = 0;
  let linked = 0;
  const mergeAll = targetDb.transaction(() => {
    for (const sourceRecord of sourceRecords) {
      const wosid = normalizeWosId(sourceRecord.wosid);
      if (!wosid) throw new Error(`Invalid WOS ID in source database: ${sourcePath}`);
      let record;
      try {
        record = JSON.parse(sourceRecord.raw_json);
      } catch (error) {
        throw new Error(`Invalid raw_json for ${wosid} in source database: ${sourcePath}`);
      }
      const row = validateWosDataRecord(record, `${sourcePath}#${wosid}`, wosid);
      const result = force ? statements.forceRecord.run(row) : statements.insertRecord.run(row);
      imported += result.changes ? 1 : 0;
      skipped += force || result.changes ? 0 : 1;
      for (const sourceRow of sourceRowsForWosId(sourceDb, wosid, sourcePath)) {
        linkWosDataSource(insertSource, sourceRow, sourcePath);
        linked += 1;
      }
    }
  });

  try {
    mergeAll();
  } finally {
    sourceDb.close();
    targetDb.close();
  }

  return {
    ok: true,
    dbPath: targetPath,
    sourceDbPath: sourcePath,
    total: sourceRecords.length,
    imported,
    skipped,
    linked,
  };
}

function assertReadOnlyQuery(sql) {
  const text = String(sql || "").trim();
  if (!text) throw new Error("Missing SQL query");
  if (!/^(select|with)\b/i.test(text)) throw new Error("Only SELECT queries are allowed");
  const withoutTrailingSemicolon = text.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) throw new Error("Only one SQL statement is allowed");
  if (/\b(insert|update|delete|replace|drop|alter|create|attach|detach|pragma|vacuum|reindex)\b/i.test(withoutTrailingSemicolon)) {
    throw new Error("Only read-only SELECT queries are allowed");
  }
  return withoutTrailingSemicolon;
}

function queryWosDataDatabase({ dbPath, sql, limit = 50 }) {
  if (!dbPath) throw new Error("Missing SQLite database path");
  if (!fs.existsSync(dbPath)) throw new Error(`SQLite database not found: ${dbPath}`);
  const query = assertReadOnlyQuery(sql);
  const rowLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(`SELECT * FROM (${query}) LIMIT ?`).all(rowLimit);
    return {
      ok: true,
      dbPath,
      query,
      limit: rowLimit,
      rowCount: rows.length,
      rows,
    };
  } finally {
    db.close();
  }
}

function queryWosDataByWosId({ dbPath, wosid }) {
  if (!dbPath) throw new Error("Missing SQLite database path");
  if (!fs.existsSync(dbPath)) throw new Error(`SQLite database not found: ${dbPath}`);
  const normalized = normalizeWosId(wosid);
  if (!normalized) throw new Error(`Invalid WOS ID: ${wosid}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    if (!tableExists(db, "wos_records")) {
      return { ok: true, dbPath, wosid: normalized, found: false, row: null };
    }
    const row = db.prepare(`
      SELECT
        wosid,
        title,
        year,
        doi,
        source_title AS sourceTitle,
        document_type AS documentType,
        url,
        fetched_at AS fetchedAt,
        updated_at AS updatedAt,
        raw_json AS rawJson
      FROM wos_records
      WHERE wosid = ?
    `).get(normalized);
    if (!row) return { ok: true, dbPath, wosid: normalized, found: false, row: null };
    let record = null;
    try {
      record = JSON.parse(row.rawJson);
    } catch (_) {
      record = null;
    }
    delete row.rawJson;
    return {
      ok: true,
      dbPath,
      wosid: normalized,
      found: true,
      row: {
        ...row,
        record,
      },
    };
  } finally {
    db.close();
  }
}

function linkExistingWosDataSources({ dbPath, wosids, taskId, source = "global-db" }) {
  if (!dbPath) throw new Error("Missing SQLite database path");
  if (!taskId) throw new Error("Missing task id for WOS data import");
  const normalized = [...new Set((wosids || []).map(normalizeWosId).filter(Boolean))];
  if (!normalized.length || !fs.existsSync(dbPath)) {
    return { ok: true, dbPath, taskId, total: normalized.length, linked: 0 };
  }
  const db = openWosDataDatabase(dbPath);
  const exists = db.prepare("SELECT 1 FROM wos_records WHERE wosid = ?");
  const sourceExists = db.prepare("SELECT 1 FROM wos_record_sources WHERE wosid = ? AND task_id = ?");
  const upsertSource = db.prepare(`
    INSERT OR REPLACE INTO wos_record_sources (wosid, task_id, json_path, imported_at)
    VALUES (@wosid, @taskId, @jsonPath, @importedAt)
  `);
  let linked = 0;
  const linkAll = db.transaction(() => {
    for (const wosid of normalized) {
      if (!exists.get(wosid)) continue;
      if (sourceExists.get(wosid, taskId)) continue;
      upsertSource.run({
        wosid,
        taskId,
        jsonPath: `${source}:${wosid}`,
        importedAt: new Date().toISOString(),
      });
      linked += 1;
    }
  });
  try {
    linkAll();
  } finally {
    db.close();
  }
  return { ok: true, dbPath, taskId, total: normalized.length, linked };
}

module.exports = {
  defaultWosDataDbPath,
  existingWosDataIds,
  importWosDataRecord,
  linkExistingWosDataSources,
  mergeWosDataDatabase,
  normalizeWosId,
  queryWosDataByWosId,
  queryWosDataDatabase,
  recordRow,
  validateWosDataRecord,
  wosDataDbStats,
  wosDataRecordExists,
};
