'use strict';

// Pure-JS separable image resampler.
// Interleaved 8-bit samples. Downscale uses exact area (box) averaging;
// upscale uses bilinear interpolation. No WebAssembly, no native code.

function resampleAxis(src, n, m, ch, outN, axis) {
  if (outN === n) return src;
  const out = new Uint8Array(outN * m * ch);
  // `n` points along the resized axis, `m` points along the other axis.
  const srcIdx = axis === 0
    ? (i, j) => (j * n + i) * ch
    : (i, j) => (i * m + j) * ch;
  const dstIdx = axis === 0
    ? (i, j) => (j * outN + i) * ch
    : (i, j) => (i * m + j) * ch;

  if (outN < n) {
    const scale = n / outN;
    const acc = new Float64Array(ch);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < outN; i++) {
        const start = i * scale;
        const end = start + scale;
        let x0 = Math.floor(start);
        let x1 = Math.ceil(end);
        if (x1 > n) x1 = n;
        if (x0 > n - 1) x0 = n - 1;
        for (let c = 0; c < ch; c++) acc[c] = 0;
        let total = 0;
        for (let x = x0; x < x1; x++) {
          const w = Math.min(end, x + 1) - Math.max(start, x);
          if (w <= 0) continue;
          total += w;
          const p = srcIdx(x, j);
          for (let c = 0; c < ch; c++) acc[c] += src[p + c] * w;
        }
        const d = dstIdx(i, j);
        if (total <= 0) {
          const p = srcIdx(Math.max(0, Math.min(n - 1, Math.floor(start))), j);
          for (let c = 0; c < ch; c++) out[d + c] = src[p + c];
        } else {
          for (let c = 0; c < ch; c++) out[d + c] = Math.round(acc[c] / total);
        }
      }
    }
  } else {
    const scale = n / outN;
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < outN; i++) {
        const center = (i + 0.5) * scale - 0.5;
        let x0 = Math.floor(center);
        let f = center - x0;
        if (x0 < 0) { x0 = 0; f = 0; }
        let x1 = x0 + 1;
        if (x1 > n - 1) x1 = n - 1;
        if (x0 > n - 1) { x0 = n - 1; x1 = n - 1; f = 0; }
        const p0 = srcIdx(x0, j);
        const p1 = srcIdx(x1, j);
        const d = dstIdx(i, j);
        const g = 1 - f;
        for (let c = 0; c < ch; c++) out[d + c] = Math.round(src[p0 + c] * g + src[p1 + c] * f);
      }
    }
  }
  return out;
}

function resample(src, sw, sh, ch, dw, dh) {
  if (dw === sw && dh === sh) return src;
  const tmp = resampleAxis(src, sw, sh, ch, dw, 0);
  return resampleAxis(tmp, sh, dw, ch, dh, 1);
}

module.exports = { resample };
