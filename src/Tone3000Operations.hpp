// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
#pragma once
#include "Tone3000Preset.hpp"
#include "Tone3000Defaults.hpp"
#include "Pedalboard.hpp"
#include "json_variant.hpp"
namespace pipedal {
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [3.12] */
struct Tone3000CurrentStateRequest {int64_t instanceId_=-1;DECLARE_JSON_MAP(Tone3000CurrentStateRequest);};
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [3.12] */
struct Tone3000CurrentStateResult {
    std::string revision_;
    int64_t instanceId_=-1;
    bool followDefaults_=false,hasSnapshotOverrides_=false;
    Tone3000StateSummary summary_;
    DECLARE_JSON_MAP(Tone3000CurrentStateResult);
};
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [3.12] */
struct Tone3000CurrentStateEdit {
    int64_t instanceId_=-1;
    std::string expectedRevision_;
    Tone3000StatePatch patch_;
    std::optional<bool> followDefaults_,applyDefaults_;
    DECLARE_JSON_MAP(Tone3000CurrentStateEdit);
};
/** Small pure guards shared by model and protocol regression tests.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [DES-SEC] [3.12]
 */
class Tone3000Operations {
public:
    static Tone3000StatePatch ProcessingPatch(const Tone3000ProcessingDefaults& defaults);
    static bool IntentMatches(const Tone3000StateSummary& actual,const Tone3000StateSummary& intended);
    static std::string Revision(const PedalboardItem& item,int64_t bankId,int64_t presetId);
    static json_variant ReadRequestJson(json_reader& reader);
    static void ValidateRequestJson(const json_variant& object,const std::string& request);
};
}
