/**
 * Diagnostic: determine which service each provider plugin actually registers,
 * and whether its constructor completes on this platform.
 *
 * Runs under `node --jitless` on the device. Uses Cordis's own service
 * registry so the answer comes from the framework rather than from reading
 * compiled code.
 */
import { Context } from '@deepseek-ai/cordis'

const providers = [
  ['subprocess-local', '@deepseek-ai/dsh-subprocess-local'],
  ['attachment-local', '@deepseek-ai/dsh-attachment-local'],
]

const ctx = new Context()

for (const [label, spec] of providers) {
  try {
    const mod = await import(spec)
    const Plugin = mod.default
    if (typeof Plugin !== 'function') {
      console.log(`${label}: default export is ${typeof Plugin}, not a plugin`)
      continue
    }
    console.log(`${label}: imported, default is ${Plugin.name || '(anonymous)'}`)

    // Cordis reads a static `name` to key the service. Report what it exposes.
    console.log(`  static name = ${JSON.stringify(Plugin.name)}`)
    console.log(`  has provide marker = ${String(Plugin.provide !== undefined)}`)
    console.log(`  prototype chain = ${Object.getPrototypeOf(Plugin)?.name ?? 'none'}`)

    // Instantiating is what registers a Service subclass.
    try {
      const instance = new Plugin(ctx)
      console.log(`  constructed OK -> ${instance?.constructor?.name}`)
    } catch (error) {
      console.log(`  CONSTRUCT FAILED: ${error?.message}`)
    }
  } catch (error) {
    console.log(`${label}: IMPORT FAILED: ${error?.message}`)
  }
}

// Report every service the context now exposes.
const services = []
for (const key of ['subprocess', 'attachments', 'shell', 'fileUploads', 'sessionController']) {
  services.push(`${key}=${ctx.get(key) === undefined ? 'MISSING' : 'present'}`)
}
console.log('services: ' + services.join('  '))
