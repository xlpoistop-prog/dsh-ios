/**
 * Determine why node-pty's native addon cannot be loaded on this device.
 *
 * `loadNativeModule` wraps every failure as "Cannot find module", which hides
 * the real dlopen reason. Calling process.dlopen with an absolute path
 * separates the cases:
 *   - ENOENT / "no such file" -> the path is genuinely wrong
 *   - "image not found" / wrong platform / code-signature -> the Mach-O cannot
 *     be mapped into this process, so no path or permission fix will help
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const require = createRequire(import.meta.url)

const candidates = [
  './node_modules/node-pty/prebuilds/ios-arm64/pty.node',
  './node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
]

for (const relative of candidates) {
  const absolute = new URL(relative, import.meta.url).pathname
  console.log(`\n=== ${relative}`)
  console.log(`exists: ${String(existsSync(absolute))}`)

  try {
    // A fresh Module object is what dlopen expects as `this`.
    const { Module } = require('node:module')
    const holder = new Module(absolute)
    holder.filename = absolute
    holder.paths = []
    process.dlopen(holder, absolute)
    console.log('  dlopen: OK')
    console.log(`  exports: ${Object.keys(holder.exports).join(', ')}`)
  } catch (error) {
    console.log(`  dlopen FAILED`)
    console.log(`    message: ${error?.message}`)
    console.log(`    code:    ${error?.code}`)
    if (error?.errno !== undefined) console.log(`    errno:   ${error.errno}`)
  }
}

console.log('\n=== spawn-helper as a subprocess image ===')
console.log('(spawn is sandbox-refused here, so this needs a non-child probe)')
