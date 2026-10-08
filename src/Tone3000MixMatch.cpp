// SPDX-License-Identifier: MIT
#include "Tone3000MixMatch.hpp"
#include "Tone3000Performance.hpp"
#include "AesDigest.hpp"
#include "PiPedalException.hpp"
#include "Utf8Utils.hpp"
#include <algorithm>
#include <bit>
#include <set>
#include <sstream>
using namespace pipedal;
JSON_MAP_BEGIN(Tone3000MixMatchRequest)
JSON_MAP_REFERENCE(Tone3000MixMatchRequest,bankId)
JSON_MAP_REFERENCE(Tone3000MixMatchRequest,presetId)
JSON_MAP_REFERENCE(Tone3000MixMatchRequest,instanceId)
JSON_MAP_REFERENCE(Tone3000MixMatchRequest,expectedRevision)
JSON_MAP_REFERENCE(Tone3000MixMatchRequest,ampBlockId)
JSON_MAP_REFERENCE(Tone3000MixMatchRequest,cabBlockId)
JSON_MAP_REFERENCE(Tone3000MixMatchRequest,name)
JSON_MAP_REFERENCE(Tone3000MixMatchRequest,creationId)
JSON_MAP_REFERENCE(Tone3000MixMatchRequest,confirmAmpHead)
JSON_MAP_REFERENCE(Tone3000MixMatchRequest,includePitch)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000MixMatchItem)
JSON_MAP_REFERENCE(Tone3000MixMatchItem,instanceId)
JSON_MAP_REFERENCE(Tone3000MixMatchItem,uri)
JSON_MAP_REFERENCE(Tone3000MixMatchItem,name)
JSON_MAP_REFERENCE(Tone3000MixMatchItem,role)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000MixMatchPreview)
JSON_MAP_REFERENCE(Tone3000MixMatchPreview,sourceRevision)
JSON_MAP_REFERENCE(Tone3000MixMatchPreview,sourceName)
JSON_MAP_REFERENCE(Tone3000MixMatchPreview,name)
JSON_MAP_REFERENCE(Tone3000MixMatchPreview,ampBlockId)
JSON_MAP_REFERENCE(Tone3000MixMatchPreview,cabBlockId)
JSON_MAP_REFERENCE(Tone3000MixMatchPreview,ampSummary)
JSON_MAP_REFERENCE(Tone3000MixMatchPreview,cabSummary)
JSON_MAP_REFERENCE(Tone3000MixMatchPreview,includePitch)
JSON_MAP_REFERENCE(Tone3000MixMatchPreview,requiresAmpHeadConfirmation)
JSON_MAP_REFERENCE(Tone3000MixMatchPreview,qualified)
JSON_MAP_REFERENCE(Tone3000MixMatchPreview,pitchControls)
JSON_MAP_REFERENCE(Tone3000MixMatchPreview,items)
JSON_MAP_REFERENCE(Tone3000MixMatchPreview,warnings)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000MixMatchResult)
JSON_MAP_REFERENCE(Tone3000MixMatchResult,bankId)
JSON_MAP_REFERENCE(Tone3000MixMatchResult,presetId)
JSON_MAP_REFERENCE(Tone3000MixMatchResult,ampInstanceId)
JSON_MAP_REFERENCE(Tone3000MixMatchResult,cabInstanceId)
JSON_MAP_REFERENCE(Tone3000MixMatchResult,pitchInstanceId)
JSON_MAP_REFERENCE(Tone3000MixMatchResult,name)
JSON_MAP_REFERENCE(Tone3000MixMatchResult,sourceRevision)
JSON_MAP_REFERENCE(Tone3000MixMatchResult,qualified)
JSON_MAP_END()
namespace {
constexpr int64_t MAX_ID=9007199254740991LL;
template<class T> std::string Json(const T& value){std::ostringstream stream;json_writer writer(stream);writer.write(value);return stream.str();}
bool Finite(double x){return (std::bit_cast<uint64_t>(x)&0x7ff0000000000000ULL)!=0x7ff0000000000000ULL;}
bool Hash(const std::string& s){return s.size()==64&&std::all_of(s.begin(),s.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');});}
bool Uuid(const std::string& s){
    if(s.size()!=36)return false;
    for(size_t i=0;i<s.size();++i)if(i==8||i==13||i==18||i==23){if(s[i]!='-')return false;}
        else if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')))return false;
    return true;
}
void Name(const std::string& s){
    if(s.empty()||s.size()>96||!IsValidUtf8(s)||s.find_first_not_of(' ')==std::string::npos)
        throw PiPedalArgumentException("Enter a copy name (1–96 UTF-8 bytes).");
    for(unsigned char c:s)if(c<32||c==127||c=='/'||c=='\\')throw PiPedalArgumentException("Invalid copy name.");
}
void Identity(const std::string& s){if(s.empty()||s.size()>512||!IsValidUtf8(s))throw PiPedalArgumentException("Invalid saved block identity.");}
}
void Tone3000MixMatch::Validate(const Tone3000MixMatchRequest& request,bool create){
    for(auto id:{request.bankId_,request.presetId_,request.instanceId_})if(id<0||id>MAX_ID)throw PiPedalArgumentException("Choose an exact saved source.");
    if(!Hash(request.expectedRevision_))throw PiPedalArgumentException("A current whole-source revision is required.");
    Name(request.name_);Identity(request.ampBlockId_);Identity(request.cabBlockId_);
    if(request.ampBlockId_==request.cabBlockId_)throw PiPedalArgumentException("Choose separate amp and cab blocks.");
    if((create||!request.creationId_.empty())&&!Uuid(request.creationId_))throw PiPedalArgumentException("A canonical creation UUID is required.");
    if(create&&!request.confirmAmpHead_)throw PiPedalArgumentException("Confirm the NAM is an amp-head capture, not a baked amp+cab.");
}
void Tone3000MixMatch::ValidateJson(const json_variant& raw,bool create){
    if(!raw.is_object())throw PiPedalArgumentException("Expected a mix-and-match request.");
    const std::set<std::string> allowed{"bankId","presetId","instanceId","expectedRevision","ampBlockId","cabBlockId","name","creationId","confirmAmpHead","includePitch"};
    for(const auto& [key,value]:*raw.as_object())if(!allowed.contains(key))throw PiPedalArgumentException("Unknown mix-and-match field.");
    for(const auto* key:{"bankId","presetId","instanceId"}){
        if(!raw.as_object()->contains(key)||!raw[key].is_number())throw PiPedalArgumentException("Missing source identity.");
        auto x=raw[key].as_number();if(!Finite(x)||x<0||x>MAX_ID||x!=static_cast<int64_t>(x))throw PiPedalArgumentException("Invalid source identity.");
    }
    for(const auto* key:{"expectedRevision","ampBlockId","cabBlockId","name"})
        if(!raw.as_object()->contains(key)||!raw[key].is_string())throw PiPedalArgumentException("Missing mix-and-match field.");
    if(raw.as_object()->contains("creationId")&&!raw["creationId"].is_string())throw PiPedalArgumentException("Invalid creation UUID.");
    for(const auto* key:{"confirmAmpHead","includePitch"})if(raw.as_object()->contains(key)&&!raw[key].is_bool())throw PiPedalArgumentException("Invalid mix-and-match switch.");
    std::istringstream stream(raw.to_string());json_reader reader(stream);Tone3000MixMatchRequest request;reader.read(&request);Validate(request,create);
}
std::string Tone3000MixMatch::RequestHash(const Tone3000MixMatchRequest& request){return AesDigest(Json(request));}
Tone3000MixMatchPrepared Tone3000MixMatch::Prepare(const Pedalboard& source,const Tone3000MixMatchRequest& request,bool create){
    Validate(request,create);
    if(Tone3000Performance::Revision(source)!=request.expectedRevision_)throw PiPedalStateException("Saved source changed; refresh before creating the copy.");
    if(source.items().empty()||source.items().size()>1024||!Finite(source.input_volume_db())||!Finite(source.output_volume_db()))throw PiPedalArgumentException("Invalid saved serial board.");
    for(const auto& snapshot:source.snapshots())if(snapshot&&!snapshot->values_.empty())throw PiPedalArgumentException("Source snapshots contain values; use a separate source copy without snapshots.");
    const PedalboardItem* original=nullptr;std::set<int64_t> ids;int64_t maxId=0;
    for(const auto& item:source.items()){
        if(item.isSplit()||!item.topChain().empty()||!item.bottomChain().empty()||item.sideChainInputId()!=-1)
            throw PiPedalArgumentException("Only serial sources without splits or sidechains can be copied.");
        if(item.instanceId()<1||item.instanceId()>MAX_ID||!ids.insert(item.instanceId()).second)throw PiPedalArgumentException("Saved source has invalid or duplicate host IDs.");
        maxId=std::max(maxId,item.instanceId());
        if(item.uri()==Tone3000Preset::PLUGIN_URI){
            if(original||!item.isEnabled()||item.instanceId()!=request.instanceId_||item.tone3000DerivedSource())throw PiPedalArgumentException("Choose one enabled original top-level TONE3000 source.");
            original=&item;
        }
    }
    if(!original)throw PiPedalArgumentException("Saved source has no requested TONE3000 item.");
    auto parts=Tone3000Preset::PartitionAmpCab(original->lv2State(),request.ampBlockId_,request.cabBlockId_,true);
    Tone3000MixMatchPrepared result;result.board=source;result.board=result.board.DeepCopy();
    result.board.name(request.name_);result.board.snapshots().clear();result.board.selectedSnapshot(-1);
    auto& preview=result.preview;preview.sourceRevision_=request.expectedRevision_;preview.sourceName_=source.name();preview.name_=request.name_;
    preview.ampBlockId_=request.ampBlockId_;preview.cabBlockId_=request.cabBlockId_;preview.includePitch_=request.includePitch_;
    std::vector<PedalboardItem> stages;
    const auto hash=RequestHash(request);
    auto stage=[&](const char* role,const char* uri){
        auto item=result.board.MakeEmptyItem();
        if(item.instanceId()<=maxId||item.instanceId()>MAX_ID)throw PiPedalArgumentException("Saved source host-ID allocator is invalid; recreate the source copy.");
        maxId=item.instanceId();item.uri(uri);item.pluginName(role==std::string_view("pitch")?"T3K Pitch":"TONE3000");
        item.title(role==std::string_view("amp")?"T3K Amp":role==std::string_view("cab")?"T3K Cab":"T3K Pitch");
        item.tone3000FollowDefaults(false);
        item.tone3000DerivedSource(Tone3000DerivedSource{request.bankId_,request.presetId_,request.instanceId_,request.expectedRevision_,request.ampBlockId_,request.cabBlockId_,role,request.creationId_,hash});
        return item;
    };
    if(request.includePitch_){
        const auto& state=original->lv2State();
        if(Tone3000Preset::ParameterValue(state,"pitchEnabled")!=0
            &&(Tone3000Preset::ParameterValue(state,"inputLevel")!=.5||Tone3000Preset::ParameterValue(state,"gateEnabled")!=0))
            throw PiPedalArgumentException("Moving active pitch requires unity input gain and gate off; prepare a separate source copy first.");
        auto pitch=stage("pitch",PITCH_URI);result.pitchInstanceId=pitch.instanceId();
        for(const auto& [symbol,parameter]:std::vector<std::pair<const char*,const char*>>{{"enabled","pitchEnabled"},{"semitones","pitchSemitones"},{"step","pitchStep"},{"tonality","pitchTonality"},{"window","pitchWindow"}})
            pitch.controlValues().emplace_back(symbol,static_cast<float>(Tone3000Preset::ParameterValue(state,parameter)));
        // Native T3K folds the selected input before pitch analysis. Preserve that
        // ordering even when preceding host effects produce unequal L/R signals.
        // @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-PITCH-LV2] [7.34]
        pitch.controlValues().emplace_back("input_mode",Tone3000Preset::SummarizeState(state).inputMode_=="left"?1.f:2.f);
        preview.pitchControls_=pitch.controlValues();stages.push_back(std::move(pitch));
        parts.ampState=Tone3000Preset::WithPitchDisabled(parts.ampState);
    }
    auto amp=stage("amp",Tone3000Preset::PLUGIN_URI);amp.lv2State(parts.ampState);amp.stateUpdateCount(1);result.ampInstanceId=amp.instanceId();stages.push_back(std::move(amp));
    auto cab=stage("cab",Tone3000Preset::PLUGIN_URI);cab.lv2State(parts.cabState);cab.stateUpdateCount(1);result.cabInstanceId=cab.instanceId();stages.push_back(std::move(cab));
    std::vector<PedalboardItem> items;
    for(const auto& item:source.items())if(item.instanceId()==original->instanceId())items.insert(items.end(),stages.begin(),stages.end());else items.push_back(item);
    result.board.items()=std::move(items);result.board.selectedPlugin(result.ampInstanceId);
    preview.ampSummary_=Tone3000Preset::SummarizeState(parts.ampState);preview.cabSummary_=Tone3000Preset::SummarizeState(parts.cabState);
    for(const auto& item:result.board.items())preview.items_.push_back({item.instanceId(),item.uri(),item.title().empty()?item.pluginName():item.title(),item.tone3000DerivedSource()?item.tone3000DerivedSource()->stage_:"effect"});
    preview.warnings_={"Experimental copy: asset loading, sound, latency and CPU are not qualified.","Middle effects must preserve the mono signal; put stereo delay/reverb after Cab.","Separate TONE3000 stages add filtering, rate boundaries and worker overhead."};
    return result;
}
std::optional<Tone3000MixMatchResult> Tone3000MixMatch::Receipt(int64_t bankId,const BankFile& bank,const Tone3000MixMatchRequest& request){
    std::optional<Tone3000MixMatchResult> result;
    for(const auto& entry:bank.presets()){
        auto board=entry->preset();std::set<std::string> roles;std::set<int64_t> ids;
        Tone3000MixMatchResult candidate;candidate.bankId_=bankId;candidate.presetId_=entry->instanceId();candidate.name_=board.name();candidate.sourceRevision_=request.expectedRevision_;
        bool found=false;
        for(const auto* item:board.GetAllPlugins())if(item->tone3000DerivedSource()&&item->tone3000DerivedSource()->creationId_==request.creationId_){
            found=true;const auto& p=*item->tone3000DerivedSource();
            if(p.requestHash_!=RequestHash(request)||p.bankId_!=request.bankId_||p.presetId_!=request.presetId_||p.instanceId_!=request.instanceId_
                ||p.revision_!=request.expectedRevision_||p.ampBlockId_!=request.ampBlockId_||p.cabBlockId_!=request.cabBlockId_
                ||item->instanceId()<1||!ids.insert(item->instanceId()).second||!roles.insert(p.stage_).second)
                throw PiPedalStateException("Creation receipt conflicts with this request; inspect the experimental bank.");
            if(p.stage_=="amp"&&item->uri()==Tone3000Preset::PLUGIN_URI)candidate.ampInstanceId_=item->instanceId();
            else if(p.stage_=="cab"&&item->uri()==Tone3000Preset::PLUGIN_URI)candidate.cabInstanceId_=item->instanceId();
            else if(p.stage_=="pitch"&&item->uri()==PITCH_URI)candidate.pitchInstanceId_=item->instanceId();
            else throw PiPedalStateException("Creation receipt has an invalid stage.");
        }
        if(found){
            if(result||roles.size()!=(request.includePitch_?3:2)||candidate.ampInstanceId_<0||candidate.cabInstanceId_<0
                ||(request.includePitch_?(candidate.pitchInstanceId_<0):(candidate.pitchInstanceId_>=0)))throw PiPedalStateException("Creation receipt is partial or ambiguous; inspect the experimental bank.");
            result=candidate;
        }
    }
    return result;
}
void Tone3000MixMatch::PinDerivedPolicies(Pedalboard& board,const Pedalboard* previous){
    for(auto* item:board.GetAllPlugins()){
        const auto* old=previous?previous->GetItem(item->instanceId()):nullptr;
        if(old&&old->uri()==item->uri()&&old->tone3000DerivedSource())item->tone3000DerivedSource(old->tone3000DerivedSource());
        if(item->tone3000DerivedSource()){
            item->tone3000FollowDefaults(false);item->tone3000SourceKey("");item->tone3000SourceHash("");
        }
    }
}
void Tone3000MixMatchPublicationGuard::Check() const{
    if(blocked_)throw PiPedalStateException("Experimental publication failed; inspect saved banks and restart the service before retrying.");
}
