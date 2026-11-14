/**
 * ITU-T T.30 Facsimile Control Protocol HDLC Frame Builder & Parser
 * Uses canonical T.38 / SpanDSP / Wireshark T.30 FCF byte ordering.
 */

export const T30_FCF = {
  DIS: 0x80,
  CSI: 0x40,
  NSF: 0x20,
  DTC: 0x81,
  DCS: 0x83, // DCS with DIS received flag (X=1)
  TSI: 0x43, // TSI with DIS received flag (X=1)
  CFR: 0x84,
  FTT: 0x44,
  MPS: 0x4f, // Multi-Page Signal (with X=1)
  EOM: 0x8f,
  EOP: 0x2f, // End of Procedure (with X=1)
  MCF: 0x8c,
  RTP: 0xcc,
  RTN: 0x4c,
  DCN: 0xfb,
};

export const T30_FCF_NAMES = {
  0x80: 'DIS (Digital Identification Signal)',
  0x40: 'CSI (Called Subscriber Identification)',
  0x20: 'NSF (Non-Standard Facilities)',
  0x81: 'DTC (Digital Transmit Command)',
  0x82: 'DCS (Digital Command Signal)',
  0x83: 'DCS (Digital Command Signal)',
  0x42: 'TSI (Transmitting Subscriber Identification)',
  0x43: 'TSI (Transmitting Subscriber Identification)',
  0x84: 'CFR (Confirmation to Receive)',
  0x85: 'CFR (Confirmation to Receive)',
  0x44: 'FTT (Failure to Train)',
  0x45: 'FTT (Failure to Train)',
  0x4e: 'MPS (Multipage Signal)',
  0x4f: 'MPS (Multipage Signal)',
  0x8e: 'EOM (End of Message)',
  0x8f: 'EOM (End of Message)',
  0x2e: 'EOP (End of Procedure)',
  0x2f: 'EOP (End of Procedure)',
  0x8c: 'MCF (Message Confirmation)',
  0x8d: 'MCF (Message Confirmation)',
  0xcc: 'RTP (Retrain Positive)',
  0x4c: 'RTN (Retrain Negative)',
  0xfa: 'DCN (Disconnect)',
  0xfb: 'DCN (Disconnect)',
};

/**
 * Compute ITU-T CRC-16 CCITT FCS over HDLC frame bytes (for telemetry & verification)
 */
export function computeHDLCFcs(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0x8408;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return (~crc) & 0xffff;
}

/**
 * Encode 20-char T.30 Station ID (CSI/TSI): reversed ASCII padded with spaces per T.30 5.3.6.2.4
 */
export function encodeStationId(idStr) {
  const clean = String(idStr || '').slice(0, 20).padStart(20, ' ');
  const out = Buffer.alloc(20, 0x20);
  for (let i = 0; i < 20; i++) {
    out[i] = clean.charCodeAt(19 - i) & 0x7f;
  }
  return out;
}

export function decodeStationId(buf) {
  let s = '';
  for (let i = buf.length - 1; i >= 0; i--) {
    s += String.fromCharCode(buf[i] & 0x7f);
  }
  return s.trim();
}

/**
 * Build HDLC frame (Address 0xFF, Control 0x03/0x13, FCF, optional FIF)
 */
export function buildHDLCFrame(fcf, fif = Buffer.alloc(0), isFinal = true) {
  const frame = Buffer.alloc(3 + fif.length);
  frame[0] = 0xff; // HDLC All-Station Address
  frame[1] = isFinal ? 0x13 : 0x03; // UI Control (Final vs Non-Final)
  frame[2] = fcf & 0xff;
  if (fif.length > 0) {
    fif.copy(frame, 3);
  }
  return frame;
}

export function buildCSIFrame(calledNumber) {
  return buildHDLCFrame(T30_FCF.CSI, encodeStationId(calledNumber), false);
}

export function buildTSIFrame(callingNumber) {
  return buildHDLCFrame(T30_FCF.TSI, encodeStationId(callingNumber), false);
}

/**
 * DIS FIF capabilities:
 * Byte 0: 0x00
 * Byte 1: 0xCE (V.17/V.29/V.27ter 14400 bps capable, Fine 200dpi, T.4 1D MH)
 * Byte 2: 0x78 (A4 1728px width, unlimited length, 0ms min scanline time, extension bit=0)
 */
export function buildDISFrame({ fine = true } = {}) {
  const byte1 = fine ? 0xce : 0x8e;
  const fif = Buffer.from([0x00, byte1, 0x78]);
  return buildHDLCFrame(T30_FCF.DIS, fif, true);
}

/**
 * DCS FIF chosen session parameters:
 * Byte 0: 0x00
 * Byte 1: V.17 14400 bps + Fine/Standard resolution bit
 * Byte 2: A4 1728px, 0ms scanline
 */
export function buildDCSFrame({ fine = true, bitRate = 14400 } = {}) {
  // V.17 14400 = 0xC4/0x84 with resolution bit 0x40
  const modBits = bitRate >= 14400 ? 0x3c : 0x2c;
  const resBit = fine ? 0x40 : 0x00;
  const fif = Buffer.from([0x00, modBits | resBit, 0x00]);
  return buildHDLCFrame(T30_FCF.DCS, fif, true);
}

export function parseHDLCFrame(frame) {
  if (!frame || frame.length < 3) return null;
  const address = frame[0];
  const control = frame[1];
  const fcf = frame[2];
  const fif = frame.subarray(3);
  const name = T30_FCF_NAMES[fcf] || `UNKNOWN(0x${fcf.toString(16)})`;
  let detail = '';

  if (fcf === T30_FCF.CSI || fcf === T30_FCF.TSI || fcf === 0x42) {
    detail = `"${decodeStationId(fif)}"`;
  } else if (fcf === T30_FCF.DIS || fcf === T30_FCF.DCS || fcf === 0x82) {
    const fine = fif.length >= 2 && (fif[1] & 0x40) !== 0;
    detail = `rate=14400bps, width=1728px, res=${fine ? 'FINE(204x196)' : 'STD(204x98)'}, coding=T.4-MH`;
  }

  return {
    address,
    control,
    isFinal: control === 0x13,
    fcf,
    name,
    detail,
    fcs: computeHDLCFcs(frame),
    rawHex: frame.toString('hex'),
  };
}
