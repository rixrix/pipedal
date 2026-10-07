"""Deterministic bank-local preservation and actual supported protocol checks."""

from copy import deepcopy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import build_bank as b
from test_qualification import ProtocolMock
from test_state_summary import encode, node


def archive(board=None, bank=None):
    with io.BytesIO() as stream:
        with zipfile.ZipFile(stream, "w") as output:
            output.writestr("bankFile.json", json.dumps(bank if bank is not None else {"presets": [{"preset": board}]}))
        return stream.getvalue()


def state_board(label):
    metadata = json.dumps({"title": label, "models": [{"id": 19, "name": "Reference NAM"}]})
    block = node("ChainBlock", {"id": "model-block", "type": "nam", "toneId": 7,
        "activeModelId": 19, "toneJson": metadata, "enabled": True},
        [node("ModelCache", children=[node("CachedModel", {"modelId": 19, "data": b"reference-model"})])])
    raw = b"T3KB" + node("TONE3000State", {"schemaVersion": 1, "activePresetId": "factory:" + label,
        "activePresetName": label}, [node("ChainSnapshot", {"stereoEnabled": False},
            [node("ChainBlocks", children=[block]), node("RightChainBlocks")])])
    return {"name": "TEST diagnostic wire name", "items": [{"instanceId": 3, "uri": b.PLUGIN,
        "isEnabled": True, "lilvPresetUri": "", "lv2State": [True, {b.PLUGIN + ":StateString":
            {"atomType": b.ATOM + "String", "value": encode(raw), "flags": 3}}]}],
        "nextInstanceId": 4, "snapshots": []}


def inputs():
    result = []
    for label in ("Dumble Spread", "Matchless Crunch"):
        board = state_board(label)
        name, item, state = b.validate_single(board)
        result.append({"label": name, "item": item, "state": state, "board": board,
                       "source": "private-fixture.piPreset", "sha256": "fixture"})
    return result


class BankMock(ProtocolMock):
    """Clone IDs overlap source IDs, but edits/deletes are scoped by current bank.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [3.7] [5.3]
    """
    def __init__(self):
        super().__init__()
        self.index["entries"] = [{"instanceId": 7, "name": "Factory Presets"},
                                 {"instanceId": 4, "name": "Original"}]
        self.os_values = {}
        self.stock = {"name": "Factory Presets", "selectedPreset": 8,
                      "presets": [{"instanceId": 8, "preset": deepcopy(self.boards[(7, 8)])}]}
        self.fail_save = False
        self.corrupt_stock = False

    def request(self, message, body=None):
        if message == "saveBankAs":
            identifier = super().request(message, body)
            entry = self.index["entries"].pop()
            source_pos = next(i for i, item in enumerate(self.index["entries"]) if item["instanceId"] == body["bankId"])
            self.index["entries"].insert(source_pos + 1, entry)
            return identifier
        if message in ("plugins", "moveBank", "deletePresetItems", "getPatchProperty", "setPatchProperty"):
            self.calls.append(("request", message, deepcopy(body)))
        if message == "plugins":
            return [{"uri": b.PLUGIN, "name": "TONE3000"}] + [
                {"uri": uri, "name": "TooB " + str(i), "controls": [
                    {"symbol": "MUTE" if i == 0 else "amount", "is_input": True, "default_value": 1 if i == 0 else 0.3},
                    {"symbol": "meter", "is_input": False, "default_value": 0}]} for i, uri in enumerate(b.SHARED)]
        if message == "moveBank":
            entry = self.index["entries"].pop(body["from"])
            self.index["entries"].insert(body["to"], entry)
            return None
        if message == "deletePresetItems":
            bank = self.index["selectedBank"]
            self.presets[bank]["presets"] = [preset for preset in self.presets[bank]["presets"] if preset["instanceId"] not in body]
            self.presets[bank]["selectedInstanceId"] = self.presets[bank]["presets"][0]["instanceId"]
            self.board = deepcopy(self.boards[(bank, self.presets[bank]["selectedInstanceId"])])
            return self.presets[bank]["selectedInstanceId"]
        if message == "getPatchProperty":
            return self.os_values.get(body["instanceId"], 1)
        if message == "setPatchProperty":
            self.os_values[body["instanceId"]] = body["value"]
            return True
        if message == "saveCurrentPresetAs" and self.fail_save:
            raise ValueError("Injected save failure")
        return super().request(message, body)

    def bank_download(self, url, identifier):
        self.calls.append(("downloadBank", identifier, None))
        assert identifier == 7
        stock = deepcopy(self.stock)
        if self.corrupt_stock and any(call[1] == "saveBankAs" for call in self.calls if call[0] == "request"):
            stock["name"] = "Corrupted source"
        return archive(bank=stock)

    def preset_download(self, url, identifier):
        board = deepcopy(self.boards[(self.index["selectedBank"], identifier)])
        return archive(board=board), board


class BuildBankTests(unittest.TestCase):
    """Preserve stock assets/ordering and scope deletions to one fresh clone.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ARCH] [DES-SEC] [3.7] [5.3]
    """
    def test_input_uses_opaque_identity_not_test_wire_name_and_refuses_program(self):
        board = state_board("Dumble Spread")
        self.assertEqual(b.validate_single(board)[0], "Dumble Spread")
        board["items"][0]["lv2State"][1][b.PROGRAM] = {"atomType": b.ATOM + "Int", "value": "AAAAAA=="}
        with self.assertRaises(ValueError):
            b.validate_single(board)
        board = state_board("Dumble Spread")
        board["items"][0]["lilvPresetUri"] = "urn:pending"
        with self.assertRaises(ValueError):
            b.validate_single(board)

    def test_dual_uses_ab_select_and_discovered_shared_defaults(self):
        entries = inputs()
        plugins = BankMock().request("plugins")[1:]
        board = b.construct_dual(entries[0]["board"], entries[0]["item"], entries[1]["item"], plugins, 100)
        split = board["items"][1]
        self.assertEqual(split["uri"], b.SPLIT)
        controls = {c["key"]: c["value"] for c in split["controlValues"]}
        self.assertEqual((controls["splitType"], controls["select"], controls["volL"], controls["volR"]), (0, 0, -3, -3))
        self.assertTrue(split["topChain"][0]["isEnabled"] and split["bottomChain"][0]["isEnabled"])
        self.assertEqual(board["items"][0]["controlValues"], [{"key": "MUTE", "value": 0}])
        self.assertEqual(board["items"][2]["controlValues"], [{"key": "amount", "value": 0.3}])
        self.assertEqual(len({item["instanceId"] for item in b.walk_items(board)}), 6)
        plugins[1]["controls"][0]["default_value"] = float("nan")
        with self.assertRaises(ValueError):
            b.construct_dual(entries[0]["board"], entries[0]["item"], entries[1]["item"], plugins, 100)

    def test_zip_prevalidation_reads_all_inputs_and_rejects_duplicate_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = []
            for i, label in enumerate(("Dumble Spread", "Matchless Crunch")):
                path = Path(directory) / f"{i}.piPreset"
                path.write_bytes(archive(board=state_board(label)))
                paths.append(path)
            self.assertEqual([entry["label"] for entry in b.load_inputs(paths)], ["Dumble Spread", "Matchless Crunch"])
            with self.assertRaises(ValueError):
                b.load_inputs([paths[0], paths[0]])
            paths[1].write_bytes(b"not a zip")
            with self.assertRaises(zipfile.BadZipFile):
                b.load_inputs(paths)

    def test_saved_shape_refuses_lost_shared_effect_or_wrong_split_mode(self):
        entries = inputs()
        board = b.construct_dual(entries[0]["board"], entries[0]["item"], entries[1]["item"], BankMock().request("plugins")[1:], 100)
        wanted = {102: entries[0]["state"], 103: entries[1]["state"]}
        b.verify_saved(board, wanted, board)
        changed = deepcopy(board)
        changed["items"][1]["controlValues"][0]["value"] = 1
        with self.assertRaises(ValueError):
            b.verify_saved(changed, wanted, board)
        changed = deepcopy(board)
        changed["items"].pop()
        with self.assertRaises(ValueError):
            b.verify_saved(changed, wanted, board)

    def test_invalid_manifest_is_refused_before_any_rpc_or_clone(self):
        rpc = BankMock()
        invalid = inputs()
        invalid[0]["item"]["lilvPresetUri"] = "urn:pending"
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                b.run(rpc, invalid, 7, "TONE3000 invalid", Path(directory) / "output", "ws://example/pipedal")
        self.assertFalse(rpc.calls)

    def test_actual_protocol_clone_move_append_verify_then_bank_local_delete(self):
        rpc = BankMock()
        original = deepcopy(rpc.presets[7])
        with tempfile.TemporaryDirectory() as directory:
            result, error = b.run(rpc, inputs(), 7, "TONE3000 reference", Path(directory) / "output", "ws://example/pipedal",
                True, rpc.bank_download, rpc.preset_download)
            self.assertIsNone(error)
            self.assertTrue(result["bank_created_verified"] and result["source_stock_unchanged"])
            self.assertFalse(result["readiness_proven"] or result["qualification_passed"])
            self.assertEqual(rpc.presets[7], original)
            self.assertEqual([entry["instanceId"] for entry in rpc.index["entries"]], [7, 4, 10])
            self.assertEqual(rpc.index["selectedBank"], 10)
            self.assertEqual(rpc.presets[10]["selectedInstanceId"], result["presets"][-1]["preset_id"])
            self.assertEqual(result["selected_preset_id"], result["presets"][-1]["preset_id"])
            self.assertEqual([preset["name"] for preset in rpc.presets[10]["presets"]], ["Dumble Spread", "Matchless Crunch", b.DUAL_LABEL])
            self.assertEqual([call[2] for call in rpc.calls if call[:2] == ("request", "deletePresetItems")], [[8]])
            self.assertEqual(len([call for call in rpc.calls if call[:2] == ("request", "setPatchProperty")]), 4)
            saves = [i for i, call in enumerate(rpc.calls) if call[:2] == ("request", "saveCurrentPresetAs")]
            deleted = next(i for i, call in enumerate(rpc.calls) if call[:2] == ("request", "deletePresetItems"))
            self.assertGreater(deleted, max(saves))

    def test_delete_guard_refuses_original_bank_overlap_and_unselected_new_preset(self):
        rpc = BankMock()
        with self.assertRaises(ValueError):
            b.guarded_delete(rpc, 4, {4, 7}, [3], [9])
        self.assertFalse(any(call[1] == "deletePresetItems" for call in rpc.calls))

    def test_save_failure_retains_clones_restores_original_even_leave_selected(self):
        rpc = BankMock()
        original_board = deepcopy(rpc.board)
        rpc.fail_save = True
        with tempfile.TemporaryDirectory() as directory:
            result, error = b.run(rpc, inputs(), 7, "TONE3000 failed trial", Path(directory) / "output", "ws://example/pipedal",
                True, rpc.bank_download, rpc.preset_download)
            self.assertIsInstance(error, ValueError)
            self.assertFalse(result["bank_created_verified"])
            self.assertEqual(rpc.index["selectedBank"], 4)
            self.assertEqual(rpc.board, original_board)
            self.assertEqual(rpc.presets[10]["presets"], [{"instanceId": 8, "name": "Last song"}])
            self.assertFalse(any(call[1] == "deletePresetItems" for call in rpc.calls))

    def test_source_export_change_fails_and_restores_original_selection(self):
        rpc = BankMock()
        rpc.corrupt_stock = True
        with tempfile.TemporaryDirectory() as directory:
            result, error = b.run(rpc, inputs(), 7, "TONE3000 failed audit", Path(directory) / "output", "ws://example/pipedal",
                True, rpc.bank_download, rpc.preset_download)
            self.assertIsInstance(error, RuntimeError)
            self.assertFalse(result["source_stock_unchanged"])
            self.assertEqual(rpc.index["selectedBank"], 4)

    def test_explicit_local_raw_bank_audit_avoids_broken_http_and_preserves_every_byte(self):
        rpc = BankMock()
        raw = json.dumps(rpc.stock, indent=2).encode()
        with tempfile.TemporaryDirectory() as directory, patch.object(b, "read_source_bank", return_value=raw) as reader:
            result, error = b.run(rpc, inputs(), 7, "TONE3000 local audit", Path(directory) / "output", "ws://127.0.0.1/pipedal",
                True, rpc.bank_download, rpc.preset_download, Path("/var/pipedal/presets/Factory+Presets.bank"))
            self.assertIsNone(error)
            self.assertTrue(result["source_stock_unchanged"])
            self.assertEqual(reader.call_count, 2)
            self.assertFalse(any(call[0] == "downloadBank" for call in rpc.calls))
            self.assertEqual(result["source_audit"]["method"], "explicit-local-raw-json")
            self.assertEqual((Path(directory) / "output" / "source-stock-before.json").read_bytes(), raw)
            self.assertEqual(b.raw_bank(raw, "Factory Presets")[0], rpc.stock)
        with self.assertRaises(ValueError):
            b.raw_bank(raw, "Wrong indexed name")
        with self.assertRaises(ValueError):
            b.read_source_bank("/var/pipedal/presets/Factory+Presets.bank", "ws://remote.invalid/pipedal")
        with self.assertRaises(ValueError):
            b.read_source_bank("/tmp/copied-source.bank", "ws://127.0.0.1/pipedal")

    def test_local_bank_byte_change_fails_and_restores_original(self):
        rpc = BankMock()
        raw = json.dumps(rpc.stock).encode()
        with tempfile.TemporaryDirectory() as directory, patch.object(b, "read_source_bank", side_effect=[raw, raw + b" "]):
            result, error = b.run(rpc, inputs(), 7, "TONE3000 changed local audit", Path(directory) / "output", "ws://127.0.0.1/pipedal",
                True, rpc.bank_download, rpc.preset_download, Path("/var/pipedal/presets/Factory+Presets.bank"))
            self.assertIsInstance(error, RuntimeError)
            self.assertFalse(result["source_stock_unchanged"])
            self.assertEqual(rpc.index["selectedBank"], 4)


if __name__ == "__main__":
    unittest.main()
