#!/usr/bin/env python3
"""Create an appended TONE3000 bank from verified private saved states.

Only the newly cloned bank is edited. Stock bank exports are audited before
and after. Stored-state validation never proves loaded or audible readiness.
@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ARCH] [DES-STATE] [DES-SEC] [3.7] [5.3]
"""

import argparse
from copy import deepcopy
import hashlib
import io
import json
import math
import os
from pathlib import Path
import stat
import sys
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import urlopen
import zipfile

from pipedal_rpc import PiPedalRpc
from qualification import (JSON_LIMIT, QualificationSession, download_saved,
                           private_destination, restore_with_reconnect, saved_board,
                           signature, write_private)
from state_summary import ATOM, PLUGIN, PROGRAM, summarize_input

SPLIT = "uri://two-play/pipedal/pedalboard#Split"
SHARED = ("http://two-play.com/plugins/toob-tuner", "http://two-play.com/plugins/toob-delay",
          "http://two-play.com/plugins/toob-freeverb")
DUAL_LABEL = "Dumble / Matchless A-B"


def walk_items(board):
    """Walk actual pedalboard branches, ignoring unrelated JSON properties.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ARCH] [3.7]
    """
    def walk(items):
        if not isinstance(items, list):
            raise ValueError("Invalid pedalboard item list")
        for item in items:
            if not isinstance(item, dict):
                raise ValueError("Invalid pedalboard item")
            yield item
            for key in ("topChain", "bottomChain"):
                if key in item:
                    yield from walk(item[key])
    yield from walk(board.get("items", []))


def validate_single(board):
    """Require one unambiguous full state and complete referenced model bytes.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [3.7] [5.3]
    """
    items = [item for item in walk_items(board) if item.get("uri") == PLUGIN]
    states = summarize_input(board)["states"]
    if len(items) != 1 or len(states) != 1:
        raise ValueError("Each input must contain exactly one TONE3000 full state")
    item, state = items[0], states[0]
    if item.get("lilvPresetUri") or state.get("lv2_state_valid") is not True or state.get("restore_prefers_program"):
        raise ValueError("Input must restore valid StateString only, without Program/pending preset URI")
    label = state.get("active_preset_name")
    if (not isinstance(label, str) or not label.strip() or len(label) > 128
            or any(ord(char) < 32 for char in label) or label.startswith("TEST ")
            or not state.get("active_preset_id") or not state.get("chain_snapshot_present")):
        raise ValueError("Input lacks a clean intended stored preset identity")
    models = [block for block in state["blocks"] if block["type"] in ("nam", "ir")]
    if not models or any(not block["active_model_bytes_present"] for block in models):
        raise ValueError("All referenced model blocks need embedded active-model bytes")
    return label.strip(), deepcopy(item), state


def load_inputs(paths):
    """Validate every ZIP before connecting or mutating a service bank.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [DES-STATE] [3.7]
    """
    result = []
    for path in paths:
        path = Path(path)
        if path.is_symlink() or not path.is_file() or path.stat().st_size > JSON_LIMIT:
            raise ValueError("Preset input is linked, missing or oversized")
        raw = path.read_bytes()
        board = saved_board(raw)
        label, item, state = validate_single(board)
        result.append({"label": label, "item": item, "state": state, "board": board,
                       "source": str(path.absolute()), "sha256": hashlib.sha256(raw).hexdigest()})
    labels = [entry["label"] for entry in result]
    if not 2 <= len(result) <= 128 or len(labels) != len(set(labels)) or DUAL_LABEL in labels:
        raise ValueError("Choose unique input identities within the supported preset bound")
    if not {"Dumble Spread", "Matchless Crunch"}.issubset(labels):
        raise ValueError("Dual board requires Dumble Spread and Matchless Crunch")
    return result


def bank_archive(raw):
    """Audit full exported bank content, independent of ZIP timestamps/order.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [DES-SEC] [5.3]
    """
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        if (len(entries) > 100000 or sum(item.file_size for item in entries) > JSON_LIMIT
                or len({item.filename for item in entries}) != len(entries)):
            raise ValueError("Ambiguous or oversized bank archive")
        content = {item.filename: hashlib.sha256(archive.read(item)).hexdigest() for item in entries}
        if "bankFile.json" not in content:
            raise ValueError("Export lacks bankFile.json")
        bank = json.loads(archive.read("bankFile.json"))
    if not isinstance(bank.get("presets"), list) or not bank["presets"]:
        raise ValueError("Source stock bank needs existing presets")
    # JSON whitespace is immaterial; asset bytes and every JSON field remain exact.
    content["bankFile.json"] = hashlib.sha256(json.dumps(bank, sort_keys=True, allow_nan=False).encode()).hexdigest()
    return bank, content


def download_bank(url, identifier):
    """Use the actual /var/downloadBank?id= route; never extract server ZIPs.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [DES-SEC] [5.3]
    """
    parsed = urlsplit(url)
    if parsed.scheme not in ("ws", "wss") or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("Explicit ws/wss URL without credentials required")
    endpoint = urlunsplit(("https" if parsed.scheme == "wss" else "http", parsed.netloc,
                           "/var/downloadBank", urlencode({"id": identifier}), ""))
    with urlopen(endpoint, timeout=15) as response:
        if response.geturl() != endpoint:
            raise ValueError("Bank download redirect is unsupported")
        raw = response.read(JSON_LIMIT + 1)
    if len(raw) > JSON_LIMIT:
        raise ValueError("Bank ZIP exceeds byte bound")
    bank_archive(raw)
    return raw


def raw_bank(raw, expected_name):
    """Check every saved JSON field and the exact indexed stock bank name.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [DES-SEC] [5.3]
    """
    if not raw or len(raw) > JSON_LIMIT:
        raise ValueError("Missing or oversized source-bank JSON")
    bank = json.loads(raw)
    if (not isinstance(bank, dict) or bank.get("name") != expected_name
            or not isinstance(bank.get("presets"), list) or not bank["presets"]):
        raise ValueError("Local source bank must match the explicitly indexed stock name")
    return bank, {"raw_json_sha256": hashlib.sha256(raw).hexdigest()}


def read_source_bank(path, url):
    """Explicit Pi-local read-only fallback when the bank HTTP body is broken.

    Storage uses /var/pipedal/presets/SafeEncodeName(name)+'.bank' raw JSON.
    The CLI never discovers/follows arbitrary links or rewrites this store.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [DES-SEC] [5.3]
    """
    parsed = urlsplit(url)
    if parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("Local source-bank fallback requires a loopback service URL on the Pi")
    path = Path(path)
    if not path.is_absolute() or path.parent != Path("/var/pipedal/presets") or path.suffix != ".bank":
        raise ValueError("Local source-bank fallback is restricted to the actual Pi preset store")
    for ancestor in path.parents:
        if not stat.S_ISDIR(ancestor.lstat().st_mode):
            raise ValueError("Linked/non-directory source-bank ancestors are unsupported")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > JSON_LIMIT:
            raise ValueError("Local source bank is not a bounded regular file")
        raw = stream.read(JSON_LIMIT + 1)
        after = os.fstat(stream.fileno())
        if len(raw) > JSON_LIMIT or (info.st_size, info.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("Local source bank changed while reading")
    return raw


def default_item(metadata, identifier, tuner=False):
    """Construct shared effects only from discovered finite input defaults.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ARCH] [3.7]
    """
    controls = []
    for control in metadata.get("controls", []):
        if not control.get("is_input"):
            continue
        value = control.get("default_value")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError("Shared effect has invalid input-control defaults")
        if not isinstance(control.get("symbol"), str) or not control["symbol"]:
            raise ValueError("Shared effect lacks a control symbol")
        controls.append({"key": control["symbol"], "value": value})
    if len({item["key"] for item in controls}) != len(controls):
        raise ValueError("Duplicate shared effect input symbols")
    if tuner:
        mute = [item for item in controls if item["key"] == "MUTE"]
        if len(mute) != 1:
            raise ValueError("Discovered TooB Tuner lacks reviewed MUTE input")
        mute[0]["value"] = 0
    return {"instanceId": identifier, "uri": metadata["uri"], "pluginName": metadata["name"],
            "isEnabled": True, "controlValues": controls, "midiBindings": [],
            "lv2State": [False, {}], "lilvPresetUri": "", "pathProperties": {}, "sideChainInputId": -1}


def tone_item(source, identifier):
    """Keep opaque rig settings while replacing host instance/routing bindings.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ARCH] [DES-STATE] [3.7]
    """
    item = deepcopy(source)
    item.update(instanceId=identifier, isEnabled=True, midiBindings=[], lilvPresetUri="", sideChainInputId=-1)
    item.pop("midiChannelBinding", None)
    return item


def construct_dual(base, left, right, shared, first_id):
    """A/B=0/select=0 follows SplitType and Pedalboard::MakeSplit exactly.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ARCH] [3.7]
    """
    board = deepcopy(base)
    split = {"instanceId": first_id + 1, "uri": SPLIT, "pluginName": "", "isEnabled": True,
        "controlValues": [{"key": key, "value": value} for key, value in
            (("splitType", 0), ("select", 0), ("mix", 0), ("panL", 0), ("volL", -3), ("panR", 0), ("volR", -3))],
        "topChain": [tone_item(left, first_id + 2)], "bottomChain": [tone_item(right, first_id + 3)],
        "midiBindings": [], "lv2State": [False, {}], "lilvPresetUri": "", "pathProperties": {}}
    board.update(name=DUAL_LABEL, items=[default_item(shared[0], first_id, tuner=True), split,
        default_item(shared[1], first_id + 4), default_item(shared[2], first_id + 5)],
        nextInstanceId=first_id + 6, snapshots=[], selectedSnapshot=-1, selectedPlugin=first_id + 1)
    return board


def verify_saved(board, wanted, planned=None):
    """Check saved identities/assets for exactly the newly assigned T3K instances.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [3.7] [5.3]
    """
    states = summarize_input(board)["states"]
    actual = {state.get("instance_id"): state for state in states}
    if len(actual) != len(states) or set(actual) != set(wanted):
        raise ValueError("Saved board lost or duplicated a TONE3000 instance")
    for identifier, expected in wanted.items():
        state = actual[identifier]
        if (state.get("lv2_state_valid") is not True or state.get("restore_prefers_program")
                or state.get("active_preset_id") != expected.get("active_preset_id")
                or state.get("active_preset_name") != expected.get("active_preset_name")
                or signature(state) != signature(expected)):
            raise ValueError("Saved board changed intended opaque model identities/assets")
    if any(item.get("lilvPresetUri") for item in walk_items(board) if item.get("uri") == PLUGIN):
        raise ValueError("Saved full state retains pending plugin preset URI")
    if planned is not None:
        actual_items, planned_items = list(walk_items(board)), list(walk_items(planned))
        if len(actual_items) != len(planned_items):
            raise ValueError("Saved board lost a planned effect or branch")
        for actual_item, planned_item in zip(actual_items, planned_items):
            if any(actual_item.get(key) != planned_item.get(key) for key in ("uri", "instanceId", "isEnabled")):
                raise ValueError("Saved board changed effect order, identity or enablement")
            actual_controls = {control["key"]: control["value"] for control in actual_item.get("controlValues", [])}
            expected_controls = {control["key"]: control["value"] for control in planned_item.get("controlValues", [])}
            if set(actual_controls) != set(expected_controls) or any(
                    isinstance(actual_controls[key], bool) or not isinstance(actual_controls[key], (int, float))
                    or not math.isfinite(actual_controls[key])
                    or not math.isclose(actual_controls[key], value, abs_tol=1e-6, rel_tol=1e-6)
                    for key, value in expected_controls.items()):
                raise ValueError("Saved board changed reviewed Split/shared effect control values")


def guarded_delete(rpc, bank, original_ids, clone_ids, new_ids):
    """Copied preset IDs are bank-local: deletion must target only the new bank.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [3.7] [5.3]
    """
    index = rpc.request("getBankIndex")
    current = rpc.request("getPresets")
    if (bank in original_ids or index["selectedBank"] != bank or not new_ids
            or set(clone_ids) & set(new_ids) or current["selectedInstanceId"] not in new_ids
            or {entry["instanceId"] for entry in current["presets"]} != set(clone_ids) | set(new_ids)):
        raise ValueError("Refusing deletion outside the verified fresh bank/clone ID set")
    rpc.request("deletePresetItems", clone_ids)
    after = rpc.request("getPresets")
    if {entry["instanceId"] for entry in after["presets"]} != set(new_ids):
        raise ValueError("New bank cleanup did not retain exactly the saved TONE3000 presets")


def run(rpc, inputs, source_bank, name, output, url, leave_selected=False,
        bank_downloader=download_bank, preset_downloader=download_saved, source_bank_file=None):
    """Validate first, edit one clone, retain originals/recovery even on failure.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ARCH] [DES-STATE] [DES-SEC] [3.7] [5.3]
    """
    if not isinstance(name, str) or not name.startswith("TONE3000") or len(name) > 100 or any(ord(c) < 32 for c in name):
        raise ValueError("New bank name must begin TONE3000 and remain bounded")
    # Also validate callers using this Python entry point directly, before RPC.
    for entry in inputs:
        label, item, state = validate_single(entry["board"])
        if label != entry["label"] or item != entry["item"] or state != entry["state"]:
            raise ValueError("Input manifest differs from its actual full-state board")
    labels = [entry["label"] for entry in inputs]
    if len(labels) != len(set(labels)) or not {"Dumble Spread", "Matchless Crunch"}.issubset(labels):
        raise ValueError("Unique supplied Dumble and Matchless states required before mutation")
    index = rpc.request("getBankIndex")
    sources = [entry for entry in index["entries"] if entry["instanceId"] == source_bank]
    if len(sources) != 1 or "factory" not in sources[0]["name"].casefold():
        raise ValueError("Explicit source-bank ID must identify an existing stock Factory bank")
    if any(entry["name"] == name for entry in index["entries"]):
        raise ValueError("New bank name already exists")
    source_raw = read_source_bank(source_bank_file, url) if source_bank_file else bank_downloader(url, source_bank)
    source_data, source_content = raw_bank(source_raw, sources[0]["name"]) if source_bank_file else bank_archive(source_raw)
    if source_data.get("name") != sources[0]["name"]:
        raise ValueError("Source export name differs from indexed stock bank")
    planned_names = {entry["label"] for entry in inputs} | {DUAL_LABEL}
    if any(entry["preset"]["name"] in planned_names for entry in source_data["presets"]):
        raise ValueError("Stock clone has a planned-name collision; no presets have been edited")
    plugins = rpc.request("plugins")
    shared = []
    for uri in SHARED:
        matches = [plugin for plugin in plugins if plugin.get("uri") == uri]
        if len(matches) != 1:
            raise ValueError("Expected one discovered shared TooB effect per reviewed URI")
        shared.append(matches[0])
    for i, plugin in enumerate(shared):
        default_item(plugin, i, tuner=i == 0)
    if len([plugin for plugin in plugins if plugin.get("uri") == PLUGIN]) != 1:
        raise ValueError("Expected exactly one discovered TONE3000 plugin")
    output.mkdir(mode=0o700)
    session = QualificationSession(rpc, output)
    session.original_bank = index
    session.original_presets = rpc.request("getPresets")
    session.board = rpc.request("currentPedalboard")
    if session.original_presets.get("selectedInstanceId", -1) < 0:
        raise ValueError("An original selected preset is required for recovery")
    write_private(output, "original-bank-index.json", index)
    write_private(output, "original-preset-index.json", session.original_presets)
    write_private(output, "original-cached-board.json", session.board)
    source_suffix = "json" if source_bank_file else "piBank"
    write_private(output, "source-stock-before." + source_suffix, source_raw)
    write_private(output, "input-manifest.json", [{key: entry[key] for key in ("label", "source", "sha256")} for entry in inputs])
    result = {"source_bank": source_bank, "bank_name": name, "presets": [], "readiness_proven": False,
              "qualification_passed": False, "source_stock_unchanged": False,
              "limitation": "Stored full-state/model identity only; audio/readiness/offline boot/CPU and MIDI remain unqualified"}
    result["source_audit"] = {"method": "explicit-local-raw-json" if source_bank_file else "supported-http-bank-export",
                             "before": source_content}
    failure = None
    success = False
    try:
        bank = rpc.request("saveBankAs", {"bankId": source_bank, "newName": name})
        original_ids = {entry["instanceId"] for entry in index["entries"]}
        if not isinstance(bank, int) or isinstance(bank, bool) or bank < 0 or bank in original_ids:
            raise ValueError("Clone did not return a fresh bank ID")
        session.bank = bank
        result["created_bank"] = bank
        write_private(output, "created-bank.json", {"bank": bank})
        cloned_index = rpc.request("getBankIndex")
        positions = [i for i, entry in enumerate(cloned_index["entries"]) if entry["instanceId"] == bank]
        if len(positions) != 1 or [entry for entry in cloned_index["entries"] if entry["instanceId"] != bank] != index["entries"]:
            raise ValueError("Clone unexpectedly changed original bank index")
        if positions[0] != len(cloned_index["entries"]) - 1:
            rpc.request("moveBank", {"from": positions[0], "to": len(cloned_index["entries"]) - 1})
        appended = rpc.request("getBankIndex")
        if appended["entries"][:-1] != index["entries"] or appended["entries"][-1]["instanceId"] != bank:
            raise ValueError("Appended clone did not preserve original MIDI bank order")
        session.switched = True
        rpc.request("openBank", bank)
        if rpc.request("getBankIndex")["selectedBank"] != bank:
            raise ValueError("New bank did not become current")
        initial = rpc.request("getPresets")
        clone_ids = [entry["instanceId"] for entry in initial["presets"]]
        write_private(output, "cloned-preset-index.json", initial)
        result["cloned_preset_ids"] = clone_ids
        first_id = max([1000000, session.board.get("nextInstanceId", 0)] +
                       [item.get("instanceId", 0) for item in walk_items(session.board)]) + 1
        by_label = {entry["label"]: entry for entry in inputs}
        plans = []
        for entry in inputs:
            board = deepcopy(entry["board"])
            board.update(name=entry["label"], items=[tone_item(entry["item"], first_id)],
                         nextInstanceId=first_id + 1, snapshots=[], selectedSnapshot=-1, selectedPlugin=first_id)
            plans.append((entry["label"], board, {first_id: entry["state"]}))
            first_id += 1
        dual = construct_dual(inputs[0]["board"], by_label["Dumble Spread"]["item"],
                              by_label["Matchless Crunch"]["item"], shared, first_id)
        plans.append((DUAL_LABEL, dual, {first_id + 2: by_label["Dumble Spread"]["state"],
                                       first_id + 3: by_label["Matchless Crunch"]["state"]}))
        new_ids = []
        for number, (label, board, wanted) in enumerate(plans):
            if rpc.request("getBankIndex")["selectedBank"] != bank:
                raise ValueError("Current bank changed before board update")
            empty = deepcopy(board)
            empty.update(items=[], selectedPlugin=-1)
            session.update(empty)
            session.update(board)
            for identifier in wanted:
                body = {"instanceId": identifier, "propertyUri": PLUGIN + ":osEnabled"}
                value = rpc.request("getPatchProperty", body)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise ValueError("Oversampling readback was not a finite number")
                if value != 0:
                    if rpc.request("setPatchProperty", {**body, "value": 0}) is not True:
                        raise ValueError("Oversampling disable was rejected")
                confirmed = rpc.request("getPatchProperty", body)
                if (isinstance(confirmed, bool) or not isinstance(confirmed, (int, float))
                        or not math.isfinite(confirmed) or confirmed != 0):
                    raise ValueError("Test state did not authoritatively report 1x oversampling")
            if rpc.request("getBankIndex")["selectedBank"] != bank:
                raise ValueError("Current bank changed before new preset save")
            identifier = rpc.request("saveCurrentPresetAs", {"clientId": -1, "bankInstanceId": bank,
                "name": label, "saveAfterInstanceId": -1})
            if not isinstance(identifier, int) or isinstance(identifier, bool) or identifier < 0 or identifier in set(clone_ids) | set(new_ids):
                raise ValueError("Save did not return a fresh new-bank preset ID")
            raw, saved = preset_downloader(url, identifier)
            write_private(output, f"{number + 1:02d}-saved.piPreset", raw)
            verify_saved(saved, wanted, board)
            new_ids.append(identifier)
            result["presets"].append({"name": label, "preset_id": identifier,
                "t3k_instance_ids": list(wanted), "saved_identity_assets_verified": True, "oversampling_readback": 0})
        guarded_delete(rpc, bank, original_ids, clone_ids, new_ids)
        # BankFile::deletePreset selects the first remaining entry even when
        # a new preset was selected. Explicitly recall the saved dual afterward.
        final_board = session.load(new_ids[-1])
        if rpc.request("getPresets")["selectedInstanceId"] != new_ids[-1]:
            raise ValueError("Final dual preset did not become selected after clone cleanup")
        verify_saved(final_board, plans[-1][2], plans[-1][1])
        result["selected_preset_id"] = new_ids[-1]
        final_index = rpc.request("getBankIndex")
        if final_index["entries"][:-1] != index["entries"] or final_index["selectedBank"] != bank:
            raise ValueError("Original bank ordering or final bank selection changed")
        write_private(output, "final-preset-index.json", rpc.request("getPresets"))
        success = True
    except Exception as error:
        failure = error
        result["failure_type"] = type(error).__name__
        write_private(output, "failure.json", {"type": type(error).__name__, "message": str(error)})
    finally:
        try:
            after_raw = read_source_bank(source_bank_file, url) if source_bank_file else bank_downloader(url, source_bank)
            write_private(output, "source-stock-after." + source_suffix, after_raw)
            after_content = raw_bank(after_raw, sources[0]["name"])[1] if source_bank_file else bank_archive(after_raw)[1]
            result["source_audit"]["after"] = after_content
            result["source_stock_unchanged"] = after_content == source_content
            if not result["source_stock_unchanged"]:
                raise RuntimeError("Stock bank export changed during build")
        except Exception as error:
            failure = failure or error
            result["source_audit_failure_type"] = type(error).__name__
        try:
            if not (success and failure is None and leave_selected):
                restore_with_reconnect(session, url)
            else:
                session.restoration = {"attempted": False, "left_selected_by_request": True}
        except Exception as error:
            failure = failure or error
            result["restoration_failure_type"] = type(error).__name__
        result["restoration"] = session.restoration
        result["bank_created_verified"] = success and failure is None
        write_private(output, "result.json", result)
    return result, failure


def main(argv=None):
    """Explicit source, new name and saved inputs are required for persistent work.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FILES] [DES-SEC] [3.7] [5.3]
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="ws://127.0.0.1/pipedal")
    parser.add_argument("--source-bank", type=int, required=True)
    parser.add_argument("--source-bank-file", type=Path,
                        help="Explicit Pi-local /var/pipedal/presets/*.bank raw JSON audit when bank HTTP download fails")
    parser.add_argument("--bank-name", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--preset", type=Path, action="append", required=True)
    parser.add_argument("--leave-selected", action="store_true")
    args = parser.parse_args(argv)
    try:
        output = private_destination(args.output)
        inputs = load_inputs(args.preset)
        parsed = urlsplit(args.url)
        if parsed.scheme not in ("ws", "wss") or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError("Explicit ws/wss service URL without credentials required")
        with PiPedalRpc(args.url, timeout=15) as rpc:
            result, error = run(rpc, inputs, args.source_bank, args.bank_name, output, args.url,
                                args.leave_selected, source_bank_file=args.source_bank_file)
        print(json.dumps({key: result.get(key) for key in ("created_bank", "bank_created_verified",
            "source_stock_unchanged", "readiness_proven", "qualification_passed", "restoration")}))
        return 1 if error else 0
    except Exception as error:
        print("build_bank: " + type(error).__name__ + "; see private evidence if created", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
