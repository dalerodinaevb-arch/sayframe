#!/usr/bin/env python3
"""Склеивает две программы для Mac (Apple-чип arm64 и Intel x86_64) в одну «универсальную».

  python3 tools/make_universal.py <arm64-файл> <x86_64-файл> <результат>

На Mac это делает команда lipo; здесь то же самое записано напрямую, чтобы собирать на любой системе.
Формат простой: заголовок со списком частей, затем сами программы, каждая выровнена на 16 КБ.
"""
import struct
import sys

FAT_MAGIC = 0xCAFEBABE
MH_MAGIC_64 = 0xFEEDFACF
CPU_X86_64, CPU_ARM64 = 0x01000007, 0x0100000C
LC_CODE_SIGNATURE = 0x1D
ALIGN = 14  # 2**14 = 16384


def inspect(data, want_cpu, name):
    """Проверяет, что это 64-битная программа нужной архитектуры; возвращает (cputype, cpusubtype, подписана ли)."""
    if len(data) < 32:
        sys.exit("%s: файл слишком мал" % name)
    magic, cputype, cpusubtype, filetype, ncmds, sizeofcmds = struct.unpack_from("<IiiIII", data, 0)
    if magic != MH_MAGIC_64:
        sys.exit("%s: это не 64-битная программа Mach-O" % name)
    if cputype & 0xFFFFFFFF != want_cpu:
        sys.exit("%s: не та архитектура (0x%08x)" % (name, cputype & 0xFFFFFFFF))
    signed = False
    off = 32
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", data, off)
        if cmd == LC_CODE_SIGNATURE:
            signed = True
        off += size
    return cputype & 0xFFFFFFFF, cpusubtype & 0xFFFFFFFF, signed


def main(arm_path, intel_path, out_path):
    parts = []
    for path, cpu in ((intel_path, CPU_X86_64), (arm_path, CPU_ARM64)):
        data = open(path, "rb").read()
        cputype, cpusubtype, signed = inspect(data, cpu, path)
        if cpu == CPU_ARM64 and not signed:
            sys.exit("%s: программа для Apple-чипа не подписана, macOS не станет её запускать" % path)
        parts.append((cputype, cpusubtype, data))

    header_size = 8 + 20 * len(parts)
    offset = header_size
    table, body = b"", b""
    for cputype, cpusubtype, data in parts:
        offset = (offset + (1 << ALIGN) - 1) & ~((1 << ALIGN) - 1)
        table += struct.pack(">IIIII", cputype, cpusubtype, offset, len(data), ALIGN)
        body += b"\0" * (offset - header_size - len(body)) + data
        offset += len(data)
    with open(out_path, "wb") as f:
        f.write(struct.pack(">II", FAT_MAGIC, len(parts)) + table + body)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
