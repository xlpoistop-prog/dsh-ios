/**
 * Rewrite a Mach-O's declared platform so iOS's dyld will map it.
 *
 * Why this is needed: node-pty ships darwin-arm64 prebuilds, and dyld refuses
 * them on iOS even though the file otherwise matches:
 *
 *   (mach-o file, but incompatible platform (have 'macOS', need 'iOS'))
 *
 * The declared platform lives in LC_BUILD_VERSION (cmd 0x32), whose `platform`
 * field is a fixed 32-bit slot: macOS is 1, iOS is 2. Rewriting that slot in
 * place changes no other byte and needs no realignment. The code signature is
 * invalidated by the edit, which is expected — ldid re-signs afterwards.
 *
 * Legacy LC_VERSION_MIN_MACOSX (0x24) has no platform slot; it is converted to
 * an equivalent 24-byte LC_BUILD_VERSION, which fits because the legacy command
 * is 16 bytes and the following command is re-read from the original offsets
 * only after this one is grown.
 *
 * Usage: node patch-macho-ios.mjs <file> [<file> ...]
 */
import { open, readFile, writeFile } from 'node:fs/promises'
import { argv, exit } from 'node:process'

const MH_MAGIC_64 = 0xfeedfacf
const LC_BUILD_VERSION = 0x32
const LC_VERSION_MIN_MACOSX = 0x24
const PLATFORM_MACOS = 1
const PLATFORM_IOS = 2

const NAMES = new Map([[1, 'macOS'], [2, 'iOS'], [3, 'tvOS'], [4, 'watchOS'], [6, 'MacCatalyst'], [7, 'iOS-simulator']])

/** Patch one file in place. Returns true when the file now declares iOS. */
async function patch(path) {
  const buffer = await readFile(path)
  if (buffer.length < 32) throw new Error(`${path}: too small to be Mach-O`)
  if (buffer.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error(`${path}: not a 64-bit little-endian Mach-O (magic 0x${buffer.readUInt32LE(0).toString(16)})`)
  }

  const ncmds = buffer.readUInt32LE(16)
  let offset = 32
  let changed = false

  for (let i = 0; i < ncmds; i += 1) {
    if (offset + 8 > buffer.length) break
    const cmd = buffer.readUInt32LE(offset)
    const cmdsize = buffer.readUInt32LE(offset + 4)
    if (cmdsize < 8) throw new Error(`${path}: load command ${i} has invalid size ${cmdsize}`)

    if (cmd === LC_BUILD_VERSION) {
      const platform = buffer.readUInt32LE(offset + 8)
      const minos = buffer.readUInt32LE(offset + 12)
      const sdk = buffer.readUInt32LE(offset + 16)
      if (platform === PLATFORM_IOS) {
        console.log(`${path}: already iOS`)
        return true
      }
      if (platform !== PLATFORM_MACOS) {
        console.log(`${path}: platform is ${NAMES.get(platform) ?? platform}; not rewriting`)
        return false
      }
      buffer.writeUInt32LE(PLATFORM_IOS, offset + 8)
      console.log(
        `${path}: LC_BUILD_VERSION macOS -> iOS `
        + `(minos ${minos >> 16}.${(minos >> 8) & 0xff}, sdk ${sdk >> 16}.${(sdk >> 8) & 0xff} preserved)`,
      )
      changed = true
    } else if (cmd === LC_VERSION_MIN_MACOSX) {
      // 16-byte legacy command -> 24-byte LC_BUILD_VERSION. The extra 8 bytes
      // overwrite the tail of a region this loop has already passed, so the
      // walk continues from the ORIGINAL cmdsize.
      const minos = buffer.readUInt32LE(offset + 8)
      const sdk = buffer.readUInt32LE(offset + 12)
      buffer.writeUInt32LE(LC_BUILD_VERSION, offset)
      buffer.writeUInt32LE(24, offset + 4)
      buffer.writeUInt32LE(PLATFORM_IOS, offset + 8)
      buffer.writeUInt32LE(minos, offset + 12)
      buffer.writeUInt32LE(sdk, offset + 16)
      console.log(`${path}: LC_VERSION_MIN_MACOSX -> LC_BUILD_VERSION(iOS)`)
      changed = true
    }

    offset += cmdsize
  }

  if (!changed) {
    console.log(`${path}: no rewritable platform field found`)
    return false
  }

  await writeFile(path, buffer)
  return true
}

if (argv.length < 3) {
  console.error('usage: node patch-macho-ios.mjs <file> [<file> ...]')
  exit(2)
}

let ok = true
for (const path of argv.slice(2)) {
  try {
    ok = (await patch(path)) && ok
  } catch (error) {
    console.error(`${path}: ${error.message}`)
    ok = false
  }
}
exit(ok ? 0 : 1)
