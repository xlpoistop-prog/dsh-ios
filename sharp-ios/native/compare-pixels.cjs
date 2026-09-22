const fs = require('fs'), path = require('path');
const [codecDir, addonDir, fixDir] = process.argv.slice(2);
const sharp = require(path.join(codecDir, 'sharp.cjs'));
const addon  = require(path.join(addonDir, 'imgaddon.node'));
const sum = b => { let s = 0; for (let i = 0; i < b.length; i++) s = (s * 31 + b[i]) >>> 0; return s; };
(async () => {
  for (const f of ['blind-test.png', 'test-image.png']) {
    const buf = fs.readFileSync(path.join(fixDir, f));
    const t0 = Date.now(); const nat = addon.decode(buf); const tN = Date.now() - t0;
    const t1 = Date.now();
    let out;
    try { out = await sharp(buf).raw().toBuffer({ resolveWithObject: true }); }
    catch (e) { console.log(`  ${f}: JS 路径调用失败 → ${e.message}`); continue; }
    const tJ = Date.now() - t1;
    const js = out.data, info = out.info;
    const jsCh = info.channels || 4;
    // compare: JS may hand back 3 channels (RGB) while the addon always returns RGBA
    let same = true, diff = 0, first = -1;
    const px = info.width * info.height;
    for (let p = 0; p < px && same; p++) {
      for (let c = 0; c < jsCh; c++) {
        const jv = js[p * jsCh + c], nv = nat.data[p * 4 + c];
        if (jv !== nv) { same = false; diff++; if (first < 0) first = p * 4 + c; }
      }
    }
    console.log(`  ${f}`);
    console.log(`    JS      ${info.width}x${info.height} ch=${jsCh}  ${tJ}ms  sum=${sum(js)}`);
    console.log(`    native  ${nat.width}x${nat.height} ch=4    ${tN}ms  sum=${sum(nat.data)}`);
    console.log(`    ${same ? '✓ 像素逐字节一致' : `✗ 不一致（差异字节 ${diff}，首个 @${first}）`}`);
  }
})().catch(e => console.log('  脚本异常:', e.message));
