"""Exact provenance and fail-before-write checks for the staged native bridge."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location("stage_patcher",Path(__file__).with_name("apply_tone3000_stage.py"))
patcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(patcher)

class StageOverlayTests(unittest.TestCase):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.5]"""
    def test_reviewed_manifest_and_all_artifacts(self):
        raw=(patcher.HERE/'tone3000-stage-manifest.json').read_bytes()
        self.assertEqual(patcher.digest(raw),patcher.MANIFEST_SHA256)
        for name,digest in json.loads(raw)['artifacts'].items():
            self.assertEqual(patcher.digest((patcher.HERE/name).read_bytes()),digest)
        self.assertEqual(json.loads(raw)['juce/modules/juce_audio_plugin_client/juce_audio_plugin_client_LV2.cpp']['before'],
            'c569c8184c496e5cc4378ffbf237e29162de54e15a6da32ebea2f6cbb0bc45ed')

    def test_exact_hunks_refuse_drift_fuzz_wrong_targets_and_counts(self):
        diff='--- a/tone3000/file\n+++ b/tone3000/file\n@@ -1 +1 @@\n-old\n+new\n'
        self.assertEqual(patcher.exact_patch('old\n',diff,'tone3000/file'),'new\n')
        for source,text,target in [('changed\n',diff,'tone3000/file'),('old\n',diff,'juce/file'),('old\n',diff.replace('@@ -1 +1 @@','@@ -1,2 +1 @@'),'tone3000/file')]:
            with self.subTest(target=target),self.assertRaises(patcher.StagePatchError):patcher.exact_patch(source,text,target)

    def fixture(self,root):
        here=root/'artifacts';here.mkdir();tone=root/'tone';tone.mkdir();juce=root/'juce';juce.mkdir()
        (tone/'first').write_bytes(b'old-one\n');(juce/'second').write_bytes(b'old-two\n')
        diff='--- a/tone3000/first\n+++ b/tone3000/first\n@@ -1 +1 @@\n-old-one\n+new-one\n--- a/juce/second\n+++ b/juce/second\n@@ -1 +1 @@\n-old-two\n+new-two\n'
        (here/'tone3000-stage.patch').write_text(diff)
        for name in ('Tone3000StageBridge.hpp','stage-addon/Tone3000StageSession.h','stage-addon/Tone3000StageSession.cpp','stage-addon/Tone3000StageMeter.hpp'):
            path=here/name;path.parent.mkdir(exist_ok=True);path.write_bytes(b'reviewed-addon\n')
        (tone/'plugin/include').mkdir(parents=True);(tone/'plugin/src').mkdir();(juce/'modules/juce_audio_plugin_client').mkdir(parents=True)
        manifest={'tone3000/first':{'before':patcher.digest(b'old-one\n'),'after':patcher.digest(b'new-one\n')},'juce/second':{'before':patcher.digest(b'old-two\n'),'after':patcher.digest(b'new-two\n')}}
        manifest['artifacts']={name:patcher.digest((here/name).read_bytes()) for name in ('tone3000-stage.patch','Tone3000StageBridge.hpp','stage-addon/Tone3000StageSession.h','stage-addon/Tone3000StageSession.cpp','stage-addon/Tone3000StageMeter.hpp')}
        raw=(json.dumps(manifest)+'\n').encode();(here/'tone3000-stage-manifest.json').write_bytes(raw)
        return here,tone,juce,patcher.digest(raw)

    def test_preflight_rejects_later_source_before_first_mutation(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as temporary:
            here,tone,juce,digest=self.fixture(Path(temporary));(juce/'second').write_bytes(b'unreviewed\n')
            with patch.object(patcher,'HERE',here),patch.object(patcher,'MANIFEST_SHA256',digest),self.assertRaises(patcher.StagePatchError):patcher.apply(tone,juce)
            self.assertEqual((tone/'first').read_bytes(),b'old-one\n');self.assertFalse((tone/'plugin/include/Tone3000StageBridge.hpp').exists())

    def test_publication_idempotence_check_and_preserved_line_endings(self):
        with tempfile.TemporaryDirectory(dir="/private/tmp") as temporary:
            here,tone,juce,digest=self.fixture(Path(temporary));(tone/'first').write_bytes(b'old-one\r\n')
            with patch.object(patcher,'HERE',here),patch.object(patcher,'MANIFEST_SHA256',digest):
                with self.assertRaises(patcher.StagePatchError):patcher.apply(tone,juce,check=True)
                self.assertEqual(patcher.apply(tone,juce)['writes'],7)
                self.assertEqual(patcher.apply(tone,juce)['writes'],0)
                self.assertEqual(patcher.apply(tone,juce,check=True)['writes'],0)
            self.assertEqual((tone/'first').read_bytes(),b'new-one\r\n')

    def test_symlink_and_unknown_existing_addon_are_refused_before_write(self):
        for symlink in (True,False):
            with self.subTest(symlink=symlink),tempfile.TemporaryDirectory(dir="/private/tmp") as temporary:
                here,tone,juce,digest=self.fixture(Path(temporary));target=tone/'plugin/include/Tone3000StageBridge.hpp'
                if symlink:target.symlink_to(here/'Tone3000StageBridge.hpp')
                else:target.write_bytes(b'unknown custom addon')
                with patch.object(patcher,'HERE',here),patch.object(patcher,'MANIFEST_SHA256',digest),self.assertRaises(patcher.StagePatchError):patcher.apply(tone,juce)
                self.assertEqual((tone/'first').read_bytes(),b'old-one\n')

if __name__=='__main__':unittest.main()
