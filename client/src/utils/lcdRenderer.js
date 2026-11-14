/**
 * Renders the 1990s backlit green dot-matrix LCD onto a 512x192 HTML5 Canvas
 * used as a live Three.js CanvasTexture on the 3D fax machine.
 */

const CODEC_SHORT = {
  G711U: 'G711u',
  G711A: 'G711a',
  G722: 'G.722',
  G729: 'G.729',
};

export function drawFaxLcd(canvas, state, timeMs = Date.now()) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  // Classic backlit olive-lime LCD background
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#8ba856');
  grad.addColorStop(0.5, '#9ab960');
  grad.addColorStop(1, '#7f9b4c');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Inner LCD bezel shadow
  ctx.strokeStyle = 'rgba(20, 32, 8, 0.35)';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, W - 6, H - 6);

  // Subtle dot-matrix grid cells
  ctx.fillStyle = 'rgba(25, 42, 10, 0.08)';
  for (let y = 10; y < H - 8; y += 6) {
    for (let x = 10; x < W - 8; x += 6) {
      ctx.fillRect(x, y, 4, 4);
    }
  }

  const blink = Math.floor(timeMs / 480) % 2 === 0;
  ctx.fillStyle = '#182807';
  ctx.textBaseline = 'top';

  const drawRow = (rowIdx, text, { invert = false, font = 'bold 24px "VT323", "IBM Plex Mono", monospace' } = {}) => {
    const y = 14 + rowIdx * 34;
    if (invert) {
      ctx.fillStyle = '#1a2b09';
      ctx.fillRect(14, y - 2, W - 28, 30);
      ctx.fillStyle = '#9db963';
    } else {
      ctx.fillStyle = '#182807';
    }
    ctx.font = font;
    ctx.fillText(String(text || '').slice(0, 34), 18, y);
  };

  const codecShort = CODEC_SHORT[state.sipCodec] || 'G711u';

  // Priority 1: Active Alert / Call / Transmission / Reception
  if (state.alertBanner) {
    drawRow(0, '*** SYSTEM ALERT ***', { invert: true });
    drawRow(1, state.alertBanner.line1 || '');
    drawRow(2, state.alertBanner.line2 || '');
    drawRow(3, 'PRESS [CLR] OR [OK]', { font: '20px "VT323", monospace' });
    return;
  }

  if (state.callState && state.callState.active) {
    const c = state.callState;
    drawRow(0, `SIP VOICE -> ${c.targetNumber || ''}`, { invert: true });
    drawRow(1, c.detail || `CODEC: ${codecShort} OVER RTP`);
    if (c.phase === 'RINGING') {
      drawRow(2, blink ? 'RINGING... WAITING ANSWER' : 'RINGING...');
    } else {
      const pct = Math.round((c.progress || 0) * 100);
      const bars = Math.round((pct / 100) * 18);
      drawRow(2, `[${'#'.repeat(bars)}${'.'.repeat(18 - bars)}] ${String(pct).padStart(3, ' ')}%`);
    }
    drawRow(3, `RTP PKTS: ${c.rtpPackets || 0}  ${codecShort}`, { font: '20px "VT323", monospace' });
    return;
  }

  if (state.rxCallState && state.rxCallState.active) {
    const rc = state.rxCallState;
    drawRow(0, `INCOMING SIP VOICE ${blink ? '<<<' : '   '}`, { invert: true });
    drawRow(1, `FROM: ${rc.fromName || rc.fromNumber || 'UNKNOWN'}`);
    const pct = Math.round((rc.progress || 0) * 100);
    const bars = Math.round((pct / 100) * 18);
    drawRow(2, `RTP [${'#'.repeat(bars)}${'.'.repeat(18 - bars)}] ${pct}%`);
    drawRow(3, `CODEC: ${CODEC_SHORT[rc.codec] || codecShort} VOICEMAIL`, { font: '20px "VT323", monospace' });
    return;
  }

  if (state.txState && state.txState.active) {
    const tx = state.txState;
    drawRow(0, `TX -> ${tx.targetNumber || ''}`, { invert: true });
    drawRow(1, tx.detail || 'T.38 INITIALIZING...');
    if (tx.phase === 'RINGING') {
      drawRow(2, blink ? 'RINGING... WAITING ANSWER' : 'RINGING...');
    } else {
      const pct = Math.round((tx.progress || 0) * 100);
      const bars = Math.round((pct / 100) * 18);
      const barStr = `[${'#'.repeat(bars)}${'.'.repeat(18 - bars)}] ${String(pct).padStart(3, ' ')}%`;
      drawRow(2, barStr);
    }
    drawRow(3, `UDPTL PKTS: ${tx.udptlPackets || 0}  14400 BPS`, { font: '20px "VT323", monospace' });
    return;
  }

  if (state.rxState && state.rxState.active) {
    const rx = state.rxState;
    drawRow(0, `INCOMING FAX ${blink ? '<<<' : '   '}`, { invert: true });
    drawRow(1, `FROM: ${rx.fromName || rx.fromNumber || 'UNKNOWN'}`);
    const pct = Math.round((rx.progress || 0) * 100);
    const bars = Math.round((pct / 100) * 18);
    drawRow(2, `PRINT [${'#'.repeat(bars)}${'.'.repeat(18 - bars)}] ${pct}%`);
    drawRow(3, 'DO NOT PULL THERMAL PAPER', { font: '20px "VT323", monospace' });
    return;
  }

  // Priority 2: Directory Browse Mode on LCD
  if (state.lcdMode === 'DIRECTORY') {
    const dir = state.directory || [];
    const idx = Math.max(0, Math.min(state.dirIndex || 0, Math.max(0, dir.length - 1)));
    drawRow(0, `DIRECTORY (${dir.length})  [▲▼] [OK=DIAL]`, { invert: true, font: 'bold 21px "VT323", monospace' });
    if (dir.length === 0) {
      drawRow(1, 'NO LISTED STATIONS YET');
      drawRow(2, 'CLICK MY CARD TO LIST YOURS');
    } else {
      const windowStart = Math.max(0, Math.min(idx - 1, Math.max(0, dir.length - 3)));
      for (let r = 0; r < 3; r++) {
        const entry = dir[windowStart + r];
        if (!entry) continue;
        const selected = windowStart + r === idx;
        const statusDot = entry.online ? '*' : '-';
        const label = (entry.display_name || 'ANON').slice(0, 14).padEnd(14, ' ');
        const num = (entry.display_number || '').slice(-12);
        drawRow(r + 1, `${selected ? '>' : ' '}${statusDot}${label} ${num}`, {
          invert: selected,
          font: '22px "VT323", monospace',
        });
      }
    }
    return;
  }

  // Default: Ready / Dialer Mode (Voice Off-Hook vs T.38 Fax Idle)
  const myNum = state.session?.displayNumber || 'ASSIGNING...';
  const dialed = state.dialNumber || '';
  const cursor = blink ? '_' : ' ';

  if (state.handsetOffHook) {
    const statLabel = state.stormyLine ? 'STAT' : '    ';
    drawRow(0, `SIP VOICE  ${codecShort}  ${statLabel} [OFF-HOOK]`, {
      invert: true,
      font: 'bold 21px "VT323", monospace',
    });
    drawRow(1, `MY#: ${myNum}`, { font: '22px "VT323", monospace' });
    drawRow(2, `TO : ${dialed}${cursor}`, { font: 'bold 25px "VT323", monospace' });
    drawRow(3, 'HANDSET UP: [CALL] OR HANG UP', {
      font: '20px "VT323", monospace',
    });
    return;
  }

  const resLabel = state.fine ? 'FINE' : 'STD ';
  const covLabel = state.coverEnabled ? 'COV' : '   ';
  const statLabel = state.stormyLine ? 'STAT' : '    ';
  const lineStatus = state.wsConnected ? `SIP/${codecShort}` : 'CONN';
  drawRow(0, `${resLabel} ${covLabel} ${statLabel} [${lineStatus}]`, {
    invert: true,
    font: 'bold 21px "VT323", monospace',
  });
  drawRow(1, `MY#: ${myNum}`, { font: '22px "VT323", monospace' });
  drawRow(2, `TO : ${dialed}${cursor}`, { font: 'bold 25px "VT323", monospace' });

  if (state.staged) {
    drawRow(3, `TRAY: ${state.staged.pagesCount}P READY  PRESS [START]`, {
      font: '20px "VT323", monospace',
    });
  } else {
    drawRow(3, 'CLICK TRAY=FAX  HANDSET=SIP CALL', {
      font: '20px "VT323", monospace',
    });
  }
}
