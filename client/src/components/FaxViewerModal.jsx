import React, { useState } from 'react';
import { Download, FileCheck2, ShieldBan, X, Terminal } from 'lucide-react';

export default function FaxViewerModal({
  fax,
  mode = 'received', // 'received' | 'sent_receipt'
  onClose,
  onBlockSender,
}) {
  const [activeTab, setActiveTab] = useState(mode === 'sent_receipt' ? 'report' : 'pages');
  const [blocked, setBlocked] = useState(false);

  if (!fax) return null;

  const report = fax.report || {};
  const previewUrls = fax.previewUrls || [];

  const handleBlock = async () => {
    await onBlockSender?.(fax.fromNumber);
    setBlocked(true);
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="viewer-title">
      <div className="retro-modal viewer-modal">
        <div className="modal-header">
          <div>
            <span className="modal-kicker">
              {mode === 'sent_receipt' ? 'T.38 TRANSMISSION VERIFICATION' : 'RECEIVED THERMAL ROLL OUTPUT'}
            </span>
            <h2 id="viewer-title">
              {mode === 'sent_receipt'
                ? `Fax Sent to ${report.toNumber || fax.toNumber}`
                : `Fax from ${fax.fromName || fax.fromNumber}`}
            </h2>
          </div>
          <button id="btn-close-viewer" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="modal-tabs">
          <button
            className={`tab-btn ${activeTab === 'pages' ? 'active' : ''}`}
            onClick={() => setActiveTab('pages')}
          >
            Thermal Pages ({previewUrls.length})
          </button>
          <button
            className={`tab-btn ${activeTab === 'report' ? 'active' : ''}`}
            onClick={() => setActiveTab('report')}
          >
            <FileCheck2 size={15} /> Verification Report
          </button>
          <button
            className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
            onClick={() => setActiveTab('logs')}
          >
            <Terminal size={15} /> T.38 Wire Log ({(fax.logs || []).length})
          </button>
        </div>

        <div className="modal-body">
          {activeTab === 'pages' && (
            <div className="thermal-scroll">
              {previewUrls.map((url, idx) => (
                <div key={url} className="thermal-sheet">
                  <div className="thermal-sheet-tag">
                    PAGE {idx + 1} / {previewUrls.length} • DECODED FROM T.38 UDPTL T.4 MH
                  </div>
                  <img src={url} alt={`Faxed page ${idx + 1}`} />
                </div>
              ))}
            </div>
          )}

          {activeTab === 'report' && (
            <div className="verification-slip">
              <div className="slip-header">
                <h3>TRANSMISSION VERIFICATION REPORT</h3>
                <span>ITU-T T.38 FACSIMILE OVER IP</span>
              </div>
              <pre className="slip-pre">
{`STATUS       : ${report.status || 'OK (MCF Confirmed)'}
PROTOCOL     : ${report.protocol || 'ITU-T T.38 UDPTL / SIP SDP'}
MODULATION   : ${report.modulation || 'V.17 14400 bps'}
IMAGE CODING : ${report.coding || 'T.4 1D Modified Huffman (1728px)'}
RESOLUTION   : ${report.resolution || (fax.fine ? 'FINE (204x196 dpi)' : 'STANDARD (204x98 dpi)')}
CALLER (TSI) : ${report.fromNumber || fax.fromNumber}
CALLED (CSI) : ${report.toNumber || fax.toNumber}
SIP CALL-ID  : ${report.callId || 'N/A'}
UDP PORTS    : ${report.senderPort || '—'} -> ${report.receiverPort || '—'} (127.0.0.1 UDPTL)
PAGES        : ${report.pages || previewUrls.length}
T.4 BYTES    : ${report.t4Bytes || '—'} bytes
UDPTL PKTS   : ${report.udptlPackets || '—'} packets (${report.udptlBytes || '—'} bytes w/ redundancy)
LINE ERRORS  : ${report.scanlineErrors ?? 0} scanline resyncs
DURATION     : ${report.durationMs ? `${(report.durationMs / 1000).toFixed(2)} sec` : '—'}`}
              </pre>
            </div>
          )}

          {activeTab === 'logs' && (
            <div className="wire-log-box">
              {(fax.logs || []).map((entry, idx) => (
                <div key={idx} className={`wire-line layer-${entry.layer?.toLowerCase()}`}>
                  <span className="w-ts">+{String(entry.ts).padStart(4, '0')}ms</span>
                  <span className="w-layer">{entry.layer}</span>
                  <span className="w-dir">{entry.direction}</span>
                  <span className="w-msg">{entry.summary}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-footer viewer-footer">
          <div className="download-group">
            {previewUrls[0] && (
              <a className="btn-secondary" href={previewUrls[0]} download={`retrofax-page1.png`}>
                <Download size={14} /> Thermal PNG
              </a>
            )}
            {fax.tiffUrl && (
              <a className="btn-secondary" href={fax.tiffUrl} download>
                <Download size={14} /> Group 3 .TIF
              </a>
            )}
            {fax.pcapUrl && (
              <a id="btn-download-pcap" className="btn-secondary" href={fax.pcapUrl} download>
                <Download size={14} /> Wireshark .PCAP
              </a>
            )}
          </div>

          <div className="action-group">
            {mode === 'received' && fax.fromNumber && !fax.fromNumber.includes('010-0000') && (
              <button
                type="button"
                className="btn-danger"
                disabled={blocked}
                onClick={handleBlock}
              >
                <ShieldBan size={14} /> {blocked ? 'Sender Blocked' : 'Shred & Block Sender'}
              </button>
            )}
            <button type="button" className="btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
