// Verify the pure-JS image codec against known-content fixtures.
//
//   node --jitless verify-image-codec.mjs [path/to/sharp-ios]
//
// Run it after install.sh, from anywhere. It exercises decode, metadata, resize
// and both encode paths, and it asserts against fixtures whose contents are
// recorded in blind-test.answer.txt — so a passing run means the codec really
// decoded the pixels, not that it returned something plausible.
//
// Why this exists at all: an earlier version of this codec produced JPEG files
// whose SOF0 segment length was 19 instead of 17 (8 + 3*components), with two
// bytes of uninitialised heap in the gap. Our own decoder ignored the length
// field, so it read them back happily and every self-test passed — while the
// real API rejected them outright. The lesson is baked in below: **check the
// bytes you produce against the spec, not only against your own decoder.**

import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// Prefer an explicitly supplied codec, else the one installed in the DSH tree.
const candidate = process.argv[2]
  ? join(process.argv[2], 'sharp.cjs')
  : join(HERE, '..', 'sharp-ios', 'sharp.cjs')

if (!existsSync(candidate)) {
  console.error(`cannot find the codec at ${candidate}`)
  console.error('usage: node --jitless verify-image-codec.mjs [path/to/sharp-ios]')
  process.exit(2)
}

const require = createRequire(import.meta.url)
const sharp = require(candidate)

let pass = 0
let fail = 0

function check(label, condition, detail) {
  if (condition) { pass += 1; console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`) }
}

const hex = (buf, n = 12) => [...buf.slice(0, n)].map((b) => b.toString(16).padStart(2, '0')).join(' ')

// ---------------------------------------------------------------------------
// 1. metadata + dimensions
// ---------------------------------------------------------------------------
console.log('\n1. metadata')
const testPng = readFileSync(join(HERE, 'test-image.png'))
const meta = await sharp(testPng).metadata()

check('format is png', meta.format === 'png', `[${meta.format}]`)
check('dimensions are 480x200', meta.width === 480 && meta.height === 200, `[${meta.width}x${meta.height}]`)
check('alpha is reported', meta.hasAlpha === true, `[hasAlpha=${meta.hasAlpha}]`)

// ---------------------------------------------------------------------------
// 2. PNG round-trip is lossless
// ---------------------------------------------------------------------------
console.log('\n2. PNG encode (lossless)')
const pngOut = await sharp(testPng).png().toBuffer()
check('magic is PNG', pngOut.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `[${hex(pngOut, 8)}]`)

const pngReMeta = await sharp(pngOut).metadata()
check('re-decodes to the same size', pngReMeta.width === 480 && pngReMeta.height === 200,
      `[${pngReMeta.width}x${pngReMeta.height}]`)

// Pixel-exact comparison. This is the check that would have caught a lossy PNG.
const rawA = await sharp(testPng).raw().toBuffer()
const rawB = await sharp(pngOut).raw().toBuffer()
let diff = 0
for (let i = 0; i < Math.min(rawA.length, rawB.length); i += 1) diff += Math.abs(rawA[i] - rawB[i])
check('PNG round-trip is pixel-exact', diff === 0, `[sum|diff|=${diff}]`)

// ---------------------------------------------------------------------------
// 3. JPEG encode — structure, not just decodability
// ---------------------------------------------------------------------------
console.log('\n3. JPEG encode (structure)')
const jpgOut = await sharp(testPng).jpeg({ quality: 85 }).toBuffer()
check('magic is JPEG', jpgOut[0] === 0xff && jpgOut[1] === 0xd8, `[${hex(jpgOut, 4)}]`)
check('ends with EOI', jpgOut[jpgOut.length - 2] === 0xff && jpgOut[jpgOut.length - 1] === 0xd9,
      `[${hex(jpgOut.slice(-2), 2)}]`)

// Walk the marker segments and validate SOF0's length.
//
// SOF0 must declare 8 + 3*Nf bytes. The historical bug wrote 19 where 17 was
// correct. Checking this is the whole point of having this script.
let pos = 2
let sofLen = null
let components = null
let sawSOF = false
while (pos < jpgOut.length - 1) {
  if (jpgOut[pos] !== 0xff) { pos += 1; continue }
  const marker = jpgOut[pos + 1]
  if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue }
  const len = jpgOut.readUInt16BE(pos + 2)
  // SOF0..SOF15, excluding DHT (0xc4), JPG (0xc8) and DAC (0xcc).
  if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
    sofLen = len
    components = jpgOut[pos + 9]
    sawSOF = true
    break
  }
  pos += 2 + len
}
check('contains an SOF segment', sawSOF)
if (sawSOF) {
  check('SOF length is 8 + 3*Nf', sofLen === 8 + 3 * components,
        `[len=${sofLen} Nf=${components} expected=${8 + 3 * components}]`)
}

const jpgReMeta = await sharp(jpgOut).metadata()
check('JPEG re-decodes', jpgReMeta.format === 'jpeg' && jpgReMeta.width === 480,
      `[${jpgReMeta.format} ${jpgReMeta.width}x${jpgReMeta.height}]`)

// ---------------------------------------------------------------------------
// 4. resize
// ---------------------------------------------------------------------------
console.log('\n4. resize')
const small = await sharp(testPng).resize({ width: 240 }).png().toBuffer()
const smallMeta = await sharp(small).metadata()
check('width halved', smallMeta.width === 240, `[${smallMeta.width}]`)
check('aspect ratio preserved', Math.abs(smallMeta.height - 100) <= 1, `[height=${smallMeta.height}]`)

// ---------------------------------------------------------------------------
// 5. blind test — the fixture whose content is recorded, not assumed
// ---------------------------------------------------------------------------
console.log('\n5. blind fixture')
const blind = readFileSync(join(HERE, 'blind-test.png'))
const blindMeta = await sharp(blind).metadata()
check('blind-test.png is 400x240', blindMeta.width === 400 && blindMeta.height === 240,
      `[${blindMeta.width}x${blindMeta.height}]`)

// Sample the two colours the answer file names, straight from the decoded
// pixels. If the codec were fabricating output these would not line up.
const raw = await sharp(blind).raw({ width: 400, height: 240 }).toBuffer()
const at = (x, y) => {
  const i = (y * 400 + x) * 4
  return { r: raw[i], g: raw[i + 1], b: raw[i + 2] }
}
const bg = at(10, 220)              // bottom-left: background
const circle = at(200, 160)         // centre of the circle

// From blind-test.answer.txt: bg=ffc8e6c8 (a light green), shapeColor=DodgerBlue
const near = (c, r, g, b, tol = 40) =>
  Math.abs(c.r - r) <= tol && Math.abs(c.g - g) <= tol && Math.abs(c.b - b) <= tol

check('background is light green', near(bg, 200, 230, 200), `[rgb(${bg.r},${bg.g},${bg.b})]`)
check('circle is dodger blue', near(circle, 30, 144, 255), `[rgb(${circle.r},${circle.g},${circle.b})]`)

console.log("\nSee blind-test.answer.txt for the recorded truth. The string 'SV-6477'")
console.log('and the shape are what a vision model reported when given this file —')
console.log('the colour assertions above are the part a text-only pipeline cannot fake.')

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
