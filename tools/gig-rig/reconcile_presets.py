#!/usr/bin/env python3
"""Report or explicitly reconcile all 128 preserved TONE3000 import labels.

Install/rescan the reviewed manifest and preset store before --apply. This
helper renames the existing complete import list; it never deletes, creates,
reorders or rewrites preset state. Custom saved plugin presets are refused.
@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-9] [DES-ORDER] [DES-DATA] [3.3]
"""

import argparse
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import sys
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import urlopen
import zipfile

from gig_rig import manifest_matches, turtle_string
from pipedal_rpc import PiPedalRpc
from qualification import JSON_LIMIT, private_destination, write_private
from state_summary import PLUGIN


def export_payload(raw):
    """Read the exact supported pluginPresets.json ZIP member without extraction.

    PresetBundleWriter::LoadPluginPresets emits pluginPresets.json and
    pluginsUsed.json. The JSON maps are declared in PluginPreset.cpp.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ORDER] [DES-SEC] [3.3]
    """
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        if sorted(entry.filename for entry in entries) != ["pluginPresets.json", "pluginsUsed.json"]:
            raise ValueError("Unsupported plugin export members; custom assets are not reconciled")
        member = archive.getinfo("pluginPresets.json")
        if member.file_size > JSON_LIMIT:
            raise ValueError("Plugin preset export exceeds byte bound")
        result = json.loads(archive.read(member))
    if not isinstance(result, dict) or set(result) != {"pluginUri", "presets", "nextInstanceId"}:
        raise ValueError("Unsupported exported plugin preset container")
    return result


def download_export(url):
    """Use the exact frontend/router /var/downloadPluginPresets API route.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ORDER] [DES-SEC] [3.3]
    """
    parsed = urlsplit(url)
    if parsed.scheme not in ("ws", "wss") or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("Use an explicit ws/wss service URL without credentials")
    endpoint = urlunsplit(("https" if parsed.scheme == "wss" else "http", parsed.netloc,
                          "/var/downloadPluginPresets", urlencode({"id": PLUGIN}), ""))
    with urlopen(endpoint, timeout=15) as response:
        if response.geturl() != endpoint:
            raise ValueError("Plugin export redirect is unsupported")
        raw = response.read(JSON_LIMIT + 1)
    if len(raw) > JSON_LIMIT:
        raise ValueError("Plugin preset ZIP exceeds byte bound")
    return raw, export_payload(raw)


def manifest_contract(inventory, text):
    """Ground every stored URI in the reviewed manifest's actual Program integer.

    Manifest grammar enforces exactly 128 distinct resources and Programs
    0..127. New display names must already agree with the supplied inventory.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-9] [DES-ORDER] [3.3]
    """
    entries = inventory.get("presets")
    if not isinstance(entries, list) or len(entries) > 128 or inventory.get("count") != len(entries):
        raise ValueError("Unsupported inventory count")
    names = []
    identities = set()
    for index, entry in enumerate(entries):
        name = entry.get("name")
        identity = entry.get("id")
        if (type(entry.get("program")) is not int or entry["program"] != index
                or entry.get("uri") != PLUGIN + ":preset" + str(index + 1)
                or not isinstance(name, str) or not name or len(name) > 65536 or "\n" in name or "\r" in name
                or not isinstance(identity, str) or not identity or identity in identities):
            raise ValueError("Inventory has ambiguous IDs, names or Program ordering")
        identities.add(identity)
        names.append(name)
    contract = {}
    for match in manifest_matches(text):
        program = int(match["program"])
        label = names[program] if program < len(names) else "(empty)"
        if match["label"] != turtle_string(label):
            raise ValueError("Manifest labels do not yet match the new inventory")
        contract[PLUGIN + ":preset" + match["slot"]] = {"program": program, "label": label}
    return contract


def propose(payload, ui, contract):
    """Require the entire unmodified import baseline before proposing label-only edits.

    Storage::UpdatePluginPresets copies each preset by instanceId and changes
    its label. Omitting entries would delete them, so order/list completeness
    and all baseline fields are validated before constructing the API body.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-9] [DES-ORDER] [3.3]
    """
    if payload.get("pluginUri") != PLUGIN or not isinstance(payload.get("presets"), list) or len(payload["presets"]) != 128:
        raise ValueError("Reconciliation requires the complete 128-entry import baseline")
    original = {"pluginUri": PLUGIN, "presets": []}
    desired = {"pluginUri": PLUGIN, "presets": []}
    ids, programs, changes, mapping = set(), set(), [], []
    for preset in payload["presets"]:
        if not isinstance(preset, dict) or set(preset) != {"instanceId", "label", "controlValues", "pathProperties", "state", "lilvPresetUri"}:
            raise ValueError("Unsupported stored preset fields")
        identifier, label = preset["instanceId"], preset["label"]
        if type(identifier) is not int or not 0 < identifier < 2**64 or identifier in ids or not isinstance(label, str) or len(label) > 65536:
            raise ValueError("Stored persistent IDs/labels are invalid or ambiguous")
        state = preset["state"]
        if (not isinstance(state, list) or len(state) != 2 or state[0] is not False or state[1] != {}
                or preset["controlValues"] != {} or preset["pathProperties"] != {}):
            raise ValueError("Custom saved state, controls or paths are not reconciled")
        uri = preset["lilvPresetUri"]
        if not isinstance(uri, str) or uri not in contract:
            raise ValueError("Stored preset URI is absent from the reviewed manifest")
        entry = contract[uri]
        if entry["program"] in programs:
            raise ValueError("Duplicate stored Program import")
        ids.add(identifier)
        programs.add(entry["program"])
        original["presets"].append({"instanceId": identifier, "label": label})
        desired["presets"].append({"instanceId": identifier, "label": entry["label"]})
        mapping.append({"instance_id": identifier, "lilv_preset_uri": uri, **entry})
        if label != entry["label"]:
            changes.append({"instance_id": identifier, "program": entry["program"], "old_label": label, "new_label": entry["label"]})
    if programs != set(range(128)) or type(payload.get("nextInstanceId")) is not int or not max(ids) < payload["nextInstanceId"] < 2**64:
        raise ValueError("Incomplete Programs or invalid persistent-ID counter")
    if ui != original:
        raise ValueError("UI mapping differs from the exported complete baseline")
    return desired, {"entry_count": 128, "mismatch_count": len(changes), "changes": changes,
                     "id_program_mapping": mapping, "persistent_ids_preserved": True, "order_preserved": True}


def unchanged_except_labels(before, after, desired):
    """Demand exact full-payload equality after replacing only expected labels.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-9] [DES-DATA] [3.3]
    """
    expected = deepcopy(before)
    for preset, wanted in zip(expected["presets"], desired["presets"]):
        preset["label"] = wanted["label"]
    return after == expected


def reconcile(rpc, url, output, inventory, text, apply=False, downloader=download_export):
    """Back up, report by default, or explicitly update and verify labels only.

    A second complete baseline read prevents applying a stale proposal.
    Failure preserves evidence and never attempts delete/reimport or rollback
    over concurrently changed data. Original UI mapping is retained privately.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-9] [DES-ORDER] [DES-SEC] [3.3]
    """
    contract = manifest_contract(inventory, text)
    output.mkdir(mode=0o700)
    raw, before = downloader(url)
    write_private(output, "original.piPluginPresets", raw)
    ui = rpc.request("getPluginPresets", PLUGIN)
    write_private(output, "original-ui-mapping.json", ui)
    desired, report = propose(before, ui, contract)
    report.update(applied=False, apply_requested=apply, manifest_sha256=hashlib.sha256(text.encode()).hexdigest(),
                  original_export_sha256=hashlib.sha256(raw).hexdigest())
    write_private(output, "proposed-ui-mapping.json", desired)
    if apply and report["mismatch_count"]:
        _, current = downloader(url)
        if current != before or rpc.request("getPluginPresets", PLUGIN) != ui:
            raise ValueError("Preset baseline changed; refusing a stale label update")
        # This full list has the original order and every original ID.
        if rpc.request("updatePluginPresets", desired) is not True:
            raise RuntimeError("Service rejected the complete label update")
        raw, after = downloader(url)
        write_private(output, "updated.piPluginPresets", raw)
        after_ui = rpc.request("getPluginPresets", PLUGIN)
        write_private(output, "updated-ui-mapping.json", after_ui)
        if after_ui != desired or not unchanged_except_labels(before, after, desired):
            raise RuntimeError("Post-update payload differs beyond the proposed labels")
        report.update(applied=True, labels_only_verified=True, updated_export_sha256=hashlib.sha256(raw).hexdigest())
    write_private(output, "report.json", report)
    return report


def main(argv=None):
    """Require explicit --apply; refuse existing/private-in-Git output first.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FILES] [DES-SEC] [3.3]
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="ws://127.0.0.1/pipedal")
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    output = None
    try:
        output = private_destination(args.output)
        inventory = json.loads(args.inventory.read_text())
        text = args.manifest.read_text(encoding="utf-8")
        manifest_contract(inventory, text)  # Refuse before any API/file creation.
        with PiPedalRpc(args.url, timeout=15) as rpc:
            result = reconcile(rpc, args.url, output, inventory, text, args.apply)
        print(json.dumps({key: result[key] for key in ("entry_count", "mismatch_count", "applied", "persistent_ids_preserved", "order_preserved")}))
        return 0
    except Exception as error:
        if output is not None and output.is_dir():
            write_private(output, "failure.json", {"type": type(error).__name__, "message": str(error)})
        print("reconcile_presets: " + type(error).__name__ + "; private evidence retained if created", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
