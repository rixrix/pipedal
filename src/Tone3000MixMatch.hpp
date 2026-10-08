// SPDX-License-Identifier: MIT
#pragma once
#include "Banks.hpp"
#include "Tone3000Preset.hpp"
#include <optional>
namespace pipedal {
/** Exact saved source and explicit authoring request; never live state.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-26] [FR-27] [DES-PITCH-LV2] [7.34]
 */
struct Tone3000MixMatchRequest {
    int64_t bankId_=-1,presetId_=-1,instanceId_=-1;
    std::string expectedRevision_,ampBlockId_,cabBlockId_,name_,creationId_;
    bool confirmAmpHead_=false,includePitch_=true;
    DECLARE_JSON_MAP(Tone3000MixMatchRequest);
};
struct Tone3000MixMatchItem {
    int64_t instanceId_=-1;
    std::string uri_,name_,role_;
    DECLARE_JSON_MAP(Tone3000MixMatchItem);
};
struct Tone3000MixMatchPreview {
    std::string sourceRevision_,sourceName_,name_,ampBlockId_,cabBlockId_;
    Tone3000StateSummary ampSummary_,cabSummary_;
    bool includePitch_=true,requiresAmpHeadConfirmation_=true,qualified_=false;
    std::vector<ControlValue> pitchControls_;
    std::vector<Tone3000MixMatchItem> items_;
    std::vector<std::string> warnings_;
    DECLARE_JSON_MAP(Tone3000MixMatchPreview);
};
struct Tone3000MixMatchResult {
    int64_t bankId_=-1,presetId_=-1,ampInstanceId_=-1,cabInstanceId_=-1,pitchInstanceId_=-1;
    std::string name_,sourceRevision_;
    bool qualified_=false;
    DECLARE_JSON_MAP(Tone3000MixMatchResult);
};
struct Tone3000MixMatchPrepared {
    Pedalboard board;
    Tone3000MixMatchPreview preview;
    int64_t ampInstanceId=-1,cabInstanceId=-1,pitchInstanceId=-1;
};
/** Pure preparation/receipt validation; publication belongs to Storage.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-MIX-MATCH] [DES-PITCH-LV2] [DES-SEC] [7.34]
 */
class Tone3000MixMatch {
public:
    static constexpr const char* PITCH_URI="https://github.com/rixrix/pipedal/plugins/t3k-pitch#stereo";
    static constexpr const char* BANK_PREFIX="TONE3000 Experiments - ";
    static void Validate(const Tone3000MixMatchRequest&,bool create);
    static void ValidateJson(const json_variant&,bool create);
    static std::string RequestHash(const Tone3000MixMatchRequest&);
    static Tone3000MixMatchPrepared Prepare(const Pedalboard&,const Tone3000MixMatchRequest&,bool create);
    static std::optional<Tone3000MixMatchResult> Receipt(int64_t bankId,const BankFile&,const Tone3000MixMatchRequest&);
    static void PinDerivedPolicies(Pedalboard&,const Pedalboard* previous=nullptr);
};
/** A failed publish may have changed disk after rename. Never retry against an
 * unchanged in-memory index in that process; restart re-reads the saved index.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [DES-SEC] [7.34]
 */
class Tone3000MixMatchPublicationGuard {
    bool blocked_=false;
public:
    void Check() const;
    template<class Write> void Publish(Write&& write){
        Check();
        try{write();}catch(...){blocked_=true;throw;}
    }
};
}
