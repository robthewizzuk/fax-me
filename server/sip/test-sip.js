import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  SIP_CODECS,
  encodeAudioForCodec,
  decodeAudioForCodec,
  pcm16ToWav,
  decodeUploadedAudioToPcm16,
} from './codecs.js';
import { buildRtpPacket, parseRtpPacket } from './rtp.js';
import { synthesizeMessageAudio } from './voiceSynth.js';
import { executeSipVoiceCall } from './engine.js';

function dftMag(samples, sr, f, start = 1600, len = 4096) {
  let re = 0;
  let im = 0;
  const w = (2 * Math.PI * f) / sr;
  const n = Math.min(len, samples.length - start);
  for (let i = 0; i < n; i++) {
    const s = samples[start + i] || 0;
    re += s * Math.cos(w * i);
    im -= s * Math.sin(w * i);
  }
  return Math.hypot(re, im) / (n / 2);
}

console.log('1. Testing RFC 3550 RTP 12-byte header pack/parse...');
{
  const payload = Buffer.from([0xab, 0xcd, 0xef, 0x01]);
  const pkt = buildRtpPacket({
    payloadType: 18,
    sequenceNumber: 12345,
    timestamp: 987654321,
    ssrc: 0xdeadbeef,
    marker: true,
    payload,
  });
  assert.equal(pkt.length, 16);
  const parsed = parseRtpPacket(pkt);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.marker, true);
  assert.equal(parsed.payloadType, 18);
  assert.equal(parsed.sequenceNumber, 12345);
  assert.equal(parsed.timestamp, 987654321);
  assert.equal(parsed.ssrc, 0xdeadbeef);
  assert.deepEqual(parsed.payload, payload);
  console.log('   -> RFC 3550 RTP packet pack/parse OK!');
}

console.log('2. Testing real ITU-T G.711u, G.711a, G.722 & G.729A codecs vs FFmpeg...');
{
  // Create 1-sec 16kHz audio containing 440Hz fundamental + 5200Hz wideband harmonic (G.722 should preserve 5200Hz!)
  const sr = 16000;
  const pcm = new Int16Array(sr);
  for (let i = 0; i < sr; i++) {
    pcm[i] = Math.round(
      7000 * Math.sin((2 * Math.PI * 440 * i) / sr) +
      3000 * Math.sin((2 * Math.PI * 5200 * i) / sr)
    );
  }

  for (const codecId of Object.keys(SIP_CODECS)) {
    const { spec, encoded } = await encodeAudioForCodec(pcm, sr, codecId);
    const decoded = await decodeAudioForCodec(encoded, codecId);
    assert.ok(encoded.length > 0);
    assert.ok(decoded.pcm16.length >= decoded.sampleRate * 0.9);
    const rms = Math.sqrt(
      decoded.pcm16.slice(Math.floor(decoded.pcm16.length * 0.4)).reduce((a, b) => a + b * b, 0) /
        (decoded.pcm16.length * 0.6)
    );
    assert.ok(rms > 800, `${codecId} RMS too low: ${rms}`);
    const m440 = dftMag(decoded.pcm16, decoded.sampleRate, 440);
    assert.ok(m440 > 180, `${codecId} failed 440Hz tone check: ${m440}`);
    if (codecId === 'G722') {
      // Wideband G.722 must preserve 5200Hz above narrowband Nyquist (4000Hz)!
      const m5200 = dftMag(decoded.pcm16, 16000, 5200);
      assert.ok(m5200 > 1800, `G.722 failed wideband 5200Hz preservation: ${m5200}`);
      console.log(`   -> ${codecId} wideband 5200Hz mag=${Math.round(m5200)}, 440Hz mag=${Math.round(m440)}`);
    } else {
      console.log(`   -> ${codecId} (${encoded.length}B/1s, RMS=${Math.round(rms)}, 440Hz mag=${Math.round(m440)}) OK!`);
    }
  }
}

console.log('3. Testing full end-to-end SIP/SDP + UDP RTP calls across all 4 codecs...');
{
  const voiceIn = synthesizeMessageAudio('HELLO 1994 TEST 5', 16000);
  for (const codecId of ['G711U', 'G711A', 'G722', 'G729']) {
    const res = await executeSipVoiceCall({
      fromNumber: '+1 (555) 010-1234',
      toNumber: '+1 (555) 010-0000',
      codec: codecId,
      callerPcm16: voiceIn,
      callerSampleRate: 16000,
      targetStatus: 'online',
      botId: 'bot-echo',
      pacingMs: 1,
    });
    assert.equal(res.status, 'ok');
    assert.equal(res.pcapBuffer.readUInt32LE(0), 0xa1b2c3d4, 'Valid libpcap magic');
    assert.equal(res.callerReturnWav.toString('ascii', 0, 4), 'RIFF', 'Valid RIFF WAV');
    assert.ok(res.report.txRtpPackets > 20, `${codecId} txRtpPackets too low`);
    assert.ok(res.report.rxRtpPackets > 20, `${codecId} rxRtpPackets too low`);
    assert.ok(res.logs.some((l) => l.layer === 'SIP' && l.summary.includes('INVITE')));
    assert.ok(res.logs.some((l) => l.layer === 'SIP' && l.summary.includes('200 OK')));
    assert.ok(res.logs.some((l) => l.layer === 'RTP' && l.summary.includes(`PT=${SIP_CODECS[codecId].pt}`)));

    // Verify FFmpeg ffprobe validates our output WAV & round-trip WAV parsing works
    const wavPath = `/tmp/test_sip_${codecId}.wav`;
    fs.writeFileSync(wavPath, res.callerReturnWav);
    const probe = execFileSync('ffprobe', ['-hide_banner', '-loglevel', 'error', '-show_streams', wavPath]).toString('utf8');
    assert.ok(probe.includes(`sample_rate=${SIP_CODECS[codecId].sampleRate}`));

    const reparsed = await decodeUploadedAudioToPcm16(res.callerReturnWav, 8000);
    assert.ok(reparsed.length > 4000);
    console.log(`   -> E2E SIP/${codecId} (PT=${res.report.payloadType}, ${res.report.rtpPackets} RTP pkts, ${res.pcapBuffer.length}B pcap) OK!`);
  }
}

console.log('4. Testing SIP 486 Busy Here and 480 Ring No Answer...');
{
  const dummy = new Int16Array(1600);
  const resBusy = await executeSipVoiceCall({
    fromNumber: '+1 555 010-1234',
    toNumber: '+1 555 010-1994',
    codec: 'G711U',
    callerPcm16: dummy,
    targetStatus: 'busy',
    pacingMs: 0,
  });
  assert.equal(resBusy.status, 'busy');
  assert.ok(resBusy.logs.some((l) => l.summary.includes('486 Busy Here')));

  const resOffline = await executeSipVoiceCall({
    fromNumber: '+1 555 010-1234',
    toNumber: '+44 20 7946 0999',
    codec: 'G729',
    callerPcm16: dummy,
    targetStatus: 'offline',
    pacingMs: 0,
  });
  assert.equal(resOffline.status, 'no_answer');
  assert.ok(resOffline.logs.some((l) => l.summary.includes('480 Temporarily Unavailable')));
  console.log('   -> SIP 486 Busy & 480 No Answer OK!');
}

console.log('ALL SIP/RTP & CODEC TESTS PASSED!');
