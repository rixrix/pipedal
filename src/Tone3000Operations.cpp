// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
#include "Tone3000Operations.hpp"
#include "AesDigest.hpp"
#include "PiPedalException.hpp"
#include <algorithm>
#include <cmath>
#include <set>
#include <sstream>
using namespace pipedal;
JSON_MAP_BEGIN(Tone3000CurrentStateRequest)
JSON_MAP_REFERENCE(Tone3000CurrentStateRequest,instanceId)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000CurrentStateResult)
JSON_MAP_REFERENCE(Tone3000CurrentStateResult,revision)
JSON_MAP_REFERENCE(Tone3000CurrentStateResult,instanceId)
JSON_MAP_REFERENCE(Tone3000CurrentStateResult,followDefaults)
JSON_MAP_REFERENCE(Tone3000CurrentStateResult,hasSnapshotOverrides)
JSON_MAP_REFERENCE(Tone3000CurrentStateResult,summary)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000CurrentStateEdit)
JSON_MAP_REFERENCE(Tone3000CurrentStateEdit,instanceId)
JSON_MAP_REFERENCE(Tone3000CurrentStateEdit,expectedRevision)
JSON_MAP_REFERENCE(Tone3000CurrentStateEdit,patch)
JSON_MAP_REFERENCE(Tone3000CurrentStateEdit,followDefaults)
JSON_MAP_REFERENCE(Tone3000CurrentStateEdit,applyDefaults)
JSON_MAP_END()
namespace {
bool Near(double a,double b) {return std::isfinite(a)&&std::isfinite(b)&&std::abs(a-b)<=1e-5*std::max({1.0,std::abs(a),std::abs(b)});}
void Keys(const json_variant& object,std::initializer_list<const char*> keys) {
    if(!object.is_object()) throw PiPedalArgumentException("Expected an operation object.");
    std::set<std::string> allowed;for(auto key:keys) allowed.insert(key);
    std::set<std::string> seen;
    for(const auto& [key,value]:*object.as_object()) if(!allowed.contains(key) || !seen.insert(key).second)
        throw PiPedalArgumentException("Unknown or duplicated operation field.");
}
void FieldTypes(const json_variant& object,std::initializer_list<const char*> booleans,
                std::initializer_list<const char*> numbers,std::initializer_list<const char*> integers,
                std::initializer_list<const char*> strings,bool optional=false) {
    auto check=[&](const char* name,auto predicate) {
        if(!object.as_object()->contains(name)) return;
        const auto& value=object[name];
        if(optional && value.is_null()) return;
        if(!predicate(value)) throw PiPedalArgumentException("Unsupported operation field type or number.");
    };
    for(auto key:booleans) check(key,[](const auto& x){return x.is_bool();});
    for(auto key:numbers) check(key,[](const auto& x){return x.is_number() && std::isfinite(x.as_number());});
    for(auto key:integers) check(key,[](const auto& x){return x.is_number() && std::isfinite(x.as_number()) && x.as_number()==std::floor(x.as_number()) && std::abs(x.as_number())<=9007199254740991.0;});
    for(auto key:strings) check(key,[](const auto& x){return x.is_string() && x.as_string().size()<=4096;});
}
json_variant ReadStrict(json_reader& reader,size_t depth,size_t& nodes) {
    if(depth>16 || ++nodes>10000) throw PiPedalArgumentException("Operation JSON exceeds its structure bound.");
    if(reader.peek()=='{') {
        reader.consume('{');auto object=std::make_shared<json_object>();
        if(reader.peek()=='}') {reader.consume('}');return json_variant(object);}
        while(true) {
            std::string key=reader.read_string();
            if(key.size()>4096 || object->contains(key)) throw PiPedalArgumentException("Duplicated or oversized operation field.");
            reader.consume(':');(*object)[key]=ReadStrict(reader,depth+1,nodes);
            if(reader.peek()=='}') {reader.consume('}');return json_variant(object);}
            reader.consume(',');
        }
    }
    if(reader.peek()=='[') {
        reader.consume('[');auto array=std::make_shared<json_array>();
        if(reader.peek()==']') {reader.consume(']');return json_variant(array);}
        while(true) {
            array->push_back(ReadStrict(reader,depth+1,nodes));
            if(reader.peek()==']') {reader.consume(']');return json_variant(array);}
            reader.consume(',');
        }
    }
    json_variant value;reader.read(&value);
    if(value.is_string() && value.as_string().size()>4096) throw PiPedalArgumentException("Operation string exceeds its bound.");
    return value;
}
void Array(const json_variant& value,size_t maximum) {if(!value.is_array() || value.size()>maximum) throw PiPedalArgumentException("Unsupported operation array.");}
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [3.12] */
Tone3000StatePatch Tone3000Operations::ProcessingPatch(const Tone3000ProcessingDefaults& d) {
    Tone3000DefaultsStore::Validate(d);Tone3000StatePatch p;
    p.calibrateInput_=d.calibrateInput_;p.inputCalibrationLevel_=d.inputCalibrationLevel_;p.osEnabled_=d.osEnabled_;p.osFactor_=d.osFactor_;return p;
}
/** Match accepted state, allowing native insert padding and APVTS float rounding.
 * This deliberately makes no engine readiness or DSP/audibility assertion.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [DES-STATE] [3.12]
 */
bool Tone3000Operations::IntentMatches(const Tone3000StateSummary& a,const Tone3000StateSummary& b) {
    // Pinned ProcessorChain::refreshBranchTapIndex clears stale/insert taps;
    // ProcessorHistory::restoreChainSnapshot folds active stereo feeds to left.
    auto branch=b.branchAfterBlockId_;
    bool validTap=std::any_of(b.blocks_.begin(),b.blocks_.end(),[&](const auto& block){return block.blockId_==branch && block.lane_==b.branchSide_ && block.type_!="insert";});
    if(!validTap) branch.clear();
    auto input=b.inputMode_;
    if(validTap && b.stereoEnabled_ && (input=="stereo" || input=="dual")) input="left";
    if(a.activePresetId_!=b.activePresetId_ || a.activePresetName_!=b.activePresetName_ || a.inputMode_!=input
       || a.calibrateInput_!=b.calibrateInput_ || !Near(a.inputCalibrationLevel_,b.inputCalibrationLevel_)
       || a.osEnabled_!=b.osEnabled_ || a.osFactor_!=b.osFactor_ || a.stereoEnabled_!=b.stereoEnabled_
       || a.branchSide_!=b.branchSide_ || a.branchAfterBlockId_!=branch) return false;
    auto count=[](const auto& s){return std::count_if(s.blocks_.begin(),s.blocks_.end(),[](const auto& x){return x.type_!="insert";});};
    if(count(a)!=count(b)) return false;
    for (const auto& lane:{"left","right"}) {
        auto order=[&](const auto& summary) {
            std::vector<std::string> ids;
            for (const auto& block:summary.blocks_) if(block.type_!="insert" && block.lane_==lane) ids.push_back(block.blockId_);
            return ids;
        };
        if(order(a)!=order(b)) return false;
    }
    for(const auto& wanted:b.blocks_) {
        if(wanted.type_=="insert") continue;
        auto it=std::find_if(a.blocks_.begin(),a.blocks_.end(),[&](const auto& x){return x.blockId_==wanted.blockId_ && x.lane_==wanted.lane_;});
        if(it==a.blocks_.end()) return false;const auto& got=*it;
        if(got.type_!=wanted.type_ || got.activeModelId_!=wanted.activeModelId_ || got.enabled_!=wanted.enabled_
           || got.normalize_!=wanted.normalize_ || !Near(got.inputGain_,wanted.inputGain_) || !Near(got.outputGain_,wanted.outputGain_)
           || !Near(got.mix_,wanted.mix_) || !Near(got.slimSize_,wanted.slimSize_) || got.eq_.enabled_!=wanted.eq_.enabled_
           || got.eq_.pre_!=wanted.eq_.pre_ || got.eq_.bands_.size()!=wanted.eq_.bands_.size()) return false;
        for(size_t i=0;i<got.eq_.bands_.size();++i) {
            const auto& x=got.eq_.bands_[i];const auto& y=wanted.eq_.bands_[i];
            if(x.type_!=y.type_ || !Near(x.freqHz_,y.freqHz_) || !Near(x.gainDb_,y.gainDb_) || !Near(x.q_,y.q_)) return false;
        }
    }
    return true;
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [3.12] */
std::string Tone3000Operations::Revision(const PedalboardItem& item,int64_t bankId,int64_t presetId) {
    std::string data=std::to_string(bankId)+":"+std::to_string(presetId)+":"+std::to_string(item.instanceId())+":"+(item.tone3000FollowDefaults()?"follow":"saved");
    for(const auto& [key,value]:item.lv2State().values_) {
        data+=std::to_string(key.size())+":"+key+":"+value.atomType_+":"+std::to_string(value.flags_)+":"+std::to_string(value.value_.size())+":";
        data.append(value.value_.begin(),value.value_.end());
    }
    return AesDigest(data);
}
/** Reject unmapped JSON before generic maps can silently discard an edit.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [DES-SEC] [3.12]
 */
json_variant Tone3000Operations::ReadRequestJson(json_reader& reader) {
    size_t nodes=0;return ReadStrict(reader,0,nodes);
}
void Tone3000Operations::ValidateRequestJson(const json_variant& object,const std::string& request) {
    if(request=="getTone3000CurrentState") {Keys(object,{"instanceId"});FieldTypes(object,{},{},{"instanceId"},{});return;}
    if(request=="setTone3000Defaults") {
        Keys(object,{"expectedRevision","activeProfile","defaults"});
        FieldTypes(object,{},{},{},{"expectedRevision","activeProfile"});
        if(!object.as_object()->contains("defaults")) throw PiPedalArgumentException("Missing processing defaults.");
        Keys(object["defaults"],{"multiCore","namSlimSizeDefault","calibrateInput","inputCalibrationLevel","osEnabled","osFactor"});
        FieldTypes(object["defaults"],{"multiCore","calibrateInput","osEnabled"},{"namSlimSizeDefault","inputCalibrationLevel"},{"osFactor"},{});
        if(object["defaults"].size()!=6) throw PiPedalArgumentException("All six processing defaults are required.");return;
    }
    Keys(object,{"instanceId","expectedRevision","patch","followDefaults","applyDefaults"});
    FieldTypes(object,{},{},{"instanceId"},{"expectedRevision"});
    FieldTypes(object,{"followDefaults","applyDefaults"},{},{},{},true);
    if(!object.as_object()->contains("patch")) return;
    const auto& patch=object["patch"];
    Keys(patch,{"inputMode","calibrateInput","inputCalibrationLevel","osEnabled","osFactor","outputLevel","blocks"});
    FieldTypes(patch,{"calibrateInput","osEnabled"},{"inputCalibrationLevel","outputLevel"},{"osFactor"},{"inputMode"},true);
    if(!patch.as_object()->contains("blocks")) return;
    const auto& blocks=patch["blocks"];Array(blocks,256);
    for(size_t i=0;i<blocks.size();++i) {
        const auto& block=blocks[i];Keys(block,{"blockId","enabled","normalize","inputGain","outputGain","mix","slimSize","eqEnabled","eqPre","eqBands"});
        FieldTypes(block,{"enabled","normalize","eqEnabled","eqPre"},{"inputGain","outputGain","mix","slimSize"},{},{"blockId"},true);
        if(block.as_object()->contains("blockId") && block["blockId"].is_null()) throw PiPedalArgumentException("A block identity is required.");
        if(!block.as_object()->contains("eqBands")) continue;
        const auto& bands=block["eqBands"];Array(bands,6);
        for(size_t j=0;j<bands.size();++j) {Keys(bands[j],{"index","type","freqHz","gainDb","q"});FieldTypes(bands[j],{},{"freqHz","gainDb","q"},{"index"},{"type"},true);if(bands[j].as_object()->contains("index") && bands[j]["index"].is_null()) throw PiPedalArgumentException("An EQ band index is required.");}
    }
}
