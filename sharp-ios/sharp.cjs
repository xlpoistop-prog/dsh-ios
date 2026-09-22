'use strict';

// Pure-JS drop-in for the `sharp` API surface that DSH actually uses.
//
// Backed by hand-written PNG/JPEG codecs (node:zlib only). No native code, no
// WebAssembly, so it runs under `node --jitless` on iOS.
//
// Implemented surface (the exact set used by @deepseek-ai/dsh-attachment-local):
//   sharp(buffer, { failOn, limitInputPixels })  -> pipeline
//   .metadata() .raw() .resize() .rotate() .toColourspace()
//   .clone() .jpeg() .png() .webp() .toFormat() .toBuffer({ resolveWithObject })
//
// Deliberately NOT implemented: WebP (encode or decode), GIF decode, SVG,
// composite/sharpen/blur and the rest of sharp's surface. Those reject with a
// descriptive Error instead of returning fabricated data.

const fs = require('node:fs');
const png = require('./png.cjs');
const jpeg = require('./jpeg.cjs');
const { resample } = require('./resize.cjs');

function toUint8(input) {
  if (typeof input === 'string') return new Uint8Array(fs.readFileSync(input));
  if (Buffer.isBuffer(input)) return input;
  // A plain Uint8Array must become a Buffer view: the codecs rely on
  // Buffer#toString(encoding, start, end), which Uint8Array ignores.
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (input && typeof input === 'object' && input.data) return toUint8(input.data);
  throw new Error('sharp(ios-js): unsupported input type');
}

function ascii(buf, a, b) {
  return Buffer.from(buf.subarray(a, b)).toString('latin1');
}

function detectFormat(buf) {
  if (png.isPNG(buf)) return 'png';
  if (jpeg.isJPEG(buf)) return 'jpeg';
  if (buf.length >= 6) {
    const s6 = ascii(buf, 0, 6);
    if (s6 === 'GIF87a' || s6 === 'GIF89a') return 'gif';
  }
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'webp';
  return undefined;
}

/* Native fast path, ON by default; set DSH_NATIVE_CODEC=0 to fall back to pure JS.
   Compiled on-device; returns null whenever the addon is missing, unloadable,
   or the env flag is off, so the pure-JS decoder stays the default and the
   fallback. PNG is lossless, so its native output is byte-identical to the JS
   decoder. JPEG comes from a different decoder and therefore differs by JPEG's
   normal rounding (measured: max +/-2 per channel, 0.8% of pixels); EXIF
   orientation is carried over from the JS header scan. */
let _nativeCodec;
function nativePng(buf) {
  if (process.env.DSH_NATIVE_CODEC === '0') return null;
  if (_nativeCodec === undefined) {
    try { _nativeCodec = require('./imgaddon.node'); }
    catch (e) { _nativeCodec = null; }
  }
  if (!_nativeCodec) return null;
  try {
    const r = _nativeCodec.decode(buf);
    if (!r || !r.data) return null;
    return {
      rgba: r.data,
      width: r.width,
      height: r.height,
      hasAlpha: r.sourceChannels === 4 || r.sourceChannels === 2,
      metadata: { format: 'png' },
    };
  } catch (e) { return null; }
}

/* JPEG counterpart of nativePng. stb_image does not read EXIF, so orientation is
   taken from the pure-JS header scan (cheap: it does not decode pixels) and
   carried through; the pixels themselves come from the native decoder. */
function nativeJpeg(buf) {
  if (process.env.DSH_NATIVE_CODEC === '0') return null;
  if (_nativeCodec === undefined) {
    try { _nativeCodec = require('./imgaddon.node'); }
    catch (e) { _nativeCodec = null; }
  }
  if (!_nativeCodec) return null;
  try {
    const r = _nativeCodec.decode(buf);
    if (!r || !r.data) return null;
    let orientation;
    try { const md = jpeg.jpegMetadata(buf); orientation = md && md.orientation; } catch (e) {}
    return {
      rgba: r.data, width: r.width, height: r.height, hasAlpha: false,
      metadata: { format: 'jpeg', orientation: orientation },
    };
  } catch (e) { return null; }
}

/* Native resize, same switch as the decoders. Returns null whenever the addon is
   unavailable so the pure-JS resampler stays the fallback. The addon mirrors
   resize.cjs exactly (verified byte-identical), so this cannot change the image. */
function nativeResize(buf, w, h, dw, dh, ch) {
  if (process.env.DSH_NATIVE_CODEC === '0') return null;
  if (_nativeCodec === undefined) {
    try { _nativeCodec = require('./imgaddon.node'); }
    catch (e) { _nativeCodec = null; }
  }
  if (!_nativeCodec || typeof _nativeCodec.resize !== 'function') return null;
  try {
    const r = _nativeCodec.resize(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), w, h, dw, dh, ch);
    return r ? new Uint8Array(r.buffer, r.byteOffset, r.byteLength) : null;
  } catch (e) { return null; }
}

/* Native PNG encoder. Two guards: the switch, and any explicit format options
   (stb would silently ignore compression level etc., so those use the JS path).
   Returns the addon's Buffer unchanged: downstream code calls Buffer methods. */
function nativeEncodePng(buf, w, h, hasAlpha, fmtOptions) {
  if (process.env.DSH_NATIVE_CODEC === '0') return null;
  if (fmtOptions && Object.keys(fmtOptions).length) return null;
  if (_nativeCodec === undefined) {
    try { _nativeCodec = require('./imgaddon.node'); }
    catch (e) { _nativeCodec = null; }
  }
  if (!_nativeCodec || typeof _nativeCodec.encodePng !== 'function') return null;
  try {
    return _nativeCodec.encodePng(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength),
                                  w, h, 4, hasAlpha ? 4 : 3) || null;
  } catch (e) { return null; }
}

function headerOnlyMetadata(buf, format) {
  if (format === 'gif') {
    const width = buf[6] | (buf[7] << 8);
    const height = buf[8] | (buf[9] << 8);
    return { format: 'gif', width, height, depth: 'uchar', space: 'srgb', channels: 4, hasAlpha: true, pages: 1 };
  }
  if (format === 'webp') {
    const fourcc = ascii(buf, 12, 16);
    let width; let height; let hasAlpha = false;
    if (fourcc === 'VP8X' && buf.length >= 30) {
      width = 1 + ((buf[24] | (buf[25] << 8) | (buf[26] << 16)) & 0xffffff);
      height = 1 + ((buf[27] | (buf[28] << 8) | (buf[29] << 16)) & 0xffffff);
      hasAlpha = (buf[20] & 0x10) !== 0;
    } else if (fourcc === 'VP8 ' && buf.length >= 30) {
      width = ((buf[26] | (buf[27] << 8)) & 0x3fff);
      height = ((buf[28] | (buf[29] << 8)) & 0x3fff);
    } else if (fourcc === 'VP8L' && buf.length >= 25) {
      const bits = buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
      hasAlpha = ((bits >> 28) & 1) === 1;
    }
    return { format: 'webp', width, height, depth: 'uchar', space: 'srgb', channels: hasAlpha ? 4 : 3, hasAlpha, pages: 1 };
  }
  throw new Error('sharp(ios-js): unsupported or malformed image data');
}

function sourceMetadata(buf) {
  const format = detectFormat(buf);
  if (format === 'png') return png.pngMetadata(buf);
  if (format === 'jpeg') return jpeg.jpegMetadata(buf);
  if (format) return headerOnlyMetadata(buf, format);
  throw new Error('sharp(ios-js): unsupported or malformed image data');
}

function applyOrientation(rgba, w, h, o) {
  if (!o || o < 2 || o > 8) return { data: rgba, width: w, height: h };
  let nw = w; let nh = h;
  if (o >= 5) { nw = h; nh = w; }
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      let dx; let dy;
      switch (o) {
        case 2: dx = w - 1 - x; dy = y; break;
        case 3: dx = w - 1 - x; dy = h - 1 - y; break;
        case 4: dx = x; dy = h - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = h - 1 - y; dy = x; break;
        case 7: dx = h - 1 - y; dy = w - 1 - x; break;
        default: dx = y; dy = w - 1 - x; break; // 8
      }
      const d = (dy * nw + dx) * 4;
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
    }
  }
  return { data: out, width: nw, height: nh };
}

function dropAlpha(rgba) {
  const n = rgba.length / 4;
  const out = new Uint8Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    out[j] = rgba[i * 4]; out[j + 1] = rgba[i * 4 + 1]; out[j + 2] = rgba[i * 4 + 2];
  }
  return out;
}

function computeTarget(ow, oh, o) {
  const fit = o.fit || 'cover';
  const withoutEnlargement = !!o.withoutEnlargement;
  let tw = o.width; let th = o.height;
  if (tw === undefined && th === undefined) return { dw: ow, dh: oh, crop: false };
  if (tw === undefined) tw = Math.max(1, Math.round(ow * th / oh));
  if (th === undefined) th = Math.max(1, Math.round(oh * tw / ow));
  if (fit === 'fill') return { dw: tw, dh: th, crop: false };
  if (fit === 'inside' || fit === 'contain') {
    let s = Math.min(tw / ow, th / oh);
    if (withoutEnlargement) s = Math.min(s, 1);
    return { dw: Math.max(1, Math.round(ow * s)), dh: Math.max(1, Math.round(oh * s)), crop: false };
  }
  // cover / outside
  let s = fit === 'outside' ? Math.max(tw / ow, th / oh) : Math.max(tw / ow, th / oh);
  if (withoutEnlargement) s = Math.min(s, 1);
  const dw = Math.max(1, Math.round(ow * s));
  const dh = Math.max(1, Math.round(oh * s));
  return { dw, dh, crop: fit === 'cover', cw: tw, ch: th };
}

function centerCrop(rgba, w, h, cw, ch) {
  const tw = Math.min(w, cw); const th = Math.min(h, ch);
  const left = Math.floor((w - tw) / 2); const top = Math.floor((h - th) / 2);
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const s = ((top + y) * w + left) * 4;
    out.set(rgba.subarray(s, s + tw * 4), y * tw * 4);
  }
  return { data: out, width: tw, height: th };
}

class Sharp {
  constructor(input, options) {
    this._buf = toUint8(input);
    this._ops = [];
    this._input = options || {};
  }

  _chain(op) {
    const s = Object.create(Sharp.prototype);
    s._buf = this._buf;
    s._ops = this._ops.concat([op]);
    s._input = this._input;
    return s;
  }

  clone() {
    const s = Object.create(Sharp.prototype);
    s._buf = this._buf;
    s._ops = this._ops.slice();
    s._input = this._input;
    return s;
  }

  metadata() {
    try { return Promise.resolve(sourceMetadata(this._buf)); } catch (e) { return Promise.reject(e); }
  }

  raw() { return this._chain({ t: 'raw' }); }
  resize(o) { return this._chain({ t: 'resize', o: o || {} }); }
  rotate(...a) { return this._chain({ t: 'rotate', a }); }
  toColourspace(cs) { return this._chain({ t: 'colour', cs }); }
  toColorspace(cs) { return this._chain({ t: 'colour', cs }); }
  jpeg(o) { return this._chain({ t: 'format', f: 'jpeg', o: o || {} }); }
  png(o) { return this._chain({ t: 'format', f: 'png', o: o || {} }); }
  webp(o) { return this._chain({ t: 'format', f: 'webp', o: o || {} }); }
  toFormat(f, o) { return this._chain({ t: 'format', f: String(f).toLowerCase(), o: o || {} }); }
  ensureAlpha() { return this._chain({ t: 'ensure-alpha' }); }
  removeAlpha() { return this._chain({ t: 'remove-alpha' }); }
  flatten(o) { return this._chain({ t: 'flatten', o: o || {} }); }
  grayscale() { return this._chain({ t: 'grayscale' }); }

  _decode() {
    const format = detectFormat(this._buf);
    if (format === 'png') {
      const nat = nativePng(this._buf);
      if (nat) return nat;
      return png.decodePNG(this._buf);
    }
    if (format === 'jpeg') {
      if (typeof jpeg.decodeJPEG !== 'function') {
        throw new Error('sharp(ios-js): JPEG decoding is not available in this build');
      }
      const nat = nativeJpeg(this._buf);
      if (nat) return nat;
      return jpeg.decodeJPEG(this._buf);
    }
    if (format === 'webp') throw new Error('sharp(ios-js): WebP decoding is not implemented; convert the image to PNG or JPEG');
    if (format === 'gif') throw new Error('sharp(ios-js): GIF decoding is not implemented; convert the image to PNG or JPEG');
    throw new Error('sharp(ios-js): unsupported or malformed image data');
  }

  async toBuffer(options) {
    const resolveWithObject = !!(options && options.resolveWithObject);
    const src = this._decode();
    let rgba = src.rgba;
    let width = src.width;
    let height = src.height;
    let hasAlpha = !!src.hasAlpha;
    let orientation = src.metadata && src.metadata.orientation;
    let rawOut = false;
    let outFormat = null;
    let fmtOptions = {};

    for (const op of this._ops) {
      if (op.t === 'rotate') {
        if (op.a.length === 0 || op.a[0] === undefined) {
          if (orientation && orientation > 1) {
            const r = applyOrientation(rgba, width, height, orientation);
            rgba = r.data; width = r.width; height = r.height;
          }
          orientation = 1;
        } else {
          const angle = ((Number(op.a[0]) % 360) + 360) % 360;
          if (angle === 90 || angle === 180 || angle === 270) {
            const r = applyOrientation(rgba, width, height, angle === 90 ? 6 : (angle === 180 ? 3 : 8));
            rgba = r.data; width = r.width; height = r.height;
          }
          orientation = 1;
        }
      } else if (op.t === 'colour') {
        // Pixel data is already sRGB/sRGBA; grayscale colourspace conversions
        // are applied at encode time.
      } else if (op.t === 'resize') {
        const t = computeTarget(width, height, op.o);
        if (t.dw !== width || t.dh !== height) {
          rgba = nativeResize(rgba, width, height, t.dw, t.dh, 4) || resample(rgba, width, height, 4, t.dw, t.dh);
          width = t.dw; height = t.dh;
        }
        if (t.crop) {
          const c = centerCrop(rgba, width, height, t.cw, t.ch);
          rgba = c.data; width = c.width; height = c.height;
        }
      } else if (op.t === 'ensure-alpha') {
        hasAlpha = true;
      } else if (op.t === 'remove-alpha') {
        hasAlpha = false;
      } else if (op.t === 'flatten') {
        const bg = op.o.background || { r: 0, g: 0, b: 0 };
        const out = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          const a = rgba[i * 4 + 3] / 255;
          const ia = 1 - a;
          out[i * 4] = Math.round(rgba[i * 4] * a + (bg.r || 0) * ia);
          out[i * 4 + 1] = Math.round(rgba[i * 4 + 1] * a + (bg.g || 0) * ia);
          out[i * 4 + 2] = Math.round(rgba[i * 4 + 2] * a + (bg.b || 0) * ia);
          out[i * 4 + 3] = 255;
        }
        rgba = out; hasAlpha = false;
      } else if (op.t === 'grayscale') {
        const out = new Uint8Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          const y = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
          out[i * 4] = y; out[i * 4 + 1] = y; out[i * 4 + 2] = y; out[i * 4 + 3] = rgba[i * 4 + 3];
        }
        rgba = out;
      } else if (op.t === 'raw') {
        rawOut = true;
        outFormat = null;
      } else if (op.t === 'format') {
        outFormat = op.f === 'jpg' ? 'jpeg' : op.f;
        fmtOptions = op.o || {};
        rawOut = false;
      }
    }

    if (rawOut) {
      const data = hasAlpha ? Buffer.from(rgba) : Buffer.from(dropAlpha(rgba));
      const info = {
        format: 'raw',
        width,
        height,
        channels: hasAlpha ? 4 : 3,
        size: data.length,
        space: 'srgb',
        depth: 'uchar',
        hasAlpha
      };
      return resolveWithObject ? { data, info } : data;
    }

    if (outFormat === null) outFormat = src.metadata && src.metadata.format === 'jpeg' ? 'jpeg' : 'png';

    let data;
    if (outFormat === 'jpeg') {
      if (typeof jpeg.encodeJPEG !== 'function') {
        throw new Error('sharp(ios-js): JPEG encoding is not available in this build');
      }
      data = jpeg.encodeJPEG(rgba, width, height, {
        quality: fmtOptions.quality === undefined ? 80 : fmtOptions.quality,
        hasAlpha
      });
      hasAlpha = false;
    } else if (outFormat === 'png') {
      data = nativeEncodePng(rgba, width, height, hasAlpha, fmtOptions) || png.encodePNG(rgba, width, height, hasAlpha, fmtOptions);
    } else if (outFormat === 'webp') {
      throw new Error('sharp(ios-js): WebP encoding is not implemented in the pure-JS iOS build; ' +
        'PNG and JPEG are supported. Re-encode the source without an alpha channel or convert it to PNG/JPEG first.');
    } else {
      throw new Error('sharp(ios-js): unsupported output format ' + outFormat);
    }

    const info = {
      format: outFormat,
      width,
      height,
      channels: hasAlpha ? 4 : 3,
      size: data.length,
      space: 'srgb',
      depth: 'uchar',
      hasAlpha
    };
    return resolveWithObject ? { data, info } : data;
  }
}

function sharp(input, options) {
  return new Sharp(input, options);
}

sharp.versions = { sharp: '0.35.4-ios-js', vips: 'ios-js-pure' };
sharp.cache = () => undefined;
sharp.concurrency = () => 0;
sharp.counters = () => ({});
sharp.simd = () => false;
sharp.queue = () => ({});
sharp.format = {};
sharp.interpolators = {};
sharp.gravity = {};
sharp.strategy = {};
sharp.kernel = {};
sharp.fit = {};
sharp.channel = {};
sharp.space = {};
sharp.colourspace = {};
sharp.colorspace = {};
sharp.default = sharp;
sharp.Sharp = Sharp;

module.exports = sharp;
