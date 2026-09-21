'use strict';

// Pure-JS JPEG codec (Huffman entropy coding, 8x8 DCT) plus a header-only
// metadata reader. No native code, no WebAssembly.
//
// Supported on decode: 8-bit Huffman JPEG, baseline/extended-sequential and
// progressive (SOF0/SOF1/SOF2), grayscale (1 component) and YCbCr (3
// component), restart intervals. Arithmetic coding, 12-bit precision and
// 4-component CMYK/YCCK are rejected with a clear error rather than faked.
// Supported on encode: baseline sequential, 4:2:0, standard tables.

const { exifOrientation } = require('./exif.cjs');

// natural index of the k-th zig-zag coefficient
const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63
]);

// Orthonormal DCT basis: M[k][n] = 0.5 * C(k) * cos((2n+1)k pi / 16)
const M = (() => {
  const m = [];
  for (let k = 0; k < 8; k++) {
    const row = new Float64Array(8);
    const c = k === 0 ? Math.SQRT1_2 : 1;
    for (let n = 0; n < 8; n++) row[n] = 0.5 * c * Math.cos((2 * n + 1) * k * Math.PI / 16);
    m.push(row);
  }
  return m;
})();

const STD_LUM_QT = new Int32Array([
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99
]);

const STD_CHROM_QT = new Int32Array([
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99
]);

const DC_LUM_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROM_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUM_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUM_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa
];
const AC_CHROM_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROM_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa
];

function isJPEG(buf) {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function readU16(buf, o) { return (buf[o] << 8) | buf[o + 1]; }

// ---------------- header parsing ----------------

function buildDecodeTable(bits, vals) {
  const maxcode = new Int32Array(17).fill(-1);
  const mincode = new Int32Array(17);
  const valptr = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    const n = bits[len];
    if (n > 0) {
      valptr[len] = k;
      mincode[len] = code;
      k += n;
      code += n;
      maxcode[len] = code - 1;
    }
    code <<= 1;
  }
  return { maxcode, mincode, valptr, vals };
}

function parseSOF(st, seg, marker) {
  if (st.frame) return;
  const precision = seg[0];
  const height = readU16(seg, 1);
  const width = readU16(seg, 3);
  const n = seg[5];
  if (width < 1 || height < 1) throw new Error('JPEG has invalid dimensions');
  const components = [];
  let maxH = 1;
  let maxV = 1;
  let o = 6;
  for (let i = 0; i < n; i++) {
    const id = seg[o];
    const hv = seg[o + 1];
    const tq = seg[o + 2];
    o += 3;
    const h = hv >> 4;
    const v = hv & 15;
    if (h < 1 || h > 4 || v < 1 || v > 4) throw new Error('invalid JPEG sampling factor');
    components.push({ id, h, v, tq });
    if (h > maxH) maxH = h;
    if (v > maxV) maxV = v;
  }
  const progressive = marker === 0xc2;
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));
  for (const c of components) {
    const compW = Math.ceil(width * c.h / maxH);
    const compH = Math.ceil(height * c.v / maxV);
    c.blocksPerLine = Math.ceil(compW / 8);
    c.blocksPerColumn = Math.ceil(compH / 8);
    c.blocksPerLineForMcu = mcusPerLine * c.h;
    c.blocksPerColumnForMcu = mcusPerColumn * c.v;
    c.coeff = new Int32Array(c.blocksPerLineForMcu * c.blocksPerColumnForMcu * 64);
  }
  st.frame = { precision, width, height, components, maxH, maxV, mcusPerLine, mcusPerColumn, progressive };
}

function parseDQT(st, seg) {
  let o = 0;
  while (o < seg.length) {
    const pq = seg[o] >> 4;
    const tq = seg[o] & 15;
    o++;
    const q = new Int32Array(64);
    if (pq === 0) {
      for (let i = 0; i < 64; i++) q[ZIGZAG[i]] = seg[o + i];
      o += 64;
    } else if (pq === 1) {
      for (let i = 0; i < 64; i++) q[ZIGZAG[i]] = readU16(seg, o + i * 2);
      o += 128;
    } else {
      throw new Error('unsupported JPEG quantisation precision');
    }
    st.quant[tq] = q;
  }
}

function parseDHT(st, seg) {
  let o = 0;
  while (o < seg.length) {
    const info = seg[o++];
    const cls = info >> 4;
    const id = info & 15;
    const bits = new Int32Array(17);
    let total = 0;
    for (let i = 1; i <= 16; i++) { bits[i] = seg[o++]; total += bits[i]; }
    const vals = seg.subarray(o, o + total);
    o += total;
    const table = buildDecodeTable(bits, vals);
    if (cls === 0) st.huffDC[id] = table;
    else st.huffAC[id] = table;
  }
}

function parseSOS(st, seg) {
  const n = seg[0];
  const components = [];
  let o = 1;
  for (let i = 0; i < n; i++) {
    const id = seg[o++];
    const t = seg[o++];
    const index = st.frame.components.findIndex((c) => c.id === id);
    if (index < 0) throw new Error('JPEG scan references unknown component');
    components.push({ index, dcTable: t >> 4, acTable: t & 15 });
  }
  const Ss = seg[o++];
  const Se = seg[o++];
  const AhAl = seg[o++];
  return { components, Ss, Se, Ah: AhAl >> 4, Al: AhAl & 15 };
}

function parseAPP1(st, seg) {
  const isExif = seg.length >= 6 && seg[0] === 0x45 && seg[1] === 0x78 && seg[2] === 0x69 && seg[3] === 0x66;
  if (isExif) { st.metadata.exif = Buffer.from(seg); return; }
  const prefix = 'http://ns.adobe.com/xap/1.0/';
  if (seg.length > prefix.length && seg.toString('latin1', 0, prefix.length) === prefix) {
    st.metadata.xmp = Buffer.from(seg.subarray(prefix.length + 1));
  }
}

function parseAPP2(st, seg) {
  const prefix = 'ICC_PROFILE';
  if (seg.length > 12 && seg.toString('latin1', 0, 11) === prefix) {
    const seq = seg[12];
    const data = seg.subarray(14);
    if (!st.metadata._iccParts) st.metadata._iccParts = [];
    if (seq >= 1 && seq <= 255) st.metadata._iccParts[seq - 1] = Buffer.from(data);
  }
}

function parseJPEG(buf, decode) {
  if (!isJPEG(buf)) throw new Error('not a JPEG');
  const st = {
    quant: [],
    huffDC: [],
    huffAC: [],
    frame: null,
    restartInterval: 0,
    metadata: {},
    adobe: null
  };
  let pos = 2;
  const len = buf.length;
  while (pos + 1 < len) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    while (pos < len && buf[pos] === 0xff) pos++;
    if (pos >= len) break;
    const marker = buf[pos++];
    if (marker === 0x00) continue;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xd9) break;
    if (pos + 2 > len) break;
    const segLen = readU16(buf, pos);
    if (segLen < 2 || pos + segLen > len) throw new Error('truncated JPEG segment');
    const seg = buf.subarray(pos + 2, pos + segLen);
    pos += segLen;
    switch (marker) {
      case 0xc0: case 0xc1: case 0xc2:
        parseSOF(st, seg, marker);
        break;
      case 0xc3: case 0xc5: case 0xc6: case 0xc7: case 0xc9: case 0xca: case 0xcb: case 0xcd: case 0xce: case 0xcf:
        throw new Error('unsupported JPEG frame type 0x' + marker.toString(16));
      case 0xc4: parseDHT(st, seg); break;
      case 0xdb: parseDQT(st, seg); break;
      case 0xdd: st.restartInterval = readU16(seg, 0); break;
      case 0xda: {
        if (!st.frame) throw new Error('JPEG scan before frame header');
        const scan = parseSOS(st, seg);
        if (decode) {
          if (st.frame.precision !== 8) throw new Error('only 8-bit JPEG is supported by the pure-JS iOS build');
          pos = decodeScan(buf, pos, st, scan);
        }
        break;
      }
      case 0xe1: parseAPP1(st, seg); break;
      case 0xe2: parseAPP2(st, seg); break;
      case 0xed: st.metadata.iptc = Buffer.from(seg); break;
      case 0xee: st.adobe = Buffer.from(seg); break;
      case 0xfe:
        if (!st.metadata.comments) st.metadata.comments = [];
        st.metadata.comments.push(Buffer.from(seg));
        break;
      default: break;
    }
  }
  if (st.metadata._iccParts) {
    const parts = st.metadata._iccParts.filter(Boolean);
    if (parts.length) st.metadata.icc = Buffer.concat(parts);
    delete st.metadata._iccParts;
  }
  if (!st.frame) throw new Error('JPEG missing frame header');
  return st;
}

// ---------------- entropy decode ----------------

class BitReader {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos;
    this.bitBuf = 0;
    this.bitCnt = 0;
    this.eof = false;
  }

  loadByte() {
    if (this.pos >= this.buf.length) { this.eof = true; return false; }
    const b = this.buf[this.pos];
    if (b === 0xff) {
      const b2 = this.pos + 1 < this.buf.length ? this.buf[this.pos + 1] : 0xd9;
      if (b2 === 0x00) { this.pos += 2; this.bitBuf = 0xff; this.bitCnt = 8; return true; }
      if (b2 === 0xff) { this.pos++; return this.loadByte(); }
      this.eof = true;
      return false;
    }
    this.pos++;
    this.bitBuf = b;
    this.bitCnt = 8;
    return true;
  }

  readBit() {
    if (this.bitCnt === 0) { if (!this.loadByte()) return 0; }
    this.bitCnt--;
    return (this.bitBuf >> this.bitCnt) & 1;
  }

  readBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit();
    return v;
  }

  align() { this.bitCnt = 0; }

  readRestart() {
    while (this.pos + 1 < this.buf.length && this.buf[this.pos] === 0xff && this.buf[this.pos + 1] === 0xff) this.pos++;
    if (this.pos + 1 < this.buf.length && this.buf[this.pos] === 0xff && this.buf[this.pos + 1] >= 0xd0 && this.buf[this.pos + 1] <= 0xd7) {
      this.pos += 2;
      return;
    }
    throw new Error('JPEG restart marker expected');
  }
}

function extend(v, t) {
  if (t === 0) return 0;
  return v < (1 << (t - 1)) ? v - (1 << t) + 1 : v;
}

function readHuffman(reader, table) {
  let code = reader.readBit();
  let len = 1;
  while (code > table.maxcode[len]) {
    code = (code << 1) | reader.readBit();
    len++;
    if (len > 16) throw new Error('invalid JPEG Huffman code');
  }
  const idx = table.valptr[len] + code - table.mincode[len];
  const v = table.vals[idx];
  if (v === undefined) throw new Error('invalid JPEG Huffman value');
  return v;
}

function decodeBaselineBlock(reader, q, dcTable, acTable, coeff, off, preds, ci) {
  const t = readHuffman(reader, dcTable);
  if (t > 11) throw new Error('invalid JPEG DC magnitude');
  if (t > 0) preds[ci] += extend(reader.readBits(t), t);
  coeff[off] = preds[ci];
  let k = 1;
  while (k < 64) {
    const rs = readHuffman(reader, acTable);
    const s = rs & 15;
    const r = rs >> 4;
    if (s === 0) {
      if (r === 15) { k += 16; continue; }
      break;
    }
    k += r;
    if (k > 63) break;
    coeff[off + ZIGZAG[k]] = extend(reader.readBits(s), s);
    k++;
  }
}

// ---- progressive (SOF2) block helpers ----
// Coefficients are stored quantised (like the baseline path); idctBlock
// multiplies by the quantisation table. Successive approximation therefore
// operates directly on the stored integers.

function decodeDCFirst(reader, dcTable, coeff, off, preds, ci, al) {
  const t = readHuffman(reader, dcTable);
  if (t > 11) throw new Error('invalid JPEG DC magnitude');
  if (t > 0) preds[ci] += extend(reader.readBits(t), t);
  coeff[off] = preds[ci] << al;
}

function decodeDCRefine(reader, coeff, off, al) {
  if (reader.readBit()) coeff[off] |= (1 << al);
}

function decodeACFirst(reader, acTable, coeff, off, ss, se, al, eob) {
  if (eob.run > 0) { eob.run--; return; }
  let k = ss;
  while (k <= se) {
    if (reader.eof) return;
    const rs = readHuffman(reader, acTable);
    const s = rs & 15;
    const r = rs >> 4;
    if (s === 0) {
      if (r < 15) { eob.run = reader.readBits(r) + (1 << r) - 1; break; }
      k += 16;
      continue;
    }
    k += r;
    if (k > se) break;
    coeff[off + ZIGZAG[k]] = extend(reader.readBits(s), s) << al;
    k++;
  }
}

function refineBit(reader, coeff, idx, p1, m1) {
  if (coeff[idx] !== 0 && reader.readBit()) {
    if ((coeff[idx] & p1) === 0) coeff[idx] += coeff[idx] >= 0 ? p1 : m1;
  }
}

function decodeACRefine(reader, acTable, coeff, off, ss, se, al, eob) {
  const p1 = 1 << al;
  const m1 = -p1;
  if (eob.run > 0) {
    // While an end-of-band run is in force, previously-nonzero coefficients in
    // the band still receive their correction bits.
    for (let k = ss; k <= se; k++) refineBit(reader, coeff, off + ZIGZAG[k], p1, m1);
    eob.run--;
    return;
  }
  let k = ss;
  while (k <= se) {
    if (reader.eof) return;
    const rs = readHuffman(reader, acTable);
    const s = rs & 15;
    let r = rs >> 4;
    let newVal = 0;
    if (s !== 0) {
      if (s !== 1) throw new Error('invalid progressive AC refinement symbol');
      newVal = reader.readBit() ? p1 : m1;
    } else if (r !== 15) {
      eob.run = reader.readBits(r) + (1 << r);
      break;
    }
    // Advance over r zero-history coefficients, correcting nonzero ones.
    while (k <= se) {
      const idx = off + ZIGZAG[k];
      if (coeff[idx] !== 0) {
        if (reader.readBit() && (coeff[idx] & p1) === 0) coeff[idx] += coeff[idx] >= 0 ? p1 : m1;
      } else {
        r--;
        if (r < 0) break;
      }
      k++;
    }
    if (newVal !== 0 && k <= se) coeff[off + ZIGZAG[k]] = newVal;
    k++;
  }
  if (eob.run > 0) eob.run--;
}

function decodeScan(buf, pos, st, scan) {
  const frame = st.frame;
  const reader = new BitReader(buf, pos);
  const preds = new Int32Array(frame.components.length);
  const scanComps = scan.components;
  const progressive = frame.progressive;
  const Ss = scan.Ss;
  const Se = scan.Se;
  const Ah = scan.Ah;
  const Al = scan.Al;
  const eob = { run: 0 };

  const restart = () => {
    reader.align();
    reader.readRestart();
    preds.fill(0);
    eob.run = 0;
  };

  const decodeBlock = (sc, bx, by) => {
    const c = frame.components[sc.index];
    const off = (by * c.blocksPerLineForMcu + bx) * 64;
    if (!progressive) {
      const q = st.quant[c.tq];
      if (!q) throw new Error('JPEG missing quantisation table ' + c.tq);
      const dcTable = st.huffDC[sc.dcTable];
      const acTable = st.huffAC[sc.acTable];
      if (!dcTable || !acTable) throw new Error('JPEG missing Huffman table');
      decodeBaselineBlock(reader, q, dcTable, acTable, c.coeff, off, preds, sc.index);
    } else if (Ss === 0 && Ah === 0) {
      const dcTable = st.huffDC[sc.dcTable];
      if (!dcTable) throw new Error('JPEG missing Huffman table');
      decodeDCFirst(reader, dcTable, c.coeff, off, preds, sc.index, Al);
    } else if (Ss === 0) {
      decodeDCRefine(reader, c.coeff, off, Al);
    } else {
      const acTable = st.huffAC[sc.acTable];
      if (!acTable) throw new Error('JPEG missing Huffman table');
      if (Ah === 0) decodeACFirst(reader, acTable, c.coeff, off, Ss, Se, Al, eob);
      else decodeACRefine(reader, acTable, c.coeff, off, Ss, Se, Al, eob);
    }
  };

  let mcu = 0;
  if ((progressive && Ss !== 0) || scanComps.length === 1) {
    // Non-interleaved: one block per MCU, raster over the component's real grid.
    const sc = scanComps[0];
    const c = frame.components[sc.index];
    for (let by = 0; by < c.blocksPerColumn; by++) {
      for (let bx = 0; bx < c.blocksPerLine; bx++) {
        if (st.restartInterval > 0 && mcu > 0 && mcu % st.restartInterval === 0) restart();
        decodeBlock(sc, bx, by);
        mcu++;
      }
    }
  } else {
    for (let my = 0; my < frame.mcusPerColumn; my++) {
      for (let mx = 0; mx < frame.mcusPerLine; mx++) {
        if (st.restartInterval > 0 && mcu > 0 && mcu % st.restartInterval === 0) restart();
        for (const sc of scanComps) {
          const c = frame.components[sc.index];
          for (let v = 0; v < c.v; v++) {
            for (let h = 0; h < c.h; h++) {
              decodeBlock(sc, mx * c.h + h, my * c.v + v);
            }
          }
        }
        mcu++;
      }
    }
  }
  reader.align();
  return reader.pos;
}

// ---------------- IDCT + colour output ----------------

const _dc = new Float64Array(64);
const _tmp = new Float64Array(64);

function idctBlock(coeff, off, q, plane, pw, ph, px, py) {
  const maxY = Math.min(8, ph - py);
  const maxX = Math.min(8, pw - px);
  // Fast path: only the DC coefficient is nonzero (very common in flat areas).
  // The 2-D IDCT of a lone DC term is a constant. Multiply in the same order as
  // the general path so the rounded result stays bit-identical.
  let onlyDC = true;
  for (let n = 1; n < 64; n++) { if (coeff[off + n] !== 0) { onlyDC = false; break; } }
  if (onlyDC) {
    let val = Math.round(M[0][0] * ((coeff[off] * q[0]) * M[0][0])) + 128;
    if (val < 0) val = 0; else if (val > 255) val = 255;
    for (let y = 0; y < maxY; y++) {
      const rowOut = (py + y) * pw + px;
      for (let x = 0; x < maxX; x++) plane[rowOut + x] = val;
    }
    return;
  }
  for (let n = 0; n < 64; n++) _dc[n] = coeff[off + n] * q[n];
  // G[r][y] = sum_v dc[r*8+v] * M[v][y]
  for (let r = 0; r < 8; r++) {
    const base = r * 8;
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += _dc[base + v] * M[v][y];
      _tmp[base + y] = s;
    }
  }
  // f[y][x] = sum_u M[u][y] * tmp[u*8+x]. The first index of a coefficient is the
  // vertical frequency, so the pass-2 contraction must use the *row* coordinate
  // on M and the *column* coordinate on tmp; using them the other way round
  // transposes every 8x8 block.
  for (let y = 0; y < maxY; y++) {
    const rowOut = (py + y) * pw + px;
    for (let x = 0; x < maxX; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += M[u][y] * _tmp[u * 8 + x];
      let val = Math.round(s) + 128;
      if (val < 0) val = 0; else if (val > 255) val = 255;
      plane[rowOut + x] = val;
    }
  }
}

function buildComponentPlanes(st) {
  const frame = st.frame;
  for (const c of frame.components) {
    const q = st.quant[c.tq];
    if (!q) throw new Error('JPEG missing quantisation table ' + c.tq);
    const pw = c.blocksPerLineForMcu * 8;
    const ph = c.blocksPerColumnForMcu * 8;
    const plane = new Uint8ClampedArray(pw * ph);
    for (let by = 0; by < c.blocksPerColumnForMcu; by++) {
      for (let bx = 0; bx < c.blocksPerLineForMcu; bx++) {
        idctBlock(c.coeff, (by * c.blocksPerLineForMcu + bx) * 64, q, plane, pw, ph, bx * 8, by * 8);
      }
    }
    c.plane = plane;
    c.planeW = pw;
    c.planeH = ph;
  }
}

function samplePlane(c, x, y, maxH, maxV) {
  const cx = (x + 0.5) * c.h / maxH - 0.5;
  const cy = (y + 0.5) * c.v / maxV - 0.5;
  let x0 = Math.floor(cx);
  let y0 = Math.floor(cy);
  let fx = cx - x0;
  let fy = cy - y0;
  if (x0 < 0) { x0 = 0; fx = 0; }
  let x1 = x0 + 1;
  if (x1 > c.planeW - 1) x1 = c.planeW - 1;
  if (x0 > c.planeW - 1) { x0 = c.planeW - 1; x1 = c.planeW - 1; fx = 0; }
  if (y0 < 0) { y0 = 0; fy = 0; }
  let y1 = y0 + 1;
  if (y1 > c.planeH - 1) y1 = c.planeH - 1;
  if (y0 > c.planeH - 1) { y0 = c.planeH - 1; y1 = c.planeH - 1; fy = 0; }
  const p = c.plane;
  const w = c.planeW;
  const a = p[y0 * w + x0] * (1 - fx) + p[y0 * w + x1] * fx;
  const b = p[y1 * w + x0] * (1 - fx) + p[y1 * w + x1] * fx;
  return a * (1 - fy) + b * fy;
}

function decodeJPEGPixels(st) {
  const frame = st.frame;
  const comps = frame.components;
  if (frame.precision !== 8) throw new Error('only 8-bit JPEG is supported by the pure-JS iOS build');
  if (comps.length !== 1 && comps.length !== 3) throw new Error('unsupported JPEG component count ' + comps.length);
  buildComponentPlanes(st);
  const W = frame.width;
  const H = frame.height;
  const rgba = new Uint8Array(W * H * 4);
  if (comps.length === 1) {
    const c = comps[0];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = Math.round(samplePlane(c, x, y, frame.maxH, frame.maxV));
        if (v < 0) v = 0; else if (v > 255) v = 255;
        const d = (y * W + x) * 4;
        rgba[d] = v; rgba[d + 1] = v; rgba[d + 2] = v; rgba[d + 3] = 255;
      }
    }
    return rgba;
  }
  let yi = comps.findIndex((c) => c.id === 1);
  let cbi = comps.findIndex((c) => c.id === 2);
  let cri = comps.findIndex((c) => c.id === 3);
  if (yi < 0 || cbi < 0 || cri < 0) { yi = 0; cbi = 1; cri = 2; }
  const Y = comps[yi];
  const Cb = comps[cbi];
  const Cr = comps[cri];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const yy = samplePlane(Y, x, y, frame.maxH, frame.maxV);
      const cb = samplePlane(Cb, x, y, frame.maxH, frame.maxV) - 128;
      const cr = samplePlane(Cr, x, y, frame.maxH, frame.maxV) - 128;
      let r = yy + 1.402 * cr;
      let g = yy - 0.344136 * cb - 0.714136 * cr;
      let b = yy + 1.772 * cb;
      r = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
      g = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
      b = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
      const d = (y * W + x) * 4;
      rgba[d] = r; rgba[d + 1] = g; rgba[d + 2] = b; rgba[d + 3] = 255;
    }
  }
  return rgba;
}

function decodeJPEG(buf) {
  const st = parseJPEG(buf, true);
  const rgba = decodeJPEGPixels(st);
  const f = st.frame;
  return {
    rgba,
    width: f.width,
    height: f.height,
    hasAlpha: false,
    space: f.components.length === 1 ? 'b-w' : 'srgb',
    metadata: jpegMetadataFromState(st)
  };
}

function jpegMetadataFromState(st) {
  const f = st.frame;
  const md = {
    format: 'jpeg',
    width: f.width,
    height: f.height,
    depth: f.precision > 8 ? 'ushort' : 'uchar',
    space: f.components.length === 1 ? 'b-w' : 'srgb',
    channels: f.components.length,
    hasAlpha: false,
    isProgressive: !!f.progressive,
    pages: 1,
    loop: 0
  };
  if (st.metadata.exif) {
    md.exif = st.metadata.exif;
    const o = exifOrientation(st.metadata.exif);
    if (o) md.orientation = o;
  }
  if (st.metadata.icc) { md.icc = st.metadata.icc; md.hasProfile = true; }
  if (st.metadata.xmp) md.xmp = st.metadata.xmp;
  if (st.metadata.iptc) md.iptc = st.metadata.iptc;
  if (st.metadata.comments) md.comments = st.metadata.comments;
  return md;
}

function jpegMetadata(buf) {
  return jpegMetadataFromState(parseJPEG(buf, false));
}

// ---------------- encode ----------------

function buildEncodeTable(bits, vals) {
  const map = new Map();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) {
      map.set(vals[k++], { code, len });
      code++;
    }
    code <<= 1;
  }
  return map;
}

const ENC_DC_LUM = buildEncodeTable(DC_LUM_BITS, DC_VALS);
const ENC_DC_CHROM = buildEncodeTable(DC_CHROM_BITS, DC_VALS);
const ENC_AC_LUM = buildEncodeTable(AC_LUM_BITS, AC_LUM_VALS);
const ENC_AC_CHROM = buildEncodeTable(AC_CHROM_BITS, AC_CHROM_VALS);

function scaleQuant(base, quality) {
  const q = new Int32Array(64);
  const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  for (let i = 0; i < 64; i++) {
    let v = Math.floor((base[i] * scale + 50) / 100);
    if (v < 1) v = 1; else if (v > 255) v = 255;
    q[i] = v;
  }
  return q;
}

class BitWriter {
  constructor() {
    this.chunks = [];
    this.cur = Buffer.allocUnsafe(65536);
    this.curLen = 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }

  flushChunk() {
    if (this.curLen > 0) this.chunks.push(Buffer.from(this.cur.subarray(0, this.curLen)));
    this.curLen = 0;
  }

  emitByte(b) {
    if (this.curLen === this.cur.length) this.flushChunk();
    this.cur[this.curLen++] = b;
    if (b === 0xff) {
      if (this.curLen === this.cur.length) this.flushChunk();
      this.cur[this.curLen++] = 0x00;
    }
  }

  writeBits(value, n) {
    for (let i = n - 1; i >= 0; i--) {
      this.bitBuf = (this.bitBuf << 1) | ((value >> i) & 1);
      this.bitCnt++;
      if (this.bitCnt === 8) {
        this.emitByte(this.bitBuf & 0xff);
        this.bitBuf = 0;
        this.bitCnt = 0;
      }
    }
  }

  flush() {
    if (this.bitCnt > 0) {
      this.emitByte((this.bitBuf << (8 - this.bitCnt)) & 0xff);
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
  }

  toBuffer() {
    this.flush();
    this.flushChunk();
    return Buffer.concat(this.chunks);
  }
}

const _fblock = new Float64Array(64);
const _ftmp = new Float64Array(64);

function fdctQuantize(src, stride, ox, oy, q, out) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) _fblock[r * 8 + c] = src[(oy + r) * stride + ox + c] - 128;
  }
  // horizontal: tmp[r][u] = sum_n M[u][n] * f[r][n]
  for (let r = 0; r < 8; r++) {
    const base = r * 8;
    for (let u = 0; u < 8; u++) {
      let s = 0;
      const mu = M[u];
      for (let n = 0; n < 8; n++) s += mu[n] * _fblock[base + n];
      _ftmp[base + u] = s;
    }
  }
  // vertical: F[u][c] = sum_n M[u][n] * tmp[n][c]
  for (let c = 0; c < 8; c++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      const mu = M[u];
      for (let n = 0; n < 8; n++) s += mu[n] * _ftmp[n * 8 + c];
      const v = s / q[u * 8 + c];
      out[u * 8 + c] = v < 0 ? -Math.round(-v) : Math.round(v);
    }
  }
}

function bitLength(v) {
  if (v === 0) return 0;
  v = v < 0 ? -v : v;
  return 32 - Math.clz32(v);
}

function amplitude(v, s) {
  return v < 0 ? v + (1 << s) - 1 : v;
}

function encodeBlock(plane, stride, ox, oy, q, dcTable, acTable, writer, predObj) {
  const qc = new Int32Array(64);
  fdctQuantize(plane, stride, ox, oy, q, qc);
  const diff = qc[0] - predObj.value;
  predObj.value = qc[0];
  const s = bitLength(diff);
  const dcCode = dcTable.get(s);
  if (!dcCode) throw new Error('JPEG DC category out of range: ' + s);
  writer.writeBits(dcCode.code, dcCode.len);
  if (s > 0) writer.writeBits(amplitude(diff, s), s);
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const v = qc[ZIGZAG[k]];
    if (v === 0) { run++; continue; }
    while (run > 15) {
      const z = acTable.get(0xf0);
      writer.writeBits(z.code, z.len);
      run -= 16;
    }
    const sz = bitLength(v);
    const code = acTable.get((run << 4) | sz);
    if (!code) throw new Error('JPEG AC symbol out of range');
    writer.writeBits(code.code, code.len);
    writer.writeBits(amplitude(v, sz), sz);
    run = 0;
  }
  if (run > 0) {
    const eob = acTable.get(0x00);
    writer.writeBits(eob.code, eob.len);
  }
}

function makeDHT(cls, id, bits, vals) {
  const out = Buffer.allocUnsafe(1 + 16 + vals.length);
  out[0] = (cls << 4) | id;
  for (let i = 0; i < 16; i++) out[1 + i] = bits[i];
  for (let i = 0; i < vals.length; i++) out[17 + i] = vals[i];
  return out;
}

function makeDQT(id, tableNatural) {
  const out = Buffer.allocUnsafe(1 + 64);
  out[0] = id;
  for (let i = 0; i < 64; i++) out[1 + i] = tableNatural[ZIGZAG[i]];
  return out;
}

function encodeJPEG(rgba, width, height, options) {
  const quality = Math.max(1, Math.min(100, Math.round((options && options.quality) || 80)));
  const w = width;
  const h = height;
  const Y = new Uint8ClampedArray(w * h);
  const CbFull = new Float64Array(w * h);
  const CrFull = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    Y[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    CbFull[i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
    CrFull[i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
  }
  const cw = Math.ceil(w / 2);
  const chh = Math.ceil(h / 2);
  const Cb = new Uint8ClampedArray(cw * chh);
  const Cr = new Uint8ClampedArray(cw * chh);
  for (let cy = 0; cy < chh; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let sb = 0;
      let sr = 0;
      let n = 0;
      for (let dy = 0; dy < 2; dy++) {
        const sy = cy * 2 + dy;
        if (sy >= h) continue;
        for (let dx = 0; dx < 2; dx++) {
          const sx = cx * 2 + dx;
          if (sx >= w) continue;
          const i = sy * w + sx;
          sb += CbFull[i];
          sr += CrFull[i];
          n++;
        }
      }
      Cb[cy * cw + cx] = Math.round(sb / n);
      Cr[cy * cw + cx] = Math.round(sr / n);
    }
  }

  const qLum = scaleQuant(STD_LUM_QT, quality);
  const qChrom = scaleQuant(STD_CHROM_QT, quality);

  const mcusPerLine = Math.ceil(w / 16);
  const mcusPerColumn = Math.ceil(h / 16);
  const yStride = mcusPerLine * 16;
  const yPad = new Uint8ClampedArray(yStride * mcusPerColumn * 16);
  const cStride = mcusPerLine * 8;
  const cPadded = new Uint8ClampedArray(cStride * mcusPerColumn * 8);
  const cPad2 = new Uint8ClampedArray(cStride * mcusPerColumn * 8);
  for (let y = 0; y < mcusPerColumn * 16; y++) {
    const sy = y < h ? y : h - 1;
    for (let x = 0; x < yStride; x++) {
      const sx = x < w ? x : w - 1;
      yPad[y * yStride + x] = Y[sy * w + sx];
    }
  }
  for (let y = 0; y < mcusPerColumn * 8; y++) {
    const sy = y < chh ? y : chh - 1;
    for (let x = 0; x < cStride; x++) {
      const sx = x < cw ? x : cw - 1;
      cPadded[y * cStride + x] = Cb[sy * cw + sx];
      cPad2[y * cStride + x] = Cr[sy * cw + sx];
    }
  }

  const writer = new BitWriter();
  const predY = { value: 0 };
  const predCb = { value: 0 };
  const predCr = { value: 0 };
  for (let my = 0; my < mcusPerColumn; my++) {
    for (let mx = 0; mx < mcusPerLine; mx++) {
      const bx = mx * 16;
      const by = my * 16;
      encodeBlock(yPad, yStride, bx, by, qLum, ENC_DC_LUM, ENC_AC_LUM, writer, predY);
      encodeBlock(yPad, yStride, bx + 8, by, qLum, ENC_DC_LUM, ENC_AC_LUM, writer, predY);
      encodeBlock(yPad, yStride, bx, by + 8, qLum, ENC_DC_LUM, ENC_AC_LUM, writer, predY);
      encodeBlock(yPad, yStride, bx + 8, by + 8, qLum, ENC_DC_LUM, ENC_AC_LUM, writer, predY);
      encodeBlock(cPadded, cStride, mx * 8, my * 8, qChrom, ENC_DC_CHROM, ENC_AC_CHROM, writer, predCb);
      encodeBlock(cPad2, cStride, mx * 8, my * 8, qChrom, ENC_DC_CHROM, ENC_AC_CHROM, writer, predCr);
    }
  }
  const scanData = writer.toBuffer();

  const dqt = Buffer.concat([makeDQT(0, qLum), makeDQT(1, qChrom)]);
  const dht = Buffer.concat([
    makeDHT(0, 0, DC_LUM_BITS, DC_VALS),
    makeDHT(1, 0, AC_LUM_BITS, AC_LUM_VALS),
    makeDHT(0, 1, DC_CHROM_BITS, DC_VALS),
    makeDHT(1, 1, AC_CHROM_BITS, AC_CHROM_VALS)
  ]);

  // SOF0 payload is 6 + 3*Nf bytes (precision, height, width, Nf, then 3
  // bytes per component); the segment length field is payload + 2. The old
  // 8 + 3*3 allocation produced a 19-byte length (17-byte payload) with two
  // uninitialised trailing bytes, which libjpeg-backed decoders reject with
  // JERR_BAD_LENGTH (length - 8 != num_components * 3).
  const sof = Buffer.alloc(6 + 3 * 3);
  sof[0] = 8;
  sof.writeUInt16BE(h, 1);
  sof.writeUInt16BE(w, 3);
  sof[5] = 3;
  sof[6] = 1; sof[7] = 0x22; sof[8] = 0;
  sof[9] = 2; sof[10] = 0x11; sof[11] = 1;
  sof[12] = 3; sof[13] = 0x11; sof[14] = 1;

  const sos = Buffer.from([3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  const jfif = Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);

  const parts = [];
  parts.push(Buffer.from([0xff, 0xd8]));
  parts.push(Buffer.from([0xff, 0xe0, 0x00, 0x10]), jfif);
  parts.push(Buffer.from([0xff, 0xdb, 0x00, dqt.length + 2]), dqt);
  parts.push(Buffer.from([0xff, 0xc0, 0x00, sof.length + 2]), sof);
  parts.push(Buffer.from([0xff, 0xc4, (dht.length + 2) >> 8, (dht.length + 2) & 0xff]), dht);
  parts.push(Buffer.from([0xff, 0xda, 0x00, sos.length + 2]), sos);
  parts.push(scanData);
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

module.exports = { isJPEG, decodeJPEG, jpegMetadata, encodeJPEG };
