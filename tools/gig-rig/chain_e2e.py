#!/usr/bin/env python3
"""Qualify inline block navigation/Apply/Save on one disposable Pi-local rig.

Prepare temporarily changes test audio. Verify/restore refuse concurrent edits;
private baseline evidence stays on the authorized Pi.
"""
import argparse
from copy import deepcopy
import json
import math
import os
from pathlib import Path
from build_bank import default_item
from library_e2e import payload
from operations_e2e import assets, observed
from pipedal_rpc import PiPedalRpc
from qualification import download_saved, write_private
from state_summary import PLUGIN


def prepare(rpc, output, source="bogner"):
    """Preserve a clean owner rig before adding a disposable prefix/T3K/suffix.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15]
    """
    owner = {key: rpc.request(method) for key, method in (
        ('board', 'currentPedalboard'), ('banks', 'getBankIndex'), ('presets', 'getPresets'),
        ('audio', 'getJackServerSettings'), ('defaults', 'getTone3000Defaults'))}
    assert not owner['presets']['presetChanged'], 'Owner has unsaved work; do not switch'
    tone = next(item for item in owner['board']['items'] if item['uri'] == PLUGIN)
    owner['current'] = observed(rpc, tone['instanceId'])
    owner['board'] = rpc.request('currentPedalboard')
    write_private(output, 'chain-owner.json', owner)
    library = rpc.request('getTone3000Library')
    entry = next(e for e in library['entries'] if source.lower() in e['name'].lower() and 'factory' in e['source'].lower())
    target = rpc.request('importTone3000Preset', payload(entry, as_new=True))
    write_private(output, 'chain-target.json', target)
    assert rpc.request('currentPedalboard') == owner['board'], 'Concurrent owner edit; leave clone unloaded'
    assert rpc.request('getPresets')['selectedInstanceId'] == owner['presets']['selectedInstanceId']
    rpc.request('loadTone3000Preset', {key: target[key] for key in ('bankId', 'presetId')})
    observed(rpc, target['instanceId'])
    board = rpc.request('currentPedalboard')
    plugins = rpc.request('plugins')
    start = max(board['nextInstanceId'], *(i['instanceId'] for i in board['items'])) + 1
    tuner = next(p for p in plugins if p['uri'] == 'http://two-play.com/plugins/toob-tuner')
    delay = next(p for p in plugins if p['uri'] == 'http://two-play.com/plugins/toob-delay')
    board['items'] = [default_item(tuner, start, tuner=True), *board['items'], default_item(delay, start + 1)]
    board['nextInstanceId'] = start + 2
    rpc.send('updateCurrentPedalboard', {'clientId': -1, 'pedalboard': board})
    current = observed(rpc, target['instanceId'])
    rpc.send('saveCurrentPreset')
    assert not rpc.request('getPresets')['presetChanged']
    write_private(output, 'chain-before.json', {'board': rpc.request('currentPedalboard'), 'current': current})
    print(json.dumps({'prepared': True, 'test_preset': target['presetId'], 'instance': target['instanceId']}))


def verify(rpc, output):
    """Check actual browser Apply/Save, independent assets and surrounding effects.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [FR-15] [DES-OPERATE] [3.15]
    """
    target = json.loads((output / 'chain-target.json').read_text())
    baseline = json.loads((output / 'chain-before.json').read_text())
    assert rpc.request('getBankIndex')['selectedBank'] == target['bankId']
    assert rpc.request('getPresets')['selectedInstanceId'] == target['presetId']
    assert not rpc.request('getPresets')['presetChanged'], 'Save not yet observed'
    current = observed(rpc, target['instanceId'])
    original = baseline['current']['summary']
    wanted = deepcopy(original)
    ir = next(block for block in wanted['blocks'] if block['type'] == 'ir')
    ir['mix'] = .99
    for expected, actual in zip(wanted['blocks'], current['summary']['blocks']):
        assert expected['blockId'] == actual['blockId']
        for key in expected:
            if isinstance(expected[key], float):
                assert math.isclose(expected[key], actual[key], abs_tol=1e-5), key
            else:
                assert expected[key] == actual[key], key
    assert {key: value for key, value in wanted.items() if key != 'blocks'} == {key: value for key, value in current['summary'].items() if key != 'blocks'}
    board = rpc.request('currentPedalboard')
    assert assets(board) == assets(baseline['board'])
    assert board['items'][0] == baseline['board']['items'][0]
    assert board['items'][-1] == baseline['board']['items'][-1]
    _, saved = download_saved('ws://127.0.0.1/pipedal', target['presetId'])
    assert assets(saved) == assets(board)
    rpc.request('loadTone3000Preset', {key: target[key] for key in ('bankId', 'presetId')})
    recalled = observed(rpc, target['instanceId'])
    assert recalled['summary'] == current['summary']
    write_private(output, 'chain-last.json', {'board': rpc.request('currentPedalboard'), 'current': recalled})
    write_private(output, 'chain-result.json', {'browser_apply_save_recall': True, 'only_ir_mix_changed': True,
        'assets_preserved': True, 'surrounding_effects_preserved': True})
    print(json.dumps({'verified': True}))


def inspect_stereo(rpc, output):
    """Observe the stereo fixture after view-only browser interaction.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [3.15]
    """
    target = json.loads((output / 'chain-target.json').read_text())
    baseline = json.loads((output / 'chain-before.json').read_text())
    assert rpc.request('getBankIndex')['selectedBank'] == target['bankId']
    assert rpc.request('getPresets')['selectedInstanceId'] == target['presetId']
    assert not rpc.request('getPresets')['presetChanged']
    current = observed(rpc, target['instanceId'])
    assert current['summary']['stereoEnabled']
    assert current['summary'] == baseline['current']['summary']
    board = rpc.request('currentPedalboard')
    assert board == baseline['board']
    write_private(output, 'chain-last.json', {'board': board, 'current': current})
    write_private(output, 'chain-stereo-result.json', {'actual_stereo_summary': True,
        'view_only_board_unchanged': True, 'clean_state': True})
    print(json.dumps({'stereo_verified': True, 'board_unchanged': True}))


def restore(rpc, output):
    """Restore the clean baseline only while the test board remains unchanged.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [DES-ROLLOUT] [3.15]
    """
    owner = json.loads((output / 'chain-owner.json').read_text())
    target = json.loads((output / 'chain-target.json').read_text())
    last = json.loads((output / 'chain-last.json').read_text())
    assert rpc.request('getBankIndex')['selectedBank'] == target['bankId']
    assert rpc.request('getPresets')['selectedInstanceId'] == target['presetId']
    assert not rpc.request('getPresets')['presetChanged']
    assert observed(rpc, target['instanceId']) == last['current'], 'Concurrent rig edits; stop'
    assert rpc.request('currentPedalboard') == last['board'], 'Concurrent host edits; stop'
    assert rpc.request('getTone3000Defaults') == owner['defaults'], 'Concurrent global edits; stop'
    assert rpc.request('getJackServerSettings') == owner['audio'], 'Concurrent audio changes; stop'
    rpc.request('deletePresetItems', [target['presetId']])
    rpc.request('openBank', owner['banks']['selectedBank'])
    rpc.send('loadPreset', owner['presets']['selectedInstanceId'])
    current = observed(rpc, owner['current']['instanceId'])
    assert current['summary'] == owner['current']['summary']
    assert assets(rpc.request('currentPedalboard')) == assets(owner['board'])
    assert not rpc.request('getPresets')['presetChanged']
    assert rpc.request('getPresets')['selectedInstanceId'] == owner['presets']['selectedInstanceId']
    assert rpc.request('getJackServerSettings') == owner['audio']
    assert rpc.request('getTone3000Defaults') == owner['defaults']
    write_private(output, 'chain-restore-result.json', {'owner_restored': True, 'test_clone_deleted': True,
        'audio_defaults_unchanged': True, 'actual_summary_assets_exact': True})
    print(json.dumps({'restored': True}))


def cleanup_inactive(rpc, output):
    """Remove only the untouched inactive fixture without reloading owner audio.

    The normal index API retains live selection and existing saved entries.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [DES-ROLLOUT] [3.15]
    """
    target = json.loads((output / 'chain-target.json').read_text())
    baseline = json.loads((output / 'chain-before.json').read_text())
    before = {key: rpc.request(method) for key, method in (
        ('board', 'currentPedalboard'), ('banks', 'getBankIndex'), ('presets', 'getPresets'),
        ('audio', 'getJackServerSettings'), ('defaults', 'getTone3000Defaults'))}
    assert before['banks']['selectedBank'] == target['bankId']
    assert before['presets']['selectedInstanceId'] != target['presetId'], 'Fixture is active; stop'
    _, saved = download_saved('ws://127.0.0.1/pipedal', target['presetId'])
    fields = ('instanceId', 'uri', 'isEnabled', 'controlValues', 'midiBindings', 'lv2State', 'pathProperties')
    project = lambda board: [{key: item[key] for key in fields} for item in board['items']]
    assert project(saved) == project(baseline['board']), 'Fixture was edited; retain it'
    assert saved['snapshots'] == baseline['board']['snapshots']
    assert saved['name'] == baseline['board']['name'], 'Fixture was renamed; retain it'
    write_private(output, 'chain-cleanup-owner.json', before)
    wanted = deepcopy(before['presets'])
    wanted['presets'] = [entry for entry in wanted['presets'] if entry['instanceId'] != target['presetId']]
    assert len(wanted['presets']) == len(before['presets']['presets']) - 1
    assert rpc.request('getPresets') == before['presets'], 'Concurrent index change; stop'
    assert rpc.request('getBankIndex') == before['banks'], 'Concurrent bank change; stop'
    assert rpc.request('updatePresets', wanted) is True
    after = {key: rpc.request(method) for key, method in (
        ('board', 'currentPedalboard'), ('banks', 'getBankIndex'), ('presets', 'getPresets'),
        ('audio', 'getJackServerSettings'), ('defaults', 'getTone3000Defaults'))}
    write_private(output, 'chain-cleanup-after.json', after)
    assert after['presets']['presets'] == wanted['presets']
    assert after['presets']['selectedInstanceId'] == before['presets']['selectedInstanceId']
    assert after['presets']['presetChanged'] == before['presets']['presetChanged']
    assert all(after[key] == before[key] for key in ('board', 'banks', 'audio', 'defaults'))
    write_private(output, 'chain-cleanup-result.json', {'inactive_fixture_removed': True, 'owner_state_unchanged': True,
        'full_browser_apply_deferred_for_concurrent_owner_use': True})
    print(json.dumps({'inactive_fixture_removed': True, 'owner_state_unchanged': True}))


def main():
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [3.15]"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('prepare', 'verify', 'restore', 'cleanup-inactive', 'inspect-stereo'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source', default='bogner', help='Factory source name for prepare')
    args = parser.parse_args()
    assert args.output.is_absolute() and args.output.is_dir() and not args.output.is_symlink()
    os.umask(0o077)
    with PiPedalRpc(timeout=30) as rpc:
        if args.phase == 'prepare':
            prepare(rpc, args.output, args.source)
        else:
            {'verify': verify, 'restore': restore, 'cleanup-inactive': cleanup_inactive, 'inspect-stereo': inspect_stereo}[args.phase](rpc, args.output)


if __name__ == '__main__':
    main()
