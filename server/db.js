import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeDigits } from './geo.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const FAX_STORE_DIR = path.join(DATA_DIR, 'faxes');
const CALL_STORE_DIR = path.join(DATA_DIR, 'calls');
fs.mkdirSync(FAX_STORE_DIR, { recursive: true });
fs.mkdirSync(CALL_STORE_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'retrofax.sqlite'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    display_number TEXT NOT NULL UNIQUE,
    dial_digits TEXT NOT NULL UNIQUE,
    country TEXT NOT NULL,
    country_name TEXT NOT NULL,
    flag TEXT NOT NULL,
    tone_profile TEXT NOT NULL DEFAULT 'na',
    display_name TEXT NOT NULL DEFAULT '',
    listed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS faxes (
    id TEXT PRIMARY KEY,
    from_session_id TEXT,
    to_session_id TEXT,
    from_number TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    to_number TEXT NOT NULL,
    pages_count INTEGER NOT NULL,
    fine INTEGER NOT NULL DEFAULT 1,
    stormy_line INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok',
    report_json TEXT NOT NULL,
    logs_json TEXT NOT NULL,
    tiff_path TEXT,
    pcap_path TEXT,
    preview_paths_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    from_session_id TEXT,
    to_session_id TEXT,
    from_number TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    to_number TEXT NOT NULL,
    codec TEXT NOT NULL,
    stormy_line INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok',
    report_json TEXT NOT NULL,
    logs_json TEXT NOT NULL,
    tx_wav_path TEXT,
    rx_wav_path TEXT,
    pcap_path TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS blocks (
    session_id TEXT NOT NULL,
    blocked_digits TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, blocked_digits)
  );
`);

export { DATA_DIR, FAX_STORE_DIR, CALL_STORE_DIR };

export function getSessionById(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

export function getSessionByDigits(digits) {
  if (!digits) return null;
  return db.prepare('SELECT * FROM sessions WHERE dial_digits = ?').get(digits) || null;
}

export function createSession({
  id,
  displayNumber,
  dialDigits,
  country,
  countryName,
  flag,
  toneProfile,
}) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, display_number, dial_digits, country, country_name, flag, tone_profile, display_name, listed, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?)`
  ).run(id, displayNumber, dialDigits, country, countryName, flag, toneProfile || 'na', now, now);
  return getSessionById(id);
}

export function touchSession(id) {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
}

const PROFANE_RE = /\b(fuck|shit|cunt|nigger|faggot|kike|bitch|asshole)\b/gi;
export function sanitizeDirectoryName(name) {
  return String(name || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(PROFANE_RE, '****')
    .trim()
    .slice(0, 28);
}

export function updateDirectoryProfile(id, { displayName, listed }) {
  const clean = sanitizeDirectoryName(displayName);
  const isListed = listed && clean.length > 0 ? 1 : 0;
  db.prepare('UPDATE sessions SET display_name = ?, listed = ?, last_seen_at = ? WHERE id = ?').run(
    clean,
    isListed,
    Date.now(),
    id
  );
  return getSessionById(id);
}

export function listDirectorySessions() {
  return db
    .prepare(
      `SELECT id, display_number, dial_digits, country, country_name, flag, display_name, last_seen_at
       FROM sessions
       WHERE listed = 1 AND display_name != ''
       ORDER BY last_seen_at DESC
       LIMIT 60`
    )
    .all();
}

export function isBlockedByRecipient(recipientSessionId, senderDigits) {
  if (!recipientSessionId || !senderDigits) return false;
  const row = db
    .prepare('SELECT 1 FROM blocks WHERE session_id = ? AND blocked_digits = ?')
    .get(recipientSessionId, senderDigits);
  return Boolean(row);
}

export function blockSender(recipientSessionId, senderDigits) {
  const clean = normalizeDigits(senderDigits);
  if (!clean) return;
  db.prepare(
    'INSERT OR IGNORE INTO blocks (session_id, blocked_digits, created_at) VALUES (?, ?, ?)'
  ).run(recipientSessionId, clean, Date.now());
}

export function saveFaxRecord(rec) {
  db.prepare(
    `INSERT INTO faxes (
      id, from_session_id, to_session_id, from_number, from_name, to_number,
      pages_count, fine, stormy_line, status, report_json, logs_json,
      tiff_path, pcap_path, preview_paths_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rec.id,
    rec.fromSessionId || null,
    rec.toSessionId || null,
    rec.fromNumber,
    rec.fromName || '',
    rec.toNumber,
    rec.pagesCount,
    rec.fine ? 1 : 0,
    rec.stormyLine ? 1 : 0,
    rec.status,
    JSON.stringify(rec.report),
    JSON.stringify(rec.logs),
    rec.tiffPath || null,
    rec.pcapPath || null,
    JSON.stringify(rec.previewPaths || []),
    rec.createdAt || Date.now()
  );
}

export function getFaxById(id) {
  const row = db.prepare('SELECT * FROM faxes WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    report: JSON.parse(row.report_json),
    logs: JSON.parse(row.logs_json),
    previewPaths: JSON.parse(row.preview_paths_json),
  };
}

export function getInboxForSession(sessionId) {
  const rows = db
    .prepare(
      `SELECT id, from_number, from_name, to_number, pages_count, fine, stormy_line, status, report_json, preview_paths_json, created_at
       FROM faxes
       WHERE to_session_id = ? AND status = 'ok'
       ORDER BY created_at DESC
       LIMIT 25`
    )
    .all(sessionId);
  return rows.map((r) => ({
    id: r.id,
    fromNumber: r.from_number,
    fromName: r.from_name,
    toNumber: r.to_number,
    pagesCount: r.pages_count,
    fine: Boolean(r.fine),
    stormyLine: Boolean(r.stormy_line),
    report: JSON.parse(r.report_json),
    previewUrls: JSON.parse(r.preview_paths_json).map((_, idx) => `/api/fax/${r.id}/page/${idx}.png`),
    createdAt: r.created_at,
  }));
}

export function saveCallRecord(rec) {
  db.prepare(
    `INSERT INTO calls (
      id, from_session_id, to_session_id, from_number, from_name, to_number,
      codec, stormy_line, status, report_json, logs_json,
      tx_wav_path, rx_wav_path, pcap_path, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    rec.id,
    rec.fromSessionId || null,
    rec.toSessionId || null,
    rec.fromNumber,
    rec.fromName || '',
    rec.toNumber,
    rec.codec,
    rec.stormyLine ? 1 : 0,
    rec.status,
    JSON.stringify(rec.report),
    JSON.stringify(rec.logs),
    rec.txWavPath || null,
    rec.rxWavPath || null,
    rec.pcapPath || null,
    rec.createdAt || Date.now()
  );
}

export function getCallById(id) {
  const row = db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    report: JSON.parse(row.report_json),
    logs: JSON.parse(row.logs_json),
  };
}

export function getCallsForSession(sessionId) {
  const rows = db
    .prepare(
      `SELECT id, from_session_id, to_session_id, from_number, from_name, to_number, codec, stormy_line, status, report_json, logs_json, created_at
       FROM calls
       WHERE (to_session_id = ? OR from_session_id = ?) AND status = 'ok'
       ORDER BY created_at DESC
       LIMIT 25`
    )
    .all(sessionId, sessionId);
  return rows.map((r) => ({
    id: r.id,
    direction: r.from_session_id === sessionId && r.to_session_id !== sessionId ? 'outbound' : 'inbound',
    fromNumber: r.from_number,
    fromName: r.from_name,
    toNumber: r.to_number,
    codec: r.codec,
    stormyLine: Boolean(r.stormy_line),
    report: JSON.parse(r.report_json),
    logs: JSON.parse(r.logs_json),
    callerWavUrl: `/api/call/${r.id}/caller.wav`,
    replyWavUrl: `/api/call/${r.id}/reply.wav`,
    pcapUrl: `/api/call/${r.id}/capture.pcap`,
    createdAt: r.created_at,
  }));
}

