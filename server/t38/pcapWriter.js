/**
 * Standard libpcap (.pcap) writer wrapping real SIP/SDP and T.38 UDPTL UDP payloads
 * with valid Ethernet II + IPv4 (with checksum) + UDP headers.
 * Link-layer header type: LINKTYPE_ETHERNET (1).
 */

function ipChecksum(header) {
  let sum = 0;
  for (let i = 0; i < header.length; i += 2) {
    if (i === 10) continue; // skip checksum field
    sum += header.readUInt16BE(i);
  }
  while (sum >>> 16) {
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return (~sum) & 0xffff;
}

export class PcapWriter {
  constructor() {
    this.chunks = [];
    // Global 24-byte libpcap header (little-endian)
    const hdr = Buffer.alloc(24);
    hdr.writeUInt32LE(0xa1b2c3d4, 0); // magic_number
    hdr.writeUInt16LE(2, 4); // version_major
    hdr.writeUInt16LE(4, 6); // version_minor
    hdr.writeInt32LE(0, 8); // thiszone
    hdr.writeUInt32LE(0, 12); // sigfigs
    hdr.writeUInt32LE(65535, 16); // snaplen
    hdr.writeUInt32LE(1, 20); // LINKTYPE_ETHERNET
    this.chunks.push(hdr);
    this.startTimeMs = Date.now();
  }

  /**
   * Append a UDP datagram packet to the capture
   */
  addUdpPacket({
    srcIp = [127, 0, 0, 1],
    dstIp = [127, 0, 0, 1],
    srcPort,
    dstPort,
    payload,
    timestampMs = Date.now(),
    fromSender = true,
  }) {
    const udpLen = 8 + payload.length;
    const ipLen = 20 + udpLen;
    const ethLen = 14 + ipLen;

    const frame = Buffer.alloc(ethLen);
    // Ethernet II header (14 bytes)
    const srcMac = fromSender
      ? [0x02, 0xfa, 0x00, 0x00, 0x00, 0x01]
      : [0x02, 0xfa, 0x00, 0x00, 0x00, 0x02];
    const dstMac = fromSender
      ? [0x02, 0xfa, 0x00, 0x00, 0x00, 0x02]
      : [0x02, 0xfa, 0x00, 0x00, 0x00, 0x01];
    Buffer.from(dstMac).copy(frame, 0);
    Buffer.from(srcMac).copy(frame, 6);
    frame.writeUInt16BE(0x0800, 12); // EtherType IPv4

    // IPv4 header (20 bytes)
    const ip = frame.subarray(14, 34);
    ip[0] = 0x45; // v4, IHL=5
    ip[1] = 0x00;
    ip.writeUInt16BE(ipLen, 2);
    ip.writeUInt16BE(this.chunks.length & 0xffff, 4); // ID
    ip.writeUInt16BE(0x4000, 6); // Don't fragment
    ip[8] = 64; // TTL
    ip[9] = 17; // UDP
    ip.writeUInt16BE(0, 10);
    ip[12] = srcIp[0]; ip[13] = srcIp[1]; ip[14] = srcIp[2]; ip[15] = srcIp[3];
    ip[16] = dstIp[0]; ip[17] = dstIp[1]; ip[18] = dstIp[2]; ip[19] = dstIp[3];
    ip.writeUInt16BE(ipChecksum(ip), 10);

    // UDP header (8 bytes)
    const udp = frame.subarray(34, 42);
    udp.writeUInt16BE(srcPort & 0xffff, 0);
    udp.writeUInt16BE(dstPort & 0xffff, 2);
    udp.writeUInt16BE(udpLen, 4);
    udp.writeUInt16BE(0, 6); // optional IPv4 UDP checksum = 0

    // Payload
    payload.copy(frame, 42);

    // Per-packet 16-byte pcap header
    const sec = Math.floor(timestampMs / 1000);
    const usec = Math.floor((timestampMs % 1000) * 1000);
    const pktHdr = Buffer.alloc(16);
    pktHdr.writeUInt32LE(sec >>> 0, 0);
    pktHdr.writeUInt32LE(usec >>> 0, 4);
    pktHdr.writeUInt32LE(frame.length, 8);
    pktHdr.writeUInt32LE(frame.length, 12);

    this.chunks.push(pktHdr, frame);
  }

  toBuffer() {
    return Buffer.concat(this.chunks);
  }
}
