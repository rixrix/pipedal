#!/usr/bin/env python3
"""Install an exact verified host package and reuse the existing TONE3000 data."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile

import gig_rig


def sha256(path):
    """Record exact artifacts without printing payloads.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [NFR-6] [DES-SEC] [5.3]
    """
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_tree(path, presets=False):
    """Reject links/special files before copying; never copy app credentials.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [2.4] [3.2]
    """
    if path.is_symlink() or not path.is_dir():
        raise ValueError(f"Expected real directory: {path}")
    for entry in path.rglob("*"):
        if entry.is_symlink() or not (entry.is_dir() or entry.is_file()):
            raise ValueError(f"Unsupported source link/special file: {entry}")
        if presets:
            relative = entry.relative_to(path)
            if entry.is_dir():
                allowed = relative.parts == ("Factory",)
            else:
                allowed = ((len(relative.parts) == 1 or relative.parts[:-1] == ("Factory",))
                           and relative.suffix == ".t3kpreset") or relative.parts == ("order.json",)
            if not allowed:
                raise ValueError(f"Unexpected file in preset source (never copy app settings/tokens): {entry}")


def check_destination(path):
    """Refuse existing paths, dangling links and redirected destination parents.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [2.4] [3.2]
    """
    if os.path.lexists(path):
        raise ValueError(f"Destination exists; preserve/reconcile before separate replacement: {path}")
    for parent in path.parents:
        if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
            raise ValueError(f"Destination ancestor is not a real directory: {parent}")


def validate(args):
    """Validate exact artifacts before any package or service mutation.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-10] [DES-DEPS] [1.5] [2.4]
    """
    if args.package.is_symlink() or not args.package.is_file():
        raise ValueError("Expected a regular package file")
    check_tree(args.bundle)
    check_tree(args.presets, presets=True)
    if args.manifest.is_symlink() or not args.manifest.is_file():
        raise ValueError("Expected a regular staged manifest file")
    if sha256(args.package) != args.package_sha256:
        raise ValueError("Package checksum mismatch")
    if sha256(args.bundle / "libTONE3000.so") != args.binary_sha256:
        raise ValueError("Plugin binary checksum mismatch")
    fields = subprocess.check_output(["dpkg-deb", "--field", str(args.package),
                                      "Package", "Version", "Architecture"], text=True)
    values = dict(line.split(": ", 1) for line in fields.splitlines())
    arch = subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip()
    if values.get("Package") != "pipedal" or values.get("Architecture") != arch or not values.get("Version"):
        raise ValueError("Package identity/architecture mismatch")
    if not (args.presets / "Factory").is_dir():
        raise ValueError("Expected source factory preset directory")
    report = gig_rig.inventory(args.presets, args.system_factory)
    if report["count"] > 128:
        raise ValueError("More than 128 rigs cannot be installed with this manifest")
    labels = gig_rig.manifest_matches(args.manifest.read_text(encoding="utf-8"))
    for match in labels:
        program = int(match["program"])
        wanted = report["presets"][program]["name"] if program < report["count"] else "(empty)"
        if match["label"] != gig_rig.turtle_string(wanted):
            raise ValueError("Staged labels do not match source preset ordering")
    destination = Path("/usr/local/lib/lv2/TONE3000.lv2")
    check_destination(destination)
    user = pwd.getpwnam("pipedal_d")
    target_presets = Path(user.pw_dir) / ".config/TONE3000/Presets"
    check_destination(target_presets)
    return values, destination, user, target_presets


def install(args):
    """Perform the approved initial deployment; preserve app-user files/presets.

    Requires an already verified off-device baseline backup. Repeated invocation
    refuses existing service data rather than overwriting it. Recovery uses the
    separately retained exact package and consistent baseline state archive.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ROLLOUT] [DES-SEC] [1.5] [2.4] [3.2]
    """
    if os.geteuid() != 0:
        raise PermissionError("Run as root after verifying the baseline backup")
    values, destination, user, target_presets = validate(args)
    # Build complete adjacent staging trees before any package/service mutation.
    destination.parent.mkdir(parents=True, exist_ok=True)
    target_presets.parent.mkdir(parents=True, exist_ok=True)
    bundle_staging = Path(tempfile.mkdtemp(prefix=".TONE3000-stage-", dir=destination.parent))
    preset_staging = Path(tempfile.mkdtemp(prefix=".Presets-stage-", dir=target_presets.parent))
    package_mutation_started = False
    try:
        shutil.copytree(args.bundle, bundle_staging, dirs_exist_ok=True, symlinks=True)
        shutil.copy2(args.manifest, bundle_staging / "manifest.ttl", follow_symlinks=False)
        check_tree(bundle_staging)
        for path in [bundle_staging, *bundle_staging.rglob("*")]:
            os.chown(path, 0, 0)
            path.chmod(0o755 if path.is_dir() else 0o644)
        shutil.copytree(args.presets, preset_staging, dirs_exist_ok=True, symlinks=True)
        check_tree(preset_staging, presets=True)
        for path in [preset_staging, *preset_staging.rglob("*")]:
            os.chown(path, user.pw_uid, user.pw_gid)
            path.chmod(0o700 if path.is_dir() else 0o600)
        if sha256(bundle_staging / "libTONE3000.so") != args.binary_sha256:
            raise ValueError("Staged binary checksum mismatch")
        if sha256(bundle_staging / "manifest.ttl") != sha256(args.manifest):
            raise ValueError("Staged manifest checksum mismatch")
        original = gig_rig.inventory(args.presets, args.system_factory)
        copied = gig_rig.inventory(preset_staging, args.system_factory)
        keys = ("id", "name", "section", "sha256")
        if ([[entry[key] for key in keys] for entry in copied["presets"]]
                != [[entry[key] for key in keys] for entry in original["presets"]]
                or copied["order_sha256"] != original["order_sha256"]):
            raise ValueError("Presets changed while staging")
        # Revalidate source identity/labels and destination before deployment.
        validate(args)
        subprocess.run(["systemctl", "stop", "pipedald"], check=True)
        package_mutation_started = True
        env = dict(os.environ, DEBIAN_FRONTEND="noninteractive")
        subprocess.run(["apt-get", "install", "-y", "--reinstall", str(args.package.resolve())],
                       env=env, check=True)
        # Package maintainer scripts may start the daemon; stop before promotion.
        subprocess.run(["systemctl", "stop", "pipedald"], check=True)
        check_destination(destination)
        check_destination(target_presets)
        os.chown(target_presets.parent, user.pw_uid, user.pw_gid)
        target_presets.parent.chmod(0o700)
        bundle_staging.rename(destination)
        preset_staging.rename(target_presets)
        subprocess.run(["systemctl", "start", "pipedald"], check=True)
    except Exception:
        if package_mutation_started:
            # Preserve both staged/promoted data and the original exception.
            # Never start a host against a partial deployment or claim rollback.
            try:
                subprocess.run(["systemctl", "stop", "pipedald"], check=False)
            except OSError as error:
                print(f"Could not stop daemon after deployment failure: {error}", file=sys.stderr)
        print(f"Deployment incomplete; retained artifacts at {bundle_staging} and {preset_staging}; "
              f"package mutation started={package_mutation_started}. Inspect and recover from verified baseline.",
              file=sys.stderr)
        raise
    print(json.dumps({"package": str(args.package.resolve()), "package_sha256": args.package_sha256,
                      "package_fields": values, "bundle": str(destination),
                      "binary_sha256": args.binary_sha256,
                      "manifest_sha256": sha256(destination / "manifest.ttl"),
                      "presets": str(target_presets)}, indent=2))


def main():
    """Accept explicit artifact paths/digests rather than wildcard packages.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FILES] [5.3]
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--package-sha256", required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--binary-sha256", required=True)
    parser.add_argument("--presets", type=Path, required=True)
    parser.add_argument("--system-factory", type=Path,
                        default=Path("/usr/share/TONE3000/Presets/Factory"))
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    try:
        install(args)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"install: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
