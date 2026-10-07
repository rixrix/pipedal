"""Meaningful format, mapping, safety and restore tests; no device writes."""

import importlib.util
import io
import json
from pathlib import Path
import struct
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


rig = load_module("gig_rig")
backup_tool = load_module("backup")


def integer(value):
    size = (value.bit_length() + 7) // 8
    return bytes([size]) + value.to_bytes(size, "little")


def string(value):
    return value.encode("utf-8") + b"\0"


def tree(tag, identity, name):
    props = b""
    for key, value in (("id", identity), ("name", name)):
        payload = b"\x05" + string(value)
        props += string(key) + integer(len(payload)) + payload
    return string(tag) + integer(2) + props + integer(0)


def preset(directory, filename, identity, name, legacy=False):
    path = Path(directory) / (filename + ".t3kpreset")
    path.parent.mkdir(parents=True, exist_ok=True)
    if legacy:
        data = b"T3KB" + tree("T3KPreset", identity, name)
    else:
        header = tree("T3KPresetHeader", identity, name)
        data = b"T3KH" + struct.pack("<i", len(header)) + header + tree("T3KPreset", identity, name)
    path.write_bytes(data)
    return path


def manifest():
    prefixes = {"pset": "http://lv2plug.in/ns/ext/presets#", "lv2": "http://lv2plug.in/ns/lv2core#",
                "rdfs": "http://www.w3.org/2000/01/rdf-schema#", "state": "http://lv2plug.in/ns/ext/state#",
                "xsd": "http://www.w3.org/2001/XMLSchema#"}
    text = "".join(f"@prefix {key}: <{value}> .\n" for key, value in prefixes.items())
    for index in range(128):
        text += (f'<https://www.tone3000.com/plugin:preset{index + 1}>\n'
                 'a pset:Preset ; lv2:appliesTo <https://www.tone3000.com/plugin> ;\n'
                 'rdfs:label "(empty)" ; state:state [ '
                 f'<https://www.tone3000.com/plugin:Program> "{index}"^^xsd:int ; ] .\n')
    return text


class InventoryTests(unittest.TestCase):
    """Verify IDs/overlay/section order and refuse dangerous mislabeling.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ORDER] [2.3] [3.3]
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.presets = self.base / "Presets"
        self.presets.mkdir()

    def test_header_and_legacy_with_fallback(self):
        path = preset(self.presets, "filename differs", "  a-id  ", "Real Name")
        self.assertEqual(rig.read_header(path)["raw_id"], "a-id")
        preset(self.presets, "fallback", "", "", legacy=True)
        entries = rig.inventory(self.presets)["presets"]
        self.assertEqual([entry["id"] for entry in entries], ["user:fallback", "user:a-id"])
        self.assertTrue(entries[0]["legacy"])

    def test_duplicate_id_fallback(self):
        preset(self.presets, "Original", "duplicate", "Zulu")
        preset(self.presets, "Original copy", "duplicate", "Alpha")
        self.assertEqual([entry["id"] for entry in rig.inventory(self.presets)["presets"]],
                         ["user:Original copy", "user:duplicate"])

    def test_factory_overlay_order_stays_in_section(self):
        system = self.base / "System"
        preset(system, "ship", "factory-id", "Old Factory")
        preset(self.presets / "Factory", "overlay", "factory-id", "New Factory")
        preset(self.presets / "Factory", "other", "f2", "Another Factory")
        preset(self.presets, "Z filename", "u1", "Alpha")
        preset(self.presets, "A filename", "u2", "Zulu")
        (self.presets / "order.json").write_text(json.dumps(["factory:factory-id", "user:u2", "user:u2", "missing"]))
        report = rig.inventory(self.presets, system)
        self.assertEqual([entry["id"] for entry in report["presets"]],
                         ["user:u2", "user:u1", "factory:factory-id", "factory:f2"])
        self.assertEqual(report["presets"][2]["name"], "New Factory")
        self.assertEqual(report["unknown_order_ids"], ["missing"])
        self.assertEqual(report["presets"][3]["uri"], "https://www.tone3000.com/plugin:preset4")

    def test_corruption_and_sort_ties_fail_closed(self):
        path = preset(self.presets, "first", "one", "same")
        preset(self.presets, "second", "two", "SAME")
        with self.assertRaises(rig.InventoryError):
            rig.inventory(self.presets)
        path.write_bytes(b"T3KH\xff\xff\xff\xff")
        with self.assertRaises(rig.InventoryError):
            rig.read_header(path)

    def test_invalid_order_refused(self):
        (self.presets / "order.json").write_text('{"ids": []}')
        with self.assertRaises(rig.InventoryError):
            rig.inventory(self.presets)

    def test_unicode_order_refused_without_plugin_locale(self):
        preset(self.presets, "ascii filename", "one", "Café")
        with self.assertRaises(rig.InventoryError):
            rig.inventory(self.presets)

    def test_stage_labels_escaping_unused_slots_original_untouched(self):
        preset(self.presets, "valid stem", "one", 'Name "quoted" \\ slash\tend')
        path = self.base / "manifest.ttl"
        original = manifest()
        path.write_text(original)
        output = self.base / "stage"
        result = rig.stage_labels(rig.inventory(self.presets), path, output)
        self.assertFalse(result["installed_changed"])
        self.assertEqual(path.read_text(), original)
        matches = rig.manifest_matches((output / "manifest.ttl").read_text())
        self.assertEqual(matches[0]["label"], '"Name \\"quoted\\" \\\\ slash\\u0009end"')
        self.assertEqual(matches[1]["label"], '"(empty)"')
        with self.assertRaises(FileExistsError):
            rig.stage_labels(rig.inventory(self.presets), path, output)

    def test_manifest_rebinding_and_wrong_program_refused(self):
        with self.assertRaises(rig.InventoryError):
            rig.manifest_matches(manifest().replace('"127"^^xsd:int', '"126"^^xsd:int'))
        with self.assertRaises(rig.InventoryError):
            rig.manifest_matches(manifest().replace('http://lv2plug.in/ns/ext/presets#', 'https://bad.example/'))
        with self.assertRaises(rig.InventoryError):
            rig.manifest_matches(manifest() + "PREFIX pset: <https://bad.example/>\n")

    def test_program_slot_limit(self):
        for index in range(129):
            preset(self.presets, f"slot{index:03}", str(index), f"Rig {index:03}")
        report = rig.inventory(self.presets)
        self.assertIsNone(report["presets"][128]["uri"])
        path = self.base / "manifest.ttl"
        path.write_text(manifest())
        with self.assertRaises(rig.InventoryError):
            rig.stage_labels(report, path, self.base / "stage")
        self.assertFalse((self.base / "stage").exists())


class BackupTests(unittest.TestCase):
    """Round-trip payload/mode proof plus tampering/path traversal rejection.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [5.3]
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.source = self.base / "private-state"
        self.source.mkdir()
        (self.source / "saved-rig.json").write_text('{"rig":"keep me"}')
        (self.source / "saved-rig.json").chmod(0o640)
        self.output = self.base / "backup"

    def make_backup(self):
        with patch.object(backup_tool.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "inactive\n", "")):
            return backup_tool.backup([self.source], self.output, "pipedald.service")

    def test_staged_roundtrip_and_refuse_overwrite(self):
        self.make_backup()
        destination = self.base / "restored"
        result = backup_tool.stage_restore(self.output, destination)
        restored = destination / str(self.source.resolve()).lstrip("/") / "saved-rig.json"
        self.assertEqual(restored.read_bytes(), (self.source / "saved-rig.json").read_bytes())
        self.assertEqual(restored.stat().st_mode & 0o777, 0o640)
        self.assertFalse(result["installed_state_changed"])
        with self.assertRaises(FileExistsError):
            backup_tool.stage_restore(self.output, destination)

    def test_service_active_refuses_before_writing(self):
        with patch.object(backup_tool.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "active\n", "")):
            with self.assertRaises(ValueError):
                backup_tool.backup([self.source], self.output, "pipedald.service")
        self.assertFalse(self.output.exists())

    def test_tampered_archive_refuses_before_extract(self):
        self.make_backup()
        with (self.output / "state.tar.gz").open("ab") as stream:
            stream.write(b"tamper")
        with self.assertRaises(ValueError):
            backup_tool.stage_restore(self.output, self.base / "restored")
        self.assertFalse((self.base / "restored").exists())

    def test_archive_traversal_refused(self):
        archive = self.base / "bad.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            member = tarfile.TarInfo("../../escape")
            member.size = 4
            tar.addfile(member, io.BytesIO(b"evil"))
        with self.assertRaises(ValueError):
            backup_tool.archive_inventory(archive)

    def test_external_symlink_and_normalized_alias_refused(self):
        for name, target in (("symlink", "/etc/passwd"), ("a/./alias", None)):
            archive = self.base / "bad.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                member = tarfile.TarInfo(name)
                if target:
                    member.type = tarfile.SYMTYPE
                    member.linkname = target
                tar.addfile(member)
            with self.assertRaises(ValueError):
                backup_tool.archive_inventory(archive)

    def test_snapshot_inside_git_tree_refused(self):
        repo = self.base / "repository"
        repo.mkdir()
        (repo / ".git").mkdir()
        with patch.object(backup_tool.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "inactive\n", "")):
            with self.assertRaises(ValueError):
                backup_tool.backup([self.source], repo / "private-backup", "pipedald.service")
        self.assertFalse((repo / "private-backup").exists())


if __name__ == "__main__":
    unittest.main()
