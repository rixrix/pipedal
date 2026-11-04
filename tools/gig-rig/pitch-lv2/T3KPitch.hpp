// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
#pragma once
#include <lv2/core/lv2.h>
#include <cstdint>

/** Independent, ordinary-port pitch effect; no T3K full-state/import identity.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-27] [DES-PITCH-LV2] [7.35]
 */
namespace t3k_pitch {
inline constexpr const char* MonoUri = "https://github.com/rixrix/pipedal/plugins/t3k-pitch#mono";
inline constexpr const char* StereoUri = "https://github.com/rixrix/pipedal/plugins/t3k-pitch#stereo";
enum Port : uint32_t { Enabled, Semitones, Step, Tonality, Window, Latency, InputMode, InputL, OutputL, InputR, OutputR, PortCount };
inline constexpr uint32_t FallbackBlock = 4096, MaximumBlock = 65536;
}
LV2_SYMBOL_EXPORT const LV2_Descriptor* lv2_descriptor(uint32_t index);
