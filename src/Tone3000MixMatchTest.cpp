// SPDX-License-Identifier: MIT
#include "catch.hpp"
#include "Tone3000MixMatch.hpp"
#include "Tone3000Performance.hpp"
#include "Tone3000Operations.hpp"
#include "PiPedalException.hpp"
#include <bit>
#include <sstream>
#include <fstream>
#include <unistd.h>
using namespace pipedal;
namespace {
using Bytes=std::vector<uint8_t>;
using Fields=std::vector<std::pair<std::string,Bytes>>;
void Add(Bytes& a,const Bytes& b){a.insert(a.end(),b.begin(),b.end());}
Bytes Text(const std::string& s){Bytes b(s.begin(),s.end());b.push_back(0);return b;}
Bytes Packed(uint32_t x){Bytes b;while(x){b.push_back(x&255);x>>=8;}b.insert(b.begin(),b.size());return b;}
Bytes Var(uint8_t kind,const Bytes& data={}){auto b=Packed(data.size()+1);b.push_back(kind);Add(b,data);return b;}
Bytes Str(const std::string& s){return Var(5,Text(s));}
Bytes Num(double x){Bytes b;auto bits=std::bit_cast<uint64_t>(x);for(int i=0;i<8;++i){b.push_back(bits&255);bits>>=8;}return Var(4,b);}
Bytes Int(uint32_t x){Bytes b;for(int i=0;i<4;++i){b.push_back(x&255);x>>=8;}return Var(1,b);}
Bytes Node(const std::string& tag,const Fields& fields={},const std::vector<Bytes>& children={}){
    auto b=Text(tag);Add(b,Packed(fields.size()));for(const auto& [key,value]:fields){Add(b,Text(key));Add(b,value);}Add(b,Packed(children.size()));for(const auto& child:children)Add(b,child);return b;
}
Bytes Param(const std::string& id,double value){return Node("Param",{{"id",Str(id)},{"value",Num(value)}});}
Lv2PluginState State(const std::vector<Bytes>& params={}){
    const std::string nam="{\"version\":\"0.7.0\",\"architecture\":\"Linear\",\"config\":{\"receptive_field\":1,\"bias\":false},\"weights\":[1],\"metadata\":{\"gear_type\":\"amp\"},\"sample_rate\":48000}";
    const Bytes wav{'R','I','F','F',40,0,0,0,'W','A','V','E','f','m','t',' ',16,0,0,0,1,0,1,0,128,187,0,0,0,119,1,0,2,0,16,0,'d','a','t','a',4,0,0,0,1,0,0,0};
    auto block=[&](bool amp){const auto id=amp?1:2;return Node("ChainBlock",{{"id",Str(amp?"amp":"cab")},{"type",Str(amp?"nam":"ir")},{"enabled",Var(2)},
        {"toneId",Int(id)},{"activeModelId",Int(id)},{"mix",Num(.9)},{"slimSize",Num(.75)},
        {"toneJson",Str(std::string("{\"gear\":\"")+(amp?"amp":"cab")+"\",\"models\":[{\"id\":"+(amp?"1":"2")+"}]}")}},
        {Node("ModelCache",{}, {Node("CachedModel",{{"modelId",Int(id)},{"data",Var(8,amp?Bytes(nam.begin(),nam.end()):wav)}})})});};
    const auto snapshot=Node("ChainSnapshot",{{"stereoEnabled",Var(3)}},{Node("ChainBlocks",{}, {block(true),block(false)}),Node("RightChainBlocks")});
    Bytes file{'T','3','K','B'};Add(file,Node("T3KPreset",{{"schemaVersion",Int(1)},{"id",Str("fixture")},{"name",Str("Original")}}, {snapshot,Node("Params",{},params)}));
    auto state=Tone3000Preset::BuildState(file,"fixture.t3kpreset");Tone3000StatePatch patch;patch.inputMode_="left";return Tone3000Preset::EditState(state,patch);
}
Pedalboard Source(const std::vector<Bytes>& params={}){
    Pedalboard board;board.name("Original");board.input_volume_db(-2);board.output_volume_db(-3);
    auto before=board.MakeEmptyItem();before.uri("test:delay");before.pluginName("Existing delay");before.controlValues().emplace_back("mix",.3f);board.items().push_back(before);
    auto tone=board.MakeEmptyItem();tone.uri(Tone3000Preset::PLUGIN_URI);tone.lv2State(State(params));tone.tone3000FollowDefaults(true);tone.tone3000SourceKey("original");tone.tone3000SourceHash("source-hash");board.items().push_back(tone);
    auto after=board.MakeEmptyItem();after.uri("test:reverb");after.lv2State().isValid_=true;after.pathProperties({{"test:file","preserved-path"}});board.items().push_back(after);board.selectedPlugin(tone.instanceId());return board;
}
Tone3000MixMatchRequest Request(const Pedalboard& source){Tone3000MixMatchRequest r;r.bankId_=6;r.presetId_=24;r.instanceId_=2;r.expectedRevision_=Tone3000Performance::Revision(source);r.ampBlockId_="amp";r.cabBlockId_="cab";r.name_="Experimental copy";r.confirmAmpHead_=true;r.creationId_="12345678-1234-4234-8234-123456789abc";return r;}
template<class T> std::string Json(const T& x){std::ostringstream stream;json_writer writer(stream);writer.write(x);return stream.str();}
template<class T> T Read(const std::string& x){std::istringstream stream(x);json_reader reader(stream);T value;reader.read(&value);return value;}
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [DES-MIX-MATCH] [7.34] */
TEST_CASE("Mix match creates complete unique stages and preserves source surrounding effects", "[gig_rig][gig_rig_mix_match][Build]"){
    auto source=Source();const auto before=Json(source);auto request=Request(source);
    auto prepared=Tone3000MixMatch::Prepare(source,request,true);auto& board=prepared.board;
    REQUIRE(Json(source)==before);REQUIRE(board.items().size()==5);REQUIRE(Json(board.items().front())==Json(source.items().front()));REQUIRE(Json(board.items().back())==Json(source.items().back()));
    REQUIRE(board.input_volume_db()==-2);REQUIRE(board.output_volume_db()==-3);REQUIRE(board.snapshots().empty());REQUIRE(board.selectedSnapshot()==-1);
    REQUIRE(prepared.pitchInstanceId>3);REQUIRE(prepared.ampInstanceId>prepared.pitchInstanceId);REQUIRE(prepared.cabInstanceId>prepared.ampInstanceId);
    REQUIRE(board.MakeEmptyItem().instanceId()>prepared.cabInstanceId);
    REQUIRE(board.items()[1].uri()==Tone3000MixMatch::PITCH_URI);REQUIRE(board.items()[2].uri()==Tone3000Preset::PLUGIN_URI);REQUIRE(board.items()[3].uri()==Tone3000Preset::PLUGIN_URI);
    for(size_t i=1;i<=3;++i){const auto& item=board.items()[i];REQUIRE(item.tone3000DerivedSource());REQUIRE(item.tone3000DerivedSource()->creationId_==request.creationId_);REQUIRE(item.tone3000DerivedSource()->requestHash_==Tone3000MixMatch::RequestHash(request));REQUIRE_FALSE(item.tone3000FollowDefaults());REQUIRE(item.tone3000SourceKey().empty());REQUIRE(item.tone3000SourceHash().empty());REQUIRE(item.midiBindings().empty());REQUIRE_FALSE(item.midiChannelBinding());}
    REQUIRE(prepared.preview.requiresAmpHeadConfirmation_);REQUIRE_FALSE(prepared.preview.qualified_);REQUIRE(prepared.preview.pitchControls_.size()==6);REQUIRE(prepared.preview.ampSummary_.blocks_.size()==1);REQUIRE(prepared.preview.cabSummary_.blocks_.size()==1);
    auto roundTrip=Read<Pedalboard>(Json(board));REQUIRE(Json(roundTrip)==Json(board));
    auto noPitch=request;noPitch.includePitch_=false;auto two=Tone3000MixMatch::Prepare(source,noPitch,true);REQUIRE(two.board.items().size()==4);REQUIRE(two.pitchInstanceId==-1);REQUIRE(two.preview.pitchControls_.empty());
    auto preview=request;preview.confirmAmpHead_=false;preview.creationId_.clear();REQUIRE_NOTHROW(Tone3000MixMatch::Prepare(source,preview,false));REQUIRE_THROWS(Tone3000MixMatch::Prepare(source,preview,true));
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [7.34] */
TEST_CASE("Mix match migrates pitch only without changing upstream gain gate ordering", "[gig_rig][gig_rig_mix_match][Build]"){
    auto source=Source({Param("pitchEnabled",1),Param("pitchSemitones",-3.5),Param("pitchStep",0),Param("pitchTonality",12345),Param("pitchWindow",2),Param("gateEnabled",0)});auto request=Request(source);
    auto prepared=Tone3000MixMatch::Prepare(source,request,true);
    REQUIRE(prepared.board.items()[1].GetControlValue("input_mode")->value()==1);
    auto rightSource=source.DeepCopy();Tone3000StatePatch right;right.inputMode_="right";rightSource.items()[1].lv2State(Tone3000Preset::EditState(rightSource.items()[1].lv2State(),right));
    const auto rightPrepared=Tone3000MixMatch::Prepare(rightSource,Request(rightSource),true);REQUIRE(rightPrepared.board.items()[1].GetControlValue("input_mode")->value()==2);
    for(const auto& [key,value]:std::vector<std::pair<const char*,float>>{{"enabled",1},{"semitones",-3.5f},{"step",0},{"tonality",12345},{"window",2}}){auto p=prepared.board.items()[1].GetControlValue(key);REQUIRE(p);REQUIRE(p->value()==value);}
    REQUIRE(Tone3000Preset::ParameterValue(prepared.board.items()[2].lv2State(),"pitchEnabled")==0);
    REQUIRE(Tone3000Preset::ParameterValue(prepared.board.items()[3].lv2State(),"pitchEnabled")==0);
    request.includePitch_=false;auto retained=Tone3000MixMatch::Prepare(source,request,true);REQUIRE(Tone3000Preset::ParameterValue(retained.board.items()[1].lv2State(),"pitchEnabled")==1);
    for(const auto& params:std::vector<std::vector<Bytes>>{{Param("pitchEnabled",1)},{Param("pitchEnabled",1),Param("gateEnabled",0),Param("inputLevel",.6)}}){auto unsafe=Source(params);REQUIRE_THROWS(Tone3000MixMatch::Prepare(unsafe,Request(unsafe),true));}
    auto state=source.items()[1].lv2State();state.values_["urn:other"].value_={1,2,3};auto disabled=Tone3000Preset::WithPitchDisabled(state);REQUIRE(disabled.values_.at("urn:other")==state.values_.at("urn:other"));REQUIRE(Tone3000Preset::InspectState(disabled).embeddedBytes==Tone3000Preset::InspectState(state).embeddedBytes);
    REQUIRE_THROWS(Tone3000Preset::ParameterValue(state,"unknown"));REQUIRE_THROWS(Tone3000Preset::WithPitchDisabled(Lv2PluginState{}));
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [DES-PITCH-LV2] [7.34] */
TEST_CASE("Mix match refuses stale complex corrupt or unconfirmed sources before publication", "[gig_rig][gig_rig_mix_match][Build]"){
    auto test=[](Pedalboard board){return Tone3000MixMatch::Prepare(board,Request(board),true);};
    auto source=Source();auto stale=Request(source);source.items()[0].controlValues()[0].value(.4f);REQUIRE_THROWS(Tone3000MixMatch::Prepare(source,stale,true));
    source=Source();source.items()[1].isEnabled(false);REQUIRE_THROWS(test(source));
    source=Source();source.items()[0].topChain().push_back(source.MakeEmptyItem());REQUIRE_THROWS(test(source));
    source=Source();source.items()[0].sideChainInputId(2);REQUIRE_THROWS(test(source));
    source=Source();source.items()[0].uri(SPLIT_PEDALBOARD_ITEM_URI);REQUIRE_THROWS(test(source));
    source=Source();source.items()[0].instanceId(2);REQUIRE_THROWS(test(source));
    source=Source();source.items()[0].instanceId(100);REQUIRE_THROWS(test(source)); // inconsistent allocator must never collide
    source=Source();auto snapshot=std::make_shared<Snapshot>();SnapshotValue value;value.instanceId_=1;snapshot->values_.push_back(value);source.snapshots().push_back(snapshot);REQUIRE_THROWS(test(source));
    source=Source();source.items()[0].uri(Tone3000Preset::PLUGIN_URI);REQUIRE_THROWS(test(source));
    source=Source();source.items()[1].tone3000DerivedSource(Tone3000DerivedSource{});REQUIRE_THROWS(test(source));
    auto request=Request(Source());for(const auto& name:{"../outside","","   "}){request.name_=name;REQUIRE_THROWS(Tone3000MixMatch::Validate(request,true));}
    request=Request(Source());request.creationId_="not-uuid";REQUIRE_THROWS(Tone3000MixMatch::Validate(request,true));
    request=Request(Source());request.confirmAmpHead_=false;REQUIRE_THROWS(Tone3000MixMatch::Validate(request,true));
    auto validate=[](const std::string& text){std::istringstream stream(text);json_reader reader(stream);auto raw=Tone3000Operations::ReadRequestJson(reader);Tone3000MixMatch::ValidateJson(raw,true);};
    request=Request(Source());REQUIRE_NOTHROW(validate(Json(request)));
    auto raw=Read<json_variant>(Json(request));(*raw.as_object())["extra"]=true;REQUIRE_THROWS(validate(raw.to_string()));
    raw=Read<json_variant>(Json(request));(*raw.as_object())["includePitch"]=json_null{};REQUIRE_THROWS(validate(raw.to_string()));
    auto text=Json(request);text.insert(1,"\"bankId\":6,");REQUIRE_THROWS(validate(text));
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [7.34] */
TEST_CASE("Mix match receipts reconcile exact requests and reject collisions partial stages", "[gig_rig][gig_rig_mix_match][Build]"){
    auto source=Source();auto request=Request(source);auto prepared=Tone3000MixMatch::Prepare(source,request,true);
    BankFile bank;bank.name(std::string(Tone3000MixMatch::BANK_PREFIX)+request.name_);const auto preset=bank.addPreset(prepared.board);
    auto receipt=Tone3000MixMatch::Receipt(42,bank,request);REQUIRE(receipt);REQUIRE(receipt->bankId_==42);REQUIRE(receipt->presetId_==preset);REQUIRE(receipt->ampInstanceId_==prepared.ampInstanceId);REQUIRE(receipt->pitchInstanceId_==prepared.pitchInstanceId);
    REQUIRE(receipt->name_==request.name_);
    bank.name("Renamed by owner");auto renamed=Tone3000MixMatch::Receipt(42,bank,request);REQUIRE(renamed);REQUIRE(renamed->presetId_==preset);REQUIRE(renamed->name_==request.name_);
    auto changed=request;changed.name_="Changed";REQUIRE_THROWS(Tone3000MixMatch::Receipt(42,bank,changed));
    changed=request;changed.includePitch_=false;REQUIRE_THROWS(Tone3000MixMatch::Receipt(42,bank,changed));
    changed=request;changed.creationId_="22345678-1234-4234-8234-123456789abc";REQUIRE_FALSE(Tone3000MixMatch::Receipt(42,bank,changed));
    auto& items=bank.getItem(preset).preset().items();items.erase(items.begin()+2);REQUIRE_THROWS(Tone3000MixMatch::Receipt(42,bank,request));
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [7.34] */
TEST_CASE("Derived policy pins survive browser omission and ordinary control edits", "[gig_rig][gig_rig_mix_match][Build]"){
    auto source=Source();auto prepared=Tone3000MixMatch::Prepare(source,Request(source),true);auto incoming=prepared.board.DeepCopy();
    auto* amp=incoming.GetItem(prepared.ampInstanceId);amp->tone3000DerivedSource(std::nullopt);amp->tone3000FollowDefaults(true);amp->tone3000SourceKey("wrong");amp->tone3000SourceHash("wrong");
    Tone3000MixMatch::PinDerivedPolicies(incoming,&prepared.board);REQUIRE(amp->tone3000DerivedSource());REQUIRE_FALSE(amp->tone3000FollowDefaults());REQUIRE(amp->tone3000SourceKey().empty());REQUIRE(amp->tone3000SourceHash().empty());
    auto regular=Source();Tone3000MixMatch::PinDerivedPolicies(regular);REQUIRE(regular.items()[1].tone3000FollowDefaults());REQUIRE(regular.items()[1].tone3000SourceKey()=="original");
    amp->tone3000FollowDefaults(true);Tone3000MixMatch::PinDerivedPolicies(incoming);REQUIRE_FALSE(amp->tone3000FollowDefaults());
}

/** The one-preset authoring path uses the same backed atomic bank/index publication.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [DES-SEC] [7.34]
 */
TEST_CASE("Mix match publication retains source selection and complete authoring receipt", "[gig_rig][gig_rig_mix_match][Build]"){
    namespace fs=std::filesystem;
    char name[]="/tmp/tone3000-mix-match-XXXXXX";auto path=mkdtemp(name);REQUIRE(path);
    struct Cleanup{fs::path path;~Cleanup(){std::error_code ec;fs::remove_all(path,ec);}} cleanup{fs::canonical(path)};
    const auto root=cleanup.path,indexPath=root/"index.json",sourcePath=root/"source.bank",newPath=root/"experiment.bank";
    auto write=[](const fs::path& path,const auto& value){std::ofstream file(path);json_writer writer(file);writer.write(value);};
    auto text=[](const fs::path& path){std::ifstream file(path);return std::string(std::istreambuf_iterator<char>(file),{});};
    auto source=Source();auto request=Request(source);BankFile original;original.name("TONE3000 Original");original.addPreset(source);write(sourcePath,original);
    BankIndex index;const auto old=index.addBank(-1,original.name());index.selectedBank(old);write(indexPath,index);
    const auto sourceBefore=text(sourcePath),indexBefore=text(indexPath);
    auto prepared=Tone3000MixMatch::Prepare(source,request,true);BankFile bank;bank.name(std::string(Tone3000MixMatch::BANK_PREFIX)+request.name_);bank.selectedPreset(bank.addPreset(prepared.board));
    auto next=index;const auto id=next.addBank(old,bank.name());Tone3000Performance::Publish(root,newPath,indexPath,bank,next);
    REQUIRE(text(sourcePath)==sourceBefore);REQUIRE(index.entries().size()==1);
    const auto savedIndex=Read<BankIndex>(text(indexPath));REQUIRE(savedIndex.selectedBank()==old);REQUIRE(savedIndex.entries().back().instanceId()==id);
    const auto savedBank=Read<BankFile>(text(newPath));REQUIRE(savedBank.presets().size()==1);REQUIRE(savedBank.selectedPreset()==bank.selectedPreset());
    auto receipt=Tone3000MixMatch::Receipt(id,savedBank,request);REQUIRE(receipt);REQUIRE(receipt->name_==request.name_);REQUIRE(receipt->cabInstanceId_==prepared.cabInstanceId);
    REQUIRE_THROWS(Tone3000Performance::Publish(root,newPath,indexPath,bank,next));REQUIRE(text(sourcePath)==sourceBefore);
    bool backed=false;for(const auto& file:fs::directory_iterator(root/"tone3000-library/backups"))if(file.path().extension()!=".sha256"&&text(file.path())==indexBefore)backed=true;REQUIRE(backed);
}

/** A post-rename failure plus failed rollback must prevent another writer.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [DES-SEC] [7.34]
 */
TEST_CASE("Mix match blocks further authoring after an uncertain publication", "[gig_rig][gig_rig_mix_match][Build]"){
    Tone3000MixMatchPublicationGuard guard;int writes=0;bool diskPublished=false;
    REQUIRE_NOTHROW(guard.Check());
    REQUIRE_NOTHROW(guard.Publish([&]{++writes;}));REQUIRE(writes==1);
    REQUIRE_THROWS(guard.Publish([&]{++writes;diskPublished=true;throw PiPedalStateException("Index directory fsync and rollback failed after rename.");}));
    REQUIRE(diskPublished);REQUIRE(writes==2);REQUIRE_THROWS(guard.Check());
    REQUIRE_THROWS(guard.Publish([&]{++writes;}));REQUIRE(writes==2);
    Tone3000MixMatchPublicationGuard restarted;REQUIRE_NOTHROW(restarted.Check());
}
