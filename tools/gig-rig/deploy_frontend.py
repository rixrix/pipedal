#!/usr/bin/env python3
"""Publish static frontend files atomically, retaining old assets and audio state.

Run on the Pi as root. --rollback names a prior private deployment directory;
rollback restores its original index first, then overlays its original files.
No service, audio, bank or preset mutation is performed.
@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-UI] [DES-ROLLOUT] [DES-SEC] [2.11]
"""

import argparse
import gzip
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

from performance import Probe, timestamp
from pipedal_rpc import PiPedalRpc
from qualification import private_destination, write_private

TARGET = Path("/etc/pipedal/react")
MAX_FILE = 32 * 1024 * 1024
MAX_TREE = 256 * 1024 * 1024
MAX_FILES = 10000


def real_path(path, directory=True, root_owned=False):
    """Reject symlinks at every existing ancestor and require a real object.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [2.11]
    """
    path = Path(os.path.abspath(path))
    for ancestor in reversed((path, *path.parents)):
        info = ancestor.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("Linked paths are forbidden")
        if ancestor != path and not stat.S_ISDIR(info.st_mode):
            raise ValueError("Non-directory ancestor")
    info = path.lstat()
    wanted = stat.S_ISDIR if directory else stat.S_ISREG
    if not wanted(info.st_mode) or (root_owned and info.st_uid != 0):
        raise ValueError("Unexpected path type or ownership")
    return path


def read_regular(path):
    """Read a bounded nonlinked stable regular file.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [2.11]
    """
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_FILE:
            raise ValueError("Nonregular or oversized frontend file")
        content = stream.read(MAX_FILE + 1)
        after = os.fstat(stream.fileno())
    if (len(content) > MAX_FILE or len(content) != before.st_size
            or (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino)):
        raise ValueError("Frontend file changed while reading")
    return content


def manifest(root, root_owned=False):
    """Bound a complete tree and retain hashes, sizes and original metadata.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [2.11]
    """
    root = real_path(root, root_owned=root_owned)
    result, total, directories = {}, 0, 0
    for directory, names, files in os.walk(root, followlinks=False):
        for name in names:
            real_path(Path(directory) / name, root_owned=root_owned)
            directories += 1
            if directories > MAX_FILES:
                raise ValueError("Too many frontend directories")
        for name in files:
            path = real_path(Path(directory) / name, directory=False, root_owned=root_owned)
            content = read_regular(path)
            info = path.stat()
            total += len(content)
            if total > MAX_TREE or len(result) >= MAX_FILES:
                raise ValueError("Frontend tree exceeds bounds")
            result[path.relative_to(root).as_posix()] = {
                "sha256": hashlib.sha256(content).hexdigest(), "size": len(content),
                "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid,
            }
    return result


class References(HTMLParser):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-UI] [2.11]"""
    def __init__(self):
        super().__init__()
        self.values = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if tag in ("script", "link") and key in ("src", "href") and value:
                self.values.append(value)


def validate_build(source, incoming, target, current):
    """Verify built entry references and every incoming gzip before any write.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-UI] [DES-ROLLOUT] [2.11]
    """
    if "index.html" not in incoming or not incoming["index.html"]["size"]:
        raise ValueError("Nonempty built index.html required")
    if "index.html.gz" in incoming or "index.html.gz" in current:
        raise ValueError("Compressed index publication is outside this helper's contract")
    parser = References()
    parser.feed(read_regular(source / "index.html").decode("utf-8"))
    scripts = 0
    for reference in parser.values:
        parsed = urlsplit(reference)
        path = parsed.path.lstrip("/")
        if path.startswith("assets/"):
            if parsed.scheme or parsed.netloc or ".." in PurePosixPath(path).parts or path not in incoming:
                raise ValueError("Index references a missing or unsafe built asset")
            if path.endswith(".js"):
                if not incoming[path]["size"]:
                    raise ValueError("Empty built JavaScript")
                scripts += 1
    if not scripts:
        raise ValueError("Index must reference nonempty built assets/*.js")
    for name, entry in incoming.items():
        if name.endswith(".gz"):
            base = name[:-3]
            if base not in incoming:
                raise ValueError("Gzip requires its uncompressed file in dist")
            with gzip.open(source / name, "rb") as stream:
                expanded = stream.read(MAX_FILE + 1)
            if len(expanded) > MAX_FILE or hashlib.sha256(expanded).hexdigest() != incoming[base]["sha256"]:
                raise ValueError("Gzip does not match its built file")
        elif name + ".gz" in current and name + ".gz" not in incoming and entry["sha256"] != current.get(name, {}).get("sha256"):
            raise ValueError("Changed file would leave stale served gzip")
        destination = target / name
        for parent in destination.parents:
            if parent == target.parent:
                break
            if parent.exists() or parent.is_symlink():
                real_path(parent)
        if destination.exists() or destination.is_symlink():
            real_path(destination, directory=False)


def atomic_write(target, name, content):
    """Write root-owned 0644 file via sibling temporary and durable rename.

    Existing directories retain their modes; new directories are 0755.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ROLLOUT] [2.11]
    """
    destination = target / name
    missing = []
    parent = destination.parent
    while not parent.exists():
        missing.append(parent)
        parent = parent.parent
    real_path(parent)
    for path in reversed(missing):
        path.mkdir(mode=0o755)
        os.chmod(path, 0o755)
    real_path(destination.parent)
    if destination.exists() or destination.is_symlink():
        real_path(destination, directory=False)
    descriptor, temporary = tempfile.mkstemp(prefix=".frontend-", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o644)
            if os.geteuid() == 0:
                os.fchown(stream.fileno(), 0, 0)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        descriptor = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def backup_tree(target, output, command=subprocess.run):
    """Create private GNU tar backup with ACLs/xattrs before static mutation.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ROLLOUT] [DES-SEC] [2.11]
    """
    archive = output / "frontend-before.tar"
    descriptor = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    command(["tar", "--format=posix", "--acls", "--xattrs", "--numeric-owner", "-cpf", str(archive),
             "-C", str(target.parent), target.name], check=True, capture_output=True, timeout=120)
    with archive.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
        os.fsync(stream.fileno())
    write_private(output, "backup.json", {"path": str(archive), "sha256": digest,
                                          "format": "GNU tar POSIX with numeric owners/ACLs/xattrs"})
    return digest


def status(rpc, probe):
    """Read only service/selection/audio settings; never request private board.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [2.11]
    """
    return {"timestamp": timestamp(), "service": probe.service_status(),
            "bank": rpc.request("getBankIndex").get("selectedBank"),
            "preset": rpc.request("getPresets").get("selectedInstanceId"),
            "audio_settings": rpc.request("getJackServerSettings"),
            "audio": rpc.request("getJackStatus")}


def entry_state(target, incoming, current):
    """Observe entry bytes even if rename succeeded before durability failed.

    This is the current file state, not proof that the failed write is durable.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-UI] [DES-ROLLOUT] [2.11]
    """
    try:
        observed = hashlib.sha256(read_regular(target / "index.html")).hexdigest()
    except Exception as error:
        return {"entry_state": "unknown", "index_published": None,
                "entry_observation_failure_type": type(error).__name__}
    original, wanted = current.get("index.html", {}).get("sha256"), incoming["index.html"]["sha256"]
    if observed == original == wanted:
        state, published = "original_and_incoming", False
    elif observed == wanted:
        state, published = "incoming", True
    elif observed == original:
        state, published = "original", False
    else:
        state, published = "unexpected", None
    return {"entry_state": state, "index_published": published, "observed_index_sha256": observed}


def publish(source, target, output, observe, backup=backup_tree, writer=atomic_write, rollback=False):
    """Prevalidate, retain exact backup, then overlay; entry publishes last.

    Failure is recorded without automatic rollback. User selection may change
    during deployment; observed changes are reported, never overwritten.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-UI] [DES-ROLLOUT] [2.11]
    """
    source, target = real_path(source), real_path(target)
    if source == target or source in target.parents or target in source.parents:
        raise ValueError("Source and served frontend must be separate trees")
    incoming, current = manifest(source), manifest(target)
    validate_build(source, incoming, target, current)
    output.mkdir(mode=0o700)
    write_private(output, "source-manifest.json", incoming)
    write_private(output, "current-manifest.json", current)
    before = observe()
    write_private(output, "status-before.json", before)
    result = {"started_at": timestamp(), "destination": str(target), "written": [],
              "index_published": False, "rollback": rollback, "qualification_passed": False,
              "limits": ["Individual resources update atomically; same-name resources are not one atomic transaction.",
                         "Old assets remain; no service/audio/selection mutation is performed.",
                         "Observed user selection/audio changes are reported rather than undone."]}
    failure = None
    try:
        result["backup_sha256"] = backup(target, output)
        if manifest(target) != current or manifest(source) != incoming:
            raise ValueError("Source or current frontend changed during backup")
        changed = sorted(name for name in incoming if incoming[name]["sha256"] != current.get(name, {}).get("sha256"))
        resources = [name for name in changed if name != "index.html"]
        # Rollback makes original entry visible first, then its exact resources.
        order = (["index.html"] if "index.html" in changed else []) + resources if rollback else resources + (["index.html"] if "index.html" in changed else [])
        for name in order:
            content = read_regular(source / name)
            if hashlib.sha256(content).hexdigest() != incoming[name]["sha256"]:
                raise ValueError("Source file changed after preflight")
            writer(target, name, content)
            result["written"].append(name)
            if name == "index.html":
                result["index_published"] = True
        final = manifest(target)
        if any(final.get(name, {}).get("sha256") != entry["sha256"] for name, entry in incoming.items()):
            raise ValueError("Published frontend hash verification failed")
        write_private(output, "final-manifest.json", final)
        result["published_files_verified"] = True
    except Exception as error:
        failure = error
        result["failure_type"] = type(error).__name__
        result["failure_message"] = str(error)
        result["published_files_verified"] = False
    finally:
        # A writer can replace the entry and then fail its directory fsync.
        # Inspect actual bytes; never infer old-entry safety from a thrown call.
        result.update(entry_state(target, incoming, current))
        try:
            after = observe()
            write_private(output, "status-after.json", after)
            result["observed_changed_fields"] = [key for key in ("service", "bank", "preset", "audio_settings") if before[key] != after[key]]
        except Exception as error:
            result["status_after_failure_type"] = type(error).__name__
            failure = failure or error
        result["finished_at"] = timestamp()
        write_private(output, "result.json", result)
    return result, failure


def main(argv=None):
    """Deploy explicit isolated dist, or restore original files from backup.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FILES] [DES-ROLLOUT] [2.11]
    """
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dist", type=Path)
    group.add_argument("--rollback", type=Path, help="Prior private deploy output directory")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    probe = None
    try:
        if os.geteuid() != 0 or not sys.platform.startswith("linux"):
            raise PermissionError("Run on the Pi as root; destination is fixed")
        target = real_path(TARGET, root_owned=True)
        manifest(target, root_owned=True)
        output = private_destination(args.output)
        with tempfile.TemporaryDirectory(prefix="pipedal-frontend-rollback-") as temporary:
            if args.rollback:
                previous = real_path(args.rollback)
                archive = real_path(previous / "frontend-before.tar", directory=False)
                details = json.loads(read_regular(previous / "backup.json"))
                with archive.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                if digest != details["sha256"]:
                    raise ValueError("Backup archive digest mismatch")
                # Inspect all members before extracting this verified local backup.
                import tarfile
                with tarfile.open(archive) as tar:
                    members = tar.getmembers()
                    if any((not member.isdir() and not member.isfile()) or member.name.startswith("/")
                           or ".." in PurePosixPath(member.name).parts
                           or PurePosixPath(member.name).parts[0] != "react" for member in members):
                        raise ValueError("Unsafe backup member")
                    if len(members) > MAX_FILES * 2 or sum(member.size for member in members) > MAX_TREE:
                        raise ValueError("Oversized backup")
                subprocess.run(["tar", "--acls", "--xattrs", "--numeric-owner", "-xpf", str(archive),
                                "-C", temporary], check=True, capture_output=True, timeout=120)
                source = Path(temporary) / "react"
                if manifest(source) != json.loads(read_regular(previous / "current-manifest.json")):
                    raise ValueError("Restored backup does not match original manifest")
            else:
                source = real_path(args.dist)
                if source.name != "dist" or source.parent.name != "vite":
                    raise ValueError("Explicit isolated vite/dist directory required")
            probe = Probe("ws://127.0.0.1/pipedal", "pipedald.service")
            with PiPedalRpc("ws://127.0.0.1/pipedal", timeout=10) as rpc:
                result, error = publish(source, target, output, lambda: status(rpc, probe), rollback=bool(args.rollback))
            print(json.dumps({key: result.get(key) for key in ("index_published", "entry_state", "published_files_verified", "observed_changed_fields", "failure_type")}))
            return 1 if error else 0
    except Exception as error:
        print("deploy_frontend: " + type(error).__name__ + "; see private evidence if created", file=sys.stderr)
        return 1
    finally:
        if probe:
            probe.close()


if __name__ == "__main__":
    sys.exit(main())
