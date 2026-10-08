// SPDX-License-Identifier: MIT
#pragma once
#include "json_variant.hpp"
#include <cstdint>
#include <string>

namespace pipedal {
/** Bounded command protocol; output reports observed facts, not source requests.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.5] [7.6]
 */
struct Tone3000StageRequest {
    int64_t instanceId_=-1, token_=0;
    std::string expectedRevision_, command_, payload_;
};
struct Tone3000LevelRequest { uint64_t token=0; std::string revision; double target=0; };
class Tone3000Stage {
public:
    static Tone3000StageRequest Request(const json_variant& value, bool poll);
    static uint32_t Command(const std::string& command);
    static json_variant Result(const std::string& text);
    static bool Terminal(const json_variant& result);
    static bool Mutates(uint32_t command);
    static double MatchedOutput(const json_variant& measurement,double targetRmsDb,double currentOutput);
    static Tone3000LevelRequest LevelRequest(const json_variant& value);
};
}
