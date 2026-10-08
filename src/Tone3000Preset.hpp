// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
#pragma once

#include "StateInterface.hpp"
#include "json.hpp"
#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <optional>
#include <vector>

namespace pipedal
{
    /** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.11] */
    struct Tone3000EqBand
    {
        std::string type_ = "bell";
        double freqHz_ = 1000, gainDb_ = 0, q_ = 1;
        DECLARE_JSON_MAP(Tone3000EqBand);
    };
    /** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.11] */
    struct Tone3000EqState
    {
        bool enabled_ = true, pre_ = false;
        std::vector<Tone3000EqBand> bands_;
        DECLARE_JSON_MAP(Tone3000EqState);
    };
    /** Stored requests and whitelisted identity; never model readiness.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [DES-SEC] [3.11]
     */
    struct Tone3000BlockSummary
    {
        std::string blockId_, lane_, type_, title_, gear_, format_;
        int index_ = 0;
        std::optional<int> activeModelId_;
        bool enabled_ = true, normalize_ = true, capabilityUnknown_ = true;
        double inputGain_ = .5, outputGain_ = .5, mix_ = 1, slimSize_ = 0;
        Tone3000EqState eq_;
        DECLARE_JSON_MAP(Tone3000BlockSummary);
    };
    /** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [DES-OPERATE] [3.11] */
    struct Tone3000StateSummary
    {
        std::string activePresetId_, activePresetName_, inputMode_ = "stereo";
        bool calibrateInput_ = false, osEnabled_ = false, stereoEnabled_ = false;
        double inputCalibrationLevel_ = 12;
        int osFactor_ = 0;
        std::string branchSide_ = "left", branchAfterBlockId_;
        std::vector<Tone3000BlockSummary> blocks_;
        DECLARE_JSON_MAP(Tone3000StateSummary);
    };
    /** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.11] */
    struct Tone3000EqBandPatch
    {
        int index_ = -1;
        std::optional<std::string> type_;
        std::optional<double> freqHz_, gainDb_, q_;
        DECLARE_JSON_MAP(Tone3000EqBandPatch);
    };
    /** Omitted/null optionals retain their exact original values.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.11]
     */
    struct Tone3000BlockPatch
    {
        std::string blockId_;
        std::optional<bool> enabled_, normalize_, eqEnabled_, eqPre_;
        std::optional<double> inputGain_, outputGain_, mix_, slimSize_;
        std::vector<Tone3000EqBandPatch> eqBands_;
        DECLARE_JSON_MAP(Tone3000BlockPatch);
    };
    /** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [DES-OPERATE] [3.11] */
    struct Tone3000StatePatch
    {
        std::optional<std::string> inputMode_;
        std::optional<bool> calibrateInput_, osEnabled_;
        std::optional<double> inputCalibrationLevel_;
        std::optional<int> osFactor_;
        std::optional<double> outputLevel_;
        std::vector<Tone3000BlockPatch> blocks_;
        DECLARE_JSON_MAP(Tone3000StatePatch);
    };
    /**
     * Stored identity and asset presence, never a DSP-readiness verdict.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [3.8]
     */
    struct Tone3000PresetInfo
    {
        std::string id;
        std::string rawId;
        std::string name;
        bool legacy = false;
        size_t embeddedBytes = 0;
        size_t modelCount = 0;
        // Cached assets, including disabled blocks and alternate model variants.
        size_t namCount = 0, irCount = 0;
    };

    /** Offline experimental states; stored assets are not a readiness verdict.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-26] [DES-MIX-MATCH] [7.33]
     */
    struct Tone3000AmpCabPartition
    {
        Lv2PluginState ampState, cabState;
        std::string ampBlockId, cabBlockId;
    };

    /**
     * Pinned v0.0.11 preset conversion without JUCE or program-index imports.
     * All failures throw std::invalid_argument before producing state.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-11] [DES-LIBRARY] [3.8]
     */
    class Tone3000Preset
    {
    public:
        static constexpr size_t MAX_BYTES = 64 * 1024 * 1024;
        static constexpr const char *PLUGIN_URI = "https://www.tone3000.com/plugin";
        static constexpr const char *STATE_URI = "https://www.tone3000.com/plugin:StateString";

        /**
         * filename is a safe full basename; section is exactly user or factory.
         * Empty legacy IDs retain the original filename stem as their identity.
         * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [3.8]
         */
        static Tone3000PresetInfo Inspect(std::span<const uint8_t> bytes,
                                         const std::string &filename,
                                         const std::string &section = "user");

        /**
         * Preserve seven session parameters and root session settings on Update.
         * Only StateString is emitted; embedded chain bytes are copied verbatim.
         * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-11] [DES-LIBRARY] [DES-STATE] [3.8]
         */
        static Lv2PluginState BuildState(std::span<const uint8_t> bytes,
                                        const std::string &filename,
                                        const std::string &section = "user",
                                        const Lv2PluginState *previous = nullptr);

        /** Whitelist saved fields; binary assets and private metadata stay opaque.
         * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [DES-OPERATE] [DES-SEC] [3.11]
         */
        static Tone3000StateSummary SummarizeState(const Lv2PluginState &state);

        /** Validated stored-state asset counts; never captures a running plugin.
         * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STAGE] [7.1]
         */
        static Tone3000PresetInfo InspectState(const Lv2PluginState &state);

        /** Export a native user preset without standalone session preferences.
         * Embedded snapshot/cache bytes are preserved exactly.
         * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-25] [DES-STAGE-EXPORT] [7.11]
         */
        static std::vector<uint8_t> ExportPreset(const Lv2PluginState &state,
                                               const std::string &rawId, const std::string &name);
        /** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.6] */
        static double OutputLevel(const Lv2PluginState &state);

        /** Pure, strict mono amp-head/cab copy. Explicit source block IDs and
         * amp-head confirmation are mandatory; combined captures stay intact.
         * Both complete states validate before return. No live import mapping.
         * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-26] [DES-MIX-MATCH] [DES-SEC] [DES-STATE] [7.33]
         */
        static Tone3000AmpCabPartition PartitionAmpCab(const Lv2PluginState &state,
            const std::string &ampBlockId, const std::string &cabBlockId, bool confirmAmpHead);

        /** Validate a sparse edit before producing a replacement full state.
         * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [FR-14] [DES-OPERATE] [DES-STATE] [3.11]
         */
        static Lv2PluginState EditState(const Lv2PluginState &state, const Tone3000StatePatch &patch);
    };
}
