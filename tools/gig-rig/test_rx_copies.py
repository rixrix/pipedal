"""Private transaction guards and actual-filesystem rollback regressions."""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import rx_copies as rx


class RxCopiesTests(unittest.TestCase):
    """Faults occur after real os.replace, not a mirrored publication implementation.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-EXPORT] [DES-SEC] [7.11]
    """
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.output, self.app = self.root / 'private', self.root / 'app'
        self.output.mkdir(mode=0o700); self.app.mkdir()
        self.bank, self.profile = self.root / 'Library.bank', self.root / 'preferences.settings'
        self.stopped, self.index = self.root / 'currentPreset.json', self.root / 'index.banks'
        self.before = json.dumps({'name':'TONE3000 Library', 'selectedPreset':26,
            'presets':[{'instanceId':ident, 'preset':{'name':f'Rig {ident}'}} for ident in (*rx.RX,*rx.RESET)]}).encode()
        revised = json.loads(self.before)
        for entry in revised['presets'][6:]: entry['preset']['reset'] = True
        self.after = json.dumps(revised).encode()
        self.bank.write_bytes(self.before); self.profile.write_bytes(b'private processing profile')
        self.stopped.write_text(json.dumps({'modified':False,'preset':{'name':'Owner Rx'}}))
        self.index.write_text(json.dumps({'selectedBank':6}))
        self.plan = {'bankSha256':rx.sha(self.before), 'afterSha256':rx.sha(self.after),
            'profileSha256':rx.sha(self.profile.read_bytes()), 'selectedPreset':26, 'exports':[], 'sources':[]}
        (self.output / 'bank-before.json').write_bytes(self.before)
        (self.output / 'bank-after.json').write_bytes(self.after)
        for ident in rx.RX:
            name=f'pipedal-rx-6-{ident}-1.t3kpreset'; raw=f'Previously native-validated export {ident}'.encode()
            (self.output / name).write_bytes(raw)
            self.plan['exports'].append({'file':name,'sha256':rx.sha(raw),'presetId':ident,'rawId':f'rx-{ident}','name':f'Rig {ident} (PiPedal)'})
        for ident in rx.RESET:
            path=self.root / f'source-{ident}.t3kpreset'; raw=f'Previously native-validated source {ident}'.encode();path.write_bytes(raw)
            self.plan['sources'].append({'path':str(path),'sha256':rx.sha(raw),'presetId':ident})
        (self.output / 'plan.json').write_text(json.dumps(self.plan))
        stack=ExitStack();self.addCleanup(stack.close)
        stack.enter_context(patch.object(rx,'BANK',self.bank));stack.enter_context(patch.object(rx,'APP',self.app));stack.enter_context(patch.object(rx,'PROFILE',self.profile))
        # Redirect only the two fixed stopped-state reads; all path checks and
        # atomic writes still operate on real private temporary files.
        def private_path(*parts):
            path=Path(*parts)
            return {Path('/var/pipedal/currentPreset.json'):self.stopped,Path('/var/pipedal/presets/index.banks'):self.index}.get(path,path)
        stack.enter_context(patch.object(rx,'Path',private_path))
        stack.enter_context(patch.object(rx.os,'geteuid',return_value=0))
        stack.enter_context(patch.object(rx.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())))
        self.service=stack.enter_context(patch.object(rx.subprocess,'run',return_value=subprocess.CompletedProcess([],3)))
        # macOS directory fsync support is not assumed; file flushes are real.
        fsync=os.fsync
        stack.enter_context(patch.object(rx.os,'fsync',side_effect=lambda fd: None if stat.S_ISDIR(os.fstat(fd).st_mode) else fsync(fd)))

    def assert_no_publication(self):
        self.assertEqual(self.bank.read_bytes(),self.before)
        self.assertEqual(list(self.app.iterdir()),[])
        self.assertFalse((self.output/'published.json').exists())

    def test_success_preserves_rx_order_selection_and_publishes_only_prepared_bytes(self):
        rx.publish(self.output)
        self.assertEqual(self.bank.read_bytes(),self.after)
        before,after=json.loads(self.before),json.loads(self.bank.read_bytes())
        self.assertEqual(before['presets'][:6],after['presets'][:6]);self.assertEqual(after['selectedPreset'],26)
        for entry in self.plan['exports']:
            path=self.app/entry['file'];self.assertEqual(rx.sha(path.read_bytes()),entry['sha256']);self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600)
        self.assertEqual(json.loads((self.output/'stopped-owner-state.json').read_bytes())['modified'],False)
        self.assertTrue((self.output/'published.json').exists())
        grants = [call for call in self.service.call_args_list if call.args[0][0] == 'setfacl']
        self.assertEqual(len(grants), 6)
        self.assertTrue(all('u::rw-,u:pipedal_d:r--,g::---,m::r--,o::---' in call.args[0] for call in grants))

    def test_service_read_grant_failure_rolls_back_new_exports(self):
        def command(args, **kwargs):
            if args[0] == 'setfacl': raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 3)
        self.service.side_effect = command
        with self.assertRaises(subprocess.CalledProcessError): rx.publish(self.output)
        self.assert_no_publication()

    def test_directory_sync_failure_after_first_export_removes_published_file(self):
        first=self.app/self.plan['exports'][0]['file'];failed=False
        def sync(fd):
            nonlocal failed
            if stat.S_ISDIR(os.fstat(fd).st_mode) and first.exists() and not failed:
                failed=True;raise OSError('injected directory fsync after export replace')
        with patch.object(rx.os,'fsync',side_effect=sync):
            with self.assertRaisesRegex(OSError,'after export replace'):rx.publish(self.output)
        self.assertTrue(failed);self.assert_no_publication();self.assertEqual(list(self.root.glob('.rx-publish-*')),[])

    def test_concurrent_destination_is_not_overwritten_or_removed(self):
        destination = self.app / self.plan['exports'][0]['file']
        link = os.link
        def racing_link(source, target, **options):
            destination.write_bytes(b'New authoring-app save')
            return link(source, target, **options)
        with patch.object(rx.os, 'link', side_effect=racing_link):
            with self.assertRaises(FileExistsError): rx.publish(self.output)
        self.assertEqual(destination.read_bytes(), b'New authoring-app save')
        self.assertEqual(self.bank.read_bytes(), self.before)
        self.assertFalse((self.output / 'published.json').exists())

    def test_directory_sync_failure_after_bank_replace_restores_bank_and_all_exports(self):
        failed=False
        def sync(fd):
            nonlocal failed
            if stat.S_ISDIR(os.fstat(fd).st_mode) and self.bank.read_bytes()==self.after and not failed:
                failed=True;raise OSError('injected directory fsync after bank replace')
        with patch.object(rx.os,'fsync',side_effect=sync):
            with self.assertRaisesRegex(OSError,'after bank replace'):rx.publish(self.output)
        self.assertTrue(failed);self.assert_no_publication()

    def test_rollback_never_deletes_a_destination_replaced_with_other_bytes(self):
        first=self.app/self.plan['exports'][0]['file'];failed=False
        def sync(fd):
            nonlocal failed
            if stat.S_ISDIR(os.fstat(fd).st_mode) and first.exists() and not failed:
                failed=True;first.write_bytes(b'Changed by another writer');raise OSError('injected publication failure')
        with patch.object(rx.os,'fsync',side_effect=sync):
            with self.assertRaisesRegex(OSError,'publication failure'):rx.publish(self.output)
        self.assertTrue(failed);self.assertEqual(self.bank.read_bytes(),self.before)
        self.assertEqual(first.read_bytes(),b'Changed by another writer');self.assertEqual(list(self.app.iterdir()),[first])

    def test_stopped_dirty_owner_is_refused_before_publication(self):
        self.stopped.write_text(json.dumps({'modified':True,'preset':{'name':'Unsaved owner edit'}}))
        with patch.object(rx,'atomic') as atomic:
            with self.assertRaisesRegex(ValueError,'unsaved edits'):rx.publish(self.output)
            atomic.assert_not_called()
        self.assert_no_publication()

    def test_changed_selected_bank_is_refused_before_publication(self):
        self.index.write_text(json.dumps({'selectedBank':7}))
        with patch.object(rx,'atomic') as atomic:
            with self.assertRaisesRegex(ValueError,'Owner changed'):rx.publish(self.output)
            atomic.assert_not_called()
        self.assert_no_publication()

    def test_changed_selected_preset_is_refused_before_publication(self):
        changed=json.loads(self.before);changed['selectedPreset']=25;raw=json.dumps(changed).encode();self.bank.write_bytes(raw)
        with patch.object(rx,'atomic') as atomic:
            with self.assertRaisesRegex(ValueError,'Owner changed'):rx.publish(self.output)
            atomic.assert_not_called()
        self.assertEqual(self.bank.read_bytes(),raw);self.assertEqual(list(self.app.iterdir()),[])

    def test_stale_saved_bank_and_processing_profile_are_refused_before_publication(self):
        for target in ('bank','profile'):
            with self.subTest(target=target):
                evidence=self.output/'stopped-owner-state.json'
                if evidence.exists():evidence.unlink()
                self.bank.write_bytes(self.before);self.profile.write_bytes(b'private processing profile')
                if target=='bank':
                    changed=json.loads(self.before);changed['presets'][0]['preset']['ownerEdit']=True;self.bank.write_text(json.dumps(changed))
                else:self.profile.write_bytes(b'new owner processing profile')
                current=self.bank.read_bytes()
                with patch.object(rx,'atomic') as atomic:
                    with self.assertRaisesRegex(ValueError,'bank/profile changed'):rx.publish(self.output)
                    atomic.assert_not_called()
                self.assertEqual(self.bank.read_bytes(),current);self.assertEqual(list(self.app.iterdir()),[])

    def test_running_service_refuses_publish_before_any_state_read(self):
        self.service.return_value=subprocess.CompletedProcess([],0)
        with patch.object(rx,'regular') as regular:
            with self.assertRaisesRegex(ValueError,'pipedald stopped'):rx.publish(self.output)
            regular.assert_not_called()
        self.assert_no_publication()

    def test_stale_native_source_refuses_publication(self):
        Path(self.plan['sources'][0]['path']).write_bytes(b'Changed native source')
        with patch.object(rx,'atomic') as atomic:
            with self.assertRaisesRegex(ValueError,'Source changed'):rx.publish(self.output)
            atomic.assert_not_called()
        self.assert_no_publication()


if __name__=='__main__':unittest.main()
