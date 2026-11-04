"""Installer mutation boundaries and partial-failure preservation tests."""

import argparse
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_gig_rig import load_module, manifest, preset


installer = load_module("install")


class InstallTests(unittest.TestCase):
    """Verify refusals precede apt/service writes and failures preserve recovery.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [DES-ROLLOUT] [1.5] [2.4] [3.2]
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.bundle = self.base / "bundle"
        self.bundle.mkdir()
        (self.bundle / "libTONE3000.so").write_bytes(b"fixture plugin")
        self.presets = self.base / "Presets"
        preset(self.presets / "Factory", "factory", "factory-id", "Test Rig")
        self.package = self.base / "pipedal.deb"
        self.package.write_bytes(b"fixture package")
        self.manifest = self.base / "manifest.ttl"
        self.manifest.write_text(manifest().replace('rdfs:label "(empty)"', 'rdfs:label "Test Rig"', 1))
        self.args = argparse.Namespace(package=self.package,
            package_sha256=installer.sha256(self.package), bundle=self.bundle,
            binary_sha256=installer.sha256(self.bundle / "libTONE3000.so"),
            presets=self.presets, manifest=self.manifest, system_factory=None)
        self.destination = self.base / "installed-bundle"
        self.target = self.base / "service" / "Presets"
        self.user = SimpleNamespace(pw_dir=str(self.base / "servicehome"), pw_uid=os.getuid(), pw_gid=os.getgid())

    def test_source_symlink_refused_before_any_mutation(self):
        (self.bundle / "linked-file").symlink_to(self.manifest)
        with patch.object(installer.os, "geteuid", return_value=0), patch.object(installer.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                installer.install(self.args)
            run.assert_not_called()
        self.assertFalse(self.destination.exists())

    def test_app_settings_in_preset_source_refused(self):
        (self.presets / "preferences.settings").write_text("private fixture")
        with patch.object(installer.os, "geteuid", return_value=0), patch.object(installer.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                installer.install(self.args)
            run.assert_not_called()

    def test_dangling_destination_and_symlink_parent_refused(self):
        self.destination.symlink_to(self.base / "missing")
        with self.assertRaises(ValueError):
            installer.check_destination(self.destination)
        linked = self.base / "linked-parent"
        linked.symlink_to(self.bundle, target_is_directory=True)
        with self.assertRaises(ValueError):
            installer.check_destination(linked / "fresh-target")

    def test_wrong_labels_refused_before_service_or_package_mutation(self):
        self.manifest.write_text(manifest())
        def output(argv, **kwargs):
            return "Package: pipedal\nVersion: 2.0.112\nArchitecture: arm64\n" if argv[0] == "dpkg-deb" else "arm64\n"
        with patch.object(installer.os, "geteuid", return_value=0), patch.object(installer.subprocess, "check_output", side_effect=output), patch.object(installer.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                installer.install(self.args)
            run.assert_not_called()

    def test_failed_package_preserves_staging_and_never_restarts(self):
        def run(argv, **kwargs):
            if argv[0] == "apt-get":
                raise subprocess.CalledProcessError(1, argv)
            return subprocess.CompletedProcess(argv, 0)
        with patch.object(installer.os, "geteuid", return_value=0), patch.object(installer.os, "chown"), patch.object(installer, "validate", return_value=({"Package": "pipedal"}, self.destination, self.user, self.target)), patch.object(installer.subprocess, "run", side_effect=run) as calls:
            with self.assertRaises(subprocess.CalledProcessError):
                installer.install(self.args)
        commands = [call.args[0] for call in calls.call_args_list]
        self.assertFalse(any(command[:2] == ["systemctl", "start"] for command in commands))
        self.assertEqual(commands[-1], ["systemctl", "stop", "pipedald"])
        self.assertFalse(self.destination.exists())
        self.assertFalse(self.target.exists())
        self.assertEqual(len(list(self.destination.parent.glob(".TONE3000-stage-*"))), 1)
        self.assertEqual(len(list(self.target.parent.glob(".Presets-stage-*"))), 1)
        self.assertEqual((self.bundle / "libTONE3000.so").read_bytes(), b"fixture plugin")


if __name__ == "__main__":
    unittest.main()
