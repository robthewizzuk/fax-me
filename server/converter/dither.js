import sharp from 'sharp';
import { FAX_WIDTH } from '../t38/t4Codec.js';

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTtiDate(ts = Date.now()) {
  const d = new Date(ts);
  const mon = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getMonth()];
  const day = String(d.getDate()).padStart(2, '0');
  const yr = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mon}-${day}-${yr} ${hh}:${mm}`;
}

/**
 * Convert an input PNG/JPEG/etc buffer into a 1728px wide 1-bit monochrome fax page with TTI header.
 * @returns {Promise<{ pixels: Uint8Array, width: number, height: number, blackRatio: number }>}
 */
export async function rasterizeToFaxPage(inputBuffer, {
  fine = true,
  fromLabel = '',
  toLabel = '',
  pageNum = 1,
  totalPages = 1,
} = {}) {
  const targetWidth = FAX_WIDTH;
  const maxContentHeight = fine ? 2280 : 1140;
  const headerHeight = fine ? 48 : 24;

  // Resize image fitting nicely onto white A4 fax sheet with small horizontal margins
  const marginX = 48;
  const innerWidth = targetWidth - marginX * 2;
  const meta = await sharp(inputBuffer).metadata();

  let resized = sharp(inputBuffer)
    .rotate() // auto EXIF orientation
    .flatten({ background: '#ffffff' });

  const aspect = (meta.height || 1000) / (meta.width || 1000);
  // In standard mode (204x98 dpi), vertical pixel density is half of horizontal
  const effectiveAspect = fine ? aspect : aspect * 0.5;
  let innerHeight = Math.round(innerWidth * effectiveAspect);
  let fitWidth = innerWidth;

  if (innerHeight > maxContentHeight - headerHeight - 32) {
    const scale = (maxContentHeight - headerHeight - 32) / innerHeight;
    innerHeight = Math.max(40, Math.round(innerHeight * scale));
    fitWidth = Math.max(80, Math.round(innerWidth * scale));
  }

  const contentBuf = await resized
    .resize(fitWidth, innerHeight, { fit: 'fill' })
    .grayscale()
    .toBuffer();

  const totalHeight = Math.max(fine ? 480 : 240, headerHeight + innerHeight + (fine ? 60 : 30));

  // Classic dot-matrix style TTI banner across the top edge
  const fontSize = fine ? 21 : 11;
  const textY = fine ? 31 : 17;
  const lineY = fine ? 42 : 21;
  const ttiLeft = `${formatTtiDate()}   FROM: ${fromLabel.slice(0, 36)}`;
  const ttiRight = `TO: ${toLabel.slice(0, 22)}   P.${String(pageNum).padStart(2, '0')}/${String(totalPages).padStart(2, '0')}`;

  const ttiSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${targetWidth}" height="${headerHeight}">
      <rect width="100%" height="100%" fill="#ffffff"/>
      <text x="48" y="${textY}" font-family="monospace" font-weight="bold" font-size="${fontSize}" fill="#000000">${escapeXml(ttiLeft)}</text>
      <text x="${targetWidth - 48}" y="${textY}" text-anchor="end" font-family="monospace" font-weight="bold" font-size="${fontSize}" fill="#000000">${escapeXml(ttiRight)}</text>
      <line x1="48" y1="${lineY}" x2="${targetWidth - 48}" y2="${lineY}" stroke="#000000" stroke-width="${fine ? 2 : 1}" stroke-dasharray="6,4"/>
    </svg>
  `);

  const leftPad = Math.round((targetWidth - fitWidth) / 2);

  const { data: grayData, info } = await sharp({
    create: {
      width: targetWidth,
      height: totalHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: ttiSvg, top: 0, left: 0 },
      { input: contentBuf, top: headerHeight + (fine ? 14 : 7), left: leftPad },
    ])
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Adaptive Floyd-Steinberg Dithering (keeps crisp text clean while dithering photos!)
  const w = info.width;
  const h = info.height;
  const buf = new Float32Array(w * h);
  for (let i = 0; i < buf.length; i++) {
    // Slight contrast curve so off-white paper stays clean while photos dither crisply
    let v = grayData[i];
    if (v > 236) v = 255;
    else if (v < 26) v = 0;
    buf[i] = v;
  }

  const pixels = new Uint8Array(w * h);
  let blackCount = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const oldVal = buf[idx];
      const isBlack = oldVal < 128;
      const newVal = isBlack ? 0 : 255;
      pixels[idx] = isBlack ? 1 : 0;
      if (isBlack) blackCount++;

      const err = oldVal - newVal;
      if (x + 1 < w) buf[idx + 1] += err * (7 / 16);
      if (y + 1 < h) {
        if (x > 0) buf[idx + w - 1] += err * (3 / 16);
        buf[idx + w] += err * (5 / 16);
        if (x + 1 < w) buf[idx + w + 1] += err * (1 / 16);
      }
    }
  }

  return {
    pixels,
    width: w,
    height: h,
    blackRatio: blackCount / (w * h),
  };
}

/**
 * Render decoded T.38 1-bit monochrome fax pixels into an authentic thermal-paper PNG buffer.
 */
export async function renderThermalPng(pixels, width, height, { fine = true } = {}) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    // Subtle thermal paper roller micro-sheen variation
    const paperR = 250;
    const paperG = 247;
    const paperB = 238;
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const p = idx * 3;
      if (pixels[idx]) {
        // Dark thermal charcoal print
        rgb[p] = 24;
        rgb[p + 1] = 26;
        rgb[p + 2] = 30;
      } else {
        rgb[p] = paperR;
        rgb[p + 1] = paperG;
        rgb[p + 2] = paperB;
      }
    }
  }

  let img = sharp(rgb, { raw: { width, height, channels: 3 } });
  // In standard mode (204x98 dpi), physical fax paper feeds twice as tall per scanline!
  // Stretching 2x vertically with nearest-neighbor creates the iconic chunky 1990s fax scanline texture!
  if (!fine) {
    img = img.resize(width, height * 2, { kernel: 'nearest' });
  }
  return img.png({ compressionLevel: 6 }).toBuffer();
}
