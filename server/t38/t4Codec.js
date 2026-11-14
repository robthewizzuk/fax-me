/**
 * ITU-T T.4 Modified Huffman (1D MH) Group 3 Facsimile Codec
 * Standard scanline width: 1728 pixels (A4)
 * Note: T.38 t4-non-ecm-data carries T.4 bitstream in LSB-first octet bit-order
 * (bit-reversed relative to MSB-first TIFF FillOrder=1), or MSB-first depending on T.38/TIFF.
 * Per ITU-T T.38 Section 4 / ITU-T T.30, wire octets are transmitted LSB-first (FillOrder=2).
 */

export const FAX_WIDTH = 1728;

// ITU-T T.4 Table 1: White Run Lengths
const WHITE_TERMINATING = [
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111',
  '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
  '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100',
  '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
  '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000',
  '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
  '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000',
  '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100'
];

const WHITE_MAKEUP = {
  64: '11011', 128: '10010', 192: '010111', 256: '0110111',
  320: '00110110', 384: '00110111', 448: '01100100', 512: '01100101',
  576: '01101000', 640: '01100111', 704: '011001100', 768: '011001101',
  832: '011010010', 896: '011010011', 960: '011010100', 1024: '011010101',
  1088: '011010110', 1152: '011010111', 1216: '011011000', 1280: '011011001',
  1344: '011011010', 1408: '011011011', 1472: '010011000', 1536: '010011001',
  1600: '010011010', 1664: '011000', 1728: '010011011'
};

// ITU-T T.4 Table 2: Black Run Lengths
const BLACK_TERMINATING = [
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011',
  '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000',
  '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000',
  '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001',
  '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111',
  '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
  '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111',
  '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111'
];

const BLACK_MAKEUP = {
  64: '0000001111', 128: '000011001000', 192: '000011001001', 256: '000001011011',
  320: '000000110011', 384: '000000110100', 448: '000000110101', 512: '0000001101100',
  576: '0000001101101', 640: '0000001001010', 704: '0000001001011', 768: '0000001001100',
  832: '0000001001101', 896: '0000001110010', 960: '0000001110011', 1024: '0000001110100',
  1088: '0000001110101', 1152: '0000001110110', 1216: '0000001110111', 1280: '0000001010010',
  1344: '0000001010011', 1408: '0000001010100', 1472: '0000001010101', 1536: '0000001011010',
  1600: '0000001011011', 1664: '0000001100100', 1728: '0000001100101'
};

const EOL_BITS = '000000000001';

// Build prefix decode tries
function buildTree(termArr, makeupMap) {
  const root = {};
  const insert = (bits, val, isMakeup) => {
    let node = root;
    for (let i = 0; i < bits.length; i++) {
      const b = bits[i];
      if (!node[b]) node[b] = {};
      node = node[b];
    }
    if (node.val !== undefined) {
      throw new Error(`Duplicate T.4 Huffman code for ${bits}`);
    }
    node.val = val;
    node.isMakeup = isMakeup;
  };
  termArr.forEach((bits, val) => insert(bits, val, false));
  for (const [lenStr, bits] of Object.entries(makeupMap)) {
    insert(bits, Number(lenStr), true);
  }
  insert(EOL_BITS, -1, false); // EOL sentinel
  return root;
}

const WHITE_TREE = buildTree(WHITE_TERMINATING, WHITE_MAKEUP);
const BLACK_TREE = buildTree(BLACK_TERMINATING, BLACK_MAKEUP);

export function reverseBitsByte(b) {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    r = (r << 1) | ((b >> i) & 1);
  }
  return r & 0xff;
}

class BitWriter {
  constructor(lsbFirst = true) {
    this.bytes = [];
    this.cur = 0;
    this.bitCount = 0;
    this.lsbFirst = lsbFirst;
  }

  writeBits(bitStr) {
    for (let i = 0; i < bitStr.length; i++) {
      const bit = bitStr.charCodeAt(i) - 48;
      if (this.lsbFirst) {
        this.cur |= (bit << this.bitCount);
      } else {
        this.cur = (this.cur << 1) | bit;
      }
      this.bitCount++;
      if (this.bitCount === 8) {
        this.bytes.push(this.cur & 0xff);
        this.cur = 0;
        this.bitCount = 0;
      }
    }
  }

  flush() {
    if (this.bitCount > 0) {
      if (!this.lsbFirst) {
        this.cur <<= (8 - this.bitCount);
      }
      this.bytes.push(this.cur & 0xff);
      this.cur = 0;
      this.bitCount = 0;
    }
    return Buffer.from(this.bytes);
  }
}

function encodeRun(writer, len, isBlack) {
  const term = isBlack ? BLACK_TERMINATING : WHITE_TERMINATING;
  const makeup = isBlack ? BLACK_MAKEUP : WHITE_MAKEUP;
  let rem = len;
  while (rem >= 64) {
    const chunk = Math.min(1728, Math.floor(rem / 64) * 64);
    writer.writeBits(makeup[chunk]);
    rem -= chunk;
  }
  writer.writeBits(term[rem]);
}

/**
 * Encode a 1-bit monochrome raster (0 = white, 1 = black) into ITU-T T.4 1D MH bitstream.
 * @param {Uint8Array} pixels - length width * height, values 0 (white) or 1 (black)
 * @param {number} width - default 1728
 * @param {number} height
 * @param {{ lsbFirst?: boolean }} opts - T.38 wire order uses lsbFirst=true
 * @returns {Buffer}
 */
export function encodeT4MH(pixels, width = FAX_WIDTH, height, opts = {}) {
  const lsbFirst = opts.lsbFirst !== undefined ? opts.lsbFirst : true;
  const writer = new BitWriter(lsbFirst);

  // Leading EOL per T.4
  writer.writeBits(EOL_BITS);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    let x = 0;
    let expectBlack = false; // Every scanline begins with a white run

    while (x < width) {
      const target = expectBlack ? 1 : 0;
      let run = 0;
      while (x + run < width && pixels[rowOffset + x + run] === target) {
        run++;
      }
      encodeRun(writer, run, expectBlack);
      x += run;
      expectBlack = !expectBlack;
    }
    writer.writeBits(EOL_BITS);
  }

  // RTC (Return To Control): 6 consecutive EOLs
  for (let i = 0; i < 5; i++) {
    writer.writeBits(EOL_BITS);
  }

  return writer.flush();
}

/**
 * Decode ITU-T T.4 1D MH bitstream back into a 1-bit monochrome pixel buffer.
 * Handles noisy/glitched scanlines gracefully (fills missing tail with white, resyncs on EOL).
 * @param {Buffer} buffer
 * @param {number} width - default 1728
 * @param {{ lsbFirst?: boolean }} opts
 * @returns {{ pixels: Uint8Array, width: number, height: number, errors: number }}
 */
export function decodeT4MH(buffer, width = FAX_WIDTH, opts = {}) {
  const lsbFirst = opts.lsbFirst !== undefined ? opts.lsbFirst : true;
  const totalBits = buffer.length * 8;
  let bitPos = 0;

  const readBit = () => {
    if (bitPos >= totalBits) return -1;
    const byteIdx = bitPos >> 3;
    const bitInByte = bitPos & 7;
    bitPos++;
    if (lsbFirst) {
      return (buffer[byteIdx] >> bitInByte) & 1;
    }
    return (buffer[byteIdx] >> (7 - bitInByte)) & 1;
  };

  // Resync to next EOL (11+ zeros followed by a 1)
  const seekNextEOL = () => {
    let zeros = 0;
    while (true) {
      const b = readBit();
      if (b === -1) return false;
      if (b === 0) {
        zeros++;
      } else {
        if (zeros >= 11) return true;
        zeros = 0;
      }
    }
  };

  const rows = [];
  let consecutiveEOL = 0;
  let errors = 0;

  // Seek initial EOL
  if (!seekNextEOL()) {
    return { pixels: new Uint8Array(0), width, height: 0, errors: 1 };
  }

  while (bitPos < totalBits) {
    const row = new Uint8Array(width);
    let x = 0;
    let isBlack = false;
    let accumRun = 0;
    let hitEOL = false;

    while (x < width) {
      let node = isBlack ? BLACK_TREE : WHITE_TREE;
      let decoded = null;
      while (node && decoded === null) {
        const b = readBit();
        if (b === -1) {
          decoded = { val: -2 };
          break;
        }
        node = node[b === 0 ? '0' : '1'];
        if (node && node.val !== undefined) {
          decoded = node;
        }
      }

      if (!decoded || decoded.val === -2) {
        // EOF or bit error
        if (decoded === null) errors++;
        hitEOL = true;
        break;
      }

      if (decoded.val === -1) {
        // Hit EOL early (possibly empty line = RTC!)
        hitEOL = true;
        break;
      }

      accumRun += decoded.val;
      if (!decoded.isMakeup) {
        const endX = Math.min(width, x + accumRun);
        if (isBlack) {
          row.fill(1, x, endX);
        }
        x = endX;
        accumRun = 0;
        isBlack = !isBlack;
      }
    }

    if (hitEOL && x === 0) {
      consecutiveEOL++;
      if (consecutiveEOL >= 5) {
        break; // RTC reached
      }
      continue;
    }

    consecutiveEOL = 0;
    rows.push(row);

    if (!hitEOL) {
      // Consume trailing EOL (including fill zeros)
      if (!seekNextEOL()) break;
    }
  }

  const height = rows.length;
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    pixels.set(rows[y], y * width);
  }
  return { pixels, width, height, errors };
}
