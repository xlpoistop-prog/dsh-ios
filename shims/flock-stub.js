/**
 * flock replacement for iOS: every exclusive lock is granted immediately.
 *
 * Why a stub rather than the real call: the shipped prebuilt addon cannot be
 * loaded here. Its guard rejects `platform === 'ios'`, its darwin binary
 * declares `platform = macOS` in LC_BUILD_VERSION (rewritten, then re-signed),
 * and after both fixes `dlopen` still fails with ERR_DLOPEN_FAILED — the binary
 * links against something this OS does not provide, the same class of failure
 * that rules out the npm ripgrep build (`/usr/lib/libiconv.2.dylib` missing).
 *
 * Why granting unconditionally is safe here: this lock serializes concurrent
 * dsh processes writing one session log. On this device exactly one dsh
 * instance runs — start-and-url.sh tracks it by pid file and kills the previous
 * one before binding — so there is no second writer to exclude. The kernel call
 * would be a no-op in practice; this module makes that explicit instead of
 * failing the boot.
 *
 * The interface matches the real module exactly, so replacing this file with a
 * working implementation later needs no other change.
 *
 * @module @deepseek-ai/node-addon-system/flock (iOS stub)
 * @param fd - Open file descriptor to lock; ownership remains with the caller.
 * @returns A resolved promise, i.e. immediate acquisition.
 */
export async function tryLockExclusive(fd) {
  void fd;
  return;
}

export default { tryLockExclusive };
