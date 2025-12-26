#!/usr/bin/env python3

import datetime
import sys


def unixms(id_val: str, epoch=1) -> int:
    """Convert a Forestrie idtimestamp hex string to a UTC datetime.

    Logic adapted from the reference helper:
    - Optional leading "0x" prefix
    - Length 16 or 18 hex chars
    - If 18 chars, first 2 are the epoch; remaining 16 are the payload
    - Time component = all but the last 3 bytes of the payload
    - Unix ms = time_component + epoch * ((2**40) - 1)
    """

    if id_val.startswith("0x"):
        id_val = id_val[2:]

    if len(id_val) not in (16, 18):
        raise ValueError(f"idtimestamp must be 16 or 18 hex chars, got {len(id_val)}")

    if len(id_val) == 18:
        epoch = int(id_val[:2])
        id_val = id_val[2:]

    if len(id_val) != 16:
        raise ValueError(
            f"idtimestamp payload length must be 16 hex chars after epoch strip, got {len(id_val)}",
        )

    raw_bytes = bytes.fromhex(id_val)
    if len(raw_bytes) < 3:
        raise ValueError(
            "idtimestamp payload too short to strip sequence/generator bytes"
        )

    raw_bytes = bytes.fromhex(id_val)
    if len(raw_bytes) < 3:
        raise ValueError(
            "idtimestamp payload too short to strip sequence/generator bytes"
        )

    unixms = int(raw_bytes[:-3].hex(), 16) + epoch * ((2**40) - 1)
    return unixms


if __name__ == "__main__":
    print(unixms(*sys.argv[1:]))
