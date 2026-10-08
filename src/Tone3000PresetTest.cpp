// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT

#include "pch.h"
#include "catch.hpp"
#include "Tone3000Preset.hpp"
#include <algorithm>
#include <bit>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <limits>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <tuple>
#include <vector>

using namespace pipedal;

namespace
{
    using Bytes = std::vector<uint8_t>;
    using Fields = std::vector<std::pair<std::string, Bytes>>;

    // Independent fixtures encode the published JUCE stream contract. These
    // do not call the production reader/writer or require model DSP engines.
    void Append(Bytes &target, const Bytes &value) { target.insert(target.end(), value.begin(), value.end()); }
    Bytes TextBytes(const std::string &text)
    {
        Bytes result(text.begin(), text.end());
        result.push_back(0);
        return result;
    }
    Bytes Packed(uint32_t number)
    {
        Bytes result;
        while (number) { result.push_back(number & 255); number >>= 8; }
        result.insert(result.begin(), static_cast<uint8_t>(result.size()));
        return result;
    }
    Bytes Variant(uint8_t marker, Bytes payload = {})
    {
        Bytes result = Packed(static_cast<uint32_t>(payload.size() + 1));
        result.push_back(marker);
        Append(result, payload);
        return result;
    }
    Bytes StringValue(const std::string &value) { return Variant(5, TextBytes(value)); }
    Bytes DoubleBits(uint64_t bits)
    {
        Bytes payload;
        for (int i = 0; i < 8; ++i) { payload.push_back(bits & 255); bits >>= 8; }
        return Variant(4, payload);
    }
    Bytes DoubleValue(double value) { return DoubleBits(std::bit_cast<uint64_t>(value)); }
    Bytes IntValue(int32_t value)
    {
        Bytes payload;
        uint32_t bits = std::bit_cast<uint32_t>(value);
        for (int i = 0; i < 4; ++i) { payload.push_back(bits & 255); bits >>= 8; }
        return Variant(1, payload);
    }
    Bytes Node(const std::string &tag, const Fields &properties = {}, const std::vector<Bytes> &children = {})
    {
        Bytes result = TextBytes(tag);
        Append(result, Packed(static_cast<uint32_t>(properties.size())));
        for (const auto &[name, value] : properties)
        {
            Append(result, TextBytes(name));
            Append(result, value);
        }
        Append(result, Packed(static_cast<uint32_t>(children.size())));
        for (const auto &child : children) Append(result, child);
        return result;
    }
    Bytes Param(const std::string &id, double value, const std::string &tag = "Param")
    {
        return Node(tag, {{"id", StringValue(id)}, {"value", DoubleValue(value)}});
    }
    Bytes ModelBytes()
    {
        Bytes result;
        for (int i = 0; i < 256; ++i) result.push_back(static_cast<uint8_t>(i));
        return result;
    }
    Bytes Block(const std::string &id, const std::string &type, int model = 19,
                Bytes asset = ModelBytes(), const std::vector<Bytes> *cacheOverride = nullptr,
                const std::string &metadata = "{\"title\":\"Fixture tone\",\"models\":[{\"id\":19,\"name\":\"Fixture model\"}]}")
    {
        const auto cache = Node("ModelCache", {}, cacheOverride ? *cacheOverride : std::vector<Bytes>{
            Node("CachedModel", {{"modelId", IntValue(model)}, {"data", Variant(8, asset)}})});
        return Node("ChainBlock", {{"id", StringValue(id)}, {"type", StringValue(type)},
            {"enabled", Variant(2)}, {"normalize", Variant(3)}, {"slimSize", DoubleValue(.75)},
            {"inputGain", DoubleValue(.25)}, {"outputGain", DoubleValue(.8)}, {"mix", DoubleValue(.6)},
            {"toneId", IntValue(7)}, {"activeModelId", IntValue(model)},
            {"toneJson", StringValue(metadata)}},
            {Node("Eq", {{"enabled", Variant(2)}, {"frequency", DoubleValue(1200)}}), cache});
    }
    Bytes Snapshot(const std::vector<Bytes> &left = {Block("nam", "nam")},
                   const std::vector<Bytes> &right = {Block("ir", "ir", 20, {'R', 'I', 'F', 'F', 0, 255})})
    {
        return Node("ChainSnapshot", {{"stereoEnabled", Variant(2)}, {"branchSide", StringValue("left")},
                    {"branchAfterBlockId", StringValue("nam")}},
                    {Node("ChainBlocks", {}, left), Node("RightChainBlocks", {}, right)});
    }
    Bytes PresetBody(const Bytes &snapshot = Snapshot(), const std::vector<Bytes> &params = {Param("outputLevel", .7)},
                     const std::string &id = "stored-id", const std::string &name = "Stored rig")
    {
        return Node("T3KPreset", {{"schemaVersion", IntValue(1)}, {"id", StringValue(id)}, {"name", StringValue(name)}},
                    {snapshot, Node("Params", {}, params)});
    }
    Bytes File(const Bytes &body = PresetBody(), bool legacy = false,
               const std::string &id = "stored-id", const std::string &name = "Stored rig")
    {
        Bytes result = legacy ? Bytes{'T', '3', 'K', 'B'} : Bytes{'T', '3', 'K', 'H'};
        if (!legacy)
        {
            const auto header = Node("T3KPresetHeader", {{"id", StringValue(id)}, {"name", StringValue(name)}});
            uint32_t size = static_cast<uint32_t>(header.size());
            for (int i = 0; i < 4; ++i) { result.push_back(size & 255); size >>= 8; }
            Append(result, header);
        }
        Append(result, body);
        return result;
    }
    bool Contains(const Bytes &bytes, const Bytes &needle)
    {
        return std::search(bytes.begin(), bytes.end(), needle.begin(), needle.end()) != bytes.end();
    }
    Bytes StateBytes(const Lv2PluginState &state)
    {
        const auto &data = state.values_.at(Tone3000Preset::STATE_URI).value_;
        const std::string text(data.begin(), data.end() - 1);
        const size_t dot = text.find('.');
        Bytes result(std::stoul(text.substr(0, dot)), 0);
        constexpr std::string_view alphabet = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+";
        // Independent bit-by-bit decoder, rather than the production byte shifts.
        for (size_t i = dot + 1; i < text.size(); ++i)
        {
            const auto value = alphabet.find(text[i]);
            for (size_t bit = 0; bit < 6; ++bit)
            {
                const size_t position = (i - dot - 1) * 6 + bit;
                if (position < result.size() * 8 && (value & (size_t(1) << bit)))
                    result[position / 8] |= uint8_t(1 << (position % 8));
            }
        }
        return result;
    }
    Lv2PluginState FullState(const Bytes &body)
    {
        Bytes bytes{'T', '3', 'K', 'B'};
        Append(bytes, body);
        std::string encoded = std::to_string(bytes.size()) + ".";
        constexpr std::string_view alphabet = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+";
        for (size_t bit = 0; bit < bytes.size() * 8; bit += 6)
        {
            unsigned value = 0;
            for (size_t i = 0; i < 6 && bit + i < bytes.size() * 8; ++i)
                if (bytes[(bit + i) / 8] & (1 << ((bit + i) % 8))) value |= 1 << i;
            encoded.push_back(alphabet[value]);
        }
        Lv2PluginState result;
        result.isValid_ = true;
        auto &entry = result.values_[Tone3000Preset::STATE_URI];
        entry.atomType_ = "http://lv2plug.in/ns/ext/atom#String";
        entry.flags_ = 3;
        entry.value_.assign(encoded.begin(), encoded.end());
        entry.value_.push_back(0);
        return result;
    }
    Bytes EditableBlock(const Bytes &eq, const Fields &extra = {}, const std::vector<Bytes> &other = {})
    {
        Fields fields{{"id", StringValue("nam")}, {"type", StringValue("nam")},
            {"toneId", IntValue(7)}, {"activeModelId", IntValue(19)},
            {"toneJson", StringValue("{\"title\":\"Saved amp\",\"gear\":\"amp\",\"platform\":\"nam\",\"token\":\"PRIVATE_METADATA\",\"url\":\"PRIVATE_URL\"}")}};
        for (const auto &field : extra)
        {
            const auto existing = std::find_if(fields.begin(), fields.end(), [&](const auto &value) { return value.first == field.first; });
            if (existing == fields.end()) fields.push_back(field); else existing->second = field.second;
        }
        std::vector<Bytes> children = other;
        if (!eq.empty()) children.push_back(eq);
        children.push_back(Node("ModelCache", {}, {Node("CachedModel", {{"modelId", IntValue(19)},
            {"data", Variant(8, ModelBytes())}})}));
        return Node("ChainBlock", fields, children);
    }
    template<class T> std::string Json(const T &value)
    {
        std::ostringstream out; json_writer writer(out); writer.write(value); return out.str();
    }

    Bytes AmpAsset(const std::string &gear = "amp")
    {
        const auto text = std::string("{\"version\":\"0.7.0\",\"architecture\":\"Linear\",\"config\":{\"receptive_field\":1,\"bias\":false},\"weights\":[1],\"metadata\":{\"gear_type\":\"")
            + gear + "\",\"input_level_dbu\":12,\"loudness\":-18},\"sample_rate\":48000}";
        return Bytes(text.begin(), text.end());
    }
    void Le(Bytes &bytes, uint64_t value, size_t count)
    {
        while (count--) { bytes.push_back(static_cast<uint8_t>(value)); value >>= 8; }
    }
    void Put32(Bytes &bytes, size_t offset, uint32_t value)
    {
        for (size_t i = 0; i < 4; ++i) bytes[offset + i] = static_cast<uint8_t>(value >> (8 * i));
    }
    Bytes CabAsset(uint16_t format = 1, uint16_t channels = 1, uint16_t bits = 16,
        size_t frames = 8, uint32_t rate = 48000, bool silent = false, bool junk = false)
    {
        Bytes bytes{'R','I','F','F',0,0,0,0,'W','A','V','E'};
        if (junk) Append(bytes, {'J','U','N','K',1,0,0,0,123,0});
        Append(bytes, {'f','m','t',' ',16,0,0,0});
        const auto align = channels * bits / 8;
        Le(bytes,format,2); Le(bytes,channels,2); Le(bytes,rate,4); Le(bytes,rate*align,4);
        Le(bytes,align,2); Le(bytes,bits,2);
        Append(bytes, {'d','a','t','a'}); Le(bytes,frames*align,4);
        for (size_t frame = 0; frame < frames; ++frame) for (size_t channel = 0; channel < channels; ++channel) {
            const auto value = silent || frame != 0 ? uint64_t(0) : format == 3
                ? (bits == 32 ? uint64_t(std::bit_cast<uint32_t>(.25f)) : std::bit_cast<uint64_t>(.25)) : uint64_t(123);
            Le(bytes,value,bits/8);
        }
        Put32(bytes,4,static_cast<uint32_t>(bytes.size()-8));
        return bytes;
    }
    Bytes StageBlock(bool amp, const Bytes &asset, const Fields &extra = {}, const std::string &gear = "",
        bool alternate = true)
    {
        Fields fields{{"id",StringValue(amp?"amp-id":"cab-id")}, {"type",StringValue(amp?"nam":"ir")},
            {"enabled",Variant(2)}, {"normalize",Variant(2)}, {"slimSize",DoubleValue(.75)},
            {"inputGain",DoubleValue(.35)}, {"outputGain",DoubleValue(.65)}, {"mix",DoubleValue(.9)},
            {"activeModelId",IntValue(amp?19:20)}, {"toneId",IntValue(amp?7:8)},
            {"toneJson",StringValue(std::string("{\"gear\":\"") + (gear.empty()?(amp?"amp":"cab"):gear)
                + "\",\"title\":\"Source block\",\"models\":[{\"id\":" + (amp?"19":"20") + "},{\"id\":21}]}")}};
        for (const auto &field : extra) {
            const auto found = std::find_if(fields.begin(),fields.end(),[&](const auto &p){return p.first==field.first;});
            if (found==fields.end()) fields.push_back(field); else *found=field;
        }
        std::vector<Bytes> cache{Node("CachedModel",{{"modelId",IntValue(amp?19:20)},{"data",Variant(8,asset)}})};
        if (alternate) cache.push_back(Node("CachedModel",{{"modelId",IntValue(21)}, {"data",Variant(8,{'A','L','T',99})}}));
        return Node("ChainBlock",fields,{Node("Eq",{{"enabled",Variant(2)},{"pre",Variant(2)}},
            {Node("Band",{{"type",StringValue("lowcut")},{"freqHz",DoubleValue(85)},{"gainDb",DoubleValue(0)},{"q",DoubleValue(.7)}})}),
            Node("ModelCache",{},cache)});
    }
    Lv2PluginState PartitionFixture(const std::vector<Bytes> &blocks = {StageBlock(true,AmpAsset()),StageBlock(false,CabAsset())},
        const Fields &rootExtra = {}, const Fields &snapshotExtra = {}, const std::vector<Bytes> &params = {},
        const std::vector<Bytes> &right = {})
    {
        Fields root{{"schemaVersion",IntValue(1)},{"activePresetId",StringValue("user:amp-and-cab")},
            {"activePresetName",StringValue("Original rig")},{"inputMode",StringValue("left")}};
        Fields snapshot{{"stereoEnabled",Variant(3)},{"branchSide",StringValue("left")},{"branchAfterBlockId",StringValue("")}};
        for (auto pair : {std::pair(&root,&rootExtra),std::pair(&snapshot,&snapshotExtra)})
            for (const auto &field : *pair.second) {
                auto found=std::find_if(pair.first->begin(),pair.first->end(),[&](const auto &p){return p.first==field.first;});
                if (found==pair.first->end()) pair.first->push_back(field); else *found=field;
            }
        return FullState(Node("TONE3000State",root,{Node("PARAMETERS",{},params),
            Node("MidiMappings",{}, {Node("Mapping",{{"cc",IntValue(64)}})}),
            Node("ChainSnapshot",snapshot,{Node("ChainBlocks",{},blocks),Node("RightChainBlocks",{},right)})}));
    }
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-EXPORT] [7.11] */
TEST_CASE("Native user export preserves assets and excludes session settings", "[tone3000_preset]")
{
    const auto original = Tone3000Preset::BuildState(File(PresetBody(Snapshot(),
        {Param("outputLevel", .61), Param("pitchSemitones", -2), Param("chainPanLeft", .18)})), "source.t3kpreset");
    Tone3000StatePatch patch;
    patch.calibrateInput_ = true; patch.inputCalibrationLevel_ = 17; patch.osEnabled_ = true; patch.osFactor_ = 2;
    const auto edited = Tone3000Preset::EditState(original, patch);
    const auto exported = Tone3000Preset::ExportPreset(edited, "pipedal-rx-6-26", "Rx working copy");
    const auto info = Tone3000Preset::Inspect(exported, "pipedal-rx-6-26.t3kpreset");
    CHECK(info.id == "user:pipedal-rx-6-26"); CHECK(info.name == "Rx working copy");
    CHECK(info.namCount == 1); CHECK(info.irCount == 1);
    CHECK(Contains(exported, Snapshot()));
    CHECK(Contains(exported, Param("outputLevel", .61)));
    CHECK(Contains(exported, Param("pitchSemitones", -2)));
    CHECK(Contains(exported, Param("chainPanLeft", .18)));
    for (const auto& session : {"targetLoudness", "calibrateInput", "inputCalibrationLevel",
                               "chainSoloLeft", "chainSoloRight", "osEnabled", "osFactor", "inputMode", "MidiMappings"})
        CHECK_FALSE(Contains(exported, TextBytes(session)));
    auto imported = Tone3000Preset::BuildState(exported, "pipedal-rx-6-26.t3kpreset");
    CHECK(Contains(StateBytes(imported), Snapshot()));
    CHECK(Contains(StateBytes(imported), Param("outputLevel", .61, "PARAM")));
    auto retained = Tone3000Preset::BuildState(exported, "pipedal-rx-6-26.t3kpreset", "user", &edited);
    CHECK(Tone3000Preset::SummarizeState(retained).inputCalibrationLevel_ == 17);
    CHECK(Tone3000Preset::SummarizeState(retained).osFactor_ == 2);
    CHECK_THROWS(Tone3000Preset::ExportPreset(edited, "../outside", "Rx"));
    CHECK_THROWS(Tone3000Preset::ExportPreset(edited, "valid", ""));
    CHECK_THROWS(Tone3000Preset::ExportPreset(Lv2PluginState{}, "valid", "Rx"));
}

/**
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-11] [DES-LIBRARY] [DES-STATE] [3.8]
 */
TEST_CASE("Direct TONE3000 state retains opaque chain and embedded NAM/IR bytes", "[tone3000_preset][Build]")
{
    const auto snapshot = Snapshot();
    const auto source = File(PresetBody(snapshot));
    const auto info = Tone3000Preset::Inspect(source, "source.t3kpreset", "factory");
    REQUIRE(info.id == "factory:stored-id");
    REQUIRE(info.rawId == "stored-id");
    REQUIRE(info.name == "Stored rig");
    REQUIRE_FALSE(info.legacy);
    REQUIRE(info.modelCount == 2);
    REQUIRE(info.embeddedBytes == 262);
    const auto state = Tone3000Preset::BuildState(source, "source.t3kpreset", "factory");
    REQUIRE(state.isValid_);
    REQUIRE(state.values_.size() == 1);
    const auto &entry = state.values_.at(Tone3000Preset::STATE_URI);
    REQUIRE(entry.flags_ == 3);
    REQUIRE(entry.atomType_ == "http://lv2plug.in/ns/ext/atom#String");
    REQUIRE(entry.value_.back() == 0);
    const auto raw = StateBytes(state);
    REQUIRE((Bytes(raw.begin(), raw.begin() + 4) == Bytes{'T', '3', 'K', 'B'}));
    REQUIRE(Contains(raw, snapshot));
    REQUIRE(Contains(raw, ModelBytes()));
    REQUIRE(Contains(raw, Param("outputLevel", .7, "PARAM")));
    REQUIRE_FALSE(Contains(raw, TextBytes("Program")));
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [3.8] */
TEST_CASE("Legacy TONE3000 identity retains filename stem and Unicode name", "[tone3000_preset][Build]")
{
    const auto bytes = File(PresetBody(Snapshot(), {}, "", "Töne 🎸"), true);
    const auto info = Tone3000Preset::Inspect(bytes, "original-guid.t3kpreset");
    REQUIRE(info.legacy);
    REQUIRE(info.rawId.empty());
    REQUIRE(info.id == "user:original-guid");
    REQUIRE(info.name == "Töne 🎸");
    REQUIRE(Contains(StateBytes(Tone3000Preset::BuildState(bytes, "original-guid.t3kpreset")),
                     StringValue("user:original-guid")));
    const auto blank = File(PresetBody(Snapshot(), {}, "", ""), true);
    REQUIRE(Tone3000Preset::Inspect(blank, "legacy.t3kpreset").name == "legacy");
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-11] [DES-LIBRARY] [3.8] */
TEST_CASE("Absent preset fields receive pinned denormalized defaults", "[tone3000_preset][Build]")
{
    const auto raw = StateBytes(Tone3000Preset::BuildState(File(PresetBody(Snapshot(), {})), "defaults.t3kpreset"));
    // Source-pinned defaults across ordinary, log-range, boolean and choices.
    for (const auto &[id, value] : std::map<std::string, double>{
        {"inputLevel", .5}, {"outputLevel", .5}, {"toneBass", 5}, {"toneMid", 5}, {"toneTreble", 5},
        {"gateThreshold", -80}, {"gateRelease", 50}, {"gateHold", 20}, {"gateRange", 80},
        {"spreadOffset", .8125}, {"pitchStep", 1}, {"pitchTonality", 20000}, {"pitchWindow", 1},
        {"targetLoudness", -18}, {"calibrateInput", 0}, {"inputCalibrationLevel", 12},
        {"chainSoloLeft", 0}, {"chainSoloRight", 0}, {"osEnabled", 0}, {"osFactor", 0}})
        REQUIRE(Contains(raw, Param(id, value, "PARAM")));
    REQUIRE(Contains(raw, TextBytes("PARAMETERS")));
    size_t count = 0;
    auto position = raw.begin();
    const auto needle = TextBytes("PARAM");
    while ((position = std::search(position, raw.end(), needle.begin(), needle.end())) != raw.end())
    { ++count; position += needle.size(); }
    REQUIRE(count == 43);
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-11] [DES-LIBRARY] [3.8] */
TEST_CASE("Direct Update preserves seven session values routing editor and MIDI", "[tone3000_preset][Build]")
{
    const std::map<std::string, double> session{{"targetLoudness", -21}, {"calibrateInput", 1},
        {"inputCalibrationLevel", 14}, {"chainSoloLeft", 1}, {"chainSoloRight", 1}, {"osEnabled", 1}, {"osFactor", 2}};
    std::vector<Bytes> params;
    for (const auto &[id, value] : session) params.push_back(Param(id, value, "PARAM"));
    params.push_back(Param("inputLevel", .9, "PARAM"));
    const auto midi = Node("MidiMappings", {}, {Node("Mapping", {{"targetId", StringValue("toneBass")}, {"cc", IntValue(17)}})});
    const auto base = FullState(Node("TONE3000State", {{"schemaVersion", IntValue(1)},
        {"inputMode", StringValue("dual")}, {"editorScale", DoubleValue(1.5)}, {"editorExtraHeight", IntValue(72)}},
        {Node("PARAMETERS", {}, params), midi, Snapshot()}));
    const auto input = File(PresetBody(Snapshot(), {Param("inputLevel", .3), Param("osFactor", 0)}));
    const auto raw = StateBytes(Tone3000Preset::BuildState(input, "update.t3kpreset", "user", &base));
    for (const auto &[id, value] : session) REQUIRE(Contains(raw, Param(id, value, "PARAM")));
    REQUIRE(Contains(raw, Param("inputLevel", .3, "PARAM")));
    REQUIRE_FALSE(Contains(raw, Param("inputLevel", .9, "PARAM")));
    REQUIRE(Contains(raw, StringValue("dual")));
    REQUIRE(Contains(raw, DoubleValue(1.5)));
    REQUIRE(Contains(raw, IntValue(72)));
    REQUIRE(Contains(raw, midi));
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [3.8] */
TEST_CASE("Legacy transpose parameter IDs migrate and ambiguous entries fail", "[tone3000_preset][Build]")
{
    const auto source = File(PresetBody(Snapshot(), {Param("transposeSemitones", -7), Param("transposeWindow", 2)}));
    const auto raw = StateBytes(Tone3000Preset::BuildState(source, "legacy.t3kpreset"));
    REQUIRE(Contains(raw, Param("pitchSemitones", -7, "PARAM")));
    REQUIRE(Contains(raw, Param("pitchWindow", 2, "PARAM")));
    REQUIRE_FALSE(Contains(raw, TextBytes("transposeSemitones")));
    const auto ambiguous = File(PresetBody(Snapshot(), {Param("transposeEnabled", 1), Param("pitchEnabled", 0)}));
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(ambiguous, "ambiguous.t3kpreset"), std::invalid_argument);
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [DES-SEC] [3.8] */
TEST_CASE("TONE3000 codec rejects identity framing truncation and size violations", "[tone3000_preset][Build]")
{
    const auto valid = File();
    for (size_t length = 0; length < valid.size(); ++length)
        REQUIRE_THROWS_AS(Tone3000Preset::Inspect(std::span<const uint8_t>(valid.data(), length), "fixture.t3kpreset"), std::invalid_argument);
    auto trailing = valid; trailing.push_back(0);
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(trailing, "fixture.t3kpreset"), std::invalid_argument);
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(PresetBody(), false, "other-id"), "fixture.t3kpreset"), std::invalid_argument);
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(PresetBody(), false, "stored-id", "other-name"), "fixture.t3kpreset"), std::invalid_argument);
    for (auto name : {"../escape.t3kpreset", "folder\\escape.t3kpreset", ".hidden.t3kpreset", "bad.txt", "bad?.t3kpreset"})
        REQUIRE_THROWS_AS(Tone3000Preset::Inspect(valid, name), std::invalid_argument);
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(valid, "fixture.t3kpreset", "untrusted"), std::invalid_argument);
    const Bytes excessive(Tone3000Preset::MAX_BYTES + 1);
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(excessive, "fixture.t3kpreset"), std::invalid_argument);
    auto negativeHeader = valid;
    std::fill(negativeHeader.begin() + 4, negativeHeader.begin() + 8, 255);
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(negativeHeader, "fixture.t3kpreset"), std::invalid_argument);
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [DES-SEC] [3.8] */
TEST_CASE("TONE3000 codec rejects invalid typed finite and duplicate data", "[tone3000_preset][Build]")
{
    for (uint64_t bits : {0x7ff8000000000000ULL, 0x7ff0000000000000ULL, 0xfff0000000000000ULL})
    {
        const auto bad = Node("Param", {{"id", StringValue("inputLevel")}, {"value", DoubleBits(bits)}});
        REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(PresetBody(Snapshot(), {bad})), "finite.t3kpreset"), std::invalid_argument);
    }
    for (const auto &param : std::vector<Bytes>{Param("inputLevel", 2), Param("osFactor", .5), Param("unknown", .5),
        Node("Param", {{"id", StringValue("inputLevel")}, {"value", StringValue("0.5")}}),
        Node("Param", {{"id", StringValue("inputLevel")}, {"id", StringValue("outputLevel")}, {"value", DoubleValue(.5)}})})
        REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(PresetBody(Snapshot(), {param})), "typed.t3kpreset"), std::invalid_argument);
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(PresetBody(Snapshot(), {Param("inputLevel", .3), Param("inputLevel", .4)})),
        "duplicate.t3kpreset"), std::invalid_argument);
    const auto future = Node("T3KPreset", {{"schemaVersion", IntValue(2)}}, {Snapshot(), Node("Params")});
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(future, true), "future.t3kpreset"), std::invalid_argument);
    const auto nested = Node("T3KPreset", {{"schemaVersion", IntValue(1)}, {"schemaVersion", IntValue(1)}}, {Snapshot(), Node("Params")});
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(nested, true), "duplicate.t3kpreset"), std::invalid_argument);
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-11] [DES-LIBRARY] [DES-SEC] [3.8] */
TEST_CASE("TONE3000 snapshot requires supported unique blocks and active embedded data", "[tone3000_preset][Build]")
{
    for (const auto &snapshot : std::vector<Bytes>{
        Snapshot({Block("amp", "unknown")}), Snapshot({Block("amp", "nam", 19, {})}),
        Snapshot({Block("same", "nam")}, {Block("same", "ir")}),
        Node("ChainSnapshot", {}, {Node("ChainBlocks"), Node("ChainBlocks")})})
        REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(PresetBody(snapshot)), "assets.t3kpreset"), std::invalid_argument);
    const std::vector<Bytes> wrong{Node("CachedModel", {{"modelId", IntValue(20)}, {"data", Variant(8, {1, 2})}})};
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(PresetBody(Snapshot({Block("amp", "nam", 19, {}, &wrong)}))),
        "wrong-active.t3kpreset"), std::invalid_argument);
    const std::vector<Bytes> duplicates{Node("CachedModel", {{"modelId", IntValue(19)}, {"data", Variant(8, {1})}}),
        Node("CachedModel", {{"modelId", IntValue(19)}, {"data", Variant(8, {2})}})};
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(PresetBody(Snapshot({Block("amp", "nam", 19, {}, &duplicates)}))),
        "duplicate-cache.t3kpreset"), std::invalid_argument);
    const auto insert = Node("ChainBlock", {{"id", StringValue("insert")}, {"type", StringValue("insert")}});
    REQUIRE_NOTHROW(Tone3000Preset::Inspect(File(PresetBody(Snapshot({insert}, {}))), "empty.t3kpreset"));
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [DES-SEC] [3.8] */
TEST_CASE("TONE3000 codec rejects malformed previous state and bounded nesting", "[tone3000_preset][Build]")
{
    const auto source = File();
    auto previous = Tone3000Preset::BuildState(source, "source.t3kpreset");
    previous.values_["https://www.tone3000.com/plugin:Program"] = Lv2PluginStateEntry();
    REQUIRE_THROWS_AS(Tone3000Preset::BuildState(source, "source.t3kpreset", "user", &previous), std::invalid_argument);
    previous = Tone3000Preset::BuildState(source, "source.t3kpreset");
    previous.isValid_ = false;
    REQUIRE_THROWS_AS(Tone3000Preset::BuildState(source, "source.t3kpreset", "user", &previous), std::invalid_argument);
    previous = Tone3000Preset::BuildState(source, "source.t3kpreset");
    previous.values_.begin()->second.value_.back() = 'X';
    REQUIRE_THROWS_AS(Tone3000Preset::BuildState(source, "source.t3kpreset", "user", &previous), std::invalid_argument);
    Bytes child = Node("Nested");
    for (int i = 0; i < 70; ++i) child = Node("Nested", {}, {child});
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(child, true), "deep.t3kpreset"), std::invalid_argument);
    Bytes tooMany = TextBytes("T3KPreset"); Append(tooMany, Packed(10001));
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(tooMany, true), "counts.t3kpreset"), std::invalid_argument);
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [DES-SEC] [3.8] */
TEST_CASE("TONE3000 tone metadata requires bounded strict finite JSON", "[tone3000_preset][Build]")
{
    for (const std::string metadata : {"[]", "{}{}", "{\"a\":1 \"b\":2}", "{\"a\":1,}",
         "{\"a\":[1,]}", "{\"a\":01}", "{\"a\":NaN}", "{\"a\":1e999}",
         "{\"a\":1,\"a\":2}", "{\"a\":1,\"\\u0061\":2}", "{\"a\":\"\\q\"}"})
    {
        const auto block = Block("nam", "nam", 19, ModelBytes(), nullptr, metadata);
        REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(PresetBody(Snapshot({block}, {}))), "metadata.t3kpreset"),
                          std::invalid_argument);
    }
    const std::string nested = "{\"a\":" + std::string(70, '[') + "0" + std::string(70, ']') + "}";
    const auto deep = Block("nam", "nam", 19, ModelBytes(), nullptr, nested);
    REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(PresetBody(Snapshot({deep}, {}))), "metadata.t3kpreset"),
                      std::invalid_argument);
    const auto valid = Block("nam", "nam", 19, ModelBytes(), nullptr,
                            " {\"a\":[true,false,null,-1.2e+3,\"\\u0061 [ {} ]\"]} \n");
    REQUIRE_NOTHROW(Tone3000Preset::Inspect(File(PresetBody(Snapshot({valid}, {}))), "metadata.t3kpreset"));
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [DES-SEC] [3.11] */
TEST_CASE("TONE3000 state summary exposes saved requests and compact identities only", "[tone3000_operate][Build]")
{
    const auto state = Tone3000Preset::BuildState(File(PresetBody(Snapshot({EditableBlock({})}))), "source.t3kpreset");
    const auto summary = Tone3000Preset::SummarizeState(state);
    REQUIRE(summary.activePresetId_ == "user:stored-id");
    REQUIRE(summary.activePresetName_ == "Stored rig");
    REQUIRE(summary.inputMode_ == "stereo");
    REQUIRE(summary.blocks_.size() == 2);
    const auto &block = summary.blocks_[0];
    REQUIRE(block.lane_ == "left"); REQUIRE(block.index_ == 0);
    REQUIRE(block.title_ == "Saved amp"); REQUIRE(block.gear_ == "amp"); REQUIRE(block.format_ == "nam");
    REQUIRE(block.activeModelId_ == 19); REQUIRE(block.capabilityUnknown_);
    REQUIRE(block.enabled_); REQUIRE(block.normalize_);
    REQUIRE(block.eq_.bands_.size() == 6);
    REQUIRE(block.eq_.bands_[0].type_ == "lowshelf"); REQUIRE(block.eq_.bands_[0].freqHz_ == 100);
    REQUIRE(block.eq_.bands_[4].q_ == double(1.4f));
    REQUIRE(block.eq_.bands_[5].type_ == "highshelf"); REQUIRE(block.eq_.bands_[5].freqHz_ == 8000);
    REQUIRE(summary.blocks_[1].lane_ == "right"); REQUIRE(summary.blocks_[1].type_ == "ir");
    for (const std::string secret : {"PRIVATE_METADATA", "PRIVATE_URL", "toneJson", "ModelCache", "CachedModel"})
        REQUIRE(Json(summary).find(secret) == std::string::npos);
    REQUIRE(Contains(StateBytes(state), EditableBlock({}))); // Displaying legacy defaults does not rewrite the block.
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-14] [DES-OPERATE] [DES-STATE] [3.11] */
TEST_CASE("TONE3000 sparse processing edits preserve raw trees and unrelated LV2 state", "[tone3000_operate][Build]")
{
    const auto snapshot = Snapshot();
    const auto mappings = Node("MidiMappings", {{"private", StringValue("keep")}}, {Node("Mapping", {{"cc", IntValue(17)}})});
    const auto extension = Node("FutureRoot", {{"opaque", Variant(8, {0, 255, 9})}});
    auto state = FullState(Node("TONE3000State", {{"schemaVersion", IntValue(1)}, {"inputMode", StringValue("right")},
        {"activePresetId", StringValue("user:stored-id")}, {"unknown", StringValue("retain")}},
        {Node("PARAMETERS", {}, {Param("outputLevel", .7, "PARAM")}), snapshot, mappings, extension}));
    state.values_["urn:other"] = state.values_.at(Tone3000Preset::STATE_URI);
    const auto original = state;
    Tone3000StatePatch patch; patch.calibrateInput_ = false; patch.inputCalibrationLevel_ = 0;
    patch.osEnabled_ = true; patch.osFactor_ = 2; patch.inputMode_ = "left";
    const auto edited = Tone3000Preset::EditState(state, patch);
    const auto summary = Tone3000Preset::SummarizeState(edited);
    REQUIRE_FALSE(summary.calibrateInput_); REQUIRE(summary.inputCalibrationLevel_ == 0);
    REQUIRE(summary.osEnabled_); REQUIRE(summary.osFactor_ == 2); REQUIRE(summary.inputMode_ == "left");
    REQUIRE(state == original); REQUIRE(edited.values_.at("urn:other") == original.values_.at("urn:other"));
    REQUIRE(edited.values_.at(Tone3000Preset::STATE_URI).flags_ == 3);
    const auto raw = StateBytes(edited);
    for (const auto &tree : {snapshot, mappings, extension, Param("outputLevel", .7, "PARAM")}) REQUIRE(Contains(raw, tree));
    REQUIRE(Contains(raw, StringValue("retain")));
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [DES-STATE] [3.11] */
TEST_CASE("TONE3000 block edits retain caches legacy EQ and unknown properties", "[tone3000_operate][Build]")
{
    const auto eq = Node("Eq", {{"enabled", Variant(2)}, {"futureEq", StringValue("keep")}});
    const auto extension = Node("FutureBlock", {{"data", Variant(8, {0, 1, 255})}});
    const auto block = EditableBlock(eq, {{"futureProperty", StringValue("unchanged")}}, {extension});
    const auto ir = Block("ir", "ir", 20, {'R', 'I', 'F', 'F', 0, 255});
    const auto state = Tone3000Preset::BuildState(File(PresetBody(Snapshot({block}, {ir}))), "source.t3kpreset");
    Tone3000StatePatch patch; Tone3000BlockPatch edit;
    edit.blockId_ = "nam"; edit.enabled_ = false; edit.normalize_ = false; edit.slimSize_ = 1;
    edit.inputGain_ = 0; edit.outputGain_ = 1; edit.mix_ = .25; patch.blocks_.push_back(edit);
    const auto edited = Tone3000Preset::EditState(state, patch);
    const auto result = Tone3000Preset::SummarizeState(edited).blocks_[0];
    REQUIRE_FALSE(result.enabled_); REQUIRE_FALSE(result.normalize_); REQUIRE(result.slimSize_ == 1);
    REQUIRE(result.inputGain_ == 0); REQUIRE(result.outputGain_ == 1); REQUIRE(result.mix_ == .25);
    const auto raw = StateBytes(edited);
    for (const auto &untouched : {eq, extension, ir, ModelBytes(), StringValue("unchanged")}) REQUIRE(Contains(raw, untouched));
    patch.blocks_[0].slimSize_ = 0;
    REQUIRE(Tone3000Preset::SummarizeState(Tone3000Preset::EditState(edited, patch)).blocks_[0].slimSize_ == 0);
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [DES-STATE] [3.11] */
TEST_CASE("TONE3000 explicit EQ edits fill missing bands using native defaults", "[tone3000_operate][Build]")
{
    const auto eq = Node("Eq", {{"enabled", Variant(2)}, {"futureEq", StringValue("keep")}});
    const auto state = Tone3000Preset::BuildState(File(PresetBody(Snapshot({EditableBlock(eq)}, {}))), "source.t3kpreset");
    Tone3000StatePatch patch; Tone3000BlockPatch edit; edit.blockId_ = "nam";
    edit.eqEnabled_ = false; edit.eqPre_ = true;
    Tone3000EqBandPatch band; band.index_ = 5; band.type_ = "highcut"; band.freqHz_ = 20000;
    band.gainDb_ = -15; band.q_ = .1; edit.eqBands_.push_back(band); patch.blocks_.push_back(edit);
    const auto edited = Tone3000Preset::EditState(state, patch);
    const auto result = Tone3000Preset::SummarizeState(edited).blocks_[0].eq_;
    REQUIRE_FALSE(result.enabled_); REQUIRE(result.pre_); REQUIRE(result.bands_.size() == 6);
    REQUIRE(result.bands_[0].freqHz_ == 100); REQUIRE(result.bands_[4].q_ == double(1.4f));
    REQUIRE(result.bands_[5].type_ == "highcut"); REQUIRE(result.bands_[5].freqHz_ == 20000);
    REQUIRE(result.bands_[5].gainDb_ == -15); REQUIRE(result.bands_[5].q_ == .1);
    REQUIRE(Contains(StateBytes(edited), StringValue("keep"))); REQUIRE(Contains(StateBytes(edited), ModelBytes()));
    REQUIRE(Contains(StateBytes(state), eq));
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [DES-OPERATE] [DES-SEC] [3.11] */
TEST_CASE("TONE3000 rejects invalid sparse edits before changing original state", "[tone3000_operate][Build]")
{
    const auto state = Tone3000Preset::BuildState(File(), "source.t3kpreset");
    const auto original = state;
    Tone3000StatePatch patch;
    REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument);
    for (const std::string input : {"invalid", "stereo", "dual"})
    { patch.inputMode_ = input; REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument); }
    patch = {}; patch.inputCalibrationLevel_ = 61;
    REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument);
    patch = {}; patch.osFactor_ = 3;
    REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument);
    Tone3000BlockPatch edit; edit.blockId_ = "missing"; edit.enabled_ = false; patch = {}; patch.blocks_ = {edit};
    REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument);
    edit.blockId_ = "nam"; patch.blocks_ = {edit, edit};
    REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument);
    for (double value : {-1., 1.01, std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()})
    { edit.mix_ = value; patch.blocks_ = {edit}; REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument); }
    edit.mix_.reset(); edit.slimSize_ = .5; patch.blocks_ = {edit};
    REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument);
    edit.slimSize_ = 0; edit.blockId_ = "ir"; patch.blocks_ = {edit};
    REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument);
    edit.slimSize_.reset(); edit.normalize_ = false; patch.blocks_ = {edit};
    REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument);
    const auto insert = Node("ChainBlock", {{"id", StringValue("slot")}, {"type", StringValue("insert")}});
    const auto insertState = Tone3000Preset::BuildState(File(PresetBody(Snapshot({insert}, {}))), "source.t3kpreset");
    edit.normalize_.reset(); edit.blockId_ = "slot"; patch.blocks_ = {edit};
    REQUIRE_THROWS_AS(Tone3000Preset::EditState(insertState, patch), std::invalid_argument);
    REQUIRE(state == original);
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [DES-SEC] [3.11] */
TEST_CASE("TONE3000 validates EQ roles ranges duplicate bands and stored field types", "[tone3000_operate][Build]")
{
    const auto state = Tone3000Preset::BuildState(File(), "source.t3kpreset");
    Tone3000StatePatch patch; Tone3000BlockPatch edit; edit.blockId_ = "nam";
    Tone3000EqBandPatch band; band.index_ = 0; band.type_ = "bell";
    edit.eqBands_ = {band}; patch.blocks_ = {edit};
    REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument);
    band.type_ = "lowcut"; band.index_ = 6; patch.blocks_[0].eqBands_ = {band};
    REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument);
    band.index_ = 0; patch.blocks_[0].eqBands_ = {band, band};
    REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument);
    for (const auto &bad : std::vector<Tone3000EqBandPatch>{
        []{Tone3000EqBandPatch b; b.index_=1; b.freqHz_=19; return b;}(),
        []{Tone3000EqBandPatch b; b.index_=1; b.gainDb_=15.1; return b;}(),
        []{Tone3000EqBandPatch b; b.index_=1; b.q_=10.1; return b;}(),
        []{Tone3000EqBandPatch b; b.index_=1; b.q_=std::numeric_limits<double>::quiet_NaN(); return b;}()})
    { patch.blocks_[0].eqBands_ = {bad}; REQUIRE_THROWS_AS(Tone3000Preset::EditState(state, patch), std::invalid_argument); }
    for (const auto &block : {
         EditableBlock({}, {{"toneId", StringValue("wrong")}}),
         EditableBlock({}, {{"mix", DoubleValue(1.1)}}),
         EditableBlock(Node("Eq", {}, {Node("Band", {{"type", StringValue("bell")}})})),
         EditableBlock(Node("Eq", {{"enabled", StringValue("true")}})),
         EditableBlock(Node("Eq"), {}, {Node("Eq")})})
    {
        REQUIRE_THROWS_AS(Tone3000Preset::Inspect(File(PresetBody(Snapshot({block}, {}))), "invalid.t3kpreset"), std::invalid_argument);
    }
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [DES-OPERATE] [3.11] */
TEST_CASE("TONE3000 sparse JSON retains optional false zero and null omissions", "[tone3000_operate][Build]")
{
    std::istringstream input(R"({"calibrateInput":false,"inputCalibrationLevel":0,"osFactor":0,"osEnabled":null,"blocks":[{"blockId":"nam","enabled":false,"mix":0,"eqBands":[{"index":1,"gainDb":0}]}]})");
    json_reader reader(input); Tone3000StatePatch patch; reader.read(&patch);
    REQUIRE(patch.calibrateInput_ == false); REQUIRE(patch.inputCalibrationLevel_ == 0); REQUIRE(patch.osFactor_ == 0);
    REQUIRE_FALSE(patch.osEnabled_); REQUIRE_FALSE(patch.inputMode_);
    REQUIRE(patch.blocks_[0].enabled_ == false); REQUIRE(patch.blocks_[0].mix_ == 0);
    REQUIRE(patch.blocks_[0].eqBands_[0].gainDb_ == 0);
    const auto state = Tone3000Preset::BuildState(File(), "source.t3kpreset");
    const auto summary = Tone3000Preset::SummarizeState(Tone3000Preset::EditState(state, patch));
    REQUIRE_FALSE(summary.calibrateInput_); REQUIRE(summary.inputCalibrationLevel_ == 0);
    REQUIRE_FALSE(summary.blocks_[0].enabled_); REQUIRE(summary.blocks_[0].mix_ == 0);
    Tone3000StateSummary reread; std::istringstream encoded(Json(summary)); json_reader rereader(encoded); rereader.read(&reread);
    REQUIRE(Json(summary) == Json(reread));
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.11] */
TEST_CASE("TONE3000 stereo routing matches native tone-only active branch rules", "[tone3000_operate][Build]")
{
    const auto insert = Node("ChainBlock", {{"id", StringValue("nam")}, {"type", StringValue("insert")}});
    for (const auto &snapshot : {Snapshot({insert}, {}), Snapshot({}, {}),
         Node("ChainSnapshot", {{"stereoEnabled", Variant(3)}, {"branchAfterBlockId", StringValue("nam")}},
             {Node("ChainBlocks", {}, {Block("nam", "nam")})})})
    {
        const auto state = Tone3000Preset::BuildState(File(PresetBody(snapshot)), "source.t3kpreset");
        for (const std::string mode : {"stereo", "dual", "left", "right"})
        {
            Tone3000StatePatch patch; patch.inputMode_ = mode;
            REQUIRE(Tone3000Preset::SummarizeState(Tone3000Preset::EditState(state, patch)).inputMode_ == mode);
        }
    }
}

/**
 * Optional source-fixture validation; supplied files stay read-only and private.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-11] [DES-LIBRARY] [3.8]
 */
TEST_CASE("Direct codec accepts the pinned real factory preset files", "[tone3000_preset_source][.]")
{
    const auto *path = std::getenv("PIPEDAL_T3K_PRESET_DIRECTORY");
    REQUIRE(path != nullptr);
    size_t count = 0;
    for (const auto &entry : std::filesystem::directory_iterator(path))
    {
        if (entry.path().extension() != ".t3kpreset") continue;
        std::ifstream input(entry.path(), std::ios::binary);
        Bytes bytes{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
        const auto name = entry.path().filename().string();
        const auto info = Tone3000Preset::Inspect(bytes, name, "factory");
        REQUIRE_FALSE(info.id.empty());
        REQUIRE(info.modelCount > 0);
        REQUIRE(info.embeddedBytes > 0);
        const auto first = Tone3000Preset::BuildState(bytes, name, "factory");
        const auto second = Tone3000Preset::BuildState(bytes, name, "factory", &first);
        REQUIRE(first == second);
        ++count;
    }
    REQUIRE(count == 8);
}

/** Cached variants (not only active assets) are counted without returning blobs.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STAGE] [7.1]
 */
TEST_CASE("Tone3000 preview counts every cached NAM and IR variant in stored state", "[gig_rig][gig_rig_codec][Build]") {
    const std::vector<Bytes> cache{
        Node("CachedModel", {{"modelId", IntValue(19)}, {"data", Variant(8, {0,1,2,3})}}),
        Node("CachedModel", {{"modelId", IntValue(20)}, {"data", Variant(8, {4,5})}})};
    auto bypassed=Block("amp", "nam", 19, {}, &cache);
    // Set the independent fixture enabled=false before encoding the full tree.
    const auto enabled=TextBytes("enabled");
    const auto at=std::search(bypassed.begin(),bypassed.end(),enabled.begin(),enabled.end());
    REQUIRE(at!=bypassed.end());
    *(at+enabled.size()+2)=3; // compressed payload-length byte then bool marker
    const auto file=File(PresetBody(Snapshot({bypassed},{Block("cab","ir",21,{8,9,10})})));
    const auto info=Tone3000Preset::Inspect(file,"rig.t3kpreset");
    REQUIRE(info.namCount==2); REQUIRE(info.irCount==1); REQUIRE(info.modelCount==2); REQUIRE(info.embeddedBytes==9);
    const auto state=Tone3000Preset::BuildState(file,"rig.t3kpreset");
    const auto before=state.values_.at(Tone3000Preset::STATE_URI).value_;
    const auto stored=Tone3000Preset::InspectState(state);
    REQUIRE(stored.namCount==2); REQUIRE(stored.irCount==1); REQUIRE(stored.embeddedBytes==9);
    REQUIRE_FALSE(Tone3000Preset::SummarizeState(state).blocks_.front().enabled_);
    REQUIRE(state.values_.at(Tone3000Preset::STATE_URI).value_==before);
    auto bad=state; bad.values_.at(Tone3000Preset::STATE_URI).value_={'b','a','d',0};
    REQUIRE_THROWS(Tone3000Preset::InspectState(bad));
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-26] [DES-MIX-MATCH] [7.33] */
TEST_CASE("Offline amp cab partition preserves full blocks and separates DSP ownership", "[gig_rig][gig_rig_codec][tone3000_partition]")
{
    const auto amp=StageBlock(true,AmpAsset()), cab=StageBlock(false,CabAsset());
    const auto insert=Node("ChainBlock",{{"id",StringValue("empty-slot")},{"type",StringValue("insert")}});
    auto source=PartitionFixture({insert,amp,cab},{},{},{Param("inputLevel",.6,"PARAM"),Param("pitchEnabled",1,"PARAM"),
        Param("pitchSemitones",-2,"PARAM"),Param("gateThreshold",-65,"PARAM"),Param("calibrateInput",1,"PARAM"),
        Param("inputCalibrationLevel",17,"PARAM"),Param("targetLoudness",-20,"PARAM"),Param("toneBass",6,"PARAM"),
        Param("outputLevel",.7,"PARAM")});
    source.values_["urn:unrelated-private-entry"].value_={1,2,3};
    const auto before=source;
    const auto parts=Tone3000Preset::PartitionAmpCab(source,"amp-id","cab-id",true);
    CHECK(source==before);
    CHECK(parts.ampBlockId=="amp-id"); CHECK(parts.cabBlockId=="cab-id");
    const auto ampBytes=StateBytes(parts.ampState), cabBytes=StateBytes(parts.cabState);
    CHECK(Contains(ampBytes,amp)); CHECK_FALSE(Contains(ampBytes,cab));
    CHECK(Contains(cabBytes,cab)); CHECK_FALSE(Contains(cabBytes,amp));
    CHECK_FALSE(Contains(ampBytes,insert)); CHECK_FALSE(Contains(cabBytes,insert));
    for (const auto *state : {&parts.ampState,&parts.cabState}) {
        CHECK(state->values_.size()==1); CHECK(state->isValid_);
        CHECK(state->values_.at(Tone3000Preset::STATE_URI).flags_==3);
        CHECK(Contains(StateBytes(*state),Node("MidiMappings")));
        CHECK_FALSE(Contains(StateBytes(*state),TextBytes("Mapping")));
        const auto summary=Tone3000Preset::SummarizeState(*state);
        CHECK(summary.blocks_.size()==1); CHECK_FALSE(summary.osEnabled_); CHECK_FALSE(summary.stereoEnabled_);
        CHECK(summary.branchAfterBlockId_.empty());
        CHECK(summary.blocks_[0].slimSize_==.75); CHECK(summary.blocks_[0].inputGain_==.35);
        CHECK(summary.blocks_[0].outputGain_==.65); CHECK(summary.blocks_[0].mix_==.9);
        CHECK(summary.blocks_[0].normalize_); CHECK(summary.blocks_[0].eq_.pre_);
        CHECK(summary.blocks_[0].eq_.bands_[0].freqHz_==85);
    }
    CHECK(Tone3000Preset::InspectState(parts.ampState).namCount==2);
    CHECK(Tone3000Preset::InspectState(parts.cabState).irCount==2);
    CHECK(Tone3000Preset::SummarizeState(parts.ampState).calibrateInput_);
    CHECK_FALSE(Tone3000Preset::SummarizeState(parts.cabState).calibrateInput_);
    CHECK(Tone3000Preset::SummarizeState(parts.ampState).inputCalibrationLevel_==17);
    CHECK(Tone3000Preset::SummarizeState(parts.ampState).activePresetId_!=Tone3000Preset::SummarizeState(parts.cabState).activePresetId_);
    for (const auto &[id,value] : std::map<std::string,double>{{"inputLevel",.6},{"pitchEnabled",1},{"pitchSemitones",-2},
        {"gateThreshold",-65},{"targetLoudness",-20},{"toneEqEnabled",0},{"outputLevel",.5},{"chainPanLeft",0},{"chainPanRight",1}})
        CHECK(Contains(ampBytes,Param(id,value,"PARAM")));
    for (const auto &[id,value] : std::map<std::string,double>{{"inputLevel",.5},{"pitchEnabled",0},{"gateEnabled",0},
        {"toneBass",6},{"outputLevel",.7},{"chainPanLeft",0},{"chainPanRight",1}})
        CHECK(Contains(cabBytes,Param(id,value,"PARAM")));
    for (const auto &[state,block,id] : {std::tuple(&parts.ampState,&amp,"derived-amp"),std::tuple(&parts.cabState,&cab,"derived-cab")}) {
        const auto file=Tone3000Preset::ExportPreset(*state,id,id);
        const auto imported=Tone3000Preset::BuildState(file,std::string(id)+".t3kpreset","user",state);
        CHECK(Contains(StateBytes(imported),*block)); CHECK(Tone3000Preset::InspectState(imported).modelCount==1);
    }
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-MIX-MATCH] [DES-SEC] [7.33] */
TEST_CASE("Offline amp cab partition refuses unsupported source identity routing and processing", "[gig_rig][gig_rig_codec][tone3000_partition]")
{
    auto partition=[](const Lv2PluginState &state){return Tone3000Preset::PartitionAmpCab(state,"amp-id","cab-id",true);};
    const auto valid=PartitionFixture();
    CHECK_THROWS(Tone3000Preset::PartitionAmpCab(valid,"amp-id","cab-id",false));
    CHECK_THROWS(Tone3000Preset::PartitionAmpCab(valid,"unknown","cab-id",true));
    CHECK_THROWS(Tone3000Preset::PartitionAmpCab(valid,"amp-id","amp-id",true));
    CHECK_THROWS(partition(Lv2PluginState{}));
    auto bad=valid; bad.values_["https://www.tone3000.com/plugin:Program"]={}; CHECK_THROWS(partition(bad));
    for (const auto &mode : {"stereo","dual"}) CHECK_THROWS(partition(PartitionFixture({},{{"inputMode",StringValue(mode)}})));
    const auto amp=StageBlock(true,AmpAsset()),cab=StageBlock(false,CabAsset());
    CHECK_THROWS(partition(PartitionFixture({cab,amp})));
    CHECK_THROWS(partition(PartitionFixture({amp,cab,cab})));
    CHECK_THROWS(partition(PartitionFixture({amp,cab},{},{{"stereoEnabled",Variant(2)}})));
    CHECK_THROWS(partition(PartitionFixture({amp,cab},{},{{"branchAfterBlockId",StringValue("amp-id")}})));
    CHECK_THROWS(partition(PartitionFixture({amp},{},{},{},{cab})));
    CHECK_THROWS(partition(PartitionFixture({StageBlock(true,AmpAsset(),{{"enabled",Variant(3)}}),cab})));
    for (const auto &gear : {"amp-cab","space","experimental","unknown"})
        CHECK_THROWS(partition(PartitionFixture({StageBlock(true,AmpAsset(),{},gear),cab})));
    CHECK_THROWS(partition(PartitionFixture({StageBlock(true,AmpAsset("amp_cab")),cab})));
    CHECK_THROWS(partition(PartitionFixture({amp,StageBlock(false,CabAsset(),{},"space")})));
    CHECK_THROWS(partition(PartitionFixture({amp,cab},{{"activePresetId",StringValue(std::string(481,'a'))}})));
    CHECK_THROWS(partition(PartitionFixture({amp,cab},{{"activePresetName",StringValue(std::string(479,'a')+"é")}})));
    CHECK_NOTHROW(partition(PartitionFixture({StageBlock(true,AmpAsset(" AMP ")),cab})));
    for (const auto &id : {"osEnabled","spreadEnabled","alignEnabled","chainSoloLeft","chainSoloRight","chainInvertLeft","chainInvertRight"})
        CHECK_THROWS(partition(PartitionFixture({amp,cab},{},{},{Param(id,1,"PARAM")})));
    for (const auto &[id,value] : std::map<std::string,double>{{"outputBalance",.6},{"chainPanLeft",.3},{"chainPanRight",.7}})
        CHECK_THROWS(partition(PartitionFixture({amp,cab},{},{},{Param(id,value,"PARAM")})));
    auto right=partition(PartitionFixture({amp,cab},{{"inputMode",StringValue("right")}}));
    CHECK(Tone3000Preset::SummarizeState(right.ampState).inputMode_=="right");
    CHECK(Tone3000Preset::SummarizeState(right.cabState).inputMode_=="left");
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-MIX-MATCH] [DES-SEC] [7.33] */
TEST_CASE("Offline amp cab partition validates actual active mono short assets", "[gig_rig][gig_rig_codec][tone3000_partition]")
{
    auto partition=[](const Bytes &wav){return Tone3000Preset::PartitionAmpCab(PartitionFixture({StageBlock(true,AmpAsset()),StageBlock(false,wav)}),"amp-id","cab-id",true);};
    for (const auto &[format,bits] : {std::pair(1,16),std::pair(1,24),std::pair(1,32),std::pair(3,32),std::pair(3,64)})
        CHECK_NOTHROW(partition(CabAsset(format,1,bits,8,48000,false,true)));
    CHECK_NOTHROW(partition(CabAsset(1,1,16,48000)));
    CHECK_THROWS(partition(CabAsset(1,1,16,48001)));
    CHECK_THROWS(partition(CabAsset(1,2)));
    CHECK_THROWS(partition(CabAsset(1,1,16,8,48000,true)));
    CHECK_THROWS(partition(CabAsset(3,1,32,8,48000,true)));
    CHECK_THROWS(partition(CabAsset(1,1,8)));
    CHECK_THROWS(partition(CabAsset(0xfffe)));
    CHECK_THROWS(partition({'R','I','F','F'}));
    auto wav=CabAsset();
    wav[0]='X'; CHECK_THROWS(partition(wav));
    wav=CabAsset(); Put32(wav,4,1); CHECK_THROWS(partition(wav));
    wav=CabAsset(); Put32(wav,16,0xffffffff); CHECK_THROWS(partition(wav));
    wav=CabAsset(); Put32(wav,28,1); CHECK_THROWS(partition(wav));
    wav=CabAsset(); wav[32]=4; CHECK_THROWS(partition(wav));
    wav=CabAsset(); wav.pop_back(); Put32(wav,4,wav.size()-8); CHECK_THROWS(partition(wav));
    wav=CabAsset(); const Bytes duplicateFmt(wav.begin()+12,wav.begin()+36); Append(wav,duplicateFmt); Put32(wav,4,wav.size()-8); CHECK_THROWS(partition(wav));
    wav=CabAsset(); Append(wav,{'d','a','t','a',0,0,0,0}); Put32(wav,4,wav.size()-8); CHECK_THROWS(partition(wav));
    wav=CabAsset(); Bytes reordered{'R','I','F','F',0,0,0,0,'W','A','V','E'};
    reordered.insert(reordered.end(),wav.begin()+36,wav.end()); reordered.insert(reordered.end(),wav.begin()+12,wav.begin()+36);
    Put32(reordered,4,reordered.size()-8); CHECK_NOTHROW(partition(reordered));
    for (const auto value : {std::numeric_limits<float>::quiet_NaN(),std::numeric_limits<float>::infinity()}) {
        wav=CabAsset(3,1,32); Put32(wav,44,std::bit_cast<uint32_t>(value)); CHECK_THROWS(partition(wav));
    }
    wav=CabAsset(3,1,64); Put32(wav,48,0x7ff00000); CHECK_THROWS(partition(wav));
    wav=CabAsset(3,1,64); const auto enormous=std::bit_cast<uint64_t>(1e300); Put32(wav,44,static_cast<uint32_t>(enormous)); Put32(wav,48,static_cast<uint32_t>(enormous >> 32)); CHECK_THROWS(partition(wav));
    // The native format reader writes float buffers. A finite double-only
    // impulse that disappears on conversion is still a silent active IR.
    wav=CabAsset(3,1,64,8,48000,true); const auto underflow=std::bit_cast<uint64_t>(1e-300);
    Put32(wav,44,static_cast<uint32_t>(underflow)); Put32(wav,48,static_cast<uint32_t>(underflow >> 32));
    CHECK_THROWS(partition(wav));
    for (const auto &asset : {Bytes{},ModelBytes(),Bytes{'{','}'},Bytes{'{','"','w','e','i','g','h','t','s','"',':','[','N','a','N',']','}'}})
        CHECK_THROWS(Tone3000Preset::PartitionAmpCab(PartitionFixture({StageBlock(true,asset),StageBlock(false,CabAsset())}),"amp-id","cab-id",true));
}
