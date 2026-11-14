/**
 * Pure-JS PNG Decoder & Encoder using Web Standard CompressionStream / DecompressionStream ('deflate').
 * Zero native dependencies — works identically in Cloudflare Workers, Browsers, and Node 20+.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function zlibTransform(format, inputU8) {
  const StreamCtor = format === 'compress' ? CompressionStream : DecompressionStream;
  const cs = new StreamCtor('deflate');
  const writer = cs.writable.getWriter();
  writer.write(inputU8);
  writer.close();
  const ab = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(ab);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode an 8-bit PNG (RGB/RGBA/Grayscale/Grayscale+Alpha) into { width, height, gray: Uint8Array }.
 */
export async function decodePngToGray(pngBytes) {
  const u8 = pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 2;
  const idats = [];

  while (pos + 8 <= u8.length) {
    const len = dv.getUint32(pos, false);
    const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
    const data = u8.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const idv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = idv.getUint32(0, false);
      height = idv.getUint32(4, false);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }

  if (!width || !height || bitDepth !== 8) {
    throw new Error(`Unsupported PNG format (${width}x${height}, depth=${bitDepth})`);
  }

  const totalIdat = idats.reduce((s, c) => s + c.length, 0);
  const compressed = new Uint8Array(totalIdat);
  let off = 0;
  for (const c of idats) {
    compressed.set(c, off);
    off += c.length;
  }

  const raw = await zlibTransform('decompress', compressed);
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * bpp;
  const scan = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    for (let x = 0; x < stride; x++) {
      const xVal = raw[rowIn + x];
      const a = x >= bpp ? scan[rowOut + x - bpp] : 0;
      const b = y > 0 ? scan[rowOut - stride + x] : 0;
      const c = x >= bpp && y > 0 ? scan[rowOut - stride + x - bpp] : 0;
      let recon = xVal;
      if (filter === 1) recon = (xVal + a) & 0xff;
      else if (filter === 2) recon = (xVal + b) & 0xff;
      else if (filter === 3) recon = (xVal + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) recon = (xVal + paeth(a, b, c)) & 0xff;
      scan[rowOut + x] = recon;
    }
  }

  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * bpp;
    if (colorType === 0) gray[i] = scan[p];
    else if (colorType === 4) {
      const alpha = scan[p + 1] / 255;
      gray[i] = Math.round(scan[p] * alpha + 255 * (1 - alpha));
    } else if (colorType === 2) {
      gray[i] = Math.round(0.299 * scan[p] + 0.587 * scan[p + 1] + 0.114 * scan[p + 2]);
    } else {
      const alpha = scan[p + 3] / 255;
      const luma = 0.299 * scan[p] + 0.587 * scan[p + 1] + 0.114 * scan[p + 2];
      gray[i] = Math.round(luma * alpha + 255 * (1 - alpha));
    }
  }

  return { width, height, gray };
}

/**
 * Dither a PNG into a 1728px wide 1-bit monochrome fax sheet.
 */
export async function rasterizePngEdge(pngBytes, { fine = true, maxHeight = 2200 } = {}) {
  const { width: srcW, height: srcH, gray } = await decodePngToGray(pngBytes);
  const targetW = 1728;
  const marginX = 48;
  const fitW = targetW - marginX * 2;
  const aspect = srcH / Math.max(1, srcW);
  const effAspect = fine ? aspect : aspect * 0.5;
  let fitH = Math.max(80, Math.round(fitW * effAspect));
  if (fitH > maxHeight) fitH = maxHeight;

  const topPad = fine ? 48 : 24;
  const totalH = topPad + fitH + (fine ? 48 : 24);
  const buf = new Float32Array(targetW * totalH).fill(255);

  for (let y = 0; y < fitH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / fitH));
    for (let x = 0; x < fitW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / fitW));
      let v = gray[sy * srcW + sx];
      if (v > 236) v = 255;
      else if (v < 26) v = 0;
      buf[(topPad + y) * targetW + (marginX + x)] = v;
    }
  }

  // Floyd-Steinberg error diffusion
  const pixels = new Uint8Array(targetW * totalH);
  let blackCount = 0;
  for (let y = 0; y < totalH; y++) {
    for (let x = 0; x < targetW; x++) {
      const idx = y * targetW + x;
      const oldVal = buf[idx];
      const isBlack = oldVal < 128;
      const newVal = isBlack ? 0 : 255;
      pixels[idx] = isBlack ? 1 : 0;
      if (isBlack) blackCount++;
      const err = oldVal - newVal;
      if (x + 1 < targetW) buf[idx + 1] += err * (7 / 16);
      if (y + 1 < totalH) {
        if (x > 0) buf[idx + targetW - 1] += err * (3 / 16);
        buf[idx + targetW] += err * (5 / 16);
        if (x + 1 < targetW) buf[idx + targetW + 1] += err * (1 / 16);
      }
    }
  }

  return {
    pixels,
    width: targetW,
    height: totalH,
    blackRatio: blackCount / (targetW * totalH),
  };
}

function makePngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  dv.setUint32(8 + data.length, crc, false);
  return out;
}

/**
 * Encode 1-bit fax pixels into an authentic warm thermal paper RGB PNG.
 */
export async function renderThermalPngEdge(pixels, width, height, { fine = true } = {}) {
  const outH = fine ? height : height * 2;
  const stride = width * 3 + 1;
  const raw = new Uint8Array(outH * stride);

  for (let y = 0; y < outH; y++) {
    const srcY = fine ? y : Math.floor(y / 2);
    const rowOff = y * stride;
    raw[rowOff] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const black = pixels[srcY * width + x];
      const p = rowOff + 1 + x * 3;
      if (black) {
        raw[p] = 24;
        raw[p + 1] = 26;
        raw[p + 2] = 30;
      } else {
        raw[p] = 250;
        raw[p + 1] = 247;
        raw[p + 2] = 238;
      }
    }
  }

  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, width, false);
  idv.setUint32(4, outH, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB

  const compressed = await zlibTransform('compress', raw);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const c1 = makePngChunk('IHDR', ihdr);
  const c2 = makePngChunk('IDAT', compressed);
  const c3 = makePngChunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(sig.length + c1.length + c2.length + c3.length);
  let off = 0;
  for (const part of [sig, c1, c2, c3]) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}
