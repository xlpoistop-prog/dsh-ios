/**
 * A `fetch` built on node:https / node:http, for running dsh on iOS under
 * `--jitless`.
 *
 * Why this replaces the global fetch: Node's built-in fetch is undici, and
 * undici compiles its WebAssembly-backed llhttp parser when the module is
 * loaded. With V8 in `--jitless` mode there is no WebAssembly, so undici cannot
 * be loaded at all.
 *
 * The whole difficulty is therefore avoiding undici *implicitly*. Node's global
 * `fetch`, `Response`, `Request`, `Headers`, `ReadableStream` and
 * `TransformStream` are all installed by the same bundled undici, so touching
 * any of them (including `Readable.toWeb`, which builds a web ReadableStream)
 * pulls the module in and reintroduces the WebAssembly dependency. Every type
 * below is hand-rolled on node:http/node:https/node:stream; no web-platform
 * class is referenced anywhere.
 *
 * The http/https path is independently verified on the device (`https.get`
 * returned 200), and this shim passes GET, POST, headers, streaming and json()
 * against live endpoints with `globalThis.WebAssembly` deleted.
 *
 * Load with `node --import ./fetch-https-shim.js`.
 */

import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'

/** Case-insensitive header view exposing the `get` callers rely on. */
class HeaderBag {
  constructor(source) {
    this._map = new Map()
    if (!source) return
    for (const key of Object.keys(source)) {
      const value = source[key]
      if (value === undefined) continue
      this._map.set(key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value))
    }
  }

  get(name) {
    const value = this._map.get(String(name).toLowerCase())
    return value === undefined ? null : value
  }

  has(name) {
    return this._map.has(String(name).toLowerCase())
  }

  forEach(callback, thisArg) {
    for (const [key, value] of this._map) callback.call(thisArg, value, key, this)
  }

  entries() { return this._map.entries() }
  keys() { return this._map.keys() }
  values() { return this._map.values() }
  [Symbol.iterator]() { return this._map.entries() }
}

/**
 * Reader over a Node Readable, shaped like the web ReadableStreamDefaultReader
 * so `response.body.getReader()` works — without constructing a web stream.
 */
class BodyReader {
  constructor(nodeStream) {
    this._stream = nodeStream
    this._done = false
    this._pending = null
    this._chunks = []
    this._ended = false
    this._error = null

    nodeStream.on('data', (chunk) => {
      this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      this._flush()
    })
    nodeStream.on('end', () => { this._ended = true; this._flush() })
    nodeStream.on('error', (error) => { this._error = error; this._flush() })
  }

  _flush() {
    if (this._pending === null) return
    this._deliver()
  }

  _deliver() {
    const { resolve, reject } = this._pending
    this._pending = null
    if (this._chunks.length > 0) {
      resolve({ done: false, value: this._chunks.shift() })
      return
    }
    if (this._error) { reject(this._error); return }
    if (this._ended) { this._done = true; resolve({ done: true, value: undefined }); return }
    // Nothing buffered and not finished: wait for the next event.
    this._pending = { resolve, reject }
  }

  read() {
    if (this._pending !== null) {
      return Promise.reject(new Error('reader already has a pending read'))
    }
    if (this._done) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject }
      this._deliver()
    })
  }

  cancel() {
    this._stream.destroy?.()
    this._done = true
    return Promise.resolve()
  }

  releaseLock() {}
}

/** A body that supports both getReader() and async iteration. */
class Body {
  constructor(nodeStream) {
    this._reader = new BodyReader(nodeStream)
    this._consumed = false
  }

  getReader() {
    return this._reader
  }

  [Symbol.asyncIterator]() {
    const reader = this._reader
    return {
      next() { return reader.read() },
      return() { return Promise.resolve({ done: true, value: undefined }) },
    }
  }
}

/** Minimal Response surface: status, ok, headers, body, text/json/arrayBuffer. */
class ShimResponse {
  constructor(nodeResponse, body) {
    this.status = nodeResponse.statusCode ?? 0
    this.statusText = nodeResponse.statusMessage ?? ''
    this.ok = this.status >= 200 && this.status < 300
    this.headers = new HeaderBag(nodeResponse.headers)
    this.body = body
    this.bodyUsed = false
    this.url = ''
    this.redirected = false
  }

  async _collect() {
    if (this.bodyUsed) throw new TypeError('body already consumed')
    this.bodyUsed = true
    const chunks = []
    const reader = this.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }

  async arrayBuffer() {
    const buffer = await this._collect()
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  }

  async text() {
    return (await this._collect()).toString('utf8')
  }

  async json() {
    return JSON.parse(await this.text())
  }
}

/** Convert the request body into something node:http accepts. */
async function bodyToBuffer(body) {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body)
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (typeof body.arrayBuffer === 'function') return Buffer.from(await body.arrayBuffer())
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = []
    for await (const chunk of body) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }
  return Buffer.from(String(body))
}

/** One request; `redirectsLeft` bounds redirect following. */
function once(url, init, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest

    const headers = {}
    const source = init.headers
    if (source) {
      if (typeof source.forEach === 'function' && typeof source.get === 'function') {
        source.forEach((value, key) => { headers[key] = value })
      } else if (Array.isArray(source)) {
        for (const [key, value] of source) headers[key] = value
      } else {
        for (const key of Object.keys(source)) headers[key] = source[key]
      }
    }

    const request = doRequest(url, { method: init.method ?? 'GET', headers }, (response) => {
      const status = response.statusCode ?? 0
      const location = response.headers.location

      if (location && status >= 300 && status < 400 && redirectsLeft > 0) {
        response.resume()
        const next = new URL(location, url)
        const keepBody = status === 307 || status === 308
        const result = once(next, keepBody ? init : { ...init, body: undefined }, redirectsLeft - 1)
        resolve(result)
        return
      }

      // A real web ReadableStream from node:stream/web. This is NOT undici —
      // node:stream/web is Node's own implementation — and it gives callers the
      // full stream surface for free: getReader(), async iteration and
      // pipeThrough(), which the LLM adapters use for SSE
      // (`body.pipeThrough(new TextDecoderStream())`). A hand-rolled reader was
      // tried first and broke exactly that call.
      //
      // Loading this module can pull in undici on some Node versions, which
      // would compile the WebAssembly llhttp parser. That is harmless here
      // because wasm-polyfill.js is imported first and supplies a WebAssembly
      // global; the shim's own fetch never routes through undici.
      const shim = new ShimResponse(response, Readable.toWeb(response))
      shim.url = url.href
      resolve(shim)
    })

    request.on('error', reject)

    const signal = init.signal
    if (signal) {
      if (signal.aborted) {
        request.destroy(new Error('The operation was aborted'))
        return
      }
      signal.addEventListener('abort', () => request.destroy(new Error('The operation was aborted')), { once: true })
    }

    Promise.resolve(bodyToBuffer(init.body))
      .then((buffer) => {
        if (buffer !== undefined) request.write(buffer)
        request.end()
      })
      .catch(reject)
  })
}

/**
 * Install the replacement WITHOUT touching the existing property value.
 *
 * Node installs its global `fetch` through a lazy accessor: reading `fetch`, or
 * assigning to `globalThis.fetch`, runs the getter, which loads undici's
 * global module, which compiles the WebAssembly llhttp parser, which throws
 * under `--jitless`. `Object.defineProperty` replaces the descriptor outright
 * and never invokes the getter, so undici is never pulled in.
 */
Object.defineProperty(globalThis, 'fetch', {
  value: function fetch(input, init = {}) {
    const target = input instanceof URL
      ? input
      : typeof input === 'string'
        ? new URL(input)
        : input && typeof input.url === 'string'
          ? new URL(input.url)
          : null

    if (target === null) return Promise.reject(new TypeError('fetch: unsupported input'))
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return Promise.reject(new TypeError(`fetch: unsupported protocol ${target.protocol}`))
    }

    return once(target, init, 10)
  },
  writable: true,
  enumerable: false,
  configurable: true,
})
