#!/usr/bin/env python3
"""Apply the approved exact TONE3000 v0.0.12 + JUCE 9.0.3 stage overlay."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

MANIFEST_SHA256 = "891763efad166ec7499564ff18259e03d334a2dc3617f0891ead103d3b475087"
HERE = Path(__file__).resolve().parent
class StagePatchError(RuntimeError):
    pass

def digest(data):
    return hashlib.sha256(data).hexdigest()

def exact_patch(source,patch,path):
    """No offsets/fuzz; the source and every hunk must match the pinned input.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.5]
    """
    lines=patch.splitlines(keepends=True)
    if lines[:2]!=[f"--- a/{path}\n",f"+++ b/{path}\n"]:raise StagePatchError("Unexpected patch target")
    old=source.splitlines(keepends=True);result=[];cursor=0;index=2
    while index<len(lines):
        match=re.fullmatch(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\n",lines[index])
        if not match:raise StagePatchError("Invalid hunk")
        start=int(match[1])-1;consumed=produced=0
        if start<cursor or start>len(old):raise StagePatchError("Overlapping hunk")
        result.extend(old[cursor:start]);cursor=start;index+=1
        while index<len(lines) and not lines[index].startswith("@@ "):
            kind,content=lines[index][:1],lines[index][1:]
            if kind in (" ","-"):
                if cursor>=len(old) or old[cursor]!=content:raise StagePatchError("Source anchor differs")
                cursor+=1;consumed+=1
            if kind in (" ","+"):result.append(content);produced+=1
            if kind not in (" ","-","+"):raise StagePatchError("Invalid patch line")
            index+=1
        if (consumed,produced)!=(int(match[2] or 1),int(match[4] or 1)):raise StagePatchError("Invalid hunk counts")
    result.extend(old[cursor:]);return "".join(result)

def unlinked(path):
    for part in (path,*path.parents):
        if part.is_symlink():raise StagePatchError("Symlinked source paths are unsupported")

def write(path,data):
    mode=path.stat().st_mode&0o777 if path.exists() else 0o644
    temporary=None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent,prefix=path.name+".stage-",delete=False) as stream:
            temporary=Path(stream.name);stream.write(data);stream.flush();os.fsync(stream.fileno())
        os.chmod(temporary,mode);os.replace(temporary,path);temporary=None
    finally:
        if temporary is not None:temporary.unlink(missing_ok=True)

def apply(source,juce,check=False):
    """Prevalidate every pinned input/addon before publishing any source change.
    Existing readback correction is a required baseline, preserved byte-for-byte.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [DES-STAGE-NEXT] [7.5] [7.6]
    """
    roots={"tone3000":Path(source).absolute(),"juce":Path(juce).absolute()}
    for root in roots.values():unlinked(root)
    manifest_bytes=(HERE/"tone3000-stage-manifest.json").read_bytes()
    if digest(manifest_bytes)!=MANIFEST_SHA256:raise StagePatchError("Reviewed manifest digest differs")
    manifest=json.loads(manifest_bytes)
    for artifact,expected in manifest["artifacts"].items():
        if digest((HERE/artifact).read_bytes())!=expected:raise StagePatchError("Reviewed overlay artifact differs")
    patch=(HERE/"tone3000-stage.patch").read_text()
    chunks={}
    for chunk in re.split(r"(?=^--- a/)",patch,flags=re.MULTILINE):
        if chunk:chunks[chunk.splitlines()[0][6:]]=chunk
    changes=[];hashes={}
    for key,pin in manifest.items():
        if key=="artifacts":continue
        namespace,relative=key.split("/",1);target=roots[namespace]/relative;unlinked(target)
        raw=target.read_bytes();normalized=raw.replace(b"\r\n",b"\n");current=digest(normalized)
        if current not in (pin["before"],pin["after"]):raise StagePatchError(f"Pinned source differs: {key}")
        hashes[key]=pin["after"]
        if current==pin["after"]:continue
        if check:raise StagePatchError("Stage overlay is not fully applied")
        amended=exact_patch(normalized.decode(),chunks[key],key).encode()
        if digest(amended)!=pin["after"]:raise StagePatchError("Patch output digest differs")
        if b"\r\n" in raw:
            if raw.count(b"\r\n")!=raw.count(b"\n"):raise StagePatchError("Mixed line endings")
            amended=amended.replace(b"\n",b"\r\n")
        changes.append((target,amended))
    copies={
        "Tone3000StageBridge.hpp":[roots["tone3000"]/"plugin/include/Tone3000StageBridge.hpp",roots["juce"]/"modules/juce_audio_plugin_client/Tone3000StageBridge.hpp"],
        "stage-addon/Tone3000StageMeter.hpp":[roots["tone3000"]/"plugin/include/Tone3000StageMeter.hpp"],
        "stage-addon/Tone3000StageSession.h":[roots["tone3000"]/"plugin/include/Tone3000StageSession.h"],
        "stage-addon/Tone3000StageSession.cpp":[roots["tone3000"]/"plugin/src/Tone3000StageSession.cpp"],
    }
    for artifact,targets in copies.items():
        data=(HERE/artifact).read_bytes()
        for target in targets:
            unlinked(target)
            if target.exists():
                if target.read_bytes()!=data:raise StagePatchError("Existing addon differs from reviewed overlay")
            elif check:raise StagePatchError("Stage addon is missing")
            else:changes.append((target,data))
    for target,data in changes:write(target,data)
    return {"action":"patched" if changes else "already-patched","writes":len(changes),"manifest_sha256":MANIFEST_SHA256,"source_hashes":hashes}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source",type=Path,required=True,help="Isolated TONE3000 v0.0.12 checkout")
    parser.add_argument("--juce",type=Path,required=True,help="Isolated JUCE9.0.3 already readback-patched")
    parser.add_argument("--check",action="store_true")
    args=parser.parse_args()
    try:print(json.dumps(apply(args.source,args.juce,args.check),sort_keys=True))
    except (StagePatchError,OSError,ValueError,UnicodeError) as error:parser.exit(1,f"T3K_STAGE_OVERLAY: {error}\n")
if __name__=="__main__":main()
