// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
#pragma once
#include <chrono>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace pipedal {
struct AudioRecoveryEndpoint {
    std::string id;
    bool capture = false, playback = false, captureBusy = false, playbackBusy = false;
};

/** Sparse observation with bounded opens per physical attachment episode.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-USB] [7.9]
 */
class AudioRecoveryPolicy {
public:
    using Clock = std::chrono::steady_clock;
    enum class Action { Wait, Attempt };
    bool Start() {
        if (active_) return false;
        active_ = true; attempts_ = probe_ = 0; lastAttempt_ = {}; ++generation_;
        return true;
    }
    void Cancel() { active_ = false; ++generation_; }
    bool IsCurrent(uint64_t generation) const { return active_ && generation == generation_; }
    bool Active() const { return active_; }
    uint64_t Generation() const { return generation_; }
    unsigned Attempts() const { return attempts_; }
    std::chrono::seconds NextDelay() {
        constexpr unsigned delays[] = {2, 4, 8, 15, 30};
        auto result = std::chrono::seconds(delays[probe_]);
        if (probe_ < 4) ++probe_;
        return result;
    }
    Action Observe(uint64_t generation, bool inputPresent, bool outputPresent, Clock::time_point now) {
        if (!IsCurrent(generation)) return Action::Wait;
        // Partial disappearance cannot replenish a stable attachment's budget.
        if (!inputPresent && !outputPresent) { attempts_ = 0; lastAttempt_ = {}; return Action::Wait; }
        if (!inputPresent || !outputPresent || attempts_ >= 3) return Action::Wait;
        if (attempts_ != 0 && now - lastAttempt_ < std::chrono::seconds(30)) return Action::Wait;
        ++attempts_; lastAttempt_ = now;
        return Action::Attempt;
    }
    static std::pair<bool,bool> Presence(const std::vector<AudioRecoveryEndpoint>& endpoints,
                                        const std::string& input, const std::string& output) {
        bool in = false, out = false;
        for (const auto& endpoint : endpoints) {
            if (endpoint.id == input && (endpoint.capture || endpoint.captureBusy)) in = true;
            if (endpoint.id == output && (endpoint.playback || endpoint.playbackBusy)) out = true;
        }
        return {in,out};
    }
private:
    bool active_ = false;
    uint64_t generation_ = 0;
    unsigned attempts_ = 0, probe_ = 0;
    Clock::time_point lastAttempt_{};
};
}
