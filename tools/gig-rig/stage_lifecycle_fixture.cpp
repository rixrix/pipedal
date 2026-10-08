// Executes extracted production PiPedalModel lifecycle methods with controlled
// host/storage/graph adapters and the real codec, JSON and state serialization.
// It verifies ownership/order, not ALSA or native JUCE/DSP scheduling.
// @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STABILITY-REVIEW] [7.23]
#include "Tone3000Preset.hpp"
#include "Tone3000Operations.hpp"
#include "Tone3000Stage.hpp"
#include "PiPedalException.hpp"
#include "Tone3000StageBridge.hpp"
#include <mutex>
#include <fstream>
#include <memory>
#include <sstream>
#include <map>
#include <bit>
#include <cmath>
#include <iostream>
#include <functional>
#include <stdexcept>
#define CHECK(x) do { if (!(x)) throw std::runtime_error(#x); } while (false)
#define SS(x) ([&]{std::ostringstream stream;stream<<x;return stream.str();}())
using namespace pipedal;
struct Lv2Log { static void error(const std::string&){} };
struct CrashGuardLock {};
struct JackServerSettings { bool IsValid()const{return true;} void UseDummyAudioDevice(){} };
struct JackConfiguration {bool isValid()const{return true;}void setErrorStatus(const std::string&){}void AlsaInitialize(const JackServerSettings&){} };
struct Lv2Pedalboard {Lv2PluginState state;};
using Lv2PedalboardErrorList=std::vector<std::string>;
struct ReviewBoard {
    PedalboardItem item; Lv2PluginState snapshotState;
    std::vector<std::shared_ptr<Snapshot>> values{std::make_shared<Snapshot>()};int selected=-1;
    ReviewBoard DeepCopy()const{return *this;}
    bool ApplySnapshot(int index,int){if(index!=0)return false;item.lv2State(snapshotState);return true;}
    std::vector<PedalboardItem*> GetAllPlugins(){return {&item};}
    PedalboardItem* GetItem(int64_t id){return id==item.instanceId()?&item:nullptr;}
    void selectedSnapshot(int x){selected=x;}
    auto& snapshots(){return values;}
    bool IsStructureIdentical(const ReviewBoard& other)const{return item.lv2State()==other.item.lv2State();}
    Snapshot MakeSnapshotFromCurrentSettings(const ReviewBoard&){return {};}
};
struct ReviewPluginHost {
    operator int()const{return 0;}
    void OnConfigurationChanged(const JackConfiguration&,int){}
    Lv2Pedalboard* CreateLv2Pedalboard(const ReviewBoard& b,Lv2PedalboardErrorList&){return new Lv2Pedalboard{b.item.lv2State()};}
};
struct ReviewStorage {
    struct Banks {int selectedBank()const{return 5;}};
    Banks GetBanks()const{return {};}
    int GetCurrentPresetId()const{return 27;}int GetChannelSelection()const{return 0;}
};
struct ReviewAudioHost {
    bool open=true, graph=true;Lv2PluginState actual;int captures=0,closeCalls=0,reads=0,cancels=0;
    std::string terminal="done";bool completeAtCancel=false;std::vector<std::string> events;
    bool IsOpen()const{return open;}void Close(){open=false;++closeCalls;events.push_back("close");}
    void Open(const JackServerSettings&,int){open=true;}
    void SetPedalboard(std::shared_ptr<Lv2Pedalboard> p){graph=bool(p);if(p)actual=p->state;}
    void LoadSnapshot(const Snapshot&,ReviewPluginHost&){}
    bool UpdatePluginState(PedalboardItem& item){
        if(item.lv2State()==actual)return false;
        item.lv2State(actual);return true;
    }
    bool CapturePluginState(int64_t,Lv2PluginState* s){if(!graph)return false;*s=actual;++captures;events.push_back("capture");return true;}
    int ReadTone3000Stage(int64_t,uint64_t,std::string& s){
        ++reads;events.push_back("read");if(!graph)return -4;
        s="{\"state\":\""+terminal+"\"}";return s.size()+1;
    }
    int SubmitTone3000Stage(int64_t,uint64_t,uint32_t command,const std::string&){
        CHECK(command==TONE3000_STAGE_CANCEL);++cancels;events.push_back("cancel");
        if(!graph)return -4;
        // Native session mutex serializes this against its timer. A completion
        // winning immediately before CANCEL retains done; cancellation winning
        // while pending cannot subsequently complete a mutating action.
        if(completeAtCancel)terminal="done";
        else if(terminal=="pending")terminal="cancelled";
        return 0;
    }
};
struct PiPedalModel {
    struct Job {int64_t clientId=1,instanceId=1,bankId=5,presetId=27;uint64_t token=1,postHandle=0;uint32_t command=6;bool captured=false;};
    std::recursive_mutex mutex,audioLifecycleMutex;bool closed=false,previousPedalboardLoaded=true,dirty=false;
    ReviewBoard pedalboard,previousPedalboard;ReviewStorage storage;ReviewPluginHost pluginHost;
    ReviewAudioHost* audioHost;JackServerSettings jackServerSettings;JackConfiguration jackConfiguration;
    std::shared_ptr<Lv2Pedalboard> lv2Pedalboard;
    std::map<int64_t,Job> tone3000StageJobs,tone3000LevelMeasurements;
    std::map<int64_t,Tone3000StateSummary> pendingTone3000States;
    void CancelPost(uint64_t){}void CancelAudioRetry(){}void CancelConfiguredAudioRecovery(){}void ArmConfiguredAudioRecovery(){}
    void FireJackConfigurationChanged(const JackConfiguration&){}void FireChannelRouterSettingsChanged(int64_t){}
    void UpdateRealtimeVuSubscriptions(){}void UpdateRealtimeMonitorPortSubscriptions(){}void UpdateMidiListenFlags(){}
    void CheckForResourceInitialization(ReviewBoard&){}
    void ApplyTone3000FollowDefaults(ReviewBoard&){}void FireLv2StateChanged(int64_t,const Lv2PluginState&){}
    void SetPresetChanged(int64_t,bool x,bool){dirty=x;}
    void FirePedalboardChanged(int64_t,bool load=true){if(load)LoadCurrentPedalboard();}
    void RestartAudio(bool dummy=false);void SetSnapshot(int64_t);bool LoadCurrentPedalboard();
    #ifdef REVIEW_LEGACY_CANCEL
    void CancelTone3000StageJobs(int64_t id=-1);
    void CancelTone3000StageJobs(int64_t id,bool) { CancelTone3000StageJobs(id); }
#else
    void CancelTone3000StageJobs(int64_t id=-1,bool retainCurrentState=true);
#endif
    void RegisterTone3000Intents();PedalboardItem& CaptureTone3000Item(int64_t);
    bool OnNotifyMaybeLv2StateChanged(uint64_t);
};
#include "ProductionMethods.inc"
// Independent fixture helpers copied unchanged from Tone3000PresetTest.cpp.
namespace {
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
}

Lv2PluginState PanState(double left){
    return FullState(Node("TONE3000State",{{"schemaVersion",IntValue(1)},
        {"activePresetId",StringValue("rig")},{"activePresetName",StringValue("Rig")},{"inputMode",StringValue("left")}},
        {Node("PARAMETERS",{}, {Param("chainPanLeft",left,"PARAM"),Param("chainPanRight",1-left,"PARAM")}),
         Node("ChainSnapshot",{{"stereoEnabled",Variant(2)}}, {Node("ChainBlocks",{}, {Node("ChainBlock",{{"id",StringValue("insert")},{"type",StringValue("insert")}})})})}));
}
void Fixture(PiPedalModel& m,ReviewAudioHost& h){
    m.audioHost=&h;m.pedalboard.item.instanceId(1);m.pedalboard.item.uri(Tone3000Preset::PLUGIN_URI);
    m.pedalboard.item.lv2State(PanState(.5));m.previousPedalboard=m.pedalboard;
    h.actual=m.pedalboard.item.lv2State();m.tone3000StageJobs[1]={};
}

int main() {
    int failures=0, cases=0;
    auto run=[&](const char* name,const std::function<void()>& test){
        ++cases;try {test();std::cout<<"PASS "<<name<<"\n";}
        catch(const std::exception& e){++failures;std::cerr<<"FAIL "<<name<<": "<<e.what()<<"\n";}
    };
    run("restart retains done native mutation before Close",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);h.actual=PanState(.2);auto completed=h.actual;
        m.RestartAudio();
        CHECK(h.closeCalls==1);CHECK(h.captures==1);CHECK(m.tone3000StageJobs.empty());
        CHECK(m.pedalboard.item.lv2State()==completed);CHECK(h.actual==completed);CHECK(m.dirty);
        CHECK(std::find(h.events.begin(),h.events.end(),"capture")<std::find(h.events.begin(),h.events.end(),"close"));
    });
    run("snapshot desired state wins preceding completed action",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);h.actual=PanState(.2);auto requested=PanState(.4);
        m.pedalboard.snapshotState=requested;
        CHECK(Tone3000Operations::IntentMatches(Tone3000Preset::SummarizeState(h.actual),Tone3000Preset::SummarizeState(requested)));
        m.SetSnapshot(0);
        CHECK(h.captures==1);CHECK(m.tone3000StageJobs.empty());CHECK(m.pedalboard.selected==0);
        CHECK(m.pedalboard.item.lv2State()==requested);CHECK(h.actual==requested);CHECK(m.dirty);
    });
    run("completion winning CANCEL is read after cancellation",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);h.actual=PanState(.2);
        h.terminal="pending";h.completeAtCancel=true;m.CancelTone3000StageJobs();
        CHECK(h.captures==1);CHECK(m.dirty);CHECK(m.pedalboard.item.lv2State()==h.actual);
        CHECK(h.events.front()=="cancel");CHECK(m.tone3000StageJobs.empty());
    });
    run("cancellation winning native action cannot capture",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);h.terminal="pending";
        m.CancelTone3000StageJobs();CHECK(h.captures==0);CHECK(!m.dirty);
        CHECK(h.terminal=="cancelled");CHECK(m.tone3000StageJobs.empty());
    });
    run("replacement cleanup never captures old runtime",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);h.actual=PanState(.2);
        auto desired=PanState(.4);m.pedalboard.item.lv2State(desired);
        m.CancelTone3000StageJobs(-1,false);
        CHECK(h.cancels==1);CHECK(h.captures==0);CHECK(h.reads==0);
        CHECK(m.pedalboard.item.lv2State()==desired);CHECK(!m.dirty);
    });
    run("fallback board load preserves desired replacement",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);h.actual=PanState(.2);
        auto desired=PanState(.4);m.pedalboard.item.lv2State(desired);m.LoadCurrentPedalboard();
        CHECK(h.captures==0);CHECK(m.pedalboard.item.lv2State()==desired);CHECK(h.actual==desired);
        CHECK(m.tone3000StageJobs.empty());CHECK(!m.dirty);
    });
    run("stale owner completion is not captured",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);h.actual=PanState(.2);
        m.tone3000StageJobs[1].bankId=999;m.CancelTone3000StageJobs();
        CHECK(h.captures==0);CHECK(h.reads==0);CHECK(!m.dirty);CHECK(m.tone3000StageJobs.empty());
    });
    run("other client jobs are retained",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);m.CancelTone3000StageJobs(999);
        CHECK(h.cancels==0);CHECK(m.tone3000StageJobs.size()==1);CHECK(!m.dirty);
    });
    run("read-only measurement completion is not captured",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);
        m.tone3000StageJobs[1].command=TONE3000_STAGE_MEASURE_OUTPUT;m.CancelTone3000StageJobs();
        CHECK(h.cancels==1);CHECK(h.captures==0);CHECK(!m.dirty);
    });
    run("repeated snapshot recall restores opaque native state rather than stale baseline fast path",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);
        auto desired=PanState(.4);m.pedalboard.snapshotState=desired;
        h.actual=PanState(.2);m.SetSnapshot(0);
        CHECK(h.actual==desired);
        // Runtime was rebuilt with the desired opaque state; previous matches it.
        CHECK(m.previousPedalboard.item.lv2State()==desired);
        // A subsequent native completion changes the live state. Cancellation
        // captures that actual state before constructing the next desired recall.
        h.actual=PanState(.2);m.tone3000StageJobs[1]={};m.SetSnapshot(0);
        CHECK(m.pedalboard.item.lv2State()==desired);
        CHECK(h.actual==desired);
    });

    run("unchanged observation retains loaded baseline without dirtying",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);
        m.CaptureTone3000Item(1);
        CHECK(m.previousPedalboardLoaded);CHECK(!m.dirty);
        h.actual=PanState(.2);m.CaptureTone3000Item(1);
        CHECK(!m.previousPedalboardLoaded);CHECK(!m.dirty);
        CHECK(m.pedalboard.item.lv2State()==h.actual);
    });

    run("notification-first native completion cannot preserve a stale graph baseline",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);
        auto desired=PanState(.4);m.pedalboard.snapshotState=desired;
        h.actual=PanState(.2);m.SetSnapshot(0);CHECK(h.actual==desired);
        // The real OnNotifyMaybeLv2StateChanged/UpdatePluginState route can
        // refresh cached item state before explicit job completion capture.
        h.actual=PanState(.2);m.pedalboard.item.lv2State(h.actual);
        m.tone3000StageJobs[1]={};m.SetSnapshot(0);
        CHECK(m.pedalboard.item.lv2State()==desired);CHECK(h.actual==desired);
    });

    run("direct T3K patch notification restores desired snapshot with no Stage job",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);
        auto desired=PanState(.4);m.pedalboard.snapshotState=desired;
        m.SetSnapshot(0);m.CaptureTone3000Item(1);
        CHECK(m.tone3000StageJobs.empty());CHECK(m.pendingTone3000States.empty());
        h.actual=PanState(.2);
        CHECK(m.OnNotifyMaybeLv2StateChanged(1));
        CHECK(!m.previousPedalboardLoaded);
        m.SetSnapshot(0);CHECK(m.pedalboard.item.lv2State()==desired);CHECK(h.actual==desired);
    });
    run("ordinary plugin notification keeps existing graph baseline behavior",[]{
        PiPedalModel m;ReviewAudioHost h;Fixture(m,h);
        m.pedalboard.item.uri("urn:test:ordinary-plugin");h.actual=PanState(.2);
        CHECK(m.OnNotifyMaybeLv2StateChanged(1));
        CHECK(m.previousPedalboardLoaded);CHECK(m.dirty);
        CHECK(m.pedalboard.item.lv2State()==h.actual);
    });
    std::cout<<cases<<" cases, "<<failures<<" failures\n";return failures?1:0;
}
