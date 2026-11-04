#!/usr/bin/env python3
"""Read-only Linux gig-rig preflight; prints selected inventory as JSON."""

import argparse
import datetime
import glob
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys


def command(argv):
    """Run a fixed read-only probe; retain explicit missing/failure evidence.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [0.2] [DES-DEPS]
    """
    try:
        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=20, check=False)
        return {"exit_code": result.returncode, "stdout": result.stdout.strip(),
                "stderr": result.stderr.strip()}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"error": str(error)}


def read(path):
    """Read only explicitly selected non-secret system inventory files.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-DEPS] [0.2]
    """
    try:
        return Path(path).read_text().strip()
    except OSError as error:
        return {"error": str(error)}


def file_digest(path):
    """Record installed artifact identity without reading private settings.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [NFR-6] [DES-DEPS] [0.2]
    """
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def preflight(bundle=None, service="pipedald.service"):
    """Inventory architecture, packages, devices and selected unit properties.

    Do not print config files, credentials, Wi-Fi data or arbitrary environment.
    Static inventory and ldd do not prove instantiation or audio qualification.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [NFR-6] [0.2] [DES-DEPS]
    """
    if platform.system() != "Linux":
        raise ValueError("Device preflight must run on Linux")
    probes = {
        "architecture": ["dpkg", "--print-architecture"],
        "packages": ["dpkg-query", "-W", "-f=${Package}\t${Version}\t${Architecture}\n",
                     "pipedal", "libc6", "libstdc++6", "libasound2t64", "libasound2",
                     "libx11-6", "libfontconfig1", "cmake", "g++", "nodejs"],
        "storage": ["df", "-h", "/", "/var/pipedal"],
        "audio_playback": ["aplay", "-l"],
        "audio_capture": ["arecord", "-l"],
        "midi": ["amidi", "-l"],
        "service": ["systemctl", "show", service, "--no-pager",
                    "--property=User,Group,ActiveState,SubState,FragmentPath,DropInPaths,"
                    "LimitRTPRIO,LimitMEMLOCK,Restart,RestartUSec,MainPID"],
        "node": ["node", "--version"], "compiler": ["g++", "--version"],
        "cmake": ["cmake", "--version"],
        "throttling": ["vcgencmd", "get_throttled"],
    }
    result = {"timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
              "kernel": platform.release(), "machine": platform.machine(),
              "model": read("/proc/device-tree/model"), "os_release": read("/etc/os-release"),
              "meminfo": read("/proc/meminfo"),
              "invoking_environment": {key: os.environ.get(key) for key in ("HOME", "XDG_CONFIG_HOME", "USER")},
              "probes": {name: command(argv) for name, argv in probes.items()},
              "thermal_millidegrees": {path: read(path) for path in glob.glob("/sys/class/thermal/thermal_zone*/temp")},
              "runtime_verified": False}
    if bundle:
        bundle = Path(bundle)
        result["bundle"] = {"path": str(bundle.resolve()), "files": {}}
        for name in ("manifest.ttl", "dsp.ttl", "ui.ttl", "libTONE3000.so"):
            path = bundle / name
            result["bundle"]["files"][name] = {"readable": os.access(path, os.R_OK),
                "sha256": file_digest(path) if path.is_file() else None}
        binary = bundle / "libTONE3000.so"
        # ldd is limited to the explicitly selected, already trusted T3K binary.
        if binary.is_file():
            result["bundle"]["dependencies"] = command(["ldd", str(binary)])
            result["bundle"]["elf_versions"] = command(["objdump", "-p", str(binary)])
    return result


def main():
    """Run without elevated privileges, or as effective service user for access.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FILES] [0.2]
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--service", default="pipedald.service")
    args = parser.parse_args()
    try:
        print(json.dumps(preflight(args.bundle, args.service), indent=2))
    except (OSError, ValueError) as error:
        print(f"preflight: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
