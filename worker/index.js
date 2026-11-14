import { DurableObject } from 'cloudflare:workers';
import {
  normalizeCodecId,
  uint8ToBase64,
  base64ToUint8,
} from '../shared/sipCodecs.js';
import { buildGroup3Tiff } from '../server/converter/tiffWriter.js';
import { rasterizePngEdge, renderThermalPngEdge } from './pngEdge.js';
import {
  prependTtiHeaderEdge,
  buildMonochromeSheetPixels,
  buildCoverSheetPageEdge,
  generateBotReplyFaxPagesEdge,
} from './edgeBitmap.js';
import { executeT38TransmissionEdge, executeSipVoiceCallEdge } from './edgeT38.js';
import {
  EDGE_BOTS,
  findBotByDigits,
  normalizeDigits,
  getCountryMeta,
  generateFaxNumberForCountry,
  geolocateEdgeRequest,
} from './geoEdge.js';

const COOKIE_NAME = 'retrofax_sid';

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      try {
        out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
      }
    }
  }
  return out;
}

function jsonResponse(data, status = 200, extraHeaders = null) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  if (extraHeaders) {
    for (const [k, v] of extraHeaders.entries()) {
      headers.append(k, v);
    }
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function buildLiveCodecSdpSpec(codecId) {
  const map = {
    G711U: { pt: 0, rtpmap: '0 PCMU/8000' },
    G711A: { pt: 8, rtpmap: '8 PCMA/8000' },
    G722: { pt: 9, rtpmap: '9 G722/8000' },
    G729: { pt: 18, rtpmap: '18 G729/8000' },
  };
  return map[codecId] || map.G711U;
}

function makeLiveSipInviteLog(toNumber, codecId, sipCallId) {
  const c = buildLiveCodecSdpSpec(codecId);
  return {
    ts: 0,
    layer: 'SIP',
    direction: 'TX->RX',
    summary: `INVITE sip:${normalizeDigits(toNumber)}@retrofax.edge SIP/2.0 (Call-ID: ${sipCallId.slice(0, 8)}, Offer: m=audio 5004 RTP/AVP ${c.pt} a=rtpmap:${c.rtpmap})`,
  };
}

export class RetroFaxHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.busySessions = new Set();
    this.activeLiveCalls = new Map();
    this.sendTimestamps = new Map();
    this.sqlReady = false;
  }

  ensureSchema() {
    if (this.sqlReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        display_number TEXT NOT NULL,
        dial_digits TEXT NOT NULL UNIQUE,
        country TEXT NOT NULL,
        country_name TEXT NOT NULL,
        flag TEXT NOT NULL,
        tone_profile TEXT NOT NULL,
        display_name TEXT DEFAULT '',
        listed INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS blocks (
        blocker_session_id TEXT NOT NULL,
        blocked_digits TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (blocker_session_id, blocked_digits)
      );

      CREATE TABLE IF NOT EXISTS faxes (
        id TEXT PRIMARY KEY,
        from_session_id TEXT,
        to_session_id TEXT,
        from_number TEXT NOT NULL,
        from_name TEXT DEFAULT '',
        to_number TEXT NOT NULL,
        pages_count INTEGER NOT NULL,
        fine INTEGER NOT NULL,
        stormy_line INTEGER NOT NULL,
        status TEXT NOT NULL,
        report_json TEXT NOT NULL,
        logs_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        from_session_id TEXT,
        to_session_id TEXT,
        from_number TEXT NOT NULL,
        from_name TEXT DEFAULT '',
        to_number TEXT NOT NULL,
        codec TEXT NOT NULL,
        stormy_line INTEGER NOT NULL,
        status TEXT NOT NULL,
        report_json TEXT NOT NULL,
        logs_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        key TEXT PRIMARY KEY,
        content_type TEXT NOT NULL,
        filename TEXT NOT NULL,
        data BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS staged_docs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    this.sqlReady = true;
  }

  // ---------- SQL Helpers ----------

  getSessionById(id) {
    if (!id) return null;
    const rows = this.ctx.storage.sql.exec('SELECT * FROM sessions WHERE id = ?', id).toArray();
    return rows[0] || null;
  }

  getSessionByDigits(digits) {
    if (!digits) return null;
    const rows = this.ctx.storage.sql.exec('SELECT * FROM sessions WHERE dial_digits = ?', digits).toArray();
    return rows[0] || null;
  }

  touchSession(id) {
    this.ctx.storage.sql.exec('UPDATE sessions SET last_seen = ? WHERE id = ?', Date.now(), id);
  }

  isBlockedByRecipient(recipientId, senderDigits) {
    if (!recipientId || !senderDigits) return false;
    const rows = this.ctx.storage.sql
      .exec('SELECT 1 AS ok FROM blocks WHERE blocker_session_id = ? AND blocked_digits = ?', recipientId, senderDigits)
      .toArray();
    return rows.length > 0;
  }

  isSessionOnline(sessionId) {
    if (!sessionId) return false;
    return this.ctx.getWebSockets(sessionId).length > 0;
  }

  sendWsToSession(sessionId, payload) {
    if (!sessionId) return;
    const raw = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets(sessionId)) {
      try {
        ws.send(raw);
      } catch {
        // closed
      }
    }
  }

  getDirectorySnapshot() {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, display_number, dial_digits, country, country_name, flag, display_name, listed, last_seen
         FROM sessions
         WHERE listed = 1 OR display_name != ''
         ORDER BY last_seen DESC
         LIMIT 60`
      )
      .toArray();

    const users = rows.map((row) => ({
      id: row.id,
      display_number: row.display_number,
      dial_digits: row.dial_digits,
      country: row.country,
      country_name: row.country_name,
      flag: row.flag,
      display_name: row.display_name,
      online: this.isSessionOnline(row.id),
      busy: this.busySessions.has(row.id),
      isBot: false,
    }));
    users.sort((a, b) => Number(b.online) - Number(a.online));
    return [...EDGE_BOTS, ...users];
  }

  broadcastDirectory() {
    const msg = JSON.stringify({ type: 'directory_update', directory: this.getDirectorySnapshot() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // ignore closed
      }
    }
  }

  getInboxForSession(sessionId, limit = 25) {
    const rows = this.ctx.storage.sql
      .exec('SELECT * FROM faxes WHERE to_session_id = ? ORDER BY created_at DESC LIMIT ?', sessionId, limit)
      .toArray();
    return rows.map((row) => ({
      id: row.id,
      fromNumber: row.from_number,
      fromName: row.from_name,
      toNumber: row.to_number,
      pagesCount: row.pages_count,
      fine: Boolean(row.fine),
      stormyLine: Boolean(row.stormy_line),
      status: row.status,
      report: JSON.parse(row.report_json),
      logs: JSON.parse(row.logs_json),
      previewUrls: Array.from({ length: row.pages_count }, (_, i) => `/api/fax/${row.id}/page/${i}.png`),
      tiffUrl: `/api/fax/${row.id}/fax.tif`,
      pcapUrl: `/api/fax/${row.id}/capture.pcap`,
      createdAt: row.created_at,
    }));
  }

  getCallsForSession(sessionId, limit = 25) {
    const rows = this.ctx.storage.sql
      .exec(
        'SELECT * FROM calls WHERE from_session_id = ? OR to_session_id = ? ORDER BY created_at DESC LIMIT ?',
        sessionId,
        sessionId,
        limit
      )
      .toArray();
    return rows.map((row) => ({
      id: row.id,
      direction: row.to_session_id === sessionId && row.from_session_id !== sessionId ? 'inbound' : 'outbound',
      fromNumber: row.from_number,
      fromName: row.from_name,
      toNumber: row.to_number,
      codec: row.codec,
      stormyLine: Boolean(row.stormy_line),
      status: row.status,
      report: JSON.parse(row.report_json),
      logs: JSON.parse(row.logs_json),
      callerWavUrl: `/api/call/${row.id}/caller.wav`,
      replyWavUrl: `/api/call/${row.id}/reply.wav`,
      pcapUrl: `/api/call/${row.id}/capture.pcap`,
      createdAt: row.created_at,
    }));
  }

  getOrCreateSession(request, url) {
    const cookies = parseCookies(request.headers.get('cookie') || '');
    const existingId = cookies[COOKIE_NAME];
    const tzHint = url.searchParams.get('tz') || request.headers.get('x-tz') || '';
    const geo = geolocateEdgeRequest(request, tzHint);

    if (existingId) {
      const existing = this.getSessionById(existingId);
      if (existing) {
        this.touchSession(existing.id);
        return { session: existing, geo, setHeaders: null };
      }
    }

    let generated = null;
    for (let attempt = 0; attempt < 15; attempt++) {
      const candidate = generateFaxNumberForCountry(geo.country);
      if (!this.getSessionByDigits(candidate.dialDigits) && !findBotByDigits(candidate.dialDigits)) {
        generated = candidate;
        break;
      }
    }
    if (!generated) {
      const arr = new Uint32Array(1);
      crypto.getRandomValues(arr);
      const fallbackNum = `+${geo.dialCode} 555-${100000 + (arr[0] % 899999)}`;
      generated = {
        displayNumber: fallbackNum,
        dialDigits: normalizeDigits(fallbackNum),
        country: geo.country,
        countryName: geo.countryName,
        flag: geo.flag,
        toneProfile: geo.toneProfile,
      };
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO sessions (id, display_number, dial_digits, country, country_name, flag, tone_profile, display_name, listed, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, ?, ?)`,
      id,
      generated.displayNumber,
      generated.dialDigits,
      generated.country,
      generated.countryName,
      generated.flag,
      generated.toneProfile,
      now,
      now
    );

    const session = this.getSessionById(id);
    const secureAttr = url.protocol === 'https:' ? '; Secure' : '';
    const setHeaders = new Headers();
    setHeaders.append(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(id)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${secureAttr}`
    );
    setHeaders.append(
      'Set-Cookie',
      `retrofax_number=${encodeURIComponent(session.display_number)}; Max-Age=31536000; Path=/; SameSite=Lax${secureAttr}`
    );

    return { session, geo, setHeaders };
  }

  resolveTarget(rawNumber, callerSession) {
    const digits = normalizeDigits(rawNumber);
    if (!digits || digits.length < 4) return { kind: 'invalid', digits };

    const bot = findBotByDigits(digits);
    if (bot) return { kind: 'bot', bot };

    let target = this.getSessionByDigits(digits);
    if (!target && callerSession) {
      const meta = getCountryMeta(callerSession.country);
      const localStripped = digits.replace(/^0+/, '');
      target =
        this.getSessionByDigits(`${meta.dialCode}${digits}`) ||
        this.getSessionByDigits(`${meta.dialCode}${localStripped}`);
    }

    if (!target) return { kind: 'unknown', digits };
    return { kind: 'user', session: target };
  }

  saveArtifact(key, contentType, filename, bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO artifacts (key, content_type, filename, data, created_at) VALUES (?, ?, ?, ?, ?)',
      key,
      contentType,
      filename,
      u8,
      Date.now()
    );
  }

  getArtifact(key) {
    const rows = this.ctx.storage.sql.exec('SELECT * FROM artifacts WHERE key = ?', key).toArray();
    return rows[0] || null;
  }

  async persistCompletedFax({
    fromSession,
    toSession,
    fromNumber,
    fromName,
    toNumber,
    fine,
    stormyLine,
    receivedPages,
    pcapBuffer,
    logs,
    report,
  }) {
    const faxId = crypto.randomUUID();
    const tiffBytes = buildGroup3Tiff(receivedPages, { fine });
    this.saveArtifact(`fax:${faxId}:tif`, 'image/tiff', `retrofax-${faxId.slice(0, 8)}.tif`, tiffBytes);
    this.saveArtifact(`fax:${faxId}:pcap`, 'application/vnd.tcpdump.pcap', `retrofax-t38-${faxId.slice(0, 8)}.pcap`, pcapBuffer);

    const previewUrls = [];
    for (let idx = 0; idx < receivedPages.length; idx++) {
      const p = receivedPages[idx];
      const pngBytes = await renderThermalPngEdge(p.pixels, p.width, p.height, { fine });
      this.saveArtifact(`fax:${faxId}:page:${idx}`, 'image/png', `page-${idx}.png`, pngBytes);
      previewUrls.push(`/api/fax/${faxId}/page/${idx}.png`);
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO faxes (id, from_session_id, to_session_id, from_number, from_name, to_number, pages_count, fine, stormy_line, status, report_json, logs_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?)`,
      faxId,
      fromSession?.id || null,
      toSession?.id || null,
      fromNumber,
      fromName || '',
      toNumber,
      receivedPages.length,
      fine ? 1 : 0,
      stormyLine ? 1 : 0,
      JSON.stringify(report),
      JSON.stringify(logs),
      Date.now()
    );

    return {
      faxId,
      previewUrls,
      tiffUrl: `/api/fax/${faxId}/fax.tif`,
      pcapUrl: `/api/fax/${faxId}/capture.pcap`,
      report,
      logs,
    };
  }

  persistCompletedCall({
    fromSession,
    toSession,
    fromNumber,
    fromName,
    toNumber,
    codec,
    stormyLine,
    calleeReceivedWav,
    callerReturnWav,
    pcapBuffer,
    logs,
    report,
  }) {
    const callId = crypto.randomUUID();
    this.saveArtifact(`call:${callId}:caller`, 'audio/wav', `caller-${callId.slice(0, 8)}.wav`, calleeReceivedWav);
    this.saveArtifact(`call:${callId}:reply`, 'audio/wav', `reply-${callId.slice(0, 8)}.wav`, callerReturnWav);
    this.saveArtifact(
      `call:${callId}:pcap`,
      'application/vnd.tcpdump.pcap',
      `retrofax-sip-${codec.toLowerCase()}-${callId.slice(0, 8)}.pcap`,
      pcapBuffer
    );

    this.ctx.storage.sql.exec(
      `INSERT INTO calls (id, from_session_id, to_session_id, from_number, from_name, to_number, codec, stormy_line, status, report_json, logs_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?)`,
      callId,
      fromSession?.id || null,
      toSession?.id || null,
      fromNumber,
      fromName || '',
      toNumber,
      codec,
      stormyLine ? 1 : 0,
      JSON.stringify(report),
      JSON.stringify(logs),
      Date.now()
    );

    return {
      callId,
      callerWavUrl: `/api/call/${callId}/caller.wav`,
      replyWavUrl: `/api/call/${callId}/reply.wav`,
      pcapUrl: `/api/call/${callId}/capture.pcap`,
      report,
      logs,
    };
  }

  async makeCoverSheetPngBytes(coverSheet, session, fallbackSubject) {
    const covPixels = buildCoverSheetPageEdge({
      from: coverSheet.from || session.display_name || session.display_number,
      to: coverSheet.to || '',
      company: coverSheet.company || 'Dunder & Beige Systems',
      subject: coverSheet.subject || fallbackSubject,
      comments: coverSheet.comments || '',
      flags: coverSheet.flags || ['URGENT'],
      totalDocPages: coverSheet.totalDocPages || 1,
      fine: true,
    });
    return renderThermalPngEdge(covPixels.pixels, covPixels.width, covPixels.height, { fine: true });
  }

  // ---------- Async T.38 Fax & SIP Jobs ----------

  async runTransmissionJob({ txId, stageId, callerSession, staged, resolved, rawDialed, fine, stormyLine }) {
    this.busySessions.add(callerSession.id);
    this.broadcastDirectory();

    let targetSession = null;
    let targetDisplayNumber = rawDialed;
    let targetStatus = 'online';

    if (resolved.kind === 'bot') {
      targetDisplayNumber = resolved.bot.display_number;
      targetStatus = 'online';
    } else if (resolved.kind === 'unknown') {
      targetStatus = 'offline';
    } else if (resolved.kind === 'user') {
      targetSession = resolved.session;
      targetDisplayNumber = targetSession.display_number;
      if (this.isBlockedByRecipient(targetSession.id, callerSession.dial_digits)) {
        targetStatus = 'busy';
      } else if (!this.isSessionOnline(targetSession.id)) {
        targetStatus = 'offline';
      } else if (this.busySessions.has(targetSession.id) && targetSession.id !== callerSession.id) {
        targetStatus = 'busy';
      } else {
        targetStatus = 'online';
      }
    }

    if (targetSession && targetStatus === 'online' && targetSession.id !== callerSession.id) {
      this.busySessions.add(targetSession.id);
      this.broadcastDirectory();
    }

    try {
      const fromLabel = callerSession.display_name
        ? `${callerSession.display_name} (${callerSession.display_number})`
        : callerSession.display_number;

      const faxPages = [];
      for (let i = 0; i < staged.rawPagePngsB64.length; i++) {
        const pngBytes = base64ToUint8(staged.rawPagePngsB64[i]);
        const dithered = await rasterizePngEdge(pngBytes, { fine });
        const withTti = prependTtiHeaderEdge(dithered, {
          fine,
          fromLabel,
          toLabel: targetDisplayNumber,
          pageNum: i + 1,
          totalPages: staged.rawPagePngsB64.length,
        });
        faxPages.push(withTti);
      }

      let rxNotifiedRinging = false;
      let rxNotifiedHandshake = false;

      const result = await executeT38TransmissionEdge({
        fromNumber: callerSession.display_number,
        toNumber: targetDisplayNumber,
        pages: faxPages,
        fine,
        stormyLine,
        targetStatus,
        pacingMs: 16,
        onEvent: (event) => {
          this.sendWsToSession(callerSession.id, { type: 'tx_event', txId, event });
          if (targetSession && targetStatus === 'online') {
            if (event.phase === 'RINGING' && !rxNotifiedRinging) {
              rxNotifiedRinging = true;
              this.sendWsToSession(targetSession.id, {
                type: 'rx_event',
                rxId: txId,
                event: {
                  type: 'incoming_ring',
                  fromNumber: callerSession.display_number,
                  fromName: callerSession.display_name || 'Unknown Caller',
                },
              });
            } else if (event.phase === 'HANDSHAKE' && !rxNotifiedHandshake) {
              rxNotifiedHandshake = true;
              this.sendWsToSession(targetSession.id, {
                type: 'rx_event',
                rxId: txId,
                event: { type: 'rx_handshake', detail: event.detail },
              });
            } else if (event.type === 'progress') {
              this.sendWsToSession(targetSession.id, {
                type: 'rx_event',
                rxId: txId,
                event: {
                  type: 'rx_progress',
                  page: event.page,
                  totalPages: event.totalPages,
                  overallProgress: event.overallProgress,
                },
              });
            } else if (event.type === 't38_log') {
              this.sendWsToSession(targetSession.id, { type: 'rx_event', rxId: txId, event });
            }
          }
        },
      });

      if (result.status !== 'ok') {
        this.sendWsToSession(callerSession.id, {
          type: 'tx_event',
          txId,
          event: { type: 'tx_failed', reason: result.status, report: result.report, logs: result.logs },
        });
        return;
      }

      const saved = await this.persistCompletedFax({
        fromSession: callerSession,
        toSession: targetSession,
        fromNumber: callerSession.display_number,
        fromName: callerSession.display_name || '',
        toNumber: targetDisplayNumber,
        fine,
        stormyLine,
        receivedPages: result.receivedPages,
        pcapBuffer: result.pcapBuffer,
        logs: result.logs,
        report: result.report,
      });

      this.ctx.storage.sql.exec('DELETE FROM staged_docs WHERE id = ?', stageId);
      this.sendWsToSession(callerSession.id, {
        type: 'tx_event',
        txId,
        event: {
          type: 'tx_complete',
          faxId: saved.faxId,
          report: saved.report,
          tiffUrl: saved.tiffUrl,
          pcapUrl: saved.pcapUrl,
          previewUrls: saved.previewUrls,
          logs: saved.logs,
        },
      });

      if (targetSession) {
        this.sendWsToSession(targetSession.id, {
          type: 'rx_event',
          rxId: txId,
          event: {
            type: 'rx_complete',
            fax: {
              id: saved.faxId,
              fromNumber: callerSession.display_number,
              fromName: callerSession.display_name || 'Unknown Sender',
              toNumber: targetDisplayNumber,
              pagesCount: result.receivedPages.length,
              fine,
              stormyLine,
              previewUrls: saved.previewUrls,
              tiffUrl: saved.tiffUrl,
              pcapUrl: saved.pcapUrl,
              report: saved.report,
              logs: saved.logs,
              createdAt: Date.now(),
            },
          },
        });
      }

      if (resolved.kind === 'bot') {
        await new Promise((r) => setTimeout(r, 900));
        await this.triggerBotCallback({
          bot: resolved.bot,
          targetSession: callerSession,
          receivedPages: result.receivedPages,
          fine,
        });
      }
    } finally {
      this.busySessions.delete(callerSession.id);
      if (targetSession) this.busySessions.delete(targetSession.id);
      this.broadcastDirectory();
    }
  }

  async triggerBotCallback({ bot, targetSession, receivedPages, fine }) {
    if (!this.isSessionOnline(targetSession.id) || this.busySessions.has(targetSession.id)) return;
    this.busySessions.add(targetSession.id);
    this.broadcastDirectory();
    const rxId = crypto.randomUUID();

    try {
      const replyRawPages = await generateBotReplyFaxPagesEdge(bot.id, {
        senderNumber: targetSession.display_number,
        senderName: targetSession.display_name,
        receivedPages,
        fine,
      });

      const faxPages = replyRawPages.map((p, idx) =>
        prependTtiHeaderEdge(p, {
          fine,
          fromLabel: `${bot.display_name} (${bot.display_number})`,
          toLabel: targetSession.display_number,
          pageNum: idx + 1,
          totalPages: replyRawPages.length,
        })
      );

      let notifiedRing = false;
      let notifiedHandshake = false;
      const result = await executeT38TransmissionEdge({
        fromNumber: bot.display_number,
        toNumber: targetSession.display_number,
        pages: faxPages,
        fine,
        stormyLine: false,
        targetStatus: this.isSessionOnline(targetSession.id) ? 'online' : 'offline',
        pacingMs: 14,
        onEvent: (event) => {
          if (event.phase === 'RINGING' && !notifiedRing) {
            notifiedRing = true;
            this.sendWsToSession(targetSession.id, {
              type: 'rx_event',
              rxId,
              event: { type: 'incoming_ring', fromNumber: bot.display_number, fromName: bot.display_name },
            });
          } else if (event.phase === 'HANDSHAKE' && !notifiedHandshake) {
            notifiedHandshake = true;
            this.sendWsToSession(targetSession.id, {
              type: 'rx_event',
              rxId,
              event: { type: 'rx_handshake', detail: event.detail },
            });
          } else if (event.type === 'progress') {
            this.sendWsToSession(targetSession.id, {
              type: 'rx_event',
              rxId,
              event: {
                type: 'rx_progress',
                page: event.page,
                totalPages: event.totalPages,
                overallProgress: event.overallProgress,
              },
            });
          } else if (event.type === 't38_log') {
            this.sendWsToSession(targetSession.id, { type: 'rx_event', rxId, event });
          }
        },
      });

      if (result.status !== 'ok') return;

      const saved = await this.persistCompletedFax({
        fromSession: null,
        toSession: targetSession,
        fromNumber: bot.display_number,
        fromName: bot.display_name,
        toNumber: targetSession.display_number,
        fine,
        stormyLine: false,
        receivedPages: result.receivedPages,
        pcapBuffer: result.pcapBuffer,
        logs: result.logs,
        report: result.report,
      });

      this.sendWsToSession(targetSession.id, {
        type: 'rx_event',
        rxId,
        event: {
          type: 'rx_complete',
          fax: {
            id: saved.faxId,
            fromNumber: bot.display_number,
            fromName: bot.display_name,
            toNumber: targetSession.display_number,
            pagesCount: result.receivedPages.length,
            fine,
            stormyLine: false,
            previewUrls: saved.previewUrls,
            tiffUrl: saved.tiffUrl,
            pcapUrl: saved.pcapUrl,
            report: saved.report,
            logs: saved.logs,
            createdAt: Date.now(),
          },
        },
      });
    } finally {
      this.busySessions.delete(targetSession.id);
      this.broadcastDirectory();
    }
  }

  async runSipBotCallJob({ callTxId, callerSession, resolved, rawDialed, codec, ttsText, stormyLine }) {
    this.busySessions.add(callerSession.id);
    this.broadcastDirectory();

    let targetSession = null;
    let targetDisplayNumber = rawDialed;
    let targetStatus = 'online';
    let botId = null;

    if (resolved.kind === 'bot') {
      targetDisplayNumber = resolved.bot.display_number;
      botId = resolved.bot.id;
      targetStatus = 'online';
    } else if (resolved.kind === 'unknown') {
      targetStatus = 'offline';
    } else if (resolved.kind === 'user') {
      targetSession = resolved.session;
      targetDisplayNumber = targetSession.display_number;
      targetStatus = this.isBlockedByRecipient(targetSession.id, callerSession.dial_digits)
        ? 'busy'
        : this.isSessionOnline(targetSession.id)
          ? this.busySessions.has(targetSession.id) && targetSession.id !== callerSession.id
            ? 'busy'
            : 'online'
          : 'offline';
    }

    try {
      const result = await executeSipVoiceCallEdge({
        fromNumber: callerSession.display_number,
        toNumber: targetDisplayNumber,
        codec,
        ttsText,
        targetStatus,
        stormyLine,
        botId,
        pacingMs: 6,
        onEvent: (event) => {
          this.sendWsToSession(callerSession.id, { type: 'call_tx_event', callTxId, event });
        },
      });

      if (result.status !== 'ok') {
        this.sendWsToSession(callerSession.id, {
          type: 'call_tx_event',
          callTxId,
          event: { type: 'call_tx_failed', reason: result.status, report: result.report, logs: result.logs },
        });
        return;
      }

      const saved = this.persistCompletedCall({
        fromSession: callerSession,
        toSession: targetSession,
        fromNumber: callerSession.display_number,
        fromName: callerSession.display_name || '',
        toNumber: targetDisplayNumber,
        codec,
        stormyLine,
        calleeReceivedWav: result.calleeReceivedWav,
        callerReturnWav: result.callerReturnWav,
        pcapBuffer: result.pcapBuffer,
        logs: result.logs,
        report: result.report,
      });

      this.sendWsToSession(callerSession.id, {
        type: 'call_tx_event',
        callTxId,
        event: {
          type: 'call_tx_complete',
          callId: saved.callId,
          codec,
          fromNumber: callerSession.display_number,
          toNumber: targetDisplayNumber,
          report: saved.report,
          callerWavUrl: saved.callerWavUrl,
          replyWavUrl: saved.replyWavUrl,
          pcapUrl: saved.pcapUrl,
          logs: saved.logs,
          createdAt: Date.now(),
        },
      });
    } finally {
      this.busySessions.delete(callerSession.id);
      this.broadcastDirectory();
    }
  }

  // ---------- Live Peer-to-Peer SIP/RTP End & Cleanup ----------

  endLiveCall(callId, { reason = 'hangup', endedBy = 'system', sipCode = 200 } = {}) {
    const call = this.activeLiveCalls.get(callId);
    if (!call) return;
    if (call.ringTimer) {
      clearTimeout(call.ringTimer);
      call.ringTimer = null;
    }
    this.activeLiveCalls.delete(callId);

    const elapsed = Date.now() - call.createdAt;
    const endLogs = [];
    if (call.state === 'RINGING') {
      if (reason === 'declined' || sipCode === 486) {
        endLogs.push(
          { ts: elapsed, layer: 'SIP', direction: 'RX->TX', summary: 'SIP/2.0 486 Busy Here (Call declined)' },
          { ts: elapsed + 10, layer: 'SIP', direction: 'TX->RX', summary: `ACK sip:${normalizeDigits(call.toNumber)}@retrofax.edge SIP/2.0` }
        );
      } else if (reason === 'no_answer' || sipCode === 480) {
        endLogs.push(
          { ts: elapsed, layer: 'SIP', direction: 'RX->TX', summary: 'SIP/2.0 480 Temporarily Unavailable (Ring timeout)' },
          { ts: elapsed + 10, layer: 'SIP', direction: 'TX->RX', summary: `ACK sip:${normalizeDigits(call.toNumber)}@retrofax.edge SIP/2.0` }
        );
      } else {
        endLogs.push(
          { ts: elapsed, layer: 'SIP', direction: 'TX->RX', summary: `CANCEL sip:${normalizeDigits(call.toNumber)}@retrofax.edge SIP/2.0` },
          { ts: elapsed + 8, layer: 'SIP', direction: 'RX->TX', summary: 'SIP/2.0 487 Request Terminated' },
          { ts: elapsed + 12, layer: 'SIP', direction: 'TX->RX', summary: `ACK sip:${normalizeDigits(call.toNumber)}@retrofax.edge SIP/2.0` }
        );
      }
    } else {
      endLogs.push(
        { ts: elapsed, layer: 'SIP', direction: endedBy === call.callerSid ? 'TX->RX' : 'RX->TX', summary: 'BYE sip:retrofax.edge SIP/2.0' },
        { ts: elapsed + 8, layer: 'SIP', direction: endedBy === call.callerSid ? 'RX->TX' : 'TX->RX', summary: 'SIP/2.0 200 OK (Live Voice Session Closed)' }
      );
    }

    this.busySessions.delete(call.callerSid);
    this.busySessions.delete(call.calleeSid);
    this.broadcastDirectory();

    const wasRinging = call.state === 'RINGING';
    if (wasRinging && reason !== 'hangup') {
      this.sendWsToSession(call.callerSid, {
        type: 'live_call_rejected',
        callId,
        reason: sipCode === 486 ? 'busy' : 'no_answer',
        sipCode,
        logs: endLogs,
        report: { toNumber: call.toNumber, codec: call.codec, callId: call.sipCallId },
      });
      this.sendWsToSession(call.calleeSid, {
        type: 'live_call_ended',
        callId,
        endedBy,
        reason,
        logs: endLogs,
      });
    } else {
      for (const sid of [call.callerSid, call.calleeSid]) {
        this.sendWsToSession(sid, {
          type: 'live_call_ended',
          callId,
          endedBy,
          reason,
          logs: endLogs,
        });
      }
    }
  }

  // ---------- Hibernatable WebSocket Handlers ----------

  async webSocketMessage(ws, rawMessage) {
    this.ensureSchema();
    const att = ws.deserializeAttachment() || {};
    const sessionId = att.sessionId;
    if (!sessionId) return;

    let msg;
    try {
      msg = JSON.parse(typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage));
    } catch {
      return;
    }

    if (msg.type === 'live_call_invite') {
      const toNumber = String(msg.toNumber || '').trim();
      const codec = normalizeCodecId(msg.codec || 'G711U');
      const stormyLine = Boolean(msg.stormyLine);
      const caller = this.getSessionById(sessionId);
      if (!caller) return;

      if (this.busySessions.has(caller.id)) {
        ws.send(JSON.stringify({ type: 'live_call_rejected', reason: 'busy', sipCode: 486, logs: [] }));
        return;
      }

      const resolved = this.resolveTarget(toNumber, caller);
      if (resolved.kind === 'bot') {
        ws.send(JSON.stringify({ type: 'live_call_use_bot', toNumber: resolved.bot.display_number, codec }));
        return;
      }

      const sipCallId = `${crypto.randomUUID()}@retrofax.edge`;
      if (resolved.kind === 'invalid') {
        ws.send(JSON.stringify({ type: 'live_call_rejected', reason: 'invalid', sipCode: 400, logs: [] }));
        return;
      }

      if (resolved.kind === 'unknown' || !this.isSessionOnline(resolved.session.id)) {
        const logs = [
          makeLiveSipInviteLog(toNumber, codec, sipCallId),
          { ts: 40, layer: 'SIP', direction: 'RX->TX', summary: 'SIP/2.0 100 Trying' },
          { ts: 650, layer: 'SIP', direction: 'RX->TX', summary: 'SIP/2.0 480 Temporarily Unavailable (User Offline / No Answer)' },
          { ts: 660, layer: 'SIP', direction: 'TX->RX', summary: `ACK sip:${normalizeDigits(toNumber)}@retrofax.edge SIP/2.0` },
        ];
        ws.send(
          JSON.stringify({
            type: 'live_call_rejected',
            reason: 'no_answer',
            sipCode: 480,
            logs,
            report: { toNumber, codec, callId: sipCallId },
          })
        );
        return;
      }

      const callee = resolved.session;
      if (callee.id === caller.id) {
        ws.send(
          JSON.stringify({
            type: 'live_call_rejected',
            reason: 'self_call',
            sipCode: 486,
            logs: [
              {
                ts: 0,
                layer: 'SIP',
                direction: 'RX->TX',
                summary: 'SIP/2.0 486 Busy Here (Cannot call your own active line live — open another visitor/tab or dial a Bot)',
              },
            ],
          })
        );
        return;
      }

      if (this.isBlockedByRecipient(callee.id, caller.dial_digits) || this.busySessions.has(callee.id)) {
        const logs = [
          makeLiveSipInviteLog(callee.display_number, codec, sipCallId),
          { ts: 30, layer: 'SIP', direction: 'RX->TX', summary: 'SIP/2.0 486 Busy Here (Recipient Line In Use)' },
        ];
        ws.send(
          JSON.stringify({
            type: 'live_call_rejected',
            reason: 'busy',
            sipCode: 486,
            logs,
            report: { toNumber: callee.display_number, codec, callId: sipCallId },
          })
        );
        return;
      }

      const callId = crypto.randomUUID();
      this.busySessions.add(caller.id);
      this.busySessions.add(callee.id);
      this.broadcastDirectory();

      const ringLogs = [
        makeLiveSipInviteLog(callee.display_number, codec, sipCallId),
        { ts: 12, layer: 'SIP', direction: 'RX->TX', summary: 'SIP/2.0 100 Trying' },
        { ts: 28, layer: 'SIP', direction: 'RX->TX', summary: 'SIP/2.0 180 Ringing (Live Browser Handset Alerting)' },
      ];

      const callRecord = {
        callId,
        callerSid: caller.id,
        calleeSid: callee.id,
        fromNumber: caller.display_number,
        fromName: caller.display_name || 'Anonymous Visitor',
        toNumber: callee.display_number,
        toName: callee.display_name || 'Online Station',
        codec,
        stormyLine,
        sipCallId,
        state: 'RINGING',
        createdAt: Date.now(),
        ringTimer: setTimeout(() => {
          this.endLiveCall(callId, { reason: 'no_answer', endedBy: 'timeout', sipCode: 480 });
        }, 35000),
      };
      this.activeLiveCalls.set(callId, callRecord);

      this.sendWsToSession(caller.id, {
        type: 'live_call_ringing',
        callId,
        toNumber: callee.display_number,
        toName: callRecord.toName,
        codec,
        sipCallId,
        logs: ringLogs,
      });

      this.sendWsToSession(callee.id, {
        type: 'live_call_incoming',
        callId,
        fromNumber: caller.display_number,
        fromName: callRecord.fromName,
        codec,
        sipCallId,
        stormyLine,
        logs: ringLogs,
      });
    } else if (msg.type === 'live_call_answer') {
      const call = this.activeLiveCalls.get(msg.callId);
      if (!call || call.calleeSid !== sessionId || call.state !== 'RINGING') return;
      if (call.ringTimer) {
        clearTimeout(call.ringTimer);
        call.ringTimer = null;
      }
      call.state = 'ACTIVE';
      call.answeredAt = Date.now();
      const c = buildLiveCodecSdpSpec(call.codec);
      const elapsed = call.answeredAt - call.createdAt;
      const acceptLogs = [
        { ts: elapsed, layer: 'SIP', direction: 'RX->TX', summary: `SIP/2.0 200 OK (Answer SDP: m=audio 5006 RTP/AVP ${c.pt} a=rtpmap:${c.rtpmap})` },
        { ts: elapsed + 8, layer: 'SIP', direction: 'TX->RX', summary: `ACK sip:${normalizeDigits(call.toNumber)}@retrofax.edge SIP/2.0 (Live Duplex RTP Started)` },
      ];

      this.sendWsToSession(call.callerSid, {
        type: 'live_call_connected',
        callId: call.callId,
        role: 'caller',
        peerNumber: call.toNumber,
        peerName: call.toName,
        codec: call.codec,
        sipCallId: call.sipCallId,
        stormyLine: call.stormyLine,
        logs: acceptLogs,
      });
      this.sendWsToSession(call.calleeSid, {
        type: 'live_call_connected',
        callId: call.callId,
        role: 'callee',
        peerNumber: call.fromNumber,
        peerName: call.fromName,
        codec: call.codec,
        sipCallId: call.sipCallId,
        stormyLine: call.stormyLine,
        logs: acceptLogs,
      });
    } else if (msg.type === 'live_call_decline') {
      const call = this.activeLiveCalls.get(msg.callId);
      if (!call || call.calleeSid !== sessionId) return;
      this.endLiveCall(call.callId, { reason: 'declined', endedBy: sessionId, sipCode: 486 });
    } else if (msg.type === 'live_call_hangup') {
      const call = this.activeLiveCalls.get(msg.callId);
      if (!call || (call.callerSid !== sessionId && call.calleeSid !== sessionId)) return;
      this.endLiveCall(call.callId, { reason: 'hangup', endedBy: sessionId, sipCode: 200 });
    } else if (msg.type === 'live_rtp') {
      const call = this.activeLiveCalls.get(msg.callId);
      if (!call || call.state !== 'ACTIVE') return;
      if (call.callerSid !== sessionId && call.calleeSid !== sessionId) return;
      const peerSid = call.callerSid === sessionId ? call.calleeSid : call.callerSid;
      this.sendWsToSession(peerSid, {
        type: 'live_rtp',
        callId: call.callId,
        rtpB64: msg.rtpB64,
      });
    } else if (msg.type === 'live_dtmf') {
      const call = this.activeLiveCalls.get(msg.callId);
      if (!call || call.state !== 'ACTIVE') return;
      if (call.callerSid !== sessionId && call.calleeSid !== sessionId) return;
      const peerSid = call.callerSid === sessionId ? call.calleeSid : call.callerSid;
      this.sendWsToSession(peerSid, {
        type: 'live_dtmf',
        callId: call.callId,
        digit: String(msg.digit || ''),
      });
    }
  }

  cleanupSocketDisconnect(ws) {
    this.ensureSchema();
    const att = ws.deserializeAttachment() || {};
    const sessionId = att.sessionId;
    if (!sessionId) return;

    const remaining = this.ctx.getWebSockets(sessionId).filter((s) => s !== ws);
    if (remaining.length === 0) {
      for (const [callId, call] of this.activeLiveCalls.entries()) {
        if (call.callerSid === sessionId || call.calleeSid === sessionId) {
          this.endLiveCall(callId, { reason: 'hangup', endedBy: sessionId, sipCode: 200 });
        }
      }
      this.busySessions.delete(sessionId);
    }
    this.broadcastDirectory();
  }

  async webSocketClose(ws) {
    this.cleanupSocketDisconnect(ws);
  }

  async webSocketError(ws) {
    this.cleanupSocketDisconnect(ws);
  }

  // ---------- HTTP + WebSocket Entry inside Durable Object ----------

  async fetch(request) {
    this.ensureSchema();
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();

    // WebSocket Upgrade (/ws)
    if (pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const cookies = parseCookies(request.headers.get('cookie') || '');
      const sid = cookies[COOKIE_NAME] || url.searchParams.get('sid');
      const session = this.getSessionById(sid);
      if (!session) {
        return new Response('No session cookie', { status: 401 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({ sessionId: session.id });
      this.ctx.acceptWebSocket(server, [session.id]);
      this.touchSession(session.id);

      server.send(
        JSON.stringify({
          type: 'connected',
          sessionId: session.id,
          displayNumber: session.display_number,
        })
      );
      this.broadcastDirectory();

      return new Response(null, { status: 101, webSocket: client });
    }

    // REST API Routes
    if (method === 'GET' && pathname === '/api/health') {
      return jsonResponse({
        ok: true,
        runtime: 'cloudflare-workers-do',
        protocols: ['ITU-T T.38 UDPTL', 'SIP/RTP G.711/G.722/G.729'],
      });
    }

    if (method === 'GET' && pathname === '/api/session') {
      const { session, geo, setHeaders } = this.getOrCreateSession(request, url);
      return jsonResponse(
        {
          session: {
            id: session.id,
            displayNumber: session.display_number,
            dialDigits: session.dial_digits,
            country: session.country,
            countryName: session.country_name,
            flag: session.flag,
            toneProfile: session.tone_profile,
            displayName: session.display_name,
            listed: Boolean(session.listed),
          },
          geo: { ip: geo.ip, country: geo.country, city: geo.city, source: geo.source },
          directory: this.getDirectorySnapshot(),
          inbox: this.getInboxForSession(session.id),
          calls: this.getCallsForSession(session.id),
          capabilities: { serverConversion: false, liveSip: true },
        },
        200,
        setHeaders
      );
    }

    if (method === 'GET' && pathname === '/api/directory') {
      return jsonResponse({ directory: this.getDirectorySnapshot() });
    }

    if (method === 'POST' && pathname === '/api/directory') {
      const { session, setHeaders } = this.getOrCreateSession(request, url);
      const body = await request.json().catch(() => ({}));
      const cleanName = String(body.displayName || '').trim().slice(0, 32);
      const isListed = body.listed ? 1 : 0;
      this.ctx.storage.sql.exec(
        'UPDATE sessions SET display_name = ?, listed = ?, last_seen = ? WHERE id = ?',
        cleanName,
        isListed,
        Date.now(),
        session.id
      );
      this.broadcastDirectory();
      const updated = this.getSessionById(session.id);
      return jsonResponse(
        {
          displayName: updated.display_name,
          listed: Boolean(updated.listed),
          directory: this.getDirectorySnapshot(),
        },
        200,
        setHeaders
      );
    }

    if (method === 'POST' && pathname === '/api/block') {
      const { session, setHeaders } = this.getOrCreateSession(request, url);
      const body = await request.json().catch(() => ({}));
      const digits = normalizeDigits(body.senderNumber);
      if (digits) {
        this.ctx.storage.sql.exec(
          'INSERT OR IGNORE INTO blocks (blocker_session_id, blocked_digits, created_at) VALUES (?, ?, ?)',
          session.id,
          digits,
          Date.now()
        );
      }
      return jsonResponse({ ok: true }, 200, setHeaders);
    }

    if (method === 'POST' && pathname === '/api/stage/pages') {
      try {
        const { session, setHeaders } = this.getOrCreateSession(request, url);
        const body = await request.json().catch(() => ({}));
        const pages = Array.isArray(body.pages) ? body.pages : [];
        if (pages.length === 0) {
          return jsonResponse({ error: 'No pages provided.' }, 400, setHeaders);
        }
        const sourceLabel = String(body.sourceLabel || 'Document');
        const coverSheet = body.coverSheet || null;

        const rawDocPagesB64 = pages.slice(0, 4).map((d) => String(d || '').replace(/^data:image\/\w+;base64,/, ''));
        let finalPagesB64 = rawDocPagesB64;

        if (coverSheet && coverSheet.enabled) {
          const covPng = await this.makeCoverSheetPngBytes(
            { ...coverSheet, totalDocPages: rawDocPagesB64.length },
            session,
            sourceLabel
          );
          finalPagesB64 = [uint8ToBase64(covPng), ...rawDocPagesB64.slice(0, 3)];
        }

        const firstRas = await rasterizePngEdge(base64ToUint8(finalPagesB64[0]), { fine: true });
        const previewPng = await renderThermalPngEdge(firstRas.pixels, firstRas.width, firstRas.height, { fine: true });

        const stageId = crypto.randomUUID();
        const stagedPayload = {
          sessionId: session.id,
          rawDocPagesB64,
          rawPagePngsB64: finalPagesB64,
          coverMeta: coverSheet || {},
          hasCover: Boolean(coverSheet && coverSheet.enabled),
          sourceLabel,
          createdAt: Date.now(),
        };
        this.ctx.storage.sql.exec(
          'INSERT INTO staged_docs (id, session_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
          stageId,
          session.id,
          JSON.stringify(stagedPayload),
          Date.now()
        );
        // Prune staged docs older than 20m
        this.ctx.storage.sql.exec('DELETE FROM staged_docs WHERE created_at < ?', Date.now() - 20 * 60 * 1000);

        return jsonResponse(
          {
            stageId,
            sourceLabel,
            pagesCount: finalPagesB64.length,
            previewDataUrl: `data:image/png;base64,${uint8ToBase64(previewPng)}`,
          },
          200,
          setHeaders
        );
      } catch (err) {
        return jsonResponse({ error: `Page staging failed: ${err.message}` }, 400);
      }
    }

    if (method === 'POST' && pathname === '/api/stage') {
      const { session, setHeaders } = this.getOrCreateSession(request, url);
      const ct = request.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const body = await request.json().catch(() => ({}));
        if (body.memo) {
          const sheet = buildMonochromeSheetPixels({
            banner: String(body.memo.template || 'MEMORANDUM'),
            meta: [
              `FROM    : ${body.memo.from || session.display_name || session.display_number}`,
              `TO      : ${body.memo.to || 'RECIPIENT'}`,
              `SUBJECT : ${body.memo.subject || 'DESK MEMO'}`,
            ],
            lines: String(body.memo.body || '').split('\n'),
            fine: true,
          });
          const png = await renderThermalPngEdge(sheet.pixels, sheet.width, sheet.height, { fine: true });
          const b64 = uint8ToBase64(png);
          const stageId = crypto.randomUUID();
          const sourceLabel = body.memo.subject ? `Memo: ${body.memo.subject}` : 'Desk Memo';
          const stagedPayload = {
            sessionId: session.id,
            rawDocPagesB64: [b64],
            rawPagePngsB64: [b64],
            coverMeta: body.coverSheet || {},
            hasCover: false,
            sourceLabel,
            createdAt: Date.now(),
          };
          this.ctx.storage.sql.exec(
            'INSERT INTO staged_docs (id, session_id, payload_json, created_at) VALUES (?, ?, ?, ?)',
            stageId,
            session.id,
            JSON.stringify(stagedPayload),
            Date.now()
          );
          return jsonResponse(
            {
              stageId,
              sourceLabel,
              pagesCount: 1,
              previewDataUrl: `data:image/png;base64,${b64}`,
            },
            200,
            setHeaders
          );
        }
      }
      return jsonResponse(
        { error: 'Please upload images (.png/.jpg/.bmp/.svg) or .txt/.csv, or use Draw & Type Memo.' },
        400,
        setHeaders
      );
    }

    if (method === 'POST' && pathname === '/api/send') {
      const { session, setHeaders } = this.getOrCreateSession(request, url);
      const body = await request.json().catch(() => ({}));
      const { stageId, toNumber, fine = true, stormyLine = false, coverEnabled = undefined } = body;

      const rows = this.ctx.storage.sql.exec('SELECT * FROM staged_docs WHERE id = ?', stageId).toArray();
      const staged = rows[0] ? JSON.parse(rows[0].payload_json) : null;
      if (!staged || staged.sessionId !== session.id) {
        return jsonResponse(
          { error: 'No staged paper in tray. Click the top slot to load a file first.' },
          404,
          setHeaders
        );
      }

      const now = Date.now();
      const recent = (this.sendTimestamps.get(session.id) || []).filter((t) => now - t < 60_000);
      if (recent.length >= 6) {
        return jsonResponse(
          { error: 'Thermal head overheating! Wait a few seconds before sending again.' },
          429,
          setHeaders
        );
      }
      recent.push(now);
      this.sendTimestamps.set(session.id, recent);

      if (this.busySessions.has(session.id)) {
        return jsonResponse({ error: 'Your fax machine is already in an active T.38 session.' }, 409, setHeaders);
      }

      const resolved = this.resolveTarget(toNumber, session);
      if (resolved.kind === 'invalid') {
        return jsonResponse({ error: 'Please enter a valid fax number (at least 4 digits).' }, 400, setHeaders);
      }

      let sendPagesB64 = staged.rawPagePngsB64;
      if (coverEnabled === true && !staged.hasCover) {
        const covPng = await this.makeCoverSheetPngBytes(
          {
            from: staged.coverMeta?.from || session.display_name || session.display_number,
            to: staged.coverMeta?.to || toNumber || '',
            company: staged.coverMeta?.company || 'Dunder & Beige Systems',
            subject: staged.coverMeta?.subject || staged.sourceLabel,
            comments: staged.coverMeta?.comments || '',
            flags: staged.coverMeta?.flags || ['URGENT', 'FOR REVIEW'],
            totalDocPages: staged.rawDocPagesB64.length,
          },
          session,
          staged.sourceLabel
        );
        sendPagesB64 = [uint8ToBase64(covPng), ...staged.rawDocPagesB64.slice(0, 3)];
      } else if (coverEnabled === false && staged.hasCover) {
        sendPagesB64 = staged.rawDocPagesB64;
      }

      const txId = crypto.randomUUID();
      this.ctx.waitUntil(
        this.runTransmissionJob({
          txId,
          stageId,
          callerSession: session,
          staged: { ...staged, rawPagePngsB64: sendPagesB64 },
          resolved,
          rawDialed: toNumber,
          fine: Boolean(fine),
          stormyLine: Boolean(stormyLine),
        }).catch((err) => {
          this.sendWsToSession(session.id, {
            type: 'tx_event',
            txId,
            event: { type: 'error', error: err.message },
          });
        })
      );

      return jsonResponse({ ok: true, txId, targetNumber: toNumber }, 200, setHeaders);
    }

    if (method === 'POST' && pathname === '/api/call') {
      const { session, setHeaders } = this.getOrCreateSession(request, url);
      if (this.busySessions.has(session.id)) {
        return jsonResponse({ error: 'Line busy — another T.38 or SIP call is already active.' }, 409, setHeaders);
      }

      let toNumber = '';
      let codec = 'G711U';
      let ttsText = 'HELLO FROM 1994 RETROFAX';
      let stormyLine = false;

      const ct = request.headers.get('content-type') || '';
      if (ct.includes('multipart/form-data')) {
        const fd = await request.formData();
        toNumber = String(fd.get('toNumber') || '').trim();
        codec = normalizeCodecId(fd.get('codec') || 'G711U');
        ttsText = String(fd.get('ttsText') || 'HELLO FROM 1994 RETROFAX').trim();
        stormyLine = fd.get('stormyLine') === 'true' || fd.get('stormyLine') === '1';
      } else {
        const body = await request.json().catch(() => ({}));
        toNumber = String(body.toNumber || '').trim();
        codec = normalizeCodecId(body.codec || 'G711U');
        ttsText = String(body.ttsText || 'HELLO FROM 1994 RETROFAX').trim();
        stormyLine = Boolean(body.stormyLine);
      }

      const resolved = this.resolveTarget(toNumber, session);
      if (resolved.kind === 'invalid') {
        return jsonResponse({ error: 'Please enter a valid number (at least 4 digits).' }, 400, setHeaders);
      }

      const callTxId = crypto.randomUUID();
      this.ctx.waitUntil(
        this.runSipBotCallJob({
          callTxId,
          callerSession: session,
          resolved,
          rawDialed: toNumber,
          codec,
          ttsText,
          stormyLine,
        }).catch((err) => {
          this.sendWsToSession(session.id, {
            type: 'call_tx_event',
            callTxId,
            event: { type: 'error', error: err.message },
          });
        })
      );

      return jsonResponse({ ok: true, callTxId, codec, targetNumber: toNumber }, 200, setHeaders);
    }

    // Fax Artifacts & Metadata
    const faxPageMatch = pathname.match(/^\/api\/fax\/([^/]+)\/page\/(\d+)\.png$/);
    if (method === 'GET' && faxPageMatch) {
      const art = this.getArtifact(`fax:${faxPageMatch[1]}:page:${faxPageMatch[2]}`);
      if (!art) return new Response('Not found', { status: 404 });
      return new Response(art.data, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
    }

    const faxTiffMatch = pathname.match(/^\/api\/fax\/([^/]+)\/fax\.tif$/);
    if (method === 'GET' && faxTiffMatch) {
      const art = this.getArtifact(`fax:${faxTiffMatch[1]}:tif`);
      if (!art) return new Response('Not found', { status: 404 });
      return new Response(art.data, {
        headers: {
          'Content-Type': 'image/tiff',
          'Content-Disposition': `attachment; filename="${art.filename}"`,
        },
      });
    }

    const faxPcapMatch = pathname.match(/^\/api\/fax\/([^/]+)\/capture\.pcap$/);
    if (method === 'GET' && faxPcapMatch) {
      const art = this.getArtifact(`fax:${faxPcapMatch[1]}:pcap`);
      if (!art) return new Response('Not found', { status: 404 });
      return new Response(art.data, {
        headers: {
          'Content-Type': 'application/vnd.tcpdump.pcap',
          'Content-Disposition': `attachment; filename="${art.filename}"`,
        },
      });
    }

    const faxMetaMatch = pathname.match(/^\/api\/fax\/([^/]+)$/);
    if (method === 'GET' && faxMetaMatch) {
      const rows = this.ctx.storage.sql.exec('SELECT * FROM faxes WHERE id = ?', faxMetaMatch[1]).toArray();
      const fax = rows[0];
      if (!fax) return jsonResponse({ error: 'Fax not found' }, 404);
      return jsonResponse({
        id: fax.id,
        fromNumber: fax.from_number,
        fromName: fax.from_name,
        toNumber: fax.to_number,
        pagesCount: fax.pages_count,
        fine: Boolean(fax.fine),
        stormyLine: Boolean(fax.stormy_line),
        report: JSON.parse(fax.report_json),
        logs: JSON.parse(fax.logs_json),
        previewUrls: Array.from({ length: fax.pages_count }, (_, i) => `/api/fax/${fax.id}/page/${i}.png`),
        tiffUrl: `/api/fax/${fax.id}/fax.tif`,
        pcapUrl: `/api/fax/${fax.id}/capture.pcap`,
        createdAt: fax.created_at,
      });
    }

    // SIP Call Artifacts & Metadata
    const callCallerWavMatch = pathname.match(/^\/api\/call\/([^/]+)\/caller\.wav$/);
    if (method === 'GET' && callCallerWavMatch) {
      const art = this.getArtifact(`call:${callCallerWavMatch[1]}:caller`);
      if (!art) return new Response('Not found', { status: 404 });
      return new Response(art.data, { headers: { 'Content-Type': 'audio/wav' } });
    }

    const callReplyWavMatch = pathname.match(/^\/api\/call\/([^/]+)\/reply\.wav$/);
    if (method === 'GET' && callReplyWavMatch) {
      const art = this.getArtifact(`call:${callReplyWavMatch[1]}:reply`);
      if (!art) return new Response('Not found', { status: 404 });
      return new Response(art.data, { headers: { 'Content-Type': 'audio/wav' } });
    }

    const callPcapMatch = pathname.match(/^\/api\/call\/([^/]+)\/capture\.pcap$/);
    if (method === 'GET' && callPcapMatch) {
      const art = this.getArtifact(`call:${callPcapMatch[1]}:pcap`);
      if (!art) return new Response('Not found', { status: 404 });
      return new Response(art.data, {
        headers: {
          'Content-Type': 'application/vnd.tcpdump.pcap',
          'Content-Disposition': `attachment; filename="${art.filename}"`,
        },
      });
    }

    const callMetaMatch = pathname.match(/^\/api\/call\/([^/]+)$/);
    if (method === 'GET' && callMetaMatch) {
      const rows = this.ctx.storage.sql.exec('SELECT * FROM calls WHERE id = ?', callMetaMatch[1]).toArray();
      const call = rows[0];
      if (!call) return jsonResponse({ error: 'Call not found' }, 404);
      return jsonResponse({
        id: call.id,
        fromNumber: call.from_number,
        fromName: call.from_name,
        toNumber: call.to_number,
        codec: call.codec,
        stormyLine: Boolean(call.stormy_line),
        report: JSON.parse(call.report_json),
        logs: JSON.parse(call.logs_json),
        callerWavUrl: `/api/call/${call.id}/caller.wav`,
        replyWavUrl: `/api/call/${call.id}/reply.wav`,
        pcapUrl: `/api/call/${call.id}/capture.pcap`,
        createdAt: call.created_at,
      });
    }

    return new Response('Not found', { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
      const id = env.RETROFAX_HUB.idFromName('global-exchange');
      const stub = env.RETROFAX_HUB.get(id);

      const headers = new Headers(request.headers);
      const cfCountry = request.cf?.country || request.headers.get('cf-ipcountry') || '';
      const cfCity = request.cf?.city || '';
      const cfIp = request.headers.get('cf-connecting-ip') || '';
      if (cfCountry) headers.set('x-edge-country', String(cfCountry));
      if (cfCity) headers.set('x-edge-city', String(cfCity));
      if (cfIp) headers.set('x-edge-ip', String(cfIp));

      return stub.fetch(new Request(request, { headers }));
    }

    return env.ASSETS.fetch(request);
  },
};
