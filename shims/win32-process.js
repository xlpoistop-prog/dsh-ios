/**
 * Drop-in replacement for `@deepseek-ai/dsh-win32-process` on iOS.
 *
 * Why this exists: the real package evaluates `koffi.pointer()`, `koffi.struct()`
 * and two exact Win32 ABI-size assertions (`STARTUPINFOW.size === 104`,
 * `PROCESS_INFORMATION.size === 24`) at module-evaluation time. Koffi ships no
 * iOS prebuild, so importing the package aborts the whole boot before any
 * plugin mounts — and `@deepseek-ai/dsh-subprocess-local` imports it
 * statically, so disabling the `subprocess` config row alone does not avoid it.
 *
 * Why a stub is safe here: every export below is reachable only on Windows.
 * The subprocess seam is Windows-Job-object plumbing, and on this device
 * `posix_spawn` is refused by the process sandbox anyway (child-process launch
 * returns ENOENT for every executable, including /usr/bin/true), so no
 * subprocess-backed capability can function regardless of this module.
 *
 * Each export throws a diagnostic naming itself, so an accidental future call
 * is self-explaining rather than a bare TypeError. Nothing here is evaluated
 * at import time.
 *
 * @module @deepseek-ai/dsh-win32-process (iOS stub)
 */

const REASON =
  'Win32 process bindings are unavailable on iOS. The dsh subprocess seam is '
  + 'Windows-only plumbing, and child-process creation is refused by this '
  + 'device\'s sandbox, so reaching this function means a platform guard is missing.';

/** Build a named export that fails loudly only when actually invoked. */
function unavailable(name) {
  return function unavailableWin32Binding() {
    throw new Error(`${name}(): ${REASON}`);
  };
}

/** Win32 code reporting a caller-provided buffer is too small (kept for parity). */
export const ERROR_INSUFFICIENT_BUFFER = 122;

/** Win32 call failure carrying the API name and error code. */
export class Win32Error extends Error {
  constructor(api, win32Code, detail) {
    super(`${api} failed (Win32 ${win32Code})${detail === undefined ? '' : `: ${detail}`}`);
    this.name = 'Win32Error';
    this.api = api;
    this.win32Code = win32Code;
  }
}

export const allocPtrSlot = unavailable('allocPtrSlot');
export const allocUint32 = unavailable('allocUint32');
export const closeHandleChecked = unavailable('closeHandleChecked');
export const decodePtr = unavailable('decodePtr');
export const decodeUint32 = unavailable('decodeUint32');
export const drainPipe = unavailable('drainPipe');
export const extendWin32ProcessBindings = unavailable('extendWin32ProcessBindings');
export const isJobEmpty = unavailable('isJobEmpty');
export const isNullPtr = (value) => value === null || value === undefined || value === 0n;
export const loadWin32ProcessBindings = unavailable('loadWin32ProcessBindings');
export const pollProcessExit = unavailable('pollProcessExit');
export const probeCurrentTokenJobSupport = unavailable('probeCurrentTokenJobSupport');
export const spawnCurrentTokenJobProcess = unavailable('spawnCurrentTokenJobProcess');
export const spawnInheritedJobProcess = unavailable('spawnInheritedJobProcess');
export const spawnPipedProcess = unavailable('spawnPipedProcess');
export const terminateJob = unavailable('terminateJob');
export const throwLastError = unavailable('throwLastError');
export const throwWin32 = unavailable('throwWin32');
export const waitForProcessExit = unavailable('waitForProcessExit');
