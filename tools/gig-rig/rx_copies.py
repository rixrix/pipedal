#!/usr/bin/env python3
"""Prepare or publish the owner's explicitly approved same-Pi Rx copies/reset.

No audio measurement, synthetic signal or app-global preference writes.
"""
import argparse
import base64
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import pwd
import stat
import subprocess
import tempfile

from pipedal_rpc import PiPedalRpc
from qualification import private_destination, write_private
from gig_rig import read_header
from library_e2e import child, node_bytes, parameters, read_tree, source_inventory, state, value, SESSION

BANK = Path('/var/pipedal/presets/TONE3000+Library.bank')
APP = Path('/home/nam/.config/TONE3000/Presets')
PROFILE = Path('/var/pipedal/home/.config/TONE3000/preferences.settings')
RX = (26, 25, 24, 15, 17, 23)
RESET = (4, 7, 2, 3, 5, 1, 6, 8, 9)


def regular(path, limit=256 * 1024 * 1024):
    """Refuse linked/special/oversized operator inputs.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [7.11]
    """
    path = Path(path).absolute()
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError('Linked operator paths are unsupported')
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
        raise ValueError('Unsupported operator input')
    return path.read_bytes()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def codec(tool, arguments, data):
    result = subprocess.run([str(tool), *arguments], input=data, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError('Bounded native codec refused a target')
    return result.stdout


def prepare(output, tool, native_loader):
    """Validate all targets before preparing a private, hash-guarded transaction.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-EXPORT] [7.11]
    """
    output = private_destination(output)
    with PiPedalRpc() as rpc:
        status = rpc.request('getPresets')
        banks = rpc.request('getBankIndex')
        library = rpc.request('getTone3000Library')
        defaults = rpc.request('getTone3000Defaults')['defaults']
    if banks['selectedBank'] != 6 or status['presetChanged'] or status['selectedInstanceId'] not in RX:
        raise ValueError('Choose a clean saved Rx rig in bank 6 before preparing')
    original = regular(BANK)
    board = json.loads(original)
    ids = [entry['instanceId'] for entry in board['presets']]
    if ids[:6] != list(RX) or set(ids[6:]) != set(RESET) or len(ids) != 15:
        raise ValueError('Owner bank order/identity changed')
    sources = source_inventory([APP, Path('/var/pipedal/home/.config/TONE3000/Presets'), Path('/usr/share/TONE3000/Presets')])
    inventory = [read_header(p) for p in APP.glob('*.t3kpreset')]
    revised = deepcopy(board)
    output.mkdir(mode=0o700)
    write_private(output, 'bank-before.json', original)
    plan = {'bankSha256': sha(original), 'profileSha256': sha(regular(PROFILE)),
            'selectedPreset': status['selectedInstanceId'], 'exports': [], 'sources': []}
    try:
        for entry in revised['presets']:
            ident, preset = entry['instanceId'], entry['preset']
            item, tree = state(preset)
            if any(v.get('instanceId') == item['instanceId'] for s in preset.get('snapshots', []) if s for v in s.get('values', [])):
                raise ValueError('Snapshot overrides need separate review')
            if ident in RX:
                raw_id = f'pipedal-rx-6-{ident}-{item["instanceId"]}'
                label = preset['name'] + ' (PiPedal)'
                filename = f'{raw_id}.t3kpreset'
                if (APP / filename).exists() or any(h['raw_id'] == raw_id or h['name'].casefold() == label.casefold() for h in inventory):
                    raise ValueError('T3K name/identity collision; review existing copy')
                exported = codec(tool, ['export', raw_id, label], json.dumps(item['lv2State'], allow_nan=False).encode())
                converted = read_tree(exported, True)
                if node_bytes(child(converted, 'ChainSnapshot')) != node_bytes(child(tree, 'ChainSnapshot')):
                    raise ValueError('Export changed embedded chain/assets')
                before = parameters(tree)
                observed = {value(p['fields']['id']): value(p['fields']['value']) for p in child(converted, 'Params')['children']}
                if set(observed) != set(before) - SESSION or any(not math.isclose(observed[k], before[k], rel_tol=1e-7, abs_tol=1e-6) for k in observed):
                    raise ValueError('Export changed preset-managed values')
                write_private(output, filename, exported)
                # PresetTool info checks only the header. migrate reads the full
                # native preset body; operate on a private disposable copy.
                verify = output / ('verify-' + str(ident)); verify.mkdir(mode=0o700)
                write_private(verify, filename, exported)
                checked = subprocess.run([str(native_loader), 'migrate', str(verify)], capture_output=True, timeout=30)
                if checked.returncode:
                    raise ValueError('Native T3K loader refused the exported copy')
                verified_files = list(verify.glob('*.t3kpreset'))
                if len(verified_files) != 1:
                    raise ValueError('Native T3K readback produced an ambiguous file list')
                native = read_tree(regular(verified_files[0]), True)
                if node_bytes(child(native, 'ChainSnapshot')) != node_bytes(child(converted, 'ChainSnapshot')) or native != converted:
                    raise ValueError('Native T3K loader changed the exported preset body')
                write_private(output, filename + '.loader.txt', checked.stdout + checked.stderr)
                plan['exports'].append({'file': filename, 'sha256': sha(exported), 'presetId': ident, 'rawId': raw_id, 'name': label})
            else:
                mapped = [(source, imp) for source in library['entries'] for imp in source['imports'] if imp['bankId'] == 6 and imp['presetId'] == ident and imp['instanceId'] == item['instanceId']]
                if len(mapped) != 1:
                    raise ValueError('Missing or ambiguous reset source')
                source, imp = mapped[0]
                path, raw = sources[source['sha256']]
                section = 'factory' if 'factory' in source['source'].lower() else 'user'
                request = {'state': item['lv2State'], 'presetBase64': base64.b64encode(raw).decode(), 'defaults': defaults}
                edited = json.loads(codec(tool, ['reset', path.name, section], json.dumps(request, allow_nan=False).encode()))
                item['lv2State'] = edited
                item['lilvPresetUri'] = ''
                item['stateUpdateCount'] = item.get('stateUpdateCount', 0) + 1
                item['pathProperties'] = {}
                item['tone3000SourceKey'] = source['key']
                item['tone3000SourceHash'] = source['sha256']
                _, actual = state(preset)
                if node_bytes(child(actual, 'ChainSnapshot')) != node_bytes(child(read_tree(raw, True), 'ChainSnapshot')):
                    raise ValueError('Reset changed source chain/assets')
                plan['sources'].append({'path': str(path), 'sha256': source['sha256'], 'presetId': ident})
        # Rx JSON and every other bank field are preserved byte-for-value.
        for before, after in zip(board['presets'], revised['presets']):
            if before['instanceId'] in RX and before != after:
                raise ValueError('Rx changed while preparing reset')
        write_private(output, 'bank-after.json', revised)
        plan['afterSha256'] = sha(regular(output / 'bank-after.json'))
        write_private(output, 'plan.json', plan)
    except Exception:
        raise RuntimeError('Preparation refused; private partial evidence retained') from None
    print(json.dumps({'preparedRx': len(plan['exports']), 'preparedReset': len(plan['sources']), 'selectedPreset': plan['selectedPreset']}))


def atomic(path, data, uid, gid, mode, replace=True):
    fd, name = tempfile.mkstemp(prefix='.rx-publish-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.chown(name, uid, gid); os.chmod(name, mode)
        if replace: os.replace(name, path)
        else:
            # link is an exclusive publication, so an app save racing the
            # earlier collision check is never overwritten by this transaction.
            os.link(name, path, follow_symlinks=False); os.unlink(name)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)


def grant_service_read(path):
    """Allow only the authoring owner and PiPedal service to read this copy.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-EXPORT] [DES-SEC] [7.11]
    """
    subprocess.run(['setfacl', '--set', 'u::rw-,u:pipedal_d:r--,g::---,m::r--,o::---', '--', str(path)],
                   check=True, capture_output=True, timeout=10)
    with path.open('rb') as stream: os.fsync(stream.fileno())


def publish(output):
    """Publish only with stopped service and exact unchanged inputs; rollback on failure.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-EXPORT] [DES-SEC] [7.11]
    """
    if os.geteuid() != 0 or subprocess.run(['systemctl', 'is-active', '--quiet', 'pipedald']).returncode == 0:
        raise ValueError('Publish as root with pipedald stopped after fresh backup')
    plan = json.loads(regular(output / 'plan.json'))
    before, after = regular(output / 'bank-before.json'), regular(output / 'bank-after.json')
    stopped = json.loads(regular(Path('/var/pipedal/currentPreset.json')))
    if stopped.get('modified') is not False or json.loads(regular(BANK))['selectedPreset'] != plan['selectedPreset'] or json.loads(regular(Path('/var/pipedal/presets/index.banks')))['selectedBank'] != 6:
        raise ValueError('Owner changed or left unsaved edits before shutdown; preserve stopped state and prepare again')
    write_private(output, 'stopped-owner-state.json', stopped)
    if sha(before) != plan['bankSha256'] or sha(regular(BANK)) != plan['bankSha256'] or sha(after) != plan['afterSha256'] or sha(regular(PROFILE)) != plan['profileSha256']:
        raise ValueError('Owner bank/profile changed; prepare again')
    for source in plan['sources']:
        if sha(regular(Path(source['path']))) != source['sha256']: raise ValueError('Source changed')
    if sorted(e['presetId'] for e in plan['exports']) != sorted(RX) or sorted(s['presetId'] for s in plan['sources']) != sorted(RESET):
        raise ValueError('Transaction target list changed')
    inventory = [read_header(p) for p in APP.glob('*.t3kpreset')]
    for entry in plan['exports']:
        if Path(entry['file']).name != entry['file'] or (APP / entry['file']).exists() or sha(regular(output / entry['file'])) != entry['sha256'] or any(h['raw_id'] == entry['rawId'] or h['name'].casefold() == entry['name'].casefold() for h in inventory):
            raise ValueError('Export destination/source changed')
    owner, info, published = pwd.getpwnam('nam'), BANK.stat(), []
    try:
        for entry in plan['exports']:
            path = APP / entry['file']; published.append(path)
            atomic(path, regular(output / entry['file']), owner.pw_uid, owner.pw_gid, 0o600, replace=False)
            grant_service_read(path)
        atomic(BANK, after, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))
    except Exception:
        atomic(BANK, before, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))
        for path in published:
            if path.exists():
                expected = next(e['sha256'] for e in plan['exports'] if e['file'] == path.name)
                if sha(regular(path)) == expected: path.unlink()
        raise
    write_private(output, 'published.json', {'bankSha256': sha(after), 'rxExported': 6, 'sourceCopiesReset': 9})
    print('Published six native Rx copies and reset nine mapped Library copies; Rx boards unchanged.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'publish'])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--codec', type=Path)
    parser.add_argument('--native-loader', type=Path)
    args = parser.parse_args()
    if args.action == 'prepare':
        if not args.codec or not args.native_loader: parser.error('prepare needs --codec and --native-loader')
        prepare(args.output, args.codec, args.native_loader)
    else: publish(args.output)


if __name__ == '__main__': main()
