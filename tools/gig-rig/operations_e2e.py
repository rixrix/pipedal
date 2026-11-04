#!/usr/bin/env python3
"""Exercise approved Plan B on the authorized test Pi, with private evidence.

Changes test audio and creates one disposable rig. Stops on failed assertions;
restoration is a separate guarded action so concurrent owner edits are retained.
"""
import argparse
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import time

from build_bank import default_item
from library_e2e import child, node_bytes, payload, read_tree, state, value, parameters
from pipedal_rpc import PiPedalRpc
from qualification import download_saved, write_private
from state_summary import PLUGIN


def observed(rpc, instance_id, timeout=30):
    """Poll actual captured state; elapsed time never substitutes for observation.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [3.14]
    """
    deadline = time.monotonic() + timeout
    while True:
        try:
            return rpc.request('getTone3000CurrentState', {'instanceId': instance_id})
        except RuntimeError as error:
            if 'Apply accepted;' not in str(error) or time.monotonic() >= deadline:
                raise
            time.sleep(.2)


def apply(rpc, current, patch, **policy):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [3.14]"""
    assert rpc.request('setTone3000CurrentState', {'instanceId': current['instanceId'],
        'expectedRevision': current['revision'], 'patch': patch, **policy}) is True
    return observed(rpc, current['instanceId'])


def assets(board):
    """Hash independent raw NAM/IR cached trees and source metadata, excluding EQ.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [3.14]
    """
    _, tree = state(board)
    result = {}
    for lane in child(tree, 'ChainSnapshot')['children']:
        for block in lane['children']:
            if value(block['fields']['type']) == 'insert':
                continue
            raw = b''.join(block['fields'].get(key, b'') for key in ('toneId', 'toneJson', 'activeModelId'))
            raw += b''.join(node_bytes(part) for part in block['children'] if part['tag'] != 'Eq')
            result[value(block['fields']['id'])] = hashlib.sha256(raw).hexdigest()
    return result


def rejected(rpc, message, body):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [3.14]"""
    try:
        rpc.request(message, body)
    except RuntimeError:
        return
    raise AssertionError('Invalid/stale operation was accepted: ' + message)


def run(rpc, output):
    """Real-service operations use only a fresh disposable library target.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [FR-14] [DES-OPERATE] [3.14]
    """
    owner = {name: rpc.request(method) for name, method in (
        ('board', 'currentPedalboard'), ('banks', 'getBankIndex'),
        ('presets', 'getPresets'), ('audio', 'getJackServerSettings'), ('library', 'getTone3000Library'))}
    write_private(output, 'operations-owner.json', owner)
    defaults = rpc.request('getTone3000Defaults')
    write_private(output, 'operations-defaults.json', defaults)
    assert {p['id'] for p in defaults['profiles']} == {'home', 'studio', 'live'}
    entry = next(e for e in owner['library']['entries'] if 'bogner' in e['name'].lower() and 'factory' in e['source'].lower())
    target = rpc.request('importTone3000Preset', payload(entry, as_new=True))
    write_private(output, 'operations-target.json', {'target': target, 'entry': entry})
    assert rpc.request('currentPedalboard') == owner['board'], 'Add changed playing owner rig'
    rpc.request('loadTone3000Preset', {key: target[key] for key in ('bankId', 'presetId')})
    current = observed(rpc, target['instanceId'])
    assert current['followDefaults'] is True
    assert rpc.request('getPresets')['presetChanged'] is False
    observed(rpc, target['instanceId'])
    assert rpc.request('getPresets')['presetChanged'] is False
    assert {'nam', 'ir'} <= {b['type'] for b in current['summary']['blocks']}
    initial_assets = assets(rpc.request('currentPedalboard'))
    for key in ('calibrateInput', 'inputCalibrationLevel', 'osEnabled', 'osFactor'):
        assert math.isclose(current['summary'][key], defaults['defaults'][key], abs_tol=1e-4)

    # Include a real surrounding effect, snapshot and MIDI data in the clone.
    composed = rpc.request('currentPedalboard')
    plugins = rpc.request('plugins')
    info = next(p for p in plugins if p.get('uri') == 'http://two-play.com/plugins/toob-delay')
    effect_id = max(composed.get('nextInstanceId', 0), *(item['instanceId'] for item in composed['items'])) + 1
    effect = default_item(info, effect_id)
    composed['items'].append(effect)
    composed['nextInstanceId'] = effect_id + 1
    snapshot_fields = ('instanceId', 'isEnabled', 'controlValues', 'lv2State', 'pathProperties')
    composed['snapshots'] = [{'name': 'Plan B qualification', 'color': '#4caf50', 'isModified': False,
        'values': [{key: deepcopy(item[key]) for key in snapshot_fields} for item in composed['items']]}]
    composed['selectedSnapshot'] = -1
    rpc.send('updateCurrentPedalboard', {'clientId': -1, 'pedalboard': composed})
    current = observed(rpc, target['instanceId'])
    base = rpc.request('currentPedalboard')
    effect = deepcopy(base['items'][1])
    snapshot = deepcopy(base['snapshots'])
    tone = next(i for i in base['items'] if i['uri'] == PLUGIN)
    midi = deepcopy(tone.get('midiBindings'))
    nam = next(b for b in current['summary']['blocks'] if b['type'] == 'nam')
    patch = {'blocks': [{'blockId': nam['blockId'], 'enabled': not nam['enabled'],
        'normalize': not nam['normalize'], 'slimSize': 0 if nam['slimSize'] >= .5 else 1,
        'inputGain': .55, 'outputGain': .45, 'mix': .9, 'eqEnabled': True,
        'eqPre': True, 'eqBands': [{'index': 2, 'gainDb': 1.5, 'freqHz': 700, 'q': 1.2}]}]}
    old_revision = current['revision']
    current = apply(rpc, current, patch)
    changed = next(b for b in current['summary']['blocks'] if b['blockId'] == nam['blockId'])
    assert changed['enabled'] != nam['enabled'] and changed['normalize'] != nam['normalize']
    assert math.isclose(changed['eq']['bands'][2]['gainDb'], 1.5, abs_tol=1e-4)
    board = rpc.request('currentPedalboard')
    assert assets(board) == initial_assets
    assert board['items'][1] == effect and board['snapshots'] == snapshot
    assert board['items'][0].get('midiBindings') == midi
    rejected(rpc, 'setTone3000CurrentState', {'instanceId': target['instanceId'], 'expectedRevision': old_revision, 'patch': patch})
    for bad in ({'unknown': 1}, {'blocks': [{'blockId': nam['blockId'], 'mix': 2}]},
                {'blocks': [{'blockId': nam['blockId'], 'eqBands': [{'index': 1, 'q': 0}]}]}):
        rejected(rpc, 'setTone3000CurrentState', {'instanceId': target['instanceId'], 'expectedRevision': current['revision'], 'patch': bad})
    assert observed(rpc, target['instanceId'])['revision'] == current['revision']

    # Global writes are staged: actual playing state must remain unchanged.
    live = deepcopy(defaults['defaults'])
    live.update(calibrateInput=not live['calibrateInput'], inputCalibrationLevel=10.5, osEnabled=False, osFactor=1,
                multiCore=not live['multiCore'], namSlimSizeDefault=0 if live['namSlimSizeDefault'] else 1)
    staged = rpc.request('setTone3000Defaults', {'expectedRevision': defaults['revision'], 'activeProfile': 'live', 'defaults': live})
    assert observed(rpc, target['instanceId']) == current
    assert staged['activeProfile'] == 'live' and staged['defaults'] == live
    rejected(rpc, 'setTone3000Defaults', {'expectedRevision': defaults['revision'], 'activeProfile': 'home', 'defaults': defaults['defaults']})
    rejected(rpc, 'setTone3000Defaults', {'expectedRevision': staged['revision'], 'activeProfile': 'live', 'defaults': {**live, 'audioDevice': 'bad'}})
    current = apply(rpc, current, {}, followDefaults=True, applyDefaults=True)
    for key in ('calibrateInput', 'inputCalibrationLevel', 'osEnabled', 'osFactor'):
        assert math.isclose(current['summary'][key], live[key], abs_tol=1e-4)
    assert assets(rpc.request('currentPedalboard')) == initial_assets
    assert next(b for b in current['summary']['blocks'] if b['blockId'] == nam['blockId'])['slimSize'] == changed['slimSize']
    current = apply(rpc, current, {'inputCalibrationLevel': 9.5})
    assert current['followDefaults'] is False and math.isclose(current['summary']['inputCalibrationLevel'], 9.5, abs_tol=1e-4)
    # Ordinary Patch Set also opts out without changing block controls.
    current = apply(rpc, current, {}, followDefaults=True, applyDefaults=True)
    rpc.request('setPatchProperty', {'instanceId': target['instanceId'], 'propertyUri': PLUGIN + ':inputCalibrationLevel', 'value': 8.5})
    current = observed(rpc, target['instanceId'])
    assert current['followDefaults'] is False and math.isclose(current['summary']['inputCalibrationLevel'], 8.5, abs_tol=1e-4)
    rpc.send('saveCurrentPreset')
    assert rpc.request('getPresets')['presetChanged'] is False
    raw, saved = download_saved('ws://127.0.0.1/pipedal', target['presetId'])
    write_private(output, 'operations-tweaked.piPreset', raw)
    assert assets(saved) == initial_assets and saved['snapshots'] == snapshot
    rpc.request('loadTone3000Preset', {key: target[key] for key in ('bankId', 'presetId')})
    current = observed(rpc, target['instanceId'])
    assert current['followDefaults'] is False and math.isclose(current['summary']['inputCalibrationLevel'], 8.5, abs_tol=1e-4)
    assert rpc.request('getPresets')['presetChanged'] is False
    # Explicit source overwrite replaces tone/block edits, retaining processing.
    mapped = {**target, 'sha256': entry['sha256']}
    assert rpc.request('importTone3000Preset', payload(entry, mapped)) == target
    current = observed(rpc, target['instanceId'])
    source = next(b for b in current['summary']['blocks'] if b['blockId'] == nam['blockId'])
    assert source['enabled'] == nam['enabled'] and source['normalize'] == nam['normalize']
    assert current['followDefaults'] is False and math.isclose(current['summary']['inputCalibrationLevel'], 8.5, abs_tol=1e-4)
    board = rpc.request('currentPedalboard')
    assert assets(board) == initial_assets and board['items'][1] == effect and board['snapshots'] == snapshot
    assert rpc.request('getJackServerSettings') == owner['audio']
    write_private(output, 'operations-last-state.json', current)
    write_private(output, 'operations-last-defaults.json', rpc.request('getTone3000Defaults'))
    write_private(output, 'operations-result.json', {'fresh_follow_seed': True, 'sparse_block_eq_edit': True,
        'assets_effects_midi_snapshots_preserved': True, 'stale_invalid_rejected': True,
        'defaults_staged_only': True, 'explicit_apply_observed': True, 'manual_patch_opts_out': True,
        'save_recall': True, 'source_overwrite_preserves_processing': True, 'audio_config_unchanged': True})


def follow(rpc, output):
    """Actual clean-load and snapshot policy.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [3.14]
    """
    target=json.loads((output/'operations-target.json').read_text())['target']
    assert rpc.request('getPresets')['selectedInstanceId']==target['presetId']
    original_assets=assets(rpc.request('currentPedalboard'))
    current=apply(rpc,observed(rpc,target['instanceId']),{},followDefaults=True,applyDefaults=True)
    assert current['followDefaults']
    rpc.send('saveCurrentPreset'); assert not rpc.request('getPresets')['presetChanged']
    profiles=rpc.request('getTone3000Defaults');home=next(p['defaults'] for p in profiles['profiles'] if p['id']=='home')
    home={**home,'inputCalibrationLevel':11.25,'osEnabled':False,'osFactor':0}
    profiles=rpc.request('setTone3000Defaults',{'expectedRevision':profiles['revision'],'activeProfile':'home','defaults':home})
    assert observed(rpc,target['instanceId'])==current
    rpc.request('loadTone3000Preset',{key:target[key] for key in ('bankId','presetId')})
    current=observed(rpc,target['instanceId'])
    assert current['followDefaults'] and not rpc.request('getPresets')['presetChanged']
    for key in ('calibrateInput','inputCalibrationLevel','osEnabled','osFactor'):
        assert math.isclose(current['summary'][key],home[key],abs_tol=1e-4)
    rpc.send('setSnapshot',0)
    current=observed(rpc,target['instanceId'])
    for key in ('calibrateInput','inputCalibrationLevel','osEnabled','osFactor'):
        assert math.isclose(current['summary'][key],home[key],abs_tol=1e-4)
    assert assets(rpc.request('currentPedalboard'))==original_assets
    rpc.send('saveCurrentPreset'); assert not rpc.request('getPresets')['presetChanged']
    write_private(output,'operations-last-state-after-follow.json',observed(rpc,target['instanceId']))
    write_private(output,'operations-last-defaults-after-follow.json',profiles)
    write_private(output,'operations-follow-result.json',{'staged_defaults_leave_audio_state':True,'clean_follow_load':True,'snapshot_follow':True,'assets_preserved':True,'normal_save':True})


def restore(rpc, output):
    """Restore only while the disposable rig is still selected and unchanged.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [DES-ROLLOUT] [3.14]
    """
    owner = json.loads((output / 'operations-owner.json').read_text())
    target = json.loads((output / 'operations-target.json').read_text())['target']
    last_file = next((output / name for name in ('operations-last-state-after-follow.json', 'operations-last-state.json') if (output / name).exists()))
    last = json.loads(last_file.read_text())
    assert rpc.request('getBankIndex')['selectedBank'] == target['bankId']
    assert rpc.request('getPresets')['selectedInstanceId'] == target['presetId']
    assert observed(rpc, target['instanceId']) == last, 'Concurrent rig edits; leave private recovery untouched'
    baseline = json.loads((output / 'operations-defaults.json').read_text())
    current = rpc.request('getTone3000Defaults')
    defaults_file = next((output / name for name in ('operations-last-defaults-after-follow.json', 'operations-last-defaults.json') if (output / name).exists()))
    assert current == json.loads(defaults_file.read_text()), 'Concurrent global edits; leave recovery untouched'
    # Restore all three profiles, then the original active selection.
    for profile in baseline['profiles']:
        current = rpc.request('setTone3000Defaults', {'expectedRevision': current['revision'],
            'activeProfile': profile['id'], 'defaults': profile['defaults']})
    current = rpc.request('setTone3000Defaults', {'expectedRevision': current['revision'],
        'activeProfile': baseline['activeProfile'], 'defaults': baseline['defaults']})
    rpc.request('deletePresetItems', [target['presetId']])
    rpc.request('openBank', owner['banks']['selectedBank'])
    rpc.send('loadPreset', owner['presets']['selectedInstanceId'])
    rpc.request('currentPedalboard')
    if owner['presets']['presetChanged']:
        # An empty temporary graph prevents the generic structural-edit API
        # reusing an old same-ID effect while restoring opaque unsaved state.
        barrier = deepcopy(owner['board'])
        barrier['items'] = []
        barrier['snapshots'] = []
        barrier['selectedSnapshot'] = -1
        rpc.send('updateCurrentPedalboard', {'clientId': -1, 'pedalboard': barrier})
        rpc.request('currentPedalboard')
        rpc.send('updateCurrentPedalboard', {'clientId': -1, 'pedalboard': owner['board']})
    observed(rpc, next(item['instanceId'] for item in owner['board']['items'] if item['uri'] == PLUGIN))
    restored = rpc.request('currentPedalboard')
    restored_params = parameters(state(restored)[1])
    for key, wanted in parameters(state(owner['board'])[1]).items():
        assert math.isclose(restored_params[key], wanted, rel_tol=1e-5, abs_tol=1e-4), key
    assert restored['snapshots'] == owner['board']['snapshots']
    assert rpc.request('getPresets')['presetChanged'] == owner['presets']['presetChanged']
    assert assets(restored) == assets(owner['board'])
    assert rpc.request('getJackServerSettings') == owner['audio']
    write_private(output, 'operations-restored.json', restored)
    write_private(output, 'operations-restore-result.json', {'owner_dirty_flag_preserved': True,
        'owner_assets_preserved': True, 'owner_selection_restored': True, 'test_clone_deleted': True,
        'profiles_restored': True, 'audio_config_unchanged': True})


def main():
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [3.14]"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('exercise', 'follow', 'restore'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    assert args.output.is_absolute() and args.output.is_dir() and not args.output.is_symlink()
    os.umask(0o077)
    with PiPedalRpc(timeout=30) as rpc:
        {'exercise': run, 'follow': follow, 'restore': restore}[args.phase](rpc, args.output)
    print(json.dumps({'phase': args.phase, 'passed': True}))


if __name__ == '__main__':
    main()
