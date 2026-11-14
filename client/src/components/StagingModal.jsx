import React, { useEffect, useRef, useState } from 'react';
import { FileUp, PenTool, FileSpreadsheet, AlertTriangle, X, Eraser } from 'lucide-react';
import { rasterizeFileOnClient, renderMemoOnClient } from '../utils/clientRasterizer.js';

const COVER_FLAGS = ['URGENT', 'FOR REVIEW', 'PLEASE COMMENT', 'PLEASE REPLY', 'CONFIDENTIAL', 'RECYCLE'];

export default function StagingModal({
  open,
  initialTab = 'upload',
  session,
  dialNumber,
  fine,
  stormyLine,
  coverEnabled,
  serverConversion = true,
  onSetFine,
  onSetStormyLine,
  onSetCoverEnabled,
  onClose,
  onStagedSuccess,
}) {
  const [tab, setTab] = useState(initialTab);
  const [selectedFile, setSelectedFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Quick Memo State
  const [memoTemplate, setMemoTemplate] = useState('MEMORANDUM');
  const [memoTo, setMemoTo] = useState('');
  const [memoFrom, setMemoFrom] = useState(session?.displayName || '');
  const [memoSubject, setMemoSubject] = useState('');
  const [memoBody, setMemoBody] = useState('');
  const [penSize, setPenSize] = useState(3);
  const [hasDrawing, setHasDrawing] = useState(false);

  // Cover Sheet State
  const [covCompany, setCovCompany] = useState('Dunder & Beige Systems');
  const [covTo, setCovTo] = useState('');
  const [covSubject, setCovSubject] = useState('');
  const [covComments, setCovComments] = useState('');
  const [covFlags, setCovFlags] = useState(['URGENT', 'FOR REVIEW']);

  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab, open]);

  useEffect(() => {
    if (session?.displayName && !memoFrom) {
      setMemoFrom(session.displayName);
    }
  }, [session?.displayName]);

  useEffect(() => {
    if (open && tab === 'memo' && canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d');
      if (!hasDrawing) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    }
  }, [open, tab]);

  if (!open) return null;

  const getCanvasPoint = (e) => {
    const c = canvasRef.current;
    const rect = c.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: ((clientX - rect.left) / rect.width) * c.width,
      y: ((clientY - rect.top) / rect.height) * c.height,
    };
  };

  const startDraw = (e) => {
    drawingRef.current = true;
    setHasDrawing(true);
    const ctx = canvasRef.current.getContext('2d');
    const pt = getCanvasPoint(e);
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = penSize;
  };

  const moveDraw = (e) => {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    const pt = getCanvasPoint(e);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
  };

  const endDraw = () => {
    drawingRef.current = false;
  };

  const clearCanvas = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    setHasDrawing(false);
  };

  const toggleFlag = (f) => {
    setCovFlags((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]));
  };

  const handleStage = async (fileOverride = null) => {
    setError('');
    setLoading(true);
    try {
      const coverPayload = {
        enabled: coverEnabled,
        to: covTo || dialNumber || 'Recipient',
        from: memoFrom || session?.displayName || session?.displayNumber,
        company: covCompany,
        subject: covSubject,
        comments: covComments,
        flags: covFlags,
      };

      let res;
      const targetFile = fileOverride || selectedFile;

      if (tab === 'upload' || fileOverride) {
        if (!targetFile) {
          setError('Choose or drop a file first.');
          setLoading(false);
          return;
        }
        if (serverConversion) {
          const form = new FormData();
          form.append('file', targetFile);
          form.append('coverSheet', JSON.stringify(coverPayload));
          res = await fetch('/api/stage', { method: 'POST', body: form });
        } else {
          const pages = await rasterizeFileOnClient(targetFile);
          res = await fetch('/api/stage/pages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pages,
              sourceLabel: targetFile.name,
              coverSheet: coverPayload,
            }),
          });
        }
      } else {
        if (!memoBody.trim() && !hasDrawing && !memoSubject.trim()) {
          setError('Type a memo note or draw a doodle first.');
          setLoading(false);
          return;
        }
        const drawingDataUrl =
          hasDrawing && canvasRef.current ? canvasRef.current.toDataURL('image/png') : '';
        if (serverConversion) {
          res = await fetch('/api/stage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              memo: {
                template: memoTemplate,
                to: memoTo || dialNumber,
                from: memoFrom || session?.displayName || session?.displayNumber,
                subject: memoSubject,
                body: memoBody,
                drawingDataUrl,
              },
              coverSheet: coverPayload,
            }),
          });
        } else {
          const pngDataUrl = await renderMemoOnClient({
            template: memoTemplate,
            to: memoTo || dialNumber,
            from: memoFrom || session?.displayName || session?.displayNumber,
            subject: memoSubject,
            body: memoBody,
            drawingDataUrl,
          });
          res = await fetch('/api/stage/pages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pages: [pngDataUrl],
              sourceLabel: memoSubject ? `Memo: ${memoSubject}` : 'Desk Memo',
              coverSheet: coverPayload,
            }),
          });
        }
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to feed paper');
      }
      if (fileInputRef.current) fileInputRef.current.value = '';
      onStagedSuccess(data);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fillBlackInk = () => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, c.width, c.height);
    setHasDrawing(true);
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="staging-title">
      <div className="retro-modal staging-modal">
        <div className="modal-header">
          <div className="win95-title-group">
            <span className="modal-kicker">FEEDER.EXE</span>
            <h2 id="staging-title">Top Input Tray — Choose Draw / Type or Upload</h2>
          </div>
          <button id="btn-close-staging" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className="modal-tabs">
          <button
            id="tab-stage-upload"
            className={`tab-btn ${tab === 'upload' ? 'active' : ''}`}
            onClick={() => setTab('upload')}
          >
            <FileUp size={15} /> Upload Image or Document
          </button>
          <button
            id="tab-stage-memo"
            className={`tab-btn ${tab === 'memo' ? 'active' : ''}`}
            onClick={() => setTab('memo')}
          >
            <PenTool size={15} /> Draw & Type Quick Memo
          </button>
        </div>

        <div className="modal-body">
          {tab === 'upload' ? (
            <div className="upload-pane">
              <div
                className="dropzone"
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer?.files?.[0];
                  if (f) {
                    setSelectedFile(f);
                    handleStage(f);
                  }
                }}
              >
                <FileSpreadsheet size={32} />
                <strong>
                  {loading
                    ? `Converting & feeding "${selectedFile?.name || 'file'}"...`
                    : selectedFile
                      ? selectedFile.name
                      : 'Click to browse or drop document here'}
                </strong>
                <span>
                  Supports PNG, JPG, WebP, GIF, BMP, SVG, PDF, Word (.docx), Excel (.xlsx/.csv), PowerPoint (.pptx), TXT
                  (max 4 pages, 12MB)
                </span>
              </div>
              <input
                ref={fileInputRef}
                id="fax-file-input"
                type="file"
                className="sr-file-input"
                accept="image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp,.svg,.pdf,.docx,.xlsx,.xls,.csv,.pptx,.txt,.md,.json,.log"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setSelectedFile(f);
                    handleStage(f);
                  }
                }}
              />
            </div>
          ) : (
            <div className="memo-pane">
              <div className="form-row-3">
                <label>
                  Pad Header
                  <select value={memoTemplate} onChange={(e) => setMemoTemplate(e.target.value)}>
                    <option value="MEMORANDUM">MEMORANDUM</option>
                    <option value="URGENT FAX">URGENT FAX</option>
                    <option value="WHILE YOU WERE OUT">WHILE YOU WERE OUT</option>
                  </select>
                </label>
                <label>
                  To
                  <input
                    id="memo-to-input"
                    type="text"
                    placeholder={dialNumber || 'Recipient'}
                    value={memoTo}
                    onChange={(e) => setMemoTo(e.target.value)}
                  />
                </label>
                <label>
                  From
                  <input
                    id="memo-from-input"
                    type="text"
                    placeholder={session?.displayNumber || 'Your Name'}
                    value={memoFrom}
                    onChange={(e) => setMemoFrom(e.target.value)}
                  />
                </label>
              </div>
              <label>
                Subject / RE
                <input
                  id="memo-subject-input"
                  type="text"
                  placeholder="RE: TPS Report Cover Sheet..."
                  value={memoSubject}
                  onChange={(e) => setMemoSubject(e.target.value)}
                />
              </label>
              <label>
                Typed Message
                <textarea
                  id="memo-body-input"
                  rows={4}
                  placeholder="Write your 1994 fax message here..."
                  value={memoBody}
                  onChange={(e) => setMemoBody(e.target.value)}
                />
              </label>
              <div className="sketch-box">
                <div className="sketch-toolbar">
                  <span>Freehand Doodle / Signature Sketchpad</span>
                  <div className="sketch-controls">
                    <label className="inline-range">
                      Pen
                      <input
                        type="range"
                        min={2}
                        max={8}
                        value={penSize}
                        onChange={(e) => setPenSize(Number(e.target.value))}
                      />
                    </label>
                    <button id="btn-fill-black" type="button" className="mini-btn" onClick={fillBlackInk} title="Fill ink black for full black page test">
                      Fill Black
                    </button>
                    <button type="button" className="mini-btn" onClick={clearCanvas}>
                      <Eraser size={13} /> Clear Ink
                    </button>
                  </div>
                </div>
                <canvas
                  ref={canvasRef}
                  width={560}
                  height={190}
                  className="sketch-canvas"
                  onMouseDown={startDraw}
                  onMouseMove={moveDraw}
                  onMouseUp={endDraw}
                  onMouseLeave={endDraw}
                  onTouchStart={startDraw}
                  onTouchMove={moveDraw}
                  onTouchEnd={endDraw}
                />
              </div>
            </div>
          )}

          {/* Read-only 1990s hardware panel mirror (toggles live directly on the 3D machine) */}
          <div className="hw-status-strip">
            <span className="hw-label">MACHINE PANEL SWITCHES:</span>
            <span className={`hw-pill ${fine ? 'on' : ''}`}>FINE (204×196): {fine ? 'ON' : 'STD'}</span>
            <span className={`hw-pill ${coverEnabled ? 'on' : ''}`}>90s COVER SHEET: {coverEnabled ? 'ON' : 'OFF'}</span>
            <span className={`hw-pill ${stormyLine ? 'warn' : ''}`}>LINE STATIC: {stormyLine ? 'ON' : 'OFF'}</span>
            <small className="hw-tip">(Toggle switches directly on the 3D fax machine console)</small>
          </div>

          {coverEnabled && (
            <div className="cover-builder">
              <div className="cover-flags">
                {COVER_FLAGS.map((flag) => (
                  <button
                    type="button"
                    key={flag}
                    className={`flag-chip ${covFlags.includes(flag) ? 'selected' : ''}`}
                    onClick={() => toggleFlag(flag)}
                  >
                    [{covFlags.includes(flag) ? 'X' : ' '}] {flag}
                  </button>
                ))}
              </div>
              <div className="form-row-2">
                <label>
                  Cover Organization
                  <input
                    type="text"
                    value={covCompany}
                    onChange={(e) => setCovCompany(e.target.value)}
                  />
                </label>
                <label>
                  Cover Subject
                  <input
                    type="text"
                    placeholder="See attached facsimile"
                    value={covSubject}
                    onChange={(e) => setCovSubject(e.target.value)}
                  />
                </label>
              </div>
              <label>
                Cover Comments
                <input
                  type="text"
                  placeholder="Please sign and fax back immediately!"
                  value={covComments}
                  onChange={(e) => setCovComments(e.target.value)}
                />
              </label>
            </div>
          )}

          {error && (
            <div className="error-banner">
              <AlertTriangle size={16} /> {error}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            id="btn-load-paper-submit"
            type="button"
            className="btn-primary"
            disabled={loading}
            onClick={() => handleStage()}
          >
            {loading ? 'Converting & Dithering...' : 'Feed Paper into Tray'}
          </button>
        </div>
      </div>
    </div>
  );
}
