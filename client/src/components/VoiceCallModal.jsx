import React, { useEffect, useRef, useState } from 'react';
import {
  Phone,
  PhoneOff,
  PhoneIncoming,
  Mic,
  MicOff,
  Square,
  Upload,
  Volume2,
  Download,
  FileCheck2,
  Terminal,
  History,
  X,
  AlertTriangle,
  Radio,
} from 'lucide-react';

const CODEC_OPTIONS = [
  {
    id: 'G711U',
    title: 'G.711 PCMU (μ-law)',
    pt: 'PT=0',
    spec: '64 kbps • 8 kHz • N.America/Japan PSTN',
  },
  {
    id: 'G711A',
    title: 'G.711 PCMA (A-law)',
    pt: 'PT=8',
    spec: '64 kbps • 8 kHz • European E1 PSTN',
  },
  {
    id: 'G722',
    title: 'G.722 SB-ADPCM',
    pt: 'PT=9',
    spec: '64 kbps • 16 kHz Wideband (RFC 3551)',
  },
  {
    id: 'G729',
    title: 'G.729A CS-ACELP',
    pt: 'PT=18',
    spec: '8 kbps • 8 kHz • 20B / 20ms VoIP',
  },
];

const SYNTH_PRESETS = [
  'HELLO FROM 1994 RETROFAX',
  'PC LOAD LETTER TEST 1994',
  'HOLD FOR T.38 FAX CARRIER',
  'MEETING AT CUBICLE 4B NOW',
];

function formatCallDuration(ms = 0) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export default function VoiceCallModal({
  open,
  initialTab = 'dial',
  session,
  directory = [],
  dialNumber,
  onChangeDialNumber,
  sipCodec = 'G711U',
  onChangeSipCodec,
  stormyLine = false,
  onSetStormyLine,
  muted = false,
  callState,
  liveCall = null,
  liveVu = { tx: 0, rx: 0 },
  micMuted = false,
  onToggleMicMute,
  onSendLivePhrase,
  onAnswerLiveCall,
  onDeclineLiveCall,
  onHangupLiveCall,
  activeCallResult,
  onSelectCallResult,
  callsInbox = [],
  onPlaceCall,
  onHangup,
  onClose,
}) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [sourceMode, setSourceMode] = useState('synth'); // 'synth' | 'mic' | 'upload'
  const [ttsText, setTtsText] = useState('HELLO FROM 1994 RETROFAX');
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadedPreviewUrl, setUploadedPreviewUrl] = useState('');
  const [recording, setRecording] = useState(false);
  const [recordedFile, setRecordedFile] = useState(null);
  const [recordedPreviewUrl, setRecordedPreviewUrl] = useState('');
  const [localError, setLocalError] = useState('');
  const [showWireInResult, setShowWireInResult] = useState(false);

  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const chunksRef = useRef([]);
  const seenResultIdRef = useRef(null);

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab || 'dial');
      setLocalError('');
    }
  }, [open, initialTab]);

  // Switch automatically to the result tab when a new outbound/selected call completes
  useEffect(() => {
    const rid = activeCallResult?.callId || activeCallResult?.id || null;
    if (open && rid && rid !== seenResultIdRef.current) {
      seenResultIdRef.current = rid;
      setActiveTab('result');
      setShowWireInResult(false);
    }
  }, [open, activeCallResult]);

  // Clean up object URLs and mic stream on unmount
  useEffect(() => {
    return () => {
      if (recordedPreviewUrl) URL.revokeObjectURL(recordedPreviewUrl);
      if (uploadedPreviewUrl) URL.revokeObjectURL(uploadedPreviewUrl);
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [recordedPreviewUrl, uploadedPreviewUrl]);

  if (!open) return null;

  const stopMicStream = () => {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
  };

  const handleStartRecord = async () => {
    setLocalError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Browser microphone API unavailable — use Synth Voice or Upload Audio.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      mr.onstop = () => {
        stopMicStream();
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        const ext = (mr.mimeType || '').includes('ogg') ? 'ogg' : 'webm';
        const file = new File([blob], `handset-mic.${ext}`, { type: blob.type });
        if (recordedPreviewUrl) URL.revokeObjectURL(recordedPreviewUrl);
        setRecordedFile(file);
        setRecordedPreviewUrl(URL.createObjectURL(blob));
        setRecording(false);
      };

      mr.start();
      setRecording(true);
    } catch (err) {
      stopMicStream();
      setRecording(false);
      setLocalError(err.message || 'Could not access microphone — try Synth Voice or Upload Audio.');
    }
  };

  const handleStopRecord = () => {
    try {
      mediaRecorderRef.current?.stop();
    } catch {
      stopMicStream();
      setRecording(false);
    }
  };

  const handleFileChange = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setLocalError('');
    if (uploadedPreviewUrl) URL.revokeObjectURL(uploadedPreviewUrl);
    setUploadedFile(f);
    setUploadedPreviewUrl(URL.createObjectURL(f));
  };

  const handleDialSubmit = async (e) => {
    e.preventDefault();
    setLocalError('');
    if (!String(dialNumber || '').trim()) {
      setLocalError('Please enter a target SIP / fax number to call.');
      return;
    }
    if (sourceMode === 'mic' && !recordedFile) {
      setLocalError('Record your microphone clip first, or switch to Synth Voice.');
      return;
    }
    if (sourceMode === 'upload' && !uploadedFile) {
      setLocalError('Choose a .wav / .mp3 / .ogg / .webm audio file first.');
      return;
    }

    const audioFile =
      sourceMode === 'mic' ? recordedFile : sourceMode === 'upload' ? uploadedFile : null;

    await onPlaceCall({
      toNumber: dialNumber,
      codec: sipCodec,
      ttsText: ttsText || 'HELLO FROM 1994 RETROFAX',
      audioFile,
      stormyLine,
    });
  };

  const report = activeCallResult?.report || {};
  const quickTargets = directory.slice(0, 4);
  const selectedCodecMeta = CODEC_OPTIONS.find((c) => c.id === sipCodec) || CODEC_OPTIONS[0];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="voice-modal-title">
      <div className="retro-modal voice-modal">
        <div className="modal-header">
          <div>
            <span className="modal-kicker">SIP/SDP + RFC 3550 REAL UDP VOICE GATEWAY</span>
            <h2 id="voice-modal-title">Handset SIP Voice Call ({selectedCodecMeta.title})</h2>
          </div>
          <button id="btn-close-voice-modal" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="modal-tabs">
          <button
            id="tab-voice-dial"
            type="button"
            className={`tab-btn ${activeTab === 'dial' ? 'active' : ''}`}
            onClick={() => setActiveTab('dial')}
          >
            <Phone size={14} /> Place SIP Call
          </button>
          <button
            id="tab-voice-result"
            type="button"
            className={`tab-btn ${activeTab === 'result' ? 'active' : ''}`}
            onClick={() => setActiveTab('result')}
            disabled={!activeCallResult}
          >
            <Volume2 size={14} /> Audio &amp; .PCAP {activeCallResult ? '●' : ''}
          </button>
          <button
            id="tab-voice-history"
            type="button"
            className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            <History size={14} /> Call Log / VM ({callsInbox.length})
          </button>
        </div>

        {activeTab === 'dial' && liveCall && liveCall.state !== 'IDLE' && (
          <div className="modal-body">
            <div className="live-call-panel">
              <div className="live-call-header">
                <span className={`live-pill ${liveCall.state === 'ACTIVE' ? 'active' : 'ringing'}`}>
                  {liveCall.state === 'INCOMING'
                    ? 'INCOMING LIVE CALL'
                    : liveCall.state === 'RINGING'
                    ? 'RINGING REMOTE HANDSET...'
                    : 'LIVE DUPLEX VOICE ACTIVE'}
                </span>
                <strong>{formatCallDuration(liveCall.durationMs)}</strong>
              </div>

              <div className="live-peer-card">
                <div className="live-peer-name">{liveCall.peerName || 'Online Station'}</div>
                <div className="live-peer-num">{liveCall.peerNumber}</div>
                <div className="live-peer-meta">
                  Codec: <strong>{liveCall.codec}</strong> ({(CODEC_OPTIONS.find((c) => c.id === liveCall.codec) || selectedCodecMeta).pt}) • SIP Call-ID:{' '}
                  {(liveCall.sipCallId || '').slice(0, 12)}
                </div>
              </div>

              {liveCall.state === 'ACTIVE' && (
                <>
                  <div className="vu-grid">
                    <div className="vu-card">
                      <div className="vu-lbl">
                        <span>YOUR MIC (TX RTP)</span>
                        <span>{liveCall.txPackets || 0} pkts</span>
                      </div>
                      <div className="vu-track">
                        <div className="vu-fill tx" style={{ width: `${Math.round((liveVu?.tx || 0) * 100)}%` }} />
                      </div>
                    </div>
                    <div className="vu-card">
                      <div className="vu-lbl">
                        <span>PEER AUDIO (RX RTP)</span>
                        <span>{liveCall.rxPackets || 0} pkts</span>
                      </div>
                      <div className="vu-track">
                        <div className="vu-fill rx" style={{ width: `${Math.round((liveVu?.rx || 0) * 100)}%` }} />
                      </div>
                    </div>
                  </div>

                  {!liveCall.micAvailable && (
                    <div className="geo-note" style={{ fontWeight: 700 }}>
                      Microphone note: {liveCall.micError || 'No mic detected — you can still listen live and send 90s Voice Phrases below.'}
                    </div>
                  )}

                  <div className="voice-box">
                    <div className="mini-kicker">LIVE CALL CONTROLS &amp; AUDIO FEED</div>
                    <div className="source-mode-row" style={{ alignItems: 'center' }}>
                      <button
                        id="btn-live-mute-mic"
                        type="button"
                        className={`flag-chip ${micMuted ? 'selected' : ''}`}
                        onClick={onToggleMicMute}
                      >
                        {micMuted ? <><MicOff size={13} /> Mic Muted</> : <><Mic size={13} /> Mic Live</>}
                      </button>
                      <button
                        type="button"
                        className={`flag-chip ${stormyLine ? 'selected' : ''}`}
                        onClick={() => onSetStormyLine?.(!stormyLine)}
                      >
                        {stormyLine ? 'Line Static: ON' : 'Line Static: OFF'}
                      </button>
                      <button
                        id="btn-live-send-phrase"
                        type="button"
                        className="flag-chip"
                        onClick={() => onSendLivePhrase?.(ttsText || 'HELLO FROM 1994 LIVE LINE')}
                      >
                        <Volume2 size={13} /> Send 90s Phrase Over RTP
                      </button>
                    </div>
                    <input
                      id="input-live-phrase"
                      type="text"
                      maxLength={60}
                      value={ttsText}
                      onChange={(e) => setTtsText(e.target.value)}
                      placeholder="Optional phrase to inject over live RTP..."
                    />
                  </div>
                </>
              )}

              <div className="modal-footer" style={{ padding: '6px 0 0' }}>
                {liveCall.state === 'INCOMING' ? (
                  <>
                    <button
                      id="btn-decline-live-call"
                      type="button"
                      className="btn-danger"
                      onClick={() => onDeclineLiveCall?.(liveCall.callId)}
                    >
                      <PhoneOff size={14} /> Decline (SIP 486)
                    </button>
                    <button
                      id="btn-answer-live-call"
                      type="button"
                      className="btn-primary"
                      onClick={() => onAnswerLiveCall?.(liveCall.callId)}
                    >
                      <PhoneIncoming size={14} /> Answer Handset
                    </button>
                  </>
                ) : (
                  <button
                    id="btn-hangup-live-call"
                    type="button"
                    className="btn-danger"
                    onClick={() => onHangupLiveCall?.(liveCall.callId)}
                  >
                    <PhoneOff size={14} /> Hang Up (SIP BYE)
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'dial' && (!liveCall || liveCall.state === 'IDLE') && (
          <form className="modal-body" onSubmit={handleDialSubmit}>
            <div className="voice-box">
              <label>
                Target Number (From {session?.displayNumber || '...'}) — Online visitors ring LIVE!
                <input
                  id="input-sip-target"
                  type="text"
                  value={dialNumber}
                  onChange={(e) => onChangeDialNumber(e.target.value)}
                  placeholder="+1 (555) 010-0000"
                />
              </label>

              {quickTargets.length > 0 && (
                <div className="bot-quick-row">
                  {directory
                    .filter((entry) => entry.id !== session?.id)
                    .slice(0, 6)
                    .map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className={`flag-chip ${dialNumber === entry.display_number ? 'selected' : ''}`}
                        onClick={() => onChangeDialNumber(entry.display_number)}
                      >
                        {entry.isBot ? '🤖' : entry.online ? '🟢 LIVE' : '⚫'} {entry.flag} {entry.display_name || entry.display_number} ({entry.display_number})
                      </button>
                    ))}
                </div>
              )}
            </div>

            <div>
              <div className="mini-kicker" style={{ marginBottom: 6 }}>
                1. SELECT REAL SIP / RTP VOICE CODEC (SDP NEGOTIATED ON UDP/WS)
              </div>
              <div className="codec-grid">
                {CODEC_OPTIONS.map((c) => (
                  <button
                    key={c.id}
                    id={`btn-codec-${c.id}`}
                    type="button"
                    className={`codec-card ${sipCodec === c.id ? 'selected' : ''}`}
                    onClick={() => onChangeSipCodec(c.id)}
                  >
                    <div className="codec-card-top">
                      <span>{c.title}</span>
                      <span className="codec-pt-pill">{c.pt}</span>
                    </div>
                    <span className="codec-card-sub">{c.spec}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="voice-box">
              <div className="mini-kicker">2. VOICE SOURCE (BOT CALLS / TEST CLIPS) • HUMAN CALLS STREAM MIC LIVE</div>
              <div className="source-mode-row">
                <button
                  type="button"
                  className={`flag-chip ${sourceMode === 'synth' ? 'selected' : ''}`}
                  onClick={() => setSourceMode('synth')}
                >
                  90s Synth Voice + DTMF
                </button>
                <button
                  type="button"
                  className={`flag-chip ${sourceMode === 'mic' ? 'selected' : ''}`}
                  onClick={() => setSourceMode('mic')}
                >
                  Record Microphone Clip
                </button>
                <button
                  type="button"
                  className={`flag-chip ${sourceMode === 'upload' ? 'selected' : ''}`}
                  onClick={() => setSourceMode('upload')}
                >
                  Upload Audio File
                </button>
              </div>

              {sourceMode === 'synth' && (
                <>
                  <label>
                    Message Phrase (Bot Calls — Live Humans Use Microphone Directly)
                    <input
                      id="input-sip-tts"
                      type="text"
                      maxLength={80}
                      value={ttsText}
                      onChange={(e) => setTtsText(e.target.value)}
                      placeholder="HELLO FROM 1994 RETROFAX"
                    />
                  </label>
                  <div className="bot-quick-row">
                    {SYNTH_PRESETS.map((phrase) => (
                      <button
                        key={phrase}
                        type="button"
                        className={`flag-chip ${ttsText === phrase ? 'selected' : ''}`}
                        onClick={() => setTtsText(phrase)}
                      >
                        {phrase}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {sourceMode === 'mic' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {!recording ? (
                      <button type="button" className="btn-secondary" onClick={handleStartRecord}>
                        <Mic size={14} /> Start Recording
                      </button>
                    ) : (
                      <button type="button" className="btn-danger" onClick={handleStopRecord}>
                        <span className="rec-dot" /> <Square size={12} /> Stop Recording
                      </button>
                    )}
                    <span className="geo-note">
                      {recordedFile ? `Recorded: ${(recordedFile.size / 1024).toFixed(1)} KB` : 'Click Start Recording to record a clip for Bot calls.'}
                    </span>
                  </div>
                  {recordedPreviewUrl && (
                    <audio controls src={recordedPreviewUrl} className="win95-audio" />
                  )}
                </div>
              )}

              {sourceMode === 'upload' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label className="dropzone" style={{ padding: '14px 12px' }}>
                    <input
                      type="file"
                      accept="audio/*,.wav,.mp3,.ogg,.webm,.flac,.aac,.m4a"
                      onChange={handleFileChange}
                    />
                    <Upload size={20} />
                    <strong>
                      {uploadedFile ? `Loaded: ${uploadedFile.name}` : 'Click to pick .WAV, .MP3, .OGG, or .WEBM audio'}
                    </strong>
                    <span>Audio is resampled and framed into 20ms {selectedCodecMeta.title} RTP packets</span>
                  </label>
                  {uploadedPreviewUrl && (
                    <audio controls src={uploadedPreviewUrl} className="win95-audio" />
                  )}
                </div>
              )}
            </div>

            <div className="hw-status-strip">
              <span className="hw-label">LINE OPTIONS:</span>
              <button
                type="button"
                className={`flag-chip ${stormyLine ? 'selected' : ''}`}
                onClick={() => onSetStormyLine?.(!stormyLine)}
              >
                {stormyLine ? 'Line Static: ON (Noisy Wire)' : 'Line Static: OFF (Clean Line)'}
              </button>
              <span className="hw-tip">Online visitors ring live (2-way mic); Bots run instant SIP+RTP test</span>
            </div>

            {callState?.active && (
              <div className="voice-box">
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 700 }}>
                  <span>{callState.detail || 'CALL IN PROGRESS...'}</span>
                  <span>{callState.rtpPackets || 0} RTP pkts</span>
                </div>
                <div className="win95-progress-wrap">
                  <div
                    className="win95-progress-bar"
                    style={{ width: `${Math.round((callState.progress || 0.08) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            {localError && (
              <div className="error-banner" role="alert">
                <AlertTriangle size={15} /> {localError}
              </div>
            )}

            <div className="modal-footer" style={{ padding: '8px 0 0' }}>
              <button type="button" className="btn-secondary" onClick={onHangup}>
                <PhoneOff size={14} /> Hang Up Handset
              </button>
              <button
                id="btn-place-sip-call"
                type="submit"
                className="btn-primary"
                disabled={Boolean(callState?.active)}
              >
                <Phone size={14} /> {callState?.active ? 'Streaming RTP...' : `Call via ${selectedCodecMeta.pt}`}
              </button>
            </div>
          </form>
        )}

        {activeTab === 'result' && activeCallResult && (
          <div className="modal-body">
            <div className="voice-player-card">
              <div className="voice-player-hdr">
                <span>1. CALLER AUDIO DECODED BY CALLEE ({report.codecLabel || activeCallResult.codec})</span>
                <span>{report.txRtpPackets || '—'} RTP pkts ({report.txCodecBytes || '—'} B)</span>
              </div>
              <audio
                id="audio-caller-wav"
                controls
                src={activeCallResult.callerWavUrl}
                className="win95-audio"
              />
            </div>

            <div className="voice-player-card">
              <div className="voice-player-hdr">
                <span>2. CALLEE / BOT REPLY DECODED AT YOUR HANDSET</span>
                <span>{report.rxRtpPackets || '—'} RTP pkts ({report.rxCodecBytes || '—'} B)</span>
              </div>
              <audio
                id="audio-reply-wav"
                controls
                autoPlay={!muted}
                src={activeCallResult.replyWavUrl}
                className="win95-audio"
              />
            </div>

            <div className="verification-slip">
              <div className="slip-header">
                <h3>SIP / RTP VOICE VERIFICATION REPORT</h3>
                <span>{report.codecLabel || activeCallResult.codec}</span>
              </div>
              <pre className="slip-pre">
{`STATUS       : ${report.status || 'OK (200 OK + BYE Completed)'}
PROTOCOL     : ${report.protocol || 'SIP/SDP + RFC 3550 RTP'}
CODEC        : ${report.codecLabel || activeCallResult.codec} (PT=${report.payloadType ?? '—'})
STANDARD     : ${report.standard || 'ITU-T Speech Codec'}
BANDWIDTH    : ${report.bitrateKbps || '—'} kbps | ${report.sampleRateHz || '—'} Hz PCM (RTP clock ${report.rtpClockHz || 8000} Hz)
FROM -> TO   : ${report.fromNumber || activeCallResult.fromNumber} -> ${report.toNumber || activeCallResult.toNumber}
SIP CALL-ID  : ${report.callId || '—'}
UDP PORTS    : ${report.senderPort || '—'} <-> ${report.receiverPort || '—'} (127.0.0.1 RTP)
RTP PACKETS  : ${report.rtpPackets || '—'} total (${report.rtpBytes || '—'} bytes)
DURATION     : ${report.durationMs ? `${(report.durationMs / 1000).toFixed(2)} sec` : '—'}`}
              </pre>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowWireInResult((v) => !v)}
              >
                <Terminal size={14} /> {showWireInResult ? 'Hide' : 'Show'} Call SIP/RTP Log ({(activeCallResult.logs || []).length})
              </button>
              <div className="download-group">
                {activeCallResult.callerWavUrl && (
                  <a className="btn-secondary" href={activeCallResult.callerWavUrl} download>
                    <Download size={14} /> Caller .WAV
                  </a>
                )}
                {activeCallResult.replyWavUrl && (
                  <a className="btn-secondary" href={activeCallResult.replyWavUrl} download>
                    <Download size={14} /> Reply .WAV
                  </a>
                )}
                {activeCallResult.pcapUrl && (
                  <a id="btn-download-call-pcap" className="btn-secondary" href={activeCallResult.pcapUrl} download>
                    <Download size={14} /> Wireshark .PCAP
                  </a>
                )}
              </div>
            </div>

            {showWireInResult && (
              <div className="wire-log-box">
                {(activeCallResult.logs || []).map((entry, idx) => (
                  <div key={idx} className={`wire-line layer-${entry.layer?.toLowerCase()}`}>
                    <span className="w-ts">+{String(entry.ts).padStart(4, '0')}ms</span>
                    <span className="w-layer">{entry.layer}</span>
                    <span className="w-dir">{entry.direction}</span>
                    <span className="w-msg">{entry.summary}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="modal-footer" style={{ padding: '6px 0 0' }}>
              <button type="button" className="btn-secondary" onClick={() => setActiveTab('dial')}>
                <Phone size={14} /> Place Another Call
              </button>
              <button type="button" className="btn-primary" onClick={onHangup}>
                <PhoneOff size={14} /> Hang Up &amp; Close
              </button>
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="modal-body">
            <div className="dir-section-title">
              <Radio size={14} /> Session SIP Voice Calls &amp; Voicemails ({callsInbox.length})
            </div>
            {callsInbox.length === 0 ? (
              <p className="dir-hint">
                No SIP voice calls recorded yet. Switch to "Place SIP Call" or lift the handset and press [START].
              </p>
            ) : (
              <div className="dir-list">
                {callsInbox.map((c) => (
                  <div key={c.id || c.callId} className="dir-row">
                    <div className="dir-left">
                      <span className={`status-dot ${c.direction === 'inbound' ? 'online' : 'offline'}`} />
                      <div>
                        <div className="dir-name">
                          {c.direction === 'inbound'
                            ? `Inbound VM from ${c.fromName || c.fromNumber}`
                            : `Outbound Call -> ${c.toNumber}`}
                          <span className="badge-bot">{c.codec}</span>
                        </div>
                        <div className="dir-num">
                          {c.report?.rtpPackets || 0} RTP pkts • {c.report?.bitrateKbps || '—'} kbps •{' '}
                          {c.createdAt ? new Date(c.createdAt).toLocaleTimeString() : ''}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-dial-row"
                      onClick={() => {
                        onSelectCallResult(c);
                        setActiveTab('result');
                      }}
                    >
                      <FileCheck2 size={13} /> Listen &amp; .PCAP
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="modal-footer" style={{ padding: '6px 0 0' }}>
              <button type="button" className="btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
