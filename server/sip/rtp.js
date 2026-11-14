/**
 * RFC 3550 Real-time Transport Protocol (RTP) fixed 12-byte header pack & parse.
 *
 *  0                   1                   2                   3
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |V=2|P|X|  CC   |M|     PT      |       sequence number         |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                           timestamp                           |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |           synchronization source (SSRC) identifier            |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 */

export function buildRtpPacket({
  payloadType = 0,
  sequenceNumber = 0,
  timestamp = 0,
  ssrc = 0x19940738,
  marker = false,
  payload = Buffer.alloc(0),
}) {
  const pkt = Buffer.allocUnsafe(12 + payload.length);
  pkt[0] = 0x80; // V=2, P=0, X=0, CC=0
  pkt[1] = (marker ? 0x80 : 0x00) | (payloadType & 0x7f);
  pkt.writeUInt16BE(sequenceNumber & 0xffff, 2);
  pkt.writeUInt32BE(timestamp >>> 0, 4);
  pkt.writeUInt32BE(ssrc >>> 0, 8);
  if (payload.length > 0) {
    payload.copy(pkt, 12);
  }
  return pkt;
}

export function parseRtpPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) {
    throw new Error(`Invalid RTP packet length: ${buf?.length ?? 0}`);
  }
  const b0 = buf[0];
  const version = (b0 >> 6) & 0x03;
  if (version !== 2) {
    throw new Error(`Unsupported RTP version: ${version}`);
  }
  const padding = Boolean((b0 >> 5) & 1);
  const extension = Boolean((b0 >> 4) & 1);
  const csrcCount = b0 & 0x0f;
  const b1 = buf[1];
  const marker = Boolean((b1 >> 7) & 1);
  const payloadType = b1 & 0x7f;
  const sequenceNumber = buf.readUInt16BE(2);
  const timestamp = buf.readUInt32BE(4);
  const ssrc = buf.readUInt32BE(8);

  let offset = 12 + csrcCount * 4;
  if (extension && offset + 4 <= buf.length) {
    const extLenWords = buf.readUInt16BE(offset + 2);
    offset += 4 + extLenWords * 4;
  }

  let end = buf.length;
  if (padding && end > offset) {
    const padLen = buf[end - 1];
    if (padLen <= end - offset) end -= padLen;
  }

  return {
    version,
    marker,
    payloadType,
    sequenceNumber,
    timestamp,
    ssrc,
    payload: buf.subarray(Math.min(offset, end), end),
  };
}
