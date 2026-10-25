// SPDX-License-Identifier: MIT
#include "Tone3000Stage.hpp"
#include "Tone3000Operations.hpp"
#include "PiPedalException.hpp"
#include "../tools/gig-rig/Tone3000StageBridge.hpp"
#include <algorithm>
#include <cmath>
#include <sstream>
using namespace pipedal;
namespace {
bool Hash(const std::string& value) { return value.size()==64 && std::all_of(value.begin(),value.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');}); }
int64_t Id(const json_variant& value) {
    if(!value.is_number() || !std::isfinite(value.as_number()) || value.as_number()<0
       || value.as_number()>9007199254740991.0 || std::floor(value.as_number())!=value.as_number())
        throw PiPedalArgumentException("Invalid soundcheck identity.");
    return static_cast<int64_t>(value.as_number());
}
}
uint32_t Tone3000Stage::Command(const std::string& command) {
    if(command=="runtime")return TONE3000_STAGE_RUNTIME;
    if(command=="balance")return TONE3000_STAGE_AUTO_BALANCE;
    if(command=="align")return TONE3000_STAGE_AUTO_ALIGN;
    if(command=="cancel")return TONE3000_STAGE_CANCEL;
    if(command=="level")return TONE3000_STAGE_MEASURE_OUTPUT;
    if(command=="pan")return TONE3000_STAGE_LINKED_PAN;
    if(command=="solo")return TONE3000_STAGE_EXCLUSIVE_SOLO;
    if(command=="block")return TONE3000_STAGE_BLOCK_EDIT;
    throw PiPedalArgumentException("Unsupported soundcheck command.");
}
Tone3000StageRequest Tone3000Stage::Request(const json_variant& value,bool poll) {
    if(!value.is_object())throw PiPedalArgumentException("Expected soundcheck request.");
    for(const auto& [key,field]:*value.as_object())
        if(key!="instanceId" && key!="token" && (poll || (key!="command" && key!="expectedRevision" && key!="payload")))
            throw PiPedalArgumentException("Unknown soundcheck field.");
    Tone3000StageRequest result;
    if(!value.as_object()->contains("instanceId"))throw PiPedalArgumentException("Missing soundcheck instance.");
    result.instanceId_=Id(value["instanceId"]);
    if(poll) {
        if(!value.as_object()->contains("token"))throw PiPedalArgumentException("Missing soundcheck token.");
        result.token_=Id(value["token"]);
        if(!result.token_)throw PiPedalArgumentException("Invalid soundcheck token.");
    } else {
        if(!value.as_object()->contains("command") || !value["command"].is_string()
           || !value.as_object()->contains("expectedRevision") || !value["expectedRevision"].is_string()
           || !Hash(value["expectedRevision"].as_string()))throw PiPedalArgumentException("Refresh the current rig before soundcheck.");
        result.command_=value["command"].as_string();result.expectedRevision_=value["expectedRevision"].as_string();
        Command(result.command_);
        if(result.command_=="cancel")throw PiPedalArgumentException("Cancel uses the active request token.");
        if(value.as_object()->contains("token"))throw PiPedalArgumentException("Soundcheck tokens are assigned by the server.");
        if(value.as_object()->contains("payload")){
            if(!value["payload"].is_object())throw PiPedalArgumentException("Expected soundcheck options object.");
            result.payload_=value["payload"].to_string();
            if(result.payload_.size()>TONE3000_STAGE_MAX_REQUEST)throw PiPedalArgumentException("Soundcheck options exceed their bound.");
        }
    }
    return result;
}
Tone3000StageUpdateRequest Tone3000Stage::UpdateRequest(const json_variant& value) {
    if(!value.is_object()||value.size()!=3||!value.as_object()->contains("instanceId")
       ||!value.as_object()->contains("token")||!value.as_object()->contains("payload")||!value["payload"].is_object())
        throw PiPedalArgumentException("Expected an active block edit update.");
    Tone3000StageUpdateRequest result;result.instanceId_=Id(value["instanceId"]);result.token_=Id(value["token"]);
    if(!result.token_)throw PiPedalArgumentException("Invalid block edit token.");
    result.payload_=value["payload"].to_string();
    if(result.payload_.empty()||result.payload_.size()>TONE3000_STAGE_MAX_REQUEST)throw PiPedalArgumentException("Block edit exceeds its bound.");
    return result;
}
json_variant Tone3000Stage::Result(const std::string& text) {
    if(text.empty() || text.size()>=TONE3000_STAGE_MAX_RESPONSE)throw PiPedalStateException("Invalid native soundcheck response.");
    std::istringstream stream(text);json_reader reader(stream);
    auto value=Tone3000Operations::ReadRequestJson(reader);
    if(!value.is_object() || !value.as_object()->contains("state") || !value["state"].is_string())
        throw PiPedalStateException("Invalid native soundcheck result.");
    const auto state=value["state"].as_string();
    if(state!="queued" && state!="listening" && state!="done" && state!="timeout" && state!="cancelled"
       && state!="notApplicable" && state!="failed" && state!="stale")throw PiPedalStateException("Unknown native soundcheck state.");
    return value;
}
bool Tone3000Stage::Terminal(const json_variant& result) {auto state=result["state"].as_string();return state!="queued"&&state!="listening";}
bool Tone3000Stage::Mutates(uint32_t command) {return command==2||command==3||command==6||command==7||command==8;}
/** Reviewable output-only proposal; clipping and out-of-range gain are refused rather than clamped.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.6]
 */
double Tone3000Stage::MatchedOutput(const json_variant& m,double target,double output) {
    if(!m.is_object())throw PiPedalStateException("No output measurement is available.");
    if(!std::isfinite(target)||target< -60||target> -3||!std::isfinite(output)||output<0||output>1)
        throw PiPedalArgumentException("Choose a bounded level target and output trim.");
    for(const auto* key:{"valid","finite","clipped","silent"})
        if(!m.as_object()->contains(key)||!m[key].is_bool())throw PiPedalStateException("No valid played measurement is available.");
    if(!m["valid"].as_bool()||!m["finite"].as_bool()||m["clipped"].as_bool()||m["silent"].as_bool())
        throw PiPedalStateException("Measure a non-silent unclipped phrase before matching levels.");
    for(const auto* key:{"rmsDb","peakDb","seconds","samples"})
        if(!m.as_object()->contains(key)||!m[key].is_number()||!std::isfinite(m[key].as_number()))
            throw PiPedalStateException("Incomplete output measurement.");
    if(m["seconds"].as_number()<1||m["samples"].as_number()<1||m["rmsDb"].as_number()< -60
       ||m["peakDb"].as_number()<m["rmsDb"].as_number())throw PiPedalStateException("Invalid output measurement.");
    const double delta=target-m["rmsDb"].as_number();
    const double proposed=output+delta/48.0;
    if(std::abs(delta)>12||proposed<0||proposed>1||m["peakDb"].as_number()+delta> -1)
        throw PiPedalArgumentException("Proposed trim exceeds the gain or peak headroom bound; choose a quieter target.");
    return proposed;
}
Tone3000LevelRequest Tone3000Stage::LevelRequest(const json_variant& value) {
    if(!value.is_object() || value.size()!=3 || !value.as_object()->contains("token")
       || !value.as_object()->contains("expectedRevision") || !value.as_object()->contains("targetRmsDb"))
        throw PiPedalArgumentException("Expected an identified level proposal.");
    Tone3000LevelRequest result;result.token=Id(value["token"]);
    if(!result.token || !value["expectedRevision"].is_string() || !Hash(value["expectedRevision"].as_string())
       || !value["targetRmsDb"].is_number() || !std::isfinite(value["targetRmsDb"].as_number()))
        throw PiPedalArgumentException("Invalid level proposal.");
    result.revision=value["expectedRevision"].as_string();result.target=value["targetRmsDb"].as_number();return result;
}
