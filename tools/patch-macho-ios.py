#!/usr/bin/env python3
"""
Rewrite a Mach-O's declared platform so it can be loaded on iOS.

Why this is needed: node-pty ships darwin-arm64 prebuilds, and dyld refuses to
map them on iOS even though the file otherwise matches, because the Mach-O
header declares the platform as macOS:

    (mach-o file, but incompatible platform (have 'macOS', need 'iOS'))

The declared platform lives in the LC_BUILD_VERSION load command (or its
predecessors LC_VERSION_MIN_MACOSX / LC_VERSION_MIN_IPHONEOS). LC_BUILD_VERSION
carries a `platform` field with a fixed width, so macOS (1) can be rewritten to
iOS (2) in place without moving any other byte in the file. The code signature
is invalidated by the edit, which is expected: ldid re-signs it afterwards.

Usage: patch-macho-ios.py <path> [<path> ...]
Exit status is non-zero when a file has no rewritable platform field.
"""

import struct
import sys

MH_MAGIC_64 = 0xFEEDFACF
LC_BUILD_VERSION = 0x32
LC_VERSION_MIN_MACOSX = 0x24
LC_VERSION_MIN_IPHONEOS = 0x25
LC_CODE_SIGNATURE = 0x1D

PLATFORM_MACOS = 1
PLATFORM_IOS = 2

PLATFORM_NAMES = {
    1: "macOS",
    2: "iOS",
    3: "tvOS",
    4: "watchOS",
    6: "MacCatalyst",
    7: "iOS-simulator",
}


def patch(path):
    with open(path, "r+b") as handle:
        header = handle.read(32)
        if len(header) < 32:
            raise SystemExit(f"{path}: too small to be Mach-O")

        magic, cputype, cpusubtype, filetype, ncmds, sizeofcmds, flags, _reserved = (
            struct.unpack("<IiiIIIII", header)
        )
        if magic != MH_MAGIC_64:
            raise SystemExit(f"{path}: not a 64-bit little-endian Mach-O (magic 0x{magic:08X})")

        offset = 32
        rewrote = False
        for _ in range(ncmds):
            handle.seek(offset)
            raw = handle.read(8)
            if len(raw) < 8:
                break
            cmd, cmdsize = struct.unpack("<II", raw)
            if cmdsize < 8:
                raise SystemExit(f"{path}: load command has invalid size {cmdsize}")

            if cmd == LC_BUILD_VERSION:
                handle.seek(offset + 8)
                platform, minos, sdk = struct.unpack("<III", handle.read(12))
                name = PLATFORM_NAMES.get(platform, f"unknown({platform})")
                if platform == PLATFORM_IOS:
                    print(f"{path}: LC_BUILD_VERSION already iOS; nothing to do")
                    return True
                if platform != PLATFORM_MACOS:
                    print(f"{path}: LC_BUILD_VERSION platform is {name}; not rewriting")
                    return False
                handle.seek(offset + 8)
                handle.write(struct.pack("<I", PLATFORM_IOS))
                minos_str = f"{minos >> 16}.{(minos >> 8) & 0xFF}"
                sdk_str = f"{sdk >> 16}.{(sdk >> 8) & 0xFF}"
                print(
                    f"{path}: LC_BUILD_VERSION {name} -> iOS "
                    f"(minos {minos_str}, sdk {sdk_str} preserved)"
                )
                rewrote = True
            elif cmd == LC_VERSION_MIN_MACOSX:
                # Legacy 16-byte version_min_command; no platform field exists,
                # so convert it into an equivalent LC_BUILD_VERSION in place.
                handle.seek(offset)
                handle.write(struct.pack("<II", LC_BUILD_VERSION, 24))
                handle.seek(offset + 8)
                minos, sdk = struct.unpack("<II", handle.read(8))
                handle.write(struct.pack("<III", PLATFORM_IOS, minos, sdk))
                print(f"{path}: LC_VERSION_MIN_MACOSX -> LC_BUILD_VERSION(iOS)")
                rewrote = True

            offset += cmdsize

        if not rewrote:
            print(f"{path}: no rewritable platform field found")
        return rewrote


def main(argv):
    if len(argv) < 2:
        raise SystemExit(__doc__.strip())
    ok = True
    for path in argv[1:]:
        ok = patch(path) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
