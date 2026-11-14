import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { WebSocketServer } from 'ws';

import {
  FAX_STORE_DIR,
  CALL_STORE_DIR,
  getSessionById,
  getSessionByDigits,
  createSession,
  touchSession,
  updateDirectoryProfile,
  listDirectorySessions,
  isBlockedByRecipient,
  blockSender,
  saveFaxRecord,
  getFaxById,
  getInboxForSession,
  saveCallRecord,
  getCallById,
  getCallsForSession,
} from './db.js';
import {
  geolocateRequest,
  generateFaxNumberForCountry,
  normalizeDigits,
  getCountryMeta,
} from './geo.js';
import {
  convertDocumentToPageImages,
  renderMemoToPngBuffer,
  renderCoverSheetToPngBuffer,
} from './converter/docToPages.js';
import { rasterizeToFaxPage, renderThermalPng } from './converter/dither.js';
import { buildGroup3Tiff } from './converter/tiffWriter.js';
import { executeT38Transmission } from './t38/engine.js';
import { executeSipVoiceCall } from './sip/engine.js';
import { normalizeCodecId, decodeUploadedAudioToPcm16 } from './sip/codecs.js';
import { synthesizeMessageAudio } from './sip/voiceSynth.js';
import { FAX_BOTS, findBotByDigits, generateBotReplyPages } from './bots.js';

const PORT = Number(process.env.PORT || 3001);
const COOKIE_NAME = 'retrofax_sid';

const app = express();
app.set('trust proxy', true);
app.use(cookieParser());
app.use(express.json({ limit: '6mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

// Active WebSocket connections per sessionId
const socketsBySession = new Map();
// Active call lock per sessionId
const busySessions = new Set();
// In-memory staged documents awaiting dial/send (TTL 20 min)
const stagedDocs = new Map();
// Simple per-session send rate limiter
const sendTimestamps = new Map();

function isSessionOnline(sessionId) {
  const set = socketsBySession.get(sessionId);
  if (!set) return false;
  for (const ws of set) {
    if (ws.readyState === 1) return true;
  }
  return false;
}

function sendWsToSession(sessionId, payload) {
  const set = socketsBySession.get(sessionId);
  if (!set) return;
  const raw = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1) {
      ws.send(raw);
    }
  }
}

function getDirectorySnapshot() {
  const dbRows = listDirectorySessions();
  const userEntries = dbRows.map((row) => ({
    id: row.id,
    display_number: row.display_number,
    dial_digits: row.dial_digits,
    country: row.country,
    country_name: row.country_name,
    flag: row.flag,
    display_name: row.display_name,
    online: isSessionOnline(row.id),
    busy: busySessions.has(row.id),
    isBot: false,
  }));

  // Sort online users first, then bots
  userEntries.sort((a, b) => Number(b.online) - Number(a.online));
  return [...FAX_BOTS, ...userEntries];
}

function broadcastDirectory() {
  const directory = getDirectorySnapshot();
  const payload = JSON.stringify({ type: 'directory_update', directory });
  for (const set of socketsBySession.values()) {
    for (const ws of set) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }
}

function getOrCreateSession(req, res) {
  const existingId = req.cookies?.[COOKIE_NAME];
  if (existingId) {
    const existing = getSessionById(existingId);
    if (existing) {
      touchSession(existing.id);
      return { session: existing, geo: geolocateRequest(req, req.query.tz || req.headers['x-tz'] || '') };
    }
  }

  const geo = geolocateRequest(req, req.query.tz || req.headers['x-tz'] || '');
  let generated;
  for (let attempt = 0; attempt < 15; attempt++) {
    const candidate = generateFaxNumberForCountry(geo.country);
    if (!getSessionByDigits(candidate.dialDigits) && !findBotByDigits(candidate.dialDigits)) {
      generated = candidate;
      break;
    }
  }
  if (!generated) {
    const fallbackNum = `+${geo.dialCode} 555-${crypto.randomInt(100000, 999999)}`;
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
  const session = createSession({
    id,
    displayNumber: generated.displayNumber,
    dialDigits: generated.dialDigits,
    country: generated.country,
    countryName: generated.countryName,
    flag: generated.flag,
    toneProfile: generated.toneProfile,
  });

  res.cookie(COOKIE_NAME, id, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
  res.cookie('retrofax_number', session.display_number, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
  });

  return { session, geo };
}

function resolveTarget(rawNumber, callerSession) {
  const digits = normalizeDigits(rawNumber);
  if (!digits || digits.length < 4) return { kind: 'invalid', digits };

  // 1. Check Bots
  const bot = findBotByDigits(digits);
  if (bot) return { kind: 'bot', bot };

  // 2. Exact dial_digits
  let target = getSessionByDigits(digits);

  // 3. Try local dialing without country code or leading 0
  if (!target && callerSession) {
    const callerMeta = getCountryMeta(callerSession.country);
    const localStripped = digits.replace(/^0+/, '');
    target =
      getSessionByDigits(`${callerMeta.dialCode}${digits}`) ||
      getSessionByDigits(`${callerMeta.dialCode}${localStripped}`);
  }

  if (!target) {
    return { kind: 'unknown', digits };
  }

  return { kind: 'user', session: target };
}

function persistCompletedFax({
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
  const dir = path.join(FAX_STORE_DIR, faxId);
  fs.mkdirSync(dir, { recursive: true });

  const tiffBuffer = buildGroup3Tiff(receivedPages, { fine });
  const tiffPath = path.join(dir, 'fax.tif');
  const pcapPath = path.join(dir, 'capture.pcap');
  fs.writeFileSync(tiffPath, tiffBuffer);
  fs.writeFileSync(pcapPath, pcapBuffer);

  return Promise.all(
    receivedPages.map(async (page, idx) => {
      const pngBuf = await renderThermalPng(page.pixels, page.width, page.height, { fine });
      const pPath = path.join(dir, `page-${idx}.png`);
      fs.writeFileSync(pPath, pngBuf);
      return pPath;
    })
  ).then((previewPaths) => {
    saveFaxRecord({
      id: faxId,
      fromSessionId: fromSession?.id || null,
      toSessionId: toSession?.id || null,
      fromNumber,
      fromName: fromName || '',
      toNumber,
      pagesCount: receivedPages.length,
      fine,
      stormyLine,
      status: 'ok',
      report,
      logs,
      tiffPath,
      pcapPath,
      previewPaths,
    });

    return {
      faxId,
      previewUrls: previewPaths.map((_, idx) => `/api/fax/${faxId}/page/${idx}.png`),
      tiffUrl: `/api/fax/${faxId}/fax.tif`,
      pcapUrl: `/api/fax/${faxId}/capture.pcap`,
      report,
      logs,
    };
  });
}

function persistCompletedCall({
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
  const dir = path.join(CALL_STORE_DIR, callId);
  fs.mkdirSync(dir, { recursive: true });

  const txWavPath = path.join(dir, 'caller.wav');
  const rxWavPath = path.join(dir, 'reply.wav');
  const pcapPath = path.join(dir, 'capture.pcap');
  fs.writeFileSync(txWavPath, calleeReceivedWav);
  fs.writeFileSync(rxWavPath, callerReturnWav);
  fs.writeFileSync(pcapPath, pcapBuffer);

  saveCallRecord({
    id: callId,
    fromSessionId: fromSession?.id || null,
    toSessionId: toSession?.id || null,
    fromNumber,
    fromName: fromName || '',
    toNumber,
    codec,
    stormyLine,
    status: 'ok',
    report,
    logs,
    txWavPath,
    rxWavPath,
    pcapPath,
  });

  return {
    callId,
    callerWavUrl: `/api/call/${callId}/caller.wav`,
    replyWavUrl: `/api/call/${callId}/reply.wav`,
    pcapUrl: `/api/call/${callId}/capture.pcap`,
    report,
    logs,
  };
}

// ---------- REST ROUTES ----------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, protocols: ['ITU-T T.38 UDPTL', 'SIP/RTP G.711/G.722/G.729'] });
});

app.get('/api/session', (req, res) => {
  const { session, geo } = getOrCreateSession(req, res);
  res.json({
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
    geo: {
      ip: geo.ip,
      country: geo.country,
      city: geo.city,
      source: geo.source,
    },
    directory: getDirectorySnapshot(),
    inbox: getInboxForSession(session.id),
    calls: getCallsForSession(session.id),
    capabilities: {
      serverConversion: true,
      liveSip: true,
    },
  });
});

app.post('/api/directory', (req, res) => {
  const { session } = getOrCreateSession(req, res);
  const { displayName, listed } = req.body || {};
  const updated = updateDirectoryProfile(session.id, { displayName, listed });
  broadcastDirectory();
  res.json({
    displayName: updated.display_name,
    listed: Boolean(updated.listed),
    directory: getDirectorySnapshot(),
  });
});

app.get('/api/directory', (req, res) => {
  res.json({ directory: getDirectorySnapshot() });
});

app.post('/api/block', (req, res) => {
  const { session } = getOrCreateSession(req, res);
  const { senderNumber } = req.body || {};
  blockSender(session.id, senderNumber);
  res.json({ ok: true });
});

// Stage a file (Image, PDF, DOCX, XLSX, PPTX, TXT) or a Memo (+ optional Cover Sheet)
app.post('/api/stage', upload.single('file'), async (req, res) => {
  try {
    const { session } = getOrCreateSession(req, res);
    let rawPagePngs = [];
    let sourceLabel = 'Document';

    if (req.file) {
      sourceLabel = req.file.originalname;
      rawPagePngs = await convertDocumentToPageImages(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );
    } else if (req.body?.memo) {
      const memo = typeof req.body.memo === 'string' ? JSON.parse(req.body.memo) : req.body.memo;
      sourceLabel = memo.subject ? `Memo: ${memo.subject}` : 'Desk Memo';
      const png = await renderMemoToPngBuffer({
        template: memo.template || 'MEMORANDUM',
        from: memo.from || session.display_name || session.display_number,
        to: memo.to || '',
        subject: memo.subject || '',
        body: memo.body || '',
        drawingDataUrl: memo.drawingDataUrl || '',
      });
      rawPagePngs = [png];
    } else {
      return res.status(400).json({ error: 'No document or memo provided.' });
    }

    if (!rawPagePngs || rawPagePngs.length === 0) {
      return res.status(400).json({ error: 'Could not extract any printable pages.' });
    }

    // Optional Cover Sheet
    let coverSheet = null;
    if (req.body?.coverSheet) {
      coverSheet =
        typeof req.body.coverSheet === 'string'
          ? JSON.parse(req.body.coverSheet)
          : req.body.coverSheet;
    }

    const rawDocPages = rawPagePngs.slice(0, 4);
    let finalPages = rawDocPages;
    if (coverSheet && coverSheet.enabled) {
      const covPng = await renderCoverSheetToPngBuffer({
        from: coverSheet.from || session.display_name || session.display_number,
        to: coverSheet.to || '',
        company: coverSheet.company || '',
        subject: coverSheet.subject || sourceLabel,
        comments: coverSheet.comments || '',
        flags: coverSheet.flags || ['URGENT'],
        totalDocPages: rawDocPages.length,
      });
      finalPages = [covPng, ...rawDocPages.slice(0, 3)];
    }

    // Generate thermal preview PNG for top tray
    const testFinePreview = await rasterizeToFaxPage(finalPages[0], {
      fine: true,
      fromLabel: session.display_name || session.display_number,
      toLabel: 'PREVIEW',
      pageNum: 1,
      totalPages: finalPages.length,
    });
    const previewPng = await renderThermalPng(
      testFinePreview.pixels,
      testFinePreview.width,
      testFinePreview.height,
      { fine: true }
    );

    const stageId = crypto.randomUUID();
    stagedDocs.set(stageId, {
      sessionId: session.id,
      rawDocPages,
      rawPagePngs: finalPages,
      coverMeta: coverSheet || {},
      hasCover: Boolean(coverSheet && coverSheet.enabled),
      sourceLabel,
      createdAt: Date.now(),
    });

    // Clean up expired staged docs (>20 min)
    const cutoff = Date.now() - 20 * 60 * 1000;
    for (const [k, v] of stagedDocs.entries()) {
      if (v.createdAt < cutoff) stagedDocs.delete(k);
    }

    res.json({
      stageId,
      sourceLabel,
      pagesCount: finalPages.length,
      previewDataUrl: `data:image/png;base64,${previewPng.toString('base64')}`,
    });
  } catch (err) {
    console.error('Stage error:', err);
    res.status(400).json({ error: `Document conversion failed: ${err.message}` });
  }
});

// Stage pre-rendered PNG pages (used seamlessly by both Node and Cloudflare Edge Workers)
app.post('/api/stage/pages', async (req, res) => {
  try {
    const { session } = getOrCreateSession(req, res);
    const { pages = [], sourceLabel = 'Document', coverSheet = null } = req.body || {};
    if (!Array.isArray(pages) || pages.length === 0) {
      return res.status(400).json({ error: 'No pages provided.' });
    }
    const rawDocPages = pages.slice(0, 4).map((d) => {
      const b64 = String(d || '').replace(/^data:image\/\w+;base64,/, '');
      return Buffer.from(b64, 'base64');
    });

    let finalPages = rawDocPages;
    if (coverSheet && coverSheet.enabled) {
      const covPng = await renderCoverSheetToPngBuffer({
        from: coverSheet.from || session.display_name || session.display_number,
        to: coverSheet.to || '',
        company: coverSheet.company || '',
        subject: coverSheet.subject || sourceLabel,
        comments: coverSheet.comments || '',
        flags: coverSheet.flags || ['URGENT'],
        totalDocPages: rawDocPages.length,
      });
      finalPages = [covPng, ...rawDocPages.slice(0, 3)];
    }

    const testFinePreview = await rasterizeToFaxPage(finalPages[0], {
      fine: true,
      fromLabel: session.display_name || session.display_number,
      toLabel: 'PREVIEW',
      pageNum: 1,
      totalPages: finalPages.length,
    });
    const previewPng = await renderThermalPng(
      testFinePreview.pixels,
      testFinePreview.width,
      testFinePreview.height,
      { fine: true }
    );

    const stageId = crypto.randomUUID();
    stagedDocs.set(stageId, {
      sessionId: session.id,
      rawDocPages,
      rawPagePngs: finalPages,
      coverMeta: coverSheet || {},
      hasCover: Boolean(coverSheet && coverSheet.enabled),
      sourceLabel,
      createdAt: Date.now(),
    });

    res.json({
      stageId,
      sourceLabel,
      pagesCount: finalPages.length,
      previewDataUrl: `data:image/png;base64,${previewPng.toString('base64')}`,
    });
  } catch (err) {
    console.error('Stage pages error:', err);
    res.status(400).json({ error: `Page staging failed: ${err.message}` });
  }
});

// Transmit staged fax via real ITU-T T.38 UDPTL protocol
app.post('/api/send', async (req, res) => {
  const { session } = getOrCreateSession(req, res);
  const {
    stageId,
    toNumber,
    fine = true,
    stormyLine = false,
    coverEnabled = undefined,
  } = req.body || {};

  const staged = stagedDocs.get(stageId);
  if (!staged || staged.sessionId !== session.id) {
    return res.status(404).json({ error: 'No staged paper in tray. Click the top slot to load a file first.' });
  }

  // Rate limit: max 6 faxes / minute
  const now = Date.now();
  const recent = (sendTimestamps.get(session.id) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 6) {
    return res.status(429).json({ error: 'Thermal head overheating! Wait a few seconds before sending again.' });
  }
  recent.push(now);
  sendTimestamps.set(session.id, recent);

  if (busySessions.has(session.id)) {
    return res.status(409).json({ error: 'Your fax machine is already in an active T.38 session.' });
  }

  const resolved = resolveTarget(toNumber, session);
  if (resolved.kind === 'invalid') {
    return res.status(400).json({ error: 'Please enter a valid fax number (at least 4 digits).' });
  }

  let sendPages = staged.rawPagePngs;
  if (coverEnabled === true && !staged.hasCover) {
    const covPng = await renderCoverSheetToPngBuffer({
      from: staged.coverMeta?.from || session.display_name || session.display_number,
      to: staged.coverMeta?.to || toNumber || '',
      company: staged.coverMeta?.company || 'Dunder & Beige Systems',
      subject: staged.coverMeta?.subject || staged.sourceLabel,
      comments: staged.coverMeta?.comments || '',
      flags: staged.coverMeta?.flags || ['URGENT', 'FOR REVIEW'],
      totalDocPages: staged.rawDocPages.length,
    });
    sendPages = [covPng, ...staged.rawDocPages.slice(0, 3)];
  } else if (coverEnabled === false && staged.hasCover) {
    sendPages = staged.rawDocPages;
  }
  const jobStaged = { ...staged, rawPagePngs: sendPages };

  const txId = crypto.randomUUID();
  res.json({ ok: true, txId, targetNumber: toNumber });

  // Run T.38 transmission asynchronously while streaming live telemetry over WebSocket
  runTransmissionJob({
    txId,
    stageId,
    callerSession: session,
    staged: jobStaged,
    resolved,
    rawDialed: toNumber,
    fine: Boolean(fine),
    stormyLine: Boolean(stormyLine),
  }).catch((err) => {
    console.error('T.38 transmission error:', err);
    sendWsToSession(session.id, {
      type: 'tx_event',
      txId,
      event: { type: 'error', error: err.message },
    });
  });
});

async function runTransmissionJob({
  txId,
  stageId,
  callerSession,
  staged,
  resolved,
  rawDialed,
  fine,
  stormyLine,
}) {
  busySessions.add(callerSession.id);
  broadcastDirectory();

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
    if (isBlockedByRecipient(targetSession.id, callerSession.dial_digits)) {
      targetStatus = 'busy';
    } else if (!isSessionOnline(targetSession.id)) {
      targetStatus = 'offline'; // Ring No Answer!
    } else if (busySessions.has(targetSession.id) && targetSession.id !== callerSession.id) {
      targetStatus = 'busy';
    } else {
      targetStatus = 'online';
    }
  }

  if (targetSession && targetStatus === 'online' && targetSession.id !== callerSession.id) {
    busySessions.add(targetSession.id);
    broadcastDirectory();
  }

  try {
    // Rasterize all pages with authentic TTI header banner
    const fromLabel = callerSession.display_name
      ? `${callerSession.display_name} (${callerSession.display_number})`
      : callerSession.display_number;

    const faxPages = [];
    for (let i = 0; i < staged.rawPagePngs.length; i++) {
      const page = await rasterizeToFaxPage(staged.rawPagePngs[i], {
        fine,
        fromLabel,
        toLabel: targetDisplayNumber,
        pageNum: i + 1,
        totalPages: staged.rawPagePngs.length,
      });
      faxPages.push(page);
    }

    let rxNotifiedRinging = false;
    let rxNotifiedHandshake = false;

    const result = await executeT38Transmission({
      fromNumber: callerSession.display_number,
      toNumber: targetDisplayNumber,
      pages: faxPages,
      fine,
      stormyLine,
      targetStatus,
      pacingMs: 26,
      onEvent: (event) => {
        sendWsToSession(callerSession.id, { type: 'tx_event', txId, event });

        // Mirror live progress to online human recipient (including self-dialing!)
        if (targetSession && targetStatus === 'online') {
          if (event.phase === 'RINGING' && !rxNotifiedRinging) {
            rxNotifiedRinging = true;
            sendWsToSession(targetSession.id, {
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
            sendWsToSession(targetSession.id, {
              type: 'rx_event',
              rxId: txId,
              event: { type: 'rx_handshake', detail: event.detail },
            });
          } else if (event.type === 'progress') {
            sendWsToSession(targetSession.id, {
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
            sendWsToSession(targetSession.id, {
              type: 'rx_event',
              rxId: txId,
              event,
            });
          }
        }
      },
    });

    if (result.status !== 'ok') {
      sendWsToSession(callerSession.id, {
        type: 'tx_event',
        txId,
        event: {
          type: 'tx_failed',
          reason: result.status,
          report: result.report,
          logs: result.logs,
        },
      });
      return;
    }

    // Save completed fax record & artifacts
    const saved = await persistCompletedFax({
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

    // Notify Sender of completion (and remove staged paper from tray)
    stagedDocs.delete(stageId);
    sendWsToSession(callerSession.id, {
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

    // Notify Recipient of completed fax so their 3D machine prints the real document!
    if (targetSession) {
      sendWsToSession(targetSession.id, {
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

    // If caller dialed one of our Joke Bots, trigger an authentic return T.38 call 2.2s later!
    if (resolved.kind === 'bot') {
      const bot = resolved.bot;
      const decodedPngBuffers = await Promise.all(
        result.receivedPages.map((p) => renderThermalPng(p.pixels, p.width, p.height, { fine }))
      );
      setTimeout(() => {
        triggerBotCallback({
          bot,
          targetSession: callerSession,
          receivedPngBuffers: decodedPngBuffers,
          fine,
        }).catch((e) => console.error('Bot callback error:', e));
      }, 1400);
    }
  } finally {
    busySessions.delete(callerSession.id);
    if (targetSession) busySessions.delete(targetSession.id);
    broadcastDirectory();
  }
}

async function triggerBotCallback({ bot, targetSession, receivedPngBuffers, fine }) {
  if (!isSessionOnline(targetSession.id)) return;
  if (busySessions.has(targetSession.id)) return;

  busySessions.add(targetSession.id);
  broadcastDirectory();
  const rxId = crypto.randomUUID();

  try {
    const replyPngs = await generateBotReplyPages(bot, {
      senderNumber: targetSession.display_number,
      senderName: targetSession.display_name,
      receivedPngBuffers,
    });

    const faxPages = [];
    for (let i = 0; i < replyPngs.length; i++) {
      const page = await rasterizeToFaxPage(replyPngs[i], {
        fine,
        fromLabel: `${bot.display_name} (${bot.display_number})`,
        toLabel: targetSession.display_number,
        pageNum: i + 1,
        totalPages: replyPngs.length,
      });
      faxPages.push(page);
    }

    let notifiedRing = false;
    let notifiedHandshake = false;

    const result = await executeT38Transmission({
      fromNumber: bot.display_number,
      toNumber: targetSession.display_number,
      pages: faxPages,
      fine,
      stormyLine: false,
      targetStatus: isSessionOnline(targetSession.id) ? 'online' : 'offline',
      pacingMs: 26,
      onEvent: (event) => {
        if (event.phase === 'RINGING' && !notifiedRing) {
          notifiedRing = true;
          sendWsToSession(targetSession.id, {
            type: 'rx_event',
            rxId,
            event: {
              type: 'incoming_ring',
              fromNumber: bot.display_number,
              fromName: bot.display_name,
            },
          });
        } else if (event.phase === 'HANDSHAKE' && !notifiedHandshake) {
          notifiedHandshake = true;
          sendWsToSession(targetSession.id, {
            type: 'rx_event',
            rxId,
            event: { type: 'rx_handshake', detail: event.detail },
          });
        } else if (event.type === 'progress') {
          sendWsToSession(targetSession.id, {
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
          sendWsToSession(targetSession.id, {
            type: 'rx_event',
            rxId,
            event,
          });
        }
      },
    });

    if (result.status !== 'ok') return;

    const saved = await persistCompletedFax({
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

    sendWsToSession(targetSession.id, {
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
    busySessions.delete(targetSession.id);
    broadcastDirectory();
  }
}

// ---------- FAX ARTIFACT DOWNLOAD ROUTES ----------

app.get('/api/fax/:id', (req, res) => {
  const fax = getFaxById(req.params.id);
  if (!fax) return res.status(404).json({ error: 'Fax not found' });
  res.json({
    id: fax.id,
    fromNumber: fax.from_number,
    fromName: fax.from_name,
    toNumber: fax.to_number,
    pagesCount: fax.pages_count,
    fine: Boolean(fax.fine),
    stormyLine: Boolean(fax.stormy_line),
    report: fax.report,
    logs: fax.logs,
    previewUrls: fax.previewPaths.map((_, i) => `/api/fax/${fax.id}/page/${i}.png`),
    tiffUrl: `/api/fax/${fax.id}/fax.tif`,
    pcapUrl: `/api/fax/${fax.id}/capture.pcap`,
    createdAt: fax.created_at,
  });
});

app.get('/api/fax/:id/page/:idx.png', (req, res) => {
  const fax = getFaxById(req.params.id);
  const idx = Number(req.params.idx);
  if (!fax || !fax.previewPaths[idx] || !fs.existsSync(fax.previewPaths[idx])) {
    return res.status(404).end();
  }
  res.sendFile(fax.previewPaths[idx]);
});

app.get('/api/fax/:id/fax.tif', (req, res) => {
  const fax = getFaxById(req.params.id);
  if (!fax || !fax.tiff_path || !fs.existsSync(fax.tiff_path)) {
    return res.status(404).end();
  }
  res.download(fax.tiff_path, `retrofax-${fax.id.slice(0, 8)}.tif`);
});

app.get('/api/fax/:id/capture.pcap', (req, res) => {
  const fax = getFaxById(req.params.id);
  if (!fax || !fax.pcap_path || !fs.existsSync(fax.pcap_path)) {
    return res.status(404).end();
  }
  res.download(fax.pcap_path, `retrofax-t38-${fax.id.slice(0, 8)}.pcap`);
});

// ---------- SIP VOICE CALL ROUTES (G.711u, G.711a, G.722, G.729) ----------

app.post('/api/call', upload.single('audio'), async (req, res) => {
  try {
    const { session } = getOrCreateSession(req, res);
    const toNumber = String(req.body?.toNumber || '').trim();
    const codec = normalizeCodecId(req.body?.codec || 'G711U');
    const ttsText = String(req.body?.ttsText || 'HELLO FROM 1994 RETROFAX').trim();
    const stormyLine = req.body?.stormyLine === true || req.body?.stormyLine === 'true' || req.body?.stormyLine === '1';

    if (busySessions.has(session.id)) {
      return res.status(409).json({ error: 'Line busy — another T.38 or SIP call is already active.' });
    }

    const resolved = resolveTarget(toNumber, session);
    if (resolved.kind === 'invalid') {
      return res.status(400).json({ error: 'Please enter a valid number (at least 4 digits).' });
    }

    let callerPcm16;
    if (req.file && req.file.buffer?.length > 16) {
      callerPcm16 = await decodeUploadedAudioToPcm16(req.file.buffer, 16000);
      // Cap at 8 seconds for quick, snappy UDP RTP transfer
      const maxSamples = 16000 * 8;
      if (callerPcm16.length > maxSamples) {
        callerPcm16 = callerPcm16.subarray(0, maxSamples);
      }
    } else {
      callerPcm16 = synthesizeMessageAudio(ttsText, 16000);
    }

    const callTxId = crypto.randomUUID();
    res.json({ ok: true, callTxId, codec, targetNumber: toNumber });

    runSipCallJob({
      callTxId,
      callerSession: session,
      resolved,
      rawDialed: toNumber,
      codec,
      callerPcm16,
      callerSampleRate: 16000,
      stormyLine,
    }).catch((err) => {
      console.error('SIP voice call error:', err);
      sendWsToSession(session.id, {
        type: 'call_tx_event',
        callTxId,
        event: { type: 'error', error: err.message },
      });
    });
  } catch (err) {
    console.error('SIP /api/call error:', err);
    res.status(400).json({ error: `SIP voice call setup failed: ${err.message}` });
  }
});

async function runSipCallJob({
  callTxId,
  callerSession,
  resolved,
  rawDialed,
  codec,
  callerPcm16,
  callerSampleRate,
  stormyLine,
}) {
  busySessions.add(callerSession.id);
  broadcastDirectory();

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
    if (isBlockedByRecipient(targetSession.id, callerSession.dial_digits)) {
      targetStatus = 'busy';
    } else if (!isSessionOnline(targetSession.id)) {
      targetStatus = 'offline';
    } else if (busySessions.has(targetSession.id) && targetSession.id !== callerSession.id) {
      targetStatus = 'busy';
    } else {
      targetStatus = 'online';
    }
  }

  if (targetSession && targetStatus === 'online' && targetSession.id !== callerSession.id) {
    busySessions.add(targetSession.id);
    broadcastDirectory();
  }

  try {
    let replyPcm16 = null;
    if (!botId && targetSession) {
      const targetName = targetSession.display_name || 'STATION';
      replyPcm16 = synthesizeMessageAudio(`ANSWERING MACHINE ${targetName} 1994 SAVED`, 16000);
    }

    let rxNotifiedRinging = false;
    let rxNotifiedActive = false;

    const result = await executeSipVoiceCall({
      fromNumber: callerSession.display_number,
      toNumber: targetDisplayNumber,
      codec,
      callerPcm16,
      callerSampleRate,
      targetStatus,
      stormyLine,
      botId,
      replyPcm16,
      replySampleRate: 16000,
      pacingMs: 12,
      onEvent: (event) => {
        sendWsToSession(callerSession.id, { type: 'call_tx_event', callTxId, event });

        if (targetSession && targetStatus === 'online') {
          if (event.phase === 'RINGING' && !rxNotifiedRinging) {
            rxNotifiedRinging = true;
            sendWsToSession(targetSession.id, {
              type: 'call_rx_event',
              callRxId: callTxId,
              event: {
                type: 'incoming_call_ring',
                fromNumber: callerSession.display_number,
                fromName: callerSession.display_name || 'Unknown Caller',
                codec,
              },
            });
          } else if (event.phase === 'VOICE_ACTIVE' && !rxNotifiedActive) {
            rxNotifiedActive = true;
            sendWsToSession(targetSession.id, {
              type: 'call_rx_event',
              callRxId: callTxId,
              event: { type: 'call_rx_active', detail: event.detail, codec },
            });
          } else if (event.type === 'progress') {
            sendWsToSession(targetSession.id, {
              type: 'call_rx_event',
              callRxId: callTxId,
              event: { type: 'call_rx_progress', overallProgress: event.overallProgress },
            });
          } else if (event.type === 't38_log') {
            sendWsToSession(targetSession.id, { type: 'call_rx_event', callRxId: callTxId, event });
          }
        }
      },
    });

    if (result.status !== 'ok') {
      sendWsToSession(callerSession.id, {
        type: 'call_tx_event',
        callTxId,
        event: {
          type: 'call_tx_failed',
          reason: result.status,
          report: result.report,
          logs: result.logs,
        },
      });
      return;
    }

    const saved = persistCompletedCall({
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

    sendWsToSession(callerSession.id, {
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

    if (targetSession) {
      sendWsToSession(targetSession.id, {
        type: 'call_rx_event',
        callRxId: callTxId,
        event: {
          type: 'call_rx_complete',
          call: {
            id: saved.callId,
            direction: 'inbound',
            fromNumber: callerSession.display_number,
            fromName: callerSession.display_name || 'Unknown Caller',
            toNumber: targetDisplayNumber,
            codec,
            stormyLine,
            callerWavUrl: saved.callerWavUrl,
            replyWavUrl: saved.replyWavUrl,
            pcapUrl: saved.pcapUrl,
            report: saved.report,
            logs: saved.logs,
            createdAt: Date.now(),
          },
        },
      });
    }
  } finally {
    busySessions.delete(callerSession.id);
    if (targetSession) busySessions.delete(targetSession.id);
    broadcastDirectory();
  }
}

app.get('/api/call/:id', (req, res) => {
  const call = getCallById(req.params.id);
  if (!call) return res.status(404).json({ error: 'Call not found' });
  res.json({
    id: call.id,
    fromNumber: call.from_number,
    fromName: call.from_name,
    toNumber: call.to_number,
    codec: call.codec,
    stormyLine: Boolean(call.stormy_line),
    report: call.report,
    logs: call.logs,
    callerWavUrl: `/api/call/${call.id}/caller.wav`,
    replyWavUrl: `/api/call/${call.id}/reply.wav`,
    pcapUrl: `/api/call/${call.id}/capture.pcap`,
    createdAt: call.created_at,
  });
});

app.get('/api/call/:id/caller.wav', (req, res) => {
  const call = getCallById(req.params.id);
  if (!call || !call.tx_wav_path || !fs.existsSync(call.tx_wav_path)) {
    return res.status(404).end();
  }
  res.type('audio/wav').sendFile(call.tx_wav_path);
});

app.get('/api/call/:id/reply.wav', (req, res) => {
  const call = getCallById(req.params.id);
  if (!call || !call.rx_wav_path || !fs.existsSync(call.rx_wav_path)) {
    return res.status(404).end();
  }
  res.type('audio/wav').sendFile(call.rx_wav_path);
});

app.get('/api/call/:id/capture.pcap', (req, res) => {
  const call = getCallById(req.params.id);
  if (!call || !call.pcap_path || !fs.existsSync(call.pcap_path)) {
    return res.status(404).end();
  }
  res.download(call.pcap_path, `retrofax-sip-${call.codec.toLowerCase()}-${call.id.slice(0, 8)}.pcap`);
});

// Serve built frontend in production
const clientDist = path.resolve(process.cwd(), 'client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// ---------- HTTP + WEBSOCKET SERVER + LIVE PEER SIP/RTP RELAY ----------

const activeLiveCalls = new Map();

function buildLiveCodecSdpSpec(codecId) {
  const map = {
    G711U: { pt: 0, rtpmap: '0 PCMU/8000' },
    G711A: { pt: 8, rtpmap: '8 PCMA/8000' },
    G722: { pt: 9, rtpmap: '9 G722/8000' },
    G729: { pt: 18, rtpmap: '18 G729/8000' },
  };
  return map[codecId] || map.G711U;
}

function makeLiveSipInviteLog(fromNumber, toNumber, codecId, sipCallId) {
  const c = buildLiveCodecSdpSpec(codecId);
  return {
    ts: 0,
    layer: 'SIP',
    direction: 'TX->RX',
    summary: `INVITE sip:${normalizeDigits(toNumber)}@retrofax.edge SIP/2.0 (Call-ID: ${sipCallId.slice(0, 8)}, Offer: m=audio 5004 RTP/AVP ${c.pt} a=rtpmap:${c.rtpmap})`,
  };
}

function endLiveCall(callId, { reason = 'hangup', endedBy = 'system', sipCode = 200 } = {}) {
  const call = activeLiveCalls.get(callId);
  if (!call) return;
  if (call.ringTimer) {
    clearTimeout(call.ringTimer);
    call.ringTimer = null;
  }
  activeLiveCalls.delete(callId);

  const elapsed = Date.now() - call.createdAt;
  const endLogs = [];
  if (call.state === 'RINGING') {
    if (reason === 'declined' || sipCode === 486) {
      endLogs.push(
        { ts: elapsed, layer: 'SIP', direction: 'RX->TX', summary: `SIP/2.0 486 Busy Here (Call declined)` },
        { ts: elapsed + 10, layer: 'SIP', direction: 'TX->RX', summary: `ACK sip:${normalizeDigits(call.toNumber)}@retrofax.edge SIP/2.0` }
      );
    } else if (reason === 'no_answer' || sipCode === 480) {
      endLogs.push(
        { ts: elapsed, layer: 'SIP', direction: 'RX->TX', summary: `SIP/2.0 480 Temporarily Unavailable (Ring timeout)` },
        { ts: elapsed + 10, layer: 'SIP', direction: 'TX->RX', summary: `ACK sip:${normalizeDigits(call.toNumber)}@retrofax.edge SIP/2.0` }
      );
    } else {
      endLogs.push(
        { ts: elapsed, layer: 'SIP', direction: 'TX->RX', summary: `CANCEL sip:${normalizeDigits(call.toNumber)}@retrofax.edge SIP/2.0` },
        { ts: elapsed + 8, layer: 'SIP', direction: 'RX->TX', summary: `SIP/2.0 487 Request Terminated` },
        { ts: elapsed + 12, layer: 'SIP', direction: 'TX->RX', summary: `ACK sip:${normalizeDigits(call.toNumber)}@retrofax.edge SIP/2.0` }
      );
    }
  } else {
    endLogs.push(
      { ts: elapsed, layer: 'SIP', direction: endedBy === call.callerSid ? 'TX->RX' : 'RX->TX', summary: `BYE sip:retrofax.edge SIP/2.0` },
      { ts: elapsed + 8, layer: 'SIP', direction: endedBy === call.callerSid ? 'RX->TX' : 'TX->RX', summary: `SIP/2.0 200 OK (Live Voice Session Closed)` }
    );
  }

  busySessions.delete(call.callerSid);
  busySessions.delete(call.calleeSid);
  broadcastDirectory();

  const wasRinging = call.state === 'RINGING';
  if (wasRinging && reason !== 'hangup') {
    sendWsToSession(call.callerSid, {
      type: 'live_call_rejected',
      callId,
      reason: sipCode === 486 ? 'busy' : 'no_answer',
      sipCode,
      logs: endLogs,
      report: { toNumber: call.toNumber, codec: call.codec, callId: call.sipCallId },
    });
    sendWsToSession(call.calleeSid, {
      type: 'live_call_ended',
      callId,
      endedBy,
      reason,
      logs: endLogs,
    });
  } else {
    for (const sid of [call.callerSid, call.calleeSid]) {
      sendWsToSession(sid, {
        type: 'live_call_ended',
        callId,
        endedBy,
        reason,
        logs: endLogs,
      });
    }
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function parseCookieHeader(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

wss.on('connection', (ws, req) => {
  const cookies = parseCookieHeader(req.headers.cookie);
  const url = new URL(req.url, 'http://localhost');
  const sid = cookies[COOKIE_NAME] || url.searchParams.get('sid');
  const session = getSessionById(sid);

  if (!session) {
    ws.close(4001, 'No session cookie');
    return;
  }

  if (!socketsBySession.has(session.id)) {
    socketsBySession.set(session.id, new Set());
  }
  socketsBySession.get(session.id).add(ws);
  touchSession(session.id);
  broadcastDirectory();

  ws.send(JSON.stringify({ type: 'connected', sessionId: session.id, displayNumber: session.display_number }));

  ws.on('message', (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString('utf8'));
    } catch {
      return;
    }

    if (msg.type === 'live_call_invite') {
      const toNumber = String(msg.toNumber || '').trim();
      const codec = normalizeCodecId(msg.codec || 'G711U');
      const stormyLine = Boolean(msg.stormyLine);
      const caller = getSessionById(session.id) || session;

      if (busySessions.has(caller.id)) {
        ws.send(JSON.stringify({ type: 'live_call_rejected', reason: 'busy', sipCode: 486, logs: [] }));
        return;
      }

      const resolved = resolveTarget(toNumber, caller);
      if (resolved.kind === 'bot') {
        ws.send(JSON.stringify({ type: 'live_call_use_bot', toNumber: resolved.bot.display_number, codec }));
        return;
      }

      const sipCallId = `${crypto.randomUUID()}@retrofax.live`;
      if (resolved.kind === 'invalid') {
        ws.send(JSON.stringify({ type: 'live_call_rejected', reason: 'invalid', sipCode: 400, logs: [] }));
        return;
      }

      if (resolved.kind === 'unknown' || !isSessionOnline(resolved.session.id)) {
        const logs = [
          makeLiveSipInviteLog(caller.display_number, toNumber, codec, sipCallId),
          { ts: 40, layer: 'SIP', direction: 'RX->TX', summary: 'SIP/2.0 100 Trying' },
          { ts: 650, layer: 'SIP', direction: 'RX->TX', summary: 'SIP/2.0 480 Temporarily Unavailable (User Offline / No Answer)' },
          { ts: 660, layer: 'SIP', direction: 'TX->RX', summary: `ACK sip:${normalizeDigits(toNumber)}@retrofax.edge SIP/2.0` },
        ];
        ws.send(JSON.stringify({
          type: 'live_call_rejected',
          reason: 'no_answer',
          sipCode: 480,
          logs,
          report: { toNumber, codec, callId: sipCallId },
        }));
        return;
      }

      const callee = resolved.session;
      if (callee.id === caller.id) {
        ws.send(JSON.stringify({
          type: 'live_call_rejected',
          reason: 'self_call',
          sipCode: 486,
          logs: [{ ts: 0, layer: 'SIP', direction: 'RX->TX', summary: 'SIP/2.0 486 Busy Here (Cannot call your own active line live — open another visitor/device or dial a Bot)' }],
        }));
        return;
      }

      if (isBlockedByRecipient(callee.id, caller.dial_digits) || busySessions.has(callee.id)) {
        const logs = [
          makeLiveSipInviteLog(caller.display_number, callee.display_number, codec, sipCallId),
          { ts: 30, layer: 'SIP', direction: 'RX->TX', summary: 'SIP/2.0 486 Busy Here (Recipient Line In Use)' },
        ];
        ws.send(JSON.stringify({
          type: 'live_call_rejected',
          reason: 'busy',
          sipCode: 486,
          logs,
          report: { toNumber: callee.display_number, codec, callId: sipCallId },
        }));
        return;
      }

      const callId = crypto.randomUUID();
      busySessions.add(caller.id);
      busySessions.add(callee.id);
      broadcastDirectory();

      const ringLogs = [
        makeLiveSipInviteLog(caller.display_number, callee.display_number, codec, sipCallId),
        { ts: 12, layer: 'SIP', direction: 'RX->TX', summary: 'SIP/2.0 100 Trying' },
        { ts: 28, layer: 'SIP', direction: 'RX->TX', summary: `SIP/2.0 180 Ringing (Live Browser Handset Alerting)` },
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
          endLiveCall(callId, { reason: 'no_answer', endedBy: 'timeout', sipCode: 480 });
        }, 35000),
      };
      activeLiveCalls.set(callId, callRecord);

      sendWsToSession(caller.id, {
        type: 'live_call_ringing',
        callId,
        toNumber: callee.display_number,
        toName: callRecord.toName,
        codec,
        sipCallId,
        logs: ringLogs,
      });

      sendWsToSession(callee.id, {
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
      const call = activeLiveCalls.get(msg.callId);
      if (!call || call.calleeSid !== session.id || call.state !== 'RINGING') return;
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

      sendWsToSession(call.callerSid, {
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
      sendWsToSession(call.calleeSid, {
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
      const call = activeLiveCalls.get(msg.callId);
      if (!call || call.calleeSid !== session.id) return;
      endLiveCall(call.callId, { reason: 'declined', endedBy: session.id, sipCode: 486 });
    } else if (msg.type === 'live_call_hangup') {
      const call = activeLiveCalls.get(msg.callId);
      if (!call || (call.callerSid !== session.id && call.calleeSid !== session.id)) return;
      endLiveCall(call.callId, { reason: 'hangup', endedBy: session.id, sipCode: 200 });
    } else if (msg.type === 'live_rtp') {
      const call = activeLiveCalls.get(msg.callId);
      if (!call || call.state !== 'ACTIVE') return;
      if (call.callerSid !== session.id && call.calleeSid !== session.id) return;
      const peerSid = call.callerSid === session.id ? call.calleeSid : call.callerSid;
      sendWsToSession(peerSid, {
        type: 'live_rtp',
        callId: call.callId,
        rtpB64: msg.rtpB64,
      });
    } else if (msg.type === 'live_dtmf') {
      const call = activeLiveCalls.get(msg.callId);
      if (!call || call.state !== 'ACTIVE') return;
      if (call.callerSid !== session.id && call.calleeSid !== session.id) return;
      const peerSid = call.callerSid === session.id ? call.calleeSid : call.callerSid;
      sendWsToSession(peerSid, {
        type: 'live_dtmf',
        callId: call.callId,
        digit: String(msg.digit || ''),
      });
    }
  });

  ws.on('close', () => {
    const set = socketsBySession.get(session.id);
    if (set) {
      set.delete(ws);
      if (set.size === 0) socketsBySession.delete(session.id);
    }
    if (!isSessionOnline(session.id)) {
      for (const [cid, call] of activeLiveCalls.entries()) {
        if (call.callerSid === session.id || call.calleeSid === session.id) {
          endLiveCall(cid, { reason: 'hangup', endedBy: session.id, sipCode: 200 });
        }
      }
    }
    broadcastDirectory();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RetroFax T.38 server listening on http://localhost:${PORT}`);
});
