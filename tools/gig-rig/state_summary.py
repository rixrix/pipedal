#!/usr/bin/env python3
"""Read-only TONE3000 opaque-state identities; observations never prove readiness."""

import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys

PLUGIN = "https://www.tone3000.com/plugin"
STATE = PLUGIN + ":StateString"
PROGRAM = PLUGIN + ":Program"
ATOM = "http://lv2plug.in/ns/ext/atom#"
ALPHABET = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+"
DEFAULT_LIMIT = 256 * 1024 * 1024


def decode_state_string(text, limit=DEFAULT_LIMIT):
    """Decode JUCE 9.0.3 MemoryBlock's length-prefixed, little-endian sextets.

    This is not RFC 4648 base64. Encoding is verified against official
    juce_MemoryBlock.cpp getBitRange/toBase64Encoding/fromBase64Encoding.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [3.5] [3.6]
    """
    if not isinstance(text, str):
        raise ValueError("StateString must be text")
    match = re.match(r"(0|[1-9][0-9]{0,9})\.", text)
    if not match:
        raise ValueError("Unsupported JUCE StateString framing")
    size = int(match[1])
    if size > limit:
        raise ValueError("StateString exceeds decoded-byte bound")
    encoded = text[match.end():]
    if len(encoded) != (size * 8 + 5) // 6:
        raise ValueError("StateString encoded length disagrees with byte count")
    numbers = {char: index for index, char in enumerate(ALPHABET)}
    result = bytearray(size)
    for index, char in enumerate(encoded):
        value = numbers.get(char)
        if value is None:
            raise ValueError("Unsupported StateString character")
        bit = index * 6
        byte, offset = divmod(bit, 8)
        remaining = size * 8 - bit
        if remaining < 6 and value >> remaining:
            raise ValueError("StateString contains nonzero padding bits")
        result[byte] |= (value << offset) & 255
        if offset > 2 and byte + 1 < size:
            result[byte + 1] |= value >> (8 - offset)
    return result


class StateTreeReader:
    """Bounded ValueTree walk retaining only approved identity/asset fields.

    Binary model payloads are hashed in-place; settings, URLs, tokens, MIDI
    maps and unknown property values are skipped and never returned.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [DES-SEC] [3.5]
    """

    KEEP = {"TONE3000State": {"schemaVersion", "activePresetId", "activePresetName"},
            "ChainSnapshot": {"stereoEnabled", "branchSide", "branchAfterBlockId"},
            "ChainBlock": {"id", "type", "toneId", "activeModelId", "toneJson", "enabled", "mix", "slimSize"},
            "CachedModel": {"modelId", "data"}}

    def __init__(self, data):
        self.data, self.pos, self.nodes = data, 4, 0

    def read(self, size):
        if size < 0 or self.pos + size > len(self.data):
            raise ValueError("Truncated ValueTree")
        start = self.pos
        self.pos += size
        return memoryview(self.data)[start:self.pos]

    def integer(self):
        marker = self.read(1)[0]
        count = marker & 0x7f
        if count > 4:
            raise ValueError("Invalid compressed integer")
        value = int.from_bytes(self.read(count), "little")
        return -value if marker & 0x80 else value

    def string(self):
        end = self.data.find(b"\0", self.pos, min(len(self.data), self.pos + 65536))
        if end < 0:
            raise ValueError("Invalid/oversized ValueTree identifier")
        value = bytes(self.read(end - self.pos)).decode("utf-8")
        self.read(1)
        return value

    def variant(self, keep=False, binary=False):
        count = self.integer()
        if count == 0:
            return None
        if count < 1:
            raise ValueError("Negative ValueTree variant size")
        value = self.read(count)
        marker, body = value[0], value[1:]
        if marker not in range(1, 10):
            raise ValueError("Unsupported ValueTree variant marker")
        if not keep:
            return None
        if binary:
            if marker != 8:
                raise ValueError("Unsupported cached model data serialization")
            return {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        if marker == 5:
            if len(body) > 1024 * 1024 or not len(body) or body[-1] != 0 or 0 in body[:-1]:
                raise ValueError("Invalid/oversized identity string")
            return bytes(body[:-1]).decode("utf-8")
        if marker == 1 and len(body) == 4:
            return struct.unpack("<i", body)[0]
        if marker == 6 and len(body) == 8:
            return struct.unpack("<q", body)[0]
        if marker in (2, 3) and not len(body):
            return marker == 2
        if marker == 4 and len(body) == 8:
            result = struct.unpack("<d", body)[0]
            if not math.isfinite(result):
                raise ValueError("Nonfinite observed chain setting")
            return result
        raise ValueError("Unsupported identity field type")

    def tree(self, depth=0):
        self.nodes += 1
        if self.nodes > 100000 or depth > 64:
            raise ValueError("ValueTree exceeds complexity bound")
        tag = self.string()
        if not tag:
            raise ValueError("Empty ValueTree type")
        count = self.integer()
        if not 0 <= count <= 10000:
            raise ValueError("Invalid property count")
        properties = {}
        for _ in range(count):
            key = self.string()
            keep = key in self.KEEP.get(tag, set())
            value = self.variant(keep, binary=tag == "CachedModel" and key == "data")
            if keep:
                properties[key] = value
        children = self.integer()
        if not 0 <= children <= 100000:
            raise ValueError("Invalid child count")
        return {"type": tag, "properties": properties,
                "children": [self.tree(depth + 1) for _ in range(children)]}


def identity_text(value):
    """Only scalar stored names/IDs are exposed, never arbitrary metadata.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [3.5]
    """
    return value if isinstance(value, (str, int)) else None


def summarize_bytes(data):
    """Report stored chain identities and embedded bytes, without readiness.

    Pinned ProcessorState.cpp writes T3KB + TONE3000State schema 1.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [3.5] [3.6]
    """
    if data[:4] != b"T3KB":
        raise ValueError("Unsupported TONE3000 state magic; pinned source uses T3KB")
    reader = StateTreeReader(data)
    tree = reader.tree()
    if reader.pos != len(data) or tree["type"] != "TONE3000State":
        raise ValueError("Unsupported/trailing TONE3000 state data")
    properties = tree["properties"]
    schema = properties.get("schemaVersion", 1)
    if schema != 1:
        raise ValueError("Unsupported TONE3000 state schema")
    blocks = []
    snapshots = [child for child in tree["children"] if child["type"] == "ChainSnapshot"]
    if len(snapshots) > 1:
        raise ValueError("Ambiguous multiple chain snapshots")
    for snapshot in snapshots:
        for lane in snapshot["children"]:
            if lane["type"] not in ("ChainBlocks", "RightChainBlocks"):
                continue
            for index, block in enumerate(lane["children"]):
                if block["type"] != "ChainBlock":
                    continue
                props = block["properties"]
                kind = props.get("type")
                if kind not in ("nam", "ir", "insert"):
                    raise ValueError("Unsupported chain block type")
                tone = {}
                if props.get("toneJson"):
                    try:
                        tone = json.loads(props["toneJson"])
                    except (TypeError, ValueError) as error:
                        raise ValueError("Invalid stored tone metadata JSON") from error
                    if not isinstance(tone, dict):
                        raise ValueError("Unsupported stored tone metadata")
                active_model = props.get("activeModelId")
                model_name = None
                for model in tone.get("models", []) if isinstance(tone.get("models", []), list) else []:
                    if isinstance(model, dict) and model.get("id") == active_model:
                        model_name = identity_text(model.get("name"))
                cached = []
                for cache in block["children"]:
                    if cache["type"] != "ModelCache":
                        continue
                    for model in cache["children"]:
                        if model["type"] == "CachedModel":
                            fields = model["properties"]
                            blob = fields.get("data") or {"bytes": 0, "sha256": None}
                            cached.append({"model_id": identity_text(fields.get("modelId")),
                                           "embedded_bytes": blob["bytes"], "embedded_sha256": blob["sha256"]})
                blocks.append({"lane": "left" if lane["type"] == "ChainBlocks" else "right", "index": index,
                    "block_id": identity_text(props.get("id")), "type": kind,
                    "tone_id": identity_text(props.get("toneId")), "tone_name": identity_text(tone.get("title", tone.get("name"))),
                    "enabled": props.get("enabled"), "mix": props.get("mix"), "slim_size": props.get("slimSize"),
                    "active_model_id": identity_text(active_model), "active_model_name": model_name,
                    "cached_models": cached, "embedded_bytes": sum(model["embedded_bytes"] for model in cached),
                    "active_model_bytes_present": any(model["model_id"] == active_model and model["embedded_bytes"] > 0 for model in cached)})
    return {"opaque_sha256": hashlib.sha256(data).hexdigest(), "opaque_bytes": len(data), "schema": schema,
            "active_preset_id": identity_text(properties.get("activePresetId")),
            "active_preset_name": identity_text(properties.get("activePresetName")),
            "chain_snapshot_present": bool(snapshots), "blocks": blocks,
            "stereo_enabled": snapshots[0]["properties"].get("stereoEnabled") if snapshots else None,
            "branch_side": snapshots[0]["properties"].get("branchSide") if snapshots else None,
            "branch_after_block_id": snapshots[0]["properties"].get("branchAfterBlockId") if snapshots else None,
            "embedded_bytes": sum(block["embedded_bytes"] for block in blocks),
            "readiness_proven": False,
            "observation_only": "Stored identity and embedded bytes do not establish loaded engines or audible readiness"}


def summarize_input(value, limit=DEFAULT_LIMIT):
    """Accept StateString text, LV2 state arrays, and nested pedalboard JSON.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [3.5] [3.6]
    """
    if isinstance(value, str):
        return {"states": [summarize_bytes(decode_state_string(value, limit))]}
    states = []
    nodes = 0
    def walk(node, instance_id=None, depth=0):
        nonlocal nodes
        nodes += 1
        if depth > 64 or nodes > 100000:
            raise ValueError("JSON exceeds complexity bound")
        if isinstance(node, list):
            if len(node) == 2 and isinstance(node[0], bool) and isinstance(node[1], dict) and (STATE in node[1] or PROGRAM in node[1]):
                values = node[1]
                program = None
                if PROGRAM in values:
                    entry = values[PROGRAM]
                    if not isinstance(entry, dict) or entry.get("atomType") != ATOM + "Int":
                        raise ValueError("Unsupported Program LV2 atom type")
                    try:
                        raw = base64.b64decode(entry.get("value"), validate=True)
                    except (TypeError, ValueError) as error:
                        raise ValueError("Invalid Program atom encoding") from error
                    if len(raw) != 4:
                        raise ValueError("Invalid Program atom size")
                    program = struct.unpack("<i", raw)[0]
                if STATE in values:
                    entry = values[STATE]
                    if not isinstance(entry, dict) or entry.get("atomType") != ATOM + "String":
                        raise ValueError("Unsupported StateString LV2 atom type")
                    summary = summarize_bytes(decode_state_string(entry.get("value"), limit))
                else:
                    summary = {"state_string_missing": True, "readiness_proven": False}
                if program is not None:
                    # JUCE retrieve checks Program first and returns before
                    # StateString. A mixed payload's stored identity is not
                    # the identity that this restore necessarily loads.
                    summary.update(program=program, restore_prefers_program=True)
                summary.update(lv2_state_valid=node[0], instance_id=instance_id)
                states.append(summary)
                return
            for child in node:
                walk(child, instance_id, depth + 1)
        elif isinstance(node, dict):
            if node.get("uri") == PLUGIN:
                instance_id = node.get("instanceId") if isinstance(node.get("instanceId"), int) else None
            if STATE in node or PROGRAM in node:
                walk([True, node], instance_id, depth + 1)
                # Bare property maps provide no PiPedal validity flag.
                states[-1]["lv2_state_valid"] = None
                return
            for child in node.values():
                if isinstance(child, (dict, list)):
                    walk(child, instance_id, depth + 1)
    walk(value)
    if not states:
        raise ValueError("No supported TONE3000 LV2 state found")
    return {"states": states}


def main(argv=None):
    """Print only whitelisted summaries; private input stays outside Git.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FILES] [DES-SEC] [3.5] [3.6]
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, nargs="?", help="Private JSON/StateString file; default stdin")
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_LIMIT)
    args = parser.parse_args(argv)
    try:
        if not 4 <= args.max_bytes <= 1024 * 1024 * 1024:
            raise ValueError("Byte bound must be between 4 and 1 GiB")
        bound = args.max_bytes * 2 + 1024 * 1024
        if args.input:
            if args.input.stat().st_size > bound:
                raise ValueError("Input file exceeds size bound")
            with args.input.open("rb") as stream:
                raw = stream.read(bound + 1)
        else:
            raw = sys.stdin.buffer.read(bound + 1)
        if len(raw) > bound:
            raise ValueError("Input exceeds size bound")
        text = raw.decode("utf-8").strip()
        value = json.loads(text) if text.startswith(("{", "[", '"')) else text
        print(json.dumps(summarize_input(value, args.max_bytes), indent=2, ensure_ascii=False))
    except (OSError, ValueError, RecursionError) as error:
        print(f"state_summary: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
