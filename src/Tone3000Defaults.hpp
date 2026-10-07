// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
#pragma once
#include "json.hpp"
#include <filesystem>
#include <optional>
#include <vector>
namespace pipedal {
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [DES-OPERATE] [3.12] */
struct Tone3000ProcessingDefaults {
    bool multiCore_=true;
    double namSlimSizeDefault_=0;
    bool calibrateInput_=false;
    double inputCalibrationLevel_=12;
    bool osEnabled_=false;
    int osFactor_=0;
    DECLARE_JSON_MAP(Tone3000ProcessingDefaults);
};
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [3.12] */
struct Tone3000ProcessingProfile {
    std::string id_,name_;
    Tone3000ProcessingDefaults defaults_;
    DECLARE_JSON_MAP(Tone3000ProcessingProfile);
};
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [3.12] */
struct Tone3000DefaultsResult {
    std::string revision_,activeProfile_="home",sourceStatus_;
    Tone3000ProcessingDefaults defaults_;
    std::vector<Tone3000ProcessingProfile> profiles_;
    std::optional<Tone3000ProcessingDefaults> appDefaults_;
    std::vector<std::string> warnings_;
    DECLARE_JSON_MAP(Tone3000DefaultsResult);
};
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [3.12] */
struct Tone3000DefaultsRequest {
    std::string expectedRevision_,activeProfile_;
    Tone3000ProcessingDefaults defaults_;
    DECLARE_JSON_MAP(Tone3000DefaultsRequest);
};
/** Single authoritative service preferences file, with read-only app reference.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [DES-OPERATE] [DES-SEC] [3.12]
 */
class Tone3000DefaultsStore {
public:
    Tone3000DefaultsStore(const std::filesystem::path& dataRoot,const std::vector<std::string>& appRoots);
    // Explicit fixed paths for isolated tests; never supplied by browser requests.
    Tone3000DefaultsStore(const std::filesystem::path& dataRoot,const std::filesystem::path& serviceFile,
                         std::vector<std::filesystem::path> appFiles);
    Tone3000DefaultsResult Get() const;
    Tone3000DefaultsResult Save(const Tone3000DefaultsRequest& request);
    static void Validate(const Tone3000ProcessingDefaults& defaults);
private:
    std::filesystem::path dataRoot,serviceFile;
    std::vector<std::filesystem::path> appFiles;
};
}
