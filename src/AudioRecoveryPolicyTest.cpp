// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
#include "catch.hpp"
#include "AudioRecoveryPolicy.hpp"
using namespace pipedal;
using namespace std::chrono_literals;

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-USB] [7.9] */
TEST_CASE("Configured audio recovery waits indefinitely without opening absent devices", "[audio_recovery]") {
    AudioRecoveryPolicy policy; REQUIRE(policy.Start()); auto generation=policy.Generation();
    const unsigned delays[]={2,4,8,15,30,30,30};
    for (auto delay:delays) REQUIRE(policy.NextDelay()==std::chrono::seconds(delay));
    auto now=AudioRecoveryPolicy::Clock::time_point{};
    for(unsigned i=0;i<1000;++i) REQUIRE(policy.Observe(generation,false,false,now+30s*i)==AudioRecoveryPolicy::Action::Wait);
    REQUIRE(policy.Attempts()==0); REQUIRE(policy.Active());
    REQUIRE(policy.Observe(generation,true,true,now+24h)==AudioRecoveryPolicy::Action::Attempt);
}

TEST_CASE("Configured audio recovery requires exact directional endpoints including busy", "[audio_recovery]") {
    using Policy=AudioRecoveryPolicy;
    REQUIRE((Policy::Presence({{"hw:Other",true,true}},"hw:Chosen","hw:Chosen")==std::pair{false,false}));
    REQUIRE((Policy::Presence({{"hw:Chosen",false,true}},"hw:Chosen","hw:Chosen")==std::pair{false,true}));
    REQUIRE((Policy::Presence({{"hw:Chosen",true,false}},"hw:Chosen","hw:Chosen")==std::pair{true,false}));
    REQUIRE((Policy::Presence({{"hw:Input",false,false,true,false},{"hw:Output",false,false,false,true}},"hw:Input","hw:Output")==std::pair{true,true}));
    REQUIRE((Policy::Presence({{"hw:Input",true,true}},"hw:Input","hw:Output")==std::pair{true,false}));
}

TEST_CASE("Configured audio recovery bounds stable attachment attempts and preserves budget on fallback", "[audio_recovery]") {
    AudioRecoveryPolicy policy; policy.Start();auto generation=policy.Generation();auto now=AudioRecoveryPolicy::Clock::time_point{};
    REQUIRE(policy.Observe(generation,true,true,now)==AudioRecoveryPolicy::Action::Attempt);
    REQUIRE_FALSE(policy.Start()); REQUIRE(policy.Generation()==generation);
    REQUIRE(policy.Observe(generation,true,true,now+29s)==AudioRecoveryPolicy::Action::Wait);
    REQUIRE(policy.Observe(generation,true,true,now+30s)==AudioRecoveryPolicy::Action::Attempt);
    REQUIRE(policy.Observe(generation,true,true,now+60s)==AudioRecoveryPolicy::Action::Attempt);
    REQUIRE(policy.Observe(generation,true,true,now+24h)==AudioRecoveryPolicy::Action::Wait);
    REQUIRE(policy.Attempts()==3);
    REQUIRE(policy.Observe(generation,false,true,now+25h)==AudioRecoveryPolicy::Action::Wait);
    REQUIRE(policy.Observe(generation,true,true,now+26h)==AudioRecoveryPolicy::Action::Wait);
    REQUIRE(policy.Observe(generation,false,false,now+27h)==AudioRecoveryPolicy::Action::Wait);
    REQUIRE(policy.Observe(generation,true,false,now+28h)==AudioRecoveryPolicy::Action::Wait);
    REQUIRE(policy.Observe(generation,true,true,now+29h)==AudioRecoveryPolicy::Action::Attempt);
    REQUIRE(policy.Attempts()==1);
}

TEST_CASE("Configured audio recovery cancellation rejects obsolete callbacks", "[audio_recovery]") {
    AudioRecoveryPolicy policy; policy.Start();auto old=policy.Generation();policy.Cancel();
    REQUIRE_FALSE(policy.Active()); REQUIRE_FALSE(policy.IsCurrent(old));
    REQUIRE(policy.Observe(old,true,true,AudioRecoveryPolicy::Clock::now())==AudioRecoveryPolicy::Action::Wait);
    REQUIRE(policy.Start());auto current=policy.Generation();REQUIRE(current!=old);
    REQUIRE(policy.Observe(old,true,true,AudioRecoveryPolicy::Clock::now())==AudioRecoveryPolicy::Action::Wait);
    REQUIRE(policy.Attempts()==0);
    REQUIRE(policy.Observe(current,true,true,AudioRecoveryPolicy::Clock::now())==AudioRecoveryPolicy::Action::Attempt);
}
