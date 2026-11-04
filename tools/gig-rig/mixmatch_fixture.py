#!/usr/bin/env python3
"""Write a tiny synthetic T3K amp/IR/pitch fixture; never reads user presets."""
import argparse
import json
import os
from pathlib import Path
import struct


def fixture():
    """Original JUCE ValueTree wire format, actual tiny LSTM NAM and float impulse IR.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [DES-TEST] [7.37]
    """
    def packed(value):
        data = value.to_bytes((value.bit_length() + 7) // 8, "little")
        return bytes([len(data)]) + data
    def variant(kind, data=b""):
        return packed(len(data) + 1) + bytes([kind]) + data
    def string(value):
        return variant(5, value.encode() + b"\0")
    def number(value):
        return variant(4, struct.pack("<d", value))
    def integer(value):
        return variant(1, struct.pack("<i", value))
    def boolean(value):
        return variant(2 if value else 3)
    def node(tag, fields=None, children=()):
        fields = fields or {}
        return (tag.encode() + b"\0" + packed(len(fields))
                + b"".join(key.encode() + b"\0" + value for key, value in fields.items())
                + packed(len(children)) + b"".join(children))
    weights = [0] * 16
    weights[4] = 1  # Candidate-gate input coefficient in row-major 4 x (input + hidden).
    weights[14] = 1  # Head coefficient; all biases and initial states remain zero.
    nam = json.dumps({"version": "0.5.4", "architecture": "LSTM", "config": {"input_size": 1, "hidden_size": 1, "num_layers": 1},
                      "weights": weights, "metadata": {"gear_type": "amp"}, "sample_rate": 48000}, separators=(",", ":")).encode()
    samples = struct.pack("<64f", 1, *([0] * 63))
    chunks = b"fmt " + struct.pack("<IHHIIHH", 16, 3, 1, 48000, 192000, 4, 32) + b"data" + struct.pack("<I", len(samples)) + samples
    wav = b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks
    def block(amp):
        identity = 1 if amp else 2
        return node("ChainBlock", {"id": string("amp" if amp else "cab"), "type": string("nam" if amp else "ir"),
            "enabled": boolean(True), "toneId": integer(identity), "activeModelId": integer(identity), "mix": number(1),
            "inputGain": number(.5), "outputGain": number(.5), "normalize": boolean(False), "slimSize": number(1),
            "toneJson": string(json.dumps({"gear": "amp" if amp else "cab", "format": "nam" if amp else "ir", "models": [{"id": identity, "name": "diagnostic", "model_url": ""}]}))},
            [node("ModelCache", children=[node("CachedModel", {"modelId": integer(identity), "data": variant(8, nam if amp else wav)})])])
    params = {"pitchEnabled": 1, "pitchSemitones": -2, "pitchStep": 1, "pitchTonality": 20000, "pitchWindow": 1,
              "inputLevel": .5, "outputLevel": .5, "gateEnabled": 0, "toneEqEnabled": 0, "osEnabled": 0,
              "spreadEnabled": 0, "alignEnabled": 0, "chainSoloLeft": 0, "chainSoloRight": 0}
    snapshot = node("ChainSnapshot", {"stereoEnabled": boolean(False)}, [node("ChainBlocks", children=[block(True), block(False)]), node("RightChainBlocks")])
    return b"T3KB" + node("T3KPreset", {"schemaVersion": integer(1), "id": string("mixmatch-diagnostic"), "name": string("Mix-match diagnostic source")},
        [snapshot, node("Params", children=[node("Param", {"id": string(key), "value": number(value)}) for key, value in params.items()])])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(fixture())


if __name__ == "__main__":
    main()
