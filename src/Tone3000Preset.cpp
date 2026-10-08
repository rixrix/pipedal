// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT

#include "Tone3000Preset.hpp"
#include "json_variant.hpp"
#include <algorithm>
#include <array>
#include <bit>
#include <charconv>
#include <cmath>
#include <cstring>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <vector>

using namespace pipedal;

JSON_MAP_BEGIN(Tone3000EqBand)
JSON_MAP_REFERENCE(Tone3000EqBand, type)
JSON_MAP_REFERENCE(Tone3000EqBand, freqHz)
JSON_MAP_REFERENCE(Tone3000EqBand, gainDb)
JSON_MAP_REFERENCE(Tone3000EqBand, q)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000EqState)
JSON_MAP_REFERENCE(Tone3000EqState, enabled)
JSON_MAP_REFERENCE(Tone3000EqState, pre)
JSON_MAP_REFERENCE(Tone3000EqState, bands)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000BlockSummary)
JSON_MAP_REFERENCE(Tone3000BlockSummary, blockId)
JSON_MAP_REFERENCE(Tone3000BlockSummary, lane)
JSON_MAP_REFERENCE(Tone3000BlockSummary, index)
JSON_MAP_REFERENCE(Tone3000BlockSummary, type)
JSON_MAP_REFERENCE(Tone3000BlockSummary, title)
JSON_MAP_REFERENCE(Tone3000BlockSummary, gear)
JSON_MAP_REFERENCE(Tone3000BlockSummary, format)
JSON_MAP_REFERENCE(Tone3000BlockSummary, activeModelId)
JSON_MAP_REFERENCE(Tone3000BlockSummary, enabled)
JSON_MAP_REFERENCE(Tone3000BlockSummary, normalize)
JSON_MAP_REFERENCE(Tone3000BlockSummary, capabilityUnknown)
JSON_MAP_REFERENCE(Tone3000BlockSummary, inputGain)
JSON_MAP_REFERENCE(Tone3000BlockSummary, outputGain)
JSON_MAP_REFERENCE(Tone3000BlockSummary, mix)
JSON_MAP_REFERENCE(Tone3000BlockSummary, slimSize)
JSON_MAP_REFERENCE(Tone3000BlockSummary, eq)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000StateSummary)
JSON_MAP_REFERENCE(Tone3000StateSummary, activePresetId)
JSON_MAP_REFERENCE(Tone3000StateSummary, activePresetName)
JSON_MAP_REFERENCE(Tone3000StateSummary, inputMode)
JSON_MAP_REFERENCE(Tone3000StateSummary, calibrateInput)
JSON_MAP_REFERENCE(Tone3000StateSummary, inputCalibrationLevel)
JSON_MAP_REFERENCE(Tone3000StateSummary, osEnabled)
JSON_MAP_REFERENCE(Tone3000StateSummary, osFactor)
JSON_MAP_REFERENCE(Tone3000StateSummary, stereoEnabled)
JSON_MAP_REFERENCE(Tone3000StateSummary, branchSide)
JSON_MAP_REFERENCE(Tone3000StateSummary, branchAfterBlockId)
JSON_MAP_REFERENCE(Tone3000StateSummary, blocks)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000EqBandPatch)
JSON_MAP_REFERENCE(Tone3000EqBandPatch, index)
JSON_MAP_REFERENCE(Tone3000EqBandPatch, type)
JSON_MAP_REFERENCE(Tone3000EqBandPatch, freqHz)
JSON_MAP_REFERENCE(Tone3000EqBandPatch, gainDb)
JSON_MAP_REFERENCE(Tone3000EqBandPatch, q)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000BlockPatch)
JSON_MAP_REFERENCE(Tone3000BlockPatch, blockId)
JSON_MAP_REFERENCE(Tone3000BlockPatch, enabled)
JSON_MAP_REFERENCE(Tone3000BlockPatch, normalize)
JSON_MAP_REFERENCE(Tone3000BlockPatch, inputGain)
JSON_MAP_REFERENCE(Tone3000BlockPatch, outputGain)
JSON_MAP_REFERENCE(Tone3000BlockPatch, mix)
JSON_MAP_REFERENCE(Tone3000BlockPatch, slimSize)
JSON_MAP_REFERENCE(Tone3000BlockPatch, eqEnabled)
JSON_MAP_REFERENCE(Tone3000BlockPatch, eqPre)
JSON_MAP_REFERENCE(Tone3000BlockPatch, eqBands)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000StatePatch)
JSON_MAP_REFERENCE(Tone3000StatePatch, inputMode)
JSON_MAP_REFERENCE(Tone3000StatePatch, calibrateInput)
JSON_MAP_REFERENCE(Tone3000StatePatch, inputCalibrationLevel)
JSON_MAP_REFERENCE(Tone3000StatePatch, osEnabled)
JSON_MAP_REFERENCE(Tone3000StatePatch, osFactor)
JSON_MAP_REFERENCE(Tone3000StatePatch, outputLevel)
JSON_MAP_REFERENCE(Tone3000StatePatch, blocks)
JSON_MAP_END()

namespace
{
    constexpr std::string_view ATOM_STRING = "http://lv2plug.in/ns/ext/atom#String";
    constexpr std::string_view PROGRAM_URI = "https://www.tone3000.com/plugin:Program";
    constexpr std::string_view ALPHABET = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+";
    constexpr size_t MAX_NODES = 100000;
    constexpr size_t MAX_DEPTH = 64;
    constexpr size_t MAX_STRING = 1024 * 1024;

    [[noreturn]] void Fail(const char *message)
    {
        throw std::invalid_argument(message);
    }

    // A release build uses fast-math; inspect IEEE exponent bits rather than
    // allowing that compiler option to optimize finite-value checks away.
    bool Finite(double value)
    {
        return (std::bit_cast<uint64_t>(value) & 0x7ff0000000000000ULL) != 0x7ff0000000000000ULL;
    }

    bool Utf8(std::string_view text)
    {
        size_t position = 0;
        while (position < text.size())
        {
            uint8_t first = static_cast<uint8_t>(text[position++]);
            if (first < 0x80) continue;
            size_t extra;
            uint32_t code, minimum;
            if (first >= 0xc2 && first <= 0xdf) { extra = 1; code = first & 0x1f; minimum = 0x80; }
            else if (first >= 0xe0 && first <= 0xef) { extra = 2; code = first & 0x0f; minimum = 0x800; }
            else if (first >= 0xf0 && first <= 0xf4) { extra = 3; code = first & 7; minimum = 0x10000; }
            else return false;
            if (extra > text.size() - position) return false;
            while (extra--)
            {
                uint8_t next = static_cast<uint8_t>(text[position++]);
                if ((next & 0xc0) != 0x80) return false;
                code = (code << 6) | (next & 0x3f);
            }
            if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
        }
        return true;
    }

    std::string Trim(std::string value)
    {
        const auto first = value.find_first_not_of(" \t\r\n");
        if (first == std::string::npos) return {};
        return value.substr(first, value.find_last_not_of(" \t\r\n") - first + 1);
    }

    void Identity(const std::string &value, size_t maximum, bool empty = false)
    {
        if ((!empty && value.empty()) || value.size() > maximum || !Utf8(value)
            || std::any_of(value.begin(), value.end(), [](unsigned char c) { return c < 0x20 || c == 0x7f; }))
            Fail("Invalid TONE3000 identity text");
    }

    std::string Stem(const std::string &filename)
    {
        Identity(filename, 255);
        constexpr std::string_view extension = ".t3kpreset";
        if (!filename.ends_with(extension) || filename.size() <= extension.size()
            || filename.find_first_of("/\\:*?\"<>|") != std::string::npos
            || filename.front() == '.' || filename.front() == '~')
            Fail("A safe .t3kpreset basename is required");
        std::string stem = filename.substr(0, filename.size() - extension.size());
        if (stem.back() == '.' || stem.back() == ' ' || stem == "." || stem == "..")
            Fail("Unsafe TONE3000 preset stem");
        return stem;
    }

    struct Value
    {
        uint8_t kind = 0;
        double number = 0;
        int64_t integer = 0;
        std::string text;
        std::span<const uint8_t> binary;
        std::span<const uint8_t> raw;
    };
    struct Property { std::string name; Value value; };
    struct Tree
    {
        std::string tag;
        std::vector<Property> properties;
        std::vector<Tree> children;
        std::span<const uint8_t> raw;
        bool modified = false;

        Value *Find(std::string_view key)
        {
            return const_cast<Value *>(std::as_const(*this).Find(key));
        }

        const Value *Find(std::string_view key) const
        {
            for (const auto &property : properties) if (property.name == key) return &property.value;
            return nullptr;
        }
        const Tree *Child(std::string_view type, bool required = true) const
        {
            const Tree *result = nullptr;
            for (const auto &child : children)
            {
                if (child.tag != type) continue;
                if (result) Fail("Duplicate TONE3000 child tree");
                result = &child;
            }
            if (!result && required) Fail("Missing TONE3000 child tree");
            return result;
        }
        Tree *Child(std::string_view type, bool required = true)
        {
            return const_cast<Tree *>(std::as_const(*this).Child(type, required));
        }
        void Set(std::string_view key, Value value)
        {
            if (auto *old = Find(key)) *old = std::move(value);
            else properties.push_back({std::string(key), std::move(value)});
            modified = true;
        }
    };

    /**
     * Bounded pinned JUCE stream traversal; raw variants/subtrees stay lossless.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [DES-SEC] [3.8]
     */
    class Reader
    {
    public:
        explicit Reader(std::span<const uint8_t> bytes) : bytes(bytes) {}
        std::span<const uint8_t> bytes;
        size_t position = 0, complexity = 0;

        std::span<const uint8_t> Read(size_t size)
        {
            if (size > bytes.size() - position) Fail("Truncated TONE3000 ValueTree");
            const auto result = bytes.subspan(position, size);
            position += size;
            return result;
        }
        int64_t Compressed()
        {
            const uint8_t marker = Read(1)[0];
            const size_t count = marker & 0x7f;
            if (count > 4) Fail("Invalid JUCE compressed integer");
            const auto raw = Read(count);
            int64_t result = 0;
            for (size_t i = 0; i < count; ++i) result |= static_cast<int64_t>(raw[i]) << (8 * i);
            if (result > std::numeric_limits<int32_t>::max()) Fail("Oversized JUCE compressed integer");
            return marker & 0x80 ? -result : result;
        }
        std::string String(size_t maximum)
        {
            const size_t start = position;
            while (position < bytes.size() && position - start <= maximum)
            {
                if (bytes[position++] == 0)
                {
                    std::string result(reinterpret_cast<const char *>(bytes.data() + start), position - start - 1);
                    if (!Utf8(result)) Fail("Invalid TONE3000 UTF-8");
                    return result;
                }
            }
            Fail("Truncated or oversized TONE3000 string");
        }
        Value Variant(size_t depth = 0)
        {
            if (++complexity > MAX_NODES || depth > MAX_DEPTH) Fail("TONE3000 ValueTree complexity limit");
            const size_t start = position;
            const auto size = Compressed();
            if (size < 0) Fail("Negative JUCE variant size");
            const auto raw = Read(static_cast<size_t>(size));
            Value result;
            result.raw = bytes.subspan(start, position - start);
            if (raw.empty()) return result;
            result.kind = raw[0];
            const auto body = raw.subspan(1);
            auto bits = [&]() {
                uint64_t value = 0;
                for (size_t i = 0; i < body.size(); ++i) value |= static_cast<uint64_t>(body[i]) << (8 * i);
                return value;
            };
            switch (result.kind)
            {
            case 1:
                if (body.size() != 4) Fail("Invalid JUCE integer variant");
                result.integer = std::bit_cast<int32_t>(static_cast<uint32_t>(bits()));
                break;
            case 6:
                if (body.size() != 8) Fail("Invalid JUCE int64 variant");
                result.integer = std::bit_cast<int64_t>(bits());
                break;
            case 2: case 3: case 9:
                if (!body.empty()) Fail("Invalid JUCE boolean/undefined variant");
                break;
            case 4:
                if (body.size() != 8) Fail("Invalid JUCE double variant");
                result.number = std::bit_cast<double>(bits());
                if (!Finite(result.number)) Fail("Nonfinite TONE3000 value");
                break;
            case 5:
                if (body.empty() || body.size() > MAX_STRING || body.back() != 0
                    || std::find(body.begin(), body.end() - 1, uint8_t(0)) != body.end() - 1)
                    Fail("Invalid JUCE string variant");
                result.text.assign(reinterpret_cast<const char *>(body.data()), body.size() - 1);
                if (!Utf8(result.text)) Fail("Invalid TONE3000 UTF-8");
                break;
            case 8:
                result.binary = body;
                break;
            case 7:
            {
                Reader array(body);
                array.complexity = complexity;
                const auto count = array.Compressed();
                if (count < 0 || count > 10000) Fail("Invalid JUCE array length");
                for (int64_t i = 0; i < count; ++i) array.Variant(depth + 1);
                if (array.position != body.size()) Fail("Trailing JUCE array bytes");
                complexity = array.complexity;
                break;
            }
            default: Fail("Unsupported JUCE variant type");
            }
            return result;
        }
        Tree Node(size_t depth = 0)
        {
            if (++complexity > MAX_NODES || depth > MAX_DEPTH) Fail("TONE3000 ValueTree complexity limit");
            const size_t start = position;
            Tree result;
            result.tag = String(65536);
            Identity(result.tag, 65536);
            const auto count = Compressed();
            if (count < 0 || count > 10000) Fail("Invalid TONE3000 property count");
            std::set<std::string> names;
            for (int64_t i = 0; i < count; ++i)
            {
                auto name = String(65536);
                Identity(name, 65536);
                if (!names.insert(name).second) Fail("Duplicate TONE3000 property");
                result.properties.push_back({std::move(name), Variant(depth)});
            }
            const auto children = Compressed();
            if (children < 0 || children > 100000) Fail("Invalid TONE3000 child count");
            for (int64_t i = 0; i < children; ++i) result.children.push_back(Node(depth + 1));
            result.raw = bytes.subspan(start, position - start);
            return result;
        }
        Tree Complete(std::string_view type)
        {
            Tree result = Node();
            if (position != bytes.size() || result.tag != type) Fail("Unsupported or trailing TONE3000 tree");
            return result;
        }
    };

    std::string Text(const Tree &tree, std::string_view key, const std::string &fallback = {})
    {
        const auto *value = tree.Find(key);
        if (!value) return fallback;
        if (value->kind != 5) Fail("TONE3000 text property has wrong type");
        return value->text;
    }
    int64_t Integer(const Value *value, int64_t fallback = 0)
    {
        if (!value) return fallback;
        if (value->kind != 1 && value->kind != 6) Fail("TONE3000 integer property has wrong type");
        return value->integer;
    }
    double Number(const Value &value)
    {
        if (value.kind == 4) return value.number;
        if (value.kind == 1 || value.kind == 6) return static_cast<double>(value.integer);
        Fail("TONE3000 parameter value has wrong type");
    }
    bool Boolean(const Tree &tree, std::string_view key, bool fallback)
    {
        const auto *value = tree.Find(key);
        if (!value) return fallback;
        if (value->kind != 2 && value->kind != 3) Fail("Invalid TONE3000 boolean property");
        return value->kind == 2;
    }
    double Bounded(double value, double minimum, double maximum)
    {
        if (!Finite(value) || value < minimum || value > maximum) Fail("TONE3000 value outside pinned range");
        return value;
    }
    double Field(const Tree &tree, std::string_view key, double fallback, double minimum, double maximum)
    {
        const auto *value = tree.Find(key);
        return Bounded(value ? Number(*value) : fallback, minimum, maximum);
    }
    void Schema(const Tree &tree)
    {
        if (Integer(tree.Find("schemaVersion"), 1) != 1) Fail("Unsupported TONE3000 schema");
    }

    struct Parameter { const char *id; double initial, minimum, maximum; bool session; bool discrete = false; };
    // Processor.cpp::createParameterLayout, ProcessorPresets::presetParameterIds,
    // PitchShift.h at v0.0.11; values here are denormalized APVTS units.
    constexpr std::array<Parameter, 43> PARAMETERS = {{
        {"inputLevel", .5, 0, 1, false}, {"toneBass", 5, 0, 10, false},
        {"toneMid", 5, 0, 10, false}, {"toneTreble", 5, 0, 10, false},
        {"outputLevel", .5, 0, 1, false}, {"gateThreshold", -80, -100, 0, false},
        {"targetLoudness", -18, -60, 0, true}, {"calibrateInput", 0, 0, 1, true, true},
        {"inputCalibrationLevel", 12, -60, 60, true}, {"gateEnabled", 1, 0, 1, false, true},
        {"toneEqEnabled", 1, 0, 1, false, true}, {"outputBalance", .5, 0, 1, false},
        {"spreadEnabled", 0, 0, 1, false, true}, {"spreadOffset", .8125, 0, 1, false},
        {"spreadWobble", .25, 0, 1, false}, {"spreadWobbleEnabled", 1, 0, 1, false, true},
        {"spreadCrossover", .5, 0, 1, false}, {"spreadCrossoverEnabled", 1, 0, 1, false, true},
        {"spreadDiffuseEnabled", 1, 0, 1, false, true}, {"alignEnabled", 0, 0, 1, false, true},
        {"alignOffset", .5, 0, 1, false}, {"alignWobble", .25, 0, 1, false},
        {"alignWobbleEnabled", 0, 0, 1, false, true}, {"alignCrossover", .5, 0, 1, false},
        {"alignCrossoverEnabled", 0, 0, 1, false, true}, {"alignDiffuseEnabled", 0, 0, 1, false, true},
        {"chainPanLeft", 0, 0, 1, false}, {"chainPanRight", 1, 0, 1, false},
        {"chainPanLinked", 1, 0, 1, false, true}, {"chainSoloLeft", 0, 0, 1, true, true},
        {"chainSoloRight", 0, 0, 1, true, true}, {"chainInvertLeft", 0, 0, 1, false, true},
        {"chainInvertRight", 0, 0, 1, false, true}, {"osEnabled", 0, 0, 1, true, true},
        {"osFactor", 0, 0, 2, true, true}, {"gateRelease", 50, 5, 500, false},
        {"gateHold", 20, 0, 200, false}, {"gateRange", 80, 20, 80, false},
        {"pitchEnabled", 0, 0, 1, false, true}, {"pitchSemitones", 0, -24, 24, false},
        {"pitchStep", 1, 0, 1, false, true}, {"pitchTonality", 20000, 1000, 20000, false},
        {"pitchWindow", 1, 0, 3, false, true}
    }};

    std::string CurrentId(std::string id)
    {
        if (id.starts_with("transpose"))
        {
            for (auto suffix : {"Enabled", "Semitones", "Step", "Tonality", "Window"})
                if (id == std::string("transpose") + suffix) return std::string("pitch") + suffix;
        }
        return id;
    }
    std::map<std::string, double> ParameterValues(const Tree &tree, std::string_view childType)
    {
        if (!tree.properties.empty()) Fail("Unsupported TONE3000 parameter tree properties");
        std::map<std::string, double> result;
        for (const auto &child : tree.children)
        {
            if (child.tag != childType || !child.children.empty()) Fail("Unsupported TONE3000 parameter child");
            const auto id = CurrentId(Text(child, "id"));
            const auto found = std::find_if(PARAMETERS.begin(), PARAMETERS.end(), [&](const auto &p) { return id == p.id; });
            const auto *value = child.Find("value");
            if (found == PARAMETERS.end() || !value) Fail("Unknown or missing TONE3000 parameter");
            const auto number = Number(*value);
            if (!Finite(number) || number < found->minimum || number > found->maximum
                || (found->discrete && std::floor(number) != number))
                Fail("TONE3000 parameter outside pinned range/choices");
            if (!result.emplace(id, number).second) Fail("Duplicate or ambiguous legacy TONE3000 parameter");
        }
        return result;
    }

    void ToneMetadata(const std::string &text)
    {
        // The application's JSON reader accepts missing/trailing commas. A
        // strict bounded walk verifies syntax first, without model parsing.
        struct JsonSyntax
        {
            const std::string &text;
            size_t position = 0, nodes = 0;
            void Space()
            {
                while (position < text.size() && std::string_view(" \t\r\n").find(text[position]) != std::string_view::npos) ++position;
            }
            bool Take(char c)
            {
                Space();
                if (position == text.size() || text[position] != c) return false;
                ++position; return true;
            }
            void Require(char c) { if (!Take(c)) Fail("Invalid TONE3000 metadata JSON"); }
            bool Digit() const { return position < text.size() && text[position] >= '0' && text[position] <= '9'; }
            std::string String()
            {
                Space();
                const size_t start = position;
                Require('"');
                while (position < text.size())
                {
                    const unsigned char c = text[position++];
                    if (c == '"')
                    {
                        try { return json_variant::parse(text.substr(start, position - start)).as_string(); }
                        catch (const std::exception &) { Fail("Invalid TONE3000 metadata string"); }
                    }
                    if (c < 0x20) Fail("Invalid TONE3000 metadata string");
                    if (c != '\\') continue;
                    if (position == text.size()) Fail("Invalid TONE3000 metadata escape");
                    const char escape = text[position++];
                    if (escape != 'u')
                    {
                        if (std::string_view("\"\\/bfnrt").find(escape) == std::string_view::npos) Fail("Invalid TONE3000 metadata escape");
                        continue;
                    }
                    for (size_t i = 0; i < 4; ++i)
                    {
                        if (position == text.size() || std::string_view("0123456789abcdefABCDEF").find(text[position++]) == std::string_view::npos)
                            Fail("Invalid TONE3000 metadata unicode escape");
                    }
                }
                Fail("Unterminated TONE3000 metadata string");
            }
            void Value(size_t depth)
            {
                if (depth > MAX_DEPTH || ++nodes > MAX_NODES) Fail("TONE3000 metadata complexity limit");
                Space();
                if (position == text.size()) Fail("Truncated TONE3000 metadata JSON");
                if (text[position] == '"') { String(); return; }
                if (Take('{'))
                {
                    std::set<std::string> keys;
                    if (Take('}')) return;
                    do
                    {
                        if (!keys.insert(String()).second) Fail("Duplicate TONE3000 metadata key");
                        Require(':'); Value(depth + 1);
                        if (Take('}')) return;
                        Require(',');
                    } while (true);
                }
                if (Take('['))
                {
                    if (Take(']')) return;
                    do
                    {
                        Value(depth + 1);
                        if (Take(']')) return;
                        Require(',');
                    } while (true);
                }
                for (auto literal : {std::string_view("true"), std::string_view("false"), std::string_view("null")})
                    if (std::string_view(text).substr(position).starts_with(literal)) { position += literal.size(); return; }
                const size_t start = position;
                if (text[position] == '-') ++position;
                if (!Digit()) Fail("Invalid TONE3000 metadata number");
                if (text[position] == '0') ++position;
                else while (Digit()) ++position;
                if (position < text.size() && text[position] == '.')
                {
                    ++position;
                    if (!Digit()) Fail("Invalid TONE3000 metadata number");
                    while (Digit()) ++position;
                }
                if (position < text.size() && (text[position] == 'e' || text[position] == 'E'))
                {
                    ++position;
                    if (position < text.size() && (text[position] == '-' || text[position] == '+')) ++position;
                    if (!Digit()) Fail("Invalid TONE3000 metadata exponent");
                    while (Digit()) ++position;
                }
                double number = 0;
                const auto conversion = std::from_chars(text.data() + start, text.data() + position, number);
                if (conversion.ec != std::errc() || conversion.ptr != text.data() + position || !Finite(number))
                    Fail("Invalid or nonfinite TONE3000 metadata number");
            }
        } syntax{text};
        syntax.Space();
        if (syntax.position == text.size() || text[syntax.position] != '{') Fail("TONE3000 tone metadata must be an object");
        syntax.Value(0);
        syntax.Space();
        if (syntax.position != text.size()) Fail("Trailing TONE3000 metadata JSON");
    }

    bool BandRole(int index, std::string_view type)
    {
        if (index == 0) return type == "lowcut" || type == "lowshelf";
        if (index == 5) return type == "highcut" || type == "highshelf";
        return type == "bell";
    }

    /** Native effective defaults, retained only in the view until an EQ edit.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-13] [DES-OPERATE] [3.11]
     */
    Tone3000EqState EqSummary(const Tree *tree)
    {
        Tone3000EqState result;
        constexpr std::array<double, 6> frequencies{100, 250, 650, 1600, 3500, 8000};
        constexpr std::array<double, 6> quality{double(.71f), 1, 1, 1, double(1.4f), double(.71f)};
        for (int index = 0; index < 6; ++index)
        {
            Tone3000EqBand band;
            band.type_ = index == 0 ? "lowshelf" : index == 5 ? "highshelf" : "bell";
            band.freqHz_ = frequencies[index]; band.q_ = quality[index];
            result.bands_.push_back(std::move(band));
        }
        if (!tree) return result;
        result.enabled_ = Boolean(*tree, "enabled", true);
        result.pre_ = Boolean(*tree, "pre", false);
        if (tree->children.size() > 6) Fail("Too many TONE3000 EQ bands");
        for (size_t index = 0; index < tree->children.size(); ++index)
        {
            const auto &node = tree->children[index];
            if (node.tag != "Band" || !node.children.empty()) Fail("Invalid TONE3000 EQ band tree");
            auto &band = result.bands_[index];
            band.type_ = Text(node, "type", band.type_);
            if (!BandRole(static_cast<int>(index), band.type_)) Fail("Invalid TONE3000 EQ band role");
            // Stored partial Band trees use the native per-property fallback;
            // completely absent bands keep the role-specific default above.
            band.freqHz_ = Field(node, "freqHz", 1000, 20, 20000);
            band.gainDb_ = Field(node, "gainDb", 0, -15, 15);
            band.q_ = Field(node, "q", 1, .1, 10);
        }
        return result;
    }

    void CheckSnapshot(const Tree &snapshot, Tone3000PresetInfo &info)
    {
        const auto *stereo = snapshot.Find("stereoEnabled");
        if (stereo && stereo->kind != 2 && stereo->kind != 3) Fail("Invalid TONE3000 stereo flag");
        const auto branch = Text(snapshot, "branchSide", "left");
        if (branch != "left" && branch != "right") Fail("Invalid TONE3000 branch side");
        Text(snapshot, "branchAfterBlockId");
        if (snapshot.children.empty() || snapshot.children.size() > 2) Fail("Unsupported TONE3000 chain lanes");
        const auto *left = snapshot.Child("ChainBlocks");
        const auto *right = snapshot.Child("RightChainBlocks", false);
        for (const auto &lane : snapshot.children)
            if (lane.tag != "ChainBlocks" && lane.tag != "RightChainBlocks") Fail("Unknown TONE3000 chain lane");
        std::set<std::string> blockIds;
        for (const auto *lane : {left, right})
        {
            if (!lane) continue;
            for (const auto &block : lane->children)
            {
                if (block.tag != "ChainBlock") Fail("Unsupported TONE3000 chain child");
                const auto blockId = Text(block, "id");
                Identity(blockId, 512);
                if (!blockIds.insert(blockId).second) Fail("Duplicate TONE3000 block identity");
                const auto type = Text(block, "type");
                if (type != "nam" && type != "ir" && type != "insert") Fail("Unsupported TONE3000 block kind");
                for (auto field : {"enabled", "normalize"})
                    if (const auto *v = block.Find(field); v && v->kind != 2 && v->kind != 3)
                        Fail("Invalid TONE3000 block flag");
                for (auto field : {"slimSize", "inputGain", "outputGain", "mix"})
                    if (const auto *v = block.Find(field)) Bounded(Number(*v), 0, 1);
                EqSummary(block.Child("Eq", false));
                if (type == "insert") continue;
                if (const auto *toneId = block.Find("toneId"))
                {
                    const auto id = Integer(toneId);
                    if (id < std::numeric_limits<int32_t>::min() || id > std::numeric_limits<int32_t>::max())
                        Fail("Invalid TONE3000 tone identity");
                }
                const auto modelId = Integer(block.Find("activeModelId"));
                if (!block.Find("activeModelId") || modelId < std::numeric_limits<int32_t>::min()
                    || modelId > std::numeric_limits<int32_t>::max()) Fail("Invalid TONE3000 active model identity");
                ToneMetadata(Text(block, "toneJson"));
                const auto *cache = block.Child("ModelCache");
                bool active = false;
                std::set<int64_t> cacheIds;
                for (const auto &model : cache->children)
                {
                    if (model.tag != "CachedModel" || !model.children.empty()) Fail("Invalid TONE3000 model cache child");
                    const auto *storedId = model.Find("modelId");
                    const auto id = Integer(storedId);
                    const auto *data = model.Find("data");
                    if (!storedId || id < std::numeric_limits<int32_t>::min() || id > std::numeric_limits<int32_t>::max()
                        || !cacheIds.insert(id).second || !data || data->kind != 8 || data->binary.empty())
                        Fail("Invalid or duplicate TONE3000 embedded model");
                    if (type == "nam") ++info.namCount; else ++info.irCount;
                    info.embeddedBytes += data->binary.size();
                    if (info.embeddedBytes > Tone3000Preset::MAX_BYTES) Fail("TONE3000 embedded-byte limit");
                    if (id == modelId) active = true;
                }
                if (!active) Fail("Active TONE3000 NAM/IR bytes are missing");
                ++info.modelCount;
            }
        }
    }

    struct ParsedPreset { Tree body; Tone3000PresetInfo info; };
    ParsedPreset Parse(std::span<const uint8_t> bytes, const std::string &filename, const std::string &section)
    {
        const auto stem = Stem(filename);
        if (section != "user" && section != "factory") Fail("Unsupported TONE3000 preset section");
        if (bytes.size() < 5 || bytes.size() > Tone3000Preset::MAX_BYTES) Fail("TONE3000 preset size limit");
        ParsedPreset result;
        size_t offset = 4;
        std::optional<Tree> header;
        if (std::memcmp(bytes.data(), "T3KH", 4) == 0)
        {
            if (bytes.size() < 8) Fail("Truncated TONE3000 header");
            uint32_t size = 0;
            for (size_t i = 0; i < 4; ++i) size |= static_cast<uint32_t>(bytes[4 + i]) << (8 * i);
            if (size == 0 || size > 65536 || size > bytes.size() - 8) Fail("Invalid TONE3000 header length");
            header = Reader(bytes.subspan(8, size)).Complete("T3KPresetHeader");
            if (!header->children.empty()) Fail("Unsupported TONE3000 header children");
            offset = 8 + size;
        }
        else if (std::memcmp(bytes.data(), "T3KB", 4) == 0) result.info.legacy = true;
        else Fail("Unsupported TONE3000 preset magic");
        result.body = Reader(bytes.subspan(offset)).Complete("T3KPreset");
        Schema(result.body);
        result.info.rawId = Trim(Text(result.body, "id"));
        result.info.name = Text(result.body, "name");
        if (header && (Trim(Text(*header, "id")) != result.info.rawId || Text(*header, "name") != result.info.name))
            Fail("TONE3000 header/body identity mismatch");
        Identity(result.info.rawId, 512, true);
        if (result.info.name.empty()) result.info.name = stem;
        Identity(result.info.name, 512);
        result.info.id = section + ":" + (result.info.rawId.empty() ? stem : result.info.rawId);
        const auto *snapshot = result.body.Child("ChainSnapshot");
        const auto *params = result.body.Child("Params");
        if (result.body.children.size() != 2) Fail("Unsupported TONE3000 preset children");
        ParameterValues(*params, "Param");
        CheckSnapshot(*snapshot, result.info);
        return result;
    }

    /**
     * Minimal stream writer; opaque source trees/variants are emitted verbatim.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.8]
     */
    class Writer
    {
    public:
        std::vector<uint8_t> bytes;
        void Raw(std::span<const uint8_t> data)
        {
            if (data.size() > Tone3000Preset::MAX_BYTES - bytes.size()) Fail("Converted TONE3000 state size limit");
            bytes.insert(bytes.end(), data.begin(), data.end());
        }
        void Byte(uint8_t value) { Raw(std::span<const uint8_t>(&value, 1)); }
        void String(std::string_view value)
        {
            Raw(std::span<const uint8_t>(reinterpret_cast<const uint8_t *>(value.data()), value.size()));
            Byte(0);
        }
        void Compressed(size_t value)
        {
            if (value > std::numeric_limits<int32_t>::max()) Fail("Converted JUCE integer limit");
            uint8_t count = 0;
            for (size_t copy = value; copy; copy >>= 8) ++count;
            Byte(count);
            for (uint8_t i = 0; i < count; ++i) Byte(static_cast<uint8_t>(value >> (8 * i)));
        }
        void Text(std::string_view key, std::string_view value)
        {
            String(key); Compressed(value.size() + 2); Byte(5); String(value);
        }
        void Number(std::string_view key, double value)
        {
            String(key); Compressed(9); Byte(4);
            const auto bits = std::bit_cast<uint64_t>(value);
            for (size_t i = 0; i < 8; ++i) Byte(static_cast<uint8_t>(bits >> (8 * i)));
        }
        void Integer(std::string_view key, int32_t value)
        {
            String(key); Compressed(5); Byte(1);
            const auto bits = std::bit_cast<uint32_t>(value);
            for (size_t i = 0; i < 4; ++i) Byte(static_cast<uint8_t>(bits >> (8 * i)));
        }
        void Variant(const Value &value)
        {
            if (!value.raw.empty()) { Raw(value.raw); return; }
            if (value.kind == 0) { Compressed(0); return; }
            if (value.kind == 2 || value.kind == 3) { Compressed(1); Byte(value.kind); return; }
            if (value.kind == 5) { Compressed(value.text.size() + 2); Byte(5); String(value.text); return; }
            if (value.kind == 4)
            {
                Compressed(9); Byte(4);
                auto bits = std::bit_cast<uint64_t>(value.number);
                for (size_t i = 0; i < 8; ++i) Byte(static_cast<uint8_t>(bits >> (8 * i)));
                return;
            }
            Fail("Unsupported new TONE3000 variant");
        }
        void Node(const Tree &tree)
        {
            if (!tree.modified && !tree.raw.empty()) { Raw(tree.raw); return; }
            String(tree.tag); Compressed(tree.properties.size());
            for (const auto &property : tree.properties) { String(property.name); Variant(property.value); }
            Compressed(tree.children.size());
            for (const auto &child : tree.children) Node(child);
        }
    };

    std::vector<uint8_t> Decode(const Lv2PluginState &state)
    {
        const auto found = state.values_.find(Tone3000Preset::STATE_URI);
        if (!state.isValid_ || state.values_.contains(std::string(PROGRAM_URI)) || found == state.values_.end()
            || found->second.atomType_ != ATOM_STRING) Fail("Previous TONE3000 full state is invalid");
        const auto &raw = found->second.value_;
        if (raw.empty() || raw.back() != 0 || raw.size() > (Tone3000Preset::MAX_BYTES * 8 + 5) / 6 + 32)
            Fail("Previous TONE3000 StateString size/framing");
        std::string_view text(reinterpret_cast<const char *>(raw.data()), raw.size() - 1);
        const auto dot = text.find('.');
        if (dot == std::string_view::npos || dot == 0 || dot > 10 || (dot > 1 && text[0] == '0'))
            Fail("Invalid JUCE StateString byte prefix");
        size_t size = 0;
        for (char c : text.substr(0, dot))
        {
            if (c < '0' || c > '9') Fail("Invalid JUCE StateString byte prefix");
            size = size * 10 + static_cast<size_t>(c - '0');
            if (size > Tone3000Preset::MAX_BYTES) Fail("Previous TONE3000 state size limit");
        }
        const auto encoded = text.substr(dot + 1);
        if (encoded.size() != (size * 8 + 5) / 6) Fail("JUCE StateString length mismatch");
        std::vector<uint8_t> result(size, 0);
        for (size_t i = 0; i < encoded.size(); ++i)
        {
            const auto value = ALPHABET.find(encoded[i]);
            const size_t bit = i * 6, byte = bit / 8, shift = bit % 8;
            if (value == std::string_view::npos || (size * 8 - bit < 6 && value >> (size * 8 - bit)))
                Fail("Invalid JUCE StateString alphabet/padding");
            result[byte] |= static_cast<uint8_t>(value << shift);
            if (shift > 2 && byte + 1 < size) result[byte + 1] |= static_cast<uint8_t>(value >> (8 - shift));
        }
        return result;
    }
    std::vector<uint8_t> Encode(std::span<const uint8_t> bytes)
    {
        std::string encoded = std::to_string(bytes.size()) + ".";
        const size_t characters = (bytes.size() * 8 + 5) / 6;
        encoded.reserve(encoded.size() + characters + 1);
        for (size_t i = 0; i < characters; ++i)
        {
            const size_t bit = i * 6, byte = bit / 8, shift = bit % 8;
            unsigned value = bytes[byte] >> shift;
            if (shift > 2 && byte + 1 < bytes.size()) value |= unsigned(bytes[byte + 1]) << (8 - shift);
            encoded.push_back(ALPHABET[value & 63]);
        }
        std::vector<uint8_t> result(encoded.begin(), encoded.end());
        result.push_back(0);
        return result;
    }

    Value TextValue(const std::string &text) { Value result; result.kind = 5; result.text = text; return result; }
    Value NumericValue(double number) { Value result; result.kind = 4; result.number = number; return result; }
    Value BoolValue(bool value) { Value result; result.kind = value ? 2 : 3; return result; }

    Tree StateTree(std::span<const uint8_t> bytes)
    {
        if (bytes.size() < 5 || std::memcmp(bytes.data(), "T3KB", 4)) Fail("Unsupported TONE3000 state magic");
        Tree tree = Reader(bytes.subspan(4)).Complete("TONE3000State");
        Schema(tree);
        ParameterValues(*tree.Child("PARAMETERS"), "PARAM");
        tree.Child("MidiMappings", false);
        Tone3000PresetInfo info;
        CheckSnapshot(*tree.Child("ChainSnapshot"), info);
        const auto input = Text(tree, "inputMode", "stereo");
        if (input != "stereo" && input != "left" && input != "right" && input != "dual") Fail("Invalid TONE3000 input mode");
        for (auto key : {"editorScale", "editorExtraHeight"}) if (const auto *value = tree.Find(key)) Number(*value);
        Identity(Text(tree, "activePresetId"), 512, true);
        Identity(Text(tree, "activePresetName"), 512, true);
        return tree;
    }

    std::string MetadataString(const json_object &object, const std::string &key)
    {
        if (!object.contains(key) || !object.at(key).is_string()) return {};
        auto text = object.at(key).as_string();
        // Compact display strings only, never arbitrary tone metadata.
        if (text.size() > 512 || !Utf8(text)) return {};
        for (char &c : text) if (static_cast<unsigned char>(c) < 0x20 || c == 0x7f) c = ' ';
        return text;
    }

    double ParameterOrDefault(const std::map<std::string, double> &parameters, const char *id)
    {
        if (const auto value = parameters.find(id); value != parameters.end()) return value->second;
        for (const auto &parameter : PARAMETERS) if (std::string_view(parameter.id) == id) return parameter.initial;
        Fail("Unknown TONE3000 parameter default");
    }

    Tone3000StateSummary Summarize(const Tree &tree)
    {
        Tone3000StateSummary result;
        result.activePresetId_ = Text(tree, "activePresetId");
        result.activePresetName_ = Text(tree, "activePresetName");
        result.inputMode_ = Text(tree, "inputMode", "stereo");
        const auto parameters = ParameterValues(*tree.Child("PARAMETERS"), "PARAM");
        result.calibrateInput_ = ParameterOrDefault(parameters, "calibrateInput") != 0;
        result.inputCalibrationLevel_ = ParameterOrDefault(parameters, "inputCalibrationLevel");
        result.osEnabled_ = ParameterOrDefault(parameters, "osEnabled") != 0;
        result.osFactor_ = static_cast<int>(ParameterOrDefault(parameters, "osFactor"));
        const auto &snapshot = *tree.Child("ChainSnapshot");
        result.stereoEnabled_ = Boolean(snapshot, "stereoEnabled", false);
        result.branchSide_ = Text(snapshot, "branchSide", "left");
        result.branchAfterBlockId_ = Text(snapshot, "branchAfterBlockId");
        for (auto laneName : {"ChainBlocks", "RightChainBlocks"})
        {
            const auto *lane = snapshot.Child(laneName, false);
            if (!lane) continue;
            for (size_t index = 0; index < lane->children.size(); ++index)
            {
                const auto &block = lane->children[index];
                Tone3000BlockSummary part;
                part.blockId_ = Text(block, "id");
                part.lane_ = std::string_view(laneName) == "ChainBlocks" ? "left" : "right";
                part.index_ = static_cast<int>(index);
                part.type_ = Text(block, "type");
                part.enabled_ = Boolean(block, "enabled", true);
                part.normalize_ = Boolean(block, "normalize", true);
                part.inputGain_ = Field(block, "inputGain", .5, 0, 1);
                part.outputGain_ = Field(block, "outputGain", .5, 0, 1);
                part.mix_ = Field(block, "mix", 1, 0, 1);
                part.slimSize_ = Field(block, "slimSize", 0, 0, 1);
                part.eq_ = EqSummary(block.Child("Eq", false));
                if (part.type_ != "insert")
                {
                    part.activeModelId_ = static_cast<int>(Integer(block.Find("activeModelId")));
                    const auto metadata = json_variant::parse(Text(block, "toneJson"));
                    const auto &object = *metadata.as_object();
                    part.title_ = MetadataString(object, "title");
                    part.gear_ = MetadataString(object, "gear");
                    part.format_ = MetadataString(object, "format");
                    if (part.format_.empty()) part.format_ = MetadataString(object, "platform");
                }
                result.blocks_.push_back(std::move(part));
            }
        }
        return result;
    }

    void SetParameter(Tree &tree, const std::string &id, double number)
    {
        const auto *definition = std::find_if(PARAMETERS.begin(), PARAMETERS.end(), [&](const auto &p) { return id == p.id; });
        if (definition == PARAMETERS.end()) Fail("Unknown TONE3000 parameter edit");
        Bounded(number, definition->minimum, definition->maximum);
        if (definition->discrete && std::floor(number) != number) Fail("Invalid TONE3000 parameter choice");
        auto *parameters = tree.Child("PARAMETERS");
        Tree *parameter = nullptr;
        for (auto &child : parameters->children)
            if (CurrentId(Text(child, "id")) == id) { parameter = &child; break; }
        if (!parameter)
        {
            parameters->children.emplace_back();
            parameter = &parameters->children.back(); parameter->tag = "PARAM";
            parameter->Set("id", TextValue(id));
        }
        parameter->Set("value", NumericValue(number));
        parameters->modified = tree.modified = true;
    }

    Tree NewBand(const Tone3000EqBand &band)
    {
        Tree result; result.tag = "Band";
        result.Set("type", TextValue(band.type_));
        result.Set("freqHz", NumericValue(band.freqHz_));
        result.Set("gainDb", NumericValue(band.gainDb_));
        result.Set("q", NumericValue(band.q_));
        return result;
    }

    void EditEq(Tree &block, const Tone3000BlockPatch &patch)
    {
        const auto effective = EqSummary(block.Child("Eq", false));
        std::set<int> indexes;
        for (const auto &band : patch.eqBands_)
        {
            if (band.index_ < 0 || band.index_ >= 6 || !indexes.insert(band.index_).second)
                Fail("Invalid or duplicate TONE3000 EQ band index");
            if (!band.type_ && !band.freqHz_ && !band.gainDb_ && !band.q_) Fail("Empty TONE3000 EQ band edit");
            if (band.type_ && !BandRole(band.index_, *band.type_)) Fail("Invalid TONE3000 EQ band role");
            if (band.freqHz_) Bounded(*band.freqHz_, 20, 20000);
            if (band.gainDb_) Bounded(*band.gainDb_, -15, 15);
            if (band.q_) Bounded(*band.q_, .1, 10);
        }
        auto *eq = block.Child("Eq", false);
        if (!eq)
        {
            block.children.emplace_back(); eq = &block.children.back(); eq->tag = "Eq";
            eq->Set("enabled", BoolValue(effective.enabled_)); eq->Set("pre", BoolValue(effective.pre_));
        }
        if (patch.eqEnabled_) eq->Set("enabled", BoolValue(*patch.eqEnabled_));
        if (patch.eqPre_) eq->Set("pre", BoolValue(*patch.eqPre_));
        for (const auto &band : patch.eqBands_)
        {
            // Missing legacy bands acquire the native effective defaults only
            // when an explicit edit addresses a band beyond the stored count.
            while (eq->children.size() <= static_cast<size_t>(band.index_))
                eq->children.push_back(NewBand(effective.bands_[eq->children.size()]));
            auto &node = eq->children[band.index_];
            if (band.type_) node.Set("type", TextValue(*band.type_));
            if (band.freqHz_) node.Set("freqHz", NumericValue(*band.freqHz_));
            if (band.gainDb_) node.Set("gainDb", NumericValue(*band.gainDb_));
            if (band.q_) node.Set("q", NumericValue(*band.q_));
        }
        eq->modified = block.modified = true;
    }

    /** Narrow RIFF/WAVE subset, independent of display metadata or host paths.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-MIX-MATCH] [DES-SEC] [7.33]
     */
    void CheckMonoCab(std::span<const uint8_t> bytes)
    {
        auto u16 = [&](size_t at) -> uint16_t {
            if (at > bytes.size() || bytes.size() - at < 2) Fail("Truncated cab WAV field");
            return uint16_t(bytes[at]) | (uint16_t(bytes[at + 1]) << 8);
        };
        auto u32 = [&](size_t at) -> uint32_t {
            if (at > bytes.size() || bytes.size() - at < 4) Fail("Truncated cab WAV field");
            return uint32_t(bytes[at]) | (uint32_t(bytes[at + 1]) << 8)
                | (uint32_t(bytes[at + 2]) << 16) | (uint32_t(bytes[at + 3]) << 24);
        };
        if (bytes.size() < 12 || std::memcmp(bytes.data(), "RIFF", 4)
            || std::memcmp(bytes.data() + 8, "WAVE", 4) || uint64_t(u32(4)) + 8 != bytes.size())
            Fail("Cab requires a complete RIFF/WAVE asset (RF64 is unsupported)");
        size_t fmt = 0, data = 0, dataSize = 0;
        for (size_t at = 12; at < bytes.size();)
        {
            if (bytes.size() - at < 8) Fail("Truncated cab WAV chunk");
            const size_t size = u32(at + 4), begin = at + 8;
            if (size > bytes.size() - begin || (size & 1) > bytes.size() - begin - size)
                Fail("Cab WAV chunk exceeds asset");
            if (!std::memcmp(bytes.data() + at, "fmt ", 4)) {
                if (fmt || (size != 16 && size != 18)) Fail("Duplicate or unsupported cab WAV format");
                fmt = begin;
                if (size == 18 && u16(begin + 16) != 0) Fail("Unsupported cab WAV format extension");
            }
            if (!std::memcmp(bytes.data() + at, "data", 4)) {
                if (data) Fail("Duplicate cab WAV data");
                data = begin; dataSize = size;
            }
            at = begin + size + (size & 1);
        }
        if (!fmt || !data || !dataSize) Fail("Cab WAV needs nonempty format and audio data");
        const auto format = u16(fmt), channels = u16(fmt + 2), bits = u16(fmt + 14);
        const uint32_t rate = u32(fmt + 4), byteRate = u32(fmt + 8), align = u16(fmt + 12);
        const bool pcm = format == 1 && (bits == 16 || bits == 24 || bits == 32);
        const bool floating = format == 3 && (bits == 32 || bits == 64);
        if ((!pcm && !floating) || channels != 1 || rate < 8000 || rate > 192000
            || align != bits / 8 || uint64_t(rate) * align != byteRate || dataSize % align
            || dataSize / align > rate)
            Fail("Cab requires a short (at most one second) mono PCM/float WAV");
        bool nonzero = false;
        for (size_t at = data; at < data + dataSize; at += align)
        {
            if (floating) {
                double sample;
                if (bits == 32) sample = std::bit_cast<float>(u32(at));
                else {
                    const uint64_t value = uint64_t(u32(at)) | (uint64_t(u32(at + 4)) << 32);
                    sample = std::bit_cast<double>(value);
                }
                if (!Finite(sample) || std::abs(sample) > std::numeric_limits<float>::max())
                    Fail("Cab WAV contains nonfinite or unrepresentable samples");
                nonzero = nonzero || static_cast<float>(sample) != 0;
            } else for (size_t byte = 0; byte < align; ++byte) nonzero = nonzero || bytes[at + byte] != 0;
        }
        if (!nonzero) Fail("Cab WAV is silent");
    }

    std::span<const uint8_t> ActiveAsset(const Tree &block)
    {
        const auto id = Integer(block.Find("activeModelId"));
        for (const auto &model : block.Child("ModelCache")->children)
            if (Integer(model.Find("modelId")) == id) return model.Find("data")->binary;
        Fail("Active TONE3000 model asset is missing");
    }

    // Structural file validation is not a NAM engine load/readiness verdict.
    void CheckAmpAsset(std::span<const uint8_t> bytes)
    {
        const std::string text(reinterpret_cast<const char *>(bytes.data()), bytes.size());
        ToneMetadata(text);
        const auto parsed = json_variant::parse(text);
        const auto &object = *parsed.as_object();
        for (const auto *field : {"version", "architecture"})
            if (!object.contains(field) || !object.at(field).is_string() || object.at(field).as_string().empty())
                Fail("Amp NAM is missing its version or architecture");
        if (!object.contains("config") || !object.at("config").is_object()
            || !object.contains("weights") || !object.at("weights").is_array())
            Fail("Amp NAM has invalid config or weights");
        for (const auto &weight : *object.at("weights").as_array())
            if (!weight.is_number() || !Finite(weight.as_number())
                || std::abs(weight.as_number()) > std::numeric_limits<float>::max())
                Fail("Amp NAM contains invalid weights");
        if (object.contains("metadata") && object.at("metadata").is_object()) {
            const auto &metadata = *object.at("metadata").as_object();
            auto gear = MetadataString(metadata, "gear_type");
            const auto begin = gear.find_first_not_of(' '), end = gear.find_last_not_of(' ');
            gear = begin == std::string::npos ? std::string() : gear.substr(begin, end - begin + 1);
            for (auto &c : gear) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
            // An explicit conflicting capture classification always wins over
            // a catalog label and the caller's amp-head confirmation.
            if (!gear.empty() && gear != "amp" && gear != "preamp" && gear != "pedal_amp")
                Fail("NAM metadata does not describe an amp-head capture");
        }
    }

    Lv2PluginState EncodeStateTree(const Tree &tree)
    {
        Writer out;
        out.Raw(std::span<const uint8_t>(reinterpret_cast<const uint8_t *>("T3KB"), 4));
        out.Node(tree);
        StateTree(out.bytes); // validate the complete derived state before publication
        Lv2PluginState result; result.isValid_ = true;
        auto &entry = result.values_[Tone3000Preset::STATE_URI];
        entry.atomType_ = ATOM_STRING; entry.flags_ = 3; entry.value_ = Encode(out.bytes);
        return result;
    }
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-26] [DES-MIX-MATCH] [DES-STATE] [7.33] */
Tone3000AmpCabPartition Tone3000Preset::PartitionAmpCab(const Lv2PluginState &state,
    const std::string &ampBlockId, const std::string &cabBlockId, bool confirmAmpHead)
{
    if (!confirmAmpHead) Fail("Explicit amp-head capture confirmation is required");
    Identity(ampBlockId, 512); Identity(cabBlockId, 512);
    const auto bytes = Decode(state);
    const auto source = StateTree(bytes);
    const auto summary = Summarize(source);
    const auto parameters = ParameterValues(*source.Child("PARAMETERS"), "PARAM");
    auto parameter = [&](const char *id) { return ParameterOrDefault(parameters, id); };
    if (summary.stereoEnabled_ || !summary.branchAfterBlockId_.empty()
        || (summary.inputMode_ != "left" && summary.inputMode_ != "right"))
        Fail("Partition requires explicit mono input and unbranched serial routing");
    if (parameter("osEnabled") || parameter("spreadEnabled") || parameter("alignEnabled")
        || parameter("chainSoloLeft") || parameter("chainSoloRight")
        || parameter("chainInvertLeft") || parameter("chainInvertRight")
        || parameter("outputBalance") != .5 || parameter("chainPanLeft") != 0 || parameter("chainPanRight") != 1)
        Fail("Disable source oversampling/spatial/image processing before partitioning");
    const auto &snapshot = *source.Child("ChainSnapshot");
    const Tree *amp = nullptr, *cab = nullptr;
    for (const auto *lane : {snapshot.Child("ChainBlocks"), snapshot.Child("RightChainBlocks", false)}) {
        if (!lane) continue;
        for (const auto &block : lane->children) {
            const auto type = Text(block, "type");
            if (type == "insert") continue;
            if (lane->tag != "ChainBlocks" || !Boolean(block, "enabled", true))
                Fail("Partition requires enabled blocks on the left serial lane only");
            if (type == "nam" && !amp && !cab && Text(block, "id") == ampBlockId) amp = &block;
            else if (type == "ir" && amp && !cab && Text(block, "id") == cabBlockId) cab = &block;
            else Fail("Choose exactly one NAM amp followed by one cab IR; combined captures stay intact");
        }
    }
    if (!amp || !cab) Fail("Requested amp/cab blocks are missing");
    const auto ampMetadata = json_variant::parse(Text(*amp, "toneJson"));
    const auto cabMetadata = json_variant::parse(Text(*cab, "toneJson"));
    if (MetadataString(*ampMetadata.as_object(), "gear") != "amp"
        || MetadataString(*cabMetadata.as_object(), "gear") != "cab")
        Fail("Only explicitly classified amp-head and cab captures can be partitioned");
    CheckAmpAsset(ActiveAsset(*amp)); CheckMonoCab(ActiveAsset(*cab));
    const auto sourceId = Text(source, "activePresetId");
    if (sourceId.size() > 480) Fail("Source identity is too long for derived stage identities");
    const auto sourceName = Text(source, "activePresetName");
    if (sourceName.size() > 480) Fail("Source name is too long for derived stage names");
    auto makeStage = [&](const Tree &block, bool ampStage) {
        Tree tree = source;
        const auto id = (sourceId.empty() ? std::string("pipedal-derived") : sourceId)
            + (ampStage ? ":pipedal-amp" : ":pipedal-cab");
        tree.Set("activePresetId", TextValue(id));
        tree.Set("activePresetName", TextValue(sourceName
            + (ampStage ? " (Amp stage)" : " (Cab stage)")));
        tree.Set("inputMode", TextValue(ampStage ? summary.inputMode_ : "left"));
        auto *chain = tree.Child("ChainSnapshot");
        chain->Set("stereoEnabled", BoolValue(false));
        chain->Set("branchSide", TextValue("left")); chain->Set("branchAfterBlockId", TextValue(""));
        Tree lane; lane.tag = "ChainBlocks"; lane.modified = true; lane.children.push_back(block);
        Tree right; right.tag = "RightChainBlocks"; right.modified = true;
        chain->children = {std::move(lane), std::move(right)};
        tree.children.erase(std::remove_if(tree.children.begin(), tree.children.end(),
            [](const Tree &child) { return child.tag == "MidiMappings"; }), tree.children.end());
        Tree midi; midi.tag = "MidiMappings"; midi.modified = true; tree.children.push_back(std::move(midi));
        // Explicitly seed every pinned parameter: no duplicated gate/pitch/tone
        // or image processing, and no implicit host constructor defaults.
        for (const auto &definition : PARAMETERS) {
            const std::string_view name = definition.id;
            const bool keepInput = name == "inputLevel" || name.starts_with("gate") || name.starts_with("pitch")
                || name == "calibrateInput" || name == "inputCalibrationLevel" || name == "targetLoudness";
            const bool keepOutput = name.starts_with("tone") || name == "outputLevel";
            double value = (ampStage ? keepInput : keepOutput) ? parameter(definition.id) : definition.initial;
            if (name == "osEnabled" || name == "osFactor" || name == "spreadEnabled" || name == "alignEnabled"
                || (!ampStage && (name == "gateEnabled" || name == "pitchEnabled" || name == "calibrateInput"))
                || (ampStage && name == "toneEqEnabled")) value = 0;
            SetParameter(tree, definition.id, value);
        }
        return EncodeStateTree(tree);
    };
    Tone3000AmpCabPartition result;
    result.ampBlockId = ampBlockId; result.cabBlockId = cabBlockId;
    result.ampState = makeStage(*amp, true); result.cabState = makeStage(*cab, false);
    return result;
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-11] [DES-LIBRARY] [3.8] */
Tone3000PresetInfo Tone3000Preset::Inspect(std::span<const uint8_t> bytes, const std::string &filename,
                                        const std::string &section)
{
    return Parse(bytes, filename, section).info;
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-11] [DES-LIBRARY] [DES-STATE] [3.8] */
Lv2PluginState Tone3000Preset::BuildState(std::span<const uint8_t> bytes, const std::string &filename,
                                       const std::string &section, const Lv2PluginState *previous)
{
    const auto preset = Parse(bytes, filename, section);
    const auto managed = ParameterValues(*preset.body.Child("Params"), "Param");
    std::map<std::string, double> oldParameters;
    std::vector<uint8_t> oldBytes;
    std::optional<Tree> old;
    if (previous)
    {
        oldBytes = Decode(*previous);
        if (oldBytes.size() < 5 || std::memcmp(oldBytes.data(), "T3KB", 4)) Fail("Unsupported previous TONE3000 state magic");
        old = Reader(std::span<const uint8_t>(oldBytes).subspan(4)).Complete("TONE3000State");
        Schema(*old);
        old->Child("ChainSnapshot");
        oldParameters = ParameterValues(*old->Child("PARAMETERS"), "PARAM");
        // Existing session settings have exact typed values, not string guesses.
        const auto input = Text(*old, "inputMode", "stereo");
        if (input != "stereo" && input != "left" && input != "right" && input != "dual") Fail("Invalid previous TONE3000 input mode");
        for (auto key : {"editorScale", "editorExtraHeight"}) if (const auto *v = old->Find(key)) Number(*v);
        old->Child("MidiMappings", false);
    }
    Writer out;
    out.Raw(std::span<const uint8_t>(reinterpret_cast<const uint8_t *>("T3KB"), 4));
    out.String("TONE3000State");
    out.Compressed(6);
    out.Integer("schemaVersion", 1);
    out.Text("activePresetId", preset.info.id);
    out.Text("activePresetName", preset.info.name);
    for (auto key : {"inputMode", "editorScale", "editorExtraHeight"})
    {
        if (old && old->Find(key)) { out.String(key); out.Raw(old->Find(key)->raw); }
        else if (std::string_view(key) == "inputMode") out.Text(key, "stereo");
        else if (std::string_view(key) == "editorScale") out.Number(key, 1);
        else out.Integer(key, 36);
    }
    out.Compressed(3);
    out.String("PARAMETERS"); out.Compressed(0); out.Compressed(PARAMETERS.size());
    for (const auto &parameter : PARAMETERS)
    {
        double value = parameter.initial;
        const auto &source = parameter.session ? oldParameters : managed;
        if (const auto found = source.find(parameter.id); found != source.end()) value = found->second;
        out.String("PARAM"); out.Compressed(2); out.Text("id", parameter.id); out.Number("value", value); out.Compressed(0);
    }
    if (old && old->Child("MidiMappings", false)) out.Raw(old->Child("MidiMappings")->raw);
    else { out.String("MidiMappings"); out.Compressed(0); out.Compressed(0); }
    out.Raw(preset.body.Child("ChainSnapshot")->raw);
    Lv2PluginState result;
    result.isValid_ = true;
    auto &entry = result.values_[STATE_URI];
    entry.atomType_ = ATOM_STRING;
    entry.flags_ = 3;
    entry.value_ = Encode(out.bytes);
    return result;
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [DES-OPERATE] [DES-SEC] [3.11] */
Tone3000StateSummary Tone3000Preset::SummarizeState(const Lv2PluginState &state)
{
    const auto bytes = Decode(state);
    return Summarize(StateTree(bytes));
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-17] [DES-STAGE] [7.1] */
Tone3000PresetInfo Tone3000Preset::InspectState(const Lv2PluginState &state)
{
    const auto bytes = Decode(state);
    const auto tree = StateTree(bytes);
    Tone3000PresetInfo result;
    result.id = Text(tree, "activePresetId");
    result.name = Text(tree, "activePresetName");
    CheckSnapshot(*tree.Child("ChainSnapshot"), result);
    return result;
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-25] [DES-STAGE-EXPORT] [7.11] */
std::vector<uint8_t> Tone3000Preset::ExportPreset(const Lv2PluginState &state,
                                               const std::string &rawId, const std::string &name)
{
    Identity(rawId, 512);
    Identity(name, 512);
    // Use a safe, portable identity independent of display name or source ID.
    Stem(rawId + ".t3kpreset");
    const auto bytes = Decode(state);
    const auto tree = StateTree(bytes);
    const auto parameters = ParameterValues(*tree.Child("PARAMETERS"), "PARAM");
    Writer header;
    header.String("T3KPresetHeader"); header.Compressed(2);
    header.Text("id", rawId); header.Text("name", name); header.Compressed(0);
    Writer out;
    out.Raw(std::span<const uint8_t>(reinterpret_cast<const uint8_t *>("T3KH"), 4));
    for (size_t i = 0; i < 4; ++i) out.Byte(static_cast<uint8_t>(header.bytes.size() >> (8 * i)));
    out.Raw(header.bytes);
    out.String("T3KPreset"); out.Compressed(3);
    out.Integer("schemaVersion", 1); out.Text("id", rawId); out.Text("name", name);
    out.Compressed(2);
    out.Raw(tree.Child("ChainSnapshot")->raw);
    out.String("Params"); out.Compressed(0);
    out.Compressed(std::count_if(PARAMETERS.begin(), PARAMETERS.end(), [](const auto& p) { return !p.session; }));
    for (const auto& parameter : PARAMETERS)
    {
        if (parameter.session) continue;
        const auto found = parameters.find(parameter.id);
        const double value = found == parameters.end() ? parameter.initial : found->second;
        out.String("Param"); out.Compressed(2);
        out.Text("id", parameter.id); out.Number("value", value); out.Compressed(0);
    }
    // Validate the complete output before returning anything to the caller.
    Parse(out.bytes, rawId + ".t3kpreset", "user");
    return out.bytes;
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [DES-OPERATE] [3.11] */
double Tone3000Preset::OutputLevel(const Lv2PluginState &state)
{
    const auto bytes=Decode(state); const auto tree=StateTree(bytes);
    const auto parameters=ParameterValues(*tree.Child("PARAMETERS"),"PARAM");
    const auto found=parameters.find("outputLevel");
    return found==parameters.end() ? .5 : found->second;
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [DES-STAGE-BRIDGE] [7.6] */
Lv2PluginState Tone3000Preset::EditState(const Lv2PluginState &state, const Tone3000StatePatch &patch)
{
    const auto bytes = Decode(state);
    auto tree = StateTree(bytes);
    if (!patch.inputMode_ && !patch.calibrateInput_ && !patch.inputCalibrationLevel_
        && !patch.osEnabled_ && !patch.osFactor_ && !patch.outputLevel_ && patch.blocks_.empty()) Fail("Empty TONE3000 state edit");
    if (patch.blocks_.size() > 256) Fail("Too many TONE3000 block edits");
    auto *snapshot = tree.Child("ChainSnapshot");
    if (patch.inputMode_)
    {
        const auto &input = *patch.inputMode_;
        if (input != "stereo" && input != "left" && input != "right" && input != "dual") Fail("Invalid TONE3000 input mode");
        if ((input == "stereo" || input == "dual") && Boolean(*snapshot, "stereoEnabled", false))
        {
            const auto branchId = Text(*snapshot, "branchAfterBlockId");
            const auto *lane = snapshot->Child(Text(*snapshot, "branchSide", "left") == "right" ? "RightChainBlocks" : "ChainBlocks", false);
            if (!branchId.empty() && lane && std::any_of(lane->children.begin(), lane->children.end(), [&](const auto &block) {
                    return Text(block, "id") == branchId && Text(block, "type") != "insert";
                }))
                Fail("Stereo/dual input conflicts with this active chain branch");
        }
        tree.Set("inputMode", TextValue(input));
    }
    if (patch.calibrateInput_) SetParameter(tree, "calibrateInput", *patch.calibrateInput_ ? 1 : 0);
    if (patch.inputCalibrationLevel_) SetParameter(tree, "inputCalibrationLevel", *patch.inputCalibrationLevel_);
    if (patch.osEnabled_) SetParameter(tree, "osEnabled", *patch.osEnabled_ ? 1 : 0);
    if (patch.osFactor_) SetParameter(tree, "osFactor", *patch.osFactor_);
    if (patch.outputLevel_) SetParameter(tree, "outputLevel", *patch.outputLevel_);
    std::set<std::string> blockIds;
    for (const auto &edit : patch.blocks_)
    {
        Identity(edit.blockId_, 512);
        if (!blockIds.insert(edit.blockId_).second) Fail("Duplicate TONE3000 block edit");
        if (!edit.enabled_ && !edit.normalize_ && !edit.inputGain_ && !edit.outputGain_ && !edit.mix_
            && !edit.slimSize_ && !edit.eqEnabled_ && !edit.eqPre_ && edit.eqBands_.empty()) Fail("Empty TONE3000 block edit");
        Tree *block = nullptr, *blockLane = nullptr;
        for (auto &lane : snapshot->children) for (auto &candidate : lane.children)
            if (Text(candidate, "id") == edit.blockId_) { block = &candidate; blockLane = &lane; }
        if (!block) Fail("Unknown TONE3000 block edit identity");
        const auto type = Text(*block, "type");
        if (type == "insert") Fail("Insert slots do not support tone controls");
        if (type == "ir" && (edit.normalize_ || edit.slimSize_)) Fail("IR normalization/size edits have no effect");
        for (const auto &value : {edit.inputGain_, edit.outputGain_, edit.mix_}) if (value) Bounded(*value, 0, 1);
        if (edit.slimSize_ && (*edit.slimSize_ != 0 && *edit.slimSize_ != 1)) Fail("NAM size must request Lite or Full");
        if (edit.enabled_) block->Set("enabled", BoolValue(*edit.enabled_));
        if (edit.normalize_) block->Set("normalize", BoolValue(*edit.normalize_));
        if (edit.inputGain_) block->Set("inputGain", NumericValue(*edit.inputGain_));
        if (edit.outputGain_) block->Set("outputGain", NumericValue(*edit.outputGain_));
        if (edit.mix_) block->Set("mix", NumericValue(*edit.mix_));
        if (edit.slimSize_) block->Set("slimSize", NumericValue(*edit.slimSize_));
        if (edit.eqEnabled_ || edit.eqPre_ || !edit.eqBands_.empty()) EditEq(*block, edit);
        blockLane->modified = snapshot->modified = tree.modified = true;
    }
    Writer out;
    out.Raw(std::span<const uint8_t>(reinterpret_cast<const uint8_t *>("T3KB"), 4));
    out.Node(tree);
    // Validate the completed candidate while all original span owners live.
    StateTree(out.bytes);
    Lv2PluginState result = state;
    result.values_[STATE_URI].value_ = Encode(out.bytes);
    return result;
}
