// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
#include "catch.hpp"
#include "stage-addon/Tone3000StageMeter.hpp"
#include <array>
#include <limits>
using namespace std;
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.6] */
TEST_CASE("stage output meter bounds duration and waits for complete real samples", "[stage_meter]") {
 Tone3000StageMeter meter;REQUIRE_FALSE(meter.arm(0,1));REQUIRE_FALSE(meter.arm(8000,0));REQUIRE_FALSE(meter.arm(8000,11));REQUIRE_FALSE(meter.arm(numeric_limits<double>::infinity(),1));
 array<float,8000> left,right;left.fill(.25f);right.fill(.5f);const float* data[]={left.data(),right.data()};
 REQUIRE(meter.arm(8000,1));meter.add(data,2,4000);REQUIRE_FALSE(meter.complete());REQUIRE_FALSE(meter.result().valid);
 meter.add(data,2,8000);REQUIRE(meter.complete());auto result=meter.result();REQUIRE(result.samples==8000);REQUIRE(result.channels==2);REQUIRE(result.seconds==1);REQUIRE(result.rms==Approx(sqrt((.25*.25+.5*.5)/2)));REQUIRE(result.peak==.5);REQUIRE(result.valid);
 left.fill(1);meter.add(data,2,8000);REQUIRE(meter.result().valid);REQUIRE(meter.result().peak==.5);
 meter.cancel();REQUIRE_FALSE(meter.complete());REQUIRE_FALSE(meter.result().valid);
}
TEST_CASE("stage output meter rejects silence clipping nonfinite and channel changes", "[stage_meter]") {
 Tone3000StageMeter meter;array<float,8000> samples{};const float* data[]={samples.data()};
 REQUIRE(meter.arm(8000,1));meter.add(data,1,8000);REQUIRE(meter.result().silent);REQUIRE_FALSE(meter.result().valid);
 samples.fill(1);REQUIRE(meter.arm(8000,1));meter.add(data,1,8000);REQUIRE(meter.result().clipped);REQUIRE_FALSE(meter.result().valid);
 samples.fill(.5);samples[0]=numeric_limits<float>::quiet_NaN();REQUIRE(meter.arm(8000,1));meter.add(data,1,8000);REQUIRE_FALSE(meter.result().finite);REQUIRE_FALSE(meter.result().valid);
 samples[0]=numeric_limits<float>::infinity();REQUIRE(meter.arm(8000,1));meter.add(data,1,8000);REQUIRE_FALSE(meter.result().finite);
 samples[0]=.5;REQUIRE(meter.arm(8000,1));meter.add(data,1,4000);const float* two[]={samples.data(),samples.data()};meter.add(two,2,4000);REQUIRE_FALSE(meter.result().finite);
 REQUIRE(meter.arm(8000,1));const float* missing[]={nullptr};meter.add(missing,1,8000);REQUIRE_FALSE(meter.result().valid);
}
