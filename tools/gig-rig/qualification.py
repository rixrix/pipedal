#!/usr/bin/env python3
"""Bounded TONE3000 state smoke in an appended bank; observations are not readiness.

Requires websocket-client for the existing PiPedal protocol. Run only against
the explicitly authorized test service, with an inventory from gig_rig.py.
Raw original boards and saved ZIPs remain private in a fresh output directory.
@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [DES-STATE] [2.6] [3.5] [3.6]
"""

import argparse
from copy import deepcopy
import errno
import hashlib
import io
import json
import math
import os
from pathlib import Path
import stat
import struct
import sys
import time
from urllib.parse import urlsplit, urlunsplit, urlencode
from urllib.request import urlopen
import uuid
import zipfile

from gig_rig import read_header
from pipedal_rpc import PiPedalRpc
from state_summary import ATOM, DEFAULT_LIMIT, PLUGIN, StateTreeReader, summarize_input

LABELS = ("Ampeg Bass Drive", "Bogner Fullstack", "Dumble Spread", "Marshall Bluesbreaker",
          "Matchless Crunch", "Mesa Pitch Shift", "Stereo Crunch Verb", "Stereo Fuzz")
JSON_LIMIT = DEFAULT_LIMIT * 2 + 1024 * 1024


def private_destination(path):
    """Refuse existing, linked, repository and non-directory ancestors before RPC.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [DES-FILES] [3.5]
    """
    path = Path(os.path.abspath(path))
    if os.path.lexists(path):
        raise ValueError("Qualification output must not already exist")
    if not path.parent.is_dir():
        raise ValueError("Qualification output needs an existing parent directory")
    for ancestor in path.parents:
        if stat.S_ISLNK(ancestor.lstat().st_mode) or not ancestor.is_dir():
            raise ValueError("Linked or non-directory output ancestors are unsupported")
        if (ancestor / ".git").exists():
            raise ValueError("Qualification output must be outside Git worktrees")
    return path


def write_private(directory, name, value):
    """Create bounded evidence once, without overwriting earlier recovery data.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [3.5] [3.6]
    """
    data = value if isinstance(value, bytes) else json.dumps(value, allow_nan=False, indent=2).encode()
    if len(data) > JSON_LIMIT:
        raise ValueError("Private evidence exceeds byte bound")
    descriptor = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)


def signature(summary):
    """Compare stored models/bytes, topology and enabled/mix/slim-size settings.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [3.5] [3.6]
    """
    return {"blocks": [{**{key: block.get(key) for key in
            ("lane", "index", "block_id", "type", "tone_id", "active_model_id", "enabled", "mix", "slim_size")},
            "cached_models": sorted(block.get("cached_models", []), key=lambda model: str(model["model_id"]))}
            for block in summary.get("blocks", [])],
            **{key: summary.get(key) for key in ("stereo_enabled", "branch_side", "branch_after_block_id")}}


def restored_block_settings(properties):
    """Use pinned applyBlockSettings defaults and conversions for source presets.

    ProcessorState.cpp restores enabled=true, mix=1.0 as float32, and
    slimSize=0.0 clamped to [0,1]. Missing observed fields are not defaulted:
    current getStateInformation serializes all three, so they must match.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [3.5] [3.6]
    """
    enabled = properties.get("enabled", True)
    mix = properties.get("mix", 1.0)
    slim_size = properties.get("slimSize", 0.0)
    if type(enabled) is not bool or any(type(value) not in (int, float) or not math.isfinite(value)
                                       for value in (mix, slim_size)):
        raise ValueError("Unsupported source block setting types/values")
    try:
        mix = struct.unpack("<f", struct.pack("<f", mix))[0]
    except (OverflowError, struct.error) as error:
        raise ValueError("Source block mix exceeds float32 range") from error
    if not math.isfinite(mix):
        raise ValueError("Source block mix is not finite after float32 conversion")
    return {"enabled": enabled, "mix": mix, "slim_size": max(0.0, min(1.0, float(slim_size)))}


def inventory_expectations(path, labels, include_user=False):
    """Use actual stored IDs and digest-verified preset bodies, never file ordering.

    PresetFile.cpp writes T3KH + little-endian header length + header + preset
    ValueTree, or legacy T3KB + preset ValueTree. Both share ChainSnapshot.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ORDER] [DES-STATE] [3.5]
    """
    data = json.loads(Path(path).read_text())
    result = {}
    for label in labels:
        entries = [entry for entry in data["presets"] if entry.get("name") == label]
        allowed_sections = {"factory", "user"} if include_user else {"factory"}
        if len(entries) != 1 or entries[0].get("section") not in allowed_sections:
            raise ValueError("Each smoke label must identify one permitted entry; user rigs require --include-user")
        entry = entries[0]
        source = Path(entry["file"])
        if source.stat().st_size > DEFAULT_LIMIT:
            raise ValueError("Source preset exceeds byte bound")
        raw = source.read_bytes()
        header = read_header(source)
        if hashlib.sha256(raw).hexdigest() != entry["sha256"] or header["name"] != label or header["raw_id"] != entry["raw_id"]:
            raise ValueError("Source preset changed since inventory")
        stored_id = header["raw_id"]
        if entry["section"] == "user" and not stored_id:
            # Pinned PresetManager's legacy fallback is the preserved file
            # stem, not its display name or a newly allocated ID.
            stored_id = source.stem
        if not stored_id or entry["id"] != entry["section"] + ":" + stored_id:
            raise ValueError("Source preset ID/fallback differs from the stored inventory")
        if raw[:4] == b"T3KH":
            count = struct.unpack("<i", raw[4:8])[0]
            raw = b"T3KB" + raw[8 + count:]
        reader = StateTreeReader(bytearray(raw))
        tree = reader.tree()
        if raw[:4] != b"T3KB" or tree["type"] != "T3KPreset" or reader.pos != len(raw):
            raise ValueError("Unsupported source preset body")
        # Only the shared snapshot is compared. No forged full-state framing
        # or inferred engine-ready flags are introduced.
        snapshots = [node for node in tree["children"] if node["type"] == "ChainSnapshot"]
        if len(snapshots) != 1:
            raise ValueError("Source preset must contain one chain snapshot")
        snapshot = snapshots[0]
        blocks = []
        for lane in snapshot["children"]:
            if lane["type"] not in ("ChainBlocks", "RightChainBlocks"):
                continue
            for index, block in enumerate(lane["children"]):
                if block["type"] != "ChainBlock":
                    raise ValueError("Unsupported source block node")
                props = block["properties"]
                cached = []
                for cache in block["children"]:
                    if cache["type"] == "ModelCache":
                        for model in cache["children"]:
                            fields = model["properties"]
                            blob = fields.get("data", {})
                            cached.append({"model_id": fields.get("modelId"),
                                "embedded_bytes": blob.get("bytes", 0), "embedded_sha256": blob.get("sha256")})
                blocks.append({"lane": "left" if lane["type"] == "ChainBlocks" else "right", "index": index,
                    "block_id": props.get("id"), "type": props.get("type"), "tone_id": props.get("toneId"),
                    "active_model_id": props.get("activeModelId"), "cached_models": cached,
                    **restored_block_settings(props)})
        if not any(model["embedded_bytes"] > 0 for block in blocks for model in block["cached_models"]):
            raise ValueError("State smoke requires embedded model bytes")
        props = snapshot["properties"]
        result[label] = {"id": entry["id"], "section": entry["section"], "signature": signature({"blocks": blocks,
            "stereo_enabled": props.get("stereoEnabled"), "branch_side": props.get("branchSide"),
            "branch_after_block_id": props.get("branchAfterBlockId")})}
    return result


def state_observation(board):
    """Return one supported opaque state; a missing initial state is observable.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [3.5]
    """
    try:
        states = summarize_input(board)["states"]
    except ValueError as error:
        if str(error) == "No supported TONE3000 LV2 state found":
            return {"state_string_missing": True, "readiness_proven": False}
        raise
    if len(states) != 1:
        raise ValueError("Smoke board must contain exactly one TONE3000 state")
    return states[0]


def matches(observation, expected, label):
    """Stored state identity and asset equality only, never loaded-engine readiness.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [3.5] [3.6]
    """
    return (observation.get("lv2_state_valid") is True and not observation.get("restore_prefers_program")
            and observation.get("active_preset_id") == expected["id"]
            and observation.get("active_preset_name") == label
            and signature(observation) == expected["signature"])


def download_saved(url, identifier):
    """Read the supported preset ZIP's stored bankFile.json without extracting it.

    The frontend uses varServerUrl + downloadPreset; makeVarServerUrl ends /var/.
    DownloadIntercept requires exactly var/downloadPreset. GetPreset then
    PresetBundleWriter::LoadPresets writes bankFile.json from the saved entry.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [DES-SEC] [3.5] [3.6]
    """
    parsed = urlsplit(url)
    if parsed.scheme not in ("ws", "wss") or parsed.username or parsed.password:
        raise ValueError("Use a ws/wss service URL without embedded credentials")
    endpoint = urlunsplit(("https" if parsed.scheme == "wss" else "http", parsed.netloc,
                           "/var/downloadPreset", urlencode({"id": identifier}), ""))
    with urlopen(endpoint, timeout=15) as response:
        if response.geturl() != endpoint:
            raise ValueError("Preset download redirect is unsupported")
        raw = response.read(JSON_LIMIT + 1)
    if len(raw) > JSON_LIMIT:
        raise ValueError("Saved preset ZIP exceeds byte bound")
    return raw, saved_board(raw)


def saved_board(raw):
    """Validate the exact supported one-preset export shape before state audit.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [3.5] [3.6]
    """
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = [entry for entry in archive.infolist() if entry.filename == "bankFile.json"]
        if len(entries) != 1 or entries[0].file_size > JSON_LIMIT:
            raise ValueError("Missing, ambiguous or oversized saved bank JSON")
        data = json.loads(archive.read(entries[0]))
    presets = data.get("presets")
    if not isinstance(presets, list) or len(presets) != 1 or not isinstance(presets[0].get("preset"), dict):
        raise ValueError("Unsupported one-preset bank export")
    return presets[0]["preset"]


class QualificationSession:
    """Append a unique clone, capture recovery, and always restore the original board.

    Existing banks/presets are never renamed, removed, reordered or overwritten.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [DES-SEC] [3.5] [3.6]
    """

    def __init__(self, rpc, output):
        self.rpc, self.output = rpc, output
        self.bank = self.board = self.original_bank = self.original_presets = None
        self.switched = False
        self.restoration = {"attempted": False}
        self.token = uuid.uuid4().hex[:12]
        self.fresh_id = 1000000

    def update(self, board):
        self.rpc.send("updateCurrentPedalboard", {"clientId": -1, "pedalboard": board})
        return self.rpc.request("currentPedalboard")

    def begin(self):
        self.original_bank = self.rpc.request("getBankIndex")
        self.original_presets = self.rpc.request("getPresets")
        self.board = self.rpc.request("currentPedalboard")
        if not self.original_bank.get("entries") or self.original_presets.get("selectedInstanceId", -1) < 0:
            raise ValueError("Smoke requires an existing selected bank and preset")
        write_private(self.output, "original-bank-index.json", self.original_bank)
        write_private(self.output, "original-preset-index.json", self.original_presets)
        write_private(self.output, "original-cached-board.json", self.board)
        self.bank = self.rpc.request("saveBankAs", {"bankId": self.original_bank["entries"][-1]["instanceId"],
            "newName": "TONE3000 diagnostics " + self.token})
        if not isinstance(self.bank, int) or self.bank < 0 or self.bank in {entry["instanceId"] for entry in self.original_bank["entries"]}:
            raise ValueError("Service did not create a fresh qualification bank")
        write_private(self.output, "qualification-bank.json", {"bank": self.bank, "token": self.token})
        updated_index = self.rpc.request("getBankIndex")
        if (updated_index["entries"][:-1] != self.original_bank["entries"]
                or updated_index["entries"][-1]["instanceId"] != self.bank
                or updated_index["selectedBank"] != self.original_bank["selectedBank"]):
            raise ValueError("Clone unexpectedly changed existing bank order/selection")
        # Noncurrent-bank SaveAs returns -1; it still captures complete live
        # state into the appended recovery entry without touching originals.
        result = self.rpc.request("saveCurrentPresetAs", {"clientId": -1, "bankInstanceId": self.bank,
            "name": "TEST recovery " + self.token, "saveAfterInstanceId": -1})
        if result != -1:
            raise ValueError("Unexpected noncurrent-bank SaveAs reply")
        self.board = self.rpc.request("currentPedalboard")
        write_private(self.output, "original-synced-board.json", self.board)
        self.switched = True  # Set before request: a lost reply may still have switched.
        self.rpc.request("openBank", self.bank)
        if self.rpc.request("getBankIndex")["selectedBank"] != self.bank:
            raise ValueError("Qualification bank did not become current")
        write_private(self.output, "qualification-initial-presets.json", self.rpc.request("getPresets"))

    def save(self, name):
        if self.rpc.request("getBankIndex")["selectedBank"] != self.bank:
            raise ValueError("Current bank changed; refusing to save")
        identifier = self.rpc.request("saveCurrentPresetAs", {"clientId": -1, "bankInstanceId": self.bank,
            "name": "TEST " + self.token + " " + name, "saveAfterInstanceId": -1})
        if not isinstance(identifier, int) or identifier < 0:
            raise ValueError("Current-bank SaveAs did not return a new preset ID")
        return identifier

    def load(self, identifier):
        self.rpc.send("loadPreset", identifier)
        board = self.rpc.request("currentPedalboard")
        if self.rpc.request("getPresets")["selectedInstanceId"] != identifier:
            raise ValueError("Preset load did not select the requested entry")
        return board

    def restore(self):
        if not self.switched:
            return
        self.restoration["attempted"] = True
        self.rpc.request("openBank", self.original_bank["selectedBank"])
        self.load(self.original_presets["selectedInstanceId"])
        # UpdateCurrentPedalboard borrows effects by instanceId. Clear them
        # first so an existing plugin cannot silently retain test opaque state.
        empty = deepcopy(self.board)
        empty.update(items=[], snapshots=[], selectedSnapshot=-1, selectedPlugin=-1)
        self.update(empty)
        restored = self.update(self.board)
        bank = self.rpc.request("getBankIndex")
        presets = self.rpc.request("getPresets")
        write_private(self.output, "restored-cached-board.json", restored)
        self.restoration.update(bank_restored=bank["selectedBank"] == self.original_bank["selectedBank"],
            selected_preset_restored=presets["selectedInstanceId"] == self.original_presets["selectedInstanceId"],
            exact_cached_board_equal=restored == self.board,
            original_preset_changed=self.original_presets.get("presetChanged"),
            final_preset_changed=presets.get("presetChanged"),
            note="Restoring a cached board can mark it dirty; original stored presets remain unmodified")
        if not self.restoration["bank_restored"] or not self.restoration["selected_preset_restored"]:
            raise RuntimeError("Original bank/preset restoration failed")


def connection_failure(error):
    """Reconnect only for transport failures, not logical restoration failures.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [DES-TEST] [3.5] [3.6]
    """
    return (isinstance(error, (ConnectionError, TimeoutError))
            or isinstance(error, OSError) and error.errno in
                {errno.ECONNRESET, errno.ECONNREFUSED, errno.ECONNABORTED, errno.ETIMEDOUT,
                 errno.EPIPE, errno.ENETUNREACH, errno.EHOSTUNREACH}
            or type(error).__module__.startswith("websocket"))


def restore_with_reconnect(session, url, factory=PiPedalRpc, timeout=20,
                           clock=time.monotonic, sleep=time.sleep):
    """Restore on a fresh connection after a restart, bounded to 20 seconds.

    The same original bank/preset and captured board are retried. Each RPC's
    timeout is limited by the overall remaining budget; no failed trial is
    repeated and no original stored preset is saved or overwritten.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [DES-TEST] [3.5] [3.6]
    """
    try:
        session.restore()
        return
    except Exception as error:
        if not connection_failure(error) or not session.switched:
            raise
        write_private(session.output, "initial-restoration-transport-failure.json",
                      {"type": type(error).__name__, "message": str(error)})
    deadline = clock() + min(20, timeout)
    original_rpc = session.rpc
    attempts = 0

    class RecoveryRpc:
        """Keep every recovery API operation inside the shared deadline.

        @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [3.6]
        """
        def __init__(self, rpc):
            self.rpc = rpc

        def prepare(self):
            remaining = deadline - clock()
            if remaining <= 0:
                raise TimeoutError("Recovery connection budget exhausted")
            self.rpc.timeout = min(2, remaining)
            if hasattr(self.rpc, "socket"):
                self.rpc.socket.settimeout(self.rpc.timeout)

        def request(self, message, body=None):
            self.prepare()
            return self.rpc.request(message, body)

        def send(self, message, body=None):
            self.prepare()
            return self.rpc.send(message, body)

    while clock() < deadline:
        candidate = None
        try:
            attempts += 1
            candidate = factory(url, timeout=min(2, deadline - clock()))
            session.rpc = RecoveryRpc(candidate)
            session.restore()
            session.restoration.update(reconnected=True, reconnect_attempts=attempts)
            return
        except Exception as error:
            if not connection_failure(error):
                raise
        finally:
            session.rpc = original_rpc
            if candidate is not None:
                try:
                    candidate.close()
                except Exception:
                    pass
        remaining = deadline - clock()
        if remaining > 0:
            sleep(min(0.25, remaining))
    session.restoration.update(reconnected=False, reconnect_attempts=attempts)
    raise TimeoutError("Original-board recovery did not reconnect within 20 seconds")


def numeric_reads(rpc, identifier, properties):
    """Demand all 43 real numeric replies, without recording private knob values.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.6]
    """
    result = {}
    for prop in properties:
        value = rpc.request("getPatchProperty", {"instanceId": identifier, "propertyUri": prop["uri"]})
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("Numeric patch read returned a nonnumeric/nonfinite value")
        result[prop["uri"]] = value
    return result


def representative_sets(rpc, identifier, properties, original):
    """Exercise continuous, toggle and enum controls through existing numeric APIs.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.6]
    """
    groups = ([p for p in properties if not p.get("integer") and not p.get("toggled") and not p.get("enumeration")],
              [p for p in properties if p.get("toggled")], [p for p in properties if p.get("enumeration")])
    if not all(groups):
        raise ValueError("Metadata lacks a required representative control class")
    changed = {}
    for group in groups:
        prop = group[0]
        low, high = prop["minValue"], prop["maxValue"]
        value = low if original[prop["uri"]] != low else high
        if prop.get("enumeration"):
            points = [point["value"] for point in prop.get("scalePoints", [])]
            value = next((point for point in points if point != original[prop["uri"]]), None)
            if value is None:
                raise ValueError("Enumeration has no alternate supported choice")
        body = {"instanceId": identifier, "propertyUri": prop["uri"], "value": value}
        if rpc.request("setPatchProperty", body) is not True:
            raise ValueError("Patch Set was rejected")
        actual = rpc.request("getPatchProperty", {key: val for key, val in body.items() if key != "value"})
        if isinstance(actual, bool) or not isinstance(actual, (int, float)) or not math.isclose(actual, value, abs_tol=1e-4, rel_tol=1e-5):
            raise ValueError("Representative Set/Get did not round trip")
        changed[prop["uri"]] = actual
    return changed


def current_capture_confirmed(rpc, identifier):
    """Probe actual state without replaying edits or accepting recovery-only JSON.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [DES-STATE] [3.16]
    """
    if isinstance(identifier, bool) or not isinstance(identifier, int):
        raise ValueError("Current TONE3000 state lacks an instance ID")
    try:
        result = rpc.request("getTone3000CurrentState", {"instanceId": identifier})
    except RuntimeError as error:
        if "Apply accepted; plugin state has not reflected edit yet" in str(error):
            return False
        raise
    if not isinstance(result, dict) or result.get("instanceId") != identifier or not result.get("revision"):
        raise ValueError("Unsupported current TONE3000 capture reply")
    return True


def wait_observation(rpc, expected, label, timeout, sleep=time.sleep):
    """Require three repeated matching stored snapshots within a bounded window.

    Confirm capture explicitly: the recovery board may retain accepted state
    while the actual plugin is unavailable or still restoring.
    Cached state is only an observation; the subsequently saved export is
    independently verified after SyncLv2State. No engine-ready verdict exists.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [DES-RECOVERY] [3.5] [3.6] [3.16]
    """
    deadline, consecutive, observations = time.monotonic() + timeout, 0, []
    while time.monotonic() < deadline:
        observed = state_observation(rpc.request("currentPedalboard"))
        confirmed = False
        if not observed.get("state_string_missing"):
            confirmed = current_capture_confirmed(rpc, observed.get("instance_id"))
            if confirmed:
                observed = state_observation(rpc.request("currentPedalboard"))
        matched = confirmed and matches(observed, expected, label)
        observations.append({"matched_expected_identity_and_assets": matched,
                             "capture_confirmed": confirmed, "state": observed})
        consecutive = consecutive + 1 if matched else 0
        if consecutive == 3:
            return observations
        sleep(0.2)
    raise TimeoutError("Expected stored rig identity/assets did not stabilize")


def run(rpc, output, expectations, url, timeout=20, downloader=download_saved):
    """Exercise TONE3000 API/state plumbing while preserving acceptance limitations.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [DES-STATE] [2.6] [3.5] [3.6]
    """
    plugins = [plugin for plugin in rpc.request("plugins") if plugin.get("uri") == PLUGIN]
    if len(plugins) != 1:
        raise ValueError("Expected one discovered TONE3000 plugin")
    plugin = plugins[0]
    properties = [p for p in plugin.get("patchProperties", []) if p.get("type") == ATOM + "Float" and p.get("readable") and p.get("writable")]
    if len(properties) != 43 or len({p["uri"] for p in properties}) != 43:
        raise ValueError("Exact 43-property readable/writable numeric contract is required")
    imported = rpc.request("getPluginPresets", PLUGIN)["presets"]
    mapping = {}
    for label in expectations:
        entries = [entry for entry in imported if entry.get("label") == label]
        if len(entries) != 1:
            raise ValueError("Each rig label must map to one existing stored plugin preset")
        mapping[label] = entries[0]["instanceId"]
    output.mkdir(mode=0o700)
    factory_only = all(entry.get("section", "factory") == "factory" for entry in expectations.values())
    result = {"factory_only": factory_only, "readiness_proven": False, "qualification_passed": False,
        "offline_recall_proven": False, "audio_readiness_proven": False, "factory_smoke_passed": False,
        "state_smoke_passed": False, "trials": [],
        "limitation": "API/stored-state observations only; loaded engines, audio, offline restart and cold boot remain unqualified"}
    session = QualificationSession(rpc, output)
    failed = None
    try:
        session.begin()
        result["qualification_bank"] = session.bank
        blank_id = rpc.request("newPreset")
        blank = session.load(blank_id)
        identifier = max([session.fresh_id, blank.get("nextInstanceId", 0)] + [item.get("instanceId", 0) for item in blank.get("items", [])]) + 1
        blank.update(name="TONE3000 qualification", nextInstanceId=identifier + 1, snapshots=[], selectedSnapshot=-1, selectedPlugin=identifier)
        blank["items"] = [{"instanceId": identifier, "uri": PLUGIN, "isEnabled": True,
            "pluginName": plugin.get("name", "TONE3000"), "controlValues": [{"key": c["symbol"], "value": c["default_value"]}
                for c in plugin.get("controls", []) if c.get("is_input")], "midiBindings": [],
            "lv2State": [False, {}], "lilvPresetUri": "", "pathProperties": {}}]
        session.update(blank)
        for index, (label, expected) in enumerate(expectations.items()):
            # A blank full state is installed between trials, so importing an
            # already-active program cannot silently become a no-op.
            session.update({**deepcopy(blank), "items": []})
            session.update(blank)
            rpc.send("loadPluginPreset", {"pluginInstanceId": identifier, "presetInstanceId": mapping[label]})
            immediate_id = session.save(f"{index + 1:02d} immediate {label}")
            raw, immediate_board = downloader(url, immediate_id)
            write_private(output, f"{index + 1:02d}-immediate.piPreset", raw)
            immediate = state_observation(immediate_board)
            trial = {"label": label, "expected_t3k_id": expected["id"], "stored_plugin_preset_id": mapping[label],
                "immediate_preset_id": immediate_id, "immediate_saved_state": immediate,
                "immediate_matches_expected": matches(immediate, expected, label)}
            result["trials"].append(trial)
            observations = wait_observation(rpc, expected, label, timeout)
            trial["settled_observations"] = observations
            settled_id = session.save(f"{index + 1:02d} settled {label}")
            raw, board = downloader(url, settled_id)
            write_private(output, f"{index + 1:02d}-settled.piPreset", raw)
            settled = state_observation(board)
            trial.update(settled_preset_id=settled_id, settled_saved_state=settled)
            if not matches(settled, expected, label):
                raise ValueError("Saved settled snapshot did not preserve expected identity/assets")
            before = numeric_reads(rpc, identifier, properties)
            changed = representative_sets(rpc, identifier, properties, before)
            edited_id = session.save(f"{index + 1:02d} controls {label}")
            raw, _ = downloader(url, edited_id)
            write_private(output, f"{index + 1:02d}-controls.piPreset", raw)
            session.update({**deepcopy(blank), "items": []})
            session.load(edited_id)
            trial["recall_observations"] = wait_observation(rpc, expected, label, timeout)
            after = numeric_reads(rpc, identifier, properties)
            wanted = {**before, **changed}
            if any(not math.isclose(after[key], value, abs_tol=1e-4, rel_tol=1e-5) for key, value in wanted.items()):
                raise ValueError("Saved numeric state did not round trip on full preset recall")
            trial.update(controls_preset_id=edited_id, numeric_get_count=43, representative_set_get_count=len(changed),
                         numeric_recall_count=43, same_service_recall_passed=True)
        result["state_smoke_passed"] = True
        result["factory_smoke_passed"] = factory_only
        write_private(output, "qualification-final-presets.json", rpc.request("getPresets"))
    except Exception as error:
        failed = error
        result["failure_type"] = type(error).__name__  # Never print raw private API errors.
        write_private(output, "failure.json", {"type": type(error).__name__, "message": str(error)})
    finally:
        try:
            restore_with_reconnect(session, url)
        except Exception as error:
            result["restoration_failure_type"] = type(error).__name__
            write_private(output, "restoration-failure.json", {"type": type(error).__name__, "message": str(error)})
            failed = failed or error
        result["restoration"] = session.restoration
        write_private(output, "result.json", result)
    return result, failed


def main(argv=None):
    """Change persistent state through supported service APIs; keep raw evidence private.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FILES] [DES-SEC] [2.6] [3.5] [3.6]
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="ws://127.0.0.1/pipedal")
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--label", action="append", help="Stored display name; default all eight factory rigs")
    parser.add_argument("--include-user", action="store_true", help="Explicitly permit named user rigs from the verified inventory")
    parser.add_argument("--timeout", type=float, default=20)
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.timeout <= 120:
            raise ValueError("Observation timeout must be between 1 and 120 seconds")
        labels = args.label or LABELS
        maximum = 128 if args.include_user else 8
        if len(labels) != len(set(labels)) or not 1 <= len(labels) <= maximum:
            raise ValueError("Choose unique labels within the permitted host-slot bound")
        parsed = urlsplit(args.url)
        if parsed.scheme not in ("ws", "wss") or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError("Use an explicit ws/wss service URL without credentials")
        output = private_destination(args.output)
        expectations = inventory_expectations(args.inventory, labels, args.include_user)
        with PiPedalRpc(args.url, timeout=15) as rpc:
            result, failure = run(rpc, output, expectations, args.url, args.timeout)
        print(json.dumps({"factory_only": result["factory_only"], "state_smoke_passed": result["state_smoke_passed"],
            "factory_smoke_passed": result["factory_smoke_passed"], "readiness_proven": False,
            "qualification_passed": False, "trials": len(result["trials"]), "restoration": result["restoration"]}))
        return 1 if failure else 0
    except Exception as error:
        print("qualification: " + type(error).__name__ + "; see private evidence if created", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
