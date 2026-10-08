// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT

#include "pch.h"
#include "catch.hpp"
#include "PluginHost.hpp"
#include "Lv2Effect.hpp"
#include "Pedalboard.hpp"
#include "RingBufferReader.hpp"
#include "AesDigest.hpp"
#include "json.hpp"
#include "Tone3000Stage.hpp"
#include "../tools/gig-rig/Tone3000StageBridge.hpp"
#include "lv2/atom/util.h"
#include "lv2/patch/patch.h"
#include "lv2/lv2plug.in/ns/ext/buf-size/buf-size.h"
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <set>
#include <thread>
#include <spawn.h>
#include <sys/wait.h>
#include <cerrno>
#include <map>
#include <memory>
#include <fstream>
#include "Lv2Pedalboard.hpp"
#include "JackConfiguration.hpp"
#include "Tone3000MixMatch.hpp"
#include "Tone3000Performance.hpp"

extern char **environ;

namespace pipedal
{
    namespace
    {
        // This changes only the host feature list. Lv2Effect still assembles
        // log/options/paths/browser/worker and performs the real instantiate.
        class UnboundedHost : public IHost
        {
        public:
            explicit UnboundedHost(IHost &host) : host(host)
            {
                for (auto p = host.GetLv2Features(); *p != nullptr; ++p)
                {
                    if (std::strcmp((*p)->URI, LV2_BUF_SIZE__boundedBlockLength) != 0)
                    {
                        features.push_back(*p);
                    }
                }
                features.push_back(nullptr);
            }

            LilvWorld *getWorld() override { return host.getWorld(); }
            LV2_URID_Map *GetLv2UridMap() override { return host.GetLv2UridMap(); }
            MapFeature &GetMapFeature() override { return host.GetMapFeature(); }
            LV2_URID GetLv2Urid(const char *uri) override { return host.GetLv2Urid(uri); }
            std::string Lv2UridToString(LV2_URID urid) override { return host.Lv2UridToString(urid); }
            LV2_Feature *const *GetLv2Features() const override { return features.data(); }
            double GetSampleRate() const override { return host.GetSampleRate(); }
            void SetMaxAudioBufferSize(size_t size) override { host.SetMaxAudioBufferSize(size); }
            size_t GetMaxAudioBufferSize() const override { return host.GetMaxAudioBufferSize(); }
            size_t GetAtomBufferSize() const override { return host.GetAtomBufferSize(); }
            bool HasMidiInputChannel() const override { return host.HasMidiInputChannel(); }
            std::shared_ptr<Lv2PluginInfo> GetPluginInfo(const std::string &uri) const override { return host.GetPluginInfo(uri); }
            IEffect *CreateEffect(PedalboardItem &item) override { return host.CreateEffect(item); }
            std::string GetPluginStoragePath() const override { return host.GetPluginStoragePath(); }
            const ChannelSelection &GetChannelSelection() const override { return host.GetChannelSelection(); }

        private:
            IHost &host;
            std::vector<LV2_Feature *> features;
        };

        std::shared_ptr<Lv2PluginInfo> PrepareHost(PluginHost &host)
        {
            const char *display = std::getenv("DISPLAY");
            REQUIRE((display == nullptr || display[0] == '\0'));
            const char *path = std::getenv("LV2_PATH");
            REQUIRE(path != nullptr);
            REQUIRE(path[0] != '\0');
            // LoadLilv sets LV2_PATH, so retain a copy across setenv.
            std::string lv2Path(path);
            const char *storage = std::getenv("PIPEDAL_T3K_TEST_STORAGE");
            std::filesystem::path storagePath = storage ? storage : "/tmp/pipedal-t3k-runtime";
            std::filesystem::create_directories(storagePath);
            host.SetPluginStoragePath(storagePath);
            host.setSampleRate(48000);
            host.asIHost()->SetMaxAudioBufferSize(64);
            host.LoadLilv(lv2Path.c_str());
            const char *uri = std::getenv("PIPEDAL_T3K_TEST_URI");
            auto info = host.GetPluginInfo(uri ? uri : "https://www.tone3000.com/plugin");
            REQUIRE(info != nullptr);
            std::cout << "T3K actual-host: uri=" << info->uri()
                      << " name=" << info->name() << " sampleRate=48000 maxBlockLength=64"
                      << " optionsSampleRate=44100 (existing host discrepancy)"
                      << " DISPLAY=" << (display ? "empty" : "unset") << " LV2_PATH=" << lv2Path << '\n';
            return info;
        }

        PedalboardItem MakeItem(const Lv2PluginInfo &info)
        {
            PedalboardItem item;
            item.instanceId(1);
            item.uri(info.uri());
            item.pluginName(info.name());
            for (const auto &port : info.ports())
            {
                if (port->is_input() && port->is_control_port())
                {
                    item.controlValues().push_back(ControlValue(port->symbol(), port->default_value()));
                }
            }
            return item;
        }

        class ActiveEffect
        {
        public:
            explicit ActiveEffect(Lv2Effect &effect) : effect(effect) { effect.Activate(); }
            ~ActiveEffect() { effect.Deactivate(); }
        private:
            Lv2Effect &effect;
        };

        /** Actual-host atom probe; does not establish audible model readiness.
         * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.9]
         */
        class NumericPatchProbe
        {
        public:
            NumericPatchProbe(PluginHost &host, std::shared_ptr<Lv2PluginInfo> info, PedalboardItem &item)
                : host(host), ring(65536, false), writer(&ring)
            {
                effect = std::make_unique<Lv2Effect>(host.asIHost(), info, item);
                inputs.resize(effect->GetNumberOfInputAudioBuffers(), std::vector<float>(64));
                outputs.resize(effect->GetNumberOfOutputAudioBuffers(), std::vector<float>(64));
                for (size_t i = 0; i < inputs.size(); ++i) { effect->SetAudioInputBuffer(i, inputs[i].data()); }
                for (size_t i = 0; i < outputs.size(); ++i) { effect->SetAudioOutputBuffer(i, outputs[i].data()); }
                // Activate allocates/connects previously unassigned atom ports.
                // Lv2Effect's destructor also deactivates if a REQUIRE throws
                // before this fixture's constructor completes.
                effect->Activate();
                REQUIRE(effect->GetAtomInputBuffer() != nullptr);
                REQUIRE(effect->GetAtomOutputBuffer() != nullptr);
                for (size_t i = 0; i < 64; ++i) { EmptyBlock(); }
            }

            ~NumericPatchProbe() { effect->Deactivate(); }

            LV2_URID Urid(const char *uri) { return host.GetLv2Urid(uri); }
            void Begin() { effect->ResetAtomBuffers(); }
            Lv2Effect &Effect() { return *effect; }

            LV2_Atom_Object *FirstInputObject()
            {
                // The host's private sequence forge is closed by Run(). Mutate
                // the already forged object without changing its byte length.
                auto first = reinterpret_cast<LV2_Atom_Event *>(effect->GetAtomInputBuffer() + sizeof(LV2_Atom_Sequence));
                REQUIRE(first->body.type == Urid(LV2_ATOM__Object));
                return reinterpret_cast<LV2_Atom_Object *>(&first->body);
            }

            void GetAll()
            {
                effect->RequestPatchProperty(Urid("urn:pipedal:gig-rig:placeholder"));
                auto object = FirstInputObject();
                auto property = reinterpret_cast<LV2_Atom_Property_Body *>(reinterpret_cast<uint8_t *>(&object->body) + sizeof(object->body));
                property->key = Urid("urn:pipedal:gig-rig:ignored");
                // No patch:property remains: this is a property-less Get with
                // one unrelated extension field, which the wrapper must ignore.
            }

            std::map<LV2_URID, float> Run(size_t outputCapacity = 0)
            {
                auto output = effect->GetAtomOutputBuffer();
                if (outputCapacity)
                {
                    REQUIRE(outputCapacity >= sizeof(LV2_Atom_Sequence));
                    REQUIRE(outputCapacity < host.asIHost()->GetAtomBufferSize());
                    reinterpret_cast<LV2_Atom *>(output)->size = outputCapacity;
                    std::memset(output + outputCapacity, 0xa5, host.asIHost()->GetAtomBufferSize() - outputCapacity);
                }
                effect->Run(64, &writer);
                auto sequence = reinterpret_cast<const LV2_Atom_Sequence *>(output);
                REQUIRE(sequence->atom.type == Urid(LV2_ATOM__Sequence));
                REQUIRE(sequence->atom.size >= sizeof(LV2_Atom_Sequence_Body));
                REQUIRE(sequence->atom.size + sizeof(LV2_Atom) <= (outputCapacity ? outputCapacity : host.asIHost()->GetAtomBufferSize()));
                if (outputCapacity)
                {
                    for (size_t i = outputCapacity; i < host.asIHost()->GetAtomBufferSize(); ++i) { REQUIRE(output[i] == 0xa5); }
                }
                std::map<LV2_URID, float> values;
                LV2_ATOM_SEQUENCE_FOREACH(sequence, event)
                {
                    if (event->body.type != Urid(LV2_ATOM__Object) && event->body.type != Urid(LV2_ATOM__Blank)) { continue; }
                    auto object = reinterpret_cast<const LV2_Atom_Object *>(&event->body);
                    if (object->body.otype != Urid(LV2_PATCH__Set)) { continue; }
                    const LV2_Atom *property = nullptr, *value = nullptr;
                    lv2_atom_object_get(object, Urid(LV2_PATCH__property), &property, Urid(LV2_PATCH__value), &value, 0);
                    REQUIRE(property != nullptr);
                    REQUIRE(value != nullptr);
                    REQUIRE(property->type == Urid(LV2_ATOM__URID));
                    REQUIRE(property->size == sizeof(LV2_URID));
                    REQUIRE(value->type == Urid(LV2_ATOM__Float));
                    REQUIRE(value->size == sizeof(float));
                    auto number = reinterpret_cast<const LV2_Atom_Float *>(value)->body;
                    REQUIRE(std::isfinite(number));
                    values[reinterpret_cast<const LV2_Atom_URID *>(property)->body] = number;
                }
                std::vector<uint8_t> discarded(ring.readSpace());
                if (!discarded.empty()) { REQUIRE(ring.read(discarded.size(), discarded.data())); }
                REQUIRE_FALSE(effect->HasErrorMessage());
                std::this_thread::sleep_for(std::chrono::microseconds(1333));
                return values;
            }

            std::map<LV2_URID, float> EmptyBlock() { Begin(); return Run(); }

            float Read(LV2_URID property)
            {
                for (size_t attempt = 0; attempt < 64; ++attempt)
                {
                    Begin();
                    effect->RequestPatchProperty(property);
                    auto values = Run();
                    auto found = values.find(property);
                    if (found != values.end()) { return found->second; }
                }
                FAIL("No authoritative numeric response to individual patch:Get");
                return 0;
            }

            float SetAndRead(LV2_URID property, float value)
            {
                Begin();
                LV2_Atom_Float atom = {{sizeof(float), Urid(LV2_ATOM__Float)}, value};
                effect->SetPatchProperty(property, sizeof(atom), reinterpret_cast<LV2_Atom *>(&atom));
                Run();
                return Read(property);
            }

        private:
            PluginHost &host;
            RingBuffer<false, true> ring;
            RealtimeRingBufferWriter writer;
            std::unique_ptr<Lv2Effect> effect;
            std::vector<std::vector<float>> inputs, outputs;
        };

        std::vector<Lv2PatchPropertyInfo> NumericProperties(const Lv2PluginInfo &info)
        {
            std::vector<Lv2PatchPropertyInfo> result;
            for (const auto &property : info.patchProperties())
            {
                if (property.readable() && property.writable() && property.type() == LV2_ATOM__Float) { result.push_back(property); }
            }
            REQUIRE(result.size() == 43);
            return result;
        }

        void RequireNumericValue(float actual, float expected)
        {
            REQUIRE(std::isfinite(actual));
            REQUIRE(std::abs(actual - expected) <= std::max(0.0001f, std::abs(expected) * 0.0001f));
        }
    }
}

using namespace pipedal;

/** Real Linux wrapper/handle/message-thread/timer gate with silent audio only.
 * Silence must never qualify an owner measurement or produce a saved trim.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [DES-TEST] [7.5] [7.6]
 */
TEST_CASE("TONE3000 actual-host Stage bridge dispatch and silence rejection", "[.][gig_rig_stage]")
{
    PluginHost host;
    auto info=PrepareHost(host);
    auto item=MakeItem(*info);
    NumericPatchProbe probe(host,info,item);
    auto& effect=probe.Effect();
    auto wait=[&](uint64_t token) {
        const auto until=std::chrono::steady_clock::now()+std::chrono::seconds(4);
        while(std::chrono::steady_clock::now()<until) {
            probe.EmptyBlock();
            std::string raw;const auto count=effect.ReadTone3000Stage(token,raw);
            REQUIRE(count>=0);
            if(count>0) {
                auto result=Tone3000Stage::Result(raw);
                if(Tone3000Stage::Terminal(result))return result;
            }
        }
        FAIL("Native Stage timer failed to finish in a headless LV2 host");
        return json_variant();
    };
    std::string raw;
    REQUIRE(effect.SubmitTone3000Stage(1,TONE3000_STAGE_RUNTIME,{})==0);
    auto runtime=wait(1);
    REQUIRE(runtime["state"].as_string()=="done");
    REQUIRE(runtime["runtime"].is_object());
    REQUIRE(effect.ReadTone3000Stage(99,raw)==TONE3000_STAGE_STALE);
    REQUIRE(effect.SubmitTone3000Stage(1,TONE3000_STAGE_CANCEL,{})==0);
    REQUIRE(effect.ReadTone3000Stage(1,raw)>0);
    REQUIRE(Tone3000Stage::Result(raw)["state"].as_string()=="done");
    REQUIRE(effect.SubmitTone3000Stage(2,TONE3000_STAGE_MEASURE_OUTPUT,"{\"seconds\":1}")==0);
    auto measured=wait(2);
    REQUIRE(measured["state"].as_string()=="done");
    REQUIRE_FALSE(measured["valid"].as_bool());
    REQUIRE(measured["silent"].as_bool());
    REQUIRE(measured["samples"].as_number()==48000);
    REQUIRE(effect.SubmitTone3000Stage(3,TONE3000_STAGE_MEASURE_OUTPUT,"{\"seconds\":10}")==0);
    for(int i=0;i<32;++i)probe.EmptyBlock();
    REQUIRE(effect.SubmitTone3000Stage(3,TONE3000_STAGE_CANCEL,{})==0);
    REQUIRE(wait(3)["state"].as_string()=="cancelled");
}

/**
 * Hidden, opt-in device test. Use the service-equivalent HOME/XDG/LV2_PATH.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [DES-COMPAT] [1.7]
 */
TEST_CASE("TONE3000 actual-host feature omission diagnostic", "[.][gig_rig_feature_omission]")
{
    PluginHost host;
    auto info = PrepareHost(host);
    UnboundedHost unbounded(*host.asIHost());
    auto item = MakeItem(*info);
    bool missingFeatureAccepted = false;
    try
    {
        Lv2Effect effect(&unbounded, info, item);
        missingFeatureAccepted = true;
    }
    catch (const std::exception &e)
    {
        // A failure later in construction would not demonstrate instantiate
        // rejection. Only the actual instantiate-error paths count here.
        std::string reason(e.what());
        REQUIRE((reason.find("Failed to create plugin") == 0 || reason.find("Plugin threw an exception:") == 0));
        std::cout << "T3K actual-host boundedBlockLength=omitted instantiate=FAILED reason=" << e.what() << '\n';
    }
    if (missingFeatureAccepted)
    {
        std::cout << "T3K actual-host boundedBlockLength=omitted instantiate=SUCCEEDED"
                  << " (F18 omission not rejected by this installed artifact)\n";
    }
}

/**
 * Isolate the omitted-feature constructor path in a fresh process: the existing
 * constructor uses raw worker-feature allocations that leak when it throws.
 * posix_spawn avoids forking into inherited JUCE/worker threads from other tests.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [DES-COMPAT] [1.7]
 */
TEST_CASE("TONE3000 actual-host bounded feature A/B", "[.][gig_rig_runtime]")
{
    std::string binary = std::filesystem::read_symlink("/proc/self/exe").string();
    char testName[] = "TONE3000 actual-host feature omission diagnostic";
    char *arguments[] = {binary.data(), testName, nullptr};
    pid_t child = -1;
    int spawned = posix_spawn(&child, binary.c_str(), nullptr, nullptr, arguments, environ);
    REQUIRE(spawned == 0);
    int status = 0;
    pid_t waited;
    do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
    REQUIRE(waited == child);
    REQUIRE(WIFEXITED(status));
    REQUIRE(WEXITSTATUS(status) == 0);

    PluginHost host;
    auto info = PrepareHost(host);
    auto item = MakeItem(*info);
    REQUIRE_NOTHROW(Lv2Effect(host.asIHost(), info, item));
    std::cout << "T3K actual-host boundedBlockLength=present instantiate=SUCCEEDED\n";
}

/**
 * Synthetic signal proves processing through Lv2Effect, not service/audio-device
 * qualification or that a particular rig/model has finished loading.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [FR-4] [DES-COMPAT] [DES-TEST] [4.5]
 */
TEST_CASE("TONE3000 actual-host audio and numeric property smoke test", "[.][gig_rig_runtime]")
{
    PluginHost host;
    auto info = PrepareHost(host);
    // This probe calls Run directly, rather than the staged audio path. The
    // selected block must already satisfy the plugin's declared bounds.
    REQUIRE((info->minBlockLength() == -1 || info->minBlockLength() <= 64));
    REQUIRE((info->maxBlockLength() == -1 || info->maxBlockLength() >= 64));
    auto item = MakeItem(*info);
    const char *presetUri = std::getenv("PIPEDAL_T3K_TEST_PRESET_URI");
    if (presetUri && presetUri[0])
    {
        item.lilvPresetUri(presetUri);
    }
    Lv2Effect effect(host.asIHost(), info, item);
    REQUIRE(effect.GetNumberOfInputAudioBuffers() > 0);
    REQUIRE(effect.GetNumberOfOutputAudioBuffers() > 0);
    constexpr size_t frames = 64;
    std::vector<std::vector<float>> inputs(effect.GetNumberOfInputAudioBuffers(), std::vector<float>(frames));
    std::vector<std::vector<float>> outputs(effect.GetNumberOfOutputAudioBuffers(), std::vector<float>(frames));
    for (size_t c = 0; c < inputs.size(); ++c)
    {
        effect.SetAudioInputBuffer(c, inputs[c].data());
    }
    for (size_t c = 0; c < outputs.size(); ++c)
    {
        effect.SetAudioOutputBuffer(c, outputs[c].data());
    }
    RingBuffer<false, true> ring(65536, false);
    RealtimeRingBufferWriter writer(&ring);
    ActiveEffect active(effect);
    std::set<LV2_URID> expectedProperties;
    std::set<LV2_URID> returnedProperties;
    for (const auto &property : info->patchProperties())
    {
        if (property.readable() && property.type() == LV2_ATOM__Float)
        {
            expectedProperties.insert(host.GetLv2Urid(property.uri().c_str()));
        }
    }
    REQUIRE(expectedProperties.size() == 43);
    const auto objectType = host.GetLv2Urid(LV2_ATOM__Object);
    const auto blankType = host.GetLv2Urid(LV2_ATOM__Blank);
    const auto setType = host.GetLv2Urid(LV2_PATCH__Set);
    const auto getType = host.GetLv2Urid(LV2_PATCH__Get);
    const auto sequenceType = host.GetLv2Urid(LV2_ATOM__Sequence);
    const auto propertyType = host.GetLv2Urid(LV2_PATCH__property);
    const auto valueType = host.GetLv2Urid(LV2_PATCH__value);
    const auto uridType = host.GetLv2Urid(LV2_ATOM__URID);
    const auto floatType = host.GetLv2Urid(LV2_ATOM__Float);
    double sumSquares = 0;
    float peak = 0;
    size_t measuredSamples = 0;
    size_t sentGetObjects = 0;
    size_t outputEvents = 0;
    std::vector<uint8_t> discarded(65536);
    for (size_t block = 0; block < 2250; ++block)
    {
        for (size_t n = 0; n < frames; ++n)
        {
            double t = (block * frames + n) / 48000.0;
            float signal = 0.08f * std::sin(2 * 3.141592653589793 * 110 * t)
                         + 0.02f * std::sin(2 * 3.141592653589793 * 330 * t);
            for (auto &channel : inputs) { channel[n] = signal; }
        }
        effect.ResetAtomBuffers();
        if (block % 100 == 0)
        {
            for (auto property : expectedProperties) { effect.RequestPatchProperty(property); }
        }
        effect.Run(frames, &writer);
        if (block % 100 == 0)
        {
            // Run closes the input forge frame. Verify that this test really
            // delivered every requested property via a valid input sequence.
            auto input = reinterpret_cast<const LV2_Atom_Sequence *>(effect.GetAtomInputBuffer());
            REQUIRE(input != nullptr);
            REQUIRE(input->atom.type == sequenceType);
            std::set<LV2_URID> delivered;
            LV2_ATOM_SEQUENCE_FOREACH(input, event)
            {
                if (event->body.type != objectType) { continue; }
                auto object = reinterpret_cast<const LV2_Atom_Object *>(&event->body);
                if (object->body.otype != getType) { continue; }
                const LV2_Atom *property = nullptr;
                lv2_atom_object_get(object, propertyType, &property, 0);
                REQUIRE(property != nullptr);
                REQUIRE(property->type == uridType);
                REQUIRE(property->size == sizeof(LV2_URID));
                delivered.insert(reinterpret_cast<const LV2_Atom_URID *>(property)->body);
                ++sentGetObjects;
            }
            REQUIRE(delivered == expectedProperties);
        }
        if (auto buffer = effect.GetAtomOutputBuffer())
        {
            auto sequence = reinterpret_cast<const LV2_Atom_Sequence *>(buffer);
            LV2_ATOM_SEQUENCE_FOREACH(sequence, event)
            {
                ++outputEvents;
                if (event->body.type != objectType && event->body.type != blankType) { continue; }
                auto object = reinterpret_cast<const LV2_Atom_Object *>(&event->body);
                if (object->body.otype != setType) { continue; }
                const LV2_Atom *property = nullptr;
                const LV2_Atom *value = nullptr;
                lv2_atom_object_get(object, propertyType, &property, valueType, &value, 0);
                if (property && property->type == uridType && property->size == sizeof(LV2_URID)
                    && value && value->type == floatType && value->size == sizeof(float))
                {
                    REQUIRE(std::isfinite(reinterpret_cast<const LV2_Atom_Float *>(value)->body));
                    auto key = reinterpret_cast<const LV2_Atom_URID *>(property)->body;
                    if (expectedProperties.count(key)) { returnedProperties.insert(key); }
                }
            }
        }
        auto available = ring.readSpace();
        if (available) { REQUIRE(ring.read(available, discarded.data())); }
        for (const auto &channel : outputs)
        {
            for (float sample : channel)
            {
                REQUIRE(std::isfinite(sample));
                if (block >= 750)
                {
                    sumSquares += static_cast<double>(sample) * sample;
                    peak = std::max(peak, std::abs(sample));
                    ++measuredSamples;
                }
            }
        }
        // Give the actual JUCE message/worker threads time to finish initial work.
        std::this_thread::sleep_for(std::chrono::microseconds(1333));
    }
    double rms = std::sqrt(sumSquares / measuredSamples);
    std::cout << "T3K actual-host audio: frames=64 sampleRate=48000 syntheticSeconds=3"
              << " outputRms=" << rms << " outputPeak=" << peak
              << " readableFloatProperties=" << returnedProperties.size()
              << "/" << expectedProperties.size()
              << " sentPatchGetObjects=" << sentGetObjects << " outputEvents=" << outputEvents
              << " preset=" << (presetUri ? presetUri : "default")
              << " (smoke test; not device latency/xrun or audible rig-identity evidence)\n";
    REQUIRE(std::isfinite(rms));
    REQUIRE(rms > 0.000001);
    for (auto property : expectedProperties) { REQUIRE(returnedProperties.count(property) == 1); }
    REQUIRE_FALSE(effect.HasErrorMessage());
}

/** Authoritative reads after individual and property-less Get requests.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.9]
 */
TEST_CASE("TONE3000 actual-host individual and all-property numeric reads", "[.][gig_rig_readback]")
{
    PluginHost host;
    auto info = PrepareHost(host);
    auto properties = NumericProperties(*info);
    auto item = MakeItem(*info);
    NumericPatchProbe probe(host, info, item);
    std::set<LV2_URID> expected;
    for (const auto &property : properties)
    {
        INFO(property.uri());
        auto urid = host.GetLv2Urid(property.uri().c_str());
        expected.insert(urid);
        auto value = probe.Read(urid);
        REQUIRE(value >= property.minValue() - 0.0001f);
        REQUIRE(value <= property.maxValue() + 0.0001f);
    }
    std::map<LV2_URID, float> all;
    for (size_t attempt = 0; attempt < 64 && all.size() < expected.size(); ++attempt)
    {
        probe.Begin();
        probe.GetAll();
        for (const auto &entry : probe.Run()) { all[entry.first] = entry.second; }
    }
    REQUIRE(all.size() == expected.size());
    for (auto property : expected) { REQUIRE(all.count(property) == 1); }
    std::cout << "T3K actual-host authoritative reads: individual=43/43 all-property=" << all.size()
              << "/43 (numeric parameter evidence; not rig/model readiness)\n";
}

/** Use actual plugin replies for every Set, range clamp, toggle and enum point.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.9]
 */
TEST_CASE("TONE3000 actual-host numeric Set Get ranges and choices", "[.][gig_rig_readback]")
{
    PluginHost host;
    auto info = PrepareHost(host);
    auto properties = NumericProperties(*info);
    auto item = MakeItem(*info);
    NumericPatchProbe probe(host, info, item);
    size_t checks = 0, choices = 0;
    for (const auto &property : properties)
    {
        INFO(property.uri());
        auto urid = host.GetLv2Urid(property.uri().c_str());
        auto minimum = property.minValue(), maximum = property.maxValue();
        auto delta = std::max(1.0f, maximum - minimum);
        for (auto pair : {std::pair<float, float>{minimum, minimum}, {maximum, maximum},
                         {minimum - delta, minimum}, {maximum + delta, maximum}})
        {
            INFO("sent=" << pair.first << " expected=" << pair.second);
            RequireNumericValue(probe.SetAndRead(urid, pair.first), pair.second);
            ++checks;
        }
        for (const auto &point : property.scalePoints())
        {
            INFO(point.label());
            RequireNumericValue(probe.SetAndRead(urid, point.value()), point.value());
            ++checks;
            ++choices;
        }
    }
    std::cout << "T3K actual-host Set/Get: parameters=43 range/clamp/choice checks=" << checks
              << " advertised choice points=" << choices << "\n";
}

/** Syntactically bounded invalid objects must not cause numeric responses.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [2.9]
 */
TEST_CASE("TONE3000 actual-host numeric invalid requests and subjects", "[.][gig_rig_readback]")
{
    PluginHost host;
    auto info = PrepareHost(host);
    auto properties = NumericProperties(*info);
    auto item = MakeItem(*info);
    NumericPatchProbe probe(host, info, item);
    auto known = host.GetLv2Urid(properties.front().uri().c_str());
    probe.Read(known);
    for (size_t i = 0; i < 16; ++i) { probe.EmptyBlock(); }
    for (size_t invalid = 0; invalid < 7; ++invalid)
    {
        INFO("invalid case=" << invalid);
        probe.Begin();
        if (invalid < 4)
        {
            probe.Effect().RequestPatchProperty(known);
            auto object = probe.FirstInputObject();
            const LV2_Atom *property = nullptr;
            lv2_atom_object_get(object, probe.Urid(LV2_PATCH__property), &property, 0);
            REQUIRE(property != nullptr);
            auto mutableProperty = const_cast<LV2_Atom *>(property);
            if (invalid == 0) { object->body.otype = probe.Urid("urn:pipedal:gig-rig:unrelated-object"); }
            if (invalid == 1) { reinterpret_cast<LV2_Atom_URID *>(mutableProperty)->body = probe.Urid("urn:pipedal:gig-rig:unknown-parameter"); }
            if (invalid == 2) { mutableProperty->type = probe.Urid(LV2_ATOM__Float); }
            if (invalid == 3) { mutableProperty->size = 0; }
        }
        else
        {
            // Set contains property/value fields, so changing the second key
            // permits subject/duplicate-property tests without resizing the
            // private host forge's sequence frame.
            LV2_Atom_Float placeholder = {{sizeof(float), probe.Urid(LV2_ATOM__Float)}, 0};
            probe.Effect().SetPatchProperty(known, sizeof(placeholder), reinterpret_cast<LV2_Atom *>(&placeholder));
            auto object = probe.FirstInputObject();
            object->body.otype = probe.Urid(LV2_PATCH__Get);
            const LV2_Atom *value = nullptr;
            lv2_atom_object_get(object, probe.Urid(LV2_PATCH__value), &value, 0);
            REQUIRE(value != nullptr);
            auto body = reinterpret_cast<LV2_Atom_Property_Body *>(reinterpret_cast<uint8_t *>(const_cast<LV2_Atom *>(value)) - 2 * sizeof(uint32_t));
            body->key = invalid == 6 ? probe.Urid(LV2_PATCH__property) : probe.Urid(LV2_PATCH__subject);
            auto mutableValue = const_cast<LV2_Atom *>(value);
            if (invalid != 5) { mutableValue->type = probe.Urid(LV2_ATOM__URID); }
            reinterpret_cast<LV2_Atom_URID *>(mutableValue)->body = invalid == 6 ? known : probe.Urid("urn:pipedal:gig-rig:other-plugin");
        }
        REQUIRE(probe.Run().empty());
        REQUIRE(probe.EmptyBlock().empty());
    }
    // Matching subject is accepted and still returns an actual Float value.
    probe.Begin();
    LV2_Atom_URID subject = {{sizeof(LV2_URID), probe.Urid(LV2_ATOM__URID)}, host.GetLv2Urid(info->uri().c_str())};
    probe.Effect().SetPatchProperty(known, sizeof(subject), reinterpret_cast<LV2_Atom *>(&subject));
    auto object = probe.FirstInputObject();
    object->body.otype = probe.Urid(LV2_PATCH__Get);
    const LV2_Atom *value = nullptr;
    lv2_atom_object_get(object, probe.Urid(LV2_PATCH__value), &value, 0);
    REQUIRE(value != nullptr);
    auto body = reinterpret_cast<LV2_Atom_Property_Body *>(reinterpret_cast<uint8_t *>(const_cast<LV2_Atom *>(value)) - 2 * sizeof(uint32_t));
    body->key = probe.Urid(LV2_PATCH__subject);
    REQUIRE(probe.Run().count(known) == 1);
    std::cout << "T3K actual-host invalid Get objects/property/subject cases=7 ignored; matching subject accepted\n";
}

/** Constrain only declared output capacity; guard remaining allocated bytes.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [NFR-5] [DES-UI] [2.9]
 */
TEST_CASE("TONE3000 actual-host numeric output capacity retries", "[.][gig_rig_readback]")
{
    PluginHost host;
    auto info = PrepareHost(host);
    auto properties = NumericProperties(*info);
    auto item = MakeItem(*info);
    NumericPatchProbe probe(host, info, item);
    for (size_t i = 0; i < 16; ++i) { probe.EmptyBlock(); }
    probe.Begin();
    probe.GetAll();
    REQUIRE(probe.Run(32).empty());
    // No new Get: the responses queued in the short block must survive.
    probe.Begin();
    auto partial = probe.Run(88);
    REQUIRE(partial.size() == 1);
    std::map<LV2_URID, float> completed = partial;
    for (size_t i = 0; i < 64 && completed.size() < properties.size(); ++i)
    {
        for (const auto &entry : probe.EmptyBlock()) { completed[entry.first] = entry.second; }
    }
    REQUIRE(completed.size() == 43);
    for (const auto &property : properties) { REQUIRE(completed.count(host.GetLv2Urid(property.uri().c_str())) == 1); }
    std::cout << "T3K actual-host output capacity: 32 bytes=0 replies, 88 bytes=1 reply; retried without new Get=43/43; guards intact\n";
}

/** Save/restore real LV2 state, then read plugin values from a fresh instance.
 * This verifies numeric persistence, not model/IR readiness or offline audio.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] [DES-STATE] [2.9]
 */
TEST_CASE("TONE3000 actual-host numeric saved state restoration", "[.][gig_rig_readback]")
{
    PluginHost host;
    auto info = PrepareHost(host);
    auto properties = NumericProperties(*info);
    Lv2PluginState saved;
    std::map<LV2_URID, float> expected;
    {
        auto item = MakeItem(*info);
        NumericPatchProbe probe(host, info, item);
        for (const auto &property : properties)
        {
            auto urid = host.GetLv2Urid(property.uri().c_str());
            auto value = property.scalePoints().empty() ? property.minValue() + 0.25f * (property.maxValue() - property.minValue()) : property.scalePoints().front().value();
            expected[urid] = probe.SetAndRead(urid, value);
        }
        REQUIRE(probe.Effect().GetLv2State(&saved));
        REQUIRE(saved.isValid_);
        REQUIRE_FALSE(saved.values_.empty());
    }
    auto item = MakeItem(*info);
    item.lv2State(saved);
    NumericPatchProbe restored(host, info, item);
    for (const auto &entry : expected)
    {
        INFO(host.Lv2UridToString(entry.first));
        RequireNumericValue(restored.Read(entry.first), entry.second);
    }
    std::cout << "T3K actual-host numeric LV2 saved-state restore=43/43; model/IR readiness not evaluated\n";
}

namespace
{
    constexpr const char *t3kStateUri = "https://www.tone3000.com/plugin:StateString";
    constexpr const char *t3kProgramUri = "https://www.tone3000.com/plugin:Program";

    /** Private board inputs are never logged or rewritten.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [DES-SEC] [3.6] [4.5]
     */
    PedalboardItem ReadFullStateItem(const char *path, const std::string &uri)
    {
        REQUIRE(path != nullptr);
        REQUIRE(std::filesystem::file_size(path) <= 512ull * 1024 * 1024);
        std::ifstream stream(path);
        REQUIRE(stream.good());
        Pedalboard board;
        try
        {
            json_reader reader(stream);
            reader.read(&board);
            if (!reader.is_complete()) { throw std::runtime_error("Trailing JSON"); }
        }
        catch (...)
        {
            FAIL("Cannot parse private PiPedal board JSON");
        }
        std::vector<PedalboardItem *> matches;
        for (auto item : board.GetAllPlugins())
        {
            if (item->uri() == uri) { matches.push_back(item); }
        }
        REQUIRE(matches.size() == 1);
        auto item = *matches.front();
        REQUIRE(item.isEnabled());
        REQUIRE(item.lilvPresetUri().empty());
        REQUIRE(item.lv2State().isValid_);
        REQUIRE(item.lv2State().values_.count(t3kProgramUri) == 0);
        auto found = item.lv2State().values_.find(t3kStateUri);
        REQUIRE(found != item.lv2State().values_.end());
        REQUIRE(found->second.atomType_ == LV2_ATOM__String);
        REQUIRE(found->second.value_.size() > 8);
        REQUIRE(found->second.value_.back() == 0);
        REQUIRE(std::find(found->second.value_.begin(), found->second.value_.end() - 1, 0)
                == found->second.value_.end() - 1);
        return item;
    }

    struct DspObservation
    {
        std::vector<float> samples;
        double rms = 0;
        double dryDifferenceRms = 0;
        float peak = 0;
        std::string sha256;
    };

    /** Three paced seconds permit background work; they do not certify readiness.
     * Gate, calibration, modulation and chain settings remain the supplied state.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [DES-TEST] [3.6] [4.5]
     */
    DspObservation RenderFullState(NumericPatchProbe &probe)
    {
        constexpr size_t frames = 64;
        auto &effect = probe.Effect();
        std::vector<std::vector<float>> inputs(effect.GetNumberOfInputAudioBuffers(), std::vector<float>(frames));
        std::vector<std::vector<float>> outputs(effect.GetNumberOfOutputAudioBuffers(), std::vector<float>(frames));
        REQUIRE_FALSE(inputs.empty());
        REQUIRE_FALSE(outputs.empty());
        for (size_t i = 0; i < inputs.size(); ++i) { effect.SetAudioInputBuffer(i, inputs[i].data()); }
        for (size_t i = 0; i < outputs.size(); ++i) { effect.SetAudioOutputBuffer(i, outputs[i].data()); }
        DspObservation result;
        result.samples.reserve(48000 * outputs.size());
        double sumSquares = 0, dryDifferenceSquares = 0;
        for (size_t block = 0; block < 3000; ++block)
        {
            for (size_t n = 0; n < frames; ++n)
            {
                const double t = (block * frames + n) / 48000.0;
                const float input = 0.08f * std::sin(2 * 3.141592653589793 * 110 * t)
                                  + 0.02f * std::sin(2 * 3.141592653589793 * 330 * t);
                for (auto &channel : inputs) { channel[n] = input; }
            }
            probe.EmptyBlock();
            for (const auto &channel : outputs)
            {
                for (size_t n = 0; n < frames; ++n)
                {
                    const float sample = channel[n];
                    REQUIRE(std::isfinite(sample));
                    if (block >= 2250)
                    {
                        result.samples.push_back(sample);
                        sumSquares += static_cast<double>(sample) * sample;
                        const double dryDifference = sample - inputs.front()[n];
                        dryDifferenceSquares += dryDifference * dryDifference;
                        result.peak = std::max(result.peak, std::abs(sample));
                    }
                }
            }
        }
        result.rms = std::sqrt(sumSquares / result.samples.size());
        result.dryDifferenceRms = std::sqrt(dryDifferenceSquares / result.samples.size());
        REQUIRE(std::isfinite(result.rms));
        REQUIRE(result.rms > 0.000001);
        // Hash native Float bytes; compare only the same pinned machine/build.
        result.sha256 = AesDigest(std::string(reinterpret_cast<const char *>(result.samples.data()), result.samples.size() * sizeof(float)));
        std::cout << "T3K full-state DSP observation: sampleRate=48000 frames=64 warmupSeconds=3 measuredSeconds=1 channels="
                  << outputs.size() << " outputRms=" << result.rms << " peak=" << result.peak
                  << " dryDifferenceRms=" << result.dryDifferenceRms << " outputFloatSha256=" << result.sha256
                  << " readinessProven=false offlineNetworkIsolationProven=false\n";
        // Disconnect temporary buffers before these local vectors expire.
        // Any subsequent Run must reconnect valid scratch first.
        for (size_t i = 0; i < inputs.size(); ++i) { effect.SetAudioInputBuffer(i, nullptr); }
        for (size_t i = 0; i < outputs.size(); ++i) { effect.SetAudioOutputBuffer(i, nullptr); }
        return result;
    }

    double RelativeDspDifference(const DspObservation &a, const DspObservation &b)
    {
        REQUIRE(a.samples.size() == b.samples.size());
        double difference = 0;
        for (size_t i = 0; i < a.samples.size(); ++i)
        {
            const double delta = a.samples[i] - b.samples[i];
            difference += delta * delta;
        }
        return std::sqrt(difference / a.samples.size()) / std::max(a.rms, b.rms);
    }
}

/** Explicitly opt in with a private board and a fresh empty HOME (before JUCE).
 * Does not prove model installation, intended audible identity, device latency,
 * no-network operation, seamless board recall or dual-instance CPU headroom.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-3] [DES-STATE] [DES-TEST] [3.6] [4.5]
 */
TEST_CASE("TONE3000 actual-host supplied full-state DSP diagnostic", "[.][gig_rig_full_state]")
{
    const char *home = std::getenv("HOME");
    REQUIRE(home != nullptr);
    REQUIRE(std::filesystem::path(home).is_absolute());
    REQUIRE(std::filesystem::is_directory(home));
    REQUIRE(std::filesystem::is_empty(home));
    // XDG paths must not accidentally expose the authoring user's cache/store.
    for (const char *variable : {"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "PIPEDAL_T3K_TEST_STORAGE"})
    {
        const char *value = std::getenv(variable);
        if (value)
        {
            auto relative = std::filesystem::path(value).lexically_normal().lexically_relative(std::filesystem::path(home).lexically_normal());
            REQUIRE_FALSE(relative.empty());
            REQUIRE(*relative.begin() != "..");
        }
    }
    REQUIRE(std::getenv("PIPEDAL_T3K_TEST_STORAGE") != nullptr);
    PluginHost host;
    auto info = PrepareHost(host);
    REQUIRE(info->uri() == "https://www.tone3000.com/plugin");
    auto item = ReadFullStateItem(std::getenv("GIG_RIG_STATE_BOARD"), info->uri());
    const auto &originalBytes = item.lv2State().values_.at(t3kStateUri).value_;
    std::cout << "T3K full-state input: stateStringSha256="
              << AesDigest(std::string(reinterpret_cast<const char *>(originalBytes.data()), originalBytes.size()))
              << " programAbsent=true privateFreshHome=true\n";
    DspObservation baseline, repeated, adjusted;
    const auto outputLevel = host.GetLv2Urid((info->uri() + ":outputLevel").c_str());
    float originalLevel = 0, changedLevel = 0;
    Lv2PluginState saved;
    {
        auto original = item;
        NumericPatchProbe probe(host, info, original);
        originalLevel = probe.Read(outputLevel);
        REQUIRE(originalLevel >= 0);
        REQUIRE(originalLevel <= 1);
        baseline = RenderFullState(probe);
    }
    {
        auto original = item;
        NumericPatchProbe probe(host, info, original);
        RequireNumericValue(probe.Read(outputLevel), originalLevel);
        repeated = RenderFullState(probe);
        // Render disconnects its temporary audio buffers. Reconnect valid
        // scratch before the subsequent patch:Set/Get blocks.
        std::vector<std::vector<float>> inputs(probe.Effect().GetNumberOfInputAudioBuffers(), std::vector<float>(64));
        std::vector<std::vector<float>> outputs(probe.Effect().GetNumberOfOutputAudioBuffers(), std::vector<float>(64));
        for (size_t i = 0; i < inputs.size(); ++i) { probe.Effect().SetAudioInputBuffer(i, inputs[i].data()); }
        for (size_t i = 0; i < outputs.size(); ++i) { probe.Effect().SetAudioOutputBuffer(i, outputs[i].data()); }
        changedLevel = originalLevel >= 0.25f ? originalLevel - 0.25f : originalLevel + 0.25f;
        RequireNumericValue(probe.SetAndRead(outputLevel, changedLevel), changedLevel);
        REQUIRE(probe.Effect().GetLv2State(&saved));
        REQUIRE(saved.isValid_);
        REQUIRE(saved.values_.count(t3kProgramUri) == 0);
        REQUIRE(saved.values_.count(t3kStateUri) == 1);
    }
    {
        auto changed = item;
        changed.lv2State(saved);
        NumericPatchProbe probe(host, info, changed);
        RequireNumericValue(probe.Read(outputLevel), changedLevel);
        adjusted = RenderFullState(probe);
    }
    const double repeatedDifference = RelativeDspDifference(baseline, repeated);
    const double expectedRatio = std::pow(10.0, (changedLevel - originalLevel) * 48.0 / 20.0);
    const double observedRatio = adjusted.rms / repeated.rms;
    std::cout << "T3K full-state DSP comparison: repeatedRelativeDifference=" << repeatedDifference
              << " recalledOutputLevel=" << changedLevel << " expectedRmsRatio=" << expectedRatio
              << " observedRmsRatio=" << observedRatio << " readinessProven=false\n";
    // Intentionally modulated/nonstationary rigs can fail these diagnostics;
    // preserve the supplied settings and report the result instead of relaxing.
    REQUIRE(repeatedDifference <= 0.10);
    REQUIRE(std::abs(observedRatio / expectedRatio - 1.0) <= 0.15);
    if (const char *secondPath = std::getenv("GIG_RIG_STATE_BOARD_B"))
    {
        auto other = ReadFullStateItem(secondPath, info->uri());
        REQUIRE(other.uri() == item.uri());
        REQUIRE(other.lv2State() != item.lv2State());
        NumericPatchProbe probe(host, info, other);
        auto otherDsp = RenderFullState(probe);
        const double stateDifference = RelativeDspDifference(baseline, otherDsp);
        std::cout << "T3K second full-state DSP: relativeDifference=" << stateDifference
                  << " distinctFloatHash=" << (baseline.sha256 != otherDsp.sha256)
                  << " (separate instance; does not exercise service board switching)\n";
        REQUIRE(stateDifference > 0.0001);
    }
}

namespace {
/** Offline real host graph; no audio device, preset store or daemon operations.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [DES-MIX-MATCH] [7.34] [7.37]
 */
class MixMatchGraph {
    PluginHost& host;
    std::unique_ptr<Lv2Pedalboard> graph;
    RingBuffer<false,true> ring{65536,false};
    RealtimeRingBufferWriter writer{&ring};
    HostRingBufferReader reader{&ring};
    float input[2][64]{},output[2][64]{};
    std::map<LV2_URID,float> patchValues;
    uint64_t token=100;
    uint64_t processedBlocks=0;
public:
    struct Observation {
        std::vector<float> samples;
        double rms=0,tailRms=0,meanRunUs=0,maxRunUs=0;
        float peak=0;
        std::string hash;
    };
    MixMatchGraph(PluginHost& host,Pedalboard board):host(host){
        Lv2PedalboardErrorList errors;
        graph.reset(host.CreateLv2Pedalboard(board,errors));
        for(const auto& error:errors)std::cout<<"Mix-match graph construction error: "<<error.message<<'\n';
        REQUIRE(errors.empty());REQUIRE(graph);
        REQUIRE(graph->GetNumberOfAudioInputChannels()==2);REQUIRE(graph->GetNumberOfAudioOutputChannels()==2);
        graph->Activate();
    }
    ~MixMatchGraph(){if(graph)graph->Deactivate();}
    double Run(Lv2Effect* patchEffect=nullptr,LV2_URID requestedProperty=0,const Pedalboard* restorePitch=nullptr){
        float* in[]{input[0],input[1]};float* out[]{output[0],output[1]};
        graph->ResetAtomBuffers();
        if(patchEffect)patchEffect->RequestPatchProperty(requestedProperty);
        if(restorePitch)for(const auto& item:restorePitch->items()){
            if(item.uri()==Tone3000Preset::PLUGIN_URI){
                auto* effect=dynamic_cast<Lv2Effect*>(graph->GetEffect(item.instanceId()));REQUIRE(effect);
                LV2_Atom_Float atom={{sizeof(float),host.GetLv2Urid(LV2_ATOM__Float)},static_cast<float>(Tone3000Preset::ParameterValue(item.lv2State(),"pitchEnabled"))};
                effect->SetPatchProperty(host.GetLv2Urid("https://www.tone3000.com/plugin:pitchEnabled"),sizeof(atom),reinterpret_cast<LV2_Atom*>(&atom));
            }else if(item.uri()==Tone3000MixMatch::PITCH_URI){
                const auto* enabled=item.GetControlValue("enabled");REQUIRE(enabled);
                const int index=graph->GetControlIndex(item.instanceId(),"enabled");REQUIRE(index>=0);
                const int effect=graph->GetIndexOfInstanceId(item.instanceId());REQUIRE(effect>=0);
                graph->SetControlValue(effect,index,enabled->value());
            }
        }
        const auto started=std::chrono::steady_clock::now();
        const bool processed=graph->Run(in,out,64,&writer);
        ++processedBlocks;
        const auto elapsed=std::chrono::duration<double,std::micro>(std::chrono::steady_clock::now()-started).count();
        REQUIRE(processed);
        if(patchEffect){
            const auto* sequence=reinterpret_cast<const LV2_Atom_Sequence*>(patchEffect->GetAtomOutputBuffer());REQUIRE(sequence);
            REQUIRE(sequence->atom.type==host.GetLv2Urid(LV2_ATOM__Sequence));REQUIRE(sequence->atom.size>=sizeof(LV2_Atom_Sequence_Body));
            REQUIRE(sequence->atom.size+sizeof(LV2_Atom)<=host.asIHost()->GetAtomBufferSize());
            LV2_ATOM_SEQUENCE_FOREACH(sequence,event){
                if(event->body.type!=host.GetLv2Urid(LV2_ATOM__Object)&&event->body.type!=host.GetLv2Urid(LV2_ATOM__Blank))continue;
                REQUIRE(event->body.size>=sizeof(LV2_Atom_Object_Body));
                const auto* object=reinterpret_cast<const LV2_Atom_Object*>(&event->body);
                if(object->body.otype!=host.GetLv2Urid(LV2_PATCH__Set))continue;
                const LV2_Atom *property=nullptr,*value=nullptr;lv2_atom_object_get(object,host.GetLv2Urid(LV2_PATCH__property),&property,host.GetLv2Urid(LV2_PATCH__value),&value,0);
                REQUIRE(property);REQUIRE(value);REQUIRE(property->type==host.GetLv2Urid(LV2_ATOM__URID));REQUIRE(property->size==sizeof(LV2_URID));
                REQUIRE(value->type==host.GetLv2Urid(LV2_ATOM__Float));REQUIRE(value->size==sizeof(float));
                patchValues[reinterpret_cast<const LV2_Atom_URID*>(property)->body]=reinterpret_cast<const LV2_Atom_Float*>(value)->body;
            }
        }
        while(reader.readSpace()){
            RingBufferCommand command;reader.read(&command);uint64_t id;reader.read(&id);
            if(command==RingBufferCommand::Lv2StateChanged||command==RingBufferCommand::MaybeLv2StateChanged)continue;
            if(command==RingBufferCommand::AtomOutput){LV2_Atom atom;reader.read(&atom);REQUIRE(atom.size<=65536);std::vector<uint8_t> body(atom.size);reader.read(body.size(),body.data());continue;}
            if(command==RingBufferCommand::Lv2ErrorMessage){std::string error;char c;do{reader.read(&c);if(c)error+=c;REQUIRE(error.size()<16384);}while(c);FAIL("Actual graph plugin/worker error: "+error);}
            FAIL("Unexpected actual graph ring-buffer message");
        }
        bool finite=true;for(auto& channel:output)for(float x:channel)finite=finite&&std::isfinite(x);REQUIRE(finite);
        return elapsed;
    }
    json_variant Runtime(Lv2Effect& effect,const std::chrono::steady_clock::time_point& until){
        const auto request=++token;REQUIRE(effect.SubmitTone3000Stage(request,TONE3000_STAGE_RUNTIME,{})==0);
        while(std::chrono::steady_clock::now()<until){
            Run();std::string raw;const auto size=effect.ReadTone3000Stage(request,raw);REQUIRE(size>=0);
            if(size){auto response=Tone3000Stage::Result(raw);if(Tone3000Stage::Terminal(response)){REQUIRE(response["state"].as_string()=="done");REQUIRE(response["runtime"].is_object());return response["runtime"];}}
            std::this_thread::sleep_for(std::chrono::microseconds(1333));
        }
        FAIL("Headless runtime bridge did not respond before the load deadline");return {};
    }
    void WaitLoaded(Pedalboard& board){
        const auto until=std::chrono::steady_clock::now()+std::chrono::seconds(30);
        for(auto* item:board.GetAllPlugins())if(item->uri()==Tone3000Preset::PLUGIN_URI){
            auto* effect=dynamic_cast<Lv2Effect*>(graph->GetEffect(item->instanceId()));REQUIRE(effect);
            const auto expected=Tone3000Preset::SummarizeState(item->lv2State());
            std::set<std::string> wanted;for(const auto& block:expected.blocks_)if(block.type_!="insert"&&block.enabled_)wanted.insert(block.blockId_);
            REQUIRE_FALSE(wanted.empty());bool loaded=false;
            while(std::chrono::steady_clock::now()<until){
                auto runtime=Runtime(*effect,until);REQUIRE(runtime["audioActive"].as_bool());REQUIRE_FALSE(runtime["truncated"].as_bool());
                REQUIRE(runtime["blocks"].is_array());std::set<std::string> actual;bool ready=true;
                for(const auto& block:*runtime["blocks"].as_array())if(block["enabled"].as_bool()){
                    actual.insert(block["blockId"].as_string());
                    const auto& fields=*block.as_object();
                    ready=ready&&fields.contains("loaded")&&block["loaded"].as_bool()
                        &&(!fields.contains("modelLoading")||!block["modelLoading"].as_bool());
                    if(fields.contains("loadFailed"))REQUIRE_FALSE(block["loadFailed"].as_bool());
                }
                if(ready&&actual==wanted){loaded=true;break;}
                for(int i=0;i<75;++i){Run();std::this_thread::sleep_for(std::chrono::microseconds(1333));}
            }
            REQUIRE(loaded);
        }
    }
    void VerifyParameters(Pedalboard& board){
        const auto properties=NumericProperties(*host.GetPluginInfo(Tone3000Preset::PLUGIN_URI));
        const std::string prefix=std::string(Tone3000Preset::PLUGIN_URI)+":";
        for(auto* item:board.GetAllPlugins()){
            auto* effect=dynamic_cast<Lv2Effect*>(graph->GetEffect(item->instanceId()));
            if(item->uri()==Tone3000Preset::PLUGIN_URI){
                REQUIRE(effect);Lv2PluginState actual;REQUIRE(effect->GetLv2State(&actual));REQUIRE(actual.isValid_);
                for(const auto& property:properties){
                    REQUIRE(property.uri().starts_with(prefix));const auto id=property.uri().substr(prefix.size());
                    const auto wanted=Tone3000Preset::ParameterValue(item->lv2State(),id);
                    const auto observed=Tone3000Preset::ParameterValue(actual,id);
                    INFO("Actual full-state parameter instance="<<item->instanceId()<<" id="<<id<<" expected="<<wanted<<" actual="<<observed);
                    REQUIRE(std::isfinite(observed));REQUIRE(std::abs(observed-wanted)<=std::max(1e-6,std::abs(wanted)*1e-6));
                    const auto urid=host.GetLv2Urid(property.uri().c_str());patchValues.clear();
                    for(int attempt=0;attempt<64&&!patchValues.contains(urid);++attempt){Run(effect,urid);std::this_thread::sleep_for(std::chrono::microseconds(1333));}
                    REQUIRE(patchValues.contains(urid));const auto live=patchValues.at(urid);
                    INFO("Actual Patch Get value="<<live);REQUIRE(std::isfinite(live));REQUIRE(std::abs(live-wanted)<=std::max(1e-6,std::abs(wanted)*1e-6));
                }
                REQUIRE(Tone3000Preset::SummarizeState(actual).inputMode_==Tone3000Preset::SummarizeState(item->lv2State()).inputMode_);
                std::cout<<"Mix-match actual full-state capture: instance="<<item->instanceId()<<" matchedCapturedParameters=43/43 matchedLivePatchGets=43/43\n";
            }else if(item->uri()==Tone3000MixMatch::PITCH_URI){
                REQUIRE(effect);REQUIRE(item->controlValues().size()==6);
                for(const auto& control:item->controlValues()){const int index=effect->GetControlIndex(control.key());REQUIRE(index>=0);REQUIRE(effect->GetControlValue(index)==control.value());}
            }
        }
    }
    Observation Render(bool antiphase){
        Observation result;double sum=0,tail=0,runTotal=0;size_t tailCount=0;
        // One second of deterministic excitation, then two seconds of silence;
        // warmup is separate and no fixed sleep is accepted as model readiness.
        for(size_t block=0;block<2250;++block){
            for(size_t n=0;n<64;++n){const double t=(block*64+n)/48000.;const float signal=block<750?.12f*std::sin(2*3.141592653589793*110*t)+.04f*std::sin(2*3.141592653589793*317*t):0;
                input[0][n]=signal;input[1][n]=antiphase?-signal:.35f*signal;}
            auto elapsed=Run();runTotal+=elapsed;result.maxRunUs=std::max(result.maxRunUs,elapsed);
            for(auto& channel:output)for(float sample:channel){result.samples.push_back(sample);sum+=double(sample)*sample;result.peak=std::max(result.peak,std::abs(sample));if(block>=1500){tail+=double(sample)*sample;++tailCount;}}
            // Feed native asynchronous workers at the actual 64/48k cadence.
            std::this_thread::sleep_for(std::chrono::microseconds(1333));
        }
        result.rms=std::sqrt(sum/result.samples.size());result.tailRms=std::sqrt(tail/tailCount);result.meanRunUs=runTotal/2250;
        REQUIRE(std::isfinite(result.rms));REQUIRE(result.rms>1e-6);REQUIRE(std::isfinite(result.tailRms));
        result.hash=AesDigest(std::string(reinterpret_cast<const char*>(result.samples.data()),result.samples.size()*sizeof(float)));
        return result;
    }
    void Warm(){for(int i=0;i<750;++i){Run();std::this_thread::sleep_for(std::chrono::microseconds(1333));}}
    uint64_t Blocks()const{return processedBlocks;}
    void StartPitchTimeline(const Pedalboard& requested){Run(nullptr,0,&requested);}
};
// Readiness and Patch Gets consume a variable number of silent audio blocks.
// JUCE LV2 activate/deactivate only invalidate the playhead; they do not reset
// DSP. Keep pitch initially disabled (native engine is not running), then enable
// the requested setting on one known block after all pre-render observations.
// The native fresh-enable path resets its rings/taps; subsequent warmup and DI
// advance an identical sample timeline. Final readback still checks the exact
// requested 43 parameters, without changing the repeat-control tolerance.
// @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-MIX-MATCH] [7.37]
Pedalboard MixMatchPitchOffStart(Pedalboard& requested){
    auto initial=requested.DeepCopy();
    for(auto* item:initial.GetAllPlugins()){
        if(item->uri()==Tone3000Preset::PLUGIN_URI)item->lv2State(Tone3000Preset::WithPitchDisabled(item->lv2State()));
        else if(item->uri()==Tone3000MixMatch::PITCH_URI){auto* enabled=item->GetControlValue("enabled");REQUIRE(enabled);enabled->value(0);}
    }
    return initial;
}
double MixMatchResidual(const MixMatchGraph::Observation& a,const MixMatchGraph::Observation& b){
    REQUIRE(a.samples.size()==b.samples.size());double sum=0;for(size_t i=0;i<a.samples.size();++i){auto d=double(a.samples[i])-b.samples[i];sum+=d*d;}
    return std::sqrt(sum/a.samples.size());
}
struct MixMatchAlignment{int lag=0;double correlation=0,residual=0;bool atBoundary=false;};
// Observations append each 64-frame L block followed by its R block. Search in
// frame units, not vector-index units, and never rescale either waveform.
MixMatchAlignment AlignMixMatch(const MixMatchGraph::Observation& a,const MixMatchGraph::Observation& b,int limit=2048){
    REQUIRE(a.samples.size()==b.samples.size());REQUIRE(a.samples.size()%128==0);REQUIRE(limit>=0);REQUIRE(limit<=2048);
    const int frames=static_cast<int>(a.samples.size()/2);REQUIRE(frames>limit);const int window=std::min(frames,48000+limit);
    auto sample=[](const auto& observation,int frame,int channel){return observation.samples[(frame/64)*128+channel*64+frame%64];};
    auto correlation=[&](int lag,int stride){double dot=0,left=0,right=0;const int begin=std::max(0,-lag),end=std::min(window,frames-lag);
        for(int frame=begin;frame<end;frame+=stride)for(int channel=0;channel<2;++channel){const double x=sample(a,frame,channel),y=sample(b,frame+lag,channel);dot+=x*y;left+=x*x;right+=y*y;}
        return left>0&&right>0?dot/std::sqrt(left*right):-1.;};
    MixMatchAlignment result;result.correlation=-2;
    // Exhaust every permitted integer lag at 1/8 sampling, then evaluate the
    // nearby peak at full sampling. This bounds offline work on the Pi.
    for(int lag=-limit;lag<=limit;++lag){const auto score=correlation(lag,8);if(score>result.correlation){result.correlation=score;result.lag=lag;}}
    const int coarse=result.lag;result.correlation=-2;
    for(int lag=std::max(-limit,coarse-4);lag<=std::min(limit,coarse+4);++lag){const auto score=correlation(lag,1);if(score>result.correlation){result.correlation=score;result.lag=lag;}}
    double sum=0;size_t count=0;for(int frame=std::max(0,-result.lag);frame<std::min(frames,frames-result.lag);++frame)for(int channel=0;channel<2;++channel){const double d=double(sample(a,frame,channel))-sample(b,frame+result.lag,channel);sum+=d*d;++count;}
    REQUIRE(count>0);result.residual=std::sqrt(sum/count);result.atBoundary=std::abs(result.lag)==limit;
    return result;
}
}

/** Pure measurement check: lag is in audio frames; level differences stay real.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-MIX-MATCH] [7.37]
 */
TEST_CASE("Mix-match lag diagnostic preserves level differences", "[gig_rig][gig_rig_mixmatch_alignment][Build]"){
    MixMatchGraph::Observation a,b;constexpr int frames=4096;a.samples.resize(frames*2);b.samples.resize(frames*2);
    auto index=[](int frame,int channel){return (frame/64)*128+channel*64+frame%64;};uint32_t random=1;
    for(int frame=0;frame<frames;++frame)for(int channel=0;channel<2;++channel){random=random*1664525u+1013904223u;a.samples[index(frame,channel)]=(int32_t(random)/2147483648.f)*.1f;}
    for(int frame=7;frame<frames;++frame)for(int channel=0;channel<2;++channel)b.samples[index(frame,channel)]=a.samples[index(frame-7,channel)];
    auto aligned=AlignMixMatch(a,b,32);REQUIRE(aligned.lag==7);REQUIRE(aligned.correlation==Approx(1));REQUIRE(aligned.residual==0);REQUIRE_FALSE(aligned.atBoundary);
    for(auto& sample:b.samples)sample*=.5f;aligned=AlignMixMatch(a,b,32);REQUIRE(aligned.lag==7);REQUIRE(aligned.correlation==Approx(1));REQUIRE(aligned.residual>.02);
    auto negative=AlignMixMatch(b,a,32);REQUIRE(negative.lag==-7);REQUIRE(negative.residual>.02);
}

/** Requires an explicit disposable saved source, installed candidate bundles and
 * a fresh HOME. Reports DSP differences and wall timings; never claims listening,
 * sample equivalence, device latency, live CPU headroom or complete qualification.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [DES-MIX-MATCH] [7.34] [7.37]
 */
TEST_CASE("TONE3000 actual-host mixed Amp Cab Pitch graphs", "[.][gig_rig_mixmatch_runtime]"){
    namespace fs=std::filesystem;
    const char* home=getenv("HOME");REQUIRE(home);REQUIRE(fs::path(home).is_absolute());REQUIRE(fs::is_directory(home));REQUIRE(fs::is_empty(home));
    REQUIRE(getenv("PIPEDAL_T3K_TEST_STORAGE"));
    for(const char* key:{"XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_CACHE_HOME","PIPEDAL_T3K_TEST_STORAGE"})if(const char* value=getenv(key)){
        auto relative=fs::path(value).lexically_normal().lexically_relative(fs::path(home).lexically_normal());REQUIRE_FALSE(relative.empty());REQUIRE(*relative.begin()!="..");}
    const char* sourcePath=getenv("PIPEDAL_TONE3000_MIXMATCH_TEST_BOARD");REQUIRE(sourcePath);REQUIRE_FALSE(fs::is_symlink(fs::symlink_status(sourcePath)));REQUIRE(fs::file_size(sourcePath)<=256ull*1024*1024);
    std::ifstream stream(sourcePath);REQUIRE(stream.good());json_reader input(stream);Pedalboard source;input.read(&source);REQUIRE(input.is_complete());
    Tone3000MixMatchRequest request;request.bankId_=1;request.presetId_=1;request.expectedRevision_=Tone3000Performance::Revision(source);request.name_="Offline mix-match DSP diagnostic";request.creationId_="12345678-1234-4234-8234-123456789abc";request.confirmAmpHead_=true;
    size_t tones=0;for(const auto& item:source.items())if(item.uri()==Tone3000Preset::PLUGIN_URI){++tones;request.instanceId_=item.instanceId();
        for(const auto& block:Tone3000Preset::SummarizeState(item.lv2State()).blocks_){if(block.type_=="nam")request.ampBlockId_=block.blockId_;if(block.type_=="ir")request.cabBlockId_=block.blockId_;}}
    REQUIRE(tones==1);auto prepared=Tone3000MixMatch::Prepare(source,request,true);
    PluginHost host;ChannelSelection channels;channels.mainInputChannels()={0,1};channels.mainOutputChannels()={0,1};JackConfiguration config;host.OnConfigurationChanged(config,channels);PrepareHost(host);
    REQUIRE(host.GetPluginInfo(Tone3000MixMatch::PITCH_URI));
    auto delayInfo=host.GetPluginInfo("http://two-play.com/plugins/toob-delay");REQUIRE(delayInfo);
    auto delayed=prepared.board.DeepCopy();auto delay=delayed.MakeEmptyItem();delay.uri(delayInfo->uri());delay.pluginName(delayInfo->name());
    for(const auto& port:delayInfo->ports())if(port->is_input()&&port->is_control_port())delay.controlValues().emplace_back(port->symbol(),port->default_value());
    for(const auto& [symbol,value]:std::vector<std::pair<const char*,float>>{{"delay",110},{"level",60},{"feedback",65}}){auto* control=delay.GetControlValue(symbol);REQUIRE(control);control->value(value);}
    auto cab=std::find_if(delayed.items().begin(),delayed.items().end(),[&](const auto& item){return item.instanceId()==prepared.cabInstanceId;});REQUIRE(cab!=delayed.items().end());delayed.items().insert(cab,delay);
    const auto sourceRevision=Tone3000Performance::Revision(source);
    auto pitchOffSource=source.DeepCopy();auto* pitchOffItem=pitchOffSource.GetItem(request.instanceId_);REQUIRE(pitchOffItem);
    pitchOffItem->lv2State(Tone3000Preset::WithPitchDisabled(pitchOffItem->lv2State()));
    auto pitchOffRequest=request;pitchOffRequest.expectedRevision_=Tone3000Performance::Revision(pitchOffSource);
    auto pitchOffPrepared=Tone3000MixMatch::Prepare(pitchOffSource,pitchOffRequest,true);
    for(bool antiphase:{false,true}){
        auto render=[&](Pedalboard board){
            auto initial=MixMatchPitchOffStart(board);MixMatchGraph graph(host,initial);
            graph.WaitLoaded(initial);graph.VerifyParameters(initial);
            graph.StartPitchTimeline(board);const auto start=graph.Blocks();
            graph.Warm();REQUIRE(graph.Blocks()-start==750);
            auto observation=graph.Render(antiphase);REQUIRE(graph.Blocks()-start==3000);
            std::cout<<"Mix-match controlled pitch timeline: pitchOffLoadVerified=true warmupBlocks=750 renderBlocks=2250 blockFrames=64 preRenderReadbacksAfterEnable=0\n";
            graph.VerifyParameters(board);return observation;
        };
        const auto original=render(source),repeat=render(source);
        const auto repeatedResidual=MixMatchResidual(original,repeat);
        std::cout<<"Mix-match repeat-control gate: antiphase="<<antiphase<<" relativeResidual="<<repeatedResidual/std::max(original.rms,repeat.rms)
            <<" requiredBelow=0.0001 originalFloatSha256="<<original.hash<<" repeatFloatSha256="<<repeat.hash<<std::endl;
        // A deterministic baseline must repeat before assessing derived residuals.
        REQUIRE(repeatedResidual/std::max(original.rms,repeat.rms)<.0001);
        const auto split=render(prepared.board),withDelay=render(delayed);
        const auto pitchOffOriginal=render(pitchOffSource),pitchOffSplit=render(pitchOffPrepared.board);
        const auto partitionResidual=MixMatchResidual(original,split),delayResidual=MixMatchResidual(split,withDelay);
        const auto aligned=AlignMixMatch(original,split),pitchOffAligned=AlignMixMatch(pitchOffOriginal,pitchOffSplit);
        REQUIRE(delayResidual>1e-6);REQUIRE(std::abs(withDelay.tailRms-split.tailRms)>1e-8);
        std::cout<<"Mix-match actual graph DI: antiphase="<<antiphase<<" originalRms="<<original.rms<<" splitRms="<<split.rms<<" delayRms="<<withDelay.rms<<" originalPeak="<<original.peak<<" delayPeak="<<withDelay.peak<<" originalRunMeanUs="<<original.meanRunUs<<" originalRunMaxUs="<<original.maxRunUs<<" repeatedResidual="<<repeatedResidual<<" partitionResidual="<<partitionResidual<<" delayResidual="<<delayResidual<<" splitTailRms="<<split.tailRms<<" delayTailRms="<<withDelay.tailRms
            <<" splitPeak="<<split.peak<<" splitRunMeanUs="<<split.meanRunUs<<" splitRunMaxUs="<<split.maxRunUs<<" delayRunMeanUs="<<withDelay.meanRunUs<<" delayRunMaxUs="<<withDelay.maxRunUs<<" splitFloatSha256="<<split.hash<<" qualified=false audibleComparison=false deviceLatencyMeasured=false networkIsolationProven=false\n";
        std::cout<<"Mix-match alignment observation: antiphase="<<antiphase<<" searchLimitFrames=2048 lagFrames="<<aligned.lag<<" correlation="<<aligned.correlation<<" alignedResidual="<<aligned.residual<<" alignedRelativeResidual="<<aligned.residual/original.rms<<" boundary="<<aligned.atBoundary
            <<" pitchOffOriginalRms="<<pitchOffOriginal.rms<<" pitchOffSplitRms="<<pitchOffSplit.rms<<" pitchOffRawResidual="<<MixMatchResidual(pitchOffOriginal,pitchOffSplit)<<" pitchOffLagFrames="<<pitchOffAligned.lag<<" pitchOffCorrelation="<<pitchOffAligned.correlation<<" pitchOffAlignedResidual="<<pitchOffAligned.residual<<" pitchOffAlignedRelativeResidual="<<pitchOffAligned.residual/pitchOffOriginal.rms<<" pitchOffBoundary="<<pitchOffAligned.atBoundary<<" levelNormalization=false sampleEquivalenceProven=false\n";
    }
    REQUIRE(Tone3000Performance::Revision(source)==sourceRevision);
}

namespace {
/** Actual mono graph for ordinary LV2 controls. No T3K bridge, device or store.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [7.35] [7.37]
 */
class PitchHostGraph {
    std::unique_ptr<Lv2Pedalboard> graph;
    RingBuffer<false,true> ring{65536,false};
    RealtimeRingBufferWriter writer{&ring};
    float input[64]{},output[64]{};
    size_t rendered=0;
public:
    PitchHostGraph(PluginHost& host,Pedalboard board){
        Lv2PedalboardErrorList errors;graph.reset(host.CreateLv2Pedalboard(board,errors));
        for(const auto& error:errors)std::cout<<"Pitch graph construction error: "<<error.message<<'\n';
        REQUIRE(errors.empty());REQUIRE(graph);REQUIRE(graph->GetNumberOfAudioInputChannels()==1);REQUIRE(graph->GetNumberOfAudioOutputChannels()==1);graph->Activate();
    }
    ~PitchHostGraph(){if(graph)graph->Deactivate();}
    Lv2Pedalboard& Board(){return *graph;}
    Lv2Effect& Effect(int64_t id){auto* effect=dynamic_cast<Lv2Effect*>(graph->GetEffect(id));REQUIRE(effect);return *effect;}
    float Get(int64_t id,const std::string& symbol){auto& effect=Effect(id);const int index=effect.GetControlIndex(symbol);REQUIRE(index>=0);return effect.GetControlValue(index);}
    void Set(int64_t id,const std::string& symbol,float value){const int index=graph->GetControlIndex(id,symbol);REQUIRE(index>=0);const int effect=graph->GetIndexOfInstanceId(id);REQUIRE(effect>=0);graph->SetControlValue(effect,index,value);}
    float Latency(int64_t id,int latencyPort){const int effect=graph->GetIndexOfInstanceId(id);REQUIRE(effect>=0);return graph->GetControlOutputValue(effect,latencyPort);}
    double Render(size_t blocks){
        double energy=0;
        for(size_t block=0;block<blocks;++block){
            for(size_t n=0;n<64;++n){const double t=(rendered+n)/48000.;input[n]=.1f*std::sin(2*3.141592653589793*140*t)+.02f*std::sin(2*3.141592653589793*433*t);}
            float* inputs[]{input};float* outputs[]{output};graph->ResetAtomBuffers();REQUIRE(graph->Run(inputs,outputs,64,&writer));
            bool finite=true;for(float sample:output){finite=finite&&std::isfinite(sample);energy+=double(sample)*sample;}REQUIRE(finite);
            // This plugin has no atom/worker ports. Any message indicates an
            // unexpected graph notification or plugin error, not success.
            REQUIRE(ring.readSpace()==0);rendered+=64;
        }
        const double rms=std::sqrt(energy/(blocks*64));REQUIRE(std::isfinite(rms));REQUIRE(rms>1e-6);return rms;
    }
    void Verify(const Pedalboard& board){
        for(const auto& item:board.items()){REQUIRE(item.controlValues().size()==6);for(const auto& control:item.controlValues())REQUIRE(Get(item.instanceId(),control.key())==control.value());}
    }
    void Capture(Pedalboard& board){
        for(auto& item:board.items())for(auto& control:item.controlValues())control.value(Get(item.instanceId(),control.key()));
    }
};
struct PitchMidiObservation{int calls=0;uint64_t instance=0;int port=-1;float value=0;};
void PitchMidiCallback(void* pointer,uint64_t instance,int port,float value){auto& result=*static_cast<PitchMidiObservation*>(pointer);++result.calls;result.instance=instance;result.port=port;result.value=value;}
}

/** Synthetic host MIDI and JSON/snapshot recall, never owner preset/device access.
 * Latency assertions cover reported plugin ports, not measured interface latency.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [7.35] [7.37]
 */
TEST_CASE("T3K Pitch actual host MIDI controls saved board and stacked instances", "[.][gig_rig_pitch_host]"){
    namespace fs=std::filesystem;
    const char* optIn=getenv("PIPEDAL_T3K_PITCH_HOST_TEST");REQUIRE(optIn);REQUIRE(std::string(optIn)=="1");
    const char* home=getenv("HOME");REQUIRE(home);REQUIRE(fs::path(home).is_absolute());REQUIRE(fs::is_directory(home));REQUIRE(fs::is_empty(home));
    const char* display=getenv("DISPLAY");REQUIRE((!display||!*display));const char* storage=getenv("PIPEDAL_T3K_TEST_STORAGE");REQUIRE(storage);
    for(const char* key:{"XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_CACHE_HOME","PIPEDAL_T3K_TEST_STORAGE"})if(const char* value=getenv(key)){
        auto relative=fs::path(value).lexically_normal().lexically_relative(fs::path(home).lexically_normal());REQUIRE_FALSE(relative.empty());REQUIRE(*relative.begin()!="..");}
    const char* path=getenv("LV2_PATH");REQUIRE(path);REQUIRE(*path);const std::string lv2Path(path);
    PluginHost host;ChannelSelection channels;channels.mainInputChannels()={0};channels.mainOutputChannels()={0};JackConfiguration config;host.OnConfigurationChanged(config,channels);
    fs::create_directories(storage);host.SetPluginStoragePath(storage);host.setSampleRate(48000);host.asIHost()->SetMaxAudioBufferSize(64);host.LoadLilv(lv2Path.c_str());
    auto info=host.GetPluginInfo("https://github.com/rixrix/pipedal/plugins/t3k-pitch#mono");REQUIRE(info);
    const auto& latency=info->getPort("latency");REQUIRE(latency.is_output());REQUIRE(latency.is_control_port());
    const int latencyPort=latency.index(),semitonesPort=info->getPort("semitones").index();
    Pedalboard board;board.name("Private Pitch host diagnostic");
    for(int i=0;i<2;++i){auto item=board.MakeEmptyItem();item.uri(info->uri());item.pluginName(info->name());
        for(const auto& port:info->ports())if(port->is_input()&&port->is_control_port())item.controlValues().emplace_back(port->symbol(),port->default_value());
        REQUIRE(item.controlValues().size()==6);item.GetControlValue("enabled")->value(i?1:0);item.GetControlValue("step")->value(0);item.GetControlValue("semitones")->value(i?7.25f:-2.5f);item.GetControlValue("window")->value(i?2:1);item.GetControlValue("tonality")->value(i?12345:20000);
        board.items().push_back(std::move(item));}
    const auto first=board.items()[0].instanceId(),second=board.items()[1].instanceId();
    MidiBinding binding;binding.symbol("semitones");binding.bindingType(BINDING_TYPE_CONTROL);binding.channel(1);binding.control(11);binding.minValue(.25f);binding.maxValue(.75f);board.items()[0].midiBindings().push_back(binding);
    {
        PitchHostGraph graph(host,board);graph.Verify(board);const auto rms=graph.Render(100);REQUIRE(graph.Latency(first,latencyPort)==0);REQUIRE(graph.Latency(second,latencyPort)==1008);
        graph.Set(first,"enabled",1);graph.Render(100);REQUIRE(graph.Latency(first,latencyPort)==768);REQUIRE(graph.Latency(second,latencyPort)==1008);
        graph.Set(first,"tonality",15000);REQUIRE(graph.Get(second,"tonality")==12345);graph.Set(first,"tonality",20000);
        PitchMidiObservation callback;uint8_t bytes[]{0xb2,11,127};MidiEvent midi{};midi.size=3;midi.buffer=bytes;
        graph.Board().OnMidiMessage(midi,&callback,PitchMidiCallback);REQUIRE(callback.calls==0);REQUIRE(graph.Get(first,"semitones")==-2.5f);
        bytes[0]=0xb1;bytes[2]=0;graph.Board().OnMidiMessage(midi,&callback,PitchMidiCallback);REQUIRE(callback.calls==1);REQUIRE(callback.instance==first);REQUIRE(callback.port==semitonesPort);REQUIRE(callback.value==Approx(-12));REQUIRE(graph.Get(first,"semitones")==Approx(-12));REQUIRE(graph.Get(second,"semitones")==7.25f);
        bytes[2]=127;graph.Board().OnMidiMessage(midi,&callback,PitchMidiCallback);REQUIRE(callback.calls==2);REQUIRE(callback.value==Approx(12));REQUIRE(graph.Get(first,"semitones")==Approx(12));REQUIRE(graph.Get(second,"semitones")==7.25f);
        bytes[1]=12;graph.Board().OnMidiMessage(midi,&callback,PitchMidiCallback);REQUIRE(callback.calls==2);
        graph.Render(100);graph.Capture(board);
        std::cout<<"Pitch actual mono host: inputs=1 outputs=1 instances=2 sampleRate=48000 reportedLatencyFirstOff=0 firstOn=768 secondOn=1008 sumReportedOn=1776 midiTargeted=true outputRms="<<rms<<" hardwareMidiTested=false interfaceLatencyMeasured=false\n";
    }
    auto snapshot=std::make_shared<Snapshot>(board.MakeSnapshotFromCurrentSettings(board));snapshot->name_="Captured Pitch controls";board.snapshots().push_back(snapshot);
    std::ostringstream saved;json_writer writer(saved);writer.write(board);std::istringstream file(saved.str());json_reader reader(file);Pedalboard restored;reader.read(&restored);REQUIRE(reader.is_complete());
    REQUIRE(restored.items()[0].midiBindings()==board.items()[0].midiBindings());REQUIRE(restored.items()[1].midiBindings().empty());REQUIRE(restored.snapshots().size()==1);REQUIRE(restored.snapshots()[0]->values_.size()==2);
    {
        PitchHostGraph graph(host,restored);graph.Verify(board);graph.Render(100);REQUIRE(graph.Latency(first,latencyPort)==768);REQUIRE(graph.Latency(second,latencyPort)==1008);
        PitchMidiObservation callback;uint8_t bytes[]{0xb1,11,0};MidiEvent midi{};midi.size=3;midi.buffer=bytes;graph.Board().OnMidiMessage(midi,&callback,PitchMidiCallback);REQUIRE(callback.calls==1);REQUIRE(callback.instance==first);REQUIRE(graph.Get(first,"semitones")==Approx(-12));REQUIRE(graph.Get(second,"semitones")==7.25f);
    }
    restored.items()[0].GetControlValue("semitones")->value(-7);restored.items()[1].GetControlValue("window")->value(0);
    REQUIRE(restored.ApplySnapshot(0,host));
    {
        PitchHostGraph graph(host,restored);graph.Verify(board);graph.Render(100);REQUIRE(graph.Latency(first,latencyPort)==768);REQUIRE(graph.Latency(second,latencyPort)==1008);
    }
    std::cout<<"Pitch actual host recall: savedJsonControls=12/12 midiBindingRetained=true nativePedalboardSnapshotRebuild=true realtimeSnapshotFastPathTested=false serviceSaveTested=false qualified=false\n";
}
