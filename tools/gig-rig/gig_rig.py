#!/usr/bin/env python3
"""Read-only TONE3000 inventory and validated staged labels. Use --help."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import struct
import sys


class InventoryError(ValueError):
    """Unsafe or unsupported inventory; never guess a program mapping.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ORDER] [2.3]
    """


class ValueTreeReader:
    """Bounded JUCE 9.0.3 ValueTree reader; binary/array payloads are skipped.

    Encoding verified against juce_InputStream.cpp, juce_Variant.cpp and
    juce_ValueTree.cpp. No model data is deserialized or rewritten.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ORDER] [3.3]
    """

    def __init__(self, stream, limit):
        self.stream, self.limit, self.nodes = stream, limit, 0

    def read(self, count):
        if count < 0 or self.stream.tell() + count > self.limit:
            raise InventoryError("Truncated ValueTree")
        value = self.stream.read(count)
        if len(value) != count:
            raise InventoryError("Truncated ValueTree")
        return value

    def integer(self):
        size = self.read(1)[0]
        if size & 0x7f > 4:
            raise InventoryError("Invalid JUCE compressed integer")
        value = int.from_bytes(self.read(size & 0x7f), "little")
        return -value if size & 0x80 else value

    def string(self):
        result = bytearray()
        for _ in range(65536):
            byte = self.read(1)
            if byte == b"\0":
                try:
                    return result.decode("utf-8")
                except UnicodeDecodeError as error:
                    raise InventoryError("Invalid UTF-8 ValueTree string") from error
            result.extend(byte)
        raise InventoryError("ValueTree string exceeds bound")

    def variant(self, identity=False):
        size = self.integer()
        if size == 0:
            return "" if identity else None
        if size < 1 or self.stream.tell() + size > self.limit:
            raise InventoryError("Invalid JUCE variant length")
        marker = self.read(1)[0]
        if identity:
            if marker != 5 or size > 65536:
                raise InventoryError("Non-string preset identity is unsupported")
            data = self.read(size - 1)
            if not data.endswith(b"\0") or b"\0" in data[:-1]:
                raise InventoryError("Invalid JUCE variant string")
            try:
                return data[:-1].decode("utf-8")
            except UnicodeDecodeError as error:
                raise InventoryError("Invalid preset identity UTF-8") from error
        if marker not in range(1, 10):
            raise InventoryError("Unknown JUCE variant marker")
        # Every serialized var has a byte-length prefix, including model bytes.
        self.stream.seek(size - 1, os.SEEK_CUR)
        return None

    def tree(self, expected=None, depth=0):
        self.nodes += 1
        if depth > 64 or self.nodes > 100000:
            raise InventoryError("ValueTree complexity exceeds bound")
        tag = self.string()
        if not tag or (expected and tag != expected):
            raise InventoryError(f"Unexpected preset tree type: {tag!r}")
        count = self.integer()
        if not 0 <= count <= 10000:
            raise InventoryError("Invalid ValueTree property count")
        identity = {}
        for _ in range(count):
            key = self.string()
            if not key:
                raise InventoryError("Empty ValueTree property name")
            value = self.variant(identity=depth == 0 and key in ("id", "name"))
            if depth == 0 and key in ("id", "name"):
                identity[key] = value
        children = self.integer()
        if not 0 <= children <= 100000:
            raise InventoryError("Invalid ValueTree child count")
        for _ in range(children):
            self.tree(depth=depth + 1)
        return identity


def digest(path):
    """Stream a file digest without including private model data in reports.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [NFR-6] [DES-SEC]
    """
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def read_header(path):
    """Read actual stored identity, matching released PresetFile framing.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ORDER] [2.3]
    """
    path = Path(path)
    with path.open("rb") as stream:
        magic = stream.read(4)
        if magic == b"T3KH":
            length_bytes = stream.read(4)
            if len(length_bytes) != 4:
                raise InventoryError(f"Truncated header: {path}")
            length = struct.unpack("<i", length_bytes)[0]
            if not 0 < length <= 65536:
                raise InventoryError(f"Invalid header length: {path}")
            header = stream.read(length)
            if len(header) != length:
                raise InventoryError(f"Truncated header: {path}")
            reader = ValueTreeReader(io.BytesIO(header), length)
            result = reader.tree("T3KPresetHeader")
            if reader.stream.tell() != length:
                raise InventoryError(f"Trailing header bytes: {path}")
            legacy = False
        elif magic == b"T3KB":
            if path.stat().st_size > 1024 * 1024 * 1024:
                raise InventoryError(f"Legacy preset exceeds 1 GiB: {path}")
            result = ValueTreeReader(stream, path.stat().st_size).tree("T3KPreset")
            legacy = True
        else:
            raise InventoryError(f"Unsupported preset framing: {path}")
    return {"raw_id": result.get("id", "").strip(),
            "name": result.get("name", ""), "legacy": legacy}


def sort_key(value):
    """Match JUCE ASCII uppercase ordering; refuse unknown Unicode locale.

    JUCE uses C-library towupper, whose Unicode mapping depends on the
    plugin process's LC_CTYPE. Python's Unicode upper is not that contract.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ORDER] [3.3]
    """
    if not value.isascii():
        raise InventoryError(f"Locale-dependent Unicode ordering is unsupported: {value!r}; verify in app")
    return value.upper()


def check_sort_ties(entries, field):
    """Reject comparisons for which upstream std::sort gives no stable rank.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ORDER] [3.3]
    """
    seen = set()
    for entry in entries:
        key = sort_key(entry[field])
        if key in seen:
            raise InventoryError(f"Ambiguous case-insensitive {field}: {entry[field]!r}")
        seen.add(key)


def scan(directory, section):
    """Scan one section, including PresetManager's duplicate-ID stem fallback.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ORDER] [2.3]
    """
    if directory is None:
        return []
    directory = Path(directory)
    if not directory.exists():
        return []
    if not directory.is_dir():
        raise InventoryError(f"Not a preset directory: {directory}")
    files = [{"stem": path.stem, "path": path} for path in directory.glob("*.t3kpreset")]
    check_sort_ties(files, "stem")
    ids, entries = set(), []
    for item in sorted(files, key=lambda entry: sort_key(entry["stem"])):
        path, stem = item["path"], item["stem"]
        try:
            header = read_header(path)
        except (OSError, InventoryError) as error:
            raise InventoryError(f"Cannot safely map {path}: {error}") from error
        identity = section + ":" + (header["raw_id"] or stem)
        if identity in ids:
            identity = section + ":" + stem
            if identity in ids:
                raise InventoryError(f"Duplicate identity and fallback stem: {path}")
        ids.add(identity)
        entries.append({**header, "id": identity, "name": header["name"] or stem,
                        "file": str(path.resolve()), "section": section,
                        "sha256": digest(path)})
    check_sort_ties(entries, "name")
    return sorted(entries, key=lambda entry: sort_key(entry["name"]))


def inventory(presets, system_factory=None):
    """Merge factory overlay and apply order.json within sections only.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-9] [DES-ORDER] [3.3]
    """
    presets = Path(presets)
    if not presets.is_dir():
        raise InventoryError(f"Preset root does not exist: {presets}")
    factory = {entry["id"]: entry for entry in scan(system_factory, "factory")}
    factory.update({entry["id"]: entry for entry in scan(presets / "Factory", "factory")})
    factory = list(factory.values())
    check_sort_ties(factory, "name")
    factory.sort(key=lambda entry: sort_key(entry["name"]))
    user = scan(presets, "user")
    order_path = presets / "order.json"
    order = []
    if order_path.exists():
        try:
            order = json.loads(order_path.read_text())
        except (ValueError, OSError) as error:
            raise InventoryError("Cannot parse order.json; fix via app before labeling") from error
        if not isinstance(order, list) or not all(isinstance(value, str) for value in order):
            raise InventoryError("Unsupported order.json; expected array of ID strings")
    rank = {}
    for index, identity in enumerate(order):
        rank.setdefault(identity, index)
    entries = sorted(user, key=lambda entry: rank.get(entry["id"], len(order)))
    entries += sorted(factory, key=lambda entry: rank.get(entry["id"], len(order)))
    for index, entry in enumerate(entries):
        entry.update(program=index, uri=f"https://www.tone3000.com/plugin:preset{index + 1}"
                     if index < 128 else None, names_line=index + 1,
                     host_slot_available=index < 128)
    return {"presets": entries, "count": len(entries),
            "order_sha256": digest(order_path) if order_path.exists() else None,
            "unknown_order_ids": [identity for identity in order
                                  if identity not in {entry["id"] for entry in entries}]}


PRESET_PATTERN = re.compile(
    r'(?P<head><https://www\.tone3000\.com/plugin:preset(?P<slot>\d+)>\s+'
    r'a\s+pset:Preset\s*;\s*lv2:appliesTo\s+<https://www\.tone3000\.com/plugin>\s*;\s*'
    r'rdfs:label\s+)(?P<label>"(?:[^"\\\r\n]|\\(?:[tbnrf"\\]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}))*")'
    r'(?P<tail>\s*;\s*state:state\s*\[\s*<https://www\.tone3000\.com/plugin:Program>\s+'
    r'"(?P<program>\d+)"\^\^xsd:int\s*;\s*\]\s*\.)')


def turtle_string(value):
    """Escape Turtle short strings including all controls and backslashes.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ORDER] [2.3]
    """
    result = []
    for char in value:
        if char == "\\":
            result.append("\\\\")
        elif char == '"':
            result.append('\\"')
        elif ord(char) < 32 or ord(char) == 127:
            result.append(f"\\u{ord(char):04x}")
        else:
            result.append(char)
    return '"' + "".join(result) + '"'


def manifest_matches(text):
    """Validate the reviewed manifest subset before any label replacement.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ORDER] [2.3]
    """
    matches = list(PRESET_PATTERN.finditer(text))
    if len(matches) != 128 or text.count("a pset:Preset") != 128:
        raise InventoryError("Only the reviewed 128-slot TONE3000 manifest grammar is supported")
    slots = {int(match["slot"]) for match in matches}
    if slots != set(range(1, 129)) or any(int(m["program"]) != int(m["slot"]) - 1 for m in matches):
        raise InventoryError("Manifest slot/program identity mismatch")
    # Prefix rebinding would change the RDF meaning despite matching syntax.
    expected = {"pset": "http://lv2plug.in/ns/ext/presets#",
                "lv2": "http://lv2plug.in/ns/lv2core#",
                "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
                "state": "http://lv2plug.in/ns/ext/state#",
                "xsd": "http://www.w3.org/2001/XMLSchema#"}
    for prefix, uri in expected.items():
        definitions = re.findall(rf"@prefix\s+{prefix}:\s*<([^>]+)>\s*\.", text)
        if definitions != [uri]:
            raise InventoryError(f"Missing/rebound manifest prefix: {prefix}")
    # Refuse extra references/triples for preset subjects or Program predicates.
    if len(re.findall(r"<https://www\.tone3000\.com/plugin:preset\d+>", text)) != 128:
        raise InventoryError("Unexpected additional preset triples")
    if text.count("<https://www.tone3000.com/plugin:Program>") != 128:
        raise InventoryError("Unexpected Program statements")
    # Validate every token outside the preset resources as well. Otherwise
    # SPARQL-style PREFIX could silently rebind pset after the checked @prefix.
    remainder = PRESET_PATTERN.sub("", text)
    for prefix, uri in {**expected, "ui": "http://lv2plug.in/ns/extensions/ui#"}.items():
        remainder = re.sub(rf"@prefix\s+{prefix}:\s*<{re.escape(uri)}>\s*\.", "", remainder)
    remainder = re.sub(
        r"<https://www\.tone3000\.com/plugin>\s+a\s+lv2:Plugin\s*;\s*"
        r"lv2:binary\s+<libTONE3000\.so>\s*;\s*rdfs:seeAlso\s+<dsp\.ttl>\s*\.",
        "", remainder)
    remainder = re.sub(
        r"<https://www\.tone3000\.com/plugin:UI>\s+a\s+ui:X11UI\s*;\s*"
        r"lv2:binary\s+<libTONE3000\.so>\s*;\s*rdfs:seeAlso\s+<ui\.ttl>\s*\.",
        "", remainder)
    if remainder.strip():
        raise InventoryError("Unsupported Turtle outside the reviewed manifest grammar")
    return matches


def stage_labels(report, manifest, output):
    """Write a fresh staging directory; never alter installed/persistent data.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-9] [DES-ORDER] [2.3] [3.3]
    """
    entries = report["presets"]
    if len(entries) > 128:
        raise InventoryError("More than 128 rigs: select scope before creating host labels")
    if any("\n" in entry["name"] or "\r" in entry["name"] for entry in entries):
        raise InventoryError("Multiline names cannot be represented in names.txt; rename in app")
    path = Path(manifest)
    text = path.read_text(encoding="utf-8")
    manifest_matches(text)
    def replace(match):
        index = int(match["program"])
        label = entries[index]["name"] if index < len(entries) else "(empty)"
        return match["head"] + turtle_string(label) + match["tail"]
    staged = PRESET_PATTERN.sub(replace, text)
    matches = manifest_matches(staged)
    for match in matches:
        index = int(match["program"])
        wanted = entries[index]["name"] if index < len(entries) else "(empty)"
        if match["label"] != turtle_string(wanted):
            raise InventoryError("Staged label validation failed")
    output = Path(output)
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    (output / "manifest.original.ttl").write_bytes(path.read_bytes())
    (output / "manifest.ttl").write_text(staged, encoding="utf-8")
    (output / "names.txt").write_text("".join(entry["name"] + "\n" for entry in entries), encoding="utf-8")
    (output / "inventory.json").write_text(json.dumps({**report, "original_manifest_sha256": digest(path),
        "staged_manifest_sha256": digest(output / "manifest.ttl")}, indent=2, ensure_ascii=False) + "\n")
    return {"staged_directory": str(output.resolve()), "installed_changed": False,
            "persistent_labels_changed": False, "rig_count": len(entries)}


def main(argv=None):
    """CLI emits JSON; errors are nonzero and no guessed inventory is printed.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FILES] [2.3] [3.3]
    """
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("inventory", "stage-labels"):
        item = sub.add_parser(command)
        item.add_argument("--presets", required=True, type=Path)
        item.add_argument("--system-factory", type=Path,
                          help="Explicit system factory path; omit only after confirming none exists")
        if command == "stage-labels":
            item.add_argument("--manifest", required=True, type=Path)
            item.add_argument("--output", required=True, type=Path, help="New staging directory; must not exist")
    args = parser.parse_args(argv)
    try:
        report = inventory(args.presets, args.system_factory)
        if args.command == "stage-labels":
            report = stage_labels(report, args.manifest, args.output)
        print(json.dumps(report, indent=2, ensure_ascii=False))
    except (OSError, InventoryError) as error:
        print(f"gig-rig: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
