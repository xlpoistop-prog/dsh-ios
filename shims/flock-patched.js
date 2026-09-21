/**
 * POSIX flock entry, patched to run on iOS.
 *
 * Three obstacles, all addressed here plus in install-flock-fix.sh:
 *
 *  1. The shipped guard rejects any platform that is not linux or darwin:
 *       if (platform !== 'linux' && platform !== 'darwin') throw ... unsupported
 *     iOS IS Darwin and flock(2) is a libSystem call present on the device, so
 *     the guard is the only problem. Accepted below, with the addon *package*
 *     name mapped to darwin.
 *
 *  2. The darwin addon's bin/system.node declares platform = macOS in
 *     LC_BUILD_VERSION, which iOS's dyld refuses to map. install-flock-fix.sh
 *     rewrites that single byte and re-signs.
 *
 *  3. Most importantly: under roothide, dlopen with an ABSOLUTE /var/mobile
 *     path fails with "no such file" even though the file exists — the shell
 *     and the process resolve that prefix through different namespaces. This is
 *     the same failure that broke absolute --import and absolute entry-point
 *     paths earlier. node-pty loads fine precisely because it uses a RELATIVE
 *     require. So the patched addon is copied next to this module and required
 *     as './system.node', which resolves against the module's own directory.
 *
 * @module @deepseek-ai/node-addon-system/flock (iOS-patched)
 */
import { createRequire } from 'node:module';

let binding;

function loadBinding() {
  if (binding) return binding;

  const { platform, arch } = process;
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'ios') {
    throw Object.assign(new Error(`flock is not supported on ${platform}-${arch}`), {
      code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',
      syscall: 'flock',
    });
  }

  // Relative to this module: absolute paths do not survive the roothide
  // namespace boundary. install-flock-fix.sh places the patched, re-signed
  // prebuild here.
  const require = createRequire(import.meta.url);
  binding = require('./system.node');
  return binding;
}

/**
 * Attempt an exclusive, nonblocking POSIX flock on the caller's descriptor.
 * The syscall runs in asynchronous work, so acquisition can occur after this
 * call returns. Keep fd open until the promise settles; the binding never
 * opens, duplicates, or closes it. Closing the locked descriptor releases the
 * lock once all descriptors for its open file description are closed.
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A promise resolving to void on acquisition. Contention rejects with
 *   EAGAIN/EWOULDBLOCK; other syscall failures also reject. Syscall errors carry
 *   code, positive errno, and syscall='flock'.
 */
export async function tryLockExclusive(fd) {
  const errno = await new Promise((resolve) => {
    loadBinding().tryLock(fd, resolve);
  });
  if (errno === 0) return;
  const { getSystemErrorName } = await import('node:util');
  const code = getSystemErrorName(-errno);
  throw Object.assign(new Error(`${code}: flock failed`), {
    code,
    errno,
    syscall: 'flock',
  });
}
