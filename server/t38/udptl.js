/**
 * ITU-T T.38 UDPTL + IFPPacket ASN.1 Aligned PER Encoder & Decoder
 * Strictly conforms to ITU-T T.38 Annex A (UDPTL) and T.38 Version 0 ASN.1 IFPPacket.
 * Wireshark's built-in `udptl` and `t38` dissectors parse these packets directly.
 */

export const T30_INDICATOR = {
  NO_SIGNAL: 0,
  CNG: 1,
  CED: 2,
  V21_PREAMBLE: 3,
  V27_2400_TRAINING: 4,
  V27_4800_TRAINING: 5,
  V29_7200_TRAINING: 6,
  V29_9600_TRAINING: 7,
  V17_7200_SHORT_TRAINING: 8,
  V17_7200_LONG_TRAINING: 9,
  V17_9600_SHORT_TRAINING: 10,
  V17_9600_LONG_TRAINING: 11,
  V17_12000_SHORT_TRAINING: 12,
  V17_12000_long_TRAINING: 13,
  V17_14400_SHORT_TRAINING: 14,
  V17_14400_LONG_TRAINING: 15,
};

export const T30_INDICATOR_NAMES = [
  'no-signal', 'cng', 'ced', 'v21-preamble',
  'v27-2400-training', 'v27-4800-training', 'v29-7200-training', 'v29-9600-training',
  'v17-7200-short-training', 'v17-7200-long-training',
  'v17-9600-short-training', 'v17-9600-long-training',
  'v17-12000-short-training', 'v17-12000-long-training',
  'v17-14400-short-training', 'v17-14400-long-training',
];

export const T30_DATA = {
  V21: 0,
  V27_2400: 1,
  V27_4800: 2,
  V29_7200: 3,
  V29_9600: 4,
  V17_7200: 5,
  V17_9600: 6,
  V17_12000: 7,
  V17_14400: 8,
};

export const T30_DATA_NAMES = [
  'v21', 'v27-2400', 'v27-4800', 'v29-7200', 'v29-9600',
  'v17-7200', 'v17-9600', 'v17-12000', 'v17-14400',
];

export const FIELD_TYPE = {
  HDLC_DATA: 0,
  HDLC_SIG_END: 1,
  HDLC_FCS_OK: 2,
  HDLC_FCS_BAD: 3,
  HDLC_FCS_OK_SIG_END: 4,
  HDLC_FCS_BAD_SIG_END: 5,
  T4_NON_ECM_DATA: 6,
  T4_NON_ECM_SIG_END: 7,
};

export const FIELD_TYPE_NAMES = [
  'hdlc-data', 'hdlc-sig-end', 'hdlc-fcs-OK', 'hdlc-fcs-BAD',
  'hdlc-fcs-OK-sig-end', 'hdlc-fcs-BAD-sig-end',
  't4-non-ecm-data', 't4-non-ecm-sig-end',
];

class PerWriter {
  constructor() {
    this.bytes = [];
    this.curByte = 0;
    this.bitPos = 0; // 0..7 from MSB
  }

  writeBit(b) {
    if (b & 1) {
      this.curByte |= 1 << (7 - this.bitPos);
    }
    this.bitPos++;
    if (this.bitPos === 8) {
      this.bytes.push(this.curByte);
      this.curByte = 0;
      this.bitPos = 0;
    }
  }

  writeBits(val, count) {
    for (let i = count - 1; i >= 0; i--) {
      this.writeBit((val >>> i) & 1);
    }
  }

  align() {
    if (this.bitPos > 0) {
      this.bytes.push(this.curByte);
      this.curByte = 0;
      this.bitPos = 0;
    }
  }

  writeUint16(val) {
    this.align();
    this.bytes.push((val >>> 8) & 0xff, val & 0xff);
  }

  writeLengthDeterminant(len) {
    this.align();
    if (len < 128) {
      this.bytes.push(len & 0x7f);
    } else if (len < 16384) {
      this.bytes.push(0x80 | ((len >>> 8) & 0x3f), len & 0xff);
    } else {
      throw new Error(`PER length too large for single fragment: ${len}`);
    }
  }

  writeBytes(buf) {
    this.align();
    for (let i = 0; i < buf.length; i++) {
      this.bytes.push(buf[i]);
    }
  }

  toBuffer() {
    this.align();
    return Buffer.from(this.bytes);
  }
}

class PerReader {
  constructor(buf) {
    this.buf = buf;
    this.bytePos = 0;
    this.bitPos = 0;
  }

  readBit() {
    if (this.bytePos >= this.buf.length) {
      throw new Error('PER unexpected EOF');
    }
    const b = (this.buf[this.bytePos] >>> (7 - this.bitPos)) & 1;
    this.bitPos++;
    if (this.bitPos === 8) {
      this.bitPos = 0;
      this.bytePos++;
    }
    return b;
  }

  readBits(count) {
    let v = 0;
    for (let i = 0; i < count; i++) {
      v = (v << 1) | this.readBit();
    }
    return v;
  }

  align() {
    if (this.bitPos > 0) {
      this.bitPos = 0;
      this.bytePos++;
    }
  }

  readUint16() {
    this.align();
    if (this.bytePos + 2 > this.buf.length) throw new Error('PER uint16 EOF');
    const v = this.buf.readUInt16BE(this.bytePos);
    this.bytePos += 2;
    return v;
  }

  readLengthDeterminant() {
    this.align();
    if (this.bytePos >= this.buf.length) throw new Error('PER len EOF');
    const first = this.buf[this.bytePos++];
    if ((first & 0x80) === 0) {
      return first & 0x7f;
    }
    if ((first & 0xc0) === 0x80) {
      if (this.bytePos >= this.buf.length) throw new Error('PER len2 EOF');
      const second = this.buf[this.bytePos++];
      return ((first & 0x3f) << 8) | second;
    }
    throw new Error('Fragmented PER length not supported');
  }

  readBytes(len) {
    this.align();
    if (this.bytePos + len > this.buf.length) throw new Error('PER bytes EOF');
    const out = this.buf.subarray(this.bytePos, this.bytePos + len);
    this.bytePos += len;
    return Buffer.from(out);
  }
}

/**
 * Encode an IFPPacket in ASN.1 Aligned PER
 * @param {{ kind: 'indicator', indicator: number } | { kind: 'data', dataType: number, fields: Array<{ fieldType: number, data?: Buffer }> }} ifp
 * @returns {Buffer}
 */
export function encodeIFP(ifp) {
  const w = new PerWriter();

  if (ifp.kind === 'indicator') {
    w.writeBit(0); // data-field OPTIONAL absent
    w.writeBit(0); // CHOICE = t30-indicator (0)
    w.writeBit(0); // ENUMERATED extension bit = 0
    w.writeBits(ifp.indicator & 0x0f, 4); // 0..15 -> 4 bits
    return w.toBuffer();
  }

  const fields = ifp.fields || [];
  const hasDataField = fields.length > 0;
  w.writeBit(hasDataField ? 1 : 0); // data-field OPTIONAL
  w.writeBit(1); // CHOICE = t30-data (1)
  w.writeBit(0); // ENUMERATED extension bit = 0
  w.writeBits(ifp.dataType & 0x0f, 4); // 0..8 -> 4 bits

  if (hasDataField) {
    w.writeLengthDeterminant(fields.length);
    for (const f of fields) {
      const hasBytes = f.data && f.data.length > 0;
      w.writeBit(hasBytes ? 1 : 0); // field-data OPTIONAL
      w.writeBit(0); // field-type extension bit = 0
      w.writeBits(f.fieldType & 0x07, 3); // 0..7 -> 3 bits
      if (hasBytes) {
        // OCTET STRING (SIZE(1..65535)): constrained length (len - 1) in 16 bits, octet-aligned
        w.writeUint16(f.data.length - 1);
        w.writeBytes(f.data);
      }
      w.align();
    }
  }

  return w.toBuffer();
}

/**
 * Decode an IFPPacket from ASN.1 Aligned PER
 */
export function decodeIFP(buf) {
  const r = new PerReader(buf);
  const hasDataField = r.readBit() === 1;
  const msgChoice = r.readBit();
  const ext = r.readBit();
  if (ext !== 0) throw new Error('Extended IFP enum not supported');

  if (msgChoice === 0) {
    const indicator = r.readBits(4);
    return {
      kind: 'indicator',
      indicator,
      indicatorName: T30_INDICATOR_NAMES[indicator] || `ind(${indicator})`,
      fields: [],
    };
  }

  const dataType = r.readBits(4);
  const fields = [];

  if (hasDataField) {
    const count = r.readLengthDeterminant();
    for (let i = 0; i < count; i++) {
      const hasBytes = r.readBit() === 1;
      const fExt = r.readBit();
      if (fExt !== 0) throw new Error('Extended field-type not supported');
      const fieldType = r.readBits(3);
      let data = null;
      if (hasBytes) {
        const lenMinusOne = r.readUint16();
        data = r.readBytes(lenMinusOne + 1);
      }
      r.align();
      fields.push({
        fieldType,
        fieldTypeName: FIELD_TYPE_NAMES[fieldType] || `field(${fieldType})`,
        data,
      });
    }
  }

  return {
    kind: 'data',
    dataType,
    dataTypeName: T30_DATA_NAMES[dataType] || `data(${dataType})`,
    fields,
  };
}

/**
 * Encode a complete UDPTLPacket
 * @param {number} seqNumber
 * @param {Buffer} primaryIfpBuf
 * @param {Buffer[]} secondaryIfpBufs - optional redundancy IFPs
 * @returns {Buffer}
 */
export function encodeUDPTL(seqNumber, primaryIfpBuf, secondaryIfpBufs = []) {
  const w = new PerWriter();
  w.writeUint16(seqNumber & 0xffff);
  w.writeLengthDeterminant(primaryIfpBuf.length);
  w.writeBytes(primaryIfpBuf);

  // error-recovery CHOICE: 0 = secondary-ifp-packets
  w.writeBit(0);
  w.writeLengthDeterminant(secondaryIfpBufs.length);
  for (const sec of secondaryIfpBufs) {
    w.writeLengthDeterminant(sec.length);
    w.writeBytes(sec);
  }
  return w.toBuffer();
}

/**
 * Decode a complete UDPTLPacket
 */
export function decodeUDPTL(buf) {
  const r = new PerReader(buf);
  const seqNumber = r.readUint16();
  const primaryLen = r.readLengthDeterminant();
  const primaryBuf = r.readBytes(primaryLen);
  const primary = decodeIFP(primaryBuf);

  const errorChoice = r.readBit();
  const secondary = [];
  if (errorChoice === 0) {
    const secCount = r.readLengthDeterminant();
    for (let i = 0; i < secCount; i++) {
      const secLen = r.readLengthDeterminant();
      const secBuf = r.readBytes(secLen);
      secondary.push(decodeIFP(secBuf));
    }
  }

  return {
    seqNumber,
    primary,
    primaryBytes: primaryBuf.length,
    secondary,
  };
}
