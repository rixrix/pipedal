// SPDX-License-Identifier: MIT
#pragma once
#include "Banks.hpp"
#include "json.hpp"
#include <filesystem>
namespace pipedal {
/** Saved sources, never unsaved/current audio state.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-18] [DES-STAGE-BANK] [7.4]
 */
struct Tone3000PerformanceSource {
    int64_t bankId_=-1,presetId_=-1;
    std::string name_,revision_,bankName_;
    DECLARE_JSON_MAP(Tone3000PerformanceSource);
};
struct Tone3000PerformanceSources {
    std::vector<Tone3000PerformanceSource> sources_;
    DECLARE_JSON_MAP(Tone3000PerformanceSources);
};
struct Tone3000PerformanceSelection {
    int64_t bankId_=-1,presetId_=-1;
    std::string expectedRevision_;
    DECLARE_JSON_MAP(Tone3000PerformanceSelection);
};
struct Tone3000PerformanceRequest {
    std::string name_;
    std::vector<Tone3000PerformanceSelection> slots_;
    DECLARE_JSON_MAP(Tone3000PerformanceRequest);
};
struct Tone3000PerformanceSlot {
    std::string label_,name_;
    int program_=0;
    int64_t presetId_=-1;
    DECLARE_JSON_MAP(Tone3000PerformanceSlot);
};
struct Tone3000PerformanceResult {
    int64_t bankId_=-1;
    std::string revision_,name_;
    std::vector<Tone3000PerformanceSlot> slots_;
    DECLARE_JSON_MAP(Tone3000PerformanceResult);
};
/** Bounded complete saved-board copies and atomic index publication.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-18] [DES-STAGE-BANK] [DES-SEC] [7.4]
 */
class Tone3000Performance {
public:
    static std::string Revision(const Pedalboard& board);
    static std::string Revision(const BankFile& bank);
    static void Validate(const Tone3000PerformanceRequest& request);
    static void ValidateJson(const json_variant& request);
    static int64_t ProgramListenerHandle(const json_variant& request);
    static int64_t BankId(const json_variant& request);
    static BankFile Prepare(const std::string& name,const std::vector<Pedalboard>& ordered);
    static Tone3000PerformanceResult Result(int64_t bankId,const BankFile& bank);
    static void Publish(const std::filesystem::path& dataRoot,const std::filesystem::path& bankPath,
                        const std::filesystem::path& indexPath,const BankFile& bank,const BankIndex& index);
};
}
