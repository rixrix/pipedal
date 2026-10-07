"""Provenance and exact-hunk tests for the approved configure-time patch."""

import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("readback_patch", Path(__file__).with_name("apply_tone3000_readback.py"))
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)


class ExactHunkTests(unittest.TestCase):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-UI] [2.8]"""

    def patch(self, hunk):
        source = patcher.RELATIVE_SOURCE.as_posix()
        return f"--- a/{source}\n+++ b/{source}\n{hunk}"

    def test_applies_multiple_exact_hunks(self):
        diff = self.patch("@@ -1,2 +1,2 @@\n one\n-two\n+second\n@@ -4 +4 @@\n-four\n+fourth\n")
        self.assertEqual(patcher.apply_hunks("one\ntwo\nthree\nfour\n", diff), "one\nsecond\nthree\nfourth\n")

    def test_refuses_fuzzy_context_and_wrong_counts(self):
        for hunk in ["@@ -1 +1 @@\n-old\n+new\n", "@@ -1,2 +1 @@\n-old\n+new\n"]:
            with self.subTest(hunk=hunk), self.assertRaises(patcher.PatchError):
                patcher.apply_hunks("different\n", self.patch(hunk))

    def test_refuses_additional_file_target(self):
        with self.assertRaises(patcher.PatchError):
            patcher.apply_hunks("old\n", "--- a/unrelated\n+++ b/unrelated\n@@ -1 +1 @@\n-old\n+new\n")

    def test_reviewed_patch_digest(self):
        self.assertEqual(patcher.digest(patcher.PATCH_FILE.read_bytes()), patcher.PATCH_SHA256)

    def test_unknown_vendor_source_is_not_mutated(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / patcher.RELATIVE_SOURCE
            target.parent.mkdir(parents=True)
            target.write_bytes(b"unreviewed vendor source\n")
            with self.assertRaises(patcher.PatchError):
                patcher.apply(root)
            self.assertEqual(target.read_bytes(), b"unreviewed vendor source\n")


if __name__ == "__main__":
    unittest.main()
