"""Compile actual model recovery methods against a minimal unavailable-audio adapter.

This exercises the observation/persistence boundary, not the Linux audio engine.
@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
"""

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def method(path, signature):
    """Extract the production body unchanged; fail if its signature drifts.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
    """
    text = path.read_text()
    start = text.index(signature)
    cursor = text.index("{", start) + 1
    depth = 1
    while depth:
        if text[cursor] == "{":
            depth += 1
        elif text[cursor] == "}":
            depth -= 1
        cursor += 1
    return text[start:cursor]


class ModelRecoveryTest(unittest.TestCase):
    """Failed capture must retain state and not prevent recovering the board.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [DES-STATE] [3.16]
    """

    def test_actual_observation_and_strict_capture_paths(self):
        compiler = shutil.which("c++") or shutil.which("clang++") or shutil.which("g++")
        if not compiler:
            self.skipTest("C++ compiler required for production-method recovery test")
        guard = method(ROOT / "src/PiPedalModel.cpp",
                       "void PiPedalModel::GuardTone3000PendingStates(bool requireCapture)")
        getter = method(ROOT / "src/PiPedalModel.hpp", "Pedalboard GetCurrentPedalboardCopy()")
        getter = getter.replace("Pedalboard GetCurrentPedalboardCopy()",
                                "Pedalboard PiPedalModel::GetCurrentPedalboardCopy()", 1)
        source = r'''
#include <cassert>
#include <exception>
#include <map>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>
#include <cstdint>
struct Item {
    std::string plugin, state;
    const std::string& uri() const {return plugin;}
};
struct Pedalboard {
    std::map<int64_t,Item> items;
    Item* GetItem(int64_t id) {auto i=items.find(id);return i==items.end()?nullptr:&i->second;}
};
struct Tone3000Preset {static constexpr const char* PLUGIN_URI="t3k";};
struct PiPedalModel {
    std::recursive_mutex mutex;
    Pedalboard pedalboard;
    std::map<int64_t,int> pendingTone3000States;
    std::map<int64_t,bool> available;
    std::vector<int64_t> attempts;
    void CaptureTone3000Item(int64_t id) {
        attempts.push_back(id);
        if(!available[id]) throw std::runtime_error("capture unavailable or not yet confirmed");
        pendingTone3000States.erase(id);
    }
    void GuardTone3000PendingStates(bool requireCapture=true);
    Pedalboard GetCurrentPedalboardCopy();
};
'''
        source += guard + "\n" + getter + r'''
int main() {
    PiPedalModel model;
    model.pedalboard.items[1]={"t3k","accepted offline rig"};
    model.pedalboard.items[2]={"t3k","second accepted rig"};
    model.pendingTone3000States={{1,1},{2,1}};
    model.available[2]=true;
    auto board=model.GetCurrentPedalboardCopy();
    assert(board.items.at(1).state=="accepted offline rig");
    assert(board.items.at(2).state=="second accepted rig");
    assert(model.attempts==std::vector<int64_t>({1,2}));
    assert(model.pendingTone3000States.contains(1));
    assert(!model.pendingTone3000States.contains(2));
    for(int retry=0;retry<3;++retry) {
        assert(model.GetCurrentPedalboardCopy().items.at(1).state=="accepted offline rig");
        bool refused=false;
        try {model.GuardTone3000PendingStates();} catch(const std::runtime_error&) {refused=true;}
        assert(refused); // strict default used by persistence never accepts failed capture
        assert(model.pendingTone3000States.contains(1));
    }
    model.available[1]=true;
    model.GetCurrentPedalboardCopy();
    assert(model.pendingTone3000States.empty());
    model.GuardTone3000PendingStates();
    model.pendingTone3000States={{3,1},{4,1}};
    model.pedalboard.items[4]={"ordinary plugin","ordinary state"};
    board=model.GetCurrentPedalboardCopy();
    assert(model.pendingTone3000States.empty()); // removed/non-T3K nodes do not strand intents
    assert(board.items.at(4).state=="ordinary state");
}
'''
        with tempfile.TemporaryDirectory(prefix="pipedal-recovery-") as directory:
            cpp = Path(directory) / "recovery.cpp"
            binary = Path(directory) / "recovery"
            cpp.write_text(source)
            built = subprocess.run([compiler, "-std=c++20", "-pthread", str(cpp), "-o", str(binary)],
                                   capture_output=True, text=True)
            self.assertEqual(built.returncode, 0, built.stderr)
            checked = subprocess.run([str(binary)], capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)


if __name__ == "__main__":
    unittest.main()
