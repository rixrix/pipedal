#!/usr/bin/env python3
"""Apply the approved JUCE 9.0.3 LV2 patch with exact provenance checks."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

RELATIVE_SOURCE = Path("modules/juce_audio_plugin_client/juce_audio_plugin_client_LV2.cpp")
ORIGINAL_SHA256 = "3e7942f9de59081c13f0816b58de42b86079a9c4f9c1bcef2917efa155b15843"
PATCHED_SHA256 = "c569c8184c496e5cc4378ffbf237e29162de54e15a6da32ebea2f6cbb0bc45ed"
PATCH_SHA256 = "c510d987c087301c8b959881b1447a8eca2c0f2272b51323c603bcb546d02b82"
PATCH_FILE = Path(__file__).with_name("tone3000-juce-readback.patch")


class PatchError(RuntimeError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def apply_hunks(source, patch):
    """Apply exact line hunks; refuse offsets, fuzz, extra files or mismatched context.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-UI] [2.8]
    """
    lines = patch.splitlines(keepends=True)
    expected = RELATIVE_SOURCE.as_posix()
    if lines[:2] != [f"--- a/{expected}\n", f"+++ b/{expected}\n"]:
        raise PatchError("Unexpected patch file target")
    original = source.splitlines(keepends=True)
    result, cursor, index = [], 0, 2
    while index < len(lines):
        match = re.fullmatch(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\n", lines[index])
        if not match:
            raise PatchError("Invalid patch hunk header")
        old_start = int(match[1]) - 1
        old_count = int(match[2] or 1)
        new_count = int(match[4] or 1)
        if old_start < cursor or old_start > len(original):
            raise PatchError("Overlapping or out-of-range patch hunk")
        result.extend(original[cursor:old_start])
        cursor = old_start
        consumed = produced = 0
        index += 1
        while index < len(lines) and not lines[index].startswith("@@ "):
            line = lines[index]
            kind, content = line[:1], line[1:]
            if kind in (" ", "-"):
                if cursor >= len(original) or original[cursor] != content:
                    raise PatchError("Patch anchor/context differs from pinned JUCE source")
                cursor += 1
                consumed += 1
            if kind in (" ", "+"):
                result.append(content)
                produced += 1
            if kind not in (" ", "-", "+"):
                raise PatchError("Invalid patch hunk line")
            index += 1
        if (consumed, produced) != (old_count, new_count):
            raise PatchError("Patch hunk line counts differ")
    result.extend(original[cursor:])
    return "".join(result)


def apply(source_root, check=False):
    """Patch only the pinned LV2 wrapper, preserving line endings and file mode.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [NFR-6] [DES-UI] [2.8]
    """
    target = Path(source_root) / RELATIVE_SOURCE
    raw = target.read_bytes()
    normalized = raw.replace(b"\r\n", b"\n")
    source_hash = digest(normalized)
    patch_bytes = PATCH_FILE.read_bytes()
    if digest(patch_bytes) != PATCH_SHA256:
        raise PatchError("Patch artifact digest differs from the reviewed patch")
    if source_hash == PATCHED_SHA256:
        return {"action": "already-patched", "source": str(target), "normalized_sha256": source_hash,
                "binary_source_sha256": digest(raw), "patch_sha256": PATCH_SHA256}
    if source_hash != ORIGINAL_SHA256:
        raise PatchError(f"JUCE source differs from pinned 9.0.3: {source_hash}")
    if check:
        raise PatchError("Pinned JUCE source is valid but the readback patch is not applied")
    patched = apply_hunks(normalized.decode("utf-8"), patch_bytes.decode("utf-8")).encode("utf-8")
    if digest(patched) != PATCHED_SHA256:
        raise PatchError("Patched source digest differs from the reviewed result")
    if b"\r\n" in raw:
        if raw.count(b"\r\n") != raw.count(b"\n"):
            raise PatchError("Mixed source line endings are unsupported")
        patched = patched.replace(b"\n", b"\r\n")
    mode = target.stat().st_mode
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + ".afx-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(patched)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, target)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {"action": "patched", "source": str(target), "normalized_sha256": PATCHED_SHA256,
            "binary_source_sha256": digest(patched), "patch_sha256": PATCH_SHA256}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Pinned JUCE source root")
    parser.add_argument("--check", action="store_true", help="Verify already-patched source without writing")
    args = parser.parse_args()
    try:
        print(json.dumps(apply(args.source, args.check), sort_keys=True))
    except (PatchError, OSError, UnicodeError) as error:
        parser.exit(1, f"T3K_LV2_PATCH_GET: {error}\n")


if __name__ == "__main__":
    main()
