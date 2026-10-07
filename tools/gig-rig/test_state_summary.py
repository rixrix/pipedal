"""State identity, custom encoding, secret omission and malformed-input tests."""

import base64
import hashlib
import json
import struct
import unittest

from test_gig_rig import integer, load_module, string

summary = load_module("state_summary")


def variant(value):
    if isinstance(value, bool):
        body = b"\x02" if value else b"\x03"
    elif isinstance(value, float):
        body = b"\x04" + struct.pack("<d", value)
    elif isinstance(value, str):
        body = b"\x05" + string(value)
    elif isinstance(value, bytes):
        body = b"\x08" + value
    elif isinstance(value, int):
        body = b"\x01" + struct.pack("<i", value)
    else:
        raise TypeError("fixture type")
    return integer(len(body)) + body


def node(tag, properties=None, children=None):
    properties, children = properties or {}, children or []
    return (string(tag) + integer(len(properties))
            + b"".join(string(key) + variant(value) for key, value in properties.items())
            + integer(len(children)) + b"".join(children))


def encode(data):
    # Independent integer bit extraction, matching source getBitRange's
    # little-endian bit positions rather than the decoder's byte operations.
    bits = int.from_bytes(data, "little")
    return str(len(data)) + "." + "".join(summary.ALPHABET[(bits >> shift) & 63]
                                          for shift in range(0, len(data) * 8, 6))


def fixture():
    metadata = json.dumps({"id": 7, "title": "Performance Amp", "accountToken": "DO-NOT-PRINT-TOKEN",
        "models": [{"id": 19, "name": "Selected NAM", "model_url": "https://example.invalid/?token=SECRET-URL"}]})
    model = node("CachedModel", {"modelId": 19, "data": b"DO-NOT-PRINT-MODEL-BYTES"})
    left = node("ChainBlocks", children=[node("ChainBlock", {"id": "amp-block", "type": "nam",
        "toneId": 7, "activeModelId": 19, "toneJson": metadata, "enabled": True, "mix": 0.75, "slimSize": 0.5}, [node("ModelCache", children=[model])])])
    ir_metadata = json.dumps({"name": "Cab IR", "models": [{"id": 20, "name": "Selected IR"}]})
    right = node("RightChainBlocks", children=[node("ChainBlock", {"id": "ir-block", "type": "ir",
        "toneId": 8, "activeModelId": 20, "toneJson": ir_metadata},
        [node("ModelCache", children=[node("CachedModel", {"modelId": 20, "data": b"IR-BYTES"})])])])
    return b"T3KB" + node("TONE3000State", {"schemaVersion": 1, "activePresetId": "user:rig-id",
        "activePresetName": "Intended Gig Rig", "accountToken": "DO-NOT-PRINT-ROOT-TOKEN"},
        [node("PARAMETERS", {"privateSetting": "DO-NOT-PRINT-SETTINGS"}),
         node("ChainSnapshot", {"stereoEnabled": True, "branchSide": "left", "branchAfterBlockId": "amp-block"}, [left, right])])


class StateSummaryTests(unittest.TestCase):
    """Inspect stored evidence without equating embedded bytes with readiness.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [DES-SEC] [3.5] [3.6]
    """

    def test_custom_juce_encoding_and_bounds(self):
        # Source alphabet and little-bit ordering give 0xff -> '+C', not '/w=='.
        self.assertEqual(encode(b"\xff"), "1.+C")
        self.assertEqual(summary.decode_state_string("1.+C"), b"\xff")
        for size in range(1, 33):
            raw = bytes(range(size))
            self.assertEqual(summary.decode_state_string(encode(raw)), raw)
        with self.assertRaises(ValueError):
            summary.decode_state_string(encode(b"bound"), 4)
        with self.assertRaises(ValueError):
            summary.decode_state_string("1.+/")
        with self.assertRaises(ValueError):
            summary.decode_state_string("1.++")
        with self.assertRaises(ValueError):
            summary.decode_state_string("2.+C")

    def test_chain_identities_blob_sizes_and_secrets_omitted(self):
        raw = fixture()
        result = summary.summarize_bytes(bytearray(raw))
        self.assertEqual(result["opaque_sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(result["opaque_bytes"], len(raw))
        self.assertEqual(result["active_preset_id"], "user:rig-id")
        self.assertEqual(result["active_preset_name"], "Intended Gig Rig")
        self.assertEqual([block["type"] for block in result["blocks"]], ["nam", "ir"])
        self.assertEqual([block["lane"] for block in result["blocks"]], ["left", "right"])
        self.assertEqual(result["blocks"][0]["active_model_name"], "Selected NAM")
        self.assertEqual(result["blocks"][0]["tone_name"], "Performance Amp")
        self.assertTrue(result["blocks"][0]["enabled"])
        self.assertEqual(result["blocks"][0]["mix"], 0.75)
        self.assertEqual(result["blocks"][0]["slim_size"], 0.5)
        self.assertTrue(result["stereo_enabled"])
        self.assertEqual(result["branch_side"], "left")
        self.assertEqual(result["branch_after_block_id"], "amp-block")
        self.assertEqual(result["blocks"][1]["active_model_name"], "Selected IR")
        self.assertEqual(result["embedded_bytes"], len(b"DO-NOT-PRINT-MODEL-BYTES") + len(b"IR-BYTES"))
        self.assertTrue(result["blocks"][0]["active_model_bytes_present"])
        self.assertFalse(result["readiness_proven"])
        printed = json.dumps(result)
        for forbidden in ("DO-NOT-PRINT", "SECRET-URL", "model_url", "privateSetting", "accountToken", "IR-BYTES"):
            self.assertNotIn(forbidden, printed)

    def test_nested_pedalboard_and_raw_state_payload(self):
        encoded = encode(fixture())
        state = [True, {summary.STATE: {"atomType": summary.ATOM + "String", "value": encoded, "flags": 3}}]
        board = {"items": [{"uri": "uri:split", "topChain": [{"uri": summary.PLUGIN,
                "instanceId": 42, "lv2State": state}], "bottomChain": []}]}
        result = summary.summarize_input(board)
        self.assertEqual(result["states"][0]["instance_id"], 42)
        self.assertTrue(result["states"][0]["lv2_state_valid"])
        self.assertEqual(summary.summarize_input(encoded)["states"][0]["opaque_sha256"], result["states"][0]["opaque_sha256"])

    def test_program_only_records_missing_identity(self):
        value = base64.b64encode(struct.pack("<i", 3)).decode()
        result = summary.summarize_input([True, {summary.PROGRAM: {"atomType": summary.ATOM + "Int", "value": value}}])
        self.assertEqual(result["states"][0]["program"], 3)
        self.assertTrue(result["states"][0]["state_string_missing"])
        self.assertFalse(result["states"][0]["readiness_proven"])

    def test_mixed_state_records_program_precedence_and_unknown_validity(self):
        values = {summary.STATE: {"atomType": summary.ATOM + "String", "value": encode(fixture())},
                  summary.PROGRAM: {"atomType": summary.ATOM + "Int",
                                    "value": base64.b64encode(struct.pack("<i", 4)).decode()}}
        result = summary.summarize_input(values)["states"][0]
        self.assertEqual(result["program"], 4)
        self.assertTrue(result["restore_prefers_program"])
        self.assertEqual(result["active_preset_name"], "Intended Gig Rig")
        self.assertIsNone(result["lv2_state_valid"])

    def test_wrong_magic_schema_truncation_and_unknown_atom_refused(self):
        for raw in (b"T3KS" + fixture()[4:], fixture()[:-2], fixture() + b"extra",
                    b"T3KB" + node("TONE3000State", {"schemaVersion": 2})):
            with self.assertRaises(ValueError):
                summary.summarize_bytes(bytearray(raw))
        with self.assertRaises(ValueError):
            summary.summarize_input([True, {summary.STATE: {"atomType": summary.ATOM + "Float", "value": 1}}])
        with self.assertRaises(ValueError):
            summary.summarize_input({"noToneState": True})


if __name__ == "__main__":
    unittest.main()
