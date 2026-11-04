"""Portable execution of actual model Stage lifecycle methods.

Host/ALSA/thread plumbing is controlled by the C++ fixture. Codec, intent matching,
Stage result parsing and LV2 state serialization are production implementations.
This does not qualify DSP timing or audio. Optional portable header locations can
be supplied in GIG_RIG_NATIVE_TEST_INCLUDE (os.pathsep separated); OpenSSL linker
flags in GIG_RIG_NATIVE_TEST_LIBS. Both are parsed as arguments, never shell code.

@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STABILITY-REVIEW] [7.23]
"""
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def method(source, signature):
    """Extract a complete real method, ignoring braces in comments/strings."""
    start = source.index(signature)
    begin = source.index("{", start)
    depth = 0
    tokens = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*[\s\S]*?\*/|[{}]')
    for token in tokens.finditer(source, begin):
        value = token.group()
        if value == "{":
            depth += 1
        elif value == "}":
            depth -= 1
            if depth == 0:
                return source[start:token.end()]
    raise AssertionError(f"Unclosed production method: {signature}")


class StageLifecycleTests(unittest.TestCase):
    def test_replacement_paths_retire_jobs_before_identity_or_state_changes(self):
        # These handlers need real Storage/PiPedalModel plumbing on Linux for
        # full execution. This separate source contract proves their entry order;
        # it is not reported as an actual-host execution test.
        source = (ROOT / "src/PiPedalModel.cpp").read_text()
        for signature, barrier in (
            ("void PiPedalModel::SetPedalboard(int64_t", "this->pedalboard = pedalboard"),
            ("void PiPedalModel::SetSnapshot(int64_t", "auto candidate="),
            ("void PiPedalModel::OpenBank(int64_t", "storage.LoadBank("),
            ("void PiPedalModel::LoadPluginPreset(int64_t", "storage.GetPluginPresetValues("),
            ("bool PiPedalModel::SetTone3000CurrentState(int64_t", "auto current=GetTone3000CurrentState("),
        ):
            with self.subTest(handler=signature):
                body = method(source, signature)
                self.assertLess(body.index("CancelTone3000StageJobs();"), body.index(barrier))
        update = method(source, "void PiPedalModel::UpdateCurrentPedalboard(int64_t")
        self.assertLess(update.index("CancelTone3000StageJobs(-1, false);"),
                        update.index("UpdateLv2PedalboardStructure("))
        load = method(source, "bool PiPedalModel::LoadCurrentPedalboard()")
        self.assertLess(load.index("CancelTone3000StageJobs(-1, false);"),
                        load.index("RegisterTone3000Intents();"))

    def test_production_lifecycle_retention_and_completion_races(self):
        compiler = shutil.which("clang++") or shutil.which("g++")
        if not compiler:
            self.skipTest("C++20 compiler required for actual-method lifecycle fixture")
        include = [str(ROOT / "src"), str(ROOT / "PiPedalCommon/src"),
                   str(ROOT / "PiPedalCommon/src/include"), str(HERE)]
        include += [p for p in os.environ.get("GIG_RIG_NATIVE_TEST_INCLUDE", "").split(os.pathsep) if p]
        extra = []
        libraries = shlex.split(os.environ.get("GIG_RIG_NATIVE_TEST_LIBS", ""))
        if shutil.which("pkg-config"):
            for package in ("lilv-0", "openssl"):
                probe = subprocess.run(["pkg-config", "--cflags", package], capture_output=True, text=True)
                if probe.returncode == 0:
                    extra += shlex.split(probe.stdout)
            if not libraries:
                probe = subprocess.run(["pkg-config", "--libs", "openssl"], capture_output=True, text=True)
                if probe.returncode == 0:
                    libraries = shlex.split(probe.stdout)
        if not libraries:
            libraries = ["-lcrypto"]
        flags = [compiler, "-std=c++20", "-O1", "-g", "-fno-fast-math",
                 "-fsanitize=address,undefined", "-fno-omit-frame-pointer"]
        flags += [f"-I{p}" for p in include] + extra
        with tempfile.TemporaryDirectory(prefix="pipedal-stage-lifecycle-") as temporary:
            work = Path(temporary)
            # Check only external toolchain dependencies before compiling code;
            # production compilation failures below are failures, never skips.
            dependency = work / "dependencies.cpp"
            dependency.write_text('#include <lv2/state/state.h>\n#include <lilv/lilv.h>\n'
                                  '#include <openssl/evp.h>\nint main(){return EVP_Q_digest(nullptr,"SHA256",'
                                  'nullptr,nullptr,0,nullptr,nullptr)?0:0;}\n')
            probe = subprocess.run(flags + [str(dependency)] + libraries + ["-o", str(work / "dependencies")],
                                   capture_output=True, text=True)
            if probe.returncode:
                self.skipTest("Required LV2/Lilv/OpenSSL3/sanitizer toolchain unavailable: " + probe.stderr[:800])
            source_path = os.environ.get("GIG_RIG_LIFECYCLE_BASELINE_SOURCE")
            source = Path(source_path).read_text() if source_path else (ROOT / "src/PiPedalModel.cpp").read_text()
            signature = "void PiPedalModel::CancelTone3000StageJobs(int64_t clientId, bool retainCurrentState)"
            legacy = signature not in source
            if legacy:
                signature = "void PiPedalModel::CancelTone3000StageJobs(int64_t clientId)"
            signatures = ["void PiPedalModel::RestartAudio(bool useDummyAudioDriver)",
                          "void PiPedalModel::SetSnapshot(int64_t selectedSnapshot)",
                          "bool PiPedalModel::LoadCurrentPedalboard()", signature,
                          "void PiPedalModel::RegisterTone3000Intents()",
                          "PedalboardItem& PiPedalModel::CaptureTone3000Item(int64_t instanceId)",
                          "bool PiPedalModel::OnNotifyMaybeLv2StateChanged(uint64_t instanceId)"]
            implementations = [method(source, signature) for signature in signatures]
            # Production operations references Validate; include its exact body
            # rather than mocking it or requiring Linux filesystem/libxml code.
            implementations.append(method((ROOT / "src/Tone3000Defaults.cpp").read_text(),
                                          "void Tone3000DefaultsStore::Validate("))
            (work / "ProductionMethods.inc").write_text("\n\n".join(implementations))
            state_source = (ROOT / "src/StateInterface.cpp").read_text()
            state_signatures = ["void Lv2PluginState::write_json(", "void Lv2PluginState::read_json(",
                                "void Lv2PluginStateEntry::write_json(", "void Lv2PluginStateEntry::read_json(",
                                "std::string Lv2PluginState::ToString()", "bool Lv2PluginStateEntry::operator==(",
                                "bool Lv2PluginState::IsEqual("]
            (work / "StateSerialization.cpp").write_text(
                '#include "StateInterface.hpp"\n#include "Base64.hpp"\n#include <sstream>\n'
                'using namespace pipedal;\n' + "\n\n".join(method(state_source, s) for s in state_signatures))
            sources = [HERE / "stage_lifecycle_fixture.cpp", ROOT / "src/Tone3000Preset.cpp",
                       ROOT / "src/Tone3000Operations.cpp", ROOT / "src/Tone3000Stage.cpp",
                       ROOT / "src/AesDigest.cpp", ROOT / "PiPedalCommon/src/json.cpp",
                       ROOT / "PiPedalCommon/src/json_variant.cpp", work / "StateSerialization.cpp"]
            command = flags + [f"-I{work}", "-Wno-parentheses", "-Wno-dangling-else"]
            if legacy:
                command += ["-DREVIEW_LEGACY_CANCEL"]
            command += [str(p) for p in sources] + libraries + ["-o", str(work / "lifecycle")]
            built = subprocess.run(command, capture_output=True, text=True, timeout=180)
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            run = subprocess.run([str(work / "lifecycle")], capture_output=True, text=True, timeout=30,
                                 env={**os.environ, "ASAN_OPTIONS": "detect_leaks=" + ("0" if sys.platform == "darwin" else "1")})
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertIn("14 cases, 0 failures", run.stdout)


if __name__ == "__main__":
    unittest.main()
