"""Private-path, supported export, inventory and original-restoration checks."""

from copy import deepcopy
import io
import json
from pathlib import Path
import stat
import struct
import tempfile
import unittest
import zipfile
from unittest.mock import patch

import gig_rig
import qualification as q
from test_state_summary import encode, fixture, node, variant


class ProtocolMock:
    """Existing service semantics, including noncurrent SaveAs's -1 result.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [3.5] [3.6]
    """

    def __init__(self):
        self.calls = []
        self.index = {"selectedBank": 4, "entries": [{"instanceId": 4, "name": "Original"},
            {"instanceId": 7, "name": "Last bank"}]}
        self.presets = {4: {"selectedInstanceId": 3, "presetChanged": True,
            "presets": [{"instanceId": 3, "name": "Original song"}]},
            7: {"selectedInstanceId": 8, "presets": [{"instanceId": 8, "name": "Last song"}]}}
        self.original = {"name": "Unsaved original", "items": [{"instanceId": 51, "uri": q.PLUGIN,
            "lv2State": [True, {q.PLUGIN + ":StateString": {"atomType": q.ATOM + "String", "value": encode(fixture())}}]}],
            "snapshots": [], "selectedSnapshot": -1, "selectedPlugin": 51, "nextInstanceId": 52}
        self.board = deepcopy(self.original)
        self.boards = {(4, 3): {"name": "Stored original", "items": []}, (7, 8): {"name": "Last song", "items": []}}

    def request(self, message, body=None):
        self.calls.append(("request", message, deepcopy(body)))
        bank = self.index["selectedBank"]
        if message == "getBankIndex":
            return deepcopy(self.index)
        if message == "getPresets":
            return deepcopy(self.presets[bank])
        if message == "currentPedalboard":
            return deepcopy(self.board)
        if message == "saveBankAs":
            source = body["bankId"]
            self.presets[10] = deepcopy(self.presets[source])
            for preset in self.presets[source]["presets"]:
                self.boards[(10, preset["instanceId"])] = deepcopy(self.boards[(source, preset["instanceId"])])
            self.index["entries"].append({"instanceId": 10, "name": body["newName"]})
            return 10
        if message == "saveCurrentPresetAs":
            target = body["bankInstanceId"]
            identifier = max(p["instanceId"] for p in self.presets[target]["presets"]) + 1
            self.presets[target]["presets"].append({"instanceId": identifier, "name": body["name"]})
            self.boards[(target, identifier)] = deepcopy(self.board)
            if target != bank:
                return -1
            self.presets[target]["selectedInstanceId"] = identifier
            return identifier
        if message == "openBank":
            self.index["selectedBank"] = body
            self.board = deepcopy(self.boards[(body, self.presets[body]["selectedInstanceId"])])
            return None
        raise AssertionError("Unexpected request: " + message)

    def send(self, message, body=None):
        self.calls.append(("send", message, deepcopy(body)))
        if message == "loadPreset":
            bank = self.index["selectedBank"]
            self.presets[bank]["selectedInstanceId"] = body
            self.board = deepcopy(self.boards[(bank, body)])
        elif message == "updateCurrentPedalboard":
            self.board = deepcopy(body["pedalboard"])
        else:
            raise AssertionError("Unexpected notification: " + message)

    def close(self):
        self.calls.append(("close", "connection", None))


class QualificationTests(unittest.TestCase):
    """Verify preservation/refusal independently of live device changes.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [DES-STATE] [2.6] [3.5] [3.6]
    """

    def test_recovery_board_requires_three_confirmed_captures(self):
        rpc = ProtocolMock()
        observed = q.state_observation(rpc.board)
        expected = {"id": observed["active_preset_id"], "signature": q.signature(observed)}
        original_request = rpc.request
        captures = 0

        def request(message, body=None):
            nonlocal captures
            if message == "getTone3000CurrentState":
                self.assertEqual(body, {"instanceId": 51})
                captures += 1
                if captures <= 2:
                    raise RuntimeError("Apply accepted; plugin state has not reflected edit yet")
                return {"instanceId": 51, "revision": "confirmed"}
            return original_request(message, body)

        rpc.request = request
        results = q.wait_observation(rpc, expected, observed["active_preset_name"], 1, sleep=lambda _: None)
        self.assertEqual(captures, 5)
        self.assertEqual([r["capture_confirmed"] for r in results], [False, False, True, True, True])
        self.assertFalse(any(r["matched_expected_identity_and_assets"] for r in results[:2]))

    def test_unavailable_capture_cannot_qualify_a_matching_recovery_board(self):
        rpc = ProtocolMock()
        observed = q.state_observation(rpc.board)
        expected = {"id": observed["active_preset_id"], "signature": q.signature(observed)}
        original_request = rpc.request

        def request(message, body=None):
            if message == "getTone3000CurrentState":
                raise RuntimeError("Current plugin state capture failed; audio may be unavailable.")
            return original_request(message, body)

        rpc.request = request
        with self.assertRaisesRegex(RuntimeError, "capture failed"):
            q.wait_observation(rpc, expected, observed["active_preset_name"], 1, sleep=lambda _: None)

    def test_private_output_refuses_existing_git_and_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.assertEqual(q.private_destination(root / "new-private"), root / "new-private")
            with self.assertRaises(ValueError):
                q.private_destination(root)
            worktree = root / "worktree"
            worktree.mkdir()
            (worktree / ".git").write_text("gitdir: elsewhere")
            with self.assertRaises(ValueError):
                q.private_destination(worktree / "private")
            alias = root / "alias"
            alias.symlink_to(root, target_is_directory=True)
            with self.assertRaises(ValueError):
                q.private_destination(alias / "private")
            # Deployment location is not a repository root: valid output may
            # live under the same .local ancestor as a staged helper.
            local = root / ".local" / "state"
            local.mkdir(parents=True)
            self.assertEqual(q.private_destination(local / "observation"), local / "observation")

    def test_saved_export_actual_shape_missing_or_empty_bank_refused(self):
        with io.BytesIO() as buffer:
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr("bankFile.json", json.dumps({"presets": [{"instanceId": 1, "preset": {"items": []}}]}))
            self.assertEqual(q.saved_board(buffer.getvalue()), {"items": []})
        with io.BytesIO() as buffer:
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr("bankFile.json", json.dumps({"presets": []}))
            with self.assertRaises(ValueError):
                q.saved_board(buffer.getvalue())
        with io.BytesIO() as buffer:
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr("unexpected.json", "{}")
            with self.assertRaises(ValueError):
                q.saved_board(buffer.getvalue())

    def test_download_uses_frontend_var_route_and_real_saved_export(self):
        with io.BytesIO() as buffer:
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr("bankFile.json", json.dumps({"presets": [{"preset": {"items": []}}]}))
            raw = buffer.getvalue()
        endpoints = []

        class Response(io.BytesIO):
            def geturl(self):
                return endpoints[-1]

        def open_mock(endpoint, timeout):
            endpoints.append(endpoint)
            return Response(raw)

        with patch.object(q, "urlopen", open_mock):
            actual, board = q.download_saved("ws://127.0.0.1:80/pipedal", 45)
            self.assertEqual(actual, raw)
            self.assertEqual(board, {"items": []})
            q.download_saved("wss://test-device.example:443/pipedal", 46)
        self.assertEqual(endpoints, ["http://127.0.0.1:80/var/downloadPreset?id=45",
                                     "https://test-device.example:443/var/downloadPreset?id=46"])

    def test_restart_recovery_reconnects_and_restores_original_without_repeating_trial(self):
        rpc = ProtocolMock()
        now = [0.0]
        attempted = []

        class Disconnected:
            def request(self, *args):
                raise ConnectionError("Service restarted")

        def factory(url, timeout):
            attempted.append((url, timeout))
            if len(attempted) == 1:
                raise ConnectionRefusedError("Service still starting")
            return rpc

        with tempfile.TemporaryDirectory() as temporary:
            session = q.QualificationSession(rpc, Path(temporary))
            session.begin()
            session.update({"name": "Test in progress", "items": []})
            session.rpc = Disconnected()
            q.restore_with_reconnect(session, "ws://test/pipedal", factory=factory,
                clock=lambda: now[0], sleep=lambda seconds: now.__setitem__(0, now[0] + seconds))
            self.assertEqual(rpc.board, rpc.original)
            self.assertEqual(rpc.index["selectedBank"], 4)
            self.assertEqual(rpc.presets[4]["selectedInstanceId"], 3)
            self.assertTrue(session.restoration["reconnected"])
            self.assertEqual(session.restoration["reconnect_attempts"], 2)
            self.assertEqual(sum(message == "saveBankAs" for _, message, _ in rpc.calls), 1)
            self.assertTrue((Path(temporary) / "initial-restoration-transport-failure.json").exists())
        self.assertLessEqual(now[0], 20)

    def test_reconnect_budget_bounded_and_filesystem_failures_never_retried(self):
        rpc = ProtocolMock()
        now = [0.0]
        attempted = []

        class Disconnected:
            def request(self, *args):
                raise ConnectionError("Service restarted")

        def factory(url, timeout):
            attempted.append(timeout)
            now[0] += timeout
            raise ConnectionRefusedError("Still unavailable")

        with tempfile.TemporaryDirectory() as temporary:
            session = q.QualificationSession(rpc, Path(temporary))
            session.begin()
            session.rpc = Disconnected()
            with self.assertRaises(TimeoutError):
                q.restore_with_reconnect(session, "ws://test/pipedal", factory=factory,
                    clock=lambda: now[0], sleep=lambda seconds: now.__setitem__(0, now[0] + seconds))
            self.assertFalse(session.restoration["reconnected"])
        self.assertLessEqual(now[0], 20)
        self.assertTrue(all(0 < timeout <= 2 for timeout in attempted))
        self.assertFalse(q.connection_failure(FileExistsError("Evidence already exists")))
        self.assertFalse(q.connection_failure(PermissionError("Disk access refused")))

    def test_clone_appends_recovery_originals_preserved_and_exact_board_restored(self):
        rpc = ProtocolMock()
        stored = deepcopy(rpc.boards[(4, 3)])
        original_index = deepcopy(rpc.index["entries"])
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary).resolve()
            session = q.QualificationSession(rpc, output)
            try:
                session.begin()
                self.assertEqual(rpc.index["entries"][:-1], original_index)
                self.assertTrue(rpc.index["entries"][-1]["name"].startswith("TONE3000 diagnostics "))
                session.update({"name": "Changed test", "items": [{"instanceId": 51, "uri": q.PLUGIN, "lv2State": [False, {}]}]})
                saved = session.save("qualification only")
                self.assertGreater(saved, 8)
                raise RuntimeError("Simulated qualification failure")
            except RuntimeError:
                pass
            finally:
                session.restore()
            self.assertEqual(rpc.index["selectedBank"], 4)
            self.assertEqual(rpc.presets[4]["selectedInstanceId"], 3)
            self.assertEqual(rpc.board, rpc.original)
            self.assertEqual(rpc.boards[(4, 3)], stored)
            self.assertEqual(rpc.presets[4]["presets"], [{"instanceId": 3, "name": "Original song"}])
            updates = [body["pedalboard"] for kind, message, body in rpc.calls if kind == "send" and message == "updateCurrentPedalboard"]
            self.assertEqual(updates[-2]["items"], [])
            self.assertEqual(updates[-1], rpc.original)
            self.assertTrue(session.restoration["exact_cached_board_equal"])
            for path in output.iterdir():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                q.write_private(output, "original-cached-board.json", {"overwrite": True})

    def test_missing_original_selection_refuses_before_clone(self):
        rpc = ProtocolMock()
        rpc.presets[4]["selectedInstanceId"] = -1
        with tempfile.TemporaryDirectory() as temporary:
            session = q.QualificationSession(rpc, Path(temporary))
            with self.assertRaises(ValueError):
                session.begin()
            session.restore()
        self.assertFalse(any(message in ("saveBankAs", "openBank", "saveCurrentPresetAs") for _, message, _ in rpc.calls))

    def test_inventory_uses_stored_id_digest_and_expected_model_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            factory = root / "Factory"
            factory.mkdir()
            snapshot = node("ChainSnapshot", {"stereoEnabled": False, "branchSide": "left", "branchAfterBlockId": ""},
                [node("ChainBlocks", children=[node("ChainBlock", {"id": "amp", "type": "nam", "toneId": 42,
                    "activeModelId": 7}, [node("ModelCache", children=[node("CachedModel", {"modelId": 7, "data": b"model bytes"})])])])])
            header = node("T3KPresetHeader", {"id": "real-stored-id", "name": "Stored display name"})
            body = node("T3KPreset", {"id": "real-stored-id", "name": "Stored display name"}, [snapshot])
            source = factory / "filename-does-not-match.t3kpreset"
            source.write_bytes(b"T3KH" + struct.pack("<i", len(header)) + header + body)
            inventory = root / "inventory.json"
            inventory.write_text(json.dumps(gig_rig.inventory(root)))
            expected = q.inventory_expectations(inventory, ["Stored display name"])["Stored display name"]
            self.assertEqual(expected["id"], "factory:real-stored-id")
            self.assertEqual(expected["signature"]["blocks"][0]["cached_models"][0]["embedded_bytes"], len(b"model bytes"))
            self.assertEqual({key: expected["signature"]["blocks"][0][key] for key in ("enabled", "mix", "slim_size")},
                             {"enabled": True, "mix": 1.0, "slim_size": 0.0})
            source.write_bytes(source.read_bytes() + b"drift")
            with self.assertRaises(ValueError):
                q.inventory_expectations(inventory, ["Stored display name"])

    def test_program_precedence_invalid_state_and_identity_mismatch_never_match(self):
        observed = q.state_observation({"items": [{"uri": q.PLUGIN, "instanceId": 5, "lv2State":
            [True, {q.PLUGIN + ":StateString": {"atomType": q.ATOM + "String", "value": encode(fixture())}}]}]})
        expected = {"id": observed["active_preset_id"], "signature": q.signature(observed)}
        self.assertTrue(q.matches(observed, expected, observed["active_preset_name"]))
        for patch in ({"restore_prefers_program": True}, {"lv2_state_valid": False}, {"active_preset_id": "other"},
                      {"blocks": []}):
            self.assertFalse(q.matches({**observed, **patch}, expected, observed["active_preset_name"]))
        self.assertTrue(q.state_observation({"items": []})["state_string_missing"])

    def test_changed_block_enabled_mix_or_slim_size_rejects_identity_matching_state(self):
        def inspect(raw):
            return q.state_observation({"items": [{"uri": q.PLUGIN, "instanceId": 5, "lv2State":
                [True, {q.PLUGIN + ":StateString": {"atomType": q.ATOM + "String", "value": encode(raw)}}]}]})
        raw = fixture()
        observed = inspect(raw)
        expected = {"id": observed["active_preset_id"], "signature": q.signature(observed)}
        self.assertTrue(q.matches(observed, expected, observed["active_preset_name"]))
        for field, key, original, wrong in (("enabled", "enabled", True, False),
                                          ("mix", "mix", 0.75, 0.25), ("slim_size", "slimSize", 0.5, 1.0)):
            with self.subTest(field=field):
                stored_key = key.encode() + b"\0"
                altered = raw.replace(stored_key + variant(original), stored_key + variant(wrong), 1)
                self.assertNotEqual(altered, raw)
                changed = inspect(altered)
                self.assertEqual(changed["blocks"][0][field], wrong)
                self.assertFalse(q.matches(changed, expected, observed["active_preset_name"]))
                self.assertEqual(changed["active_preset_id"], observed["active_preset_id"])
                self.assertEqual(changed["blocks"][0]["cached_models"], observed["blocks"][0]["cached_models"])

    def test_source_settings_match_exact_pinned_legacy_defaults_cast_and_clamp(self):
        self.assertEqual(q.restored_block_settings({}), {"enabled": True, "mix": 1.0, "slim_size": 0.0})
        self.assertEqual(q.restored_block_settings({"enabled": False, "mix": 0.1, "slimSize": 2.0}),
            {"enabled": False, "mix": struct.unpack("<f", struct.pack("<f", 0.1))[0], "slim_size": 1.0})
        self.assertEqual(q.restored_block_settings({"slimSize": -1.0})["slim_size"], 0.0)
        for properties in ({"enabled": "false"}, {"mix": True}, {"mix": float("nan")},
                           {"mix": 1e100}, {"slimSize": float("inf")}, {"slimSize": "unknown"}):
            with self.subTest(properties=properties):
                with self.assertRaises(ValueError):
                    q.restored_block_settings(properties)

    def test_explicit_legacy_user_preserves_filename_id_and_all_embedded_models(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            blocks = []
            for index in range(5):
                blocks.append(node("ChainBlock", {"id": "legacy-block-" + str(index), "type": "nam",
                    "toneId": index + 40, "activeModelId": index + 100, "enabled": index == 4},
                    [node("ModelCache", children=[node("CachedModel", {"modelId": index + 100,
                        "data": b"preserved model " + bytes([index])})])]))
            snapshot = node("ChainSnapshot", {"stereoEnabled": False, "branchSide": "left", "branchAfterBlockId": ""},
                            [node("ChainBlocks", children=blocks)])
            stem = "b2ae66fd57b247e8963f8b4cf238106a"
            source = root / (stem + ".t3kpreset")
            source.write_bytes(b"T3KB" + node("T3KPreset", {"id": "", "name": "tsinelas"}, [snapshot]))
            inventory = root / "inventory.json"
            data = gig_rig.inventory(root)
            inventory.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                q.inventory_expectations(inventory, ["tsinelas"])
            expected = q.inventory_expectations(inventory, ["tsinelas"], include_user=True)["tsinelas"]
            self.assertEqual(expected["id"], "user:" + stem)
            self.assertEqual(expected["section"], "user")
            self.assertEqual(len(expected["signature"]["blocks"]), 5)
            self.assertEqual(sum(len(block["cached_models"]) for block in expected["signature"]["blocks"]), 5)
            self.assertEqual([block["enabled"] for block in expected["signature"]["blocks"]], [False, False, False, False, True])
            self.assertTrue(all(block["mix"] == 1.0 and block["slim_size"] == 0.0 for block in expected["signature"]["blocks"]))
            data["presets"][0]["id"] = "user:tsinelas"
            inventory.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                q.inventory_expectations(inventory, ["tsinelas"], include_user=True)


if __name__ == "__main__":
    unittest.main()
