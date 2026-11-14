import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookUser,
  Copy,
  Check,
  Volume2,
  VolumeX,
  Inbox,
  Camera,
  FileCheck2,
  Phone,
  PhoneIncoming,
  PhoneOff,
} from 'lucide-react';
import FaxScene3D from './components/FaxScene3D.jsx';
import StagingModal from './components/StagingModal.jsx';
import DirectoryModal from './components/DirectoryModal.jsx';
import FaxViewerModal from './components/FaxViewerModal.jsx';
import VoiceCallModal from './components/VoiceCallModal.jsx';
import T38Inspector from './components/T38Inspector.jsx';
import { faxAudio } from './audio/faxAudio.js';
import { liveCallEngine } from './audio/liveCallEngine.js';
import { uint8ToBase64, base64ToUint8 } from '../../shared/sipCodecs.js';
import { rasterizeFileOnClient } from './utils/clientRasterizer.js';

const CODEC_ORDER = ['G711U', 'G711A', 'G722', 'G729'];
const CODEC_DESCRIPTIONS = {
  G711U: 'G.711 PCMU μ-law (PT=0, 64 kbps, 8 kHz)',
  G711A: 'G.711 PCMA A-law (PT=8, 64 kbps, 8 kHz)',
  G722: 'G.722 SB-ADPCM Wideband (PT=9, 64 kbps, 16 kHz)',
  G729: 'G.729A CS-ACELP (PT=18, 8 kbps, 8 kHz)',
};

export default function App() {
  const [session, setSession] = useState(null);
  const [geo, setGeo] = useState(null);
  const [directory, setDirectory] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [callsInbox, setCallsInbox] = useState([]);
  const [wsConnected, setWsConnected] = useState(false);

  // Machine Hardware State
  const [dialNumber, setDialNumber] = useState('+1 (555) 010-0000'); // Pre-filled Echo Bot for instant fun, editable via 3D keypad!
  const [lastDialed, setLastDialed] = useState('+1 (555) 010-0000');
  const [lcdMode, setLcdMode] = useState('READY'); // 'READY' | 'DIRECTORY'
  const [dirIndex, setDirIndex] = useState(0);
  const [fine, setFine] = useState(true);
  const [stormyLine, setStormyLine] = useState(false);
  const [coverEnabled, setCoverEnabled] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraPreset, setCameraPreset] = useState('desk');

  // SIP Voice Hardware & Codec State
  const [handsetOffHook, setHandsetOffHook] = useState(false);
  const [sipCodec, setSipCodec] = useState('G711U');
  const [wireMode, setWireMode] = useState('t38'); // 't38' | 'sip'

  // Staged Document + Active T.38 / SIP Voice State
  const [staged, setStaged] = useState(null);
  const [txState, setTxState] = useState({ active: false, phase: 'IDLE', progress: 0, detail: '', udptlPackets: 0 });
  const [rxState, setRxState] = useState({ active: false, fromNumber: '', fromName: '', progress: 0 });
  const [callState, setCallState] = useState({
    active: false,
    phase: 'IDLE',
    progress: 0,
    detail: '',
    rtpPackets: 0,
    targetNumber: '',
  });
  const [rxCallState, setRxCallState] = useState({
    active: false,
    fromNumber: '',
    fromName: '',
    codec: 'G711U',
    progress: 0,
  });
  const [deskPrintedFax, setDeskPrintedFax] = useState(null);
  const [alertBanner, setAlertBanner] = useState(null);

  // UI Modals & Drawers
  const [stagingOpen, setStagingOpen] = useState(false);
  const [stagingTab, setStagingTab] = useState('upload');
  const [dirOpen, setDirOpen] = useState(false);
  const [viewerFax, setViewerFax] = useState(null);
  const [viewerMode, setViewerMode] = useState('received');
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [voiceModalTab, setVoiceModalTab] = useState('dial');
  const [activeCallResult, setActiveCallResult] = useState(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [t38Logs, setT38Logs] = useState([]);
  const [toast, setToast] = useState(null);
  const [copiedNum, setCopiedNum] = useState(false);
  const [capabilities, setCapabilities] = useState({ serverConversion: true, liveSip: true });

  // Live Peer-to-Peer Bidirectional SIP Voice State
  const [liveCall, setLiveCall] = useState(null); // { callId, state: 'RINGING'|'INCOMING'|'ACTIVE', role, peerNumber, peerName, codec, sipCallId, txPackets, rxPackets, durationMs, micAvailable, micError }
  const [liveVu, setLiveVu] = useState({ tx: 0, rx: 0 });
  const [micMuted, setMicMuted] = useState(false);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const txStateRef = useRef(txState);
  txStateRef.current = txState;
  const callStateRef = useRef(callState);
  callStateRef.current = callState;
  const rxCallStateRef = useRef(rxCallState);
  rxCallStateRef.current = rxCallState;
  const liveCallRef = useRef(liveCall);
  liveCallRef.current = liveCall;
  const micMutedRef = useRef(micMuted);
  micMutedRef.current = micMuted;
  const sipCodecRef = useRef(sipCodec);
  sipCodecRef.current = sipCodec;
  const stormyLineRef = useRef(stormyLine);
  stormyLineRef.current = stormyLine;
  const liveSipLogsRef = useRef([]);
  const wsRef = useRef(null);
  const pendingBotCallRef = useRef(null);
  const handledTxIdsRef = useRef(new Set());
  const handledCallTxIdsRef = useRef(new Set());

  const showToast = useCallback((text, action = null) => {
    setToast({ text, action, id: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6500);
    return () => clearTimeout(t);
  }, [toast]);

  // 1. Bootstrap Cookie Session + IP Geolocation
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    fetch(`/api/session?tz=${encodeURIComponent(tz)}`)
      .then((r) => r.json())
      .then((data) => {
        setSession(data.session);
        setGeo(data.geo);
        setDirectory(data.directory || []);
        setInbox(data.inbox || []);
        setCallsInbox(data.calls || []);
        if (data.capabilities) setCapabilities(data.capabilities);
      })
      .catch((err) => {
        console.error('Session init failed:', err);
      });
  }, []);

  const handleTxEvent = useCallback((ev, txId = null) => {
    if (ev.type === 't38_log') {
      setWireMode('t38');
      setT38Logs((prev) => [...prev.slice(-220), ev.entry]);
    } else if (ev.type === 'phase') {
      setTxState((prev) => ({
        ...prev,
        active: !['COMPLETED', 'BUSY', 'NO_ANSWER'].includes(ev.phase),
        phase: ev.phase,
        detail: ev.detail,
      }));
      if (ev.phase === 'HANDSHAKE') {
        faxAudio.playFaxHandshake();
      } else if (ev.phase === 'RINGING') {
        faxAudio.playRingback(sessionRef.current?.toneProfile || 'na');
      }
    } else if (ev.type === 'ring_pulse') {
      faxAudio.playRingback(sessionRef.current?.toneProfile || 'na');
    } else if (ev.type === 'progress') {
      setTxState((prev) => ({
        ...prev,
        active: true,
        phase: 'TRANSMITTING',
        progress: ev.overallProgress,
        udptlPackets: ev.udptlPackets,
      }));
    } else if (ev.type === 'tx_failed') {
      if (txId) {
        if (handledTxIdsRef.current.has(txId)) return;
        handledTxIdsRef.current.add(txId);
      }
      setTxState({ active: false, phase: ev.reason === 'busy' ? 'BUSY' : 'NO_ANSWER', progress: 0, detail: '', udptlPackets: 0 });
      if (ev.reason === 'busy') {
        faxAudio.playBusySignal();
        setAlertBanner({ line1: 'LINE BUSY (SIP 486)', line2: 'RECIPIENT LINE IN USE' });
        showToast('Line Busy (SIP 486 Busy Here)');
      } else {
        faxAudio.playBuzzerError();
        setAlertBanner({ line1: 'NO ANSWER (SIP 480)', line2: 'RECIPIENT MACHINE OFFLINE' });
        showToast('Ring No Answer — Recipient fax machine is offline (SIP 480)');
      }
    } else if (ev.type === 'tx_complete') {
      if (txId) {
        if (handledTxIdsRef.current.has(txId)) return;
        handledTxIdsRef.current.add(txId);
      }
      faxAudio.playConfirmBeep();
      setTxState({ active: false, phase: 'COMPLETED', progress: 1, detail: 'MCF CONFIRMED', udptlPackets: ev.report?.udptlPackets || 0 });
      setStaged(null);
      const sentFax = {
        id: ev.faxId,
        fromNumber: sessionRef.current?.displayNumber,
        toNumber: ev.report?.toNumber,
        fine,
        previewUrls: ev.previewUrls,
        tiffUrl: ev.tiffUrl,
        pcapUrl: ev.pcapUrl,
        report: ev.report,
        logs: ev.logs,
      };
      showToast(`Fax transmitted via T.38 (${ev.report?.udptlPackets} UDPTL pkts)!`, {
        label: 'View Receipt & .PCAP',
        onClick: () => {
          setViewerMode('sent_receipt');
          setViewerFax(sentFax);
        },
      });
    } else if (ev.type === 'error') {
      if (txId) {
        if (handledTxIdsRef.current.has(txId)) return;
        handledTxIdsRef.current.add(txId);
      }
      faxAudio.playBuzzerError();
      setTxState({ active: false, phase: 'ERROR', progress: 0, detail: '', udptlPackets: 0 });
      setAlertBanner({ line1: 'TRANSMISSION ERROR', line2: (ev.error || '').slice(0, 30) });
      showToast(ev.error || 'Transmission error');
    }
  }, [fine, showToast]);

  const handleRxEvent = useCallback((ev) => {
    if (ev.type === 't38_log') {
      if (!txStateRef.current?.active) {
        setWireMode('t38');
        setT38Logs((prev) => [...prev.slice(-220), ev.entry]);
      }
    } else if (ev.type === 'incoming_ring') {
      if (!txStateRef.current?.active) setWireMode('t38');
      faxAudio.playIncomingMachineRing();
      setRxState({ active: true, fromNumber: ev.fromNumber, fromName: ev.fromName, progress: 0.04 });
      showToast(`Incoming T.38 Fax from ${ev.fromName || ev.fromNumber}!`);
    } else if (ev.type === 'rx_handshake') {
      if (!txStateRef.current?.active) faxAudio.playFaxHandshake();
      setRxState((prev) => ({ ...prev, active: true, progress: 0.08 }));
    } else if (ev.type === 'rx_progress') {
      setRxState((prev) => ({
        ...prev,
        active: true,
        progress: Math.max(0.1, ev.overallProgress || 0.1),
      }));
    } else if (ev.type === 'rx_failed') {
      faxAudio.playBuzzerError();
      setRxState({ active: false, fromNumber: '', fromName: '', progress: 0 });
      showToast(ev.error || 'Incoming T.38 fax interrupted');
    } else if (ev.type === 'rx_complete') {
      faxAudio.playConfirmBeep();
      setRxState({ active: false, fromNumber: '', fromName: '', progress: 0 });
      setDeskPrintedFax(ev.fax);
      setInbox((prev) => [ev.fax, ...prev.filter((x) => x.id !== ev.fax.id)].slice(0, 25));
      showToast(`Printed fax from ${ev.fax.fromName || ev.fax.fromNumber}! Click paper to read.`, {
        label: 'Open Fax',
        onClick: () => {
          setViewerMode('received');
          setViewerFax(ev.fax);
        },
      });
    }
  }, [showToast]);

  const handleCallTxEvent = useCallback((ev, callTxId = null) => {
    if (ev.type === 't38_log') {
      setWireMode('sip');
      setT38Logs((prev) => [...prev.slice(-220), ev.entry]);
    } else if (ev.type === 'phase') {
      setCallState((prev) => ({
        ...prev,
        active: !['COMPLETED', 'BUSY', 'NO_ANSWER'].includes(ev.phase),
        phase: ev.phase,
        detail: ev.detail,
      }));
      if (ev.phase === 'RINGING') {
        faxAudio.playRingback(sessionRef.current?.toneProfile || 'na');
      } else if (ev.phase === 'VOICE_ACTIVE') {
        faxAudio.playConfirmBeep();
      }
    } else if (ev.type === 'ring_pulse') {
      faxAudio.playRingback(sessionRef.current?.toneProfile || 'na');
    } else if (ev.type === 'progress') {
      setCallState((prev) => ({
        ...prev,
        active: true,
        phase: 'VOICE_ACTIVE',
        progress: ev.overallProgress,
        rtpPackets: ev.rtpPackets,
      }));
    } else if (ev.type === 'call_tx_failed') {
      if (callTxId) {
        if (handledCallTxIdsRef.current.has(callTxId)) return;
        handledCallTxIdsRef.current.add(callTxId);
      }
      setCallState({
        active: false,
        phase: ev.reason === 'busy' ? 'BUSY' : 'NO_ANSWER',
        progress: 0,
        detail: '',
        rtpPackets: 0,
        targetNumber: ev.report?.toNumber || '',
      });
      if (ev.reason === 'busy') {
        faxAudio.playBusySignal();
        setAlertBanner({ line1: 'VOICE BUSY (SIP 486)', line2: 'TARGET STATION BUSY/BLOCKED' });
        showToast('Voice Line Busy (SIP 486 Busy Here)');
      } else {
        faxAudio.playBuzzerError();
        setAlertBanner({ line1: 'NO ANSWER (SIP 480)', line2: 'TARGET HANDSET OFFLINE' });
        showToast('Ring No Answer — Target station offline (SIP 480)');
      }
    } else if (ev.type === 'call_tx_complete') {
      if (callTxId) {
        if (handledCallTxIdsRef.current.has(callTxId)) return;
        handledCallTxIdsRef.current.add(callTxId);
      }
      faxAudio.playConfirmBeep();
      setCallState({
        active: false,
        phase: 'COMPLETED',
        progress: 1,
        detail: 'SIP 200 OK / BYE',
        rtpPackets: ev.report?.rtpPackets || 0,
        targetNumber: ev.toNumber,
      });
      const completed = {
        id: ev.callId,
        callId: ev.callId,
        direction: 'outbound',
        fromNumber: ev.fromNumber,
        toNumber: ev.toNumber,
        codec: ev.codec,
        callerWavUrl: ev.callerWavUrl,
        replyWavUrl: ev.replyWavUrl,
        pcapUrl: ev.pcapUrl,
        report: ev.report,
        logs: ev.logs,
        createdAt: ev.createdAt || Date.now(),
      };
      setCallsInbox((prev) => [completed, ...prev.filter((x) => x.id !== completed.id)].slice(0, 25));
      setActiveCallResult(completed);
      showToast(
        `SIP ${ev.codec} call done (${ev.report?.rtpPackets} RTP pkts)!`,
        {
          label: 'Play .WAV & .PCAP',
          onClick: () => {
            setActiveCallResult(completed);
            setVoiceModalTab('result');
            setVoiceModalOpen(true);
          },
        }
      );
    } else if (ev.type === 'error') {
      if (callTxId) {
        if (handledCallTxIdsRef.current.has(callTxId)) return;
        handledCallTxIdsRef.current.add(callTxId);
      }
      faxAudio.playBuzzerError();
      setCallState({ active: false, phase: 'ERROR', progress: 0, detail: '', rtpPackets: 0, targetNumber: '' });
      setAlertBanner({ line1: 'SIP CALL ERROR', line2: (ev.error || '').slice(0, 30) });
      showToast(ev.error || 'SIP voice call error');
    }
  }, [showToast]);

  const handleCallRxEvent = useCallback((ev) => {
    if (ev.type === 't38_log') {
      if (!callStateRef.current?.active) {
        setWireMode('sip');
        setT38Logs((prev) => [...prev.slice(-220), ev.entry]);
      }
    } else if (ev.type === 'incoming_call_ring') {
      faxAudio.playIncomingMachineRing();
      setWireMode('sip');
      setRxCallState({
        active: true,
        fromNumber: ev.fromNumber,
        fromName: ev.fromName,
        codec: ev.codec || 'G711U',
        progress: 0.05,
      });
      showToast(`Incoming SIP Voice Call (${ev.codec}) from ${ev.fromName || ev.fromNumber}!`);
    } else if (ev.type === 'call_rx_active') {
      setRxCallState((prev) => ({ ...prev, active: true, progress: 0.12 }));
    } else if (ev.type === 'call_rx_progress') {
      setRxCallState((prev) => ({
        ...prev,
        active: true,
        progress: Math.max(0.1, ev.overallProgress || 0.1),
      }));
    } else if (ev.type === 'call_rx_complete') {
      faxAudio.playConfirmBeep();
      setRxCallState({ active: false, fromNumber: '', fromName: '', codec: 'G711U', progress: 0 });
      const vm = ev.call;
      if (vm) {
        setCallsInbox((prev) => [vm, ...prev.filter((x) => x.id !== vm.id)].slice(0, 25));
        showToast(`New SIP Voicemail (${vm.codec}) from ${vm.fromName || vm.fromNumber}!`, {
          label: 'Play Voicemail',
          onClick: () => {
            setActiveCallResult(vm);
            setVoiceModalTab('result');
            setVoiceModalOpen(true);
          },
        });
      }
    }
  }, [showToast]);

  // Sync live stormy line & mute state into liveCallEngine
  useEffect(() => {
    liveCallEngine.setStormyLine(stormyLine);
  }, [stormyLine]);

  useEffect(() => {
    if (!liveCall || (liveCall.state !== 'RINGING' && liveCall.state !== 'INCOMING')) return;
    const iv = setInterval(() => {
      if (liveCall.state === 'RINGING') {
        faxAudio.playRingback(sessionRef.current?.toneProfile || 'na');
      } else {
        faxAudio.playIncomingMachineRing();
      }
    }, 2600);
    return () => clearInterval(iv);
  }, [liveCall?.callId, liveCall?.state]);

  const runBotSipCall = useCallback(async ({
    toNumber,
    codec,
    ttsText = 'HELLO FROM 1994 RETROFAX',
    audioFile = null,
    useStatic = false,
  }) => {
    setCallState({
      active: true,
      phase: 'DIALING',
      progress: 0.04,
      detail: `SIP INVITE (${codec}) -> ${toNumber}`,
      rtpPackets: 0,
      targetNumber: toNumber,
    });
    try {
      let res;
      if (audioFile) {
        const form = new FormData();
        form.append('toNumber', toNumber);
        form.append('codec', codec);
        form.append('ttsText', ttsText);
        form.append('stormyLine', String(useStatic));
        form.append('audio', audioFile);
        res = await fetch('/api/call', { method: 'POST', body: form });
      } else {
        res = await fetch('/api/call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toNumber,
            codec,
            ttsText,
            stormyLine: useStatic,
          }),
        });
      }
      const data = await res.json();
      if (!res.ok) {
        setCallState({ active: false, phase: 'IDLE', progress: 0, detail: '', rtpPackets: 0, targetNumber: '' });
        faxAudio.playBuzzerError();
        showToast(data.error || 'SIP call failed');
      } else if (data.callTxId && !handledCallTxIdsRef.current.has(data.callTxId)) {
        if (data.status === 'ok' && data.call) {
          handleCallTxEvent(data.call, data.callTxId);
        } else if (data.status === 'busy' || data.status === 'no_answer') {
          handleCallTxEvent(
            { type: 'call_tx_failed', reason: data.status, report: data.report, logs: data.logs },
            data.callTxId
          );
        }
      }
    } catch (err) {
      setCallState({ active: false, phase: 'IDLE', progress: 0, detail: '', rtpPackets: 0, targetNumber: '' });
      faxAudio.playBuzzerError();
      showToast(err.message);
    }
  }, [showToast, handleCallTxEvent]);

  // 2. WebSocket Connection for Live T.38 & Live Duplex SIP+RTP Telemetry
  useEffect(() => {
    if (!session?.id) return;
    let ws;
    let dead = false;
    let reconnectTimer;
    let hasOpenedOnce = false;

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws?sid=${encodeURIComponent(session.id)}`;
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        if (hasOpenedOnce) {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
          fetch(`/api/session?tz=${encodeURIComponent(tz)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (!data || dead) return;
              if (data.directory) setDirectory(data.directory);
              if (data.inbox) setInbox(data.inbox);
              if (data.calls) setCallsInbox(data.calls);
            })
            .catch(() => {});
        }
        hasOpenedOnce = true;
      };
      ws.onclose = () => {
        setWsConnected(false);
        if (wsRef.current === ws) wsRef.current = null;
        if (!dead) reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onmessage = async (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data.type === 'directory_update') {
            setDirectory(data.directory || []);
          } else if (data.type === 'tx_event') {
            handleTxEvent(data.event, data.txId);
          } else if (data.type === 'rx_event') {
            handleRxEvent(data.event);
          } else if (data.type === 'call_tx_event') {
            handleCallTxEvent(data.event, data.callTxId);
          } else if (data.type === 'call_rx_event') {
            handleCallRxEvent(data.event);
          } else if (data.type === 'live_call_use_bot') {
            const pending = pendingBotCallRef.current || {
              toNumber: data.toNumber,
              codec: data.codec,
              ttsText: 'HELLO FROM 1994 RETROFAX',
              audioFile: null,
              useStatic: stormyLineRef.current,
            };
            pendingBotCallRef.current = null;
            runBotSipCall(pending);
          } else if (data.type === 'live_call_ringing') {
            setWireMode('sip');
            setCallState({ active: false, phase: 'IDLE', progress: 0, detail: '', rtpPackets: 0, targetNumber: '' });
            faxAudio.playRingback(sessionRef.current?.toneProfile || 'na');
            liveSipLogsRef.current = data.logs || [];
            setT38Logs((prev) => [...prev.slice(-180), ...(data.logs || [])]);
            setLiveCall({
              callId: data.callId,
              state: 'RINGING',
              role: 'caller',
              peerNumber: data.toNumber,
              peerName: data.toName,
              codec: data.codec,
              sipCallId: data.sipCallId,
              txPackets: 0,
              rxPackets: 0,
              durationMs: 0,
              micAvailable: false,
              micError: '',
            });
          } else if (data.type === 'live_call_incoming') {
            setWireMode('sip');
            faxAudio.playIncomingMachineRing();
            liveSipLogsRef.current = data.logs || [];
            setT38Logs((prev) => [...prev.slice(-180), ...(data.logs || [])]);
            setLiveCall({
              callId: data.callId,
              state: 'INCOMING',
              role: 'callee',
              peerNumber: data.fromNumber,
              peerName: data.fromName,
              codec: data.codec,
              sipCallId: data.sipCallId,
              stormyLine: data.stormyLine,
              txPackets: 0,
              rxPackets: 0,
              durationMs: 0,
              micAvailable: false,
              micError: '',
            });
            showToast(`Incoming LIVE SIP Voice Call (${data.codec}) from ${data.fromName || data.fromNumber}!`);
          } else if (data.type === 'live_call_connected') {
            setWireMode('sip');
            if (data.codec) setSipCodec(data.codec);
            setHandsetOffHook(true);
            setVoiceModalTab('dial');
            setVoiceModalOpen(true);
            faxAudio.playConfirmBeep();
            liveSipLogsRef.current = [...liveSipLogsRef.current, ...(data.logs || [])];
            setT38Logs((prev) => [...prev.slice(-180), ...(data.logs || [])]);
            setRxCallState({ active: false, fromNumber: '', fromName: '', codec: data.codec, progress: 0 });
            setLiveCall({
              callId: data.callId,
              state: 'ACTIVE',
              role: data.role,
              peerNumber: data.peerNumber,
              peerName: data.peerName,
              codec: data.codec,
              sipCallId: data.sipCallId,
              txPackets: 0,
              rxPackets: 0,
              durationMs: 0,
              micAvailable: false,
              micError: '',
            });

            const micStatus = await liveCallEngine.start({
              callId: data.callId,
              codec: data.codec,
              stormyLine: Boolean(data.stormyLine),
              muted: micMutedRef.current,
              onSendRtp: (rtpBytes) => {
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(
                    JSON.stringify({
                      type: 'live_rtp',
                      callId: data.callId,
                      rtpB64: uint8ToBase64(rtpBytes),
                    })
                  );
                }
              },
              onWireLog: (entry) => {
                liveSipLogsRef.current = [...liveSipLogsRef.current.slice(-180), entry];
                setT38Logs((prev) => [...prev.slice(-220), entry]);
              },
              onStats: (st) => {
                setLiveCall((prev) =>
                  prev && prev.callId === data.callId
                    ? {
                        ...prev,
                        txPackets: st.txPackets,
                        rxPackets: st.rxPackets,
                        durationMs: st.durationMs,
                        micAvailable: st.micAvailable,
                      }
                    : prev
                );
              },
              onVu: (dir, val) => {
                setLiveVu((prev) => ({ ...prev, [dir]: val }));
              },
            });

            setLiveCall((prev) =>
              prev && prev.callId === data.callId
                ? { ...prev, micAvailable: micStatus.micAvailable, micError: micStatus.micError }
                : prev
            );
          } else if (data.type === 'live_rtp') {
            if (liveCallRef.current?.callId === data.callId) {
              liveCallEngine.handleIncomingRtp(base64ToUint8(data.rtpB64));
            }
          } else if (data.type === 'live_dtmf') {
            if (liveCallRef.current?.callId === data.callId && data.digit) {
              faxAudio.playDTMF(data.digit);
            }
          } else if (data.type === 'live_call_rejected') {
            setCallState({ active: false, phase: 'IDLE', progress: 0, detail: '', rtpPackets: 0, targetNumber: '' });
            setLiveCall(null);
            setLiveVu({ tx: 0, rx: 0 });
            if (data.logs?.length) setT38Logs((prev) => [...prev.slice(-180), ...data.logs]);
            if (data.sipCode === 486) {
              faxAudio.playBusySignal();
              setAlertBanner({ line1: 'VOICE BUSY (SIP 486)', line2: data.reason === 'self_call' ? 'CANNOT SELF-CALL LIVE' : 'RECIPIENT DECLINED / BUSY' });
              showToast(data.reason === 'self_call' ? 'Open another tab/device to call live, or dial a Bot!' : 'Call declined or busy (SIP 486 Busy Here)');
            } else {
              faxAudio.playBuzzerError();
              setAlertBanner({ line1: 'NO ANSWER (SIP 480)', line2: 'TARGET STATION OFFLINE' });
              showToast('Ring No Answer — Recipient is offline or did not answer (SIP 480)');
            }
          } else if (data.type === 'live_call_ended') {
            const endedPrev = liveCallRef.current;
            const endLogs = data.logs || [];
            setT38Logs((prev) => [...prev.slice(-180), ...endLogs]);
            const allLogs = [...liveSipLogsRef.current, ...endLogs];
            if (liveCallEngine.active) {
              const exported = liveCallEngine.stopAndExport({
                fromNumber: sessionRef.current?.displayNumber || '',
                toNumber: endedPrev?.peerNumber || '',
                sipCallId: endedPrev?.sipCallId || '',
              });
              const finishedCall = {
                id: endedPrev?.callId || String(Date.now()),
                callId: endedPrev?.callId || String(Date.now()),
                direction: endedPrev?.role === 'callee' ? 'inbound' : 'outbound',
                fromNumber: endedPrev?.role === 'callee' ? endedPrev?.peerNumber : sessionRef.current?.displayNumber,
                fromName: endedPrev?.peerName || '',
                toNumber: endedPrev?.role === 'callee' ? sessionRef.current?.displayNumber : endedPrev?.peerNumber,
                codec: endedPrev?.codec || sipCodecRef.current,
                callerWavUrl: exported.callerWavUrl,
                replyWavUrl: exported.replyWavUrl,
                pcapUrl: exported.pcapUrl,
                report: exported.report,
                logs: allLogs,
                createdAt: Date.now(),
              };
              setCallsInbox((prev) => [finishedCall, ...prev].slice(0, 25));
              setActiveCallResult(finishedCall);
              setVoiceModalTab('result');
            } else {
              liveCallEngine.stopSyncOnly();
            }
            setLiveCall(null);
            setLiveVu({ tx: 0, rx: 0 });
            setHandsetOffHook(false);
            faxAudio.playHandsetHangup();
            showToast('Live SIP call ended (SIP BYE / 200 OK). Recording & .PCAP ready!');
          }
        } catch (err) {
          console.error('WS parse error', err);
        }
      };
    };

    connect();
    return () => {
      dead = true;
      clearTimeout(reconnectTimer);
      liveCallEngine.stopSyncOnly();
      ws?.close();
    };
  }, [session?.id, handleTxEvent, handleRxEvent, handleCallTxEvent, handleCallRxEvent, runBotSipCall, showToast]);

  // Quick drag-drop file directly onto the 3D machine
  const handleQuickFileOrOpen = async (droppedFile) => {
    if (droppedFile instanceof File) {
      try {
        let res;
        if (capabilities?.serverConversion !== false) {
          const form = new FormData();
          form.append('file', droppedFile);
          form.append('coverSheet', JSON.stringify({ enabled: coverEnabled }));
          res = await fetch('/api/stage', { method: 'POST', body: form });
        } else {
          const pages = await rasterizeFileOnClient(droppedFile);
          res = await fetch('/api/stage/pages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pages,
              sourceLabel: droppedFile.name,
              coverSheet: { enabled: coverEnabled },
            }),
          });
        }
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load document');
        handleStagedSuccess(data);
      } catch (err) {
        faxAudio.playBuzzerError();
        showToast(err.message);
      }
      return;
    }
    setStagingTab('upload');
    setStagingOpen(true);
  };

  const handleStagedSuccess = (data) => {
    setStaged(data);
    setAlertBanner(null);
    faxAudio.playConfirmBeep();
    showToast(`Loaded "${data.sourceLabel}" (${data.pagesCount}p) into top tray.`);
  };

  const handleSendFax = useCallback(async (numberOverride = null) => {
    const targetNumber = typeof numberOverride === 'string' ? numberOverride : dialNumber;
    if (txStateRef.current.active || callStateRef.current.active || liveCallRef.current) {
      showToast('Transmission or live call already in progress.');
      return;
    }
    if (!staged) {
      faxAudio.playBuzzerError();
      setAlertBanner({ line1: 'FEEDER TRAY EMPTY', line2: 'CLICK TOP TRAY: DRAW/UPLOAD' });
      setStagingTab('upload');
      setStagingOpen(true);
      return;
    }
    if (!targetNumber.trim()) {
      faxAudio.playBuzzerError();
      setAlertBanner({ line1: 'NO NUMBER ENTERED', line2: 'DIAL OR PICK FROM [DIR]' });
      return;
    }

    setAlertBanner(null);
    setWireMode('t38');
    setLastDialed(targetNumber);
    setT38Logs([]);
    setTxState({
      active: true,
      phase: 'DIALING',
      progress: 0,
      detail: `Dialing ${targetNumber}...`,
      udptlPackets: 0,
      targetNumber,
    });

    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stageId: staged.stageId,
          toNumber: targetNumber,
          fine,
          stormyLine,
          coverEnabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTxState({ active: false, phase: 'IDLE', progress: 0, detail: '', udptlPackets: 0 });
        faxAudio.playBuzzerError();
        showToast(data.error || 'Failed to send fax');
      } else if (data.txId && !handledTxIdsRef.current.has(data.txId)) {
        if (data.status === 'ok' && data.fax) {
          handleTxEvent(data.fax, data.txId);
        } else if (data.status === 'busy' || data.status === 'no_answer') {
          handleTxEvent(
            { type: 'tx_failed', reason: data.status, report: data.report, logs: data.logs },
            data.txId
          );
        }
      }
    } catch (err) {
      setTxState({ active: false, phase: 'IDLE', progress: 0, detail: '', udptlPackets: 0 });
      showToast(err.message);
    }
  }, [dialNumber, staged, fine, stormyLine, coverEnabled, showToast, handleTxEvent]);

  const handlePlaceSipCall = useCallback(async ({
    toNumber = null,
    codec = null,
    ttsText = 'HELLO FROM 1994 RETROFAX',
    audioFile = null,
    stormyLine: stormyOverride = null,
  } = {}) => {
    const target = String(toNumber || dialNumber || '').trim();
    const chosenCodec = codec || sipCodec;
    const useStatic = stormyOverride !== null ? Boolean(stormyOverride) : stormyLine;

    if (callStateRef.current.active || txStateRef.current.active || liveCallRef.current) {
      showToast('A call or fax session is already active.');
      return;
    }
    if (!target) {
      faxAudio.playBuzzerError();
      setAlertBanner({ line1: 'NO NUMBER ENTERED', line2: 'DIAL OR PICK FROM [DIR]' });
      return;
    }

    setAlertBanner(null);
    setHandsetOffHook(true);
    setWireMode('sip');
    setLastDialed(target);
    setT38Logs([]);

    const targetDigits = target.replace(/[^\d]/g, '');
    const dirMatch = directory.find(
      (d) =>
        d.dial_digits === targetDigits ||
        d.shortDial === targetDigits ||
        (targetDigits.length >= 7 && d.dial_digits?.endsWith(targetDigits))
    );

    // Bots or explicit uploaded audio clips run automated SIP/RTP round-trip on backend
    if (audioFile || dirMatch?.isBot || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      await runBotSipCall({ toNumber: target, codec: chosenCodec, ttsText, audioFile, useStatic });
      return;
    }

    // Live peer-to-peer SIP INVITE over WebSocket!
    pendingBotCallRef.current = { toNumber: target, codec: chosenCodec, ttsText, audioFile: null, useStatic };
    wsRef.current.send(
      JSON.stringify({
        type: 'live_call_invite',
        toNumber: target,
        codec: chosenCodec,
        stormyLine: useStatic,
      })
    );
  }, [dialNumber, sipCodec, stormyLine, directory, runBotSipCall, showToast]);

  const handleAnswerLiveCall = useCallback((callId) => {
    const id = callId || liveCallRef.current?.callId;
    if (!id || wsRef.current?.readyState !== WebSocket.OPEN) return;
    setHandsetOffHook(true);
    setWireMode('sip');
    setVoiceModalTab('dial');
    setVoiceModalOpen(true);
    wsRef.current.send(JSON.stringify({ type: 'live_call_answer', callId: id }));
  }, []);

  const handleDeclineLiveCall = useCallback((callId) => {
    const id = callId || liveCallRef.current?.callId;
    if (!id || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'live_call_decline', callId: id }));
    setLiveCall(null);
    faxAudio.playHandsetHangup();
  }, []);

  const handleHangupLiveCall = useCallback((callId) => {
    const id = callId || liveCallRef.current?.callId;
    if (id && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'live_call_hangup', callId: id }));
    } else {
      liveCallEngine.stopSyncOnly();
      setLiveCall(null);
      setHandsetOffHook(false);
    }
  }, []);

  const handleToggleMicMute = useCallback(() => {
    setMicMuted((prev) => {
      const next = !prev;
      liveCallEngine.setMuted(next);
      return next;
    });
  }, []);

  const handleSendLivePhrase = useCallback((phrase) => {
    if (!liveCallEngine.active) return;
    liveCallEngine.sendSynthBurst(phrase || 'HELLO FROM 1994 LIVE LINE');
  }, []);

  const handleToggleHandset = useCallback(() => {
    if (liveCallRef.current || callStateRef.current.active || rxCallStateRef.current.active) {
      setVoiceModalTab('dial');
      setVoiceModalOpen(true);
      return;
    }
    if (!handsetOffHook) {
      setHandsetOffHook(true);
      setWireMode('sip');
      setAlertBanner(null);
      faxAudio.playHandsetPickup(sessionRef.current?.toneProfile || 'na');
      setVoiceModalTab('dial');
      setTimeout(() => setVoiceModalOpen(true), 280);
    } else {
      setHandsetOffHook(false);
      setVoiceModalOpen(false);
      faxAudio.playHandsetHangup();
      showToast('Handset placed back on cradle.');
    }
  }, [handsetOffHook, showToast]);

  // Physical 3D Keypad & Hardware Switch Handler
  const handle3DKeyPress = useCallback((keyId) => {
    if (/^[0-9*#]$/.test(keyId)) {
      faxAudio.playDTMF(keyId);
      if (liveCallRef.current?.state === 'ACTIVE' && liveCallEngine.active) {
        liveCallEngine.sendDtmfBurst(keyId);
        wsRef.current?.send(JSON.stringify({ type: 'live_dtmf', callId: liveCallRef.current.callId, digit: keyId }));
      }
      setAlertBanner(null);
      setLcdMode('READY');
      setDialNumber((prev) => (prev + keyId).slice(0, 22));
    } else if (keyId === 'CLR') {
      faxAudio.playButtonClick(480);
      if (alertBanner) {
        setAlertBanner(null);
      } else if (lcdMode === 'DIRECTORY') {
        setLcdMode('READY');
      } else {
        setDialNumber((prev) => prev.slice(0, -1));
      }
    } else if (keyId === 'DIR') {
      faxAudio.playButtonClick(680);
      setAlertBanner(null);
      setLcdMode((m) => (m === 'DIRECTORY' ? 'READY' : 'DIRECTORY'));
    } else if (keyId === 'UP') {
      faxAudio.playButtonClick(720);
      setLcdMode('DIRECTORY');
      setDirIndex((i) => Math.max(0, i - 1));
    } else if (keyId === 'DOWN') {
      faxAudio.playButtonClick(640);
      setLcdMode('DIRECTORY');
      setDirIndex((i) => Math.min(Math.max(0, directory.length - 1), i + 1));
    } else if (keyId === 'OK') {
      faxAudio.playButtonClick(820);
      if (alertBanner) {
        setAlertBanner(null);
      } else if (lcdMode === 'DIRECTORY' && directory[dirIndex]) {
        setDialNumber(directory[dirIndex].display_number);
        setLcdMode('READY');
      } else {
        setDirOpen(true);
      }
    } else if (keyId === 'RES') {
      faxAudio.playButtonClick(740);
      const next = !fine;
      setFine(next);
      showToast(next ? 'Fine (204×196 dpi) mode ON' : 'Standard (204×98 dpi) mode ON');
    } else if (keyId === 'COVER') {
      faxAudio.playButtonClick(760);
      const next = !coverEnabled;
      setCoverEnabled(next);
      showToast(next ? '90s Cover Sheet: ON (cover page prepended on send)' : '90s Cover Sheet: OFF');
    } else if (keyId === 'STATIC') {
      const next = !stormyLine;
      setStormyLine(next);
      if (next) faxAudio.playStaticBurst();
      else faxAudio.playButtonClick(540);
      showToast(next ? 'Line Static: ON (stormy 90s glitches enabled)' : 'Line Static: OFF (clean line)');
    } else if (keyId === 'CODEC') {
      faxAudio.playButtonClick(840);
      const next = CODEC_ORDER[(CODEC_ORDER.indexOf(sipCodec) + 1) % CODEC_ORDER.length];
      setSipCodec(next);
      setWireMode('sip');
      showToast(`SIP Codec: ${CODEC_DESCRIPTIONS[next]}`);
    } else if (keyId === 'VOICE') {
      if (!handsetOffHook) {
        faxAudio.playHandsetPickup(sessionRef.current?.toneProfile || 'na');
      } else {
        faxAudio.playButtonClick(860);
      }
      setHandsetOffHook(true);
      setWireMode('sip');
      setVoiceModalTab('dial');
      setVoiceModalOpen(true);
    } else if (keyId === 'MEMO') {
      faxAudio.playButtonClick(740);
      setStagingTab('memo');
      setStagingOpen(true);
    } else if (keyId === 'REDIAL') {
      faxAudio.playButtonClick(700);
      setDialNumber(lastDialed);
      setLcdMode('READY');
    } else if (keyId === 'TONE') {
      const next = !muted;
      setMuted(next);
      faxAudio.setMuted(next);
    } else if (keyId === 'START') {
      faxAudio.playButtonClick(920);
      let target = null;
      if (lcdMode === 'DIRECTORY' && directory[dirIndex]) {
        target = directory[dirIndex].display_number;
        setDialNumber(target);
        setLcdMode('READY');
      }
      if (liveCallRef.current?.state === 'INCOMING') {
        handleAnswerLiveCall(liveCallRef.current.callId);
      } else if (handsetOffHook && !staged) {
        handlePlaceSipCall({ toNumber: target || dialNumber, codec: sipCodec });
      } else {
        handleSendFax(target);
      }
    } else if (keyId === 'STOP') {
      faxAudio.playButtonClick(380);
      if (liveCallRef.current) {
        handleHangupLiveCall(liveCallRef.current.callId);
      }
      if (handsetOffHook) faxAudio.playHandsetHangup();
      setHandsetOffHook(false);
      setAlertBanner(null);
      setLcdMode('READY');
      faxAudio.stopAll();
    }
  }, [
    alertBanner,
    lcdMode,
    directory,
    dirIndex,
    lastDialed,
    muted,
    fine,
    coverEnabled,
    stormyLine,
    sipCodec,
    handsetOffHook,
    staged,
    dialNumber,
    showToast,
    handleSendFax,
    handlePlaceSipCall,
    handleAnswerLiveCall,
    handleHangupLiveCall,
  ]);

  // Global keyboard dialing when no text input or modal is focused
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (stagingOpen || dirOpen || viewerFax || voiceModalOpen) return;
      if (/^[0-9*#]$/.test(e.key)) {
        handle3DKeyPress(e.key);
      } else if (e.key === 'Backspace') {
        handle3DKeyPress('CLR');
      } else if (e.key === 'Enter') {
        handle3DKeyPress('START');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handle3DKeyPress, stagingOpen, dirOpen, viewerFax, voiceModalOpen]);

  const handleCopyMyNumber = () => {
    if (!session?.displayNumber) return;
    navigator.clipboard?.writeText(session.displayNumber).catch(() => {});
    setCopiedNum(true);
    setTimeout(() => setCopiedNum(false), 1800);
    showToast(`Copied your fax & SIP number: ${session.displayNumber}`);
  };

  const handleSaveDirectory = async ({ displayName, listed }) => {
    const res = await fetch('/api/directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, listed }),
    });
    const data = await res.json();
    setSession((prev) => (prev ? { ...prev, displayName: data.displayName, listed: data.listed } : prev));
    setDirectory(data.directory || []);
  };

  const handleBlockSender = async (senderNumber) => {
    await fetch('/api/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderNumber }),
    });
    showToast(`Blocked ${senderNumber}. Future calls will receive 486 Busy.`);
  };

  return (
    <div className="app-shell">
      <h1 className="sr-only">RetroFax T.38 — 1990s 3D Fax Machine & SIP Voice Workstation</h1>

      {/* Full-Viewport 3D Desk & Fax Machine */}
      <FaxScene3D
        state={{
          session,
          dialNumber,
          lcdMode,
          dirIndex,
          directory,
          fine,
          coverEnabled,
          stormyLine,
          handsetOffHook,
          sipCodec,
          wsConnected,
          staged,
          txState,
          rxState,
          callState,
          rxCallState,
          deskPrintedFax,
          alertBanner,
        }}
        cameraPreset={cameraPreset}
        onTriggerUpload={handleQuickFileOrOpen}
        onToggleHandset={handleToggleHandset}
        onKeyPress={handle3DKeyPress}
        onInspectPrintedFax={() => {
          if (deskPrintedFax) {
            setViewerMode('received');
            setViewerFax(deskPrintedFax);
            setDeskPrintedFax(null);
          }
        }}
        onCopyNumber={handleCopyMyNumber}
        onFocusConsole={() => setCameraPreset('console')}
      />

      {/* Top Left Windows-95 Identity & Address Book Panel */}
      <header className="hud-top-left">
        <div className="win95-window brand-plate">
          <div className="win95-titlebar mini">
            <span>RETROFAX.EXE</span>
          </div>
          <div className="brand-inner">
            <div className="brand-badge">RETROFAX T.38 + SIP</div>
            <span className="brand-sub">ITU-T T.38 &amp; G.711/G.722/G.729</span>
          </div>
        </div>

        <div className="win95-window my-line-pill">
          <span className="flag-emoji" title={session?.countryName || 'Detected Country'}>
            {session?.flag || '📠'}
          </span>
          <div className="my-line-meta">
            <span className="mini-lbl">YOUR LINE ({session?.country || '...'})</span>
            <strong id="my-fax-number">{session?.displayNumber || 'Assigning...'}</strong>
          </div>
          <button
            id="btn-copy-number"
            className="win95-btn chip-btn"
            onClick={handleCopyMyNumber}
            title="Copy your cookie-persisted fax & SIP number"
          >
            {copiedNum ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            id="btn-open-directory"
            className="win95-btn chip-btn accent"
            onClick={() => setDirOpen(true)}
          >
            <BookUser size={14} />
            <span>Address Book ({directory.length})</span>
          </button>
        </div>
      </header>

      {/* Top Right 1990s Camera, Inbox, SIP Voice & Audio Bar */}
      <div className="hud-top-right">
        <div className="win95-window camera-group" role="group" aria-label="Camera View">
          <Camera size={14} />
          <button
            id="btn-cam-desk"
            className={`cam-btn ${cameraPreset === 'desk' ? 'active' : ''}`}
            onClick={() => setCameraPreset('desk')}
          >
            Desk
          </button>
          <button
            id="btn-cam-console"
            className={`cam-btn ${cameraPreset === 'console' ? 'active' : ''}`}
            onClick={() => setCameraPreset('console')}
          >
            Keypad &amp; LCD
          </button>
          <button
            id="btn-cam-output"
            className={`cam-btn ${cameraPreset === 'output' ? 'active' : ''}`}
            onClick={() => setCameraPreset('output')}
          >
            Output Tray
          </button>
        </div>

        <button
          id="btn-open-voice"
          className={`win95-btn hud-btn ${handsetOffHook || callState.active ? 'voice-active' : ''}`}
          onClick={() => {
            setHandsetOffHook(true);
            setWireMode('sip');
            setVoiceModalTab('dial');
            setVoiceModalOpen(true);
          }}
        >
          <Phone size={15} />
          <span>Voice ({callsInbox.length})</span>
        </button>

        <button
          id="btn-open-inbox"
          className="win95-btn hud-btn"
          onClick={() => {
            if (inbox[0]) {
              setViewerMode('received');
              setViewerFax(inbox[0]);
            } else {
              showToast('No received faxes yet! Try dialing Echo Bot (+1 555 010-0000).');
            }
          }}
        >
          <Inbox size={15} />
          <span>Inbox ({inbox.length})</span>
        </button>

        <button
          id="btn-toggle-mute"
          className="win95-btn hud-btn"
          onClick={() => {
            const next = !muted;
            setMuted(next);
            faxAudio.setMuted(next);
          }}
          title={muted ? 'Unmute speaker audio' : 'Mute speaker audio'}
        >
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
      </div>

      {/* Incoming Live SIP Voice Call Banner */}
      {liveCall?.state === 'INCOMING' && (
        <div id="incoming-live-call-banner" className="win95-window incoming-call-banner" role="alertdialog" aria-live="assertive">
          <div className="win95-titlebar">
            <span>SIPPHONE.EXE — INCOMING LIVE CALL</span>
          </div>
          <div className="incoming-call-body">
            <div>
              <strong>{liveCall.peerName || 'Online Visitor'}</strong>
              <span className="incoming-call-sub">
                {liveCall.peerNumber} • Codec: {liveCall.codec}
              </span>
            </div>
            <div className="incoming-call-actions">
              <button
                id="btn-banner-answer-call"
                type="button"
                className="btn-primary"
                onClick={() => handleAnswerLiveCall(liveCall.callId)}
              >
                <PhoneIncoming size={14} /> Answer Handset
              </button>
              <button
                id="btn-banner-decline-call"
                type="button"
                className="btn-danger"
                onClick={() => handleDeclineLiveCall(liveCall.callId)}
              >
                <PhoneOff size={14} /> Decline
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className="win95-window retro-toast" role="status">
          <span>{toast.text}</span>
          {toast.action && (
            <button className="win95-btn toast-action" onClick={toast.action.onClick}>
              <FileCheck2 size={14} /> {toast.action.label}
            </button>
          )}
        </div>
      )}

      {/* Bottom Left Status Strip */}
      <div className="hud-bottom-left">
        <div className="win95-window desk-guide-bar">
          <span className="guide-start-badge">1994</span>
          <span className="guide-sunken">
            {liveCall?.state === 'ACTIVE'
              ? `LIVE SIP CALL [${liveCall.codec}] with ${liveCall.peerNumber} (${liveCall.txPackets} TX / ${liveCall.rxPackets} RX RTP)`
              : handsetOffHook
              ? `HANDSET OFF-HOOK [${sipCodec}] — Cycle [CODEC] or click [VOICE] / [START] to Place SIP RTP Call`
              : staged
              ? `TRAY READY: ${staged.sourceLabel.slice(0, 22)}${coverEnabled ? ' [+COVER]' : ''} — Press [START] for T.38 Fax`
              : 'Top Tray = T.38 Fax • Handset / [VOICE] = Live SIP Call (G.711u/a, G.722, G.729) • [CODEC] to Switch'}
          </span>
        </div>
      </div>

      {/* Bottom Right 90s CRT T.38 / SIP+RTP Protocol Wire Log */}
      <T38Inspector
        open={inspectorOpen}
        logs={t38Logs}
        mode={wireMode}
        sipCodec={sipCodec}
        onToggle={() => setInspectorOpen((o) => !o)}
        onClear={() => setT38Logs([])}
      />

      {/* Modals */}
      <StagingModal
        open={stagingOpen}
        initialTab={stagingTab}
        session={session}
        dialNumber={dialNumber}
        fine={fine}
        stormyLine={stormyLine}
        coverEnabled={coverEnabled}
        serverConversion={capabilities?.serverConversion !== false}
        onSetFine={setFine}
        onSetStormyLine={setStormyLine}
        onSetCoverEnabled={setCoverEnabled}
        onClose={() => setStagingOpen(false)}
        onStagedSuccess={handleStagedSuccess}
      />

      <VoiceCallModal
        open={voiceModalOpen}
        initialTab={voiceModalTab}
        session={session}
        directory={directory}
        dialNumber={dialNumber}
        onChangeDialNumber={(n) => {
          setDialNumber(n);
          setLcdMode('READY');
        }}
        sipCodec={sipCodec}
        onChangeSipCodec={(c) => {
          setSipCodec(c);
          setWireMode('sip');
        }}
        stormyLine={stormyLine}
        onSetStormyLine={setStormyLine}
        muted={muted}
        callState={callState}
        liveCall={liveCall}
        liveVu={liveVu}
        micMuted={micMuted}
        onToggleMicMute={handleToggleMicMute}
        onSendLivePhrase={handleSendLivePhrase}
        onAnswerLiveCall={handleAnswerLiveCall}
        onDeclineLiveCall={handleDeclineLiveCall}
        onHangupLiveCall={handleHangupLiveCall}
        activeCallResult={activeCallResult}
        onSelectCallResult={(c) => setActiveCallResult(c)}
        callsInbox={callsInbox}
        onPlaceCall={handlePlaceSipCall}
        onHangup={() => {
          if (liveCall) {
            handleHangupLiveCall(liveCall.callId);
          } else {
            if (handsetOffHook) faxAudio.playHandsetHangup();
            setHandsetOffHook(false);
          }
          setVoiceModalOpen(false);
        }}
        onClose={() => setVoiceModalOpen(false)}
      />

      <DirectoryModal
        open={dirOpen}
        session={session}
        geo={geo}
        directory={directory}
        onSaveProfile={handleSaveDirectory}
        onSelectNumber={(num) => {
          faxAudio.playDTMF('5');
          setDialNumber(num);
          setLcdMode('READY');
        }}
        onClose={() => setDirOpen(false)}
      />

      <FaxViewerModal
        fax={viewerFax}
        mode={viewerMode}
        onClose={() => setViewerFax(null)}
        onBlockSender={handleBlockSender}
      />
    </div>
  );
}
