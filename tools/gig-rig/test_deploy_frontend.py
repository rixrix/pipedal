"""@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-UI] [DES-ROLLOUT] [2.11]"""
import gzip
import os
from pathlib import Path
import tempfile
import unittest

import deploy_frontend as deploy

TEST_TEMP = Path(tempfile.gettempdir()).resolve()


class FrontendDeploymentTests(unittest.TestCase):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [2.11]"""
    def fixture(self, root):
        source, target = root / "vite" / "dist", root / "react"
        for directory in (source / "assets", target / "assets", target / "var"):
            directory.mkdir(parents=True)
        (source / "index.html").write_text('<script type="module" src="/assets/new.js"></script>')
        (source / "assets/new.js").write_bytes(b"new javascript")
        (source / "assets/new.js.gz").write_bytes(gzip.compress(b"new javascript"))
        (target / "index.html").write_text('<script type="module" src="/assets/old.js"></script>')
        (target / "assets/old.js").write_bytes(b"old javascript")
        (target / "var/notices.txt").write_bytes(b"generated notices")
        return source, target

    def status(self):
        return {"service": {"pid": 12, "restarts": 0}, "bank": 5, "preset": 30, "audio_settings": {"bufferSize": 32}}

    def test_publication_order_preserves_old_assets_notices_and_reports_user_change(self):
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as directory:
            root = Path(directory)
            source, target = self.fixture(root)
            original = (target / "index.html").read_bytes()
            calls, events = [], [self.status(), {**self.status(), "preset": 29}]
            def backup(path, output):
                calls.append("backup")
                self.assertEqual((path / "index.html").read_bytes(), original)
                return "private tar digest"
            def writer(path, name, content):
                calls.append(name)
                if name != "index.html":
                    self.assertEqual((path / "index.html").read_bytes(), original)
                deploy.atomic_write(path, name, content)
            result, error = deploy.publish(source, target, root / "evidence", lambda: events.pop(0), backup, writer)
            self.assertIsNone(error)
            self.assertEqual(calls[0], "backup")
            self.assertEqual(calls[-1], "index.html")
            self.assertEqual((target / "assets/old.js").read_bytes(), b"old javascript")
            self.assertEqual((target / "var/notices.txt").read_bytes(), b"generated notices")
            self.assertEqual(result["observed_changed_fields"], ["preset"])
            self.assertTrue(result["published_files_verified"])
            self.assertFalse(result["qualification_passed"])
            # Explicit rollback presents old entry before its resources.
            older = root / "older"
            older.mkdir()
            (older / "assets").mkdir()
            (older / "index.html").write_bytes(original)
            (older / "assets/old.js").write_bytes(b"old javascript replaced")
            calls.clear()
            def rollback_writer(path, name, content):
                calls.append(name)
                deploy.atomic_write(path, name, content)
            result, error = deploy.publish(older, target, root / "rollback", self.status,
                                           lambda *_: calls.append("backup") or "private digest", rollback_writer, rollback=True)
            self.assertIsNone(error)
            self.assertEqual(calls[1], "index.html")
            self.assertTrue((target / "assets/new.js").exists())

    def test_symlink_gzip_and_missing_asset_preflight_are_before_output_or_mutation(self):
        for invalid in ("symlink", "hardlink", "gzip", "asset", "stale_gzip"):
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory(dir=TEST_TEMP) as directory:
                root = Path(directory)
                source, target = self.fixture(root)
                original = deploy.manifest(target)
                if invalid == "symlink":
                    (source / "linked").symlink_to(target / "index.html")
                elif invalid == "hardlink":
                    os.link(source / "assets/new.js", source / "assets/linked.js")
                elif invalid == "gzip":
                    (source / "assets/new.js.gz").write_bytes(gzip.compress(b"wrong"))
                elif invalid == "asset":
                    (source / "index.html").write_text('<script src="/assets/missing.js"></script>')
                else:
                    (target / "assets/new.js.gz").write_bytes(gzip.compress(b"old content"))
                    original = deploy.manifest(target)
                    (source / "assets/new.js.gz").unlink()
                with self.assertRaises(ValueError):
                    deploy.publish(source, target, root / "evidence", self.status,
                                   backup=lambda *_: self.fail("Backup must not run before preflight"))
                self.assertFalse((root / "evidence").exists())
                self.assertEqual(deploy.manifest(target), original)

    def test_partial_resource_failure_keeps_original_index_and_private_evidence(self):
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as directory:
            root = Path(directory)
            source, target = self.fixture(root)
            original = (target / "index.html").read_bytes()
            def failing_writer(path, name, content):
                if name.endswith(".gz"):
                    raise OSError("simulated resource write failure")
                deploy.atomic_write(path, name, content)
            result, error = deploy.publish(source, target, root / "evidence", self.status,
                                           backup=lambda *_: "private digest", writer=failing_writer)
            self.assertIsInstance(error, OSError)
            self.assertEqual((target / "index.html").read_bytes(), original)
            self.assertFalse(result["index_published"])
            self.assertEqual(result["entry_state"], "original")
            self.assertEqual(result["written"], ["assets/new.js"])
            self.assertTrue((root / "evidence/result.json").exists())
            self.assertTrue((target / "assets/old.js").exists())

    def test_failed_durability_after_entry_replace_reports_live_incoming_entry(self):
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as directory:
            root = Path(directory)
            source, target = self.fixture(root)
            wanted = (source / "index.html").read_bytes()
            def writer_then_failure(path, name, content):
                deploy.atomic_write(path, name, content)
                if name == "index.html":
                    raise OSError("simulated directory fsync failure after replace")
            result, error = deploy.publish(source, target, root / "evidence", self.status,
                                           backup=lambda *_: "private digest", writer=writer_then_failure)
            self.assertIsInstance(error, OSError)
            self.assertEqual((target / "index.html").read_bytes(), wanted)
            self.assertTrue(result["index_published"])
            self.assertEqual(result["entry_state"], "incoming")
            self.assertFalse(result["published_files_verified"])
            self.assertEqual(result["failure_type"], "OSError")
            # Reporting does not silently restore the old entry or claim durability.
            self.assertTrue((target / "assets/old.js").exists())


if __name__ == "__main__":
    unittest.main()
