#!/usr/bin/env python3
"""Private verified snapshots and safe staging restore; no in-place deployment."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile


def hash_stream(stream):
    """Digest private payloads without printing their contents.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [5.3]
    """
    result = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        result.update(block)
    return result.hexdigest()


def archive_inventory(archive):
    """Inspect every member and digest payload without following symlinks.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [5.3]
    """
    entries = []
    with tarfile.open(archive, "r:gz") as tar:
        names = set()
        links = set()
        for member in tar:
            name = PurePosixPath(member.name)
            if (name.is_absolute() or not name.parts or ".." in name.parts
                    or name.as_posix() != member.name.rstrip("/") or member.name in names):
                raise ValueError(f"Unsafe/duplicate archive path: {member.name}")
            if any(parent.as_posix() in links for parent in name.parents):
                raise ValueError(f"Archive traverses symlink: {member.name}")
            names.add(member.name)
            entry = {"name": member.name, "mode": member.mode, "uid": member.uid,
                     "gid": member.gid, "size": member.size, "mtime": member.mtime}
            if member.isfile():
                entry.update(kind="file", sha256=hash_stream(tar.extractfile(member)))
            elif member.isdir():
                entry.update(kind="directory")
            elif member.issym():
                # Restoring absolute/outside links would let later writes escape.
                target = PurePosixPath(member.linkname)
                if target.is_absolute() or ".." in target.parts:
                    raise ValueError(f"External symlink cannot be safely staged: {member.name}")
                links.add(member.name)
                entry.update(kind="symlink", target=member.linkname)
            else:
                raise ValueError(f"Unsupported archive member: {member.name}")
            entries.append(entry)
    return entries


def backup(roots, output, service):
    """Snapshot explicit roots only while the selected service is inactive.

    Existing files and installed packages are never changed. Add the exact
    previous .deb/plugin archive explicitly; this is not package rollback.
    POSIX mode/uid/gid/mtime retained; ACL/xattr capture is unsupported.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-10] [NFR-6] [DES-SEC] [5.3]
    """
    result = subprocess.run(["systemctl", "show", service, "--property=ActiveState", "--value"],
                            capture_output=True, text=True, timeout=15)
    if result.returncode or result.stdout.strip() != "inactive":
        raise ValueError("Backup requires an existing inactive service; stop it explicitly first")
    requested = [Path(root) for root in roots]
    if not requested or any(not root.exists() or root.is_symlink() for root in requested):
        raise ValueError("Every root must exist and must not itself be a symlink")
    selected = [root.resolve() for root in requested]
    if any(root == Path("/") for root in selected):
        raise ValueError("Whole-device backups are outside this helper")
    for index, root in enumerate(selected):
        if any(root == other or root in other.parents or other in root.parents
               for other in selected[index + 1:]):
            raise ValueError("Backup roots must be distinct and nonoverlapping")
    output = Path(output).resolve()
    if any((parent / ".git").exists() for parent in (output, *output.parents)):
        raise ValueError("Private backups must be outside Git working trees")
    if any(root == output or root in output.parents for root in selected):
        raise ValueError("Backup output cannot be inside a source root")
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    try:
        archive = output / "state.tar.gz"
        with tarfile.open(archive, "w:gz", dereference=False) as tar:
            for root in selected:
                tar.add(root, arcname=str(root).lstrip("/"))
        os.chmod(archive, 0o600)
        members = archive_inventory(archive)
        check = subprocess.run(["systemctl", "show", service, "--property=ActiveState", "--value"],
                               capture_output=True, text=True, timeout=15)
        if check.returncode or check.stdout.strip() != "inactive":
            raise ValueError("Service did not remain inactive throughout capture")
        with archive.open("rb") as stream:
            digest = hash_stream(stream)
        manifest = {"timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                    "consistency": f"{service} inactive before snapshot; caller must keep it inactive",
                    "roots": [str(root) for root in selected], "archive_sha256": digest,
                    "members": members, "acl_xattr_preserved": False}
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        os.chmod(output / "manifest.json", 0o600)
    except Exception:
        # Keep failed capture for inspection; it must never be claimed verified.
        (output / "INCOMPLETE").touch(mode=0o600)
        raise
    return {"backup_directory": str(output), "archive_sha256": digest,
            "member_count": len(members), "installed_state_changed": False}


def stage_restore(backup_directory, destination):
    """Verify snapshot and extract to a new directory, retaining original owners.

    Root is needed for root-owned metadata. Device deployment/package rollback
    stays an explicit operator action after stopping the service.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-10] [DES-SEC] [DES-ROLLOUT] [5.3]
    """
    backup_directory = Path(backup_directory)
    if (backup_directory / "INCOMPLETE").exists():
        raise ValueError("Snapshot was not completed")
    archive = backup_directory / "state.tar.gz"
    manifest = json.loads((backup_directory / "manifest.json").read_text())
    with archive.open("rb") as stream:
        if hash_stream(stream) != manifest["archive_sha256"]:
            raise ValueError("Archive digest mismatch")
    members = archive_inventory(archive)
    if members != manifest["members"]:
        raise ValueError("Archive inventory differs from manifest")
    # Check all ancestors against all symlinks, independent of archive ordering.
    links = {entry["name"] for entry in members if entry["kind"] == "symlink"}
    if any(any(parent.as_posix() in links for parent in PurePosixPath(entry["name"]).parents)
           for entry in members):
        raise ValueError("Archive member traverses a symlink")
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    try:
        with tarfile.open(archive, "r:gz") as tar:
            # Paths/links/types were explicitly checked above on every member.
            # fully_trusted retains ownership after those checks on Python >=3.12.
            kwargs = {"filter": "fully_trusted"} if hasattr(tarfile, "data_filter") else {}
            tar.extractall(destination, numeric_owner=True, **kwargs)
        for entry in members:
            path = destination / entry["name"]
            if entry["kind"] == "file":
                with path.open("rb") as stream:
                    if hash_stream(stream) != entry["sha256"]:
                        raise ValueError(f"Restored digest mismatch: {entry['name']}")
            elif entry["kind"] == "symlink" and os.readlink(path) != entry["target"]:
                raise ValueError(f"Restored link mismatch: {entry['name']}")
            stat = path.lstat()
            if stat.st_uid != entry["uid"] or stat.st_gid != entry["gid"]:
                raise ValueError(f"Restored owner mismatch; run as root: {entry['name']}")
            if entry["kind"] != "symlink" and stat.st_mode & 0o7777 != entry["mode"]:
                raise ValueError(f"Restored mode mismatch: {entry['name']}")
    except Exception:
        (destination / "INCOMPLETE").touch(mode=0o600)
        raise
    return {"restored_staging_directory": str(destination.absolute()),
            "verified_members": len(members), "installed_state_changed": False,
            "package_rollback_proven": False}


def main(argv=None):
    """CLI backups must be private and separate from source repositories.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FILES] [5.3]
    """
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    save = sub.add_parser("backup")
    save.add_argument("--root", type=Path, action="append", required=True,
                      help="Repeat for state/config/plugin/overrides/exact prior package")
    save.add_argument("--output", type=Path, required=True, help="New private backup directory")
    save.add_argument("--service", default="pipedald.service")
    restore = sub.add_parser("stage-restore")
    restore.add_argument("--backup", type=Path, required=True)
    restore.add_argument("--destination", type=Path, required=True, help="Fresh staging directory; no in-place restore")
    args = parser.parse_args(argv)
    try:
        result = backup(args.root, args.output, args.service) if args.command == "backup" else stage_restore(args.backup, args.destination)
        print(json.dumps(result, indent=2))
    except (OSError, ValueError, KeyError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(f"backup: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
