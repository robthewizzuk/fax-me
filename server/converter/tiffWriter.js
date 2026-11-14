import { FAX_WIDTH, encodeT4MH, reverseBitsByte } from '../t38/t4Codec.js';

/**
 * Write a standards-compliant multi-page CCITT Group 3 (T.4 1D MH) TIFF file.
 * Uses FillOrder=1 (MSB-first) for maximum compatibility with OS viewers & libtiff.
 * @param {Array<{ pixels: Uint8Array, width?: number, height: number }>} pages
 * @param {{ fine?: boolean, stationId?: string }} opts
 * @returns {Buffer}
 */
export function buildGroup3Tiff(pages, opts = {}) {
  const fine = opts.fine !== undefined ? opts.fine : true;
  const software = 'RetroFax T.38 FoIP Engine v1.0\0';

  // Pre-encode each page's T.4 MH stream (FillOrder=1 / MSB-first for TIFF)
  const pageEntries = pages.map((page) => {
    const width = page.width || FAX_WIDTH;
    const t4Buf = encodeT4MH(page.pixels, width, page.height, { lsbFirst: false });
    return {
      width,
      height: page.height,
      strip: t4Buf,
    };
  });

  // Compute binary layout:
  // 8-byte TIFF Header -> IFDs & extra tag data -> image strips
  const PARTS = [];
  const hdr = Buffer.alloc(8);
  hdr.write('II', 0, 'ascii'); // Little-endian
  hdr.writeUInt16LE(42, 2);
  hdr.writeUInt32LE(8, 4); // First IFD at offset 8
  PARTS.push(hdr);

  let cursor = 8;
  const NUM_TAGS = 15;
  const ifdByteSize = 2 + NUM_TAGS * 12 + 4;

  // Calculate total offsets per page
  const pageBlocks = pageEntries.map((entry) => {
    const ifdOffset = cursor;
    cursor += ifdByteSize;
    const xResOffset = cursor; cursor += 8;
    const yResOffset = cursor; cursor += 8;
    const softOffset = cursor; cursor += software.length + (software.length % 2);
    const stripOffset = cursor; cursor += entry.strip.length;
    return {
      ...entry,
      ifdOffset,
      xResOffset,
      yResOffset,
      softOffset,
      stripOffset,
      nextIfdOffset: 0,
    };
  });

  for (let i = 0; i < pageBlocks.length - 1; i++) {
    pageBlocks[i].nextIfdOffset = pageBlocks[i + 1].ifdOffset;
  }

  for (let i = 0; i < pageBlocks.length; i++) {
    const pb = pageBlocks[i];
    const ifd = Buffer.alloc(ifdByteSize);
    ifd.writeUInt16LE(NUM_TAGS, 0);
    let pos = 2;

    const writeTag = (tag, type, count, valueOrOffset) => {
      ifd.writeUInt16LE(tag, pos);
      ifd.writeUInt16LE(type, pos + 2);
      ifd.writeUInt32LE(count, pos + 4);
      ifd.writeUInt32LE(valueOrOffset >>> 0, pos + 8);
      pos += 12;
    };

    // Tags MUST be sorted in ascending tag ID order per TIFF 6.0 spec
    writeTag(254, 4, 1, 2); // NewSubfileType: PAGE (2)
    writeTag(256, 4, 1, pb.width); // ImageWidth
    writeTag(257, 4, 1, pb.height); // ImageLength
    writeTag(258, 3, 1, 1); // BitsPerSample = 1
    writeTag(259, 3, 1, 3); // Compression = 3 (CCITT Group 3 / T.4)
    writeTag(262, 3, 1, 0); // PhotometricInterpretation = 0 (WhiteIsZero)
    writeTag(266, 3, 1, 1); // FillOrder = 1 (MSB first)
    writeTag(273, 4, 1, pb.stripOffset); // StripOffsets
    writeTag(278, 4, 1, pb.height); // RowsPerStrip
    writeTag(279, 4, 1, pb.strip.length); // StripByteCounts
    writeTag(282, 5, 1, pb.xResOffset); // XResolution
    writeTag(283, 5, 1, pb.yResOffset); // YResolution
    writeTag(292, 4, 1, 0); // T4Options = 0 (1D Modified Huffman)
    writeTag(296, 3, 1, 2); // ResolutionUnit = 2 (Inch)
    writeTag(305, 2, software.length, pb.softOffset); // Software
    ifd.writeUInt32LE(pb.nextIfdOffset, pos);
    PARTS.push(ifd);

    const xRes = Buffer.alloc(8);
    xRes.writeUInt32LE(204, 0);
    xRes.writeUInt32LE(1, 4);
    PARTS.push(xRes);

    const yRes = Buffer.alloc(8);
    yRes.writeUInt32LE(fine ? 196 : 98, 0);
    yRes.writeUInt32LE(1, 4);
    PARTS.push(yRes);

    const softBuf = Buffer.alloc(software.length + (software.length % 2), 0);
    softBuf.write(software, 0, 'ascii');
    PARTS.push(softBuf);

    PARTS.push(pb.strip);
  }

  return Buffer.concat(PARTS);
}
