#!/usr/bin/env python3
# 01 - iOS base port patches for the Node.js source tree.
#
# Ported to Node 24.21.0 from j0shua-SYSON/node-ios scripts/ios-source-fixups.sh
# (MIT License, https://github.com/j0shua-SYSON/node-ios). The patch *set* is
# theirs; the anchors below were re-derived against 24.21.0 and every one is
# checked before it is applied, so a silent no-op is not possible.
#
# Each patch carries a `marker`: a string that exists only after that patch has
# been applied. Idempotency is decided by the marker, not by re-testing the
# anchor -- an "insert before this anchor" patch leaves its own anchor in place,
# so testing the anchor would insert a second copy on every run. (Learned by
# validating against the real 24.21.0 tree: the first version of this script did
# exactly that and produced two OS=="ios" blocks in common.gypi.)
#
# Usage: 01-ios-base.py <node-source-dir>
import sys
import pathlib

applied, skipped = [], []


def fail(msg):
    print("FAIL: " + msg, file=sys.stderr)
    sys.exit(1)


def patch(src, rel, old, new, label, marker, count=1):
    """Replace `old` with `new` in src/rel, once, unless `marker` is present."""
    p = src / rel
    if not p.exists():
        fail(f"{rel} does not exist — wrong source tree?")
    s = p.read_text(encoding="utf-8")
    if marker in s:
        skipped.append(label)
        print(f"  skip (already applied): {label}")
        return
    found = s.count(old)
    if found != count:
        fail(f"{rel}: expected {count} match(es) for '{label}', found {found}\n"
             f"      anchor: {old[:110]!r}")
    p.write_text(s.replace(old, new), encoding="utf-8")
    applied.append(label)
    print(f"  applied: {label}")


def main():
    if len(sys.argv) != 2:
        fail("usage: 01-ios-base.py <node-source-dir>")
    src = pathlib.Path(sys.argv[1]).resolve()
    if not (src / "node.gyp").exists():
        fail(f"{src} does not look like a Node.js source tree")
    print(f"== iOS base patches -> {src}")

    # --- gyp's make generator wraps static libraries in GNU linker groups, and
    # Apple's ld64 rejects -Wl,--start-group/--end-group outright. ld64 resolves
    # archives with a global view, so the groups are unnecessary. Stripping them
    # from every link template is far less invasive than remapping the flavor,
    # which would shift obj.host library paths and break the js2c host link.
    p = src / "tools/gyp/pylib/gyp/generator/make.py"
    if not p.exists():
        fail("gyp make generator not found")
    s = p.read_text(encoding="utf-8")
    stripped = s.replace(" -Wl,--start-group", "").replace(" -Wl,--end-group", "")
    if stripped == s:
        skipped.append("gyp link groups")
        print("  skip (already applied): gyp link groups")
    else:
        p.write_text(stripped, encoding="utf-8")
        applied.append("gyp link groups")
        print("  applied: gyp link groups (-Wl,--start-group/--end-group)")

    # --- Node's macOS keychain CA reader is guarded with `#ifdef __APPLE__`, but
    # it calls SecTrustSettings*, which is macOS-only. __APPLE__ is defined on iOS
    # too, so the guard has to name the OS. Not needed here: Node's bundled
    # Mozilla roots handle TLS.
    #
    # Two things differ from the reference script on purpose. It replaces every
    # `#ifdef __APPLE__` in the file, which also drops the
    # `#include <Security/Security.h>` (iOS has Security.framework, so that
    # include is not the problem). And it does not add the header that defines
    # TARGET_OS_OSX. This narrows exactly the two macOS-only code sites and makes
    # sure the macro is defined.
    patch(src, "src/crypto/crypto_context.cc",
          "#include <Security/Security.h>",
          "#include <Security/Security.h>\n"
          "#if defined(__APPLE__)\n"
          "#include <TargetConditionals.h>\n"
          "#endif",
          "crypto_context.cc includes TargetConditionals.h",
          marker="#include <TargetConditionals.h>")
    patch(src, "src/crypto/crypto_context.cc",
          "#ifdef __APPLE__\nTrustStatus IsTrustDictionaryTrustedForPolicy(",
          "#if defined(__APPLE__) && TARGET_OS_OSX\nTrustStatus IsTrustDictionaryTrustedForPolicy(",
          "crypto SecTrustSettings code excluded on iOS",
          marker="#if defined(__APPLE__) && TARGET_OS_OSX\nTrustStatus")
    patch(src, "src/crypto/crypto_context.cc",
          "#ifdef __APPLE__\n  ReadMacOSKeychainCertificates(&system_store_certs);\n#endif",
          "#if defined(__APPLE__) && TARGET_OS_OSX\n  ReadMacOSKeychainCertificates(&system_store_certs);\n#endif",
          "crypto macOS keychain call excluded on iOS",
          marker="#if defined(__APPLE__) && TARGET_OS_OSX\n  ReadMacOSKeychainCertificates")

    # --- Link the Darwin frameworks on iOS.
    # gyp applies xcode_settings.OTHER_LDFLAGS only for flavor=="mac", so an
    # "ios" flavor links no frameworks at all. Abseil's timezone lookup (pulled in
    # by V8) needs CoreFoundation; other deps want CoreServices and Security.
    # link_settings.libraries is honored by any flavor and reaches every target.
    patch(src, "common.gypi",
          "      ['OS==\"mac\"', {\n"
          "        'defines': ['_DARWIN_USE_64_BIT_INODE=1'],",
          "      # iOS port: a flavor of \"ios\" gets no OTHER_LDFLAGS, so the Darwin\n"
          "      # frameworks have to be linked this way instead.\n"
          "      ['OS==\"ios\"', {\n"
          "        'link_settings': { 'libraries': [\n"
          "          '-framework CoreFoundation',\n"
          "          '-framework CoreServices',\n"
          "          '-framework Security',\n"
          "        ] },\n"
          "      }],\n"
          "      ['OS==\"mac\"', {\n"
          "        'defines': ['_DARWIN_USE_64_BIT_INODE=1'],",
          "common.gypi links CoreFoundation/CoreServices/Security on iOS",
          marker="iOS port: a flavor of \"ios\" gets no OTHER_LDFLAGS")

    # --- Do not ask for MAP_JIT on iOS.
    # V8 requests MAP_JIT pages for all of Darwin. On iOS those pages are not
    # executable -- the recipe records an on-device probe result of `[map-jit]
    # FAIL`, with allow-jit and platform-application re-signing making no
    # difference. Excluding iOS lets the code range come from plain anonymous
    # pages, which this port then maps a second time for execution; see
    # 03-fix-wx-alias.py.
    patch(src, "deps/v8/src/base/platform/platform-posix.cc",
          "#if V8_OS_DARWIN\n"
          "  // MAP_JIT is required to obtain writable and executable pages when the",
          "#if V8_OS_DARWIN && !defined(V8_OS_IOS)\n"
          "  // MAP_JIT is required to obtain writable and executable pages when the",
          "V8 does not use MAP_JIT on iOS",
          marker="#if V8_OS_DARWIN && !defined(V8_OS_IOS)")

    # --- c-ares: the iOS SDK has no <sys/random.h> (it has arc4random_buf).
    # cares.gyp points both mac and ios at config/darwin, so undef the macro and
    # let ares_rand.c fall back to arc4random_buf, which is already detected.
    patch(src, "deps/cares/config/darwin/ares_config.h",
          "#define HAVE_SYS_RANDOM_H 1",
          "/* #undef HAVE_SYS_RANDOM_H -- the iOS SDK does not ship it */",
          "c-ares HAVE_SYS_RANDOM_H undef'd",
          marker="the iOS SDK does not ship it")

    print(f"== done: {len(applied)} applied, {len(skipped)} already applied")
    return 0


if __name__ == "__main__":
    sys.exit(main())
