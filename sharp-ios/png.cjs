'use strict';

// Pure-JS PNG codec (decode + encode) built on node:zlib.
// Supports bit depths 1/2/4/8/16, colour types 0/2/3/4/6, non-interlaced and
// Adam7 interlaced files, tRNS transparency, eXIf / iCCP / XMP metadata.

const zlib = require('node:zlib');
const { exifOrientation } = require('./exif.cjs');

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPNG(buf) {
  if (buf.length < 8) return false;
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return false;
  return true;
}

function readU32(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function parsePng(buf) {
  if (!isPNG(buf)) throw new Error('not a PNG');
  const res = { idat: [], ihdr: null };
  let o = 8;
  while (o + 8 <= buf.length) {
    const len = readU32(buf, o);
    if (o + 12 + len > buf.length) throw new Error('truncated PNG chunk');
    const type = buf.toString('latin1', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      if (len !== 13) throw new Error('malformed PNG IHDR');
      res.ihdr = {
        width: readU32(data, 0),
        height: readU32(data, 4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12]
      };
    } else if (type === 'PLTE') {
      res.palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      res.trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      res.idat.push(data);
    } else if (type === 'IEND') {
      break;
    } else if (type === 'eXIf') {
      res.exif = Buffer.from(data);
    } else if (type === 'iCCP') {
      const z = data.indexOf(0);
      if (z >= 0 && z + 2 <= data.length) {
        try { res.icc = zlib.inflateSync(data.subarray(z + 2)); } catch (e) { /* ignore bad profile */ }
      }
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0) {
        const keyword = data.toString('latin1', 0, z);
        if (keyword === 'XML:com.adobe.xmp') {
          // keyword\0 compFlag(1) compMethod(1) lang\0 translated\0 text
          let p = z + 3;
          const langEnd = data.indexOf(0, p);
          if (langEnd >= 0) {
            p = langEnd + 1;
            const transEnd = data.indexOf(0, p);
            if (transEnd >= 0) {
              let text = data.subarray(transEnd + 1);
              if (data[z + 1] === 1) {
                try { text = zlib.inflateSync(text); } catch (e) { /* ignore */ }
              }
              res.xmp = Buffer.from(text);
            }
          }
        }
      }
    }
    o += 12 + len;
  }
  if (!res.ihdr) throw new Error('PNG missing IHDR');
  const h = res.ihdr;
  if (h.width < 1 || h.height < 1) throw new Error('PNG has invalid dimensions');
  if (h.colorType === 3 && !res.palette) throw new Error('palette PNG missing PLTE');
  return res;
}

function channelsForColorType(ct) {
  switch (ct) {
    case 0: return 1;
    case 2: return 3;
    case 3: return 1;
    case 4: return 2;
    case 6: return 4;
    default: throw new Error('unsupported PNG colour type ' + ct);
  }
}

function paletteHasAlpha(p) {
  if (!p.trns) return false;
  return p.trns.some((v) => v < 255);
}

function pngHasAlpha(p) {
  const ct = p.ihdr.colorType;
  if (ct === 4 || ct === 6) return true;
  if (ct === 3) return paletteHasAlpha(p);
  if (ct === 0 || ct === 2) return !!p.trns;
  return false;
}

function pngMetadata(buf) {
  const p = parsePng(buf);
  const h = p.ihdr;
  const hasAlpha = pngHasAlpha(p);
  const md = {
    format: 'png',
    width: h.width,
    height: h.height,
    depth: h.bitDepth === 16 ? 'ushort' : 'uchar',
    space: (h.colorType === 0 || h.colorType === 4) ? 'b-w' : 'srgb',
    channels: h.colorType === 3 ? (hasAlpha ? 4 : 3) : channelsForColorType(h.colorType),
    hasAlpha,
    bitsPerSample: h.bitDepth,
    isPalette: h.colorType === 3,
    pages: 1,
    loop: 0
  };
  if (p.icc) { md.icc = p.icc; md.hasProfile = true; }
  if (p.exif) {
    md.exif = p.exif;
    const o = exifOrientation(p.exif);
    if (o) md.orientation = o;
  }
  if (p.xmp) md.xmp = p.xmp;
  return md;
}

// Un-filter `h` scanlines starting at `off`; each row is prefixed by its filter
// byte. Returns a fresh Buffer of h*stride unfiltered bytes.
function unfilter(raw, off, h, stride, bpp) {
  const out = Buffer.allocUnsafe(h * stride);
  let p = off;
  for (let y = 0; y < h; y++) {
    if (p >= raw.length) throw new Error('PNG IDAT too short');
    const f = raw[p++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[p++];
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = y > 0 && x >= bpp ? out[prev + x - bpp] : 0;
      let r;
      switch (f) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          r = v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
          break;
        }
        default: throw new Error('unknown PNG filter ' + f);
      }
      out[row + x] = r & 0xff;
    }
  }
  return out;
}

// Expand a (possibly interlaced) pass into the destination RGBA buffer.
function expandPass(src, stride, pw, ph, h, palette, trns, dst, dstW, ox, oy, sx, sy) {
  const bd = h.bitDepth;
  const ct = h.colorType;
  const chIn = channelsForColorType(ct);
  const invMax = bd === 16 ? 0 : (bd === 8 ? 0 : 255 / ((1 << bd) - 1));
  const scale8 = (v) => (bd === 16 ? v >> 8 : (bd === 8 ? v : Math.round(v * invMax)));
  for (let y = 0; y < ph; y++) {
    const rowBase = y * stride;
    const dy = oy + y * sy;
    for (let x = 0; x < pw; x++) {
      const dx = ox + x * sx;
      const sample = (ci) => {
        if (bd === 8) return src[rowBase + x * chIn + ci];
        if (bd === 16) {
          const o = rowBase + (x * chIn + ci) * 2;
          return (src[o] << 8) | src[o + 1];
        }
        const bitPos = (x * chIn + ci) * bd;
        const byteOff = rowBase + (bitPos >> 3);
        const shift = 8 - bd - (bitPos & 7);
        return (src[byteOff] >> shift) & ((1 << bd) - 1);
      };
      let r = 0; let g = 0; let b = 0; let a = 255;
      if (ct === 0) {
        const v = sample(0);
        r = g = b = scale8(v);
        if (trns && trns.length >= 2) {
          const tv = (trns[0] << 8) | trns[1];
          if (v === tv) a = 0;
        }
      } else if (ct === 2) {
        const rr = sample(0); const gg = sample(1); const bb = sample(2);
        r = scale8(rr); g = scale8(gg); b = scale8(bb);
        if (trns && trns.length >= 6) {
          const tr = (trns[0] << 8) | trns[1];
          const tg = (trns[2] << 8) | trns[3];
          const tb = (trns[4] << 8) | trns[5];
          if (rr === tr && gg === tg && bb === tb) a = 0;
        }
      } else if (ct === 3) {
        const idx = sample(0);
        const pi = idx * 3;
        if (pi + 2 >= palette.length) throw new Error('PNG palette index out of range');
        r = palette[pi]; g = palette[pi + 1]; b = palette[pi + 2];
        if (trns && idx < trns.length) a = trns[idx];
      } else if (ct === 4) {
        const v = sample(0); const av = sample(1);
        r = g = b = scale8(v); a = scale8(av);
      } else {
        r = scale8(sample(0)); g = scale8(sample(1)); b = scale8(sample(2)); a = scale8(sample(3));
      }
      const d = (dy * dstW + dx) * 4;
      dst[d] = r; dst[d + 1] = g; dst[d + 2] = b; dst[d + 3] = a;
    }
  }
}

function decodePNG(buf) {
  const p = parsePng(buf);
  const h = p.ihdr;
  const width = h.width;
  const height = h.height;
  const bd = h.bitDepth;
  const chIn = channelsForColorType(h.colorType);
  const bitsPerPixel = chIn * bd;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  if (p.idat.length === 0) throw new Error('PNG has no IDAT data');
  const raw = zlib.inflateSync(Buffer.concat(p.idat));
  const rgba = new Uint8Array(width * height * 4);
  if (h.interlace === 0) {
    const stride = Math.ceil(width * bitsPerPixel / 8);
    const need = height * (stride + 1);
    if (raw.length < need) throw new Error('PNG IDAT too short');
    const unf = unfilter(raw, 0, height, stride, bpp);
    expandPass(unf, stride, width, height, h, p.palette, p.trns, rgba, width, 0, 0, 1, 1);
  } else if (h.interlace === 1) {
    const SC = [0, 4, 0, 2, 0, 1, 0];
    const SR = [0, 0, 4, 0, 2, 0, 1];
    const CI = [8, 8, 4, 4, 2, 2, 1];
    const RI = [8, 8, 8, 4, 4, 2, 2];
    let off = 0;
    for (let pass = 0; pass < 7; pass++) {
      const pw = width > SC[pass] ? Math.ceil((width - SC[pass]) / CI[pass]) : 0;
      const ph = height > SR[pass] ? Math.ceil((height - SR[pass]) / RI[pass]) : 0;
      if (pw === 0 || ph === 0) continue;
      const stride = Math.ceil(pw * bitsPerPixel / 8);
      const need = ph * (stride + 1);
      if (off + need > raw.length) throw new Error('PNG IDAT too short (interlaced)');
      const unf = unfilter(raw, off, ph, stride, bpp);
      off += need;
      expandPass(unf, stride, pw, ph, h, p.palette, p.trns, rgba, width, SC[pass], SR[pass], CI[pass], RI[pass]);
    }
  } else {
    throw new Error('unsupported PNG interlace method ' + h.interlace);
  }
  return {
    rgba,
    width,
    height,
    hasAlpha: pngHasAlpha(p),
    bitDepth: bd,
    colorType: h.colorType,
    space: (h.colorType === 0 || h.colorType === 4) ? 'b-w' : 'srgb',
    metadata: pngMetadata(buf)
  };
}

// ---------- encoder ----------

let crcTable = null;
function makeCrcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
}

function crc32(buf) {
  if (!crcTable) crcTable = makeCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

function encodePNG(rgba, width, height, hasAlpha) {
  const ch = hasAlpha ? 4 : 3;
  const stride = width * ch;
  const raw = Buffer.allocUnsafe(height * (stride + 1));
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  const tmp = Buffer.allocUnsafe(stride);
  let o = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = x * ch;
      cur[d] = rgba[s]; cur[d + 1] = rgba[s + 1]; cur[d + 2] = rgba[s + 2];
      if (hasAlpha) cur[d + 3] = rgba[s + 3];
    }
    let bestF = 0;
    let bestSum = -1;
    let best = null;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? cur[i - ch] : 0;
        const b = prev[i];
        const c = i >= ch ? prev[i - ch] : 0;
        const v = cur[i];
        let out;
        switch (f) {
          case 0: out = v; break;
          case 1: out = (v - a) & 0xff; break;
          case 2: out = (v - b) & 0xff; break;
          case 3: out = (v - ((a + b) >> 1)) & 0xff; break;
          default: out = (v - paeth(a, b, c)) & 0xff; break;
        }
        tmp[i] = out;
        sum += out < 128 ? out : 256 - out;
      }
      if (bestSum < 0 || sum < bestSum) {
        bestSum = sum;
        bestF = f;
        best = Buffer.from(tmp);
      }
    }
    raw[o++] = bestF;
    best.copy(raw, o);
    o += stride;
    prev.set(cur);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = hasAlpha ? 6 : 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from(PNG_SIG),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { isPNG, decodePNG, pngMetadata, encodePNG, parsePng };
