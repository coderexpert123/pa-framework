"""Nonpaged kernel pool attribution via NtQuerySystemInformation (2026-09-10
launch-cadence wave).

The 2026-09-10 disk-saturation incident's root cause (a per-user font-handle
loop leaking NTFS file-control blocks under pool tag "NtFC") was findable in
minutes once the tag was known. RAMMap's own scan never finishes on a
starved machine, and `poolmon` needs the Windows Driver Kit, so
NtQuerySystemInformation(SystemPoolTagInformation) via ctypes is the only
reliable path on a bare deployment.

Buffer layout (x64 only): a ULONG Count at offset 0, then entries of stride
40 starting at offset 8, each struct.Struct('<4sIIxxxxQIIQ') decoding to
(tag, pagedAllocs, pagedFrees, pagedUsed, nonpagedAllocs, nonpagedFrees,
nonpagedUsed). Getting this stride wrong turns totals into exabytes, which
is exactly why the two guards below are hard errors and not comments.

Output contract: one line of JSON on stdout, exit 0, e.g.
{"ok":true,"totalNonpagedBytes":0,"totalPagedBytes":0,"tagCount":0,
 "top":[{"tag":"NtFC","nonpagedBytes":0,"nonpagedAllocs":0,"nonpagedFrees":0}]}
On any failure: nothing on stdout, one line on stderr, exit 1. Never a
partial or degraded reading.
"""

import argparse
import ctypes
import json
import struct
import sys

# SYSTEM_POOLTAG_INFORMATION: ULONG Count at offset 0, then entries at
# offset 8 (natural alignment padding for the SIZE_T fields inside each
# SYSTEM_POOLTAG entry).
ENTRIES_OFFSET = 8
# SYSTEM_POOLTAG: UCHAR Tag[4]; ULONG PagedAllocs; ULONG PagedFrees;
# SIZE_T PagedUsed; ULONG NonPagedAllocs; ULONG NonPagedFrees;
# SIZE_T NonPagedUsed. On x64 this is exactly 40 bytes.
ENTRY_STRIDE = 40
ENTRY_STRUCT = struct.Struct('<4sIIxxxxQIIQ')

SYSTEM_POOL_TAG_INFORMATION = 22
STATUS_INFO_LENGTH_MISMATCH = 0xC0000004
INITIAL_BUFFER_BYTES = 1024 * 1024
MAX_BUFFER_BYTES = 64 * 1024 * 1024

# No real machine has a terabyte of nonpaged pool; a summed total in that
# range means the struct is misaligned, not that the machine is dying.
NONPAGED_TOTAL_GUARD_BYTES = 1 << 40


class PoolTagLayoutError(ValueError):
    """A pool-tag buffer's shape contradicts its own declared count, or
    decodes to an implausible total. Both are wrong-stride reads, never a
    real machine reading — see the module docstring."""


def parse_pool_tag_buffer(buf: bytes):
    """Parse a SYSTEM_POOLTAG_INFORMATION buffer into per-tag entries.

    Returns a list of dicts: {'tag': str, 'paged_bytes': int,
    'nonpaged_bytes': int, 'nonpaged_allocs': int, 'nonpaged_frees': int}.

    Raises PoolTagLayoutError when the buffer's length is inconsistent with
    its own declared count (a wrong-stride read, not a short read), or when
    the summed nonpaged total exceeds a terabyte (a misaligned read, not a
    real reading).
    """
    if len(buf) < 4:
        raise PoolTagLayoutError(f'buffer too short to hold a Count field: {len(buf)} bytes')

    count = struct.unpack_from('<I', buf, 0)[0]
    required = ENTRIES_OFFSET + ENTRY_STRIDE * count
    if len(buf) < required:
        raise PoolTagLayoutError(
            f'buffer length {len(buf)} is inconsistent with declared count {count} '
            f'(needs at least {required} bytes at stride {ENTRY_STRIDE}) - '
            'this is a wrong-stride read, not a short read'
        )

    entries = []
    nonpaged_total = 0
    for i in range(count):
        offset = ENTRIES_OFFSET + i * ENTRY_STRIDE
        (
            tag_bytes,
            paged_allocs,
            paged_frees,
            paged_used,
            nonpaged_allocs,
            nonpaged_frees,
            nonpaged_used,
        ) = ENTRY_STRUCT.unpack_from(buf, offset)
        tag = tag_bytes.rstrip(b'\x00').decode('ascii', errors='replace')
        nonpaged_total += nonpaged_used
        entries.append(
            {
                'tag': tag,
                'paged_bytes': paged_used,
                'nonpaged_bytes': nonpaged_used,
                'nonpaged_allocs': nonpaged_allocs,
                'nonpaged_frees': nonpaged_frees,
            }
        )

    if nonpaged_total > NONPAGED_TOTAL_GUARD_BYTES:
        raise PoolTagLayoutError(
            f'summed nonpaged total {nonpaged_total} bytes exceeds the {NONPAGED_TOTAL_GUARD_BYTES}-byte '
            '(1 TiB) guard - no real machine has this much nonpaged pool; the struct is misaligned'
        )

    return entries


def read_pool_tags(top_n: int) -> dict:
    """Read live nonpaged/paged pool-tag totals via NtQuerySystemInformation.

    Returns {'totalNonpagedBytes', 'totalPagedBytes', 'tagCount', 'top'} —
    the same shape as the CLI's JSON contract, minus the outer 'ok' field.
    Raises RuntimeError on a non-win32 platform, a non-x64 process, or an
    unexpected NTSTATUS.
    """
    if sys.platform != 'win32':
        raise RuntimeError('pool_tags.py: SystemPoolTagInformation is Windows-only')
    if ctypes.sizeof(ctypes.c_void_p) != 8:
        raise RuntimeError('pool_tags.py: the pool-tag buffer layout is x64-only')

    ntdll = ctypes.WinDLL('ntdll')
    nt_query_system_information = ntdll.NtQuerySystemInformation
    nt_query_system_information.restype = ctypes.c_uint32
    nt_query_system_information.argtypes = [
        ctypes.c_int32,
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_uint32),
    ]

    size = INITIAL_BUFFER_BYTES
    buf = None
    while True:
        buf = ctypes.create_string_buffer(size)
        return_length = ctypes.c_uint32(0)
        status = nt_query_system_information(
            SYSTEM_POOL_TAG_INFORMATION,
            ctypes.cast(buf, ctypes.c_void_p),
            size,
            ctypes.byref(return_length),
        )
        if status == 0:
            break
        if status == STATUS_INFO_LENGTH_MISMATCH and size < MAX_BUFFER_BYTES:
            size *= 2
            continue
        raise RuntimeError(f'NtQuerySystemInformation failed with NTSTATUS 0x{status:08X}')

    entries = parse_pool_tag_buffer(buf.raw)
    entries.sort(key=lambda e: e['nonpaged_bytes'], reverse=True)
    top = entries[:top_n]

    return {
        'totalNonpagedBytes': sum(e['nonpaged_bytes'] for e in entries),
        'totalPagedBytes': sum(e['paged_bytes'] for e in entries),
        'tagCount': len(entries),
        'top': [
            {
                'tag': e['tag'],
                'nonpagedBytes': e['nonpaged_bytes'],
                'nonpagedAllocs': e['nonpaged_allocs'],
                'nonpagedFrees': e['nonpaged_frees'],
            }
            for e in top
        ],
    }


def main(argv):
    parser = argparse.ArgumentParser(
        description='Read nonpaged kernel pool tag attribution via NtQuerySystemInformation.'
    )
    parser.add_argument('--top', type=int, default=3, help='Number of top tags (by nonpaged bytes) to report.')
    args = parser.parse_args(argv)

    try:
        result = read_pool_tags(args.top)
    except Exception as exc:  # deliberately broad: any failure is a declared job failure, never a partial reading
        print(str(exc), file=sys.stderr)
        return 1

    payload = {'ok': True, **result}
    sys.stdout.write(json.dumps(payload) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
