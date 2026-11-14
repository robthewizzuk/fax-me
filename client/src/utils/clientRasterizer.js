/**
 * Browser Canvas rasterizer fallback for Cloudflare Workers edge mode
 * where Sharp / Poppler / Headless Chromium are not available server-side.
 */

export async function rasterizeFileOnClient(file) {
  const name = String(file?.name || 'document');
  const ext = name.split('.').pop()?.toLowerCase() || '';

  // 1. Standard raster images & SVG natively decoded by browser <img> + <canvas>
  if (file.type?.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'].includes(ext)) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error(`Could not decode image "${name}" in browser`));
        el.src = url;
      });
      const targetW = 1200;
      const scale = Math.min(1.5, targetW / Math.max(1, img.naturalWidth || 800));
      const w = Math.max(400, Math.round((img.naturalWidth || 800) * scale));
      const h = Math.max(300, Math.round((img.naturalHeight || 600) * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      return [c.toDataURL('image/png')];
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // 2. Plain text / CSV / Markdown
  if (file.type?.startsWith('text/') || ['txt', 'csv', 'log', 'md', 'json'].includes(ext)) {
    const text = await file.text();
    return [renderPlainTextToCanvasPng(name, text)];
  }

  throw new Error(
    `Format ".${ext}" requires the Node.js conversion server; on Cloudflare Edge please upload images (.png/.jpg/.bmp/.svg), .txt/.csv, or use Draw & Type Memo.`
  );
}

export function renderMemoOnClient({
  template = 'MEMORANDUM',
  from = '',
  to = '',
  subject = '',
  body = '',
  drawingDataUrl = '',
}) {
  const w = 1100;
  const h = 1420;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.strokeRect(48, 48, w - 96, h - 96);

  ctx.fillStyle = '#000000';
  ctx.font = 'bold 42px "Courier New", monospace';
  ctx.fillText(String(template || 'MEMORANDUM').toUpperCase(), 76, 122);

  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(76, 146);
  ctx.lineTo(w - 76, 146);
  ctx.stroke();

  ctx.font = 'bold 24px "Courier New", monospace';
  ctx.fillText(`TO     : ${String(to || 'RECIPIENT').slice(0, 48)}`, 76, 200);
  ctx.fillText(`FROM   : ${String(from || 'SENDER').slice(0, 48)}`, 76, 240);
  ctx.fillText(`SUBJECT: ${String(subject || 'INTEROFFICE FAX').slice(0, 48)}`, 76, 280);

  ctx.beginPath();
  ctx.moveTo(76, 306);
  ctx.lineTo(w - 76, 306);
  ctx.stroke();

  let y = 356;
  ctx.font = '24px "Courier New", monospace';
  const lines = String(body || '').split('\n');
  for (const rawLine of lines) {
    const words = rawLine.split(' ');
    let cur = '';
    for (const word of words) {
      const next = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(next).width > w - 160) {
        ctx.fillText(cur, 76, y);
        y += 34;
        cur = word;
      } else {
        cur = next;
      }
      if (y > 900) break;
    }
    if (cur && y <= 900) {
      ctx.fillText(cur, 76, y);
      y += 34;
    }
    if (y > 900) break;
  }

  return new Promise((resolve) => {
    if (!drawingDataUrl) return resolve(c.toDataURL('image/png'));
    const img = new Image();
    img.onload = () => {
      const boxY = Math.max(y + 24, 620);
      const boxH = Math.min(680, h - boxY - 80);
      ctx.strokeRect(76, boxY, w - 152, boxH);
      ctx.drawImage(img, 80, boxY + 4, w - 160, boxH - 8);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => resolve(c.toDataURL('image/png'));
    img.src = drawingDataUrl;
  });
}

function renderPlainTextToCanvasPng(title, text) {
  const w = 1100;
  const h = 1400;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 26px "Courier New", monospace';
  ctx.fillText(`FILE: ${title.slice(0, 56)}`, 54, 70);
  ctx.fillRect(54, 88, w - 108, 3);

  ctx.font = '20px "Courier New", monospace';
  let y = 132;
  for (const line of String(text || '').split('\n').slice(0, 38)) {
    ctx.fillText(line.slice(0, 78), 54, y);
    y += 31;
  }
  return c.toDataURL('image/png');
}
