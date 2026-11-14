/**
 * Pure-JS 5x7 Bitmap Font & Fax Sheet Renderer for Cloudflare Workers Edge.
 * Zero Node/Sharp/Chromium dependencies — writes directly to 1-bit pixel arrays and RGB PNGs.
 */
import { decodePngToGray } from './pngEdge.js';

// Compact 5x7 bitmap glyphs (each row is 5 bits wide, 7 rows tall)
const FONT_5X7 = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '!': [4, 4, 4, 4, 4, 0, 4],
  '"': [10, 10, 10, 0, 0, 0, 0],
  '#': [10, 10, 31, 10, 31, 10, 10],
  '$': [4, 15, 20, 14, 5, 30, 4],
  '%': [25, 25, 2, 4, 8, 19, 19],
  '&': [12, 18, 20, 8, 21, 18, 13],
  "'": [4, 4, 8, 0, 0, 0, 0],
  '(': [2, 4, 8, 8, 8, 4, 2],
  ')': [8, 4, 2, 2, 2, 4, 8],
  '*': [0, 4, 21, 14, 21, 4, 0],
  '+': [0, 4, 4, 31, 4, 4, 0],
  ',': [0, 0, 0, 0, 0, 4, 8],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 0, 4],
  '/': [1, 2, 2, 4, 8, 8, 16],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 6, 8, 16, 31],
  '3': [31, 2, 4, 6, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  ':': [0, 0, 4, 0, 4, 0, 0],
  ';': [0, 0, 4, 0, 4, 4, 8],
  '<': [2, 4, 8, 16, 8, 4, 2],
  '=': [0, 0, 31, 0, 31, 0, 0],
  '>': [8, 4, 2, 1, 2, 4, 8],
  '?': [14, 17, 1, 2, 4, 0, 4],
  '@': [14, 17, 23, 21, 23, 16, 14],
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 27, 17],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  '[': [14, 8, 8, 8, 8, 8, 14],
  '\\': [16, 8, 8, 4, 2, 2, 1],
  ']': [14, 2, 2, 2, 2, 2, 14],
  '^': [4, 10, 17, 0, 0, 0, 0],
  _: [0, 0, 0, 0, 0, 0, 31],
  '|': [4, 4, 4, 4, 4, 4, 4],
  '~': [0, 0, 10, 21, 0, 0, 0],
};

function drawText1Bit(pixels, stride, maxH, text, startX, startY, scaleX = 3, scaleY = 3) {
  const s = String(text || '').toUpperCase();
  let x = startX;
  for (let i = 0; i < s.length; i++) {
    const glyph = FONT_5X7[s[i]] || FONT_5X7[' '];
    for (let row = 0; row < 7; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if ((bits >> (4 - col)) & 1) {
          for (let sy = 0; sy < scaleY; sy++) {
            const py = startY + row * scaleY + sy;
            if (py < 0 || py >= maxH) continue;
            for (let sx = 0; sx < scaleX; sx++) {
              const px = x + col * scaleX + sx;
              if (px >= 0 && px < stride) {
                pixels[py * stride + px] = 1;
              }
            }
          }
        }
      }
    }
    x += 6 * scaleX;
    if (x >= stride - 24) break;
  }
}

function drawRect1Bit(pixels, stride, maxH, x, y, w, h, thickness = 3) {
  for (let t = 0; t < thickness; t++) {
    for (let px = x; px < x + w; px++) {
      if (px >= 0 && px < stride) {
        if (y + t >= 0 && y + t < maxH) pixels[(y + t) * stride + px] = 1;
        if (y + h - 1 - t >= 0 && y + h - 1 - t < maxH) pixels[(y + h - 1 - t) * stride + px] = 1;
      }
    }
    for (let py = y; py < y + h; py++) {
      if (py >= 0 && py < maxH) {
        if (x + t >= 0 && x + t < stride) pixels[py * stride + x + t] = 1;
        if (x + w - 1 - t >= 0 && x + w - 1 - t < stride) pixels[py * stride + x + w - 1 - t] = 1;
      }
    }
  }
}

function formatTtiDate(ts = Date.now()) {
  const d = new Date(ts);
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, '0');
  const yr = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${mon}-${day}-${yr} ${hh}:${mm}`;
}

/**
 * Prepend authentic dot-matrix TTI header row above rasterized 1-bit page pixels.
 */
export function prependTtiHeaderEdge(page, { fine = true, fromLabel = '', toLabel = '', pageNum = 1, totalPages = 1 } = {}) {
  const w = page.width || 1728;
  const headerH = fine ? 52 : 26;
  const newH = page.height + headerH;
  const pixels = new Uint8Array(w * newH);
  const scaleY = fine ? 3 : 2;
  const scaleX = 2;

  const leftText = `${formatTtiDate()}  FROM: ${String(fromLabel).slice(0, 34)}`;
  const rightText = `TO: ${String(toLabel).slice(0, 20)} P.${String(pageNum).padStart(2, '0')}/${String(totalPages).padStart(2, '0')}`;

  drawText1Bit(pixels, w, newH, leftText, 48, fine ? 12 : 5, scaleX, scaleY);
  const rightX = Math.max(880, w - 48 - rightText.length * 6 * scaleX);
  drawText1Bit(pixels, w, newH, rightText, rightX, fine ? 12 : 5, scaleX, scaleY);

  // Dashed divider line
  const lineY = fine ? 42 : 21;
  for (let x = 48; x < w - 48; x++) {
    if (Math.floor(x / 8) % 2 === 0) {
      pixels[lineY * w + x] = 1;
      if (fine) pixels[(lineY + 1) * w + x] = 1;
    }
  }

  pixels.set(page.pixels, headerH * w);
  let black = 0;
  for (let i = 0; i < pixels.length; i++) black += pixels[i];
  return {
    pixels,
    width: w,
    height: newH,
    blackRatio: black / pixels.length,
  };
}

/**
 * Render an already-1-bit-dithered monochrome sheet (1728px) from structured lines without Sharp/Chromium.
 */
export function buildMonochromeSheetPixels({
  banner = 'FACSIMILE TRANSMISSION',
  meta = [],
  lines = [],
  fine = true,
} = {}) {
  const w = 1728;
  const scaleY = fine ? 4 : 2;
  const lineStep = fine ? 44 : 22;
  const h = fine ? 1680 : 840;
  const pixels = new Uint8Array(w * h);

  drawRect1Bit(pixels, w, h, 48, fine ? 36 : 18, w - 96, h - (fine ? 72 : 36), fine ? 4 : 2);
  drawText1Bit(pixels, w, h, banner, 84, fine ? 74 : 37, 4, scaleY);

  let y = fine ? 140 : 70;
  for (let x = 84; x < w - 84; x++) {
    pixels[y * w + x] = 1;
    if (fine) pixels[(y + 2) * w + x] = 1;
  }
  y += fine ? 28 : 14;

  for (const m of meta) {
    drawText1Bit(pixels, w, h, m, 84, y, 3, fine ? 3 : 2);
    y += lineStep;
  }

  y += fine ? 12 : 6;
  for (let x = 84; x < w - 84; x++) {
    if (Math.floor(x / 6) % 2 === 0) pixels[y * w + x] = 1;
  }
  y += fine ? 34 : 17;

  for (const line of lines) {
    if (y > h - (fine ? 90 : 45)) break;
    // Wrap long lines cleanly at 68 chars
    const str = String(line || '');
    if (str.length <= 68) {
      drawText1Bit(pixels, w, h, str, 84, y, 3, fine ? 3 : 2);
      y += lineStep;
    } else {
      for (let i = 0; i < str.length && y <= h - (fine ? 90 : 45); i += 68) {
        drawText1Bit(pixels, w, h, str.slice(i, i + 68), 84, y, 3, fine ? 3 : 2);
        y += lineStep;
      }
    }
  }

  let black = 0;
  for (let i = 0; i < pixels.length; i++) black += pixels[i];
  return { pixels, width: w, height: h, blackRatio: black / pixels.length };
}

export function buildCoverSheetPageEdge({
  from = '',
  to = '',
  company = 'Dunder & Beige Systems',
  subject = 'Facsimile Transmission',
  comments = '',
  flags = ['URGENT'],
  totalDocPages = 1,
  fine = true,
} = {}) {
  const flagLine = ['URGENT', 'FOR REVIEW', 'PLEASE COMMENT', 'CONFIDENTIAL']
    .map((f) => `[${flags.includes(f) ? 'X' : ' '}] ${f}`)
    .join('   ');

  return buildMonochromeSheetPixels({
    banner: 'URGENT FACSIMILE COVER SHEET',
    meta: [
      `ORGANIZATION : ${company}`,
      `TO           : ${to || 'RECIPIENT'}`,
      `FROM         : ${from || 'SENDER'}`,
      `SUBJECT      : ${subject}`,
      `PAGES        : ${totalDocPages + 1} (INCLUDING COVER SHEET)`,
      `PRIORITY     : ${flagLine}`,
    ],
    lines: [
      'COMMENTS / ROUTING INSTRUCTIONS:',
      '',
      ...(String(comments || 'PLEASE DELIVER IMMEDIATELY TO ADDRESSEE DESK.').split('\n')),
      '',
      '--------------------------------------------------------------------',
      'TRANSMITTED VIA ITU-T T.38 REAL-TIME FOIP (V.17 14,400 BPS)',
    ],
    fine,
  });
}

export async function generateBotReplyFaxPagesEdge(botId, { senderNumber, senderName, receivedPages, fine }) {
  if (botId === 'bot-echo' && receivedPages?.length > 0) {
    return receivedPages.map((p) => ({
      pixels: new Uint8Array(p.pixels),
      width: p.width,
      height: p.height,
      blackRatio: p.blackRatio,
    }));
  }

  if (botId === 'bot-megacorp') {
    return [
      buildMonochromeSheetPixels({
        banner: 'MEGACORP HR - INTEROFFICE MEMO',
        meta: [
          `FROM    : HUMAN RESOURCES (EXT. 1994)`,
          `TO      : ${senderName || 'VALUED EMPLOYEE'} (${senderNumber})`,
          `SUBJECT : TPS REPORT COVER SHEET AUDIT`,
        ],
        lines: [
          'THANK YOU FOR YOUR FACSIMILE TRANSMISSION.',
          '',
          'OUR MICROFICHE AUDIT TEAM REVIEWED YOUR DOCUMENT:',
          '  [X] MISSING NEW COVER SHEET FORMAT (FORM 94-B)',
          '  [X] INSUFFICIENT BEIGE TONER DENSITY',
          '  [ ] APPROVED BY MIDDLE MANAGEMENT',
          '',
          'PLEASE RE-FAX IN TRIPLICATE BEFORE FRIDAY 5:00 PM OR',
          'REPORT TO SUB-BASEMENT STORAGE FOR STAPLE COUNTING.',
          '',
          '   +------------------------------+',
          '   |  STAMPED: FILED IN DRAWER    |',
          '   |      NOVEMBER 13, 1994       |',
          '   +------------------------------+',
        ],
        fine,
      }),
    ];
  }

  const fortunes = [
    'YOUR NEXT IMPORTANT EMAIL WILL BE PRINTED AND LEFT ON A DESK.',
    'A MYSTERIOUS CURLY THERMAL SCROLL BRINGS UNEXPECTED CLARITY.',
    'THE MODEM SCREECHES FAVOR YOUR BOLDEST MEMO THIS WEEK.',
    'SOMEONE FAR AWAY IS ABOUT TO SEND YOU A VERY DITHERED CAT.',
  ];
  const fortune = fortunes[Math.floor(Math.random() * fortunes.length)];
  const lucky = `${Math.floor(100 + Math.random() * 899)}-01${Math.floor(10 + Math.random() * 89)}`;

  return [
    buildMonochromeSheetPixels({
      banner: 'MYSTIC FAX ORACLE - FORTUNE',
      meta: [
        `FROM    : THE THERMAL ORACLE (555-010-0777)`,
        `TO      : ${senderName || 'SEEKER'} (${senderNumber})`,
        `SUBJECT : YOUR FACSIMILE FORTUNE`,
      ],
      lines: [
        '          . * .     _______     . * .',
        '                  /         \\',
        '                 |  T . 3 8  |',
        '                 |   O R B   |',
        '                  \\ _______ /',
        '',
        'THE THERMAL ORACLE READS YOUR TRANSMISSION:',
        '',
        `  "${fortune}"`,
        '',
        `LUCKY AREA CODE : ${lucky}`,
        'BAUD ALIGNMENT  : 14,400 BPS ASCENDING',
        'PAPER AURA      : SLIGHTLY CURLED',
      ],
      fine,
    }),
  ];
}

export async function pngGraySummary(pngBytes) {
  return decodePngToGray(pngBytes);
}
