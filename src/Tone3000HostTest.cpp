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
