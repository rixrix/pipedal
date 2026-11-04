#!/usr/bin/env python3
"""Authorized Pi smoke on disposable saved copies; never apply an owner level trim."""
import argparse
from copy import deepcopy
import json
import math
from pathlib import Path
import time
from urllib.request import Request, urlopen
from zipfile import ZipFile

from pipedal_rpc import PiPedalRpc
from qualification import private_destination, write_private
from library_e2e import child, node_bytes, parameters, state

BANK = Path('/var/pipedal/presets/TONE3000+Library.bank')


def check_bundle_import(output, bundle):
    """Roundtrip a qualified bundle through the existing no-autoload importer.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BUNDLE] [DES-TEST] [7.7]
    """
    output = private_destination(output); output.mkdir(mode=0o700)
    original = BANK.read_bytes()
    raw = bundle.read_bytes()
    with PiPedalRpc(timeout=30) as rpc:
        banks, presets = rpc.request('getBankIndex'), rpc.request('getPresets')
        if banks['selectedBank'] != 6 or presets['presetChanged']:
            raise ValueError('Begin on a clean Library rig')
        owner = presets['selectedInstanceId']
        report = json.loads(urlopen(Request('http://127.0.0.1/var/checkRigBundle', data=raw), timeout=30).read())
        if not report['knownAssetsPresent'] or any(not p['installed'] for p in report['plugins']):
            raise ValueError('Bundle dependency check failed')
        identifier = json.loads(urlopen(Request('http://127.0.0.1/var/uploadBank', data=raw, headers={'Content-Type': 'application/json'}), timeout=30).read())
        try:
            assert rpc.request('getBankIndex')['selectedBank'] == 6
            with ZipFile(bundle) as archive:
                expected = json.loads(archive.read('bankFile.json'))
            first = expected['presets'][0]['instanceId']
            rpc.request('loadTone3000Preset', {'bankId': identifier, 'presetId': first}); time.sleep(1)
            _, actual = state(rpc.request('currentPedalboard'))
            _, stored = state(expected['presets'][0]['preset'])
            assert node_bytes(child(actual, 'ChainSnapshot')) == node_bytes(child(stored, 'ChainSnapshot'))
            actual_params, stored_params = parameters(actual), parameters(stored)
            assert all(math.isclose(actual_params[k], v, rel_tol=1e-7, abs_tol=1e-6) for k, v in stored_params.items())
            write_private(output, 'summary.json', {'importedBank': identifier, 'presets': report['presetCount'], 'noAutoload': True, 'firstFullStateRecall': True, 'cleanDeviceVerified': False, 'listeningVerified': False})
        finally:
            with PiPedalRpc(timeout=10) as recovery:
                if recovery.request('getBankIndex')['selectedBank'] == identifier:
                    recovery.request('loadTone3000Preset', {'bankId': 6, 'presetId': owner})
                recovery.request('deleteBankItem', identifier)
            assert BANK.read_bytes() == original
    print('Bundle upload/no-autoload/full-state recall passed; disposable import removed and owner bank unchanged.')


def wait_clean(rpc):
    for _ in range(50):
        if not rpc.request('getPresets')['presetChanged']: return
        time.sleep(.1)
    raise RuntimeError('Save did not confirm a clean preset')


def run(rpc, instance, command, payload=None, cancel=False, context=None):
    """Use real daemon ownership, native dispatch and result polling.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.5] [7.6]
    """
    def owned():
        if context and (rpc.request('getBankIndex')['selectedBank'], rpc.request('getPresets')['selectedInstanceId']) != context:
            raise ValueError('Owner changed the playing rig; validation stopped')
    owned()
    current = rpc.request('getTone3000CurrentState', {'instanceId': instance})
    owned()
    request = {'instanceId': instance, 'command': command, 'expectedRevision': current['revision']}
    if payload is not None: request['payload'] = payload
    started = rpc.request('startTone3000Stage', request)
    identity = {'instanceId': instance, 'token': started['token']}
    if cancel:
        time.sleep(.15)
        rpc.request('cancelTone3000Stage', identity)
    until = time.monotonic() + 25
    while time.monotonic() < until:
        owned()
        result = rpc.request('pollTone3000Stage', identity)
        if result['state'] not in ('queued', 'listening'): return result
        time.sleep(.1)
    raise RuntimeError('Native action failed to finish before bounded deadline')



def check_stage_lifecycle(rpc, instance, context, restart=False, evidence_output=None):
    """Qualify cancellation/recall on the disposable playing context only.

    Snapshot data is built after explicit authoritative runtime capture; this
    does not test ordinary browser Snapshot Save or prove audio readiness.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STABILITY-REVIEW] [7.23]
    """
    def owned():
        if (rpc.request('getBankIndex')['selectedBank'],
                rpc.request('getPresets')['selectedInstanceId']) != context:
            raise ValueError('Owner changed the playing rig; lifecycle validation stopped')

    def native(command, payload=None):
        return run(rpc, instance, command, payload, context=context)

    def captured_pans():
        owned()
        rpc.request('getTone3000CurrentState', {'instanceId': instance})
        owned()
        board = rpc.request('currentPedalboard')
        item, tree = state(board)
        if item['instanceId'] != instance:
            raise ValueError('Disposable TONE3000 instance changed')
        actual = parameters(tree)
        pans = (actual['chainPanLeft'], actual['chainPanRight'])
        if not all(math.isfinite(value) for value in pans):
            raise ValueError('Captured pan is nonfinite')
        return board, pans

    def close_to(actual, desired):
        return all(math.isclose(a, b, abs_tol=1e-5, rel_tol=0) for a, b in zip(actual, desired))

    def stable_pans(desired, phase):
        deadline = time.monotonic() + 15
        since = None
        observations = 0
        began = time.monotonic()
        trace = []
        while time.monotonic() < deadline:
            try:
                board, actual = captured_pans()
            except RuntimeError as failure:
                if 'Apply accepted; plugin state has not reflected edit yet' not in str(failure):
                    raise
                since = None
                trace.append({'seconds': time.monotonic() - began, 'pending': str(failure)[:400]})
            else:
                trace.append({'seconds': time.monotonic() - began, 'left': actual[0], 'right': actual[1],
                              'selectedSnapshot': board.get('selectedSnapshot')})
                if close_to(actual, desired):
                    since = time.monotonic() if since is None else since
                    observations += 1
                    if time.monotonic() - since >= .6:
                        return {'left': actual[0], 'right': actual[1],
                                'observations': observations, 'stableSeconds': time.monotonic() - since}
                else:
                    since = None
                    observations = 0
            time.sleep(.1)
        if evidence_output is not None:
            write_private(evidence_output, 'lifecycle-failure.json',
                          {'phase': phase, 'bankId': context[0], 'presetId': context[1],
                           'instanceId': instance, 'expectedLeft': desired[0], 'expectedRight': desired[1],
                           'capturedObservations': trace, 'audioReadinessQualified': False})
        last = trace[-1] if trace else None
        raise RuntimeError('Desired captured pans did not remain stable after lifecycle change '
                           + phase + '; last observation: ' + json.dumps(last, allow_nan=False))

    def snapshot_values(items):
        values = []
        for item in items:
            values.append({key: deepcopy(item.get(key, default)) for key, default in
                           (('instanceId', -1), ('isEnabled', True), ('controlValues', []),
                            ('lv2State', [False, {}]), ('pathProperties', {}))})
            for lane in ('topChain', 'bottomChain'):
                values.extend(snapshot_values(item.get(lane, [])))
        return values

    owned()
    runtime = native('runtime')
    live = runtime.get('runtime', {})
    if (runtime['state'] != 'done' or live.get('unknown')
            or live.get('stereoEnabled') is not True or live.get('stereoOutput') is not True
            or live.get('audioActive') is not True):
        raise ValueError('Lifecycle qualification requires actual active stereo TONE3000 output')
    owned()
    linked = rpc.request('getPatchProperty', {'instanceId': instance,
                         'propertyUri': 'https://www.tone3000.com/plugin:chainPanLinked'})
    if not math.isclose(linked, 1.0, abs_tol=1e-5):
        raise ValueError('Disposable native linked-pan precondition changed')
    assert native('pan', {'side': 'left', 'value': .4})['state'] == 'done'
    stable_pans((.4, .6), "snapshot baseline")
    board, actual = captured_pans()
    assert close_to(actual, (.4, .6))
    snapshots = deepcopy(board.get('snapshots', []))
    while len(snapshots) < 6:
        snapshots.append(None)
    snapshots[0] = {'name': 'Lifecycle desired .4/.6', 'color': '', 'isModified': False,
                    'values': snapshot_values(board['items'])}
    owned()
    # Both existing snapshot handlers are notifications, with no reply. The
    # following ordered request acts as a processing barrier on this socket.
    rpc.send('setSnapshots', {'snapshots': snapshots, 'selectedSnapshot': -1})
    owned()
    stored = rpc.request('currentPedalboard')
    if not stored.get('snapshots') or stored['snapshots'][0] != snapshots[0]:
        raise ValueError('Native SetSnapshots did not retain the exact authored full-item snapshot')
    rpc.send('saveCurrentPreset')
    wait_clean(rpc)
    owned()
    trials = []
    for delay in (0, .01, .05, .2, .3):
        owned()
        current = rpc.request('getTone3000CurrentState', {'instanceId': instance})
        owned()
        started = rpc.request('startTone3000Stage', {'instanceId': instance, 'command': 'pan',
                              'expectedRevision': current['revision'], 'payload': {'side': 'left', 'value': .2}})
        # No result poll/capture here: exercise queued, completed-but-uncaptured,
        # and daemon-captured completion around the intentional recall barrier.
        if delay:
            time.sleep(delay)
        owned()
        rpc.send('setSnapshot', 0)
        observed = stable_pans((.4, .6), "recall delay " + str(delay))
        owned()
        try:
            rpc.request('pollTone3000Stage', {'instanceId': instance, 'token': started['token']})
        except RuntimeError as failure:
            if 'Soundcheck request expired' not in str(failure):
                raise
        else:
            raise ValueError('Snapshot recall retained the preceding native Stage job')
        trial = {'delaySeconds': delay, 'desiredRecallObserved': True,
                 'oldJobExpired': True, 'capturedPans': observed}
        trials.append(trial)
        if evidence_output is not None:
            write_private(evidence_output, 'lifecycle-trial-' + str(len(trials)) + '.json', trial)

    # All preceding jobs expired, and stable_pans explicitly cleared the load
    # intent. These reads therefore observe the notification-updated model cache;
    # do not call getTone3000CurrentState until after intentional snapshot recall.
    owned()
    for symbol, value in (('chainPanLeft', .2), ('chainPanRight', .8)):
        owned()
        rpc.request('setPatchProperty', {'instanceId': instance,
                    'propertyUri': 'https://www.tone3000.com/plugin:' + symbol, 'value': value})
    notification_until = time.monotonic() + 5
    notification_began = time.monotonic()
    notification_trace = []
    while time.monotonic() < notification_until:
        owned()
        cached_board = rpc.request('currentPedalboard')
        cached_item, cached_tree = state(cached_board)
        if cached_item['instanceId'] != instance:
            raise ValueError('Disposable TONE3000 instance changed during direct patch notification')
        cached_params = parameters(cached_tree)
        cached_pans = (cached_params['chainPanLeft'], cached_params['chainPanRight'])
        if not all(math.isfinite(value) for value in cached_pans):
            raise ValueError('Notification-updated pan is nonfinite')
        notification_trace.append({'seconds': time.monotonic() - notification_began,
                                   'left': cached_pans[0], 'right': cached_pans[1]})
        if close_to(cached_pans, (.2, .8)):
            break
        time.sleep(.05)
    else:
        if evidence_output is not None:
            write_private(evidence_output, 'lifecycle-failure.json',
                          {'phase': 'direct patch model notification', 'bankId': context[0],
                           'presetId': context[1], 'instanceId': instance,
                           'expectedLeft': .2, 'expectedRight': .8,
                           'cachedObservations': notification_trace, 'explicitCaptureUsed': False})
        raise RuntimeError('Direct Patch Set did not notify the model of .2/.8 without explicit capture')
    notification = {'modelNotificationObserved': True, 'explicitCaptureUsed': False,
                    'cachedObservations': notification_trace}
    if evidence_output is not None:
        write_private(evidence_output, 'lifecycle-direct-patch-model.json', notification)
    owned()
    rpc.send('setSnapshot', 0)
    direct_patch = {**notification, 'desiredRecallObserved': True,
                    'capturedPans': stable_pans((.4, .6), 'direct patch recall')}
    if evidence_output is not None:
        write_private(evidence_output, 'lifecycle-direct-patch.json', direct_patch)

    restart_result = {'requested': restart, 'tested': False}
    dirty_restart_result = {'requested': restart, 'tested': False}
    if restart:
        # Exact settings are retained; this deliberately exercises RestartAudio
        # via the existing settings API, without choosing a different device.
        owned()
        settings = deepcopy(rpc.request('getJackServerSettings'))
        assert native('pan', {'side': 'left', 'value': .4})['state'] == 'done'
        stable_pans((.4, .6), "restart baseline")
        owned()
        rpc.send('saveCurrentPreset')
        wait_clean(rpc)
        current = rpc.request('getTone3000CurrentState', {'instanceId': instance})
        owned()
        began = time.monotonic()
        started = rpc.request('startTone3000Stage', {'instanceId': instance, 'command': 'pan',
                              'expectedRevision': current['revision'], 'payload': {'side': 'left', 'value': .2}})
        observed_before_poll = False
        while time.monotonic() - began < .25:
            left = rpc.request('getPatchProperty', {'instanceId': instance,
                               'propertyUri': 'https://www.tone3000.com/plugin:chainPanLeft'})
            if math.isclose(left, .2, abs_tol=1e-5):
                observed_before_poll = True
                break
            time.sleep(.005)
        elapsed = time.monotonic() - began
        owned()
        clean_before_restart = not rpc.request('getPresets')['presetChanged']
        if observed_before_poll and elapsed < .25 and clean_before_restart and time.monotonic() - began < .25:
            owned()
            if time.monotonic() - began >= .25:
                raise RuntimeError('Restart timing precondition expired before submission; retry qualification')
            rpc.request('setJackServerSettings', settings)
            owned()
            assert rpc.request('getJackServerSettings') == settings
            assert rpc.request('getPresets')['presetChanged'] is True
            observed = stable_pans((.2, .8), "same-settings restart")
            restart_result = {'requested': True, 'tested': True, 'observedBefore250ms': True,
                              'observationSeconds': elapsed, 'dirtyRetained': True,
                              'audioSettingsUnchanged': True, 'capturedPans': observed}
        else:
            # Do not count a daemon-poll capture as proof of the pre-Close race.
            restart_result['reason'] = 'Native completion was not observed cleanly before the 250ms daemon capture window'
            owned()
            rpc.request('cancelTone3000Stage', {'instanceId': instance, 'token': started['token']})
        # Separately qualify ordinary dirty-state retention after acknowledged
        # completion capture. Passing this does not qualify the narrow race above.
        owned()
        assert native('pan', {'side': 'left', 'value': .2})['state'] == 'done'
        stable_pans((.2, .8), 'ordinary dirty restart baseline')
        owned()
        if rpc.request('getPresets')['presetChanged'] is not True:
            raise ValueError('Completed native pan did not mark the disposable rig dirty')
        if rpc.request('getJackServerSettings') != settings:
            raise ValueError('Audio settings changed before ordinary dirty restart')
        owned()
        rpc.request('setJackServerSettings', deepcopy(settings))
        owned()
        assert rpc.request('getJackServerSettings') == settings
        assert rpc.request('getPresets')['presetChanged'] is True
        engine_until = time.monotonic() + 15
        engine_trace = []
        while time.monotonic() < engine_until:
            owned()
            host = rpc.request('getJackStatus')
            engine_trace.append({key: host.get(key) for key in
                                 ('active', 'engineRunning', 'usingFallback', 'restarting', 'audioDriver')})
            if (host.get('active') is True and host.get('engineRunning') is True and host.get('usingFallback') is False
                    and host.get('restarting') is False):
                break
            time.sleep(.1)
        else:
            if evidence_output is not None:
                write_private(evidence_output, 'lifecycle-failure.json',
                              {'phase': 'ordinary dirty restart host', 'bankId': context[0],
                               'presetId': context[1], 'instanceId': instance,
                               'hostObservations': engine_trace, 'audioReadinessQualified': False})
            raise RuntimeError('Ordinary dirty restart did not settle to the actual nonfallback running engine')
        observed = stable_pans((.2, .8), 'ordinary dirty same-settings restart')
        dirty_restart_result = {'requested': True, 'tested': True, 'completedBeforeRestart': True,
                                'dirtyRetained': True, 'audioSettingsUnchanged': True,
                                'capturedPans': observed, 'active': True, 'engineRunning': True, 'usingFallback': False,
                                'restarting': False, 'pre250msRaceQualified': False}
        if evidence_output is not None:
            write_private(evidence_output, 'lifecycle-dirty-restart.json', dirty_restart_result)
    return {'snapshotRecall': trials, 'directPatchRecall': direct_patch, 'sameSettingsRestart': restart_result,
            'dirtySameSettingsRestart': dirty_restart_result,
            'ordinarySnapshotSaveQualified': False, 'audioReadinessQualified': False}


def check(output, lifecycle_restart=False):
    """Exercise copies, previews, bundle HTTP, native edits and normal Save/recall.
    Owner data is guarded and selected rig restored; physical/listening gates stay open.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [DES-STAGE-BANK] [DES-STAGE-BUNDLE] [7.3] [7.4] [7.5] [7.6] [7.7]
    """
    output = private_destination(output); output.mkdir(mode=0o700)
    owner_bank = json.loads(BANK.read_bytes())
    with PiPedalRpc(timeout=30) as rpc:
        banks, presets = rpc.request('getBankIndex'), rpc.request('getPresets')
        if banks['selectedBank'] != 6 or presets['presetChanged']:
            raise ValueError('Begin on a clean owner Library rig')
        owner_selection = presets['selectedInstanceId']
        sources = rpc.request('getTone3000PerformanceSources')['sources']
        order = (17, 26, 25, 24)
        slots = []
        for ident in order:
            matches = [s for s in sources if s['bankId'] == 6 and s['presetId'] == ident]
            if len(matches) != 1: raise ValueError('Saved Rx source identity changed')
            slots.append({'bankId': 6, 'presetId': ident, 'expectedRevision': matches[0]['revision']})
        invalid = {'name': 'Validation', 'slots': deepcopy(slots)}
        invalid['slots'][0]['expectedRevision'] = '0' * 64
        try: rpc.request('createTone3000PerformanceBank', invalid)
        except RuntimeError: pass
        else: raise ValueError('Stale copied bank was accepted')
        result = rpc.request('createTone3000PerformanceBank', {'name': 'Validation', 'slots': slots})
        identifier = result['bankId']
        write_private(output, 'performance.json', result)
        try:
            assert rpc.request('getBankIndex')['selectedBank'] == 6
            assert [slot['program'] for slot in result['slots']] == [0, 1, 2, 3]
            library = rpc.request('getTone3000Library')
            target = next((e, i) for e in library['entries'] for i in e['imports'] if i['bankId'] == 6 and i['presetId'] == 26)
            preview = rpc.request('getTone3000PresetPreview', {'key': target[0]['key'], 'sha256': target[0]['sha256'], 'bankId': 6, 'presetId': 26, 'instanceId': target[1]['instanceId'], 'expectedImportSha256': target[1]['sha256']})
            assert preview['targetState'] is not None
            write_private(output, 'preview.json', preview)
            raw = urlopen('http://127.0.0.1/var/downloadBank?id=' + str(identifier), timeout=30).read()
            write_private(output, 'validation.piBank', raw)
            report = json.loads(urlopen(Request('http://127.0.0.1/var/checkRigBundle', data=raw, headers={'Content-Type': 'application/octet-stream'}), timeout=30).read())
            assert report['presetCount'] == 4 and report['knownAssetsPresent'] and not report['readinessProven']
            assert all(p['installed'] for p in report['plugins'])
            write_private(output, 'bundle.json', report)
            first = result['slots'][0]['presetId']
            for slot in result['slots']:
                rpc.request('loadTone3000Preset', {'bankId': identifier, 'presetId': slot['presetId']})
                time.sleep(.35)
                assert rpc.request('getPresets')['selectedInstanceId'] == slot['presetId']
            rpc.request('loadTone3000Preset', {'bankId': identifier, 'presetId': first}); time.sleep(1)
            board = rpc.request('currentPedalboard'); item, _ = state(board); instance = item['instanceId']
            native = lambda command, payload=None, cancel=False: run(rpc, instance, command, payload, cancel, (identifier, first))
            runtime = native('runtime'); assert runtime['state'] == 'done'
            write_private(output, 'runtime.json', runtime)
            # Set an explicit test precondition on the disposable copy; the
            # owner's saved rig may legitimately use independent stereo pans.
            rpc.request('setPatchProperty', {'instanceId': instance, 'propertyUri': 'https://www.tone3000.com/plugin:chainPanLinked', 'value': 1.0})
            assert native('pan', {'side': 'left', 'value': .2})['state'] == 'done'
            assert native('solo', {'side': 'left'})['state'] == 'done'
            _, tree = state(rpc.request('currentPedalboard')); actual = parameters(tree)
            assert abs(actual['chainPanLeft'] - .2) < 1e-5 and abs(actual['chainPanRight'] - .8) < 1e-5
            assert actual['chainSoloLeft'] == 1 and actual['chainSoloRight'] == 0
            assert native('solo', {'side': 'none'})['state'] == 'done'
            rpc.send('saveCurrentPreset'); wait_clean(rpc)
            rpc.request('loadTone3000Preset', {'bankId': identifier, 'presetId': result['slots'][1]['presetId']})
            rpc.request('loadTone3000Preset', {'bankId': identifier, 'presetId': first}); time.sleep(.5)
            _, tree = state(rpc.request('currentPedalboard')); assert abs(parameters(tree)['chainPanLeft'] - .2) < 1e-5
            cancelled = native('level', {'seconds': 10}, cancel=True); assert cancelled['state'] == 'cancelled'
            write_private(output, 'cancelled.json', cancelled)
            balanced = native('balance', cancel=True); assert balanced['state'] in ('cancelled', 'notApplicable')
            write_private(output, 'balance-cancelled.json', balanced)
            measured = native('level', {'seconds': 1})
            assert measured['state'] == 'done'; write_private(output, 'played-observation.json', measured)
            if not measured.get('valid'):
                try: rpc.request('applyTone3000Level', {'token': measured['token'], 'expectedRevision': measured['savedRevision'], 'targetRmsDb': -18})
                except RuntimeError: pass
                else: raise ValueError('Invalid phrase produced a saved output trim')
            align = native('align'); write_private(output, 'alignment.json', align)
            assert align['state'] in ('done', 'notApplicable', 'timeout')
            lifecycle = check_stage_lifecycle(rpc, instance, (identifier, first), lifecycle_restart, output)
            write_private(output, 'lifecycle.json', lifecycle)
            write_private(output, 'summary.json', {'copies': 4, 'preview': True, 'bundle': True, 'panSoloSaveRecall': True, 'cancel': True, 'alignState': align['state'], 'lifecycleRecallObserved': True, 'lifecycleRestartTested': lifecycle['sameSettingsRestart']['tested'], 'dirtyRestartRetentionTested': lifecycle['dirtySameSettingsRestart']['tested'], 'ownerTrimsApplied': False, 'physicalMidiVerified': False, 'listeningVerified': False})
        finally:
            # The original socket may have disconnected or the daemon restarted.
            # Recover only the disposable playing context, never a newer owner edit.
            restored = False
            for attempt in range(3):
                try:
                    with PiPedalRpc(timeout=10) as recovery:
                        if recovery.request('getBankIndex')['selectedBank'] == identifier:
                            recovery.request('loadTone3000Preset', {'bankId': 6, 'presetId': owner_selection})
                        entries = recovery.request('getBankIndex')['entries']
                        if any(e['instanceId'] == identifier for e in entries): recovery.request('deleteBankItem', identifier)
                        restored = True; break
                except (OSError, RuntimeError, TimeoutError, ConnectionError): time.sleep(.2)
            write_private(output, 'recovery.json', {'restored': restored, 'ownerBank': 6, 'ownerPreset': owner_selection, 'disposableBank': identifier})
            if not restored: raise RuntimeError('Device unavailable; private recovery.json retains exact cleanup identities')
            after = json.loads(BANK.read_bytes())
            assert after['presets'] == owner_bank['presets'] and after['nextInstanceId'] == owner_bank['nextInstanceId']
    print('Actual service preview/copies/bundle/native edits/Save/recall checked; owner rigs restored unchanged. Physical MIDI and listening pending.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--bundle', type=Path, help='Run only the disposable bundle import roundtrip')
    parser.add_argument('--lifecycle-restart', action='store_true', help='Also attempt the bounded unchanged-settings audio restart race on the disposable rig')
    args = parser.parse_args()
    if args.bundle: check_bundle_import(args.output, args.bundle)
    else: check(args.output, args.lifecycle_restart)
