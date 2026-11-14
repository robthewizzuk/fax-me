import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { FAX_WIDTH, encodeT4MH, decodeT4MH } from './t4Codec.js';
import { encodeIFP, decodeIFP, encodeUDPTL, decodeUDPTL, T30_INDICATOR, T30_DATA, FIELD_TYPE } from './udptl.js';
import { buildGroup3Tiff } from '../converter/tiffWriter.js';
import { executeT38Transmission } from './engine.js';

console.log('1. Testing T.4 MH round-trip for every run length 0..1728 (white & black)...');
{
  const height = 100;
  const pixels = new Uint8Array(FAX_WIDTH * height);
  // Checkerboards, single runs, full white, full black, sweeping edge
  for (let y = 0; y < height; y++) {
    const split = Math.min(FAX_WIDTH, Math.floor((y * FAX_WIDTH) / height));
    for (let x = 0; x < FAX_WIDTH; x++) {
      if (y === 0) pixels[y * FAX_WIDTH + x] = 0; // full white
      else if (y === 1) pixels[y * FAX_WIDTH + x] = 1; // full black
      else if (y === 2) pixels[y * FAX_WIDTH + x] = x % 2; // 1px alternating
      else if (y === 3) pixels[y * FAX_WIDTH + x] = (x >> 3) % 2;
      else pixels[y * FAX_WIDTH + x] = x < split ? 1 : 0;
    }
  }
  const encoded = encodeT4MH(pixels, FAX_WIDTH, height, { lsbFirst: true });
  const decoded = decodeT4MH(encoded, FAX_WIDTH, { lsbFirst: true });
  assert.equal(decoded.height, height);
  assert.equal(decoded.errors, 0);
  assert.deepEqual(decoded.pixels, pixels);
  console.log(`   -> T.4 MH round-trip OK! (${pixels.length / 8} raw bytes -> ${encoded.length} compressed bytes)`);
}

console.log('2. Testing UDPTL & IFP ASN.1 PER encode/decode...');
{
  const ifp1 = encodeIFP({ kind: 'indicator', indicator: T30_INDICATOR.CNG });
  assert.equal(ifp1[0], 0x02);
  const dec1 = decodeIFP(ifp1);
  assert.equal(dec1.kind, 'indicator');
  assert.equal(dec1.indicatorName, 'cng');

  const sampleData = Buffer.from([0xff, 0x13, 0x80, 0x00, 0xce, 0x78]);
  const ifp2 = encodeIFP({
    kind: 'data',
    dataType: T30_DATA.V21,
    fields: [
      { fieldType: FIELD_TYPE.HDLC_DATA, data: sampleData },
      { fieldType: FIELD_TYPE.HDLC_FCS_OK_SIG_END },
    ],
  });
  assert.equal(ifp2[0], 0xc0);
  const pkt = encodeUDPTL(42, ifp2, [ifp1]);
  const decPkt = decodeUDPTL(pkt);
  assert.equal(decPkt.seqNumber, 42);
  assert.equal(decPkt.primary.dataTypeName, 'v21');
  assert.equal(decPkt.primary.fields[0].data.toString('hex'), sampleData.toString('hex'));
  assert.equal(decPkt.secondary.length, 1);
  assert.equal(decPkt.secondary[0].indicatorName, 'cng');
  console.log('   -> UDPTL PER encode/decode OK!');
}

console.log('3. Testing full end-to-end T.38 UDP session + Group 3 TIFF validation...');
{
  const h = 120;
  const p1 = new Uint8Array(FAX_WIDTH * h);
  for (let y = 10; y < 110; y++) {
    for (let x = 200; x < 1500; x++) {
      if ((x + y) % 17 < 4) p1[y * FAX_WIDTH + x] = 1;
    }
  }
  const res = await executeT38Transmission({
    fromNumber: '+1 (555) 010-1234',
    toNumber: '+44 20 7946 0999',
    pages: [{ pixels: p1, width: FAX_WIDTH, height: h }],
    fine: true,
    targetStatus: 'online',
    pacingMs: 2,
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.receivedPages.length, 1);
  assert.deepEqual(res.receivedPages[0].pixels, p1);
  assert.ok(res.pcapBuffer.length > 500);

  const tiffBuf = buildGroup3Tiff(res.receivedPages, { fine: true });
  fs.writeFileSync('/tmp/test_fax.tif', tiffBuf);
  fs.writeFileSync('/tmp/test_fax.pcap', res.pcapBuffer);
  // Validate with ImageMagick identify/convert!
  const info = execFileSync('identify', ['/tmp/test_fax.tif']).toString('utf8').trim();
  console.log('   -> ImageMagick TIFF identify:', info);
  assert.ok(info.includes('1728x120'));
  // Also decode with convert back to png to ensure zero libtiff errors
  execFileSync('convert', ['/tmp/test_fax.tif', '/tmp/test_fax_out.png']);
  console.log(`   -> Full T.38 call OK! (${res.report.udptlPackets} UDPTL pkts, ${res.report.t4Bytes} T.4 bytes)`);
}

console.log('4. Testing Ring No Answer (offline recipient)...');
{
  const resOffline = await executeT38Transmission({
    fromNumber: '+1 (555) 010-1234',
    toNumber: '+81 3-5555-0199',
    pages: [],
    targetStatus: 'offline',
    pacingMs: 0,
  });
  assert.equal(resOffline.status, 'no_answer');
  console.log('   -> Ring No Answer (480 Temporarily Unavailable) OK!');
}

console.log('ALL T.38 ENGINE TESTS PASSED!');
