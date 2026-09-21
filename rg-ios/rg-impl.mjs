/**
 * A `rg` (ripgrep) replacement for iOS, where no ripgrep binary exists.
 *
 * Why: `@deepseek-ai/dsh-tool-fs-search` resolves `@vscode/ripgrep-<platform>-<arch>`
 * at import time, which is `ripgrep-ios-arm64` here — a package that is not
 * published. The npm darwin-arm64 build is a macOS Mach-O that links
 * `/usr/lib/libiconv.2.dylib`, absent on iOS, so it cannot load. Cross-compiling
 * ripgrep needs a Rust iOS toolchain.
 *
 * What this does instead: the two invocation shapes dsh actually uses —
 * `--files` for glob and `--json` for grep — are implemented directly in
 * JavaScript. No subprocess is spawned, so there is no shell quoting or PATH
 * dependency, and the JSON is emitted in ripgrep's documented schema so the
 * existing parser in dsh-tool-fs-search is unchanged.
 *
 * Two entry points share one implementation:
 *   - the CLI (`node rg-impl.mjs …`) used while bringing this up, and
 *   - the exported `runRgImpl(argv, options)` that dsh-tool-fs-search now calls
 *     IN-PROCESS instead of spawning the `rg` launcher. iOS cannot reliably exec
 *     a shebang script across the jbroot path views, so the launcher is bypassed
 *     entirely; the module is imported and called as a function.
 *
 * The programmatic form never touches `process.exit`, `process.argv`,
 * `process.stdout`, or `process.cwd()` — it takes a `cwd`, writes to a
 * byte-capped sink, honours an AbortSignal, and returns a result object. That
 * matters because it runs inside the long-lived DSH server process: a stray
 * `process.exit` or a process-wide stdout swap would take the server with it.
 *
 * Deliberately not a full ripgrep: the flag set is limited to what dsh passes
 * (observed: `--files`, `--json`, `--hidden`, `--no-config`, `--no-ignore`,
 * plus pattern/glob/type/path arguments). Unknown flags are ignored rather than
 * fatal, so a future dsh version degrades instead of failing.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Directories ripgrep skips by default; honoured unless --no-ignore. */
const DEFAULT_IGNORED_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg', 'vendor'])

/** Files above this size are skipped; a search tool should not read a disk image. */
const MAX_FILE_BYTES = 8 * 1024 * 1024

/** Expand `{a,b}` alternation into separate globs, one level at a time (nested braces supported). */
function expandBraces(glob) {
  const open = glob.indexOf('{')
  if (open === -1) return [glob]
  const close = glob.indexOf('}', open)
  if (close === -1) return [glob]
  const prefix = glob.slice(0, open)
  const body = glob.slice(open + 1, close)
  const suffix = glob.slice(close + 1)
  return body.split(',').flatMap((part) => expandBraces(`${prefix}${part}${suffix}`))
}

/** Convert one brace-free ripgrep glob (with `*`/`?`/`**`) into a RegExp source over a POSIX path. */
function globFragmentToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i += 1 } else out += '[^/]*'
    } else if (ch === '?') out += '[^/]'
    else if ('\\^$.|+()[]{}'.includes(ch)) out += `\\${ch}`
    else out += ch
  }
  return out
}

/** Convert a ripgrep glob (with `*`/`?`/`**` and `{a,b}` alternation) into a RegExp. */
function globToRegExp(glob) {
  const alternatives = expandBraces(glob).map(globFragmentToRegExp)
  return new RegExp(`^(?:${alternatives.join('|')})$`)
}

/** Parse argv into the small subset of ripgrep's interface that dsh uses. */
function parseArgs(argv) {
  const options = {
    mode: 'grep',
    pattern: null,
    paths: [],
    globs: [],
    types: [],
    ignoreCase: false,
    fixedStrings: false,
    wordRegexp: false,
    maxCount: 0,
    hidden: false,
    noIgnore: false,
    filesWithMatchesOnly: false,
    countOnly: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--') { options.paths.push(...argv.slice(i + 1)); break }
    if (arg === '--files') { options.mode = 'files'; continue }
    if (arg === '--json') { options.mode = 'json'; continue }
    if (arg === '--hidden') { options.hidden = true; continue }
    if (arg === '--no-ignore' || arg === '--no-ignore-vcs') { options.noIgnore = true; continue }
    if (arg === '--no-config' || arg === '--no-messages' || arg === '--line-number'
      || arg === '--with-filename' || arg === '--color=never' || arg === '--no-heading') continue
    if (arg === '-i' || arg === '--ignore-case') { options.ignoreCase = true; continue }
    if (arg === '-F' || arg === '--fixed-strings') { options.fixedStrings = true; continue }
    if (arg === '-w' || arg === '--word-regexp') { options.wordRegexp = true; continue }
    if (arg === '-l' || arg === '--files-with-matches') { options.filesWithMatchesOnly = true; continue }
    if (arg === '-c' || arg === '--count') { options.countOnly = true; continue }
    if (arg === '-n' || arg === '--line-number') continue

    if (arg === '-e' || arg === '--regexp') { options.pattern = argv[++i]; continue }
    if (arg === '-g' || arg === '--glob') { options.globs.push(argv[++i]); continue }
    if (arg === '-t' || arg === '--type') { options.types.push(argv[++i]); continue }
    if (arg === '-m' || arg === '--max-count') { options.maxCount = Number(argv[++i]) || 0; continue }
    if (arg === '-A' || arg === '-B' || arg === '-C' || arg === '--after-context'
      || arg === '--before-context' || arg === '--context') { i += 1; continue }

    // dsh passes the pattern and include in `--flag=value` form: `--regexp=…`,
    // `--glob=…`. Handle those before the generic "-flag is ignored" fallback.
    if (arg.startsWith('--regexp=')) { options.pattern = arg.slice(9); continue }
    if (arg.startsWith('--glob=')) { options.globs.push(arg.slice(7)); continue }
    if (arg.startsWith('--type=')) { options.types.push(arg.slice(7)); continue }
    if (arg.startsWith('--max-count=')) { options.maxCount = Number(arg.slice(12)) || 0; continue }
    if (arg.startsWith('-')) continue

    // A leading non-flag argument is the pattern in grep mode, else a path.
    if (options.mode === 'files' || options.pattern !== null) options.paths.push(arg)
    else options.pattern = arg
  }

  if (options.paths.length === 0) options.paths.push('.')
  return options
}

/** Build the search RegExp from the pattern and flags. */
function buildMatcher(options) {
  if (options.pattern === null) throw new Error('rg-wrapper: no pattern supplied')
  let source = options.fixedStrings ? options.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : options.pattern
  if (options.wordRegexp) source = `\\b(?:${source})\\b`
  try {
    return new RegExp(source, options.ignoreCase ? 'gi' : 'g')
  } catch (error) {
    // Keep ripgrep's "regex parse error" wording: dsh-tool-fs-search classifies
    // that phrase as SEARCH_INVALID_PATTERN rather than a generic SEARCH_FAILED.
    throw new Error(`regex parse error: ${options.pattern}: ${error?.message ?? error}`)
  }
}

/** Throw when the caller's AbortSignal has fired, so a timeout stops the walk. */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    const reason = signal.reason
    if (reason instanceof Error) throw reason
    throw new Error('aborted')
  }
}

/** Recursively collect candidate file paths under `root`. */
async function collectFiles(root, options, out, signal) {
  throwIfAborted(signal)
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return }

  for (const entry of entries) {
    throwIfAborted(signal)
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!options.noIgnore && DEFAULT_IGNORED_DIRS.has(entry.name)) continue
      if (!options.hidden && entry.name.startsWith('.')) continue
      await collectFiles(full, options, out, signal)
      continue
    }
    if (!entry.isFile()) continue
    if (!options.hidden && entry.name.startsWith('.')) continue
    out.push(full)
  }
}

/** Whether a path passes the --glob filters (include and `!`-exclusion forms). */
function passesGlobs(path, options) {
  if (options.globs.length === 0) return true
  const posix = path.split(sep).join('/')
  let included = false
  let sawPositive = false
  for (const raw of options.globs) {
    const negation = raw.startsWith('!')
    const glob = negation ? raw.slice(1) : raw
    const re = globToRegExp(glob.includes('/') ? glob : `**/${glob}`)
    const matches = re.test(posix) || globToRegExp(glob).test(posix.split('/').pop())
    if (negation) { if (matches) return false }
    else { sawPositive = true; if (matches) included = true }
  }
  return sawPositive ? included : true
}

/** Emit one ripgrep JSON line to the caller's stdout sink. */
function emitJson(write, value) {
  write(`${JSON.stringify(value)}\n`)
}

/** ripgrep-shaped TextValue wrapper. */
function text(value) { return { text: value } }

/** Strip a trailing CR so CRLF files report clean lines. */
function stripCr(line) { return line.endsWith('\r') ? line.slice(0, -1) : line }

async function runFiles(options, cwd, write, signal) {
  throwIfAborted(signal)
  const files = []
  for (const target of options.paths) {
    await collectFiles(resolve(cwd, target), options, files, signal)
  }
  const filtered = files
    .filter((file) => passesGlobs(file, options))
    .sort()
    .map((file) => relative(cwd, file).split(sep).join('/'))
  for (const file of filtered) write(`${file}\n`)
  return filtered.length === 0 ? 1 : 0
}

async function runJson(options, cwd, write, signal) {
  throwIfAborted(signal)
  const matcher = buildMatcher(options)
  const files = []
  for (const target of options.paths) {
    throwIfAborted(signal)
    try {
      const info = await stat(resolve(cwd, target))
      if (info.isFile()) files.push(resolve(cwd, target))
      else await collectFiles(resolve(cwd, target), options, files, signal)
    } catch (error) {
      if (signal?.aborted) throw error
      /* unreadable target: ripgrep would report and continue */
    }
  }

  let totalMatches = 0
  let totalMatchedLines = 0
  let searchesWithMatch = 0

  for (const file of files) {
    throwIfAborted(signal)
    if (!passesGlobs(file, options)) continue
    let info
    try { info = await stat(file) } catch { continue }
    if (info.size > MAX_FILE_BYTES) continue

    let buffer
    try { buffer = await readFile(file) } catch { continue }
    if (buffer.includes(0)) continue // binary

    const content = buffer.toString('utf8')
    const lines = content.split('\n')
    const displayPath = relative(cwd, file).split(sep).join('/')

    let fileMatches = 0
    const matchEvents = []

    for (let index = 0; index < lines.length; index += 1) {
      if ((index & 1023) === 0) throwIfAborted(signal)
      const line = stripCr(lines[index])
      matcher.lastIndex = 0
      const submatches = []
      let hit
      while ((hit = matcher.exec(line)) !== null) {
        submatches.push({ match: text(hit[0]), start: hit.index, end: hit.index + hit[0].length })
        if (hit[0] === '') matcher.lastIndex += 1 // guard against zero-width loops
      }
      if (submatches.length === 0) continue
      fileMatches += 1
      matchEvents.push({
        type: 'match',
        data: {
          path: text(displayPath),
          lines: text(`${line}\n`),
          line_number: index + 1,
          absolute_offset: 0,
          submatches,
        },
      })
      if (options.maxCount > 0 && fileMatches >= options.maxCount) break
    }

    if (fileMatches === 0) continue
    searchesWithMatch += 1
    totalMatches += fileMatches
    totalMatchedLines += fileMatches

    emitJson(write, { type: 'begin', data: { path: text(displayPath) } })
    for (const event of matchEvents) emitJson(write, event)
    emitJson(write, {
      type: 'end',
      data: {
        path: text(displayPath),
        binary_offset: null,
        stats: {
          elapsed: { secs: 0, nanos: 0, human: '0s' },
          searches: 1,
          searches_with_match: 1,
          bytes_searched: buffer.length,
          bytes_printed: buffer.length,
          matched_lines: fileMatches,
          matches: fileMatches,
        },
      },
    })
  }

  emitJson(write, {
    type: 'summary',
    data: {
      elapsed_total: { human: '0s', nanos: 0, secs: 0 },
      stats: {
        elapsed: { human: '0s', nanos: 0, secs: 0 },
        searches: files.length,
        searches_with_match: searchesWithMatch,
        bytes_searched: 0,
        bytes_printed: 0,
        matched_lines: totalMatchedLines,
        matches: totalMatches,
      },
    },
  })

  return totalMatches === 0 ? 1 : 0
}

/**
 * A byte-capped in-memory sink shaped like the little of `process.stdout` the
 * implementation needs. Once the cap is crossed it stops retaining and reports
 * `lossy`, which the caller turns into a `SEARCH_RAW_OUTPUT_OVERFLOW` failure —
 * the same disposition the subprocess-seam budget had.
 */
function makeSink(maxBytes) {
  const chunks = []
  let bytes = 0
  let isLossy = false
  return {
    write(chunk) {
      if (isLossy) return false
      const value = typeof chunk === 'string' ? chunk : String(chunk)
      const size = Buffer.byteLength(value, 'utf8')
      if (bytes + size > maxBytes) { isLossy = true; return false }
      bytes += size
      chunks.push(value)
      return true
    },
    get text() { return chunks.join('') },
    get lossy() { return isLossy },
  }
}

/**
 * Run the replacement in-process. Returns
 * `{ exitCode, stdout, stderr, stdoutLossy, stderrLossy, aborted }` where
 * `exitCode` is ripgrep's 0 (results), 1 (no results) or 2 (error), and is
 * `null` when an AbortSignal fired first. Never throws and never exits the host
 * process.
 *
 * @param {string[]} argv - ripgrep arguments (without the binary name).
 * @param {object} [options]
 * @param {string} [options.cwd] - directory targets resolve against and paths are printed relative to.
 * @param {AbortSignal} [options.signal] - cooperative cancellation from the caller.
 * @param {number} [options.stdoutMaxBytes] - cap on retained stdout; beyond it `stdoutLossy` is set.
 * @param {number} [options.stderrMaxBytes] - cap on retained stderr; beyond it `stderrLossy` is set.
 */
export async function runRgImpl(argv, options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const signal = options.signal
  const stdout = makeSink(options.stdoutMaxBytes ?? Number.POSITIVE_INFINITY)
  const stderr = makeSink(options.stderrMaxBytes ?? Number.POSITIVE_INFINITY)
  const write = (chunk) => { stdout.write(chunk) }
  const writeErr = (chunk) => { stderr.write(chunk) }

  try {
    throwIfAborted(signal)
    const parsed = parseArgs(argv)
    const exitCode = parsed.mode === 'files'
      ? await runFiles(parsed, cwd, write, signal)
      : await runJson(parsed, cwd, write, signal)
    return {
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutLossy: stdout.lossy,
      stderrLossy: stderr.lossy,
      aborted: false,
    }
  } catch (error) {
    if (signal?.aborted) {
      return {
        exitCode: null,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutLossy: stdout.lossy,
        stderrLossy: stderr.lossy,
        aborted: true,
      }
    }
    writeErr(`rg-wrapper: ${error?.message ?? error}\n`)
    return {
      exitCode: 2,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutLossy: stdout.lossy,
      stderrLossy: stderr.lossy,
      aborted: false,
    }
  }
}

/** Whether this module was started as the CLI entry point rather than imported. */
function isMainModule() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try { return import.meta.url === pathToFileURL(entry).href } catch { return false }
}

/** CLI form: run once and exit with ripgrep's status. `process.exit` is safe here (single-purpose process). */
async function main() {
  const result = await runRgImpl(process.argv.slice(2), { cwd: process.cwd() })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exitCode = result.exitCode ?? 2
}

if (isMainModule()) main()
