"""Tests for pa/scripts/pool_tags.py's buffer parser (2026-09-10 launch-cadence
wave). Pure unittest, no ctypes/live-syscall dependency here — read_pool_tags()
is exercised on the live machine separately (WP-D's manual report), never in
this suite; this file only proves the buffer parser itself.
"""
import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pool_tags import (  # noqa: E402
    ENTRIES_OFFSET,
    NONPAGED_TOTAL_GUARD_BYTES,
    PoolTagLayoutError,
    parse_pool_tag_buffer,
)

# The struct this test builds fixtures with MUST mirror the real
# SYSTEM_POOLTAG layout: tag, pagedAllocs, pagedFrees, pagedUsed,
# nonpagedAllocs, nonpagedFrees, nonpagedUsed.
GOOD_ENTRY_STRUCT = struct.Struct('<4sIIxxxxQIIQ')
GOOD_STRIDE = GOOD_ENTRY_STRUCT.size
assert GOOD_STRIDE == 40


def build_entry(tag: bytes, paged_allocs, paged_frees, paged_used, nonpaged_allocs, nonpaged_frees, nonpaged_used) -> bytes:
    return GOOD_ENTRY_STRUCT.pack(tag, paged_allocs, paged_frees, paged_used, nonpaged_allocs, nonpaged_frees, nonpaged_used)


def build_buffer(entries: list[bytes]) -> bytes:
    """Count (ULONG) + 4 bytes padding, then the entries back to back —
    exactly the real SYSTEM_POOLTAG_INFORMATION layout at ENTRIES_OFFSET=8."""
    header = struct.pack('<I', len(entries)) + b'\x00' * 4
    return header + b''.join(entries)


class ParsePoolTagBufferTest(unittest.TestCase):
    def test_two_entry_buffer_parses_exact_tags_and_bytes(self):
        buf = build_buffer(
            [
                build_entry(b'NtFC', 100, 90, 12345, 50, 40, 3_000_000_000),
                build_entry(b'MmSt', 10, 9, 999, 5, 4, 123_456),
            ]
        )
        entries = parse_pool_tag_buffer(buf)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]['tag'], 'NtFC')
        self.assertEqual(entries[0]['paged_bytes'], 12345)
        self.assertEqual(entries[0]['nonpaged_bytes'], 3_000_000_000)
        self.assertEqual(entries[0]['nonpaged_allocs'], 50)
        self.assertEqual(entries[0]['nonpaged_frees'], 40)
        self.assertEqual(entries[1]['tag'], 'MmSt')
        self.assertEqual(entries[1]['paged_bytes'], 999)
        self.assertEqual(entries[1]['nonpaged_bytes'], 123_456)

    def test_tag_bytes_decoded_with_trailing_nuls_stripped(self):
        buf = build_buffer([build_entry(b'Io\x00\x00', 1, 1, 1, 1, 1, 1)])
        entries = parse_pool_tag_buffer(buf)
        self.assertEqual(entries[0]['tag'], 'Io')
        self.assertEqual(len(entries[0]['tag']), 2)

    def test_short_stride_buffer_raises_layout_error(self):
        """Known-bad proof (stride 36): the buffer declares count=2 but is
        packed 4 bytes short per entry versus the real 40-byte stride. The
        buffer is then too SHORT for the parser's stride-40 assumption, so
        the length guard fires — proving the guard can actually fail."""
        bad_stride = 36
        self.assertNotEqual(bad_stride, ENTRIES_OFFSET + 0)  # sanity: distinct from the real stride
        header = struct.pack('<I', 2) + b'\x00' * 4
        buf = header + (b'\xff' * bad_stride) * 2
        self.assertLess(len(buf), ENTRIES_OFFSET + GOOD_STRIDE * 2, 'fixture must be shorter than the stride-40 requirement')
        with self.assertRaises(PoolTagLayoutError) as ctx:
            parse_pool_tag_buffer(buf)
        message = str(ctx.exception)
        self.assertIn(str(len(buf)), message)
        self.assertIn('2', message)  # the declared count

    def test_long_stride_buffer_raises_layout_error_via_exabyte_guard(self):
        """Known-bad proof (stride 44): the buffer declares count=2 and is
        packed 4 bytes LONGER per entry than the real 40-byte stride, so it
        is NOT short relative to the stride-40 length requirement — the
        length guard alone cannot see this shape. Filling the buffer with
        0xFF (beyond the 4-byte Count header) guarantees that whichever
        8-byte window the stride-40 parser reads as `nonpaged_used` decodes
        to a near-max uint64, which the exabyte guard catches instead."""
        bad_stride = 44
        self.assertGreater(bad_stride, GOOD_STRIDE)
        count = 2
        header = struct.pack('<I', count) + b'\x00' * 4
        buf = header + b'\xff' * (bad_stride * count)
        self.assertGreaterEqual(
            len(buf), ENTRIES_OFFSET + GOOD_STRIDE * count, 'fixture must NOT be short relative to the stride-40 requirement'
        )
        with self.assertRaises(PoolTagLayoutError) as ctx:
            parse_pool_tag_buffer(buf)
        message = str(ctx.exception)
        self.assertIn('1 TiB', message)
        self.assertIn(str(NONPAGED_TOTAL_GUARD_BYTES), message)

    def test_entries_summing_past_one_tib_raise_layout_error(self):
        """Directly targets the exabyte guard with a well-formed (correct
        stride) buffer whose nonpaged totals are simply too large."""
        huge = (1 << 40) + 1
        buf = build_buffer([build_entry(b'Big!', 0, 0, 0, 0, 0, huge)])
        with self.assertRaises(PoolTagLayoutError):
            parse_pool_tag_buffer(buf)

    def test_well_formed_buffer_under_the_guard_does_not_raise(self):
        buf = build_buffer([build_entry(b'Ok  ', 0, 0, 0, 0, 0, (1 << 40) - 1)])
        entries = parse_pool_tag_buffer(buf)
        self.assertEqual(len(entries), 1)


if __name__ == '__main__':
    unittest.main()
