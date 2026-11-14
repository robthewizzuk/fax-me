import React, { useEffect, useRef } from 'react';
import { Terminal, ChevronDown, ChevronUp, Trash2 } from 'lucide-react';

const CODEC_META = {
  G711U: { label: 'G.711u (PCMU PT=0)', rate: '64 kbps 8kHz' },
  G711A: { label: 'G.711a (PCMA PT=8)', rate: '64 kbps 8kHz' },
  G722: { label: 'G.722 (SB-ADPCM PT=9)', rate: '64 kbps 16kHz' },
  G729: { label: 'G.729A (CS-ACELP PT=18)', rate: '8 kbps 8kHz' },
};

export default function T38Inspector({ open, logs, mode = 't38', sipCodec = 'G711U', onToggle, onClear }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length, open]);

  const codecInfo = CODEC_META[sipCodec] || CODEC_META.G711U;
  const isVoiceMode = mode === 'sip';

  return (
    <div className={`t38-drawer win95-window ${open ? 'open' : 'closed'}`}>
      <div className="win95-titlebar t38-drawer-header">
        <button id="btn-toggle-t38-inspector" className="t38-toggle" onClick={onToggle}>
          <Terminal size={13} />
          <span>T38MON.EXE — T.38 / SIP+RTP WIRE LOG</span>
          <span className="t38-count">{logs.length} pkts</span>
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        {open && logs.length > 0 && (
          <button className="t38-clear win95-btn" onClick={onClear} title="Clear live log">
            <Trash2 size={12} /> CLR
          </button>
        )}
      </div>

      {open && (
        <>
          <div className="t38-drawer-body crt-screen" ref={scrollRef}>
            {logs.length === 0 ? (
              <div className="t38-empty">
                READY &gt; Click Top Tray for T.38 Fax OR Click Handset for SIP Voice Call (G.711u / G.711a / G.722 / G.729). Live SIP, UDPTL &amp; RTP packets trace here.
              </div>
            ) : (
              logs.map((entry, idx) => (
                <div key={idx} className={`wire-line layer-${entry.layer?.toLowerCase()}`}>
                  <span className="w-ts">+{String(entry.ts).padStart(4, '0')}ms</span>
                  <span className="w-layer">{entry.layer}</span>
                  <span className="w-dir">{entry.direction}</span>
                  <span className="w-msg">{entry.summary}</span>
                </div>
              ))
            )}
          </div>
          <div className="win95-statusbar">
            <span>{isVoiceMode ? 'PROTO: SIP / RTP' : 'PROTO: T.38 / SIP'}</span>
            <span>{isVoiceMode ? `CODEC: ${codecInfo.label}` : `FAX: T.4 MH | ${codecInfo.label.split(' ')[0]}`}</span>
            <span>{isVoiceMode ? codecInfo.rate : 'V.17 14400 BPS'}</span>
          </div>
        </>
      )}
    </div>
  );
}
