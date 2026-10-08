// SPDX-License-Identifier: MIT
#pragma once
#include "json.hpp"
#include <filesystem>
#include <functional>
#include <optional>
#include <vector>
namespace pipedal {
struct Tone3000BundlePluginVersion {std::string name;uint32_t minor=0,micro=0;};
struct Tone3000BundlePlugin {
    std::string uri_,name_,versionStatus_="unknown";
    bool installed_=false;
    std::optional<uint32_t> requiredMinor_,requiredMicro_,installedMinor_,installedMicro_;
    DECLARE_JSON_MAP(Tone3000BundlePlugin);
};
/** Stored dependency observations, not DSP/audio readiness.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-22] [DES-STAGE-BUNDLE] [7.7]
 */
struct Tone3000BundleReport {
    std::string name_,sha256_;
    bool archive_=false,knownAssetsPresent_=false,completenessKnown_=false,readinessProven_=false;
    uint64_t presetCount_=0,namCount_=0,irCount_=0,embeddedBytes_=0,opaqueStates_=0,incompleteToneStates_=0;
    std::vector<Tone3000BundlePlugin> plugins_;
    std::vector<std::string> missingMedia_,warnings_;
    DECLARE_JSON_MAP(Tone3000BundleReport);
};
/** Inspect existing ZIP/legacy JSON without extraction, publication or audio calls.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-22] [DES-STAGE-BUNDLE] [DES-SEC] [7.7]
 */
class Tone3000BundleCheck {
public:
    static constexpr size_t MAX_FILE=128*1024*1024,MAX_EXPANDED=256*1024*1024;
    using Resolver=std::function<std::optional<Tone3000BundlePluginVersion>(const std::string&)>;
    static Tone3000BundleReport Check(const std::filesystem::path& file,const Resolver& installed);
    static bool SafeEntry(const std::string& name);
};
}
