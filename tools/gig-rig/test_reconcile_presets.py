"""Preserved imports, exact HTTP route and fail-closed label-only updates."""

from copy import deepcopy
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import gig_rig
import reconcile_presets as r
from test_gig_rig import manifest


def zip_export(payload):
    with io.BytesIO() as stream:
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("pluginPresets.json", json.dumps(payload))
            archive.writestr("pluginsUsed.json", "[]")
        return stream.getvalue()


def baseline():
    # IDs and persistent ordering deliberately differ from numeric Program
    # order; mapping must come from each URI's reviewed manifest integer.
    programs = sorted(range(128), key=lambda value: str(value + 1))
    return {"pluginUri": r.PLUGIN, "nextInstanceId": 2000,
        "presets": [{"instanceId": 1001 + index, "label": "Old label " + str(program),
            "controlValues": {}, "pathProperties": {}, "state": [False, {}],
            "lilvPresetUri": r.PLUGIN + ":preset" + str(program + 1)} for index, program in enumerate(programs)]}


def contract_fixture():
    inventory = {"count": 2, "presets": [{"name": "tsinelas", "id": "user:preserved-filename",
        "program": 0, "uri": r.PLUGIN + ":preset1"}, {"name": "Ampeg Bass Drive", "id": "factory:stored-id",
        "program": 1, "uri": r.PLUGIN + ":preset2"}]}
    text = gig_rig.PRESET_PATTERN.sub(lambda match: match["head"] + gig_rig.turtle_string(
        inventory["presets"][int(match["program"])]["name"] if int(match["program"]) < 2 else "(empty)") + match["tail"], manifest())
    return inventory, text


def ui_mapping(payload):
    return {"pluginUri": r.PLUGIN, "presets": [{"instanceId": preset["instanceId"], "label": preset["label"]}
                                               for preset in payload["presets"]]}


class RpcMock:
    def __init__(self, payload):
        self.payload = deepcopy(payload)
        self.calls = []

    def request(self, message, body):
        self.calls.append((message, deepcopy(body)))
        if message == "getPluginPresets":
            return ui_mapping(self.payload)
        if message == "updatePluginPresets":
            by_id = {preset["instanceId"]: deepcopy(preset) for preset in self.payload["presets"]}
            self.payload["presets"] = []
            for entry in body["presets"]:
                preset = by_id[entry["instanceId"]]
                preset["label"] = entry["label"]
                self.payload["presets"].append(preset)
            return True
        raise AssertionError("Unexpected API mutation: " + message)


class ReconcileTests(unittest.TestCase):
    """Use exact supported shapes, reject custom data before any mutation.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-9] [DES-ORDER] [DES-SEC] [3.3]
    """

    def test_actual_shape_route_and_uri_to_program_preserve_persistent_order(self):
        payload = baseline()
        raw = zip_export(payload)
        self.assertEqual(r.export_payload(raw), payload)
        endpoints = []

        class Response(io.BytesIO):
            def geturl(self):
                return endpoints[-1]

        def opener(endpoint, timeout):
            endpoints.append(endpoint)
            return Response(raw)

        with patch.object(r, "urlopen", opener):
            self.assertEqual(r.download_export("ws://127.0.0.1/pipedal"), (raw, payload))
        self.assertEqual(endpoints, ["http://127.0.0.1/var/downloadPluginPresets?id=https%3A%2F%2Fwww.tone3000.com%2Fplugin"])
        inventory, text = contract_fixture()
        desired, report = r.propose(payload, ui_mapping(payload), r.manifest_contract(inventory, text))
        self.assertEqual([entry["instanceId"] for entry in desired["presets"]], [preset["instanceId"] for preset in payload["presets"]])
        self.assertEqual(desired["presets"][0]["label"], "tsinelas")
        self.assertEqual(desired["presets"][1]["label"], "(empty)")  # URI preset10, not next Program.
        target = next(entry for entry in desired["presets"] if entry["instanceId"] == next(p["instanceId"] for p in payload["presets"] if p["lilvPresetUri"].endswith(":preset2")))
        self.assertEqual(target["label"], "Ampeg Bass Drive")
        self.assertEqual(report["entry_count"], 128)

    def test_custom_unknown_duplicate_and_incomplete_baselines_refused_before_update(self):
        inventory, text = contract_fixture()
        contract = r.manifest_contract(inventory, text)
        invalid = []
        for field, value in (("state", [True, {"private-state": {"value": "secret"}}]),
                             ("state", [0, {}]), ("controlValues", {"enabled": 0.0}),
                             ("pathProperties", {"private": "/file"}), ("lilvPresetUri", "urn:custom"),
                             ("instanceId", True)):
            candidate = baseline()
            candidate["presets"][0][field] = value
            invalid.append(candidate)
        duplicate_id = baseline()
        duplicate_id["presets"][1]["instanceId"] = duplicate_id["presets"][0]["instanceId"]
        invalid.append(duplicate_id)
        duplicate_program = baseline()
        duplicate_program["presets"][1]["lilvPresetUri"] = duplicate_program["presets"][0]["lilvPresetUri"]
        invalid.append(duplicate_program)
        truncated = baseline()
        truncated["presets"].pop()
        invalid.append(truncated)
        for payload in invalid:
            with self.subTest(payload_field_count=len(payload["presets"])):
                rpc = RpcMock(payload)
                with tempfile.TemporaryDirectory() as temporary:
                    output = Path(temporary) / "new-private"
                    with self.assertRaises(ValueError):
                        r.reconcile(rpc, "ws://test/pipedal", output, inventory, text, apply=True,
                                    downloader=lambda url: (zip_export(payload), payload))
                self.assertFalse(any(message == "updatePluginPresets" for message, _ in rpc.calls))

    def test_default_dry_run_and_explicit_apply_change_labels_only_private_backup(self):
        inventory, text = contract_fixture()
        original = baseline()
        for apply in (False, True):
            rpc = RpcMock(original)
            with tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary).resolve() / "new-private"
                report = r.reconcile(rpc, "ws://test/pipedal", output, inventory, text, apply=apply,
                    downloader=lambda url: (zip_export(rpc.payload), deepcopy(rpc.payload)))
                self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
                self.assertEqual(report["applied"], apply)
                for path in output.iterdir():
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(r.export_payload((output / "original.piPluginPresets").read_bytes()), original)
                if apply:
                    desired = json.loads((output / "proposed-ui-mapping.json").read_text())
                    self.assertTrue(r.unchanged_except_labels(original, rpc.payload, desired))
                    self.assertTrue(report["labels_only_verified"])
                else:
                    self.assertEqual(rpc.payload, original)
                self.assertEqual(sum(message == "updatePluginPresets" for message, _ in rpc.calls), int(apply))

    def test_stale_baseline_and_nonlabel_post_update_changes_not_accepted(self):
        inventory, text = contract_fixture()
        rpc = RpcMock(baseline())
        count = [0]

        def downloader(url):
            count[0] += 1
            payload = deepcopy(rpc.payload)
            if count[0] == 2:
                payload["presets"][0]["label"] = "Concurrent user change"
            return zip_export(payload), payload

        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError):
                r.reconcile(rpc, "ws://test/pipedal", Path(temporary) / "new-private", inventory, text, True, downloader)
        self.assertFalse(any(message == "updatePluginPresets" for message, _ in rpc.calls))
        original = baseline()
        desired, _ = r.propose(original, ui_mapping(original), r.manifest_contract(inventory, text))
        changed = deepcopy(original)
        for preset, wanted in zip(changed["presets"], desired["presets"]):
            preset["label"] = wanted["label"]
        self.assertTrue(r.unchanged_except_labels(original, changed, desired))
        changed["nextInstanceId"] += 1
        self.assertFalse(r.unchanged_except_labels(original, changed, desired))
        with self.assertRaises(ValueError):
            r.manifest_contract(inventory, manifest())


if __name__ == "__main__":
    unittest.main()
