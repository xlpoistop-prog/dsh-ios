'use strict';

// Minimal EXIF/TIFF reader: we only need the EXIF Orientation tag (0x0112),
// which drives sharp's auto-rotate behaviour.

function readUInt(buf, off, little, size) {
  if (off < 0 || off + size > buf.length) return -1;
  if (size === 2) return little ? buf[off] | (buf[off + 1] << 8) : (buf[off] << 8) | buf[off + 1];
  if (size === 4) {
    return little
      ? (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
      : ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
  }
  return -1;
}

// `data` may be a raw TIFF block (PNG eXIf) or start with "Exif\0\0" (JPEG APP1).
function tiffOf(data) {
  if (!data || data.length < 8) return null;
  if (data[0] === 0x45 && data[1] === 0x78 && data[2] === 0x69 && data[3] === 0x66) {
    // "Exif"
    return data.subarray(6);
  }
  return data;
}

function exifOrientation(data) {
  const t = tiffOf(data);
  if (!t || t.length < 8) return undefined;
  let little;
  if (t[0] === 0x49 && t[1] === 0x49) little = true;
  else if (t[0] === 0x4d && t[1] === 0x4d) little = false;
  else return undefined;
  const ifd0 = readUInt(t, 4, little, 4);
  if (ifd0 < 0 || ifd0 + 2 > t.length) return undefined;
  const count = readUInt(t, ifd0, little, 2);
  for (let i = 0; i < count; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > t.length) break;
    const tag = readUInt(t, e, little, 2);
    if (tag === 0x0112) {
      const type = readUInt(t, e + 2, little, 2);
      const n = readUInt(t, e + 4, little, 4);
      if (type === 3 && n >= 1) {
        const v = readUInt(t, e + 8, little, 2);
        return v >= 1 && v <= 8 ? v : undefined;
      }
    }
  }
  return undefined;
}

// True when the EXIF block carries an orientation tag we would have to strip.
function hasExifOrientation(data) {
  return exifOrientation(data) !== undefined;
}

module.exports = { exifOrientation, hasExifOrientation };
