// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
#include "pch.h"
#include "catch.hpp"
#include "Tone3000Defaults.hpp"
#include "Tone3000Operations.hpp"
#include "Tone3000Library.hpp"
#include "PluginHost.hpp"
#include "JackConfiguration.hpp"
#include "Lv2Pedalboard.hpp"
#include "AesDigest.hpp"
#include <cstdlib>
#include <fstream>
#include <limits>
#include <sstream>
#include <sys/stat.h>
#include <unistd.h>
using namespace pipedal;
namespace fs=std::filesystem;
namespace {
struct Temporary {
    fs::path path;
    Temporary() {
        auto pattern=(fs::canonical(fs::temp_directory_path())/"tone3000-defaults-test-XXXXXX").string();
        std::vector<char> name(pattern.begin(),pattern.end());name.push_back(0);
        auto result=mkdtemp(name.data());if(!result) throw std::runtime_error("Fixture creation failed");path=result;
    }
    ~Temporary(){std::error_code error;fs::remove_all(path,error);}
};
struct ScopedConfigHome {
    std::optional<std::string> previous;
    explicit ScopedConfigHome(const fs::path& path) {
        if(const char* value=getenv("XDG_CONFIG_HOME")) previous=value;
        if(setenv("XDG_CONFIG_HOME",path.c_str(),1)) throw std::runtime_error("Fixture environment setup failed");
    }
    ~ScopedConfigHome(){if(previous) setenv("XDG_CONFIG_HOME",previous->c_str(),1);else unsetenv("XDG_CONFIG_HOME");}
};
void Put(const fs::path& file,const std::string& text) {
    fs::create_directories(file.parent_path());std::ofstream out(file,std::ios::binary);out<<text;
    if(!out) throw std::runtime_error("Fixture write failed");
}
std::string Read(const fs::path& file) {auto bytes=Tone3000Library::ReadFile(file);return std::string(bytes.begin(),bytes.end());}
template<class T> std::string Json(const T& value){std::ostringstream out;json_writer writer(out);writer.write(value);return out.str();}
json_variant Raw(const std::string& value){std::istringstream in(value);json_reader reader(in);json_variant result;reader.read(&result);return result;}
std::string AppXml(){return "<?xml version=\"1.0\"?><PROPERTIES><VALUE name=\"multiCore\" val=\"1\"/><VALUE name=\"namSlimSizeDefault\" val=\"1.0\"/><VALUE name=\"calibrateInput\" val=\"1.0\"/><VALUE name=\"inputCalibrationLevel\" val=\"11.99999809265137\"/><VALUE name=\"osEnabled\" val=\"1.0\"/><VALUE name=\"osFactor\" val=\"0.0\"/></PROPERTIES>";}
Tone3000StateSummary Summary() {
    Tone3000StateSummary s;s.activePresetId_="rig";s.activePresetName_="Rig";
    Tone3000BlockSummary block;block.blockId_="amp";block.type_="nam";block.lane_="left";block.activeModelId_=23;
    Tone3000EqBand band;band.type_="bell";band.freqHz_=1000;band.gainDb_=0;band.q_=1;
    block.eq_.bands_.push_back(band);s.blocks_.push_back(block);return s;
}
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [DES-OPERATE] [3.12] */
TEST_CASE("Tone3000 profiles stage one authoritative store and retain exact backup","[gig_rig][gig_rig_defaults][Build]") {
    Temporary temp;auto service=temp.path/"service/preferences.settings",app=temp.path/"app/preferences.settings";
    Put(app,AppXml());Put(service,"<PROPERTIES><!--owner--><VALUE name=\"unrelated\" val=\"A &amp; B &quot;quoted&quot;\"/></PROPERTIES>");
    REQUIRE(chmod(service.c_str(),0640)==0);
    Tone3000DefaultsStore store(temp.path,service,{app});auto initial=store.Get();auto original=Read(service),appOriginal=Read(app);
    REQUIRE(initial.sourceStatus_=="app-seed");REQUIRE(initial.profiles_.size()==3);
    for(const auto& profile:initial.profiles_) REQUIRE(Json(profile.defaults_)==Json(initial.defaults_));
    REQUIRE(initial.defaults_.namSlimSizeDefault_==1);REQUIRE(initial.defaults_.calibrateInput_);
    REQUIRE(initial.defaults_.osEnabled_);REQUIRE(initial.defaults_.osFactor_==0);
    REQUIRE(Read(service)==original);REQUIRE(Read(app)==appOriginal);
    Tone3000DefaultsRequest request{initial.revision_,"live",initial.defaults_};request.defaults_.multiCore_=false;
    request.defaults_.osFactor_=2;request.defaults_.inputCalibrationLevel_=-3;
    auto saved=store.Save(request);REQUIRE(saved.activeProfile_=="live");REQUIRE(saved.sourceStatus_=="service-profile");
    REQUIRE(saved.defaults_.osFactor_==2);REQUIRE_FALSE(saved.defaults_.multiCore_);REQUIRE(saved.profiles_[0].defaults_.osFactor_==0);
    REQUIRE(Read(app)==appOriginal);REQUIRE(Read(service).find("A &amp; B &quot;quoted&quot;")!=std::string::npos);
    REQUIRE(Read(service).find("<!--owner-->")!=std::string::npos);
    struct stat status{};REQUIRE(stat(service.c_str(),&status)==0);REQUIRE((status.st_mode&0777)==0640);
    size_t backups=0;
    for(const auto& file:fs::directory_iterator(temp.path/"tone3000-library/backups")) if(file.path().extension()!=".sha256") {
        ++backups;REQUIRE(Read(file.path())==original);REQUIRE(Read(file.path().string()+".sha256")==AesDigest(original));
        REQUIRE(stat(file.path().c_str(),&status)==0);REQUIRE((status.st_mode&0777)==0600);
    }
    REQUIRE(backups==1);auto after=Read(service);REQUIRE_THROWS(store.Save(request));REQUIRE(Read(service)==after);
    Put(app,"<PROPERTIES><VALUE name=\"osFactor\" val=\"1\"/></PROPERTIES>");auto reference=store.Get();
    REQUIRE(reference.appDefaults_->osFactor_==1);REQUIRE(reference.defaults_.osFactor_==2);REQUIRE(reference.revision_==saved.revision_);
    request={reference.revision_,"studio",reference.defaults_};request.defaults_.osEnabled_=false;
    auto switched=store.Save(request);REQUIRE(switched.activeProfile_=="studio");REQUIRE_FALSE(switched.defaults_.osEnabled_);
    REQUIRE(switched.profiles_[2].defaults_.osFactor_==2);
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [DES-OPERATE] [3.12] */
TEST_CASE("Tone3000 defaults reject unsafe XML paths and nonfinite values without publishing","[gig_rig][gig_rig_defaults][Build]") {
    Temporary temp;auto file=temp.path/"service/preferences.settings";
    Tone3000DefaultsStore store(temp.path,file,{});auto defaults=store.Get();REQUIRE(defaults.sourceStatus_=="pinned-defaults");REQUIRE_FALSE(fs::exists(file));
    auto request=Tone3000DefaultsRequest{defaults.revision_,"home",defaults.defaults_};request.defaults_.inputCalibrationLevel_=std::numeric_limits<double>::quiet_NaN();
    REQUIRE_THROWS(store.Save(request));REQUIRE_FALSE(fs::exists(file));
    for(const auto& xml:std::vector<std::string>{
        "<!DOCTYPE PROPERTIES [<!ENTITY secret SYSTEM 'file:///etc/passwd'>]><PROPERTIES><VALUE name='x' val='&secret;'/></PROPERTIES>",
        "<PROPERTIES><VALUE name='osFactor' val='0.5'/></PROPERTIES>","<PROPERTIES><VALUE name='osEnabled' val='2'/></PROPERTIES>",
        "<PROPERTIES><VALUE name='inputCalibrationLevel' val='nan'/></PROPERTIES>",
        "<PROPERTIES><VALUE name='multiCore' val='1'/><VALUE name='multiCore' val='0'/></PROPERTIES>","<PROPERTIES><VALUE name='x'>bad</VALUE></PROPERTIES>",std::string(65537,'x')}) {
        Put(file,xml);REQUIRE_THROWS(store.Get());REQUIRE(Read(file)==xml);
    }
    Put(file,"<PROPERTIES/>");auto link=temp.path/"link.settings";fs::create_symlink(file,link);
    REQUIRE_THROWS(Tone3000DefaultsStore(temp.path,link,{}).Get());
    fs::create_directory_symlink(file.parent_path(),temp.path/"linked-directory");
    REQUIRE_THROWS(Tone3000DefaultsStore(temp.path,temp.path/"linked-directory/preferences.settings",{}).Get());
    fs::create_hard_link(file,temp.path/"hard.settings");REQUIRE_THROWS(store.Get());
    fs::remove(temp.path/"hard.settings");Put(temp.path/"app.settings","<invalid/>");
    auto app=Tone3000DefaultsStore(temp.path,file,{temp.path/"app.settings"}).Get();REQUIRE_FALSE(app.appDefaults_);REQUIRE(app.warnings_.size()==1);
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16] */
TEST_CASE("Tone3000 optional app roots cannot block authoritative defaults or admit links","[gig_rig][gig_rig_defaults][Build]") {
    Temporary temp;ScopedConfigHome config(temp.path/"service");
    auto service=temp.path/"service/TONE3000/preferences.settings";
    Tone3000DefaultsStore seed(temp.path,service,{});auto initial=seed.Get();
    auto saved=seed.Save({initial.revision_,"home",initial.defaults_});auto original=Read(service);
    auto app=temp.path/"app/TONE3000";Put(app/"preferences.settings",AppXml());
    fs::create_directories(app/"real-presets");
    fs::create_directory_symlink(app/"real-presets",app/"Presets");
    Tone3000DefaultsStore store(temp.path,std::vector<std::string>{(app/"Presets").string()});
    auto result=store.Get();
    REQUIRE(result.sourceStatus_=="service-profile");REQUIRE(result.revision_==saved.revision_);
    REQUIRE(Json(result.defaults_)==Json(saved.defaults_));REQUIRE_FALSE(result.appDefaults_);
    REQUIRE(result.warnings_.size()==1);REQUIRE(Read(service)==original);
    auto changed=Tone3000DefaultsRequest{result.revision_,"live",result.defaults_};changed.defaults_.osFactor_=2;
    auto updated=store.Save(changed);REQUIRE(updated.defaults_.osFactor_==2);REQUIRE(updated.sourceStatus_=="service-profile");
    REQUIRE_FALSE(updated.appDefaults_);REQUIRE(updated.warnings_.size()==1);
    // Validate roots on every read, including a root changed after construction.
    fs::remove(app/"Presets");fs::create_directory(app/"Presets");
    REQUIRE(store.Get().appDefaults_.has_value());
    fs::remove(app/"Presets");fs::create_directory_symlink(app/"real-presets",app/"Presets");
    REQUIRE_FALSE(store.Get().appDefaults_);
    // App preferences remain optional even before a service profile exists.
    fs::remove(service);auto fallback=store.Get();REQUIRE(fallback.sourceStatus_=="pinned-defaults");
    REQUIRE(fallback.warnings_.size()==1);REQUIRE_FALSE(fs::exists(service));
    REQUIRE_THROWS(Tone3000DefaultsStore(temp.path,std::vector<std::string>{"relative/Presets"}));
    REQUIRE_THROWS(Tone3000DefaultsStore(temp.path,std::vector<std::string>{(app/"../Presets").string()}));
    REQUIRE_THROWS(Tone3000DefaultsStore(temp.path,std::vector<std::string>(9,(app/"Presets").string())));
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [DES-SEC] [3.12] */
TEST_CASE("Tone3000 operations reject unmapped fields and preserve false zero sparse edits","[gig_rig][gig_rig_defaults][Build]") {
    auto valid=Raw(R"({"instanceId":1,"expectedRevision":"revision","patch":{"calibrateInput":false,"osFactor":0,"blocks":[{"blockId":"amp","enabled":false,"mix":0,"eqBands":[{"index":0,"freqHz":20}]}]},"followDefaults":false})");
    REQUIRE_NOTHROW(Tone3000Operations::ValidateRequestJson(valid,"setTone3000CurrentState"));
    std::istringstream in(valid.to_string());json_reader reader(in);Tone3000CurrentStateEdit request;reader.read(&request);
    REQUIRE(request.patch_.calibrateInput_.has_value());REQUIRE_FALSE(*request.patch_.calibrateInput_);REQUIRE(*request.patch_.osFactor_==0);
    REQUIRE(request.patch_.blocks_[0].mix_.has_value());REQUIRE(*request.patch_.blocks_[0].mix_==0);REQUIRE_FALSE(*request.followDefaults_);
    for(const auto& bad:{R"({"instanceId":1,"unknown":0})",R"({"instanceId":1,"patch":{"blockz":[]}})",R"({"instanceId":1,"patch":{"blocks":[{"blockId":"amp","unknown":0}]}})",R"({"instanceId":1,"patch":{"blocks":[{"blockId":"amp","eqBands":[{"index":0,"freqHz":20,"unknown":1}]}]}})",R"({"instanceId":1.5})",R"({"instanceId":1,"patch":{"calibrateInput":1}})",R"({"instanceId":1,"patch":{"osFactor":0.5}})",R"({"instanceId":1,"patch":{"blocks":[{"blockId":"amp","eqBands":[{"index":0.5}]}]}})"})
        REQUIRE_THROWS(Tone3000Operations::ValidateRequestJson(Raw(bad),"setTone3000CurrentState"));
    REQUIRE_THROWS(Tone3000Operations::ValidateRequestJson(Raw(R"({"expectedRevision":"r","activeProfile":"home","defaults":{"multiCore":true}})"),"setTone3000Defaults"));
    for(const auto& duplicate:{R"({"instanceId":1,"instanceId":2})",R"({"patch":{"osFactor":0,"osFactor":1}})",R"({"patch":{"blocks":[{"blockId":"amp","mix":0,"mix":1}]}})"}) {
        std::istringstream input(duplicate);json_reader parser(input);
        REQUIRE_THROWS(Tone3000Operations::ReadRequestJson(parser));
    }
    auto defaults=Tone3000DefaultsRequest{"r","home",{}};REQUIRE_NOTHROW(Tone3000Operations::ValidateRequestJson(Raw(Json(defaults)),"setTone3000Defaults"));
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [DES-STATE] [3.12] */
TEST_CASE("Tone3000 accepted-state guard rejects stale restores and tolerates float rounding","[gig_rig][gig_rig_defaults][Build]") {
    auto intended=Summary(),actual=intended;REQUIRE(Tone3000Operations::IntentMatches(actual,intended));
    actual.inputCalibrationLevel_+=.000001;actual.blocks_[0].inputGain_+=.0000001;REQUIRE(Tone3000Operations::IntentMatches(actual,intended));
    Tone3000BlockSummary insert;insert.type_="insert";insert.blockId_="native-padding";insert.lane_="left";actual.blocks_.insert(actual.blocks_.begin(),insert);
    REQUIRE(Tone3000Operations::IntentMatches(actual,intended));
    actual=intended;actual.activePresetId_="old";REQUIRE_FALSE(Tone3000Operations::IntentMatches(actual,intended));
    actual=intended;actual.inputMode_="left";REQUIRE_FALSE(Tone3000Operations::IntentMatches(actual,intended));
    actual=intended;actual.osFactor_=1;REQUIRE_FALSE(Tone3000Operations::IntentMatches(actual,intended));
    actual=intended;actual.blocks_[0].slimSize_=1;REQUIRE_FALSE(Tone3000Operations::IntentMatches(actual,intended));
    actual=intended;actual.blocks_[0].eq_.bands_[0].gainDb_=1;REQUIRE_FALSE(Tone3000Operations::IntentMatches(actual,intended));
    actual=intended;actual.blocks_[0].inputGain_=std::numeric_limits<double>::infinity();REQUIRE_FALSE(Tone3000Operations::IntentMatches(actual,intended));
    actual=intended;actual.blocks_.push_back(actual.blocks_[0]);REQUIRE_FALSE(Tone3000Operations::IntentMatches(actual,intended));
    auto ordered=intended;auto second=ordered.blocks_[0];second.blockId_="cab";second.type_="ir";ordered.blocks_.push_back(second);
    actual=ordered;std::swap(actual.blocks_[0],actual.blocks_[1]);REQUIRE_FALSE(Tone3000Operations::IntentMatches(actual,ordered));
    actual=ordered;actual.blocks_.insert(actual.blocks_.begin(),insert);REQUIRE(Tone3000Operations::IntentMatches(actual,ordered));
    actual=intended;intended.stereoEnabled_=true;intended.branchAfterBlockId_="amp";actual=intended;actual.inputMode_="left";
    REQUIRE(Tone3000Operations::IntentMatches(actual,intended));actual.inputMode_="right";REQUIRE_FALSE(Tone3000Operations::IntentMatches(actual,intended));
    intended.branchAfterBlockId_="stale";actual=intended;actual.branchAfterBlockId_.clear();REQUIRE(Tone3000Operations::IntentMatches(actual,intended));
    actual=intended;actual.branchAfterBlockId_="stale";REQUIRE_FALSE(Tone3000Operations::IntentMatches(actual,intended));
    Pedalboard board;auto item=board.MakeEmptyItem();board.items().push_back(item);auto revision=Tone3000Operations::Revision(item,1,2);
    item.tone3000FollowDefaults(true);REQUIRE(Tone3000Operations::Revision(item,1,2)!=revision);REQUIRE(Tone3000Operations::Revision(item,1,3)!=revision);
    board.items()[0]=item;std::istringstream in(Json(board));json_reader reader(in);Pedalboard restored;reader.read(&restored);
    REQUIRE(restored.items()[0].tone3000FollowDefaults());
    REQUIRE_FALSE(PedalboardItem().tone3000FollowDefaults());
}
/** No audio device or service writes; explicitly opt in only with a private HOME.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RELOAD] [DES-OPERATE] [3.12]
 */
TEST_CASE("Tone3000 force reload replaces only selected actual effect","[.gig_rig_force][gig_rig_runtime]") {
    Temporary temp;const char* path=getenv("LV2_PATH");REQUIRE(path!=nullptr);std::string lv2Path(path);
    PluginHost host;ChannelSelection channels;channels.mainInputChannels()={0,1};channels.mainOutputChannels()={0,1};
    JackConfiguration config;host.OnConfigurationChanged(config,channels);
    host.SetPluginStoragePath(temp.path);host.setSampleRate(48000);host.asIHost()->SetMaxAudioBufferSize(64);host.LoadLilv(lv2Path.c_str());
    auto info=host.GetPluginInfo(Tone3000Preset::PLUGIN_URI);REQUIRE(info!=nullptr);
    Pedalboard board;
    for(int i=0;i<2;++i) {
        auto item=board.MakeEmptyItem();item.uri(info->uri());item.pluginName(info->name());
        for(const auto& port:info->ports()) if(port->is_input() && port->is_control_port()) item.controlValues().push_back(ControlValue(port->symbol(),port->default_value()));
        board.items().push_back(item);
    }
    Lv2PedalboardErrorList errors;std::shared_ptr<Lv2Pedalboard> first(host.CreateLv2Pedalboard(board,errors));REQUIRE(errors.empty());
    std::shared_ptr<Lv2Pedalboard> reused(host.UpdateLv2PedalboardStructure(board,first.get(),errors));REQUIRE(errors.empty());
    auto selected=board.items()[0].instanceId(),other=board.items()[1].instanceId();
    REQUIRE(first->GetEffect(selected)!=nullptr);REQUIRE(reused->GetEffect(selected)==first->GetEffect(selected));
    std::shared_ptr<Lv2Pedalboard> forced(host.UpdateLv2PedalboardStructure(board,reused.get(),errors,{selected}));REQUIRE(errors.empty());
    REQUIRE(forced->GetEffect(selected)!=reused->GetEffect(selected));REQUIRE(forced->GetEffect(other)==reused->GetEffect(other));
}
