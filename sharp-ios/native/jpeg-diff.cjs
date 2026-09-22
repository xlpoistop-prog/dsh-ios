const fs = require('fs'), path = require('path');
const [codecDir, jpg] = process.argv.slice(2);
const sharp = require(path.join(codecDir, 'sharp.cjs'));
(async () => {
  const buf = fs.readFileSync(jpg);
  process.env.DSH_NATIVE_CODEC = '0';
  const a = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  process.env.DSH_NATIVE_CODEC = '1';
  const b = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const A = a.data, B = b.data;
  if (A.length !== B.length) { console.log(`  长度不同: ${A.length} vs ${B.length}`); return; }
  let max = 0, sum = 0, diffPx = 0, n = 0, over2 = 0;
  const px = a.info.width * a.info.height, ch = a.info.channels;
  for (let p = 0; p < px; p++) {
    let pxDiff = false;
    for (let c = 0; c < ch; c++) {
      const d = Math.abs(A[p * ch + c] - B[p * ch + c]);
      if (d) { sum += d; n++; pxDiff = true; if (d > max) max = d; if (d > 2) over2++; }
    }
    if (pxDiff) diffPx++;
  }
  console.log(`  采样通道数 ${n}，平均绝对差 ${n ? (sum / n).toFixed(3) : 0}，最大差 ${max}，差>2 的通道 ${over2}`);
  console.log(`  有差异的像素 ${diffPx}/${px} （${(100 * diffPx / px).toFixed(1)}%）`);
  const sample = [0, 1, 2, 3, 1000, 50000];
  for (const p of sample) {
    const av = [], bv = [];
    for (let c = 0; c < ch; c++) { av.push(A[p * ch + c]); bv.push(B[p * ch + c]); }
    console.log(`    px#${String(p).padEnd(6)} JS[${av.join(',')}]  原生[${bv.join(',')}]`);
  }
})().catch(e => console.log('  异常:', e.message));
