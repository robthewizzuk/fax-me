import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);
const MAX_PAGES = 4;

const CHROMIUM_BIN = fs.existsSync('/usr/bin/chromium')
  ? '/usr/bin/chromium'
  : '/usr/bin/google-chrome';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function pdfToPngBuffers(pdfPath, workDir) {
  const outPrefix = path.join(workDir, 'page');
  await execFileAsync('pdftoppm', [
    '-png',
    '-r', '175',
    '-f', '1',
    '-l', String(MAX_PAGES),
    pdfPath,
    outPrefix,
  ], { timeout: 25000 });

  const files = fs
    .readdirSync(workDir)
    .filter((f) => f.startsWith('page-') && f.endsWith('.png'))
    .sort();
  return files.slice(0, MAX_PAGES).map((f) => fs.readFileSync(path.join(workDir, f)));
}

async function htmlToPngBuffers(htmlContent, workDir, { landscape = false } = {}) {
  const htmlPath = path.join(workDir, 'doc.html');
  const pdfPath = path.join(workDir, 'doc.pdf');
  fs.writeFileSync(htmlPath, htmlContent, 'utf8');

  await execFileAsync(
    CHROMIUM_BIN,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-software-rasterizer',
      '--print-to-pdf-no-header',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ],
    { timeout: 30000 }
  );

  return pdfToPngBuffers(pdfPath, workDir);
}

async function convertDocx(buffer, workDir) {
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const b64 = await image.read('base64');
        return { src: `data:${image.contentType};base64,${b64}` };
      }),
    }
  );
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 16mm 18mm; }
    body { font-family: Georgia, "Times New Roman", serif; color: #000; font-size: 13pt; line-height: 1.48; }
    h1, h2, h3 { font-family: Arial, Helvetica, sans-serif; margin-top: 1em; margin-bottom: 0.4em; border-bottom: 1px solid #000; padding-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { border: 1.5px solid #000; padding: 6px 8px; text-align: left; }
    th { background: #e8e8e8; }
    img { max-width: 100%; height: auto; }
  </style></head><body>${result.value || '<p>(Empty Document)</p>'}</body></html>`;
  return htmlToPngBuffers(html, workDir);
}

function colIndexToLetters(idx) {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function convertSpreadsheet(buffer, workDir) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetNames = wb.SheetNames.slice(0, 3);
  const sections = sheetNames.map((name) => {
    const sheet = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }).slice(0, 48);
    const maxCols = Math.min(12, Math.max(4, ...rows.map((r) => r.length)));
    const headCols = Array.from({ length: maxCols }, (_, c) => `<th>${colIndexToLetters(c)}</th>`).join('');
    const bodyRows = rows
      .map((r, rIdx) => {
        const cells = Array.from({ length: maxCols }, (_, c) => {
          const val = r[c] !== undefined && r[c] !== null ? String(r[c]) : '';
          const isNum = val !== '' && !Number.isNaN(Number(val));
          return `<td class="${isNum ? 'num' : ''}">${escapeHtml(val)}</td>`;
        }).join('');
        return `<tr><td class="row-num">${rIdx + 1}</td>${cells}</tr>`;
      })
      .join('');
    return `
      <section class="sheet">
        <div class="sheet-title">SHEET: ${escapeHtml(name)}</div>
        <table>
          <thead><tr><th class="corner">#</th>${headCols}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </section>
    `;
  });

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 12mm; }
    body { font-family: "Courier New", monospace; color: #000; font-size: 9.5pt; }
    .sheet { page-break-after: always; }
    .sheet:last-child { page-break-after: auto; }
    .sheet-title { font-family: Arial, sans-serif; font-weight: bold; font-size: 13pt; border: 2px solid #000; padding: 6px 10px; background: #eee; margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { border: 1px solid #000; padding: 4px 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    th { background: #e0e0e0; font-weight: bold; text-align: center; }
    td.row-num, th.corner { width: 28px; background: #eaeaea; text-align: center; font-weight: bold; }
    td.num { text-align: right; }
  </style></head><body>${sections.join('')}</body></html>`;

  return htmlToPngBuffers(html, workDir);
}

function collectPptTextAndImages(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectPptTextAndImages(item, out);
    return out;
  }
  if (node['a:t'] !== undefined) {
    out.push(String(node['a:t']));
  }
  for (const [k, v] of Object.entries(node)) {
    if (k !== 'a:t') collectPptTextAndImages(v, out);
  }
  return out;
}

function extractParagraphsFromTxBody(txBody) {
  if (!txBody) return [];
  const ps = Array.isArray(txBody['a:p']) ? txBody['a:p'] : txBody['a:p'] ? [txBody['a:p']] : [];
  return ps
    .map((p) => collectPptTextAndImages(p).join(' ').trim())
    .filter(Boolean);
}

async function convertPptx(buffer, workDir) {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

  // Read presentation slide size
  let slideW = 9144000;
  let slideH = 6858000;
  const presXml = await zip.file('ppt/presentation.xml')?.async('string');
  if (presXml) {
    const pres = parser.parse(presXml);
    const sz = pres?.['p:presentation']?.['p:sldSz'];
    if (sz?.['@_cx']) slideW = Number(sz['@_cx']);
    if (sz?.['@_cy']) slideH = Number(sz['@_cy']);
  }

  const slideFiles = Object.keys(zip.files)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)/)[1]);
      const nb = Number(b.match(/slide(\d+)/)[1]);
      return na - nb;
    })
    .slice(0, MAX_PAGES);

  const slideHtmlBlocks = [];

  for (let i = 0; i < slideFiles.length; i++) {
    const sFile = slideFiles[i];
    const xmlStr = await zip.file(sFile).async('string');
    const parsed = parser.parse(xmlStr);

    // Load rels for embedded images
    const relPath = sFile.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    const relMap = {};
    const relXml = await zip.file(relPath)?.async('string');
    if (relXml) {
      const relParsed = parser.parse(relXml);
      const rels = relParsed?.Relationships?.Relationship;
      const arr = Array.isArray(rels) ? rels : rels ? [rels] : [];
      for (const rel of arr) {
        if (rel['@_Id'] && rel['@_Target']) {
          relMap[rel['@_Id']] = rel['@_Target'];
        }
      }
    }

    const spTree = parsed?.['p:sld']?.['p:cSld']?.['p:spTree'] || {};
    const shapes = Array.isArray(spTree['p:sp']) ? spTree['p:sp'] : spTree['p:sp'] ? [spTree['p:sp']] : [];
    const pics = Array.isArray(spTree['p:pic']) ? spTree['p:pic'] : spTree['p:pic'] ? [spTree['p:pic']] : [];

    const elements = [];

    for (const sp of shapes) {
      const xfrm = sp?.['p:spPr']?.['a:xfrm'];
      const off = xfrm?.['a:off'];
      const ext = xfrm?.['a:ext'];
      const paras = extractParagraphsFromTxBody(sp?.['p:txBody']);
      if (paras.length === 0) continue;

      const xPct = off?.['@_x'] ? (Number(off['@_x']) / slideW) * 100 : 6;
      const yPct = off?.['@_y'] ? (Number(off['@_y']) / slideH) * 100 : 10 + elements.length * 14;
      const wPct = ext?.['@_cx'] ? (Number(ext['@_cx']) / slideW) * 100 : 88;
      const phType = sp?.['p:nvSpPr']?.['p:nvPr']?.['p:ph']?.['@_type'] || '';
      const isTitle = phType === 'title' || phType === 'ctrTitle';

      elements.push(
        `<div class="ppt-box ${isTitle ? 'ppt-title' : ''}" style="left:${xPct.toFixed(1)}%;top:${yPct.toFixed(1)}%;width:${Math.min(94, wPct).toFixed(1)}%;">${paras
          .map((line) => `<div>${escapeHtml(line)}</div>`)
          .join('')}</div>`
      );
    }

    for (const pic of pics) {
      const blipId = pic?.['p:blipFill']?.['a:blip']?.['@_r:embed'];
      const target = blipId ? relMap[blipId] : null;
      if (!target) continue;
      const mediaPath = path.posix.normalize(path.posix.join('ppt/slides', target));
      const mediaFile = zip.file(mediaPath);
      if (!mediaFile) continue;
      const b64 = await mediaFile.async('base64');
      const extName = path.extname(mediaPath).slice(1).toLowerCase() || 'png';
      const mime = extName === 'jpg' ? 'jpeg' : extName;
      const xfrm = pic?.['p:spPr']?.['a:xfrm'];
      const off = xfrm?.['a:off'];
      const ext = xfrm?.['a:ext'];
      const xPct = off?.['@_x'] ? (Number(off['@_x']) / slideW) * 100 : 10;
      const yPct = off?.['@_y'] ? (Number(off['@_y']) / slideH) * 100 : 25;
      const wPct = ext?.['@_cx'] ? (Number(ext['@_cx']) / slideW) * 100 : 40;
      const hPct = ext?.['@_cy'] ? (Number(ext['@_cy']) / slideH) * 100 : 40;
      elements.push(
        `<img class="ppt-img" src="data:image/${mime};base64,${b64}" style="left:${xPct.toFixed(1)}%;top:${yPct.toFixed(1)}%;width:${wPct.toFixed(1)}%;height:${hPct.toFixed(1)}%;"/>`
      );
    }

    const aspectRatio = (slideH / slideW) * 100;
    slideHtmlBlocks.push(`
      <div class="slide-wrap">
        <div class="slide-hdr">SLIDE ${i + 1} OF ${slideFiles.length}</div>
        <div class="slide-canvas" style="padding-bottom:${aspectRatio.toFixed(2)}%;">
          ${elements.join('') || '<div class="ppt-empty">(Blank Slide)</div>'}
        </div>
      </div>
    `);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 14mm; }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; margin: 0; }
    .slide-wrap { margin-bottom: 18px; page-break-inside: avoid; }
    .slide-hdr { font-family: monospace; font-size: 10pt; font-weight: bold; margin-bottom: 4px; }
    .slide-canvas { position: relative; width: 100%; border: 2.5px solid #000; background: #fff; overflow: hidden; }
    .ppt-box { position: absolute; font-size: 11pt; line-height: 1.3; word-wrap: break-word; }
    .ppt-title { font-size: 16pt; font-weight: bold; border-bottom: 1.5px solid #000; padding-bottom: 4px; }
    .ppt-img { position: absolute; object-fit: contain; }
    .ppt-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-style: italic; }
  </style></head><body>${slideHtmlBlocks.join('')}</body></html>`;

  return htmlToPngBuffers(html, workDir);
}

export async function renderMemoToPngBuffer({
  template = 'MEMORANDUM',
  from = '',
  to = '',
  subject = '',
  body = '',
  drawingDataUrl = '',
}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfax-memo-'));
  try {
    const drawingHtml =
      drawingDataUrl && drawingDataUrl.startsWith('data:image/png;base64,')
        ? `<img class="sketch" src="${drawingDataUrl}" />`
        : '';

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: A4; margin: 16mm; }
      body { font-family: "Courier New", monospace; color: #000; margin: 0; }
      .pad { border: 3px solid #000; padding: 24px; min-height: 920px; position: relative; }
      .banner { border-bottom: 4px double #000; padding-bottom: 10px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: baseline; }
      .banner h1 { margin: 0; font-family: Arial, sans-serif; font-size: 24pt; letter-spacing: 2px; }
      .meta { display: grid; grid-template-columns: 110px 1fr; row-gap: 8px; border-bottom: 2px solid #000; padding-bottom: 14px; margin-bottom: 16px; font-size: 12pt; }
      .lbl { font-weight: bold; }
      .val { border-bottom: 1px dotted #000; padding-bottom: 2px; }
      .body { white-space: pre-wrap; font-size: 13pt; line-height: 1.55; min-height: 220px; }
      .sketch { display: block; width: 100%; max-height: 520px; object-fit: contain; margin-top: 12px; border: 1.5px dashed #333; }
    </style></head><body>
      <div class="pad">
        <div class="banner">
          <h1>${escapeHtml(template)}</h1>
          <span>DESK MEMO PAD</span>
        </div>
        <div class="meta">
          <div class="lbl">TO:</div><div class="val">${escapeHtml(to || 'Recipient')}</div>
          <div class="lbl">FROM:</div><div class="val">${escapeHtml(from || 'Anonymous Sender')}</div>
          <div class="lbl">RE:</div><div class="val">${escapeHtml(subject || 'Urgent Correspondence')}</div>
        </div>
        <div class="body">${escapeHtml(body)}</div>
        ${drawingHtml}
      </div>
    </body></html>`;

    const pages = await htmlToPngBuffers(html, workDir);
    return pages[0];
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export async function renderCoverSheetToPngBuffer({
  from = '',
  to = '',
  company = '',
  subject = '',
  comments = '',
  flags = [],
  totalDocPages = 1,
}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfax-cov-'));
  try {
    const allFlags = ['URGENT', 'FOR REVIEW', 'PLEASE COMMENT', 'PLEASE REPLY', 'CONFIDENTIAL', 'RECYCLE'];
    const flagSet = new Set(flags || []);
    const checksHtml = allFlags
      .map((f) => `<div class="chk"><span class="box">${flagSet.has(f) ? 'X' : '&nbsp;'}</span> ${f}</div>`)
      .join('');

    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: A4; margin: 16mm; }
      body { font-family: Arial, Helvetica, sans-serif; color: #000; }
      .sheet { border: 4px solid #000; padding: 28px; min-height: 920px; }
      .top { border-bottom: 6px solid #000; padding-bottom: 12px; margin-bottom: 24px; }
      .top h1 { margin: 0; font-size: 30pt; letter-spacing: 3px; }
      .sub { font-family: monospace; font-size: 11pt; margin-top: 4px; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; border-bottom: 2px solid #000; padding-bottom: 18px; margin-bottom: 18px; font-size: 12pt; }
      .field label { display: block; font-size: 9pt; font-weight: bold; letter-spacing: 1px; margin-bottom: 3px; }
      .field div { border-bottom: 1.5px solid #000; padding: 4px 0; font-family: "Courier New", monospace; font-size: 13pt; font-weight: bold; }
      .checks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; border-bottom: 2px solid #000; padding-bottom: 16px; margin-bottom: 18px; font-weight: bold; font-size: 11pt; }
      .box { display: inline-block; width: 18px; height: 18px; border: 2px solid #000; text-align: center; line-height: 17px; font-family: monospace; margin-right: 6px; }
      .notes-lbl { font-weight: bold; font-size: 10pt; letter-spacing: 1px; margin-bottom: 8px; }
      .notes { font-family: "Courier New", monospace; font-size: 13pt; line-height: 1.5; white-space: pre-wrap; border: 1.5px dashed #000; padding: 14px; min-height: 360px; }
    </style></head><body>
      <div class="sheet">
        <div class="top">
          <h1>FACSIMILE COVER SHEET</h1>
          <div class="sub">TRANSMITTED VIA ITU-T T.38 UDPTL PROTOCOL</div>
        </div>
        <div class="grid">
          <div class="field"><label>TO:</label><div>${escapeHtml(to || 'Recipient')}</div></div>
          <div class="field"><label>FROM:</label><div>${escapeHtml(from || 'Sender')}</div></div>
          <div class="field"><label>ORGANIZATION:</label><div>${escapeHtml(company || 'RetroFax Corp.')}</div></div>
          <div class="field"><label>PAGES (INCLUDING COVER):</label><div>${totalDocPages + 1}</div></div>
          <div class="field" style="grid-column:span 2"><label>SUBJECT / RE:</label><div>${escapeHtml(subject || 'Please see attached transmission')}</div></div>
        </div>
        <div class="checks">${checksHtml}</div>
        <div class="notes-lbl">COMMENTS / MEMO:</div>
        <div class="notes">${escapeHtml(comments || 'Sent over genuine T.38 Fax-over-IP.')}</div>
      </div>
    </body></html>`;

    const pages = await htmlToPngBuffers(html, workDir);
    return pages[0];
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Convert an uploaded file buffer into an array of PNG page buffers (max 4 pages).
 */
export async function convertDocumentToPageImages(buffer, originalName = '', mimeType = '') {
  const ext = path.extname(originalName).toLowerCase();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfax-doc-'));

  try {
    // 1. PDF
    if (ext === '.pdf' || mimeType === 'application/pdf') {
      const pdfPath = path.join(workDir, 'input.pdf');
      fs.writeFileSync(pdfPath, buffer);
      return await pdfToPngBuffers(pdfPath, workDir);
    }

    // 2. Microsoft Word (.docx)
    if (
      ext === '.docx' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      return await convertDocx(buffer, workDir);
    }

    // 3. Spreadsheets (.xlsx / .xls / .csv)
    if (
      ['.xlsx', '.xls', '.csv'].includes(ext) ||
      mimeType.includes('spreadsheetml') ||
      mimeType === 'text/csv'
    ) {
      return await convertSpreadsheet(buffer, workDir);
    }

    // 4. PowerPoint (.pptx)
    if (
      ext === '.pptx' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ) {
      return await convertPptx(buffer, workDir);
    }

    // 5. Plain text / markdown
    if (['.txt', '.md', '.log', '.json'].includes(ext) || mimeType.startsWith('text/')) {
      const text = buffer.toString('utf8').slice(0, 12000);
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        @page { size: A4; margin: 16mm; }
        body { font-family: "Courier New", monospace; font-size: 11pt; line-height: 1.45; white-space: pre-wrap; color: #000; }
      </style></head><body>${escapeHtml(text)}</body></html>`;
      return await htmlToPngBuffers(html, workDir);
    }

    // 6. Standard image formats (PNG, JPG, WebP, GIF, BMP, TIFF, SVG, ICO, AVIF)
    try {
      const pngBuf = await sharp(buffer, { animated: false })
        .rotate()
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer();
      return [pngBuf];
    } catch {
      const extMimeMap = {
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.avif': 'image/avif',
      };
      const resolvedMime = (mimeType && mimeType.startsWith('image/')) ? mimeType : (extMimeMap[ext] || 'image/png');
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        @page { size: A4; margin: 12mm; }
        body { margin: 0; display: flex; align-items: flex-start; justify-content: center; background: #fff; }
        img { max-width: 100%; max-height: 265mm; object-fit: contain; }
      </style></head><body><img src="data:${resolvedMime};base64,${buffer.toString('base64')}" /></body></html>`;
      return await htmlToPngBuffers(html, workDir);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
