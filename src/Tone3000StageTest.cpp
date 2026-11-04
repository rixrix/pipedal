// SPDX-License-Identifier: MIT
#include "pch.h"
#include "catch.hpp"
#include "Tone3000Stage.hpp"
#include "../tools/gig-rig/Tone3000StageBridge.hpp"
#include <limits>
using namespace pipedal;
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [DES-SEC] [7.5] [7.6] */
TEST_CASE("Soundcheck accepts only identified bounded native commands", "[tone3000_stage]") {
    const std::string hash(64,'a');
    auto value=json_variant::parse("{\"instanceId\":1,\"command\":\"balance\",\"expectedRevision\":\""+hash+"\"}");
    auto request=Tone3000Stage::Request(value,false);
    CHECK(request.instanceId_==1);CHECK(Tone3000Stage::Command(request.command_)==2);
    value["unknown"]=true;CHECK_THROWS(Tone3000Stage::Request(value,false));
    for(const auto& text:{"{\"instanceId\":1,\"token\":0}","{\"instanceId\":1.2,\"token\":1}","{\"instanceId\":1,\"token\":1,\"command\":\"level\"}"})
        CHECK_THROWS(Tone3000Stage::Request(json_variant::parse(text),true));
    CHECK(Tone3000Stage::Request(json_variant::parse("{\"instanceId\":1,\"token\":33}"),true).token_==33);
    const auto update=Tone3000Stage::UpdateRequest(json_variant::parse("{\"instanceId\":1,\"token\":33,\"payload\":{\"phase\":\"commit\"}}"));
    CHECK(update.instanceId_==1);CHECK(update.token_==33);CHECK_FALSE(update.payload_.empty());
    for(const auto& text:{"{\"instanceId\":1,\"token\":0,\"payload\":{}}","{\"instanceId\":1,\"token\":2,\"payload\":[]}","{\"instanceId\":1,\"token\":2,\"payload\":{},\"extra\":1}"})
        CHECK_THROWS(Tone3000Stage::UpdateRequest(json_variant::parse(text)));
    CHECK(Tone3000Stage::Command("block")==TONE3000_STAGE_BLOCK_EDIT);CHECK(Tone3000Stage::Mutates(TONE3000_STAGE_BLOCK_EDIT));
    CHECK_THROWS(Tone3000Stage::Command("injected"));
    CHECK(Tone3000Stage::Terminal(Tone3000Stage::Result("{\"state\":\"notApplicable\"}")));
    CHECK_FALSE(Tone3000Stage::Terminal(Tone3000Stage::Result("{\"state\":\"listening\"}")));
    CHECK_THROWS(Tone3000Stage::Result("{\"state\":\"successMaybe\"}"));
}
TEST_CASE("Played RMS proposals preserve headroom and reject invalid measurements", "[tone3000_stage]") {
    auto value=json_variant::parse("{\"valid\":true,\"finite\":true,\"silent\":false,\"clipped\":false,\"rmsDb\":-18,\"peakDb\":-8,\"seconds\":3,\"samples\":144000}");
    CHECK(Tone3000Stage::MatchedOutput(value,-24,.5)==Approx(.375));
    CHECK(Tone3000Stage::MatchedOutput(value,-18,.5)==Approx(.5));
    CHECK_THROWS(Tone3000Stage::MatchedOutput(value,-6,.5)); // peak would clip.
    CHECK_THROWS(Tone3000Stage::MatchedOutput(value,-40,.5)); // excessive trim.
    CHECK_THROWS(Tone3000Stage::MatchedOutput(value,-24,.05)); // no hidden clamp.
    CHECK_THROWS(Tone3000Stage::MatchedOutput(value,std::numeric_limits<double>::quiet_NaN(),.5));
    for(const auto* key:{"clipped","silent"}) {
        value[key]=true;CHECK_THROWS(Tone3000Stage::MatchedOutput(value,-24,.5));value[key]=false;
    }
    value["valid"]=false;CHECK_THROWS(Tone3000Stage::MatchedOutput(value,-24,.5));value["valid"]=true;
    value["samples"]=0.0;CHECK_THROWS(Tone3000Stage::MatchedOutput(value,-24,.5));
}
