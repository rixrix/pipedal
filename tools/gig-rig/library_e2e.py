#!/usr/bin/env python3
"""Authorized-device TONE3000 library verification; keeps private evidence on Pi.

Run only on the explicitly approved test device. This changes test audio and
adds managed library entries. It never substitutes for a listening verdict.
"""
import argparse
from copy import deepcopy
import hashlib
import io
import json
import math
import os
from pathlib import Path
import stat
import struct
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
import uuid

from gig_rig import ValueTreeReader
from build_bank import default_item
from pipedal_rpc import PiPedalRpc
from qualification import download_saved, private_destination, write_private
from state_summary import decode_state_string, PLUGIN

# Independent source-pinned Processor.cpp/PitchShift.h values, rather than the
# native converter's table or its converted state. Seven fields are session-only.
DEFAULTS = {
    'inputLevel': .5, 'toneBass': 5, 'toneMid': 5, 'toneTreble': 5,
    'outputLevel': .5, 'gateThreshold': -80, 'targetLoudness': -18,
    'calibrateInput': 0, 'inputCalibrationLevel': 12, 'gateEnabled': 1,
    'toneEqEnabled': 1, 'outputBalance': .5, 'spreadEnabled': 0,
    'spreadOffset': .8125, 'spreadWobble': .25, 'spreadWobbleEnabled': 1,
    'spreadCrossover': .5, 'spreadCrossoverEnabled': 1, 'spreadDiffuseEnabled': 1,
    'alignEnabled': 0, 'alignOffset': .5, 'alignWobble': .25,
    'alignWobbleEnabled': 0, 'alignCrossover': .5, 'alignCrossoverEnabled': 0,
    'alignDiffuseEnabled': 0, 'chainPanLeft': 0, 'chainPanRight': 1,
    'chainPanLinked': 1, 'chainSoloLeft': 0, 'chainSoloRight': 0,
    'chainInvertLeft': 0, 'chainInvertRight': 0, 'osEnabled': 0, 'osFactor': 0,
    'gateRelease': 50, 'gateHold': 20, 'gateRange': 80, 'pitchEnabled': 0,
    'pitchSemitones': 0, 'pitchStep': 1, 'pitchTonality': 20000, 'pitchWindow': 1,
}
SESSION = {'targetLoudness', 'calibrateInput', 'inputCalibrationLevel',
           'chainSoloLeft', 'chainSoloRight', 'osEnabled', 'osFactor'}
LEGACY = {'transpose' + name: 'pitch' + name for name in
          ('Enabled', 'Semitones', 'Step', 'Tonality', 'Window')}


class RawReader(ValueTreeReader):
    """Independent fixture traversal preserving every serialized property byte.

    This reads trusted qualification inputs only; production parsing is native.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]
    """
    def tree(self, expected=None, depth=0):
        self.nodes += 1
        if depth > 64 or self.nodes > 100000:
            raise ValueError('Fixture complexity bound')
        tag = self.string()
        if expected and tag != expected:
            raise ValueError('Unexpected fixture tree')
        count = self.integer()
        if not 0 <= count <= 10000:
            raise ValueError('Fixture property bound')
        fields = {}
        for _ in range(count):
            key = self.string()
            start = self.stream.tell()
            self.variant()
            end = self.stream.tell()
            self.stream.seek(start)
            if key in fields:
                raise ValueError('Duplicate fixture property')
            fields[key] = self.read(end - start)
        count = self.integer()
        if not 0 <= count <= 100000:
            raise ValueError('Fixture child bound')
        return {'tag': tag, 'fields': fields,
                'children': [self.tree(depth=depth + 1) for _ in range(count)]}


def packed(value):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]"""
    body = value.to_bytes((value.bit_length() + 7) // 8, 'little')
    return bytes([len(body)]) + body


def variant(kind, body):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]"""
    return packed(len(body) + 1) + bytes([kind]) + body


def text(value):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]"""
    return variant(5, value.encode() + b'\0')


def number(value):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]"""
    return variant(4, struct.pack('<d', value))


def node_bytes(node):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]"""
    return (node['tag'].encode() + b'\0' + packed(len(node['fields']))
            + b''.join(key.encode() + b'\0' + value for key, value in node['fields'].items())
            + packed(len(node['children'])) + b''.join(map(node_bytes, node['children'])))


def value(raw):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]"""
    stream = io.BytesIO(raw)
    reader = ValueTreeReader(stream, len(raw))
    count = reader.integer()
    data = reader.read(count)
    kind, body = data[0], data[1:]
    if kind == 5:
        return body[:-1].decode()
    if kind == 4:
        return struct.unpack('<d', body)[0]
    if kind == 1:
        return struct.unpack('<i', body)[0]
    if kind in (2, 3):
        return float(kind == 2)
    raise ValueError('Unsupported qualification scalar')


def child(node, tag):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]"""
    matches = [part for part in node['children'] if part['tag'] == tag]
    if len(matches) != 1:
        raise ValueError('Ambiguous qualification tree')
    return matches[0]


def read_tree(raw, preset=False):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]"""
    assert raw[:4] in (b'T3KH', b'T3KB')
    if raw[:4] == b'T3KH':
        assert preset and len(raw) >= 8
        header_length = int.from_bytes(raw[4:8], 'little')
        assert 0 < header_length <= 65536 and header_length <= len(raw) - 8
        offset = 8 + header_length
    else:
        offset = 4
    stream = io.BytesIO(raw)
    stream.seek(offset)
    reader = RawReader(stream, len(raw))
    node = reader.tree('T3KPreset' if preset else 'TONE3000State')
    assert stream.tell() == len(raw)
    return node


def fixture(source, identity, label, output_level):
    """Make a disposable app-save fixture with exact original NAM/IR subtree.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]
    """
    original = read_tree(source.read_bytes(), True)
    kinds = {value(block['fields']['type'])
             for lane in child(original, 'ChainSnapshot')['children'] for block in lane['children']}
    assert {'nam', 'ir'} <= kinds, 'Choose an actual source rig containing NAM and IR'
    body = deepcopy(original)
    body['fields'].update(id=text(identity), name=text(label))
    params = child(body, 'Params')
    target = next((part for part in params['children'] if value(part['fields']['id']) == 'outputLevel'), None)
    assert target is not None
    target['fields']['value'] = number(output_level)
    assert node_bytes(child(body, 'ChainSnapshot')) == node_bytes(child(original, 'ChainSnapshot'))
    header = {'tag': 'T3KPresetHeader', 'fields': {'id': text(identity), 'name': text(label)}, 'children': []}
    raw_header = node_bytes(header)
    return b'T3KH' + struct.pack('<I', len(raw_header)) + raw_header + node_bytes(body)


def state(board):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]"""
    items = [item for item in board['items'] if item.get('uri') == PLUGIN]
    assert len(items) == 1
    item = items[0]
    assert not item.get('lilvPresetUri')
    valid, entries = item['lv2State']
    assert valid and 'https://www.tone3000.com/plugin:Program' not in entries
    entry = entries['https://www.tone3000.com/plugin:StateString']
    assert entry['atomType'] == 'http://lv2plug.in/ns/ext/atom#String' and entry['flags'] == 3
    assert isinstance(entry['value'], str) and '\0' not in entry['value']
    # PiPedal's JSON atom:String uses its string value, with no NUL in JSON.
    tree = read_tree(decode_state_string(entry['value']))
    return item, tree


def parameters(tree):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]"""
    result = {}
    for part in child(tree, 'PARAMETERS')['children']:
        assert part['tag'] == 'PARAM'
        key, number = value(part['fields']['id']), value(part['fields']['value'])
        assert key not in result and key in DEFAULTS and math.isfinite(number)
        result[key] = number
    assert set(result) == set(DEFAULTS)
    return result


def source_expectation(raw, filename, source, sha256):
    """Compare persisted conversion with actual authoring bytes and parameters.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [DES-STATE] [3.10]
    """
    assert hashlib.sha256(raw).hexdigest() == sha256
    tree = read_tree(raw, True)
    raw_id = value(tree['fields']['id']).strip() if 'id' in tree['fields'] else ''
    name = value(tree['fields']['name']) if 'name' in tree['fields'] else ''
    section = 'factory' if source in ('Pi app factory', 'Service factory', 'Installed factory') else 'user'
    expected = dict(DEFAULTS)
    seen = set()
    for part in child(tree, 'Params')['children']:
        assert part['tag'] == 'Param'
        original = value(part['fields']['id'])
        key = LEGACY.get(original, original)
        number = value(part['fields']['value'])
        assert key in DEFAULTS and key not in seen and math.isfinite(number)
        seen.add(key)
        if key not in SESSION:
            expected[key] = number
    chain = node_bytes(child(tree, 'ChainSnapshot'))
    return {'id': section + ':' + (raw_id or Path(filename).stem),
            'name': name or Path(filename).stem, 'sha256': sha256,
            'chain_sha256': hashlib.sha256(chain).hexdigest(), 'chain_bytes': len(chain),
            'parameters': expected}


def source_inventory(roots):
    """Read only explicit preset roots and their known Factory subdirectories.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [DES-SEC] [3.10]
    """
    result = {}
    for root in {directory for base in roots for directory in (base, base / 'Factory')}:
        if not root.exists():
            continue
        assert root.is_dir() and not root.is_symlink()
        for path in root.glob('*.t3kpreset'):
            assert path.is_file() and not path.is_symlink() and path.stat().st_size <= 64 * 1024 * 1024
            raw = path.read_bytes()
            digest = hashlib.sha256(raw).hexdigest()
            result.setdefault(digest, (path, raw))
    return result


def verify_state(board, expected):
    """Check identity, exact embedded chain serialization and source parameters.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [DES-STATE] [3.10]
    """
    item, tree = state(board)
    assert item['tone3000SourceHash'] == expected['sha256']
    assert value(tree['fields']['activePresetId']) == expected['id']
    assert value(tree['fields']['activePresetName']) == expected['name']
    chain = node_bytes(child(tree, 'ChainSnapshot'))
    assert len(chain) == expected['chain_bytes'] and hashlib.sha256(chain).hexdigest() == expected['chain_sha256']
    numbers = parameters(tree)
    for key, wanted in expected['parameters'].items():
        assert math.isclose(numbers[key], wanted, rel_tol=1e-7, abs_tol=1e-6), (key, numbers[key], wanted)
    return item, tree


def payload(entry, target=None, as_new=False):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]"""
    body = {'key': entry['key'], 'sha256': entry['sha256'], 'asNew': as_new}
    if target:
        body.update({key: target[key] for key in ('bankId', 'presetId', 'instanceId')})
        body['expectedImportSha256'] = target['sha256']
    return body


def upload(raw, filename):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]"""
    endpoint = 'http://127.0.0.1/var/uploadTone3000Preset?filename=' + quote(filename, safe='')
    request = Request(endpoint, data=raw, headers={'Content-Type': 'application/octet-stream'})
    try:
        with urlopen(request, timeout=30) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.load(error)


def require_error(rpc, body):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]"""
    try:
        rpc.request('importTone3000Preset', body)
    except RuntimeError as error:
        return str(error)
    raise AssertionError('Invalid import unexpectedly succeeded')


def bank_digests():
    """Compare actual persistent bank bytes around expected failed operations.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [DES-SEC] [3.10]
    """
    root = Path('/var/pipedal/presets')
    assert root.is_dir() and not root.is_symlink()
    result = {}
    for path in root.glob('*.bank'):
        assert path.is_file() and not path.is_symlink() and path.stat().st_size <= 256 * 1024 * 1024
        result[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    assert result
    return result


def guarded_error(rpc, body):
    """An expected rejected import must preserve every persistent bank byte.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.10]
    """
    before = bank_digests()
    error = require_error(rpc, body)
    assert bank_digests() == before
    return error


def recall(rpc, target, output, name, expected_source):
    """Check real numeric reads and saved exports after explicit library Load.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [DES-TEST] [3.10]
    """
    rpc.request('loadTone3000Preset', {key: target[key] for key in ('bankId', 'presetId')})
    board = rpc.request('currentPedalboard')
    item, tree = verify_state(board, expected_source)
    expected = expected_source['parameters']
    assert item['instanceId'] == target['instanceId']
    # Patch Get replies verify plugin restore rather than merely cached JSON.
    for key, wanted in expected.items():
        actual = rpc.request('getPatchProperty', {'instanceId': item['instanceId'], 'propertyUri': PLUGIN + ':' + key})
        assert not isinstance(actual, bool) and isinstance(actual, (int, float))
        assert math.isclose(actual, wanted, rel_tol=1e-5, abs_tol=1e-4), (key, actual, wanted)
    raw, saved = download_saved('ws://127.0.0.1/pipedal', target['presetId'])
    write_private(output, name + '.json', saved)
    write_private(output, name + '.piPreset', raw)
    verify_state(saved, expected_source)
    return saved


def main():
    """Operate only reviewed fixture paths on the authorized Pi test machine.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [3.10]
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prepare', 'recall', 'update'])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--app-root', type=Path)
    parser.add_argument('--preset-root', type=Path, action='append', default=[])
    parser.add_argument('--resume-prepare', action='store_true',
                        help='Resume only a verified nine-import preparation, preserving its original owner evidence')
    args = parser.parse_args()
    os.umask(0o077)
    assert not args.resume_prepare or args.phase == 'prepare'
    if args.phase == 'prepare':
        assert args.source and args.app_root
        assert args.source.is_file() and not args.source.is_symlink()
        assert args.source.suffix == '.t3kpreset' and args.source.stat().st_size <= 64 * 1024 * 1024
        assert args.app_root.is_dir() and not args.app_root.is_symlink()
        # Fail on the actual NAM/IR content and filename before any RPC writes,
        # recovery capture, output creation or app-origin fixture publication.
        fixture(args.source, 'preflight-only', 'Preflight only', .41)
    output = args.output.absolute()
    if args.phase == 'prepare' and not args.resume_prepare:
        output = private_destination(output)
        output.mkdir(mode=0o700)
    else:
        for path in (output, *output.parents):
            assert stat.S_ISDIR(path.lstat().st_mode) and not (path / '.git').exists()
        assert stat.S_IMODE(output.stat().st_mode) == 0o700
    with PiPedalRpc(timeout=60) as rpc:
        if args.phase == 'prepare':
            before = rpc.request('getTone3000Library')
            assert len(before['entries']) == 9 and not before['warnings'], before['warnings']
            inventory = source_inventory([args.app_root, args.source.parent, *args.preset_root])
            # Resolve every source before the first Add, rather than failing
            # midway through preparation when a supplied source root is wrong.
            expectations = {}
            for entry in before['entries']:
                path, original_bytes = inventory[entry['sha256']]
                expectations[entry['key']] = source_expectation(original_bytes, path.name, entry['source'], entry['sha256'])
            if args.resume_prepare:
                for filename in ('owner-board.json', 'owner-banks.json', 'owner-presets.json', 'added.json'):
                    path = output / filename
                    assert path.is_file() and not path.is_symlink() and stat.S_IMODE(path.stat().st_mode) == 0o600
                assert not any((output / name).exists() for name in ('fixture.json', 'uploaded.json', 'prepare-result.json'))
                original_bank = json.loads((output / 'owner-banks.json').read_text())
                added = json.loads((output / 'added.json').read_text())
                assert len(added) == 9 and len({record['entry']['key'] for record in added}) == 9
                current_entries = {entry['key']: entry for entry in before['entries']}
                for record in added:
                    entry = current_entries[record['entry']['key']]
                    assert entry['sha256'] == record['entry']['sha256']
                    assert record['expected'] == expectations[entry['key']]
                    assert len(entry['imports']) == 1
                    mapped = entry['imports'][0]
                    assert {key: mapped[key] for key in ('bankId', 'presetId', 'instanceId')} == record['target']
                    assert mapped['sha256'] == entry['sha256']
            else:
                for label, request in [('owner-board', 'currentPedalboard'), ('owner-banks', 'getBankIndex'), ('owner-presets', 'getPresets')]:
                    write_private(output, label + '.json', rpc.request(request))
                original_bank = json.loads((output / 'owner-banks.json').read_text())
                added = []
                for entry in before['entries']:
                    target = rpc.request('importTone3000Preset', payload(entry))
                    assert rpc.request('importTone3000Preset', payload(entry)) == target
                    added.append({'entry': entry, 'target': target, 'expected': expectations[entry['key']]})
            after = rpc.request('getBankIndex')
            assert after['entries'][:-1] == original_bank['entries']
            assert after['selectedBank'] == original_bank['selectedBank']
            assert rpc.request('currentPedalboard') == json.loads((output / 'owner-board.json').read_text())
            if not args.resume_prepare:
                write_private(output, 'added.json', added)
            token = 'pipedal-e2e-' + uuid.uuid4().hex
            filename = token + '.t3kpreset'
            raw = fixture(args.source, token, 'Library E2E NAM + IR', .41)
            # Actual app-style sibling-temp rename exercises default ACL inheritance.
            temporary = args.app_root / (token + '.tmp')
            with temporary.open('xb') as stream:
                stream.write(raw)
            # App uses normal 0666 creation. Explicitly emulate it despite private evidence umask.
            temporary.chmod(0o644)
            destination = args.app_root / filename
            temporary.replace(destination)
            write_private(output, filename, raw)
            found = rpc.request('getTone3000Library')
            entry = next(entry for entry in found['entries'] if entry['name'] == 'Library E2E NAM + IR')
            target = rpc.request('importTone3000Preset', payload(entry))
            assert upload(raw, filename) == (200, {**entry, 'imports': []})
            upload_identity = token + '-upload'
            upload_filename = upload_identity + '.t3kpreset'
            uploaded_bytes = fixture(args.source, upload_identity, 'Library E2E uploaded NAM + IR', .47)
            code, uploaded_entry = upload(uploaded_bytes, upload_filename)
            assert code == 200 and uploaded_entry['source'] == 'Uploaded' and uploaded_entry['imports'] == []
            assert uploaded_entry['key'].startswith('uploaded:')
            assert upload(uploaded_bytes, upload_filename) == (200, uploaded_entry)
            uploaded_target = rpc.request('importTone3000Preset', payload(uploaded_entry))
            assert rpc.request('importTone3000Preset', payload(uploaded_entry)) == uploaded_target
            copy_target = rpc.request('importTone3000Preset', payload(uploaded_entry, as_new=True))
            assert copy_target['bankId'] == uploaded_target['bankId'] and copy_target['presetId'] != uploaded_target['presetId']
            uploaded_expected = source_expectation(uploaded_bytes, upload_filename, 'Uploaded', uploaded_entry['sha256'])
            write_private(output, upload_filename, uploaded_bytes)
            write_private(output, 'uploaded.json', {'entry': uploaded_entry, 'targets': [uploaded_target, copy_target], 'expected': uploaded_expected})
            # Prepare must still leave running audio and selection unchanged.
            assert rpc.request('currentPedalboard') == json.loads((output / 'owner-board.json').read_text())
            assert rpc.request('getBankIndex')['selectedBank'] == original_bank['selectedBank']
            invalid = []
            before_failure = bank_digests()
            for data, name in [(b'T3KBbroken', 'broken.t3kpreset'), (raw, '../escape.t3kpreset'), (raw[:-1], 'truncated.t3kpreset')]:
                code, body = upload(data, name)
                assert code == 400 and body.get('error')
                invalid.append({'status': code, 'error': body['error']})
            assert bank_digests() == before_failure
            expected_source = source_expectation(raw, filename, entry['source'], entry['sha256'])
            write_private(output, 'fixture.json', {'filename': filename, 'path': str(destination), 'identity': token, 'source': str(args.source), 'entry': entry, 'target': target, 'expected': expected_source})
            write_private(output, 'prepare-result.json', {'discovered': 9, 'added': 9, 'idempotent_add': True, 'selection_unchanged': True, 'app_atomic_save_discovered': True, 'identical_upload_reused': True, 'distinct_upload_published': True, 'add_as_new_unique_preset': True, 'invalid_uploads': invalid, 'failure_bank_bytes_unchanged': True})
            print('Prepared: nine real rigs, stable Add, app-save and uploaded fixtures, Add as new, invalid HTTP refusal')
        elif args.phase == 'recall':
            added = json.loads((output / 'added.json').read_text())
            for record in added:
                name = 'recall-' + str(record['target']['presetId'])
                recall(rpc, record['target'], output, name, record['expected'])
            uploaded = json.loads((output / 'uploaded.json').read_text())
            for target in uploaded['targets']:
                recall(rpc, target, output, 'recall-upload-' + str(target['presetId']), uploaded['expected'])
            fixture_data = json.loads((output / 'fixture.json').read_text())
            recall(rpc, fixture_data['target'], output, 'fixture-before', fixture_data['expected'])
            write_private(output, 'recall-result.json', {'rigs': len(added) + len(uploaded['targets']) + 1, 'numeric_reads_per_rig': 43, 'source_parameters_verified': True, 'exact_source_chain_bytes_verified': True, 'saved_exports_verified': True})
            print('Recall: twelve entries, all 43 real numeric reads, source parameters/chain bytes and saved exports passed')
        else:
            data = json.loads((output / 'fixture.json').read_text())
            destination = Path(data['path'])
            target = data['target']
            old_entry = data['entry']
            # Leave source exactly the same except an actual managed parameter change.
            changed = fixture(Path(data['source']), data['identity'], old_entry['name'], .63)
            temporary = destination.with_suffix('.tmp')
            with temporary.open('xb') as stream:
                stream.write(changed)
            temporary.chmod(0o644)
            temporary.replace(destination)
            found = rpc.request('getTone3000Library')
            entry = next(entry for entry in found['entries'] if entry['key'] == old_entry['key'])
            assert entry['sha256'] != old_entry['sha256'] and len(entry['imports']) == 1
            mapped = entry['imports'][0]
            stale_error = guarded_error(rpc, payload(old_entry, mapped))
            stale_target = {**mapped, 'sha256': '0' * 64}
            stale_target_error = guarded_error(rpc, payload(entry, stale_target))
            board = rpc.request('currentPedalboard')
            assert state(board)[0]['instanceId'] == target['instanceId']
            rpc.request('setPatchProperty', {'instanceId': target['instanceId'], 'propertyUri': PLUGIN + ':targetLoudness', 'value': -20})
            dirty_error = guarded_error(rpc, payload(entry, mapped))
            rpc.send('saveCurrentPreset')
            rpc.request('currentPedalboard')
            # Compose the disposable imported board using discovered real
            # metadata and the exact native SnapshotValue JSON schema.
            composed = rpc.request('currentPedalboard')
            tone_item = state(composed)[0]
            matches = [plugin for plugin in rpc.request('plugins')
                       if plugin.get('uri') == 'http://two-play.com/plugins/toob-delay']
            assert len(matches) == 1
            effect_id = max(composed.get('nextInstanceId', 0),
                            *(item['instanceId'] for item in composed['items'])) + 1
            effect = default_item(matches[0], effect_id)
            composed['items'].append(effect)
            composed['nextInstanceId'] = effect_id + 1
            snapshot_fields = ('instanceId', 'isEnabled', 'controlValues', 'lv2State', 'pathProperties')
            composed['snapshots'] = [{'name': 'Library E2E saved override', 'color': '#4caf50',
                                      'isModified': False, 'values': [
                                          {key: deepcopy(item[key]) for key in snapshot_fields}
                                          for item in (tone_item, effect)]}]
            composed['selectedSnapshot'] = -1
            rpc.send('updateCurrentPedalboard', {'clientId': -1, 'pedalboard': composed})
            rpc.request('currentPedalboard')
            rpc.send('saveCurrentPreset')
            rpc.request('currentPedalboard')
            baseline_raw, baseline = download_saved('ws://127.0.0.1/pipedal', target['presetId'])
            write_private(output, 'fixture-composition-before.piPreset', baseline_raw)
            write_private(output, 'fixture-composition-before.json', baseline)
            assert len(baseline['items']) == 2 and baseline['selectedSnapshot'] == -1
            assert baseline['snapshots'][0]['values'][0]['instanceId'] == target['instanceId']
            assert math.isclose(parameters(state(baseline)[1])['targetLoudness'], -20, abs_tol=1e-5)
            preserved_effects = [item for item in baseline['items'] if item['uri'] != PLUGIN]
            preserved_order = [item['instanceId'] for item in baseline['items']]
            mapped = next(entry for entry in rpc.request('getTone3000Library')['entries'] if entry['key'] == old_entry['key'])['imports'][0]
            assert mapped['hasSnapshotOverrides'] is True
            assert rpc.request('importTone3000Preset', payload(entry, mapped)) == target
            expected_source = source_expectation(changed, destination.name, entry['source'], entry['sha256'])
            expected_source['parameters']['targetLoudness'] = -20
            updated = recall(rpc, target, output, 'fixture-updated', expected_source)
            numbers = parameters(state(updated)[1])
            assert math.isclose(numbers['outputLevel'], .63, abs_tol=1e-5)
            assert math.isclose(numbers['targetLoudness'], -20, abs_tol=1e-5)
            assert state(updated)[0]['tone3000SourceHash'] == entry['sha256']
            assert updated['snapshots'] == baseline['snapshots']
            assert updated['selectedSnapshot'] == baseline['selectedSnapshot']
            assert [item['instanceId'] for item in updated['items']] == preserved_order
            assert [item for item in updated['items'] if item['uri'] != PLUGIN] == preserved_effects
            mapped = next(entry for entry in rpc.request('getTone3000Library')['entries']
                          if entry['key'] == old_entry['key'])['imports'][0]
            assert mapped['hasSnapshotOverrides'] is True
            write_private(output, 'update-result.json', {'stale_source_rejected': stale_error, 'stale_target_rejected': stale_target_error, 'dirty_active_rejected': dirty_error, 'failure_bank_bytes_unchanged': True, 'stable_ids': target, 'active_update_loaded': True, 'session_value_preserved': True, 'new_output_value_recalled': True, 'other_effect_exactly_preserved': True, 'snapshot_exactly_preserved': True, 'snapshot_override_disclosed': True, 'item_order_and_ids_preserved': True})
            print('Update: stale/dirty refusal, stable IDs/order, active reload, session, delay and snapshot preservation passed')


if __name__ == '__main__':
    main()
