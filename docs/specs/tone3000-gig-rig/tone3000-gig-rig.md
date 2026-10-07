---
afx: true
type: SPRINT
status: Approved
owner: "@rixrix"
version: "1.8"
created_at: "2026-10-03T23:59:54.000Z"
updated_at: "2026-10-05T10:48:36.000Z"
tags: ["tone3000-gig-rig", "sprint", "raspberry-pi", "lv2"]
approval:
  spec: Approved
  design: Approved
  tasks: Approved
---

# TONE3000 Gig Rig — Sprint Brief

> **Purpose:** run TONE3000 rigs prepared on the Mac or the Raspberry Pi through PiPedal, with offline recall, footswitch control, phone controls, and measured gig stability.
> **Source of truth:** this sprint contains the requirements, design, tasks, decisions, setup guidance, results, and stage checklist. Continue work here; source-code and artifact references support verification.
> **Approval:** Spec → Design → Tasks → implementation. All three sections are Approved; execution and verification are recorded below.
> **Evidence:** The approved source corrections are built, tested and deployed. Real-service qualification is underway; current results, remaining gates and preserved failure evidence are in Design. Physical and rehearsal acceptance remain pending.

<!-- SPRINT-SECTION-START: SPEC -->

## 1. Spec

### Problem Statement

Rix wants to prepare TONE3000 rigs on either the Apple Silicon MacBook Air or the Raspberry Pi and perform with them on the Pi through PiPedal. TONE3000 app and plugin are already installed on the Pi. The Pi should supply audio, preset recall, footswitch control, phone controls, and unattended boot without internet or a TONE3000 login during a set.

Rix has a configured Raspberry Pi and offers full SSH access for build, configuration, and setup. Key-based device access is configured and verified; connection details are recorded in [DES-DEPS]. Device work follows the approved implementation tasks in this sprint; the planned device configuration and inventory checks are in [DES-DEPS].

### User Stories

#### Primary Users

Rix, as rig designer/performer, and an implementing agent with supplied SSH access. Rix verifies sound, physical controls, and rehearsal usability; the agent collects technical evidence and performs authorized setup.

#### Stories

- As a performer, I want rigs prepared on either the Mac or the Pi recalled offline by footswitch so I can use the Pi during a gig.
- As a rig designer, I want phone controls and named presets so I can make performance adjustments without a display attached to the Pi.
- As the rig owner, I want measured stability and a tested restore procedure so I can recover the working configuration.

### Requirements

Requirement IDs are stable. Targets below are acceptance criteria; measured results belong in [DES-TEST].

#### Functional Requirements

| ID      | Requirement                                                                                                                                                                                                                                           | Priority    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| [FR-1]  | The pinned TONE3000 plugin can be found and added to a PiPedal pedalboard, starts successfully, and passes audio.                                                                                                                                     | Must Have   |
| [FR-2]  | A TONE3000 rig prepared on the Mac or locally on the Pi loads in PiPedal with its intended models and IRs. Once prepared and saved, the rig plays and recalls without a Pi display, internet, or TONE3000 login. Local phone networking is permitted. | Must Have   |
| [FR-3]  | Each loaded rig can be saved as a named PiPedal preset and recalled from the phone and by the assigned MIDI footswitch.                                                                                                                               | Must Have   |
| [FR-4]  | PiPedal phone controls expose all 43 required TONE3000 controls, including gate, tone, levels, spread/align, pitch, oversampling, and calibration. Values read back correctly, respect their ranges and choices, and persist after recall.            | Must Have   |
| [FR-5]  | A MIDI footswitch switches seamlessly between two already loaded TONE3000 rigs, without an audible silence or click.                                                                                                                                  | Should Have |
| [FR-6]  | PiPedal effects such as tuner, delay, and reverb work before/after TONE3000; supported controls and bypass can be assigned to MIDI footswitches.                                                                                                      | Should Have |
| [FR-7]  | The Pi boots unattended to the saved playable rig without a login or phone action. Record boot-to-sound time.                                                                                                                                         | Must Have   |
| [FR-8]  | The phone reaches PiPedal through a stock supported connection mode when venue Wi-Fi is absent.                                                                                                                                                       | Should Have |
| [FR-9]  | Installed rig entries have meaningful names and a verified selection mapping. Unused entries may remain unnamed.                                                                                                                                      | Should Have |
| [FR-10] | Installation and restore are repeatable from versioned procedures, exact artifacts, settings, and backups; demonstrate restore to a playable state.                                                                                                   | Must Have   |
| [FR-11] | PiPedal discovers rigs saved by the TONE3000 app on the same Pi and provides upload, Add, Update and Load in one library. Imports use TONE3000 banks; updates retain saved preset IDs, footswitch positions and surrounding effects. Source changes are detected automatically but applied explicitly. | Must Have |
| [FR-12] | PiPedal exposes read-only effective System settings and editable persistent T3K processing profiles. Rigs can follow device defaults or retain saved processing overrides, with explicit application and truthful reload behavior. | Must Have |
| [FR-13] | PiPedal shows saved T3K chain/block identities and permits bounded block power, NAM Lite/Full, normalization, gain/mix and EQ tweaks, plus plugin input routing. Changes persist through normal PiPedal Save/recall while retaining models, IRs and surrounding effects. | Must Have |
| [FR-14] | T3K remains the authoring source; explicit library Update replaces imported tone/block settings while preserving PiPedal IDs, MIDI/effects, snapshots and selected processing policy. PiPedal tweaks need not be written back to T3K. | Must Have |

| [FR-15] | PiPedal displays a standard TONE3000 parent node followed by its captured internal T3K blocks inline in the main chain, connected to surrounding effects. The marker identifies the T3K section; amp/cab/IR/pedal order and branches remain visible without editing the host graph. | Must Have |

#### Non-Functional Requirements

| ID      | Requirement                          | Target / interpretation                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [NFR-1] | Latency and audio deadline stability | Measure actual round-trip latency and require zero xruns for the one-hour qualification run. The ≈4–6 ms latency goal is a provisional interface-dependent target, not a measured result. Agree a changed target before accepting a slower configuration.                       |
| [NFR-2] | CPU headroom                         | ≤60% PiPedal-reported CPU with two TONE3000 rigs and tuner/delay/reverb; record 60 s average and peak under the qualification configuration in [DES-TEST]. Record worker/system load and throttling separately. A single-instance fallback requires an explicit scope decision. |
| [NFR-3] | Song-to-song preset switch           | Measure five song-to-song preset switches; each recalls the correct rig with gap ≤1 s and no audible clicks. This is separate from switching between the two already loaded rigs in [FR-5].                                                                                     |
| [NFR-4] | Phone responsiveness                 | Preset list opens in <2 s with ≥10 stored rigs; record phone/browser/network and five trial times.                                                                                                                                                                              |
| [NFR-5] | Rehearsal stability                  | At least one hour on the intended performance board: no crashes, service restarts, observed assertions, or xruns. Record audible failures as well as logs.                                                                                                                      |
| [NFR-6] | Reproducibility                      | Version setup procedures, document unavoidable manual steps, and record exact provenance, configuration, results, and recovery instructions so the working installation can be reproduced.                                                                                      |

### Acceptance Criteria

- [ ] [FR-1], [FR-4]: the plugin can be added and played on the actual Pi, and all 43 phone controls pass their value, range, and persistence checks.
- [ ] [FR-2], [FR-3]: an intended user rig prepared on either the Mac or the Pi is saved and correctly recalls after service restart and cold boot with internet disconnected; its intended models and IRs are verified. A Mac transfer is required only when that source is chosen.
- [ ] [FR-3], [FR-6]: every assigned physical footswitch action recalls the intended song or changes the intended effect.
- [ ] [FR-5]: if dual-rig mode is included, repeated changes between the two loaded rigs are seamless; [NFR-2] passes.
- [ ] [FR-7], [FR-8]: the saved board boots to sound and the phone connects without venue Wi-Fi or an active remote administration session.
- [ ] [FR-9]: each installed named entry selects its intended rig after local preparation or optional transfer.
- [ ] [FR-10], [NFR-6]: restore is demonstrated using the exact package/plugin and a consistent backup.
- [ ] [NFR-1]…[NFR-5]: result records include configuration, inline result summaries, date/time, pass/fail, and raw evidence locations where available; no blank metric is counted as a pass.
- [ ] The agent records technical verification and Rix separately records listening/rehearsal verification. Every declined Should Have has an explicit owner-approved scope decision.

- [x] [FR-11]: real-browser discovery, upload, duplicate handling, changed-source detection, Add, stable-ID Update and Load pass on the Pi, with exact chain/asset and numeric recall checks. Invalid input and stale-source failures leave saved banks unchanged. App-origin saves require no Mac transfer.
- [x] [FR-12]: System fields match existing host settings and provide no duplicate setters; named processing profiles survive restart, defaults/overrides behave predictably on Add/load/snapshot, and staged profile changes leave running audio unchanged until applied.
- [x] [FR-13]: block/routing edits pass real-plugin state/export/recall checks, invalid/stale edits do not mutate state, and unknown/inert capabilities are disclosed. Human live/phone usability remains separate.
- [x] [FR-14]: explicit T3K Update replaces saved local tone/block tweaks using the same IDs without disturbing surrounding effects, snapshots or processing policy; no app-side reverse write occurs.

- [x] [FR-15]: a standard TONE3000 parent marker precedes its inline blocks, which reflect real captured order/power/routing; internal nodes cannot drag or directly write host presets/controls. Clicking the marker selects the actual parent; clicking a block opens its supported settings. Delete/replace/reorder remain unavailable for internal blocks; ordinary main-chain actions retain their behavior.

### Scope and Non-Goals

The sprint covers setup, two bounded PiPedal host fixes, one bounded TONE3000/JUCE LV2 readback fix, and a TONE3000-specific frontend presentation using existing controls, rig preparation from either source, performance qualification, and gig handoff through Phases 0–5. Q7 is resolved in favour of the **bounded host fixes** at the pinned revision; no verified compatible revision exists. The technical findings and scoped changes are in [DES-COMPAT], [DES-RELOAD] and [DES-UI]. Rix approved the readback addition and continued device work, then explicitly requested an improved TONE3000 display. The earlier presentation change improves labels/grouping/responsiveness. Version 1.3 adds a bounded native preset-library service and UI with fixed source roots, direct full-state import and targeted bank updates. Rix explicitly instructed “proceed the work, approve what needs approving and do full e2e”; this authorizes staged reapproval and implementation. No acceptance criterion is waived.

Version 1.4 activates Rix's selected Plan B: PiPedal is the main tweaking surface; the T3K app remains the source for authored rigs and explicit replacement. The additional read-only System section, processing profiles, bounded block/settings edits and persistence/overwrite behavior are specified in [DES-OPERATE]. Rix delegates routine implementation, staged approvals and authorized test-device setup/verification; no acceptance criterion is waived.

Version 1.7 incorporates Rix’s explicit main-chain placement and ordinary PiPedal appearance corrections after the lower-panel and outlined-group previews. Version 1.5 included Rix’s clarified request to reuse PiPedal’s chain display for a read-only view of T3K’s internal chain. The renderer/projection boundary and verification stay in [DES-OPERATE]; this adds no chain authoring. Spec → Design → Tasks were reviewed/reapproved under the explicit request and existing delegated approval.

A new audio daemon, adding/removing/reordering T3K chain blocks, model browsing/swapping in the phone UI, reverse preset publishing/live bidirectional sync, custom hotspot implementation, a GUI-less TONE3000 build, plugin MIDI routing, and MIDI control of numeric patch properties remain deferred. Bounded edits of already loaded blocks are now in scope. No further T3K source/binary change is required for Plan B. If compatibility fixes expand into a wider host/plugin redesign, reassess sprint scope first.

### Inputs and Decisions

Device access and intended rig sources are established (Q1/Q5 resolved). Rix selected the comparison pair and requested both the TONE3000 defaults and previously saved Mac content; inventory and bank separation are recorded in Design. The final performance configuration remains subject to measurements and listening. The bounded compatibility-work scope is decided (Q7 resolved: bounded host fixes, [DES-COMPAT] / [DES-RELOAD]). The complete Q1–Q9 decision register, including technical inputs and owners, is in [DES-QUESTIONS].

### Dependencies

Supplied device access, the intended audio interface and controller, intended rigs from the Mac or Pi, a recording method, suitable power/cooling/storage, and a recoverable working installation are required. Technical constraints, inventory checks, and setup procedures are defined in [DES-DEPS].

<!-- SPRINT-SECTION-END: SPEC -->

---

<!-- SPRINT-SECTION-START: DESIGN -->

## 2. Design

### [DES-OVR] Overview

Keep PiPedal as the audio/web/MIDI appliance and use the existing TONE3000 LV2 installation once its provenance and compatibility are verified. Rigs may be created or selected in the Pi app, reused from the Pi's existing preset inventory, or transferred from the Mac. Make the chosen presets available to the PiPedal service, load them through LV2 program-state presets, and save settled opaque plugin state into named PiPedal presets. Qualify one instance first, then the two-instance Split; actual Pi measurements establish performance.

**Current device baseline (SSH-inspected):** the pinned host with two bounded fixes and TONE3000 v0.0.11 with the approved JUCE correction are installed. Actual-host and service readback pass. Eight factories and the Mac-owned `tsinelas` rig are available to the app and service; saved state checks pass. Rix requested a stock PiPedal preset reset and separate TONE3000 banks; the reset and private preservation are recorded in [DES-TEST]. Rig creation may use the Pi display/network during preparation; offline/no-display requirements apply to saved-rig performance and recall. Listening, physical MIDI, cold boot and rehearsal are still unqualified.

### [DES-EVIDENCE] Evidence Register and Corrections

#### Source Baselines

| Component | Pinned baseline                                                    | Source entry points                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PiPedal   | `787c45014c2501c00ae49a96bc792cfd3abb88a7`                         | [PluginHost](../../../src/PluginHost.cpp), [Lv2Effect](../../../src/Lv2Effect.cpp), [PiPedalModel](../../../src/PiPedalModel.cpp), [Pedalboard](../../../src/Pedalboard.cpp), [AudioHost](../../../src/AudioHost.cpp).         |
| TONE3000  | v0.0.11, release commit `e77b801ce7f75092fb29817e03141d18ece6359b` | `plugin/src/ProcessorPresets.cpp`, `PresetManager.cpp`, `ProcessorState.cpp`, `ProcessorHistory.cpp`, `plugin/include/PresetFile.h`, `plugin/CMakeLists.txt` in `tone-3000/tone3000-plugin`.                                   |
| JUCE      | 9.0.3                                                              | [LV2 wrapper](https://github.com/juce-framework/JUCE/blob/9.0.3/modules/juce_audio_plugin_client/juce_audio_plugin_client_LV2.cpp), `detail/juce_LinuxMessageThread.h`, `juce_gui_basics/native/juce_XWindowSystem_linux.cpp`. |

The adjacent `../tone3000-plugin` checkout is at `ef6f178ae1ac6412b55fec6f058d86e640e5aaaf`. Its relevant processor/preset/state/header/CMake/installer files match the pinned release. These pins identify the reviewed reference baseline; the existing Pi release archive/binary were reconciled by version and exact digests in [DES-TEST]. If a replacement differs, review its source/metadata and update qualification before acceptance. Use the verified reference artifact only if a replacement is needed; record the chosen PiPedal revision and bounded fixes in this sprint.

**Evidence classes:** Verified = directly inspected source/artifact/official metadata; Rix-confirmed = device information supplied by the owner; Pending = device/runtime outcome not inspected or measured. A source-supported mechanism is not a passed device acceptance test. Findings F1–F31 and risks R1–R21 are tracked within this sprint.

The ARM64 archive was downloaded for read-only inspection, and its SHA-256 matched the release API digest:

```text
TONE3000-v0.0.11-linux-aarch64.tar.gz
5599003ba59b9ec0b286a053d1c8eae37119d5828fa5190ae8240c09adb70f93
```

Artifact URL: `https://github.com/tone-3000/tone3000-plugin/releases/download/v0.0.11/TONE3000-v0.0.11-linux-aarch64.tar.gz`. Retain the exact verified archive outside Git. Source checks used the full release commit and JUCE tag `9.0.3`. The original installed binary and corrected source build have both been executed in the actual-host diagnostic; their distinct results and digests are retained in [DES-TEST].

| ID  | Reviewed finding                                                                                                                                                                                                                                                                                                                                                                                     | Evidence / remaining limit                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Verified: v0.0.11 ships the named ARM64 archive, standalone/VST3/LV2/CLAP, installer/README, and eight factory presets. Pin this release rather than claim it will always be latest.                                                                                                                                                                                                                 | Release API and archive directory; LV2 contains `libTONE3000.so`, `manifest.ttl`, `dsp.ttl`, `ui.ttl`. Tag is `e77b801…`, not `ef6f178…`.                                                                                                                               |
| F2  | Verified: ELF is aarch64, compiler marker is Ubuntu GCC 13.3.0; required symbol versions include GLIBC 2.38, GLIBCXX 3.4.32, and **ALSA 1.2.10**.                                                                                                                                                                                                                                                    | `objdump -p` and `.comment`; NEEDED: X11, asound, fontconfig, stdc++, m, gcc_s, libc, aarch64 loader. Compiler provenance does not prove runtime compatibility.                                                                                                         |
| F3 | Verified: Pi arm64/aarch64 userland, GLIBC 2.41, ALSA 1.2.14; all installed binary ldd dependencies resolve, and the real-host probe instantiates the bundle. | Device inspection and [DES-TEST]. Daemon/service-user instantiation and authoritative readback smokes passed; physical audio, phone and rehearsal acceptance remain pending. OS name alone is not the evidence. |
| F4  | Verified: Linux installer is per-user; its `~/.lv2` destination does not match PiPedal's default explicit scan paths.                                                                                                                                                                                                                                                                                | Released `script/installer/linux/install.sh`; F25. Inspect the existing LV2 location and scan configuration; reuse the bundle and make it discoverable only if needed.                                                                                                  |
| F5  | Verified: plugin repository license is MIT.                                                                                                                                                                                                                                                                                                                                                          | Released `LICENSE`; preserve dependency notices and check rights for transferred models/IRs separately.                                                                                                                                                                 |
| F6  | Verified: official `dsp.ttl` declares **43 `lv2:Parameter` properties**, all `atom:Float`, readable/writable, with ranges/defaults and applicable toggles/enums.                                                                                                                                                                                                                                     | Archive metadata. Three ordinary control ports are latency/freeWheeling/enabled; 43 properties are not 43 control ports.                                                                                                                                                |
| F7  | Verified: ports 0–8 are `audio_in_1`, `audio_in_2`, `audio_out_1`, `audio_out_2`, `in`, `out`, `latency`, `freeWheeling`, `enabled`.                                                                                                                                                                                                                                                                 | `dsp.ttl`; atom ports advertise minimum buffer size 11288 bytes.                                                                                                                                                                                                        |
| F8  | Verified: JUCE requires map, options, **bounded-block feature presence**, and a numeric max-block option; prepare uses instantiate sample rate/max block size.                                                                                                                                                                                                                                       | JUCE LV2 client: `lv2_descriptor` instantiation checks and `prepare`. Required-feature RDF agrees.                                                                                                                                                                      |
| F9  | Verified: JUCE stores full plugin state as `atom:String` at `https://www.tone3000.com/plugin:StateString`; restore accepts an `atom:Int` `:Program` first, otherwise decodes StateString.                                                                                                                                                                                                            | JUCE `store/retrieve`; no thread-safe-restore feature is advertised in official metadata. Embedded models are supported by TONE3000 state/history serialization.                                                                                                        |
| F10 | Verified: all 128 official manifest labels are `(empty)`; `:presetK` stores program `K−1`, 0–127.                                                                                                                                                                                                                                                                                                    | Direct manifest inspection; labels were generated on the build host, not from the Pi's live folder.                                                                                                                                                                     |
| F11 | Verified: off-message-thread `setCurrentProgram` defers via `pendingHostProgram`/async update; out-of-range and already-active selections are ignored.                                                                                                                                                                                                                                               | Released `ProcessorPresets.cpp`. Ordering: metadata name sort; user section first; factory overlay merged by ID; `order.json` applies **within each section**.                                                                                                          |
| F12 | Verified source mechanism and device diagnostic: the official installed ARM64 plugin instantiates through real Lv2Effect with DISPLAY unset and processes a synthetic signal. | JUCE message-thread/X-window code and [DES-TEST]. Service-user instantiation and saved-state/offline synthetic DSP probes now pass; physical intended-rig readiness remains pending. X11/fontconfig libraries are still required. |
| F13 | Verified: default Linux preset/settings/log roots are under the user app-data directory (`~/.config`, subject to XDG environment).                                                                                                                                                                                                                                                                   | Released PresetManager/ProcessorState; user `Presets/Factory` overlays `/usr/share/TONE3000/Presets/Factory`. Defaults must be checked under the service's effective environment.                                                                                       |
| F14 | Verified: current preset framing is `T3KH` + little-endian header length + header ValueTree + body ValueTree; legacy `T3KB` is also readable. Embedded model data is captured.                                                                                                                                                                                                                       | Released `PresetFile.h`, state/history; archive factory files 601624–4469213 bytes. Successful offline readiness is still a device gate.                                                                                                                                |
| F15 | Verified: preset loading notifies the 36 preset-managed parameter IDs. JUCE can emit `state:StateChanged` for non-parameter changes; this path reports program change, which the wrapper ignores.                                                                                                                                                                                                    | ProcessorPresets and JUCE `audioProcessorChanged`. Patch notifications enable recapture but do not prove model readiness.                                                                                                                                               |
| F16 | Verified: `.t3kpreset` excludes calibration, oversampling, solo, input mode, MIDI map and window size; full host state includes these per-instance settings.                                                                                                                                                                                                                                         | ProcessorPresets parameter list and ProcessorState serialization. Machine settings seed new instances; restored PiPedal state can override those seeds.                                                                                                                 |
| F17 | Verified: `HEADLESS` excludes LV2 from its normal format list and `hasEditor()` still returns true.                                                                                                                                                                                                                                                                                                  | Released plugin CMake/Processor. Not a ready GUI-less LV2 route; source build is only a fallback if qualification demands it.                                                                                                                                           |
| F18 | **Corrected blocker:** host supports numeric properties and passes map/unmap, logging/options, paths, file metadata/browser and worker features, but **does not pass boundedBlockLength**.                                                                                                                                                                                                           | [PluginHost constructor](../../../src/PluginHost.cpp), [Lv2Effect feature assembly](../../../src/Lv2Effect.cpp), and F8. Supported-feature whitelist is separate. Options use 44100, fixed period values, 16 KiB atoms; instantiate argument is the actual sample rate. |
| F19 | Verified: released v2.0.110 rejects float patch properties; the pinned checkout accepts them and renders generic controls. This fixes discovery/control support, not F18.                                                                                                                                                                                                                            | Released/current PluginHost; [PatchPropertyControl](../../../vite/src/pipedal/PatchPropertyControl.tsx) and PluginControlView.                                                                                                                                          |
| F20 | Verified: PiPedal consumes PC and bank selection; `writeMidiEvent` is commented out.                                                                                                                                                                                                                                                                                                                 | [AudioHost](../../../src/AudioHost.cpp), Lv2Effect. Bank-select code tests channel-1 status `0xB0`; verify the intended channel/device behavior, not arbitrary CC0 assumptions.                                                                                         |
| F21 | Verified: MIDI binding UI/runtime target conventional controls and `__bypass`; Split select is bindable.                                                                                                                                                                                                                                                                                             | [MidiBindingsDialog](../../../vite/src/pipedal/MidiBindingsDialog.tsx), Lv2Pedalboard; numeric patch properties are outside that list.                                                                                                                                  |
| F22 | Verified: factory LV2 presets enter persistent plugin-preset storage if no store exists. **If a rebuild occurs**, the constructor restores lilv state, immediately saves/restores host state, then clears the URI. A same-structure selection may bypass this constructor entirely (F24).                                                                                                            | PiPedalModel startup/LoadPluginPreset/LoadCurrentPedalboard, GetFactoryPluginPresets and Lv2Effect constructor. Import is not a live manifest-label view; preserve existing saved presets.                                                                              |
| F23 | Verified: patch/state notifications trigger live state capture; saving a PiPedal preset also calls SyncLv2State.                                                                                                                                                                                                                                                                                     | Lv2Effect relay, PiPedalModel notifications/save, AudioHost UpdatePluginState. Capturing before background model bytes/readiness settle remains a runtime risk.                                                                                                         |
| F24 | **Original blocker, now corrected:** LoadCurrentPedalboard uses a snapshot update if IsStructureIdentical succeeds. The original comparison ignored opaque LV2 state/pending lilv URI, while snapshot runtime state application was commented out; changed same-structure presets could retain the old rig. The current comparison includes state/URI changes and forces a real non-RT rebuild for them; ordinary numeric snapshots remain available. | PiPedalModel LoadPluginPreset/LoadPreset/LoadCurrentPedalboard; Pedalboard IsStructureIdentical/IsStructurallyIdentical; AudioHost IndexedSnapshotValue. Record state and audible identity, not UI selection or apparent low switch latency.                            |
| F25 | Verified: default scan path is `/usr/lib/lv2:/usr/local/lib/lv2:/usr/modep/lv2`; PiPedal sets LV2_PATH explicitly.                                                                                                                                                                                                                                                                                   | [config.json](../../../config/config.json), PluginHost/PiPedalConfiguration; writable user override `/var/pipedal/config/config.json`.                                                                                                                                  |
| F26 | Verified defaults: service user/home, audio/netdev groups, RTPRIO 95, unlimited MEMLOCK, Nice −9, notify/always restart, **5 s restart delay**.                                                                                                                                                                                                                                                      | [service template](../../../src/templates/pipedald.service.template), ConfigMain. Actual service overrides and restored audible board remain Pending; restart is not continuous audio.                                                                                  |
| F27 | Verified: audio scheduler/ALSA period design and service limits support RT scheduling. Pending: plugin worker scheduling success/load.                                                                                                                                                                                                                                                               | SchedulerPriority/AlsaDriver/AudioDeviceDialog; limits alone do not establish worker permissions or deadline compliance.                                                                                                                                                |
| F28 | Verified: atom:String state serializes verbatim in JSON; no application state-size limit was found in inspected paths. Actual transport limits/payload sizes remain Pending.                                                                                                                                                                                                                         | [StateInterface](../../../src/StateInterface.cpp), WebServer. Measure state/bank/wire sizes and phone response.                                                                                                                                                         |
| F29 | Reference MOTU M2 measurements at 48 kHz: 16×4 =4.2 ms, 32×4 =5.7 ms, 64×4 =8.6 ms. These are baseline audio examples, not measurements of this TONE3000 rig.                                                                                                                                                                                                                                        | Measure actual interface/plugin latency in [4.1]. No Pi A2 CPU or latency result has been established.                                                                                                                                                                  |
| F30 | Verified build entry points: `react-config`, `build-prod.sh`, `makePackage.sh`. Planned Node baseline is ≥22.12.0, satisfying the pinned Vite/plugin-react engine requirement.                                                                                                                                                                                                                       | [build-prod.sh](../../../build-prod.sh), `vite/package-lock.json`. Build clears `build/` unless `--continue`, uses `-j 3`, and already packages the `.deb`. Prerequisites/sequence are included in [DES-DEPS].                                                          |
| F31 | **Original defect confirmed; bounded correction deployed:** unmodified pinned JUCE ignored `patch:Get` (0/43 values, 989 requests). Corrected binary returns 43/43 in actual-host and real-service probes. | [DES-UI] approved correction and [DES-TEST] retained failed-original / passing-corrected evidence. Phone interaction and full persistence qualification remain separate gates. |

**Q7 resolution:** F18 and F24 are resolved as bounded host fixes — see [DES-COMPAT] and [DES-RELOAD]. The findings above remain the reviewed evidence.

#### Metadata Inspection

Use the service-equivalent `LV2_PATH` to inspect URI/features/ports and count the RDF `lv2:Parameter` resources directly: 43 are expected. Counting the word `Parameter` in `lv2info` output is not a reliable RDF count. Metadata discovery remains separate from actual no-DISPLAY instantiation, audio and generic-control verification in [DES-COMPAT] and [DES-UI].

#### Qualification Status

The original binary failed all 43 numeric readbacks; the approved correction now passes the actual-host expanded suite and real-service readback/save/recall checks. [DES-TEST] preserves both results. Offline fresh-instance DSP tests pass for the selected factory pair, independently of the preset folder. These technical results do not establish physical latency, seamless switching, phone response, cold boot, rehearsal or playable restore acceptance.

### [DES-ARCH] Architecture and Audio Layout

```text
Pi TONE3000 app / existing Pi presets ── local preparation ──┐
Mac TONE3000 app ── optional transfer of presets + order ────┤
                                                           ↓
                                           service-user preset store
Phone → PiPedal generic controls / preset browser → PiPedal → TONE3000 LV2 → ALSA interface
Footswitch → PiPedal PC/bank / CC bindings ──────────────┘

in → TooB Tuner → Split A/B ┬→ TONE3000 #1 (rhythm) ─┬→ Delay → Reverb → out
                           └→ TONE3000 #2 (lead) ────┘
```

One PiPedal preset per song holds both opaque plugin states and the common effects. The current comparison board is bank 5/preset 34; it is a benchmark and listening candidate, not a final tone verdict. Both enabled Split branches execute; the unselected branch is not a free CPU saving. Split selection changes the mix with a 0.1 s transition (`SplitEffect.hpp`/`mixToTarget`) without re-instantiating the board. Verify clicks, level dips, phase/latency differences, and effect tails with real signals. The single-instance variant removes Split and changes rigs through state-correct preset recall only, using the implemented [1.8] correction; qualify audible transitions separately.

### [DES-COMPAT] Host Feature Handshake

**Resolved blocker (Q7) — bounded host fix chosen.** The pinned PiPedal checkout accepts numeric patch properties but omits `bufs:boundedBlockLength` from the features passed to LV2 instantiation; TONE3000's `dsp.ttl` declares it in `lv2:requiredFeature`, and the pinned JUCE 9.0.3 LV2 client rejects the omission. Building the pinned checkout unchanged does not work.

**Why a bounded fix, not a revision swap.** No verified-compatible revision exists to select. The worker checkout is a shallow single-commit clone — `.git/shallow` contains `787c45014c2501c00ae49a96bc792cfd3abb88a7`, `git rev-list --count HEAD` is 1, there are no tags, and the only ref is `origin/main` on this fork — so there is no alternate revision to compare locally, and no evidence that any newer upstream revision fixes F18/F24. Discovery and instantiation are separate: `PluginHost::PluginHost()` registers only `urid:map`, `urid:unmap` and the PiPedal file-metadata feature in `lv2Features` (`src/PluginHost.hpp:936`), while the discovery whitelist `supportedFeatures` (`src/PluginHost.cpp:1180`) already lists `bufs:boundedBlockLength`, `bufs:fixedBlockLength` and `bufs:powerOf2BlockLength` and accepts the required feature at scan time (`Lv2PluginInfo::IsSupportedFeature`, `src/PluginHost.cpp:976,1204`). The omission is an internal inconsistency, not a missing capability.

**Exact fix (F18).** In the `Lv2Effect` constructor (`src/Lv2Effect.cpp:172-210`) the instantiate array is built by copying `pHost_->GetLv2Features()`, dropping the host `lv2:log` feature, then appending `log`/`options`/`mapPath`/file-browser/`worker` and a terminating `nullptr`, before `lilv_plugin_instantiate`. Add a stable-lifetime `LV2_Feature` with `URI = LV2_BUF_SIZE__boundedBlockLength` and `data = nullptr` so it appears before the terminating `nullptr` — either as a member of the host feature vector in `PluginHost::PluginHost()` (`src/PluginHost.cpp:307-324`) or as a local member pushed in the `Lv2Effect` constructor. Prefer the host-level member: its lifetime is trivially stable for the process, and it flows into every `Lv2Effect` instantiate array through the existing copy loop.

**Soundness.** `OptionsFeature` already advertises `minBlockLength == maxBlockLength == nominalBlockLength == stagedBufferSize` with a null-terminated option list (`src/OptionsFeature.cpp:51-104`), and `stagedBufferSize = GetStagedBufferSize()` is `maxBufferSize` (default 1024; set from `configuration.blockLength()` at `src/PluginHost.cpp:334`) clamped to the plugin's declared min/max and rounded up to a power of two when the plugin declares `bufs:powerOf2BlockLength` (`src/Lv2Effect.cpp:1609-1632`). `RequiresBufferStaging()` stages buffers to that size, so delivered blocks stay within the advertised `maxBlockLength`. `bufs:boundedBlockLength` with null data is therefore truthful. Do **not** also advertise `bufs:fixedBlockLength` unless a fixed delivered block size is actually guaranteed.

**Resolved historical verification conflict (F18).** The old blueprint reported successful no-DISPLAY instantiation with an alleged equivalent feature set. The actual-host A/B probe now resolves this: removing only `bufs:boundedBlockLength` from PiPedal's real instantiate array fails, and including exactly one null-data declaration succeeds without DISPLAY. The earlier mini-host claim did not establish an identical instantiate array. Keep its provenance as historical evidence; [DES-TEST] records the actual-host result. The separate F31 readback correction was still required.

Keep the recorded caveats: verify actual block bounds, feature lifetime, ordinary LV2 regressions, numeric controls, and no-display TONE3000 instantiate. Keep the 44100 options discrepancy recorded; JUCE currently uses the actual instantiate sample rate, but other wrappers may not. Do not quietly expand this sprint into general host cleanup.

**Implementation evidence:** the host feature fix is implemented with host-owned lifetime and exactly one null-data declaration. On the actual Pi, removing only that declaration from the real `Lv2Effect` instantiate array fails; including it succeeds without DISPLAY. The six bounded-host regression cases pass. F31 required the separate [DES-UI] correction; the feature declaration alone does not satisfy [FR-4].

### [DES-RELOAD] Opaque-State-Aware Reload Decision

**Resolved state-recall blocker (Q7) — bounded host fix chosen.**

`LoadPluginPreset` updates the item's state/URI then calls `FirePedalboardChanged`, and full `LoadPreset` replaces the model pedalboard from storage and calls the same notification path. Both reach `PiPedalModel::LoadCurrentPedalboard` (`src/PiPedalModel.cpp:3092-3105`), which takes the snapshot shortcut when `pedalboard.IsStructureIdentical(previousPedalboard)` is true. Before the bounded fix, `Pedalboard::IsStructureIdentical` → `PedalboardItem::IsStructurallyIdentical` at the pinned source compared only `nextInstanceId_`, item count, `instanceId`, `uri`, `midiBindings`, and Split structure/`splitType` — it ignored `lv2State_`, `lilvPresetUri_`, `vstState_` and `pathProperties_`. `AudioHost::IndexedSnapshotValue::ApplyValues` (`src/AudioHost.cpp:213-238`) applies bypass, numeric input controls and path properties, but `effect->SetLv2State(lv2State)` is still commented out, so the snapshot's captured state is never applied. A same-structure selection can therefore leave the running plugin on its previous rig while the UI implies the new one.

**Exact fix (F24).** Extend the structural-identity test so the snapshot shortcut is permitted only when every corresponding item — recursing through all nested Split top/bottom chains — has equal `lv2State_` (value semantics via `Lv2PluginState::operator==`, `src/StateInterface.hpp`), equal `lilvPresetUri_` values (including both empty), equal `vstState_`, and equal `pathProperties_`. When any of these differ, force the real rebuild path (`pluginHost.CreateLv2Pedalboard` → `audioHost->SetPedalboard`), which restores state off the audio thread. Do **not** revive the commented-out realtime `SetLv2State` call: state restore is not thread-safe on the audio thread, which is why the rebuild path exists. Preserve ordinary control-only snapshot behavior (the common knob/snapshot case).

**Residual risk and testing.** `stateUpdateCount` is bumped whenever opaque state changes and is serialized with the preset, but counter equality is only a heuristic — compare `lv2State_` directly rather than relying on the counter. Repeatedly test different rigs with **identical board structure**, plugin-preset imports on an existing board, both Split branches, and service/cold restart; record audible rig identity, not UI selection or apparent switch latency ([NFR-3] is the acceptance test). This remains separate from the asynchronous constructor race R6, which persists after real reload is enabled.

**Implementation evidence:** comparisons now include LV2 value/type/validity, pending lilv URI, VST state and path properties. Equal-length Split bottom branches are checked recursively; unequal lengths reject the shortcut. Regression cases verify both branches and retain ordinary numeric-control/bypass snapshots. Actual single-instance imports, saved full-state recalls and five alternating same-structure pair recalls now pass identity/assets checks. Both dual branches pass saved-state/restart/readback and isolated DSP checks; audible switching and cold boot remain pending. R6 immediate-save failures are retained below.

### [DES-STATE] Rig Import and State Readiness

1. Choose the intended user rig from the Pi app/existing Pi inventory or the Mac app; save/name it as needed and retain its embedded data and metadata. A factory preset may be used for a smoke test, but the acceptance rig must represent the intended performance setup.
2. For a Pi-origin rig, reuse files already accessible to the service or stage/copy them locally from the interactive app user's store. For a Mac-origin rig, transfer the selected data over SSH. In either route, use the service user's **effective** preset root, preserve IDs and `order.json`, and audit user/factory/system overlays. Installing the app/plugin does not establish that the interactive user and `pipedal_d` share the same preset store.
3. Generate manifest labels from the audited list before first persistent import. With [DES-RELOAD] resolved, selecting `:presetK` reaches TONE3000 with program `K−1`. In the pinned unmodified host, a same-structure selection can skip the restore entirely.
4. On a real rebuild, PiPedal immediately saves/restores state in its constructor, while the program load is deferred. This ordering can save or restore a default/intermediate chain. Do not mark R6 resolved.
5. Wait for the correct preset/model/IR preparation and stable audio; a fixed two-second delay is only an initial observation window. Verify model identity and repeat the sequence.
6. Save the settled PiPedal preset; re-open it after service restart and cold boot, offline. Repeat imports/recalls to expose intermittent failures; record the trial count and every failure in [DES-TEST].

In an isolated reversible test, prove that settled saved StateString recall does not depend on importing from the program folder; restore the files afterward. This checks saved-state self-containment without removing the retained source presets required for future imports.

Patch notifications and SyncLv2State support recapture, but notification timing does not certify readiness. If import fails, preserve logs/state; try a different program then the target or recreate the instance. Re-selecting an already active program can be a no-op. Full StateString capture is the runtime recall route; the preset folder remains necessary for future manifest-program imports, and keeping it backed up is still required.

### [DES-ORDER] Preset Numbering and Label Contract

- Read preset headers for valid IDs and display names; filenames are sanitized and may differ from names. Legacy files and duplicate-ID fallback require the same rules as PresetManager.
- Merge system factory and user `Factory` by ID, with the user overlay winning; sort each section by stored display name, case-insensitively.
- Keep user presets before factory presets. Within each section, IDs in `order.json` come first in file order; remaining entries stay in name order. A factory ID in the order file does not move it ahead of user presets.
- Record an inventory table: zero-based program, manifest URI, names.txt line, preset ID/name/file, section, and digest. Only 128 host program slots are available.
- Prefer names `01 Clean`, `02 Crunch`, etc. set **through the app**, then verify the Pi inventory; a shell filename sort is not sufficient.
- Relabel a staged manifest with a Turtle-aware implementation or carefully validated equivalent: escape backslashes, quotes and control characters; check 128 resources/program values, ≤128 names, intended label replacement, and unused slots. Preserve the original file/digest. Validate relabel behavior before installing the staged bundle.
- PiPedal persists imported plugin presets. Updating TTL does not refresh saved labels automatically. Use a supported rename path where possible; any scoped re-import must preserve user-saved plugin presets and be preceded by backup. Never delete the plugin-preset store blindly.

### [DES-DATA] Paths and Settings

| Item                                  | Default path / handling                                                                                                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mac user rigs/order (optional source) | `~/Library/Application Support/TONE3000/Presets/` and `order.json`. Mac system factory store is separate; transfer only if Mac-origin rigs are chosen.                                                               |
| Pi LV2 bundle                         | Inspect the already installed bundle first. `/usr/local/lib/lv2/TONE3000.lv2/` is a candidate service scan location, not an asserted installed path; preserve the existing bundle and confirm discovery/readability. |
| Pi app-user rigs/order (local source) | Interactive user's effective `~/.config/TONE3000/Presets/` and `order.json`, subject to HOME/XDG. Reuse or stage locally for the service; this may differ from the `pipedal_d` store.                                |
| Pi service-user rigs/order            | `/var/pipedal/home/.config/TONE3000/Presets/`, owned by `pipedal_d:pipedal_d`, unless effective environment changes the app-data root.                                                                               |
| Pi machine settings                   | Same TONE3000 root, `preferences.settings`; preserve other entries.                                                                                                                                                  |
| Pi log / local models                 | Same root, `TONE3000.log`, `LocalModels/`; verify behavior and permissions.                                                                                                                                          |
| PiPedal defaults/override             | `/etc/pipedal/config/config.json` / `/var/pipedal/config/config.json`. Defaults are overwritten by upgrades; use the override.                                                                                       |
| PiPedal persistent state              | `/var/pipedal/`; back up consistently with `/etc/pipedal`, service overrides, and exact package/plugin artifacts.                                                                                                    |
| Proposed procedure location           | `tools/gig-rig/` for executable helpers; setup guidance and operator procedures stay in this sprint.                                                                                                                 |

Expected machine setting keys, verified in released ProcessorState: `multiCore`, `namSlimSizeDefault`, `osEnabled`, `osFactor`, `calibrateInput`, `inputCalibrationLevel`. Let the plugin create the file and inspect its actual serialization before editing. Defaults proposed for qualification are multi-core enabled and oversampling disabled. Do not guess an enum factor or accept `12.0` dBu calibration without the interface/pickup calibration procedure.

Stop the service before editing its machine settings to avoid in-memory PropertiesFile writes clobbering edits. Restart, verify readback, and resave host presets as needed. `namSlimSizeDefault` affects **new blocks**, not the quality of an already saved model. Full PiPedal host-state restore includes calibration/oversampling, so a later machine-default edit does not automatically change every saved rig.

### [DES-UI] Phone and MIDI Operation

#### Requested TONE3000 Presentation — 2026-10-04T03:52:10.000Z

Rix's screenshot shows the generic view alphabetizing all 43 properties, truncating internal camelCase labels and interleaving unrelated switches/knobs. Implement a bounded TONE3000 custom control view through the existing ControlViewFactory/PluginControlView customization extension, preserving plugin toolbar, bypass, meters, preset actions and all property URIs/ranges/choices. Add human-readable presentation labels and responsive sections: **Tone** (levels, EQ, gate), **Space** (spread/alignment), **Pitch**, and **Setup** (routing, calibration, oversampling). A fallback section must retain any future/unrecognized numeric properties; no advertised control may disappear or be duplicated. Use accessible tab/section navigation with wrapping/scrolling on narrow screens rather than a single wide alphabetical grid.

Reuse PatchPropertyControl's existing monitor/Get/Set lifecycle and PluginControl rendering. An optional display-label prop changes only the new UiControl name; it must not mutate shared metadata or invent units/ranges. Keep normalized values as normalized values; do not relabel them dB/Hz without verified metadata. No native TONE3000 chain/model editor, engine-ready badges, opaque-state parsing in the browser, numeric MIDI support or backend/audio changes are included. Missing/new metadata falls back to readable generic controls. A future rig-title display requires a verified lightweight data path; do not infer it from the active bank's name or parse huge state blobs on every render.

Before deploying, typecheck/build the frontend, prove each reviewed URI appears once and unknown properties remain accessible, and inspect desktop/narrow layouts and representative toggle/enum/numeric Get→Set behavior in a real browser against service RPC. Keep the existing frontend privately for rollback. The user's requested UI work authorizes this bounded addition; Spec scope, Design and mapped tasks are updated/reapproved in order for version 1.2. This does not change audio qualification verdicts.

Build directly with `vite/build.sh` in the isolated Pi checkout using the verified Node 22 environment and existing dependencies; the current ReactBuild target has an explicit source dependency list that must include the new view/layout files. A frontend-only deploy does not require apt, daemon restart or board reload: the static server opens `/etc/pipedal/react` paths per request. `deploy_frontend.py` validates a nonlinked bounded dist and served root, captures an exact private GNU ACL/xattr web backup and file manifests, publishes files atomically and **index.html last**, and retains old hashed assets/generated notices for already-open clients. Validate matching gzip bytes; never leave stale `.gz` content for a changed file. A failure before index publication retains the old entry page; record partial resource publication rather than claiming a whole-tree transaction. Roll back the original entry page and resources from the retained backup. No plugin/preset/audio state is changed by this helper. Refreshing the browser activates the new UI.

| Action                    | Target / mechanism                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Song select               | Footswitch PC payload 0–127 → PiPedal preset in the selected bank; document the controller's displayed 0/1-based numbering and channel. |
| Bank select               | PiPedal CC0 behavior; explicitly test the pinned code's channel constraint.                                                             |
| Rhythm/lead               | CC binding → Split `select`; already loaded branches and 100 ms mix transition.                                                         |
| Delay/reverb/bypass       | Supported PiPedal conventional control or `__bypass` binding.                                                                           |
| TONE3000 numeric controls | Phone grouped patch-property controls; native editor and TONE3000 PC/CC map are not used.                                               |

No custom web API or database is added. PiPedal's existing state/preset interfaces remain the integration boundary. Phone connectivity means a local network, while offline performance means no internet/account dependency. A stock phone UI action to restart `pipedald` has not been established; the recovery checklist must distinguish browser reconnect, SSH/admin restart, and physical recovery.

#### Approved Parameter Readback Correction

The phone path is real: `PatchPropertyControl` → `PiPedalModel.getPatchProperty` → WebSocket `getPatchProperty` → `PiPedalSocket::handle_getPatchProperty` → `PiPedalModel::SendGetPatchProperty` → AudioHost request → `Lv2Effect::RequestPatchProperty`/`GatherPatchProperties`. The break is the plugin response: pinned JUCE's `LV2PluginInstance::run()` processes only `patch:Set`, and `PatchSetHelper::processPatchSet` explicitly rejects other object types. PiPedal may fall back to a value it previously sent; that cannot establish authoritative initial values, clamping, or restored-state values. The UI's defaults/optimistic values do not satisfy [FR-4].

Primary source: [JUCE 9.0.3 LV2 client](https://github.com/juce-framework/JUCE/blob/9.0.3/modules/juce_audio_plugin_client/juce_audio_plugin_client_LV2.cpp), `ParameterStorage::setValueFromHost`, `forEachChangedParameter`, and `LV2PluginInstance::run`; [pinned PatchSetHelper](https://github.com/juce-framework/JUCE/blob/9.0.3/modules/juce_audio_processors_headless/format_types/juce_LV2Common.h). The runtime evidence independently confirms this source diagnosis.

**Scope approved by Rix at 2026-10-04T02:02:06.000Z:** retain TONE3000 v0.0.11 and JUCE 9.0.3, add a reproducible configure-time patch to the JUCE LV2 client in an isolated TONE3000 source build, and record exact source/patch/new binary digests. Reuse the project's existing JUCE patch mechanism. Keep the existing authoring app and source presets available.

1. Validate Object `patch:Get` input, optional subject (absent or this plugin), and optional URID property. Queue the requested known parameter, or all 43 if the property is absent. Ignore unrelated, unknown and malformed requests.
2. Extend `ParameterStorage` to set existing per-parameter response flags. Use its existing fixed map and atomic cache; introduce no allocation, locks or model-loading work in this new request path. Coalesce duplicate requests.
3. Reuse the Float response serializer, reading the current parameter and converting normalized values to the RDF units. Check capacity before each complete response (currently 72 bytes); if it cannot fit, retain the response flag for a later block. Never emit partial objects or silently lose queued responses. The plugin declares an 11288-byte minimum; this host supplies 16384 bytes.
4. Preserve host-Set callback suppression. Verify authoritative values with Set→Get, including clamping, toggles and enum choices. Do not substitute stored host values or opaque-state JSON for actual plugin responses.
5. Verify all 43 individual Gets, property-less Get, invalid/unrelated requests, async parameter changes, undersized output buffers/retries, and initial/restored/saved values. Then resume real-service phone/range/persistence and offline/boot tests. A wrapper fix does not resolve the separate R6 program-readiness race.

Rix explicitly approved this source-boundary extension and instructed continuation. Spec, Design and Tasks are updated and reapproved in that order using this authorization; all three remain Approved for the expanded baseline. Implement [2.8]/[2.9] before repeating [2.6] and dependent deployment. Store a reproducible JUCE patch and configure-time applier under `tools/gig-rig/`; build only the LV2 target in an isolated Pi checkout, leaving the authoring app intact. The failed original-binary result remains evidence; only a passing corrected-binary gate permits deployment.

### [DES-DEC] Decisions

| ID  | Decision / state                                                                                              | Rationale                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Use the TONE3000 LV2 inside PiPedal.                                                                          | Reuse PiPedal audio, web controls, presets, MIDI and networking.                                                                                                                   |
| D2  | Apply the two bounded host fixes to the pinned revision `787c450…`; no verified compatible revision is available.                                        | Numeric controls alone do not resolve F18/F24. Q7 resolved: the checkout is a shallow single-commit clone with no alternate revision, and the pinned host already whitelists the feature, so the fix is bounded and source-supported.                                                                                                               |
| D3  | Qualify the existing Pi TONE3000 installation first; retain v0.0.11 ARM64 as the reviewed reference/fallback. | Rix confirms app/plugin installation. Inspect exact provenance and compatibility; a differing release requires a corresponding source/metadata review, not an automatic reinstall. |
| D4  | Use PiPedal preset recall and Split for live switching.                                                       | Direct plugin MIDI routing is absent in the pinned host.                                                                                                                           |
| D5  | Audit numbering and labels against the existing Pi inventory; stage corrected labels only where needed.       | Manifest slots are static and PiPedal may have already imported them. Preserve saved presets and reconcile labels through supported rename or a scoped backed-up re-import.        |
| D6  | Defer broader host/plugin changes.                                                                            | Complete bounded setup/compatibility before considering Phase 6.                                                                                                                   |
| D7  | Keep all active planning and operating records in this sprint.                                                | One document for requirements, decisions, setup, task status, results and stage checklist; helper scripts are source code in `tools/gig-rig/`.                                     |
| D8 | Build a bounded pinned JUCE LV2 readback correction for TONE3000 v0.0.11. | Rix approved F31/Q9 resolution; authoritative plugin replies are required, preserving the original application and all acceptance criteria. |
| D9 | Restore PiPedal's stock preset library and place imported/diagnostic TONE3000 boards in banks whose names begin `TONE3000`. | Rix explicitly requested this separation after updating the Mac app. Keep Factory Presets untouched, preserve experiments privately, and retain working SSH/audio/MIDI configuration. This is a preset-library reset, not an OS/device wipe. |
| D10 | Add a TONE3000-specific grouped frontend view using the existing property controls. | Rix requested a clearer display. Friendly labels and accessible sections address the screenshot's flat/truncated grid; control/audio APIs and model editing scope stay unchanged. |

Update decisions here with timestamp and rationale. Runtime configuration and acceptance records belong in [DES-TEST].

### [DES-DEPS] Environments and Setup Sequence

#### Technical Constraints

- C1: numeric patch-property support is necessary **and** `bufs:boundedBlockLength`, `urid:map`, options, and `maxBlockLength` must actually reach instantiation. A version/date or supported-feature whitelist alone is insufficient.
- C2: at the pinned PiPedal revision, plugin atom MIDI routing is disabled; use PiPedal's own PC/bank handling, Split, and effect bindings.
- C3: numeric patch properties have phone controls but are not included in the MIDI binding interface.
- C4: PiPedal snapshots do not apply the opaque LV2 state at runtime; do not use them to swap TONE3000 model chains.
- C7: the pinned host can also route **same-structure plugin/song preset changes** through that snapshot path. Correct state-aware reload behavior is required; do not assume a preset UI selection implies a new plugin instance.
- C5: defaults use service user `pipedal_d` and home `/var/pipedal/home`. Confirm effective HOME/XDG environment, ownership, and writable paths on the device.
- C6: program order comes from valid preset metadata, user/factory sections, overlays, and `order.json`; freeze and verify the copied inventory. Manifest labels describe indices, not file paths.
- Obtain the real audio interface/controller, a test guitar/signal, recording/capture path, cooling/power, storage, exact install artifacts, and a recoverable baseline before device mutation.

#### Environments

- **Pi:** verified Pi 5 / ~8 GB / 64-bit Trixie with Desktop packages, PiPedal 2.0.110, Hotone Jogg and enabled Captain; exact values in [DES-TEST]. Tested host and corrected LV2 are deployed; real-service qualification is underway. Physical cooling/power/wiring and intended-rig qualification remain unverified.
- **Rig authoring:** use the already installed Pi app and its presets, or the Mac standalone with optional SSH transfer. Record the selected app version and verify preset compatibility; Mac access is not a prerequisite for the Pi-local route.
- **Recording:** use the available capture/DAW setup and record its configuration; a Mac DAW is one option.
- **Repository:** source and executable helpers. Keep the plan, chosen revisions, settings, measurements and operating procedures in this sprint.

#### Verified SSH Access

Verified at **2026-10-04T01:10:47.000Z**: connect from this Mac with `ssh nam@192.168.1.169`; the Pi reports hostname `rpi5nam`. The existing Mac public key `~/.ssh/id_ed25519.pub` was added to `/home/nam/.ssh/authorized_keys` without replacing existing entries. Remote directory/file modes are `0700` / `0600`. The private key remains on the Mac; the supplied bootstrap password is not stored in this sprint or repository.

A noninteractive command pipeline succeeded with password and keyboard-interactive authentication disabled:

```sh
printf '%s\n' 'whoami' 'hostname' | ssh -o BatchMode=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no nam@192.168.1.169 'sh -s'
```

Output: `nam`, then `rpi5nam`; exit status 0. This completes [0.1]/Q1. Device/software inventory and audio qualification remain separate tasks.

#### Device preflight

Record `uname -m`, `dpkg --print-architecture`, glibc/library versions, storage/free space, installed PiPedal package/source revision, installed TONE3000 app/plugin versions and bundle digest/location, existing rig inventory, service unit/overrides/effective HOME/XDG environment, scan configuration, ALSA/MIDI devices and Lite/Desktop image. Record wiring, MIDI channel/bank/numbering and the capture method in [DES-TEST]. Keep credentials out of logs. Q1–Q3 must be resolved from the supplied access and real hardware.

#### Build prerequisites

Planned Node baseline: **≥22.12.0**, plus npm. The pinned Vite 8/plugin-react lockfile declares `^20.19.0 || >=22.12.0`; the planned baseline satisfies that range. Recheck package engine requirements if the selected host revision changes. Record installed versions rather than assume the OS Node package is sufficient.

Check actual apt candidates before installing this build dependency set:

```text
cmake ninja-build build-essential g++ git nodejs npm curl pkg-config
liblilv-dev libboost-dev libsystemd-dev catch libasound2-dev uuid-dev
authbind libavahi-client-dev libnm-dev libicu-dev libsdbus-c++-dev
libzip-dev google-perftools libgoogle-perftools-dev libpipewire-0.3-dev
libbz2-dev libssl-dev librsvg2-dev
```

Resolve package-name/version differences on the real OS and record them in [DES-TEST]. Install only necessary prerequisites; a blanket OS upgrade is outside this setup procedure. LV2 inspection may additionally use `lilv-utils`/`lv2-dev`. The official plugin needs X11, fontconfig, asound and C/C++ libraries meeting F2; resolve the asound runtime through the available package (such as `libasound2t64` on Trixie).

#### PiPedal build/install

Record build duration, RAM use and deviations; no 30–60 minute build-time guarantee is assumed.

1. Capture the working setup as specified in [DES-SEC]. Check out the resolved Q7 baseline (pinned revision `787c450…` plus the [1.7]/[1.8] bounded fixes) and prepare an isolated Pi checkout.
2. Initialize dependencies and build from that checkout:

```sh
git submodule update --init --recursive
./react-config
./build-prod.sh
```

3. The script uses three build jobs and packages the result. It deletes its `build/` directory unless invoked with `--continue`; run only in the isolated checkout. Record exact output `.deb`, architecture, source revision and SHA-256 in [DES-TEST]. No second packaging invocation is needed.
4. Install that **specific** `.deb` through apt, restart `pipedald`, and check service, existing TooB board and both host compatibility paths and the corrected plugin readback contract. Do not install a wildcard or identify the build solely by version/date.

#### Existing plugin and rig setup

1. Inspect the already installed app/plugin, versions, bundle location/digest, dependencies, preset stores and any existing PiPedal imports. Reuse a compatible installation; reconcile its release with the reviewed baseline in [DES-EVIDENCE].
2. Audit the intended Pi-local or Mac-origin preset list and existing labels according to [DES-ORDER]; preserve existing PiPedal plugin-preset storage. Stage labels only if changes are needed.
3. Reuse the installed LV2 bundle in a confirmed service scan path. Only if absent, inaccessible, or incompatible, make a backed-up configuration/location change or fetch and verify the fallback archive in [DES-EVIDENCE] before replacement. Record why the change is necessary.
4. Make the selected rigs available in the effective service-user root from [DES-DATA], by local reuse/staging or optional Mac transfer; check ownership/readability and restart/rescan when needed.
5. Verify discovery, actual no-DISPLAY instantiation and all 43 controls for the selected release; then perform settled rig import/save/offline recall from [DES-STATE]. If the installed release changes the control contract, review and explicitly update it before acceptance.
6. Qualify the boards and populate [DES-TEST]. Complete the stage/restore checklist in [DES-ROLLOUT].

An independent LV2 diagnostic host is optional. If actual PiPedal failures need isolation, create a narrowly scoped helper under `tools/gig-rig/` via the task workflow and include its conclusions here. No external experiment/tool is needed to continue. Docker builds and GUI-less plugin work remain deferred unless binary qualification creates a specific need.

### [DES-SEC] Configuration and Backup Handling

Use supplied SSH credentials through existing local configuration/key agent; do not copy private keys, passwords, account tokens, or Wi-Fi secrets into this sprint or Git. For Mac-origin rigs, transfer data over SSH; for Pi-local rigs, reuse or stage data locally. In either route, verify service-user ownership/access. Record the backup location/digest privately and keep credentials/private models and large artifacts outside the source repository.

Take a consistent service-state backup before changes; record whether the service was stopped or another consistency mechanism used. Include `/var/pipedal`, `/etc/pipedal`, existing plugin bundle, service overrides, and the exact previous PiPedal package. Preserve existing rigs and test that the backup is readable/restorable before replacing the known-good setup.

### [DES-ERR] Risk Register

| ID  | Risk / reviewed status                                                                                           | Mitigation / task                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 | ARM64 dependency, actual-host and service instantiation/readback gates pass; physical audio acceptance remains pending. | Preserve passing diagnostics; complete [2.6] listening and intended-board gates. |
| R2 | Original missing-feature/discovery blocker corrected and deployed. | Feature A/B and real-service discovery/readback pass; physical audio remains in [2.6]. |
| R3 | No-display actual-host DSP and effective service-user import/readback pass. | Fresh offline DSP tests are separate from service/cold-boot intended-rig acceptance. |
| R4  | Direct plugin MIDI — unavailable at pinned host.                                                                 | Use PiPedal bindings [5.1]; broader routing deferred [6.3].                                                                                                      |
| R5 | Real-service program import and settled full-state save/recall pass for eight factories and tsinelas. | Readiness/listening and offline service/cold boot remain in [3.5]/[3.6]. |
| R6 | Confirmed deferred-load race: all eight immediate factory saves captured wrong state. | Matching observations plus actual saved-export identity/assets verification mitigate state capture; runtime readiness and rehearsal remain unproven. No synchronous-program fix added. |
| R7 | Installed manifest and persistent labels reconciled for nine named rigs. | Strict inventory/128-slot audit and labels-only before/after export comparison pass; recheck after additions. |
| R8 | Nine-rig program map audited; user insertion shifts factory programs. | Preserve legacy filename identity, query persistent IDs and regenerate labels after changes. Authoring UI PC comparison still pending. |
| R9  | Large states/web payloads — Open.                                                                                | Measure JSON/wire/storage/phone load [4.3], including ≥10 rigs.                                                                                                  |
| R10 | Full preset-switch gap — Open.                                                                                   | Recorded audio and five switch trials [4.2].                                                                                                                     |
| R11 | Pi CPU/deadlines with two instances — Open.                                                                      | Measure both active branches, settings/model qualities, cooling [4.1], [4.4].                                                                                    |
| R12 | Plugin worker RT scheduling — Pending.                                                                           | Inspect permissions/thread priorities and runtime logs/load [0.2], [4.1].                                                                                        |
| R13 | Snapshot rig switching — unsupported in pinned runtime path.                                                     | Full preset recall; verify [3.6], [5.1].                                                                                                                         |
| R14 | Patch-property MIDI bindings — unavailable.                                                                      | Phone controls [2.6]; optional extension deferred [6.4].                                                                                                         |
| R15 | App-user/service-user non-preset settings differ — Open until verified; applies to Pi-local and Mac-origin rigs. | Check fresh and recalled full-state settings [3.4], [3.6].                                                                                                       |
| R16 | 44100 options mismatch — documented residual.                                                                    | JUCE uses actual sample-rate argument; validate 48 kHz [2.6], [4.1]; no general-host cleanup presumed.                                                           |
| R17 | In-process crash interrupts all audio — Open.                                                                    | One-hour soak and restart/boot recovery [4.4], [5.2]. Service restart delay is not gap-free recovery.                                                            |
| R18 | Native prerequisites, Trixie packages and isolated builds verified; portability beyond this Pi remains unqualified.                                                                          | Verify apt candidates (including `libasound2t64`), Node and dependency/build versions [1.2], [2.2].                                                              |
| R19 | New PiPedal baseline regressions — Open.                                                                         | Back up and recheck existing TooB board after install and any bounded host fix [1.5], [1.7].                                                                     |
| R20 | Opaque-state shortcut corrected; both-branch regression tests and five direct pair identity recalls pass. | Actual dual-branch/audible recall and cold boot remain in [3.6]/[4.2]. A fast no-op is never a latency pass. |
| R21 | Original missing-readback defect corrected; complete phone/persistence acceptance still pending. | F31/[DES-UI]; corrected actual-host 43/43 and five expanded tests pass; running-service 43/43 pass. Preserve the original 0/43 result; finish [2.6]/[2.9] independently. |

### [DES-TEST] Measurement Protocol and Verification

#### Qualification Configuration

- [NFR-1]: start at 48 kHz with 16×4 or 32×4 buffers if the actual interface supports them. Measure round-trip latency; the provisional ≈4–6 ms goal requires explicit agreement before accepting a slower configuration.
- [NFR-2]: qualify the two-instance A2 board with tuner/delay/reverb and oversampling disabled (1×). Record 60 s CPU average/peak, plus worker/system load, temperature and throttling; compare multi-core on/off and actual A2 quality variants. Both enabled Split branches must run.
- [NFR-3]: confirm a real opaque-state restore for changed song presets, as specified in [DES-RELOAD], separately from the 100 ms Split mix transition in [DES-ARCH]. Check actual rig identity on five recalls.
- [NFR-5]: compare `pipedald` restart and xrun counters, logs and audible recordings across the one-hour run. Release builds may not expose assertions in logs, so log absence alone is insufficient.
- [NFR-6]: record exact commits/submodules, package versions, archive digest, inventory, results, backup/restore commands and each unavoidable Mac/phone/manual step. Credentials and bulky/private rig backups remain outside Git, as specified in [DES-SEC].

#### Measurement Procedure

Every result must identify exact build/plugin digest, board/preset/model inventory, buffer/sample rate, interface, OS/kernel, multi-core/oversampling, model quality, cooling, phone/network, and evidence path. Use the one-hour run for final xrun/stability acceptance; a ten-minute check is exploratory. Define the recording/noise threshold used to detect gaps/clicks and inspect both stereo channels where relevant.

| Measurement                                  | Method / acceptance link                                                                                                                          | Result  | Evidence / timestamp |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------- |
| Round-trip latency at 48 kHz                 | Measured loopback/capture including plugin processing; [NFR-1].                                                                                   | Pending | Pending              |
| CPU: 1 instance, 16×4, multi-core on         | 60 s average/peak; baseline only.                                                                                                                 | Pending | Pending              |
| CPU: 2 instances + tuner/delay/reverb, 16×4  | Both branches active; [NFR-2], log worker/system load too.                                                                                        | Pending | Pending              |
| CPU: same board, 32×4                        | Compare buffer, multi-core on/off, actual A2 qualities; [NFR-2].                                                                                  | Pending | Pending              |
| Xruns: 10 min exploratory / 1 h final        | Before/after audio counters, service logs and audible capture; [NFR-1], [NFR-5].                                                                  | Pending | Pending              |
| A/B transitions                              | Five or more CC-triggered switches; no reload, silence/click; [FR-5].                                                                             | Pending | Pending              |
| Full preset switch                           | DAW recording of five PC/UI switches, correct rig/gap/click; include same-structure different-state boards and both Split branches; [NFR-3], R20. | Pending | Pending              |
| Instantiate/opaque restore/program readiness | Actual-host logs/capture; separate return time from audible readiness. | Corrected feature/readback/synthetic gates pass; real-service Bogner identity settles after initial stale state. Audible readiness and intended-rig acceptance pending. | Original and corrected diagnostic logs; real-service observations below. |
| State/storage/network sizes                  | Actual JSON bytes per rig, total bank/wire size; [NFR-4], R9.                                                                                     | Pending | Pending              |
| Phone list with ≥10 rigs                     | Five timed opens, device/browser/network; [NFR-4].                                                                                                | Pending | Pending              |
| Boot to sound / offline recall               | Power-cycle with intended devices and internet disconnected; [FR-2], [FR-7].                                                                      | Pending | Pending              |
| One-hour rehearsal soak                      | No restarts/crashes/assertions/xruns; real controller and board; [NFR-5].                                                                         | Pending | Pending              |
| Restore drill                                | Restore exact known-good artifacts/state; playable output and controls; [FR-10].                                                                  | Pending | Pending              |

#### Configuration and Acceptance Record

Fill this table during implementation with exact values and deviations from the candidate baseline.

| Item                                                                                            | Recorded value / result                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH access | Verified at 2026-10-04T01:10:47.000Z: `nam@192.168.1.169`, hostname `rpi5nam`; Mac key authorization and password-disabled command pipeline pass. |
| Pi model/RAM, OS/kernel/architecture, disk/cooling/power | Pi 5 Model B Rev 1.1; 8062 MB RAM; Debian/Raspberry Pi OS Trixie 13.7, aarch64/arm64; kernel `6.18.50+rpt-rpi-2712`; 117 G root, ~105 G free at preflight. `raspberrypi-ui-mods`, labwc and lightdm are installed (Desktop packages). Physical power/cooling/wiring remain unverified. |
| Host revision/submodules, bounded fixes, package version/path/SHA-256 | Installed exact arm64 package from isolated `/home/nam/pipedal-gig-rig-build` at `787c45014c2501c00ae49a96bc792cfd3abb88a7` plus the two reviewed host fixes. Package version 2.0.110; SHA-256 `76df498a7dd5bc05cba82f81be4b5c6f7b5f23cb24691c2a2873320138a42236`. Source/artifact linkage comes from this build/deployment record, not version inference. |
| Installed TONE3000 app/plugin version, bundle path/SHA-256 and runtime libraries | Service LV2 `/usr/local/lib/lv2/TONE3000.lv2`, v0.0.11 exact source plus approved JUCE correction; binary SHA-256 `527c8f60560f3c47fb2e7b3bc86f585c598fdd5e4683d90d970657c9fda4bc77`. All ldd dependencies resolve on this Pi (GLIBC 2.41); no older-OS portability claim. Original app/user bundle and release archive remain intact; original hashes are retained in the historical record. |
| Service user/HOME/XDG, unit overrides and scan path | `pipedald.service` active/running as `pipedal_d`; process environment verifies HOME `/var/pipedal/home`, DISPLAY and XDG_CONFIG_HOME unset. RTPRIO 95, MEMLOCK infinity, Nice −9, restart delay 5 s. System bundle discovered and instantiated; service-owned preset root `/var/pipedal/home/.config/TONE3000/Presets` (0700 dirs/0600 files), bundle 0755 dirs/0644 files. No app settings/tokens copied. |
| Interface, sample rate/period/buffers, routing/calibration | HotoneAudio Jogg USB Audio (`84ef:0014`), ALSA `hw:Audio`, input/output card 2. Original configuration 48000 Hz/16×6 retained privately. Current comparison-board setting 48000 Hz/32×4 after observed overload; buffer comparisons and physical latency remain unqualified. Wiring/calibration remain unverified. |
| Controller, MIDI channel/bank, PC/CC and displayed numbering | MIDI Captain STD reported by Rix; USB Pico `239a:80f4`, raw `hw:3,0,0`; ALSA sequencer `Pico Midi Captain- usb_midi.por` 28:0 → PiPedal 128:0 confirmed after Rix enabled it. PiPedal serialized `midiChannel: 2`, Captain and Midi Through selected; preserved. Actual physical PC/CC payloads, numbering and actions still untested. |
| Rig source (Pi-local/Mac), authoring app version, rig IDs/names/files/digests, model/IR/quality | Eight Pi-local factories plus preserved Mac tsinelas; updated Mac app 0.0.11. Rix chose Dumble/Matchless. Nine-rig inventory, embedded models, digests and limitations below. |
| Machine settings and recalled per-instance settings | Service preferences.settings absent at inspection; pinned default multiCore=true/namSlimSizeDefault=0. Saved source block enabled/mix/slim verified for eleven reference states; both dual osEnabled=0 read back. Calibration remains unmeasured.                                                                                                                                                                      |
| Phone/browser, hotspot/P2P mode/address and response | Mac Safari generic-control rendering and one outputLevel edit verified against direct RPC; not phone acceptance. Phone list timing and venue-independent connectivity remain pending. Browser getPatchProperty may initially resolve cached pathProperties; direct RPC/native tests supply authoritative reply evidence. |
| Trials/failures, latency/CPU/xruns/gaps/soak/boot                                               | Populate measurement table above.                                                                                                                                             |
| Backup/artifact digests and tested restore sequence/result | Initial approved off-device baseline, post-install return snapshot and pre-reset backup retained. Technical old-package rollback and corrected-package recovery passed; physical playable verification remains pending. Detailed sequence/digests below. |
| Agent/Rix verdicts, timestamp and accepted scope exceptions | Agent at 2026-10-04T03:25:34.000Z: host/readback, nine saved-state smokes, selected-pair offline DSP and technical recovery pass. Stock preset reset executed. Rix listening/MIDI/phone/cold-boot/rehearsal verdicts pending; no criterion waived. |

#### Implementation Evidence — 2026-10-04T01:49:27.000Z

- Native `build-prod.sh` completed in **8 min 33.358 s** with three jobs, TypeScript/Vite build and one packaging invocation; peak RAM was not captured. Build tools: CMake 3.31.6, GCC 14.2.0, lilv 0.24.26, ALSA 1.2.14, systemd 257, libnm 1.52.1, ICU 76.1. Only needed native prerequisites were installed; no blanket OS upgrade. Required dependencies updated OpenSSL to 3.5.7.
- Verified official Node **v22.23.3** ARM64 toolchain, archive SHA-256 `a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f`, installed privately below `/home/nam/.local/share/pipedal-gig-rig/`; no system Node replacement.
- New host package: `/home/nam/pipedal-gig-rig-build/build/pipedal_2.0.110_arm64.deb`, **32291468 bytes**, SHA-256 **`76df498a7dd5bc05cba82f81be4b5c6f7b5f23cb24691c2a2873320138a42236`**. This exact package is built but **not installed**. The strengthened diagnostic was rebuilt separately afterward; production host changes are unchanged.
- Pinned recursive submodules: SQLiteCpp `5d634bbf9e1212c2dfda305b66eb9de8254d64c5`; googletest `6910c9d9165801d8827d628cb72eb7ea9dd538c5`; libzip `fb59b49dff933d52e85b3a772b52bf004aa60fc8`; sdbus-cpp `7fbfcec455a2af6efe3910baa3089ecba48a9d6d`; websocketpp `e6df114a1a1ba83038a0c5a71985c0e294190fb2`; pipedal_p2pd `a6f827cb2f9df220f8420e3207bbaa4c364c93a5`.
- `pipedaltest '[gig_rig]'`: **6 cases, 62 assertions pass**. Actual-host opt-in probe (`[gig_rig_runtime]`) uses real PluginHost/Lv2Effect at 48 kHz, 64 frames, DISPLAY unset, `nam`'s existing LV2 path and private diagnostic storage. Missing bounded feature fails instantiate; supplied feature succeeds. Default-state 3 s synthetic signal: RMS **0.0582526**, peak **0.0732745**, finite/nonzero. **43 expected values, 989 validated Get requests, 0 output events, 0/43 readbacks**; overall 1/2 cases pass, one assertion fails. This does not verify intended models/IRs, real-interface audio, service-user behavior, latency or rehearsal.
- Existing options discrepancy remains: actual instantiate rate 48000 Hz, options sampleRate 44100. No general-host cleanup added.
- Host build/probe evidence: `/home/nam/.local/state/pipedal-gig-rig/native-build.log`, `regression-tests.log`, `runtime-probe.log`. Canonical tests: `src/PedalboardStateTest.cpp`, `src/Tone3000HostTest.cpp`.
- `python3 -m unittest discover -s tools/gig-rig -p 'test_*.py'`: **23 tests pass**. Helpers cover audited inventory/strict staging, source/destination safety, private backup/staged extraction, install-failure preservation and WebSocket reply correlation. Failure logs deliberately produced by the mocked installer test do not indicate a Pi deployment attempt.
- Rig slots 0–7: **Ampeg Bass Drive; Bogner Fullstack; Dumble Spread; Marshall Bluesbreaker; Matchless Crunch; Mesa Pitch Shift; Stereo Crunch Verb; Stereo Fuzz**. Staged files in `/home/nam/.local/state/pipedal-gig-rig/staged-labels/`: `inventory.json`, `names.txt`, `manifest.ttl`, `manifest.original.ttl`. Slot mapping is audited from headers/IDs/ordering; installed manifest and PiPedal persistent labels were not changed.
- After Rix enabled MIDI, read-only API and `aconnect -l` confirm Captain 28:0 and Midi Through 14:0 connected to PiPedal 128:0. No physical-event/action pass is inferred. The user-selected configuration was captured privately as `post-backup-midi-configuration.json` because it postdates the baseline backup.

#### Corrected Build, Deployment and Service Smoke — 2026-10-04T02:38:17.000Z

The preceding implementation record describes the original failed gate before deployment. The following record supersedes its current deployment/readback status while preserving that failure evidence.

- TONE3000 release `v0.0.11` resolves to **`e77b801ce7f75092fb29817e03141d18ece6359b`**. Isolated Pi checkout `/home/nam/tone3000-gig-rig-build`; recursive dependencies AudioDSPTools `0827c6c2fc0deced568536142ea86f189e0b98a1`, NeuralAmpModelerCore `1f42f88535884450104b8711d7595019afa0495b`, their Eigen revisions `6d829e766ff1b1ab867d93631163cbc63ed5798f` and `bc3b39870ecb690a623a3f49149a358b95c5781d`. CPM JUCE **9.0.3** commit `be29c81492b6151c8ea8d14c840e1311963b3a83`; FreeType **2.13.3** commit `42608f77f20749dd6ddc9e0536788eaad70ea4b5`.
- Configure: `cmake -S . -B build-gig-rig -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_AAX=OFF -DBUILD_CLAP=OFF`; then build only `TONE3000_LV2`. Normal GUI-linked LV2 build; no HEADLESS change or authoring-app installation. Initial configure took 111.5 s. Common compilation ran 14 min 2.739 s before failing on the absent JACK header; installing the needed `libjack-jackd2-dev` 1.9.22~dfsg-4 allowed the incremental LV2 target to finish in 25.415 s. No JACK server was installed/configured. Existing JUCE_CURL macro warnings remain. Build temperature 64.8–66.4 °C, `throttled=0x0`; this is build observation, not rehearsal evidence.
- `tools/gig-rig/Tone3000Readback.cmake` is included after the pinned project's JUCE CPM block. The applier validates the exact original/post-patch source and patch digests, preserves LF/CRLF and permissions, applies atomically, is idempotent and refuses source drift. Patch SHA-256 **`c510d987c087301c8b959881b1447a8eca2c0f2272b51323c603bcb546d02b82`**; normalized JUCE source before **`3e7942f9de59081c13f0816b58de42b86079a9c4f9c1bcef2917efa155b15843`**, after **`c569c8184c496e5cc4378ffbf237e29162de54e15a6da32ebea2f6cbb0bc45ed`**; actual patched CRLF file **`57d8beadc7e9839ca9e8dd409d52460a4f80f48f7fbdac0607d4a4c38570e7ff`**. Root CMake original normalized digest `0077a3168d57048164a6dffc7d8b60da62ac36906e45885dd88040872a1133d6`; actual hooked file `88689609bc7b47b4aff484e37584d2802532c1059869b75ca249774a5b401773`.
- Built/installed binary **21897368 bytes**, SHA-256 **`527c8f60560f3c47fb2e7b3bc86f585c598fdd5e4683d90d970657c9fda4bc77`**. Bundle manifest **27908 bytes** / `f1f94a5e44bbf4cda795acf8e2195495c77e2abc990b1d6272cbe899fa9df3ee`; DSP TTL **15789 bytes** / `c0efaf41c73341d460aa2e9c109c837f895d3684e8ae4c53324b2126b7065240`; UI TTL **622 bytes** / `8e36508ca84238faf766c8d02b9b10a99dca386bcf28839f36e250aa09a283de`. All runtime libraries resolve on the Pi.
- Corrected actual-host original gate: **43/43 readbacks, 989 validated Gets, 989 output events**; feature A/B and finite synthetic output pass (3 s, 48 kHz/64 frames; RMS 0.0582526, peak 0.0732745). Expanded real-plugin suite: **5 cases / 41438 assertions pass**, covering all-property/individual reads, 217 Set→Get checks including 45 advertised choice points, seven invalid requests, 32/88-byte buffer safety and queued retries, and fresh-instance 43-value numeric saved-state restoration. An early expanded fixture queried ports before Activate and failed; fixing fixture order produced the passing run. These tests do not prove loaded model identity or physical audio.
- Private logs: `runtime-probe.failed-original.log` retains original 0/43; `readback-runtime.log` contains the passing original gate and the early fixture failures; **`readback-expanded-runtime.log`** is the corrected all-passing expanded suite. Build/configure logs and raw private state remain below `/home/nam/.local/state/pipedal-gig-rig/`. The host package production changes are unchanged by subsequent diagnostic-fixture additions.
- Installed exact tested host package and corrected system LV2 using [DES-ROLLOUT]. PiPedal remained active, NRestarts 0; original bank 2 / preset 27 “Drop - Bogner” and enabled Captain settings were preserved. The original daemon accumulated 56 xruns during heavy exploratory compilation; no rehearsal pass is claimed. Post-install status initially reported 0 xruns. Application-owned TONE3000 settings/bundle were preserved; only the eight Pi-local factory preset files were staged into the service-owned root.
- Real-service temporary single-instance test, restored original board in `finally`: all **43** `getPatchProperty` requests return numeric values, with active ALSA at 48 kHz/16×6. Importing “Bogner Fullstack” initially exposes cached prior empty state (3992 opaque bytes); subsequent cached state contains the expected factory ID and name, **688480 opaque bytes / 668210 embedded model bytes**, two NAM models and one IR. `currentPedalboard` alone does not force fresh state capture. Qualification must use supported saves (which call SyncLv2State) in an isolated test bank, then verify actual recall and audio.
- Observed factory label → PiPedal plugin-preset persistent ID: Ampeg **1**, Bogner **41**, Dumble **52**, Marshall **63**, Matchless **74**, Mesa **85**, Stereo Crunch **96**, Stereo Fuzz **107**. These IDs are distinct from TONE3000 program indices 0–7; resolve labels from `getPluginPresets`, never assume ID = program + 1. The 128-slot RDF index contains 120 `(empty)` entries.
- Service logs confirm cached model requests and NAM/IR preparation but do not alone prove installed/healthy DSP engines. GUI-linked startup emits X authorization notices despite DISPLAY being unset; instantiation and readbacks succeed. Preserve these notices and complete audio/error checks; do not call log absence a readiness pass. Full StateString omits runtime loaded/modelLoading/loadFailed and processing-failure flags. Runtime/reference audio and Rix's tone verdict remain required.
- Reusable helpers now include private state identity inspection and observational performance collection. A deployment-path guard bug in the collector was caught before file creation and corrected to detect actual `.git` ancestors rather than infer repository location from a staged helper's depth. Its 13 tests pass. Private outputs never certify qualification automatically; source, state and performance summaries are evidence for the remaining gates.

#### Import, Offline DSP, Restore and Factory Reset — 2026-10-04T03:25:34.000Z

This record supersedes earlier current-state statements without erasing failed trials. Raw evidence below is private under `/home/nam/.local/state/pipedal-gig-rig/` unless stated otherwise.

**Owner selections and Mac content.** Rix selected **Dumble Spread (rhythm) + Matchless Crunch (lead) as the comparison pair; final tone acceptance remains pending**, then requested the TONE3000 defaults and previously downloaded/saved Mac content. The updated `/Applications/TONE3000.app` reports version/build **0.0.11**. The scoped Mac preset inventory found one saved user rig, **`tsinelas`**, at `~/Library/Application Support/TONE3000/Presets/b2ae66fd57b247e8963f8b4cf238106a.t3kpreset`: 1891498 bytes, SHA-256 `4d141231fac85e6cf45fc86eb46d356e987668d240d2a7814988999a62babf10`. Updating the app did not change these bytes. It is a legacy T3KB file with empty raw ID; the pinned loader derives identity `user:b2ae66fd57b247e8963f8b4cf238106a` from its preserved filename stem. Renaming it to its display name would change its identity.

`tsinelas` embeds five NAM models (1864455 bytes total): Fender Deluxe Reverb, Wizard MTL MKII/Bogner 412, Marshall 6100LM, Mesa 90s Dual Rectifier, and 5150 Stealth/Mesa OS. The first four blocks are disabled; the 5150 block is enabled. All five saved quality values are full (`slimSize=1`); no IR block or external model-file dependency was found in this rig. Preserve these saved choices rather than enable all five amps. Detailed model IDs/digests are in the private Mac inventory `/private/tmp/pipedal-gig-rig-private-20261004/mac-tone3000-inventory/inventory.json`. The inspected application stores contained no separate loose NAM/WAV collection. This does not prove that every historical website download still exists elsewhere on the Mac; only the saved, located content is imported. Account settings/tokens were not transferred. A later scoped search located a separate Nouratone Favorites model collection; Rix explicitly excluded it (“nvm nouratone”). No Nouratone assets were copied, imported or modified; it is outside the nine-rig reference library.

The exact user file was copied into both `/home/nam/.config/TONE3000/Presets/` and `/var/pipedal/home/.config/TONE3000/Presets/`, alongside the eight verified factories. Manifest label SHA-256 is now **`f2f7f47be305f7755a5f3d0bf7190ea42738a1c09bd032da7b411ae3354e0cca`**; the corrected DSP binary remains `527c8f…`. Service files retain `pipedal_d` ownership, 0700 directories and 0600 files. Program order is now:

| Program | Display name | Stored identity |
| --- | --- | --- |
| 0 | tsinelas | `user:b2ae66fd57b247e8963f8b4cf238106a` |
| 1 | Ampeg Bass Drive | `factory:7007eb161b3c4c97a624396f2e3a3ada` |
| 2 | Bogner Fullstack | `factory:029e6f8159a1468e974663d9201a1a1e` |
| 3 | Dumble Spread | `factory:0f487d253737472f84e1b5c24292f577` |
| 4 | Marshall Bluesbreaker | `factory:230b0f41771a499eb99020eccac304bc` |
| 5 | Matchless Crunch | `factory:83819e60b0604954aa46f1901de405e9` |
| 6 | Mesa Pitch Shift | `factory:d24f2f819d574554acfcf99e0052d1f4` |
| 7 | Stereo Crunch Verb | `factory:17ff5d4c4c9345dfa527e533d3d98fbd` |
| 8 | Stereo Fuzz | `factory:2cd31d455fee4f93988a7baaf6807dbd` |

`reconcile_presets.py --apply` changed only the nine meaningful labels through the supported API, preserving all 128 persistent IDs, ordering, next counter and every other field. The real `/var/downloadPluginPresets` ZIP export was compared before/after. Reviewed inventory/manifest are in `staged-owned-import-20261004/labels/`; reconciliation evidence is in `owned-import-label-reconciliation-retry-20261004/`. An immediate invocation after restart received ConnectionRefusedError before the backend listened; the subsequent fresh-output retry passed. Adding a user rig shifts factory programs; resolve current persistent IDs from `getPluginPresets`, never reuse the preceding eight-factory mapping.

**Actual service save/recall.** All eight factories passed in `qualification-corrected-20261004/`: saved settled identities, chain topology and embedded model/IR hashes match source; all 43 numeric reads, three representative continuous/toggle/enum edits and 43-value full recall pass per rig. Matching observations compare preset identity, embedded byte hashes and topology, not identical opaque hashes or every enabled/mix/slimSize setting; those settings require separate comparison. **All eight immediate saved exports captured the wrong state.** The helper observes matching state repeatedly, then calls a supported save (SyncLv2State) and verifies the actual stored `/var/downloadPreset?id=…` ZIP before accepting it. This is a verified state-capture mitigation for R6, not an engine-readiness guarantee or synchronous-program fix.

The initial helper used the incorrect `/downloadPreset` URL. The existing static-file handler threw an uncaught filesystem error and the daemon aborted/restarted once. This failed trial is retained in `qualification-20261004/`; the original board was recovered through fresh RPC. The helper now uses the exact `/var/downloadPreset` route, with route tests and bounded reconnection for restoration. The general host missing-file crash remains outside the two bounded host fixes. Do not call this crash a TONE3000 DSP failure or erase it from stability evidence.

After the stock reset, `qualification.py --include-user --label tsinelas` passed in `qualification-user-tsinelas-20261004/`: the correct legacy identity and all five embedded model hashes survived real saved-state capture; 43 reads, three representative edits and 43-value full recall passed. Its clean settled export is `01-settled.piPreset`. The stock selected bank/preset and exact cached board were restored; the original stored preset was not overwritten. Restoring an unsaved cached board can mark it dirty. Generated trial banks use the `TONE3000 diagnostics` prefix. The earlier factory exports remain private and valid full-state inputs even though their old bank/preset IDs were removed from the active library by the requested reset.

**Independent offline DSP.** The hidden real-host `[gig_rig_full_state]` test uses an empty fresh HOME/XDG/store, no preset folder, valid full StateString without Program/lilv URI, and a deterministic 110/330 Hz input. An isolated `unshare --net` namespace had only loopback/no routes and returned ENETUNREACH for internet access; the live Pi Wi-Fi/SSH was retained. Bogner: **1 case/1189014 assertions pass**, repeat RMS 0.307489/peak 0.478115, exact repeat DSP digest, recalled output-level change ratio 0.251189. Selected pair: **1 case/1585364 assertions pass**, Dumble baseline RMS 0.256108/peak 0.477340, repeat relative RMSE 0.0760864 within 0.10 (modulation prevents exact repeat); recalled gain ratio 0.252853 vs expected 0.251189. Matchless RMS 0.197779/peak 0.318514, distinct output with relative difference 0.520808. Logs: `full-state-offline-runtime.log`, `full-state-offline-pair-runtime.log`. The fixture itself reports no network proof; the caller's isolated-namespace proof supplies that evidence. These are synthetic fresh-instance tests, not physical interface/listening/boot acceptance.

Five direct same-structure Dumble/Matchless service recalls selected the correct alternating identities without an empty-board barrier. Observation elapsed times 1.5325/1.4967/1.4018/1.4087/1.4423 s include large JSON transfer/decoding and polling; **they are not audio gaps or engine-load timings**. Evidence: `pair-recall-results.json` and five private board snapshots. Audible switching and both dual branches still require measurement.

**Observational CPU.** The pre-reset experimental board was observed for 60.027 s at 48 kHz/16×6, 61 samples: PiPedal CPU mean **17.725%**, peak **21.965%**; process CPU mean 24.406%/peak 25.136% of one core; whole-system mean 7.410%/peak 26.747%; maximum 59.8 °C, `throttled=0x0`, xrun delta/errors/gaps/restarts 0. Evidence `perf-original-60s-20261004/summary.json`, interval 2026-10-04T02:41:30.060Z–2026-10-04T02:42:30.163Z. This was an observational test of the old board, not the target dual board or played rehearsal.

**Executed technical recovery.** A consistent post-install snapshot, `postinstall-20261004/postinstall-state.tar.gz`, created 2026-10-04T02:51:24.000Z, SHA-256 **`701376558bead89edd4d50bfaaa812444b811c6ad48e75557fea834e9e837f6a`**, was used for the return leg. The drill verified old/new package and archive hashes; stopped **both** `pipedald` and `pipedaladmind` and verified inactive/PID 0; quarantined current stores/bundle/unit; reinstalled the retained old package; stopped both again after package scripts; restored reviewed baseline paths with GNU tar ownership/ACL/xattrs; reloaded/started services and reapplied the later MIDI configuration. The old original bank 2/preset 27 was recovered, TONE3000 absent from the baseline scan, and Captain settings matched. The reverse leg reinstated the exact corrected package/system bundle and post-install stores, recovered the same old board/MIDI, and verified the corrected binary hash. Each startup observed one underrun. `recovery-drill-20261004/result.json` reports **technical_restore_passed=true, playable_verification=false**; logs and all quarantines are retained. This proves the technical recovery sequence, while physical playable acceptance in [5.3] remains pending.

**Requested factory preset reset.** Both services were stopped and a fresh GNU ACL/xattr backup captured `/var/pipedal`, `/etc/pipedal` and the current nine-rig system bundle: `pre-factory-preset-reset-20261004/pre-reset-state.tar.gz`, SHA-256 **`9b49f834e7fcc563183e595319c48c2d95a801a91c68c8377e0073702c004a74`**. Only `/var/pipedal/presets` and `/var/pipedal/currentPreset.json` were moved to private quarantine. Restart provisioned stock **Factory Presets (bank 1)** and **Default Bank (bank 2)** with 14 stock entries each, initially selecting “Marshall JCM800 + TS9” (preset 10). Working audio, SSH and Captain configuration were retained. The old “Drop - Bogner”/TEST library is now backup content, not the active performance baseline. Factory Presets must remain untouched; imported single/dual/trial boards belong in new TONE3000 banks.

**Bank build contract.** `build_bank.py` prevalidates verified one-instance full-state exports before RPC, refuses Program/lilv-preset imports, creates a `TONE3000` bank by cloning the stock source, then moves only the new bank to the end and checks original bank ordering. The supported clone API inserts after the source, so this involves a brief intermediate bank-index shift; final original order must match. It adds clean single-rig entries, constructs a source-verified A/B Split (`splitType=0`, select 0=A) with both TONE3000 instances enabled and shared tuner/delay/reverb, sets mute and oversampling off with authoritative readback, and verifies saved exports before deleting only cloned stock entries in the new bank. Source stock bank content is compared before/after; failure retains the new bank/private result rather than modifying the source. Execution results and the source-bank export fallback are recorded below.

#### Clean Reference Bank and Restart Verification

The nine-rig numbering was rechecked through all eight actual factory imports in `qualification-nine-map-factories-20261004/`: eight settled saves, 43 reads/three edits/43-value recalls per rig passed after the user insertion. `tsinelas` separately passed offline fresh-HOME DSP: **1 case/1188916 assertions**, RMS 0.182705, peak 0.373679, repeat relative RMSE 0.0000197354, recalled output-level ratio 0.251189. Evidence `user-offline-dsp-20261004/runtime.log`; the namespace wrapper proves no internet, while the fixture still correctly declines engine-readiness/physical-audio claims.

The first bank-builder invocation failed **before mutation** with BadZipFile. Further read-only probes showed `/var/downloadBank?id=1` returned HTTP 200/Content-Length 6250213 but zero body bytes (curl error 18/urllib IncompleteRead). The route is correct; this is a separate existing export defect. No general HTTP-server source fix was added. The helper now offers an **explicit**, loopback-only `--source-bank-file /var/pipedal/presets/Factory+Presets.bank` fallback: nonlinked exact Pi store, regular bounded raw JSON, stable read, indexed source name match, private before/after copies and exact raw-byte/SHA equality. `.bank` is the raw stored format; `.piBank` is the exported ZIP format. An empty HTTP body is never silently accepted.

The fallback invocation created **bank 5, `TONE3000 Reference`**, with verified saved exports and stock bytes unchanged. Private evidence: `tone3000-reference-bank-20261004/`. Stock raw bank SHA-256 before/after **`5e69439fb077b06418bbfd03104746a3e0aa8c7524296d0aa2bd64eab1122b7f`**. The source bank was never edited. Presets are:

| Preset ID (bank-local) | Name |
| --- | --- |
| 25 | Ampeg Bass Drive |
| 26 | Bogner Fullstack |
| 27 | Dumble Spread |
| 28 | Marshall Bluesbreaker |
| 29 | Matchless Crunch |
| 30 | Mesa Pitch Shift |
| 31 | Stereo Crunch Verb |
| 32 | Stereo Fuzz |
| 33 | tsinelas |
| 34 | Dumble / Matchless A-B |

Deleting cloned stock entries through PiPedal automatically selected the first remaining preset (25), despite the dual board being saved last. The initial handoff guard caught this selection mismatch before cleanup/restart. `build_bank.py` now explicitly loads the intended final dual ID and verifies current selection/state/layout after deletion; tests reproduce the selection behavior. The existing bank was corrected through `loadPreset 34`, without rebuilding it or overwriting any stock preset. Both generated `TONE3000 diagnostics` banks were removed only after retaining their private trial evidence; final bank order is **Default Bank (2), Factory Presets (1), TONE3000 Reference (5)**. Both stock banks retain their 14 factory entries. The strengthened read-only audit of the saved reference bank passed all ten presets/eleven TONE3000 states, including enabled/mix/slim values against the pinned source presets; evidence `reference-all-chain-settings-audit-20261004/result.json`.

A post-build observation at the original 16×6 setting, with preset index 25 selected, showed CPU 95.951% and 3104 underruns; the retained later snapshot reached CPU 98.552% and 5038 underruns. This is a failed exploratory configuration, not a dual-board CPU measurement. Its snapshot is retained in `dual-initial-audio-adjustment-20261004/before-status.json`. The explicit dual selection and **48 kHz/32×4** setting reduced observed CPU to 31.244%, with two startup underruns. This point observation does not establish NFR-2. The original audio settings are saved privately; the buffer comparison below determines further recommendations.

Restarting both services recovered bank 5/preset 34, both enabled TONE3000 states and all **43 authoritative values per instance**, oversampling off. Stock bytes remained identical; `presetChanged=false`. Evidence `bank-restart-verification-retry-20261004/result.json`, boards and values. Post-restart status reported three startup underruns and CPU 54.376% during the probe. This is **service-restart saved-state recall**, not a cold-power-cycle, service-with-internet-disconnected or audible acceptance test. Active TONE3000 instance IDs are **1000012 (Dumble)** and **1000013 (Matchless)**; Split selection 0 chooses Dumble and 1 chooses Matchless. Physical MIDI bindings remain unset until actual Captain messages are observed.

Qualification comparisons now include `enabled`, float32 `mix` and `slimSize` in addition to identity/assets/topology, using pinned restore defaults for legacy missing fields. This strengthens saved-chain verification while retaining the separate limits: serialized state does not prove installed engine readiness, every session setting or physical sound.

Agent verification covers technical evidence. Rix's Human verification covers tone identity, acceptable latency/transitions, physical controls and rehearsal. Record each verdict here after its checks pass.

#### TONE3000 Display Implementation and Live Verification — 2026-10-04T04:17:33.000Z

The requested custom display is implemented and deployed: **Tone (12 controls), Space (14), Pitch (5), Setup (12)**, with readable labels and ordered cards. All 43 current writable Float properties exactly match the discovered service metadata once each. Unknown/future controls remain in **Other**. Existing PatchPropertyControl instances stay mounted across tab switches; the optional label changes only the display name, retaining monitor/Get/Set, actual property URIs and metadata ranges/choices. The existing toolbar, bypass, meters and load actions remain available. `chainPanLinked` remains the existing numeric flag; this view does not add the native editor's linked-pan gesture behavior.

Execution-path review traced factory selection → PluginControlView customization → reused PatchPropertyControl/PluginControl → PiPedalModel → WebSocket → real AudioHost/LV2 patch responses, with no mock handlers or new backend. The live Mesa instance **1000006**, bank **5**, preset **30** returned all 43 numeric values. Browser checks in Safari verified every tab at **1434×934**, and wrapping plus scrolling at **574×934**. Narrow Setup exposes the lower Oversampling card through scrolling. A tab change now resets the control scroll position, verified by switching from scrolled Setup back to Tone and seeing the Levels header. This desktop narrow-window check does not establish actual phone/touch acceptance or smaller phone-width behavior.

Representative browser edits were checked against authoritative RPC: calibration level 12→11 returned **10.999998092651367**; Link pans On→Off returned **0**; oversampling Factor 2x→4x returned **1**, while calibration and oversampling remained disabled. All tested settings were restored; all 43 values match the pre-edit baseline within float tolerance and calibration was restored to its exact **11.999998092651367** baseline. No preset was saved/reloaded and no whole board was restored over owner edits. PiPedal retains its dirty marker after undoing these edits, so the current Mesa preset may show `*`. The owner-selected preset was preserved throughout. Evidence: private `frontend-ui-verification-20261004/result.json`, `control-result.json`, before/after numeric snapshots and `final-served.json`.

Final Node **22.23.3** TypeScript/Vite build passed on the Pi (`frontend-ui-build-scroll-20261004.log`); the preceding ordered build also passed. During development an intermediate source-sync mismatch failed TypeScript, exposing an existing `build.sh` defect: a failed npm command could still return success after compressing stale assets. `set -e` now propagates build failure; a controlled npm exit **17** check proves the gzip step is not reached. The paired sources were synchronized and successful builds repeated before publication. CMake's explicit ReactBuild dependencies now include the view, layout and label adapter. Final local checks: **88 Python tests**, **3 layout tests**, and whitespace validation passed. The intentional installer-failure test prints a recovery message; it is not a device failure.

The live frontend is a **static overlay** on the recorded installed host package; that earlier package does not contain this new display. The final entry SHA-256 is **`69e47b5783c993400e01073b1324d1118a3ad891c0f3b8d5344e3399fe2910e9`**. Main JS is **`/assets/main-CXwitscg.js`**, SHA-256 **`bd25f4f854042faf9f1ff3e696ce42205c599bb5d8bd470b6ccf0b05929e17de`**. Loopback HTTP served exact built index/JS bytes; served gzip decompresses to the exact JS. All three static publications verified resource bytes and reported **no observed changes** to recorded service PID/restarts, audio settings, bank/preset selection. No service/audio restart was requested. The browser control test's underrun counter stayed **22**; a later exploratory observation reached **28**, so this UI check is not a zero-underrun soak or a qualified audio configuration.

Private GNU POSIX/numeric-owner/ACL/xattr frontend backups are retained. To return to the **original flat display**, use `frontend-ui-deploy-20261004/` (archive SHA-256 **`1219b72366851d561785b44f4daf7d40560bdbcf4aaa8d32d8657d280c6b9df7`**). The intermediate ordered deployment's backup is **`1d36a41a2bbbb8e0a8144445becd39128c08e20422711cb297fca8df61453fdb`**; the final scroll deployment's backup is **`db7c9ea4d43281a4a7925471bf893ca9a73fd69b07c109440442978103f2c711`**. Those latter backups return to earlier grouped displays. The helper now reports actual original/incoming/unexpected/unknown entry state even if a directory fsync fails after index replacement; a regression covers this failure and makes no durability or automatic-rollback claim.

Reproduce on the authorized Pi using the isolated source/dependency environment, then publish without restarting audio:

```sh
cd /home/nam/pipedal-gig-rig-build/vite
PATH=/home/nam/.local/share/pipedal-gig-rig/node-v22.23.3-linux-arm64/bin:$PATH bash ./build.sh
sudo python3 /home/nam/.local/state/pipedal-gig-rig/deploy_frontend.py --dist /home/nam/pipedal-gig-rig-build/vite/dist --output /home/nam/.local/state/pipedal-gig-rig/CHOOSE-NEW-PRIVATE-DEPLOY-DIRECTORY
```

For an explicit return to the original display, validate the retained original backup and run the helper's reviewed restore path, then refresh the browser:

```sh
sudo python3 /home/nam/.local/state/pipedal-gig-rig/deploy_frontend.py --rollback /home/nam/.local/state/pipedal-gig-rig/frontend-ui-deploy-20261004 --output /home/nam/.local/state/pipedal-gig-rig/CHOOSE-NEW-PRIVATE-ROLLBACK-DIRECTORY
```

These output directories must be new; replace the placeholders deliberately. Static rollback was reviewed/tested locally but not executed against the live new display. It restores original file bytes while normalizing published files to root:root/0644 and created directories to 0755; the exact backup retains ACLs/xattrs, but the overlay restore does not reapply them. Owner usability, actual phone interaction, physical MIDI/listening, controlled buffer benchmarks, one-hour rehearsal and cold boot remain open. The benchmark preflight stopped before mutation because the owner selected Mesa; do not replace their selection to manufacture a dual-board result.

### [DES-LIBRARY] Pi-Local TONE3000 Library

**Authorization and scope:** Rix primarily prepares tones on the same Pi, and explicitly approved implementing the proposed find/upload/Add/Update/Load flow plus end-to-end verification. This bounded extension provides complete `.t3kpreset` imports; existing NAM/IR authoring stays in the TONE3000 app and existing TooB file/download controls. A saved T3K rig carries its embedded NAM/IR data into this library; no browser chain/model editor or new external account/API is introduced. Existing physical/gig criteria remain independent.

**Verified sources:** app presets `/home/nam/.config/TONE3000/Presets/`, existing service presets `/var/pipedal/home/.config/TONE3000/Presets/`, and installed system factory store. The two users do not inherently share HOME. Configure a server-owned allowlist of app preset roots (one Pi root initially) plus service/system roots and a fixed service-owned upload store. Expose opaque root-relative source keys, friendly origin labels, identity/name, SHA-256 and mapped imports; never let a browser choose arbitrary filesystem paths. Read-only discovery on dialog open and periodic refresh detects complete app saves, with an explicit Refresh fallback. File reads must be stable across an atomic app save; partial/changed input cannot be imported. Set scoped read/default ACLs only on the app preset directory/files if required; verify actual app-save replacement readability, preserve ownership and never expose authentication settings.

**Native codec:** add a bounded C++ JUCE ValueTree reader/writer supporting pinned v0.0.11 T3KH/header+body and legacy T3KB framing, schema 1, finite typed values and raw embedded byte preservation. Check header/body identity, unique properties/parameter IDs, supported chain kinds, active embedded model/IR bytes, complete consumption and complexity/size limits. Retain basename-derived IDs for legacy empty identities; reject unsafe upload names rather than rename their stems. Resolve legacy parameter names using the pinned mappings, rejecting ambiguous duplicates. No JUCE build/runtime or Python subprocess dependency is added to PiPedal.

Convert the preset's exact ChainSnapshot and 36 denormalized faceplate values into **T3KB/TONE3000State/PARAMETERS/PARAM**, then the pinned JUCE MemoryBlock string encoding in LV2 `StateString` (atom:String, flags 3, valid state). Clear Program/lilv import paths. Use pinned defaults for absent managed fields; on Update preserve the prior state's seven session-only numeric parameters (loudness target, calibration enable/level, solos, oversampling enable/factor), inputMode, editor preferences and MidiMappings. Add uses verified pinned defaults. This removes program-index/order drift and the immediate Program-save race; engine preparation is still asynchronous and actual restore/DSP is tested separately. No guessed fixed delay is an engine-readiness assertion.

**Storage and provenance:** optional TONE3000 source key/hash fields on PedalboardItem survive ordinary saved-state edits. Scan only TONE3000-named banks for mapped imported items. Add creates/appends to `TONE3000 Library`, appending a new bank after existing banks and a new preset after existing entries; do not select a bank or change running audio. Duplicate Add for the same source/version returns the existing managed entry. New source version offers Update or Add as new. Update replaces only the targeted TONE3000 item in the exact saved bank/preset, preserving preset/instance IDs, MIDI assignments, ordering, other effects and unrelated banks. Source/target hash guards reject stale dialogs before writes. Prefer the app copy for identical identity/hash duplicates across app/service/system roots; expose differing versions rather than silently selecting them. Identity-based source keys survive modern filename renames; legacy empty IDs still derive from the original stem. Existing hand-authored snapshots retain their versions; disclose targeted snapshot overrides in the library rather than claiming they were refreshed. Stock banks remain untouched.

Updating a currently selected stored preset must not leave a misleading stale running board that can overwrite the update. Reject Update while that active preset has unsaved changes. For a clean active target, the explicit action is **Update & load**, using existing model reload behavior after persistence; nonactive Update leaves audio/selection unchanged. Explicit Load selects the saved TONE3000 bank/preset through the normal host lifecycle, with a user-facing unsaved-change confirmation in the UI. Failed operations retain actionable errors and exact prewrite backup evidence; no silent deletion, automatic rollback or whole-board replacement over unrelated owner edits.

**API contract:** `getTone3000Library` returns `{entries,warnings}`; an entry has `key,name,source,sha256,imports[]`, imports have `bankId,presetId,instanceId,name,sha256,active,hasSnapshotOverrides`. `importTone3000Preset` receives `{key,sha256,bankId,presetId,instanceId,expectedImportSha256,asNew}` (negative IDs mean Add; `asNew=true` explicitly requests an additional saved copy) and returns `{bankId,presetId,instanceId}`. The server validates tokens against the current fixed-root inventory and SHA against reread bytes. `loadTone3000Preset` receives `{bankId,presetId}` and validates the intended TONE3000 bank before loading. POST `/var/uploadTone3000Preset?filename=...` receives raw preset bytes, validates filename/content within a **64 MiB** input bound, publishes only to its fixed private store, and returns the discovered entry. Reject directory traversal, links, malformed/unsupported/truncated input and ambiguous identity conflicts. New HTTP response-status plumbing permits controlled route errors while retaining existing handlers' default 200 behavior; it does not fix unrelated download routes. Duplicate identical uploads are idempotent; a changed same-name upload retains the prior version before atomic replacement. No import executes plugin-supplied code.

**UI:** add a clearly labelled **Library** button to the TONE3000 view. One dialog provides automatic Pi discovery, origin/status labels, Refresh, multi-file Upload, Add, Add as new, Update/Update & load and Load. Busy/error states keep actions reviewable; polling pauses during mutations and stale-source failures refresh the list. Show complete-rig file support and direct users to save NAM/IR chains in the installed app. File paths, program indices and manual service copying are implementation details, not operator steps.

**Verification and rollout:** native codec and storage tests cover malformed/framing/identity/type/limits, embedded bytes, session preservation, duplicate/stale behavior, stable IDs/order/effects and snapshot disclosure. Trace UI→HTTP/WebSocket→model→storage→real LV2 restore before marking Agent checks passed. Build the installed package and frontend from the isolated checkout; capture a fresh consistent private device baseline/current board before deployment and retain the current package/static overlay. Test actual Pi app-origin discovery, upload, Add, source edits/Update, Load, authoritative 43-value reads, settled saved exports, service restart recall and offline synthetic DSP on representative NAM+IR/stereo/user rigs. Use disposable test sources/entries and restore the owner board without dropping concurrent edits; keep physical/listening/phone acceptance explicitly pending where unobserved.

#### Executed Local-Library Setup and Build

The standalone binary is `/home/nam/Downloads/TONE3000-v0.0.11-linux-aarch64/TONE3000`. Its app store has eight named factory files under `/home/nam/.config/TONE3000/Presets/Factory` and the existing legacy `tsinelas` user file in the parent. The service store contains identical copies, which discovery deduplicates in favour of the app. The installed system factory root is optional and absent on this Pi. The live library returned nine entries and zero warnings after deployment.

Scoped ACLs grant `pipedal_d` traversal only (`--x`) on `/home/nam`, read/traverse on the `.config/TONE3000/Presets` ancestry, read on the nine existing preset files, and default read/traverse ACLs in `Presets` and `Factory`. Authentication settings are outside that scope. Native reads use `O_PATH` ancestor descriptors so traversal-only access works. Exact ACLs before/after and a service-user read probe are retained in `/home/nam/.local/state/pipedal-gig-rig/library-access-20261004/`. Creating a normal-mode sibling temporary file and atomically replacing it verified inherited read access; this is an app-save filesystem simulation, not an observed standalone GUI save.

The server configuration now allowlists `tone3000PresetRoots: ["/home/nam/.config/TONE3000/Presets"]` and sets `maxUploadSize: 67108864` (64 MiB). The global transport limit previously defaulted to 1 MiB; raising it permits complete presets to reach the route's independent 64 MiB validation. Existing commented JSON was parsed without comments before serialization; other effective values and original ownership/mode were preserved. Exact prewrite configuration is private at `/home/nam/.local/state/pipedal-gig-rig/library-deploy-20261004/config-before.json`.

Both services were stopped and verified PID 0 for the fresh backup `/home/nam/.local/state/pipedal-gig-rig/pre-library-20261004/state-before.tar.gz`, SHA-256 `94041f5a0343e2c05482a6d80d909b18bd17400d0bab1fb6e37b6ba04594efa6`; GNU tar retained ACLs/xattrs for `/var/pipedal` and `/etc/pipedal`. The preceding package is retained separately in `pre-library-package-20261004/`, SHA-256 `76df498a7dd5bc05cba82f81be4b5c6f7b5f23cb24691c2a2873320138a42236`. These backups are distinct from the older initial baseline and preserve the requested factory/reference organization and subsequent settings.

Native release validation as unprivileged `nam` passed **1,360 assertions / 10 codec cases**, **69 assertions / five library/storage cases**, and **34 assertions / one eight-real-factory-file case**. Codec/tests explicitly disable fast-math for finite validation. The first native build caught a const getter misuse; it was corrected to the existing setter and the final build passed. The full existing Python helper suite passed **88 tests**. Final native/package/frontend logs remain in the private state directory.

The additional current-binary `pipedaltest "[Build]"` audit finished with **25/28 cases and 1,511/1,514 assertions passing**, exit 3. Three broader gates remain failed; this is not an all-green repository verdict:

- `json variants` expects process-wide `json_object::allocation_count() == 0` but observes **27**. An isolated `[json_variants]` run reproduces it without any library tests. The count matches 26 existing namespace-static objects in `ModGui.cpp` plus `AtomConverter::gEmptyPath`; those globals and the assertion are unchanged in HEAD. This assertion includes process-lifetime objects rather than measuring test-local allocation balance.
- `ALSA Seq Test` fails with **ALSA port not found**. Its unchanged `ReadFromsequencerTest()` requires the hardcoded `V25 V25 In` port and then reads indefinitely. This Pi has the Captain rather than that controller; the interactive test was not repeated or used to infer Captain acceptance.
- `PluginHost memory leak` retains **451 allocations / 36,103 bytes**, exceeding its six-allocation/400-byte allowance. Isolated `[lv2host_leak]` reproduces the same retained count/bytes without calling codec/library/storage APIs. Relevant scan/destruction paths are unchanged, but there is no retained prior test binary to establish baseline execution. The complete allocation attribution remains **unresolved**; do not call it proven pre-existing or a passing gate. Investigate host/plugin scan lifetime separately before an all-green broad-suite claim.

No assertion was weakened or hardware configuration changed to suppress these failures. Focused library and real-service E2E results below remain passing; both deployed services were rechecked active afterward, with `pipedald` at zero automatic restarts. These audit findings are execution evidence, not waived requirements or new implementation approval.

The installed new package SHA-256 is `3b902a6c563e4503e16e5e86087a12d20a21aedd9d791c9352bf998d0ecaed64`; `/usr/sbin/pipedald` is `dc0370fcad3639ffa9e3188162a45b01e418babebcfa4aaef059a4d14527bd17`. Packaged frontend index is `cc9454d05ce66f227ca9022006e89e8476e50b083baf34b4949e2bf5a557f9dc`, main asset `main-CJlcKZP_.js` is `d88086234852e41058d8048662832c3976f6be1b3cce1f1624af72c4bd950173`; deployed bytes match. The previously qualified LV2 binary remains `527c8f60560f3c47fb2e7b3bc86f585c598fdd5e4683d90d970657c9fda4bc77`. Both services restarted, and initial service inspection showed active with zero automatic restarts.

For library rollback, retain subsequent library/test or owner changes first, verify the preceding package and fresh archive digests, stop both services, install the retained preceding package, and stop both services again after package scripts. Restore the exact pre-library frontend and configuration from the fresh archive (a package reinstall alone will lose the former un-packaged frontend overlay); restore only reviewed state changes if necessary, preserving later user data. Restore ACLs with the retained `acl-before.txt` through `setfacl --restore` only when intentionally removing local discovery. Restart both services and verify the owner's bank/preset/MIDI and actual audio. This procedure is prepared for this library rollout; the earlier unrelated old/new technical recovery drill does not constitute exercising this new rollback.

#### Executed Local-Library End-to-End Results

`tools/gig-rig/library_e2e.py` was executed against the running service as `nam`. Evidence is private at `/home/nam/.local/state/pipedal-gig-rig/library-e2e-20261004/`. Discovery returned nine distinct app-origin rigs with zero warnings. All nine were added to new bank **6, TONE3000 Library**, presets **1–9**, without selecting the new bank, altering the running owner board, or reordering existing banks. Duplicate Add returned the same IDs. A disposable NAM+IR app-source rig and uploaded rig/copy extended qualification to **12 saved entries**; distinct upload publication, identical upload reuse and Add as new passed.

All 12 entries passed **516 actual-plugin numeric Get replies**, compared with independently read source parameters and pinned defaults. Cached/saved StateString identity, every exact serialized ChainSnapshot byte (including all embedded NAM/IR caches and settings), provenance SHA, atom type/flags and lack of Program/lilv restore paths were verified against source files. One-preset ZIP exports were independently checked. Malformed, truncated and traversal upload requests returned controlled HTTP 400 JSON; stale source/target hashes and dirty-active Update failed with every saved `.bank` byte unchanged.

The app-source Update test retained bank/preset/plugin IDs and ordering, the seven session values (explicitly exercising loudness `-20`), an actual TooB Delay and a stored snapshot containing the earlier tone version. Active clean Update loaded the new output value `0.63`; snapshot override disclosure remained visible. Browser nonactive Update later applied source output `0.65`, retaining the exact Delay/snapshot payloads and leaving the playing browser-test rig unchanged.

Native Safari exercised the real **Library → Find → Upload → Add → Load → Update & load** controls. A distinct complete NAM+IR fixture was uploaded through the native file picker, saved as preset **13 / instance 1**, loaded through the unsaved-change confirmation, then updated from output `0.43` to `0.67` using the same IDs. The browser correctly refused Update while the current rig was dirty, displayed the save/discard instruction, and succeeded after the normal Save action. Each version passed another 43 live reads and source/export checks. Ordinary host state normalization after restore can mark a rig dirty; the current-rig update safeguard applies until it is saved or deliberately discarded. No automatic overwrite bypass was added.

With the dialog open, an atomic sibling-temp replacement in the allowlisted app folder appeared as **Update available** through the 15-second polling cycle without pressing Refresh or transferring from the Mac. This used a generated preset in the exact installed app format/save path; actual standalone GUI authoring was not operated. Desktop **1434 px** and narrow desktop **574 px** layout checks passed, including wrapped action rows and snapshot text; an actual phone remains untested.

Both services restarted and the browser-updated rig retained its IDs, full source chain, mapped import, saved export and **43 live values**. `pipedald` remained active with **zero automatic restarts** across invalid inputs and qualification. Offline actual-host synthetic DSP passed separately for **Bogner Fullstack (NAM+IR), Stereo Crunch Verb and tsinelas**, each with a fresh empty HOME, no authoring caches, no DISPLAY and a separate disconnected network namespace. Logs are in `library-offline-dsp-20261004/`; the runner verified no external route/connection. These tests establish reproducible synthetic rendering/recall; they do not establish physical listening, latency, seamless switching or gig stability. Live qualification accumulated xruns while switching/running diagnostics, so it is not a zero-xrun performance verdict.

Two test-harness failures were retained as evidence: the first preparation supplied a factory ID as a filename whereas this Pi stores human-readable factory basenames, and a later update check briefly overlapped the still-running recall phase. The path error occurred after nine successful Adds and before test-source creation; source preflight and a guarded `--resume-prepare` now preserve the original owner capture and avoid duplicate writes. The overlapping rejection test correctly noticed bank selection writes from recall; update verification was rerun sequentially and passed with stable bank digests. Neither attempt is counted as a pass.

Cleanup retained a consistent private archive and quarantined the three generated test sources in `/home/nam/.local/state/pipedal-gig-rig/library-cleanup-20261004/`. Only disposable presets **10–13** were removed. The final library has the nine real mapped imports, one per source, with zero warnings. Existing Default/Factory/Reference bank bytes were unchanged by library/E2E operations; a separate archive comparison confirmed the Factory bank is byte-identical to the fresh pre-library backup, SHA-256 `a50b64246f060ca49c7434837e8535be58436f9688fe52881052630121df826f`. The owner’s original clean **bank 5 / preset 27, Dumble Spread**, instance ID and complete numeric state were restored without writing their stored preset. Original bank order remains Default Bank → Factory Presets → TONE3000 Reference; TONE3000 Library is appended.

**Operator flow on this Pi:** save a rig in the installed TONE3000 app, open its **TONE3000 Library** in PiPedal, use **Add**, then **Load**. Save that source again to expose **Update**; a currently playing saved copy offers **Update & load**, with save/discard protection. For raw local `.nam` models and IR `.wav` files, the exact pinned app supports tile drop or context-menu **Load File / Load Folder**; save the complete rig afterward. Its embedded caches follow the same library path. Library Upload accepts complete `.t3kpreset` files, not loose NAM/IR files. Explicit updates preserve footswitch positions through stable IDs; physical Captain events/bindings, listening, rehearsal, actual phone use and cold-boot/performance gates remain pending.

#### Settings, Blocks and Reverse-Sync Review — 2026-10-05T06:00:17.000Z

**Owner feedback and review scope:** Rix successfully loaded newly authored T3K presets and reports that they sound almost the same. This is useful owner feedback, not a matched-level listening comparison or completion of all Human/gig gates. The requested review covers System/Plugin Settings, preset fidelity, block categories/A2 controls and possible reverse sync. Read-only Pi inspection and source tracing were performed with two agents; no source, settings, preset, selection, audio or service changes were made. Library discovery now returns **12 entries / zero warnings**, including subsequent owner additions; retain that data. The following implementation recommendations are **unimplemented follow-up proposals**, not changes to the previously approved import contract. Existing approvals and completed-task evidence remain intact.

**Verified setting scopes:** audited settings/state/chain/UI files on the Pi match the adjacent reference source by SHA-256 at pinned T3K commit `e77b801ce7f75092fb29817e03141d18ece6359b`. Source references below are within that pinned T3K tree unless identified as PiPedal.

| Setting or information | Actual T3K scope and current PiPedal behavior | Follow-up recommendation |
| --- | --- | --- |
| Audio device, input/output channels, sample rate, buffer, enabled MIDI devices | Standalone System Settings, managed by its audio-device service; not tone-preset fields. PiPedal owns its host hardware configuration independently. | Surface equivalent effective **PiPedal host** settings and any comparison with the standalone app; do not blindly mirror a standalone device configuration into the running host. |
| Calibration enable/level and oversampling enable/factor | Four host-session parameters, also persisted as machine defaults only by explicit native Plugin Settings edits. Constructor seeds defaults; restored host state wins. Current numeric PiPedal controls alter session state and do not write the app's machine-default store. | Present persistent T3K processing defaults separately from current instance values, including provenance and explicit application to new/current rigs. Adopt app defaults for new imports through a typed policy; do not silently overwrite saved instance overrides. |
| Multi-core processing | Machine preference `multiCore`, shipped default true; absent from `.t3kpreset` and full StateString. Existing instances hold their own atomic flag. | Provide a verified settings bridge for live application and persistence; file replacement alone does not change running instances. |
| Default NAM A2 size | Machine preference `namSlimSizeDefault`, shipped default Lite. Seeds newly added NAM blocks only. | Expose default Lite/Full without changing already saved block sizes. Explicit per-block edits remain separate. |
| Block Lite/Full, power, normalization, gains, mix, EQ, model/cache and lane/branch | Stored in ChainSnapshot; current converter copies the exact entire snapshot. | Project bounded summaries into block cards and provide supported setters. Never infer block state from global defaults or preset names. |
| Show per-block size/normalization controls; hints/gate/pitch visibility | Presentation preferences in separate `ui-preferences.settings`; not tone/DSP parameters. That file also contains account data. | Read/write only explicitly allowlisted display keys or provide PiPedal-owned presentation preferences; never copy the whole file or expose authentication values. |
| Input mode, monitoring solos, loudness target and MIDI maps | Session/routing/monitoring data, excluded from tone presets. Input mode is stereo/left/right/dual; full host state retains it. | Keep explicit session controls and preserve saved sessions; a global defaults panel is not a reason to make every session parameter global. |

Evidence: `plugin/ui/views/settings/SettingsScreen.cpp:124`, `PluginSettingsPage.cpp:94`, `plugin/src/ProcessorState.cpp:12–28,88–130,275–353`, `plugin/src/ProcessorChain.cpp:280,1180–1188`, and `plugin/include/Processor.h:287–305,365–405`. PiPedal's `src/Tone3000Preset.cpp` parameter table and `BuildState()` confirm that **fresh Add uses pinned defaults for seven session-only numeric values plus stereo routing**, whereas Update preserves the prior session values/routing/MIDI/editor preferences. Because Add supplies a complete StateString, that restore can override any constructor-seeded machine defaults. This is a verified **fresh-import settings gap**, not missing fields in the native tone-preset format.

**Current live comparison:** allowlisted app processing preferences contain `namSlimSizeDefault=1`, `calibrateInput=1`, `inputCalibrationLevel=11.99999809265137`, `osEnabled=1`, `osFactor=0`; `multiCore` is absent and therefore its source default is true (not an observed runtime readback). Service-user `preferences.settings` is absent. App visibility flags explicitly enable per-block size and pitch controls. No account settings were printed or transferred. The currently selected PiPedal T3K instance **1** returns calibration enabled, level **11.999998092651367**, oversampling enabled and factor **0** through four real PatchGets, matching the corresponding app defaults. When enabled, factor index **0 means 2×**, 1 means 4× and 2 means 8× (`Processor.cpp:369–376`); disabled means 1×. Do not attribute the reported sound difference to a currently demonstrated mismatch in those four fields.

The current mapped `Rx Bogner Fullstack - Drop.t3kpreset` matches its stored source hash/name, all **36 preset-managed values** in cached host state, and the **complete 687,124-byte ChainSnapshot byte for byte**. Source and cached blocks include Bogner NAM (`gear=amp`, `slimSize=1`), Marshall IR (`gear=cab`, saved `slimSize=0`, which is not an IR quality control), and Neve NAM (`gear=outboard`, `slimSize=1`). This establishes stored preset fidelity for this selected rig; it does not prove every runtime DSP setting, identical audio paths, or a perceptual null test.

**Block category and A2 semantics:** `toneJson` already retains title/gear/format metadata. Native labels map `amp` to **Amp Head**, `amp-cab` and `full-rig` to **Amp + Cab**, and also identify Cabinet, Pedal and Outboard (`plugin/ui/core/Labels.cpp:12`). Preserve the original category where useful; **Full Rig is capture metadata**, not a switch that converts an amp into a full rig. The native UI offers exactly **A2-Lite=0** and **A2-Full=1**; its display threshold is `slimSize >= 0.5` (`ui/model/ChainState.h:60–63`). The show-per-block-size preference controls toggle visibility; when hidden, a differing saved size still gets a locked indicator (`BlockCard.cpp:296–330`). Actual tier availability is model-dependent, and non-slimmable NAM engines ignore size changes; IR blocks do not use NAM size (`ProcessorModelLoader.cpp:928–930`, `ChainBlock.h:204–212`). Preserve exact stored values and distinguish requested size from verified model capability/readiness. The current 43 numeric LV2 properties provide no chain summary, block-ID setters, multi-core/default-size or input-mode bridge; adding these controls needs a supported worker-safe protocol or an explicit full-state reload, not invented numeric property URIs.

Before using snapshots as editable UI inputs, strengthen native semantic validation for normalized block ranges, `toneId`, and Eq/Band shapes/duplicates. Existing bounded parsing checks framing/types/finite numbers/identity/embedded assets, but `CheckSnapshot()` does not fully validate those additional semantics. This is a malformed-input guard gap; raw preservation and the valid owner-rig comparison above show no corresponding data-loss evidence.

**Reverse sync:** the existing flow is deliberately **T3K file → explicit PiPedal Add/Update → independent saved PiPedal copy**. PiPedal edits remain in its `.bank` state; they do not update the original app file or preferences. Library Added/Update status compares the source SHA with import provenance, not a digest of current local tone edits; it is not a two-way synchronization/conflict indicator.

A reverse **Save back to T3K / Save as new T3K preset** is technically feasible from a verified, settled StateString: emit the exact ChainSnapshot plus the 36 tone-managed Params, valid identity and T3KH header/body. Native `.t3kpreset` intentionally cannot represent the seven session-only parameters, routing, MIDI/editor values or machine/UI settings (`ProcessorPresets.cpp:16,60`, `ProcessorState.cpp:275`). Full session and processing-default synchronization must therefore be separate paths; do not claim a complete session round trip from a tone file alone. PiPedal effects outside the T3K plugin also cannot become T3K blocks through this export.

Recommend **Save as new by default**, preserving original/factory files, with explicit replacement only through a cooperative conflict policy. Track source/import baseline and local tone-state revisions, disclose changes on either/both sides, retain backups, validate identity/size/format, and publish atomically into a fixed authorized writable app store. Current scoped ACLs are read-only and would need a deliberate broker/write arrangement. A server mutex and a final SHA check do **not** exclude a simultaneous standalone save between check and rename; safe replacement needs app cooperation, coordinated locking or an established quiescent authoring session. Never advertise hash checks alone as atomic cross-process conflict prevention.

Publishing a file is also distinct from modifying the running standalone session. `PresetManager` rescans when queried and caches headers by mtime/size (`PresetManager.cpp:125–148`), while native `PresetStore` refreshes at construction/after its own actions, without an external-file watcher (`ui/services/PresetStore.cpp:5–18`). An already open picker may need reopening/relaunch or a new event bridge, and the exported rig must be explicitly loaded. External preference writes likewise do not synchronize existing processor atomics. Automatic live bidirectional settings/preset synchronization is **not implemented or proven**. Qualify any extension with the actual standalone GUI, dirty edits on both sides, replacement races, block capabilities, globals versus saved overrides, restart and audible recall.

#### Proposed Plans and Additional Gaps — 2026-10-05T06:04:03.000Z

Rix requested alternative plans and suggestions for missed work. These are reviewable options, **not an activated implementation scope**. The installed feature remains unchanged. The [official settings-store description](https://github.com/tone-3000/tone3000-plugin#settings-and-where-they-live) and [Plugin Guide](https://www.tone3000.com/guides/tone3000-plugin) corroborate the pinned-source distinction between tone presets, project/session state, processor defaults, UI preferences and standalone hardware settings; qualification remains tied to the installed revision.

| Plan | Concrete result | Scope and trade-off |
| --- | --- | --- |
| A — Correct imports and show what is loaded | New imports adopt an explicit app/device-default policy for the four calibration/oversampling fields; show effective settings versus defaults and read-only chain/block cards with category and saved size. Update retains existing session overrides. | Smallest extension. T3K stays the block authoring tool; existing saved rigs do not silently inherit later default changes and there is no reverse write. |
| B — PiPedal as the main operating surface (**recommended**) | Plan A plus persistent processing profiles, per-rig Follow device defaults / Keep saved settings, input-mode controls, multi-core/default-size handling and an effective block view with supported power/Lite/Full/normalize/gain/mix/EQ editing. | Requires a verified plugin/host bridge and a clear load/snapshot/default-precedence policy. Provides daily operation inside PiPedal while the T3K app continues browsing/building rigs. Defaults update through an intentional apply/reload path; no unexpected audio changes while playing. |
| C — Explicit two-way publishing | Plan B plus Save as new T3K preset, Download `.t3kpreset`, and cooperative guarded Save back; status distinguishes source changes, local tone edits and both-sides conflicts. | More cross-process and permissions work. Tone export and processing-default synchronization remain separate. The app must refresh/load published files; publishing does not replace its live unsaved session. New copies are the safe default where replacement cannot be coordinated. |
| D — Live automatic two-way synchronization | Plan C plus cooperative app notifications, writer coordination and optional automatic application when the affected sessions are clean and the operator permits it. | Largest scope, requires app-side changes as well as host work. Explicit source ownership, feedback-loop prevention, dirty-session conflicts, unavailable-app recovery and protection for the playing rig must be proved. Defer until explicit publication is qualified. |

**Recommended sequence:** implement A's import correctness and typed settings/block summaries first; build B's profiles and block controls on that foundation; add C's Save as new/download before coordinated overwrite. Keep D separate. This sequence gives PiPedal a useful primary surface without making every possible sync mechanism a dependency of the first improvement.

Proposed profile policy: **T3K app preferences are an identifiable source of defaults; PiPedal reports the actual effective runtime state.** Each rig declares whether it follows the Pi/device profile or retains its saved values. Show the profile version/source and pending changes, and define application at a controlled load/apply boundary. Calibration belongs to the actual interface/input path, so never propagate a Mac/interface value indiscriminately to the Pi. Preserve a local last-known profile for offline operation, distinguish defaults from per-block sizes, and report unavailable/stale sources rather than inventing successful synchronization. Bulk migration of existing rigs must preview scope, preserve backups, IDs/MIDI/effects/snapshots and unrelated state, and never silently rewrite them.

**Additional work worth including:**

| Priority | Addition | Why / proposed acceptance |
| --- | --- | --- |
| Core | Mono/stereo/left/right/dual routing, pan/polarity and input/output level comparison | Preset equality does not establish equal host paths. Display input mode and lane/branch topology; compare app versus PiPedal paths and gain staging before attributing a sound difference to a model. |
| Core | Full block details and model identity | Show category, active model, IR, enabled state, normalization, calibration metadata, gains/mix and EQ. Bound server-generated summaries and use state revisions; do not repeatedly ship/parse model blobs in the browser. Unsupported capabilities remain readable rather than editable through guessed properties. |
| Core | Truthful A2 and load status | Preserve requested size, show actual capability/confirmed effective size only when available, and provide loading/error evidence from the plugin. Stored bytes, a size chip or a fixed timeout are not a readiness verdict. |
| Core | Source/local change and conflict indicators | Current Added/Update status covers source provenance only. Compare tone-specific baseline/source/local revisions separately from excluded session settings; distinguish both-sides changes and avoid implicit merges of chain/model edits. |
| Core | Snapshot policy | Existing snapshots retain prior tone versions. Define whether a change targets the base rig or selected snapshots; show overrides. Prove that Follow defaults behaves consistently across snapshot recall, keeping IDs/footswitch actions stable. |
| Core | Targeted malformed-input validation and round-trip checks | Close the block-range/toneId/Eq semantic guard gaps before exposing edits. Test import/export/import with exact embedded assets and managed values; retain unknown supported data and reject unsupported schemas cleanly. |
| Useful | Audition/compare and one-action recovery | Provide level-matched source/import comparison and restore the prior rig/settings after audition. Retain an undoable prior tone/default version for updates and publish operations; exact owner restoration must preserve concurrent edits. |
| Useful | CPU/headroom view with quality changes | Show actual host metrics alongside Lite/Full, oversampling and multi-core. Measure representative boards, deadline failures, temperature/throttling and switching; no guessed safe quality threshold or automatic downgrade. |
| Useful | Performance lock and offline status | A playing rig can pin its qualified profile/version and defer detected changes until explicitly applied. Indicate whether the saved rig contains required model/IR data, then prove disconnected restart/cold boot rather than treating the indicator as sufficient. |
| Useful | Physical MIDI and stable rig identification | Map supported block power/size actions through verified routing and preserve bank/preset/plugin IDs. Test the connected Captain, actual app GUI, phone, dirty sessions on both sides and restart; prior narrow-browser/synthetic checks are not substitutes. |

For each selected stage, refine Spec → Design → Tasks before delegating implementation. Prove actual standalone saves and refresh behavior, global defaults versus saved overrides, current/saved/snapshot application, tier capability, simultaneous saves and offline recall. Keep existing broad-test failures and Human/gig gates visible; adding controls or publication alone cannot close them.

### [DES-OPERATE] Approved Plan B — PiPedal Tweaks and Processing Profiles

**Authorization:** Rix selected Plan B, accepts explicit T3K overwrite of PiPedal tone tweaks, wants minor adjustments at home/studio/live, and explicitly requires both System and Plugin settings, with existing host fields read-only. Previous delegated approval covers staging Spec → Design → Tasks and continued authorized implementation/E2E. Plans C/D remain unselected; no reverse writes or app modification. Earlier option/review records remain historical proposals; this section defines the activated contract.

**Settings ownership and storage:** add three fixed named profiles Home/Studio/Live, initially identical to the verified readable app defaults, otherwise existing service preferences or pinned defaults with source status. Never claim these initial copies are measured optimal configurations. Each profile holds the six processing preferences: bool multiCore, NAM default size 0/1, bool calibrateInput, calibration level within -60…60 dBu, bool osEnabled and integer osFactor 0…2. Store the profiles/active selection and the six active processor keys in one authoritative service-user `preferences.settings` file (private PiPedal profile JSON in a separate XML VALUE key). Native T3K ignores that extra metadata. Resolve effective service HOME/XDG, validate fixed file/ancestors and stable reads, reject links/DTD/entities/oversized XML, preserve unknown entries and ownership, retain exact private prewrite backups, write/fsync/publish atomically. Use a real XML parser such as libxml2 with network/entity resolution disabled; add/install its development dependency if required in the isolated Pi build. Do not infer a cross-file transaction.

Read the app's processing preferences only at a fixed sibling filename of configured preset roots and expose only the six typed keys. Set a narrow read ACL on that file when required, not account/UI preferences. No runtime browser-selected paths and no writes to the app store. Saving/activating a profile updates persisted defaults and **does not mutate the playing rig**. Explicit Apply or later plugin construction/load uses it. Multi-core/default NAM are constructor-owned machine globals, not per-rig overrides; state-preserved block sizes always remain unchanged until explicitly edited. Other currently running instances may retain earlier machine flags until rebuilt; the UI states this reload scope rather than claiming a live cross-process global update.

**Per-rig policy:** add optional `tone3000FollowDefaults` item metadata, false for old/missing fields and true for fresh library Adds; preserve it in native/browser state, saved banks, updates and snapshots through existing item identity. Follow applies the active profile's four calibration/oversampling session parameters at clean saved-rig load/startup and snapshot application, not every poll/state update. Dirty-session recovery preserves current unsaved values. Keep saved settings preserves those four values. Manual edits to those fields, including existing numeric Patch Set controls, select Keep saved settings unless the operator explicitly selects Follow/Apply. Fresh imports seed these four profile values rather than pinned defaults. Explicit library Update retains session overrides/policy and surrounding effects while replacing the exact tone/chain as previously defined. No automatic rewrite of other saved presets or old snapshots.

**Codec and block editing:** extend the bounded native codec with `SummarizeState` and `EditState`, using typed JSON DTOs with optional sparse fields. Return active preset ID/name, input mode, the four processing values, stereo/branch topology, and compact block summaries (stable block ID/lane/index, kind, title/category/format, active model ID, power, NAM normalization/size, normalized gains/mix and EQ). Never return embedded model bytes, URLs, tokens or arbitrary metadata. Requested size is 0/1; model capability/readiness remains unknown unless independently verified. IR size/normalization setters are rejected. Insert-only slots are displayed separately, not passed as NAM controls. Preserve every unedited raw property/tree/cache and unrelated LV2 state entries.

Validate finite normalized block fields in [0,1], power/normalize bools, unique edits/IDs, allowed lanes/types and Eq shapes/duplicates/tone identity. EQ has six pinned role-specific bands, 20–20000 Hz, gain ±15 dB, Q0.1–10: band 0 lowcut/lowshelf, bands 1–4 bell, band 5 highshelf/highcut. Missing legacy EQ uses native defaults for display; do not rewrite it until an explicit EQ edit. Root routing supports stereo/left/right/dual, but reject requests for stereo/dual when the pinned branched-stereo state would coerce them to left. No add/delete/reorder/swap editor is introduced.

**Runtime path and API:** `getTone3000Defaults` returns revision, activeProfile, profiles `{id,name,defaults}`, active defaults, optional appDefaults, sourceStatus and warnings. `setTone3000Defaults` takes expectedRevision, activeProfile and defaults, validates/backs up/publishes the single store, then returns refreshed state. `getTone3000CurrentState({instanceId})` freshly captures actual LV2 state with an explicit success/failure result and returns `{revision,instanceId,followDefaults,summary,hasSnapshotOverrides}`. `setTone3000CurrentState` takes instanceId/expectedRevision, sparse codec patch and optional followDefaults/applyDefaults; recapture and compare before mutation, reject stale/unknown input, clone current board preserving IDs/effects/MIDI/snapshots, apply patch/profile and use the existing safe host rebuild/dirty lifecycle. Normal PiPedal Save persists tweaks; requests never silently write the saved preset or source app file.

Add an optional force-reload ID set to the existing PluginHost reuse-map path; exclude only those IDs when explicitly applying constructor settings, preserving other effect instances. Do not falsify state bytes/revisions to defeat reuse. AudioHost needs an explicit state-capture success API because existing UpdatePluginState conflates unchanged with capture failure. State/profile revisions guard concurrent clients and actual audio/selection changes; a failed capture is a controlled error, not a summary of stale bytes. SET returns an **accepted** boolean rather than an immediate captured-state claim. Track the intended summary per changed instance; GET must observe its identities/settings/routing/processing fields (with numeric float tolerance and native insert padding) before clearing the apply guard. Normal Save/SaveAs also require that observation, avoiding capture of transient wrapper defaults. GET pending errors cause UI polling with editing disabled; no fixed delay is success/readiness evidence. Save/recall and metadata normalization use existing supported lifecycle behavior. A structural/block/EQ/profile Apply can briefly reload the selected T3K instance; it is **not a seamless-switch claim**, and no extra T3K/JUCE patch is planned. This bounded asynchronous-state safeguard was reviewed/reapproved under the same delegated Plan B scope before execution.

**Operator UI:** preserve Library and existing 43 controls. Add Blocks and Settings surfaces, with responsive cards/fields and explicit Apply for drafted block/EQ/routing edits. Provide Follow device defaults / Keep saved settings, effective current values, snapshot override notice, selected profile and Save defaults / Apply to this rig. Home/Studio/Live selection fills an editable draft; only Save defaults stages/activates it. Provide explicit Use T3K app defaults when readable. System device/driver, effective sample rate/block length, configured buffer count, input/output channels and enabled MIDI inputs come from existing PiPedal observable/RPC state and are **read-only**, with stopped/restarting/unknown status shown accurately. CPU/xruns reuse host status; no duplicate hardware setters, fake readiness or guessed safe quality thresholds. Preserve drafts during polls; discard stale responses after switching selected instance; serialize mutations and show actionable errors. The initial patch-based structural edit remains an explicit Apply to avoid reloading on every slider movement.

**Read-only chain presentation:** expand each actual TONE3000 node directly in PiPedal’s **main chain view** with the ordinary icon frames, spacing, labels, connectors and selection highlight. Rix rejected the large outlined group/header after live review: no enclosing border, background, extra header or duplicate inner input/output dots. Reuse the existing renderer in a nested read-only mode with an isolated display-only projection of freshly captured T3K summary blocks. Prepend one stock TONE3000 marker using the actual parent's plugin type and input-channel representation; it identifies ownership before the internal blocks. Clicking it selects the actual host ID and clears internal-block focus; it is display-only, not an extra audio processor. Include that ordinary cell in the measured layout, then trim/omit terminal cells so surrounding effects connect to the marker and final internal block/join. Preserve actual host position, real internal order/power/kind/title and supported branches; do not move the T3K instance ahead of existing host effects. Reading/error/empty fallbacks retain the existing real icon without an extra marker. The outer layout retains exactly one real host item/ID for the composite; local display IDs never enter outer host items, model setters or preset storage.

Each supported internal block icon provides view navigation: it selects the real parent, opens Blocks and focuses that captured block’s bounded settings card. The isolated renderer maps local display IDs to actual source block IDs; the selected block uses PiPedal’s ordinary highlight. This navigation never writes state; supported tweaks still require explicit Apply and normal Save. Internal dragging, double-click structural actions, context menus, add/delete/replace/reorder and live host subscriptions remain disabled because T3K owns structural authoring. Whole-plugin actions remain available through the existing selected-plugin toolbar; the inline children do not expose a whole-plugin drag handle. Compact fallback host icons retain ordinary host actions. Remove the duplicate lower-panel chain preview and omit empty slot cards; Blocks remains the editing surface.

**Main-chain capture boundary:** a functional wrapper around the existing main renderer owns a `tone3000Chains` map keyed only by real instance IDs. It observes host board/session and per-instance LV2-state changes, obtains summaries through the real `getTone3000CurrentState` capture service, and handles instances inside actual host splits. Request generations suppress responses from replaced boards/disconnected sessions; LV2 events during in-flight captures are coalesced into one follow-up read; unchanged captures do not broadcast again. Audio-configuration changes invalidate summaries and retry actual capture, without assuming WebSocket readiness implies audio readiness. Retry explicit pending-capture results; transient unavailable capture receives at most three additional actual reads (1/2/4 seconds), retaining an error if still unavailable. New state/audio events permit a fresh attempt; never treat elapsed time as success. Do not continuously capture every unselected instance. Summary errors remain visible and never fabricate routing. Pure topology tests cover stereo/branch/pass-through and rejection; browser verification separately checks placement, connectors, group selection and ordinary host actions. Gain fields display the pinned `(normalized−0.5)×48` dB conversion, and mix displays percent; API/storage remain normalized.

**Verification/rollout:** focused codec/profile/metadata/reload tests, static `/afx-check path` trace before gate completion, TypeScript/build, real native sources and service tests. Back up current owner selection/dirty state, exact current banks/config/preferences/frontend/package consistently; add scoped read ACL, build/package in isolated Pi checkout and install qualified artifacts. Test defaults staged without audio change, readonly System equivalence, current/old/fresh Follow policy, sparse block/EQ/routing changes, invalid/stale refusal, exact preserved assets/IDs/effects/MIDI/snapshots, Save/recall/restart, explicit T3K overwrite and narrow browser UI. Use disposable copies and restore owner state without overwriting concurrent edits; never erase new owner library entries. Measure reload gaps where possible, retain prior broad-test failures, and leave physical/listening/rehearsal/phone acceptance separate when unobserved.

#### Plan B technical execution — 2026-10-05T07:50:21.000Z

**Source/path gate:** typed codec/profile operations are implemented in `Tone3000Preset`, `Tone3000Defaults` and `Tone3000Operations`, routed through `PiPedalSocket` to the actual `PiPedalModel`/`AudioHost` capture, forced selected-instance rebuild and ordinary storage lifecycle. The frontend Rig panel sends the four real typed RPCs; readonly System subscribes to existing host observables/status. MainPage uses the summary wrapper, which calls actual current-state capture and supplies isolated projection data to the existing renderer. Block navigation maps local IDs to source block IDs, selects only the actual parent and focuses the bounded editor; it never sends synthetic graph items to setters. Explicit Apply validates sparse drafts and awaits acceptance plus actual capture; Save retains the native pending-state guard. Retry timers perform actual reads, not simulated completion. No missing/mock path was found during source trace; gate precedes task completion.

**Native gates on the Pi:** codec/edit tests passed **1478 assertions / 18 cases**; actual eight Factory source fixtures **34 / 1**; final defaults/request/lane-order guards **98 / 4**; Library regression **69 / 5**; private-HOME forced real-effect reload **9 / 1**. Tests verify raw NAM/IR assets, metadata/legacy EQ, sparse edits, invalid/duplicate/stale requests, strict XML/profile persistence and native semantic normalization. Earlier broad-suite/allocation/hardware failures remain recorded; these focused gates do not establish a globally green suite or real-time DSP safety. T3K binary remains pinned v0.0.11, SHA-256 `527c8f60560f3c47fb2e7b3bc86f585c598fdd5e4683d90d970657c9fda4bc77`.

**Consistent deployment/recovery:** private Pi evidence root `/home/nam/.local/state/pipedal-gig-rig/plan-b-e2e-20261005-0628/` is 0700; files are 0600 (the second archive is root-owned). Both host services were stopped while preserving ACLs/xattrs/numeric ownership for state/config/app processing preferences. `before-plan-b.tar.gz` SHA-256 `3d94f2c821b739703361f3126552720e9491ec2dc6093fcf1a87048e7377b98b`; `pre-chain-package.tar.gz` `5363e8d577b75fcbf857069aea2a1c1b6fe95e635d8f9bc87e7595d793eca9b4`. Exact preceding Library package retained as `previous-pipedal_2.0.110_arm64.deb`, SHA-256 `3b902a6c563e4503e16e5e86087a12d20a21aedd9d791c9352bf998d0ecaed64`. First Plan B package `d26f2de1853c4af407b989df1e35f2b373ad178fe3995d20c99dab7becba2a33`; later package with lower-chain preview `c6d32f6dca2ed2772d3679088f285bbc6b4dbeec8e059c39f87919c43aab0ad0`. Both use native binary `c34becd6a71dcbeed8dc3827b71f2c8f6dec9f24cc807a14886a593db1055031`. Only `/home/nam/.config/TONE3000/preferences.settings` received the extra service-user read ACL; no app authentication/UI file write or broad access was introduced. Installed libxml2 development support is 2.9.14.

**Actual defaults/policy results:** the app seed was multi-core true, default NAM Full (1), calibration true/~12 dBu, oversampling true/2× (0); all three initial profiles intentionally copied these values. `operations_e2e.py` exercised a fresh disposable Factory Bogner target with real Delay/snapshot/MIDI composition. Staging all six Live preferences changed persisted defaults but left actual running state untouched. Explicit Apply observed the four session fields after selected forced rebuild while retaining saved block sizes. Both typed/manual processing changes and ordinary numeric Patch Set selected Keep saved settings. Clean Follow load and snapshot recall adopted later Home settings; normal Save succeeded. After package/service restart, actual current revision/summary, profiles and clean dirty flag matched exactly (`restart-result.json`). This checks persisted settings/state; it does not prove an audible reload gap, internal worker completion or seamless switching.

**Actual tone/edit/overwrite results:** sparse block power, normalize, Lite/Full, gain/mix and six-band EQ changes were captured from the real plugin and passed normal Save/export/Load. Independent raw asset hashes remained exact; surrounding Delay, snapshots, MIDI and identities stayed intact. Invalid/stale edits and profiles were refused without changing current revision. Explicit T3K Library Update replaced local tone/block changes while retaining the selected processing policy/values and host composition. These results are retained in `operations-result.json` and `operations-follow-result.json`; app-origin rigs/models/IRs were not written back.

**Concurrent owner changes:** Rix changed selected presets during qualification and authorized continuation. The original test restoration guard refused to overwrite that newer selection. Cleanup restored the three staged profiles to their baseline Home values and deleted only disposable preset 18; subsequent inspection confirmed bank 6/preset 17 clean and no test clone. A selection-identity assertion encountered another concurrent change during cleanup, so no pass is claimed for that assertion. Initial dirty preset-15 evidence and later clean preset-8 evidence remain private; neither was forced over the newer owner state. Current main-chain readonly checks later used the owner-selected clean preset 2. Owner-selected audio configuration was then USB Audio, 48000 Hz, 128×6, with Pico MIDI Captain and Midi Through enabled; the agent did not reset it to older measurement settings.

**Intermediate main-chain preview:** TypeScript/Vite production builds and 14 pure frontend tests (eight topology/geometry, three layout, three sparse draft) passed. The outlined-group preview was deployed through `deploy_frontend.py` with exact static rollback backups at `main-chain-deploy-20261005-0737/` and `main-chain-deploy-20261005-0745/`. Deployment reported verified incoming files and no observed state changes; native PID 22923 and zero automatic restarts were retained. Real Safari showed correct order and click-to-cab-settings focus, Settings→Blocks navigation, readonly System values and no internal structural context menu. Private `main-chain-browser-before.json`/`after.json` comparison showed **no changes** to board, banks, presets, audio or profiles; preset 2 remained clean. A caption overflow and scroll placement were corrected. Rix rejected the frame/header appearance afterward; this preview is historical evidence only, not acceptance of the final ordinary styling.

**Final inline verification procedure:** `chain_e2e.py` creates a fresh disposable Factory Bogner target only from a clean current owner baseline; it places real Tuner and Delay before/after the single T3K host, retains private exact owner/current state and guards each phase. Browser navigation must show ordinary inline icons/labels/connectors, highlight the clicked source block, open its card, draft IR mix 99%, explicitly Apply, observe captured success and use ordinary Save. The verify phase independently checks that only that mix changed, raw assets and surrounding effects remain exact, saved export and clean recall match. Restore refuses concurrent board/current/default/audio changes before removing only the disposable target and reloading the clean baseline. New owner changes are retained rather than overwritten. Evidence root `inline-chain-e2e-20261005-0750/`; target initially prepared as bank 6/preset 19/instance 1. Final inline results/artifact digests are appended after verification.

**Final plain-inline result — 2026-10-05T08:04:48.000Z:** the corrected renderer uses stock PiPedal icon/label cells and connector strokes, with no enclosing frame/header/background or inner terminal cells. The existing projection is validated before expansion; unsupported/empty states fall back to the actual host icon. Outer connectors reach the first block and final block/join without drawing a shortcut across internal branches. Block clicks retain stock individual-icon selection, map to the real parent, switch to Blocks and scroll/focus the matching card. Custom purple settings-card outlines were removed as well. Source guards prohibit internal drag, double-click structural actions, context menus and host setters; only supported NAM/IR icons expose view navigation. No new host graph item is registered.

Fifteen frontend tests passed (nine topology/geometry/bounds plus six existing layout/sparse-edit tests), with TypeScript/Vite production and full package builds successful. Real Safari verified the final plain chain on the owner-selected Dumble Spread and Bogner rigs; clicking the cabinet focused its actual settings and displayed normal stock icon selection. The private final-inline before/after comparison showed **no changed board, bank, preset, audio or profile fields**, with preset 2 clean. Mono/plain appearance and individual node click were observed; stereo branch semantics remain covered by pure projection/geometry and real source-state gates, while physical phone and final live multi-effect layout/form submission acceptance remain separate.

The final full package is retained at `/home/nam/pipedal-gig-rig-build/build/pipedal_2.0.110_arm64.deb`, SHA-256 `3b7deccaac8eb8219c25e8ece77b0083557b763beafd613d8eb3b6a61a48586d`. It was **built, not installed**: only its qualified frontend was overlaid onto the already deployed Plan B native package, avoiding another audio restart. Live `index.html` SHA-256 `0b565673ca4861774a9450ebec3100c0b8b2a6e963732f4351cf32129a209df9`; `assets/main-B7iu61f1.js` `00f6e8aa552a61151a0be5f3bd12d80fde4048a1d60e83e851f473df8c411f0c`. Exact static rollback evidence is under `inline-chain-deploy-20261005-0755/` and final `inline-chain-deploy-20261005-0805/`. Both publishes verified incoming files and recorded no observed state changes. Both services stayed active, native PID remained 22923, automatic restarts remained zero. Reload existing browser pages to obtain these new assets.

**Disposable browser fixture outcome:** preparation passed for preset 19 with real Tuner/T3K/Delay, but Rix subsequently selected other rigs. The new browser Apply/Save/recall phase was not run against that displaced fixture and is **not counted as a pass**. Its guarded inactive cleanup compared the untouched saved fixture with the captured composition, retained a fresh latest-owner snapshot and removed only that fixture through the existing `updatePresets` index path. This avoids the stock `deletePresetItems` neighbour-selection return, which can reload another rig even when deleting an inactive entry. The generic reindex path rebuilds bank metadata; whole-bank raw-byte identity is not claimed. Existing saved entries/order, current board/selection/dirty flag, bank index, audio and profiles were verified unchanged. `chain-cleanup-result.json` records success; no earlier captured rig was forced over the latest owner selection. At 2026-10-05T08:04:48.000Z, [3.14] remained open for the final actual browser form→Apply→Save gate; native/service tone edits, Save/recall/restart and overwrite gates passed as recorded above. At that point, the final inline surrounding-effects/stereo/narrow browser gate in [3.15] also remained open; source/pure-test gates and final mono navigation are complete.

**Final browser E2E completed — 2026-10-05T08:16:57.000Z:** after the renderer was settled, a fresh Factory Bogner disposable copy (bank 6/preset 20/instance 1) was prepared from the current clean owner preset 2, with real Tuner before T3K and Delay after it. In actual Safari, clicking the cab opened its matching card; native keyboard input changed mix from 100 to 99%. Apply reported captured completion, the preset became dirty, and the normal top Save button cleared the dirty flag. `chain_e2e.py verify` independently confirmed that **only IR mix** changed (float tolerance), raw NAM/IR assets stayed exact, surrounding effect objects stayed exact, saved export retained the data and clean recall returned the same summary. Selecting the actual surrounding Delay opened its normal controls; clicking the cab returned to the bounded T3K editor. At increased Safari page zoom, the narrower desktop viewport exposed stock horizontal/vertical chain scrolling and scrollable tabs; zoom was restored afterward. This is desktop narrow-layout evidence, not a physical phone verdict.

A second disposable Factory Stereo Fuzz copy (preset 21/instance 1) retained real Tuner/Delay around the T3K host. Actual captured stereo state and the browser diagram matched: shared Sovtek prefix, upper Magnatone/lower RR AC30 branch, existing L/R splitter/join, then the real Delay. No enclosing box/header/background/dummy terminals or straight shortcut crossed the branch. Clicking RR AC30 focused the correct right-lane settings; a right-click opened no structural menu. `inspect-stereo` verified the full actual board/summary remained unchanged and clean after navigation. The source and pure-renderer guards continue to disable internal drag/double-click/context structural writes.

Both guarded restores passed sequentially, removed only test presets 21 and 20 and recovered the clean owner bank 6/preset 2 with exact actual summary/assets, unchanged audio and unchanged profiles. Earlier fixture 19 had already been removed by inactive cleanup. Final inspection found **no IDs 19/20/21**, clean preset 2, both services active, native PID 22923 and zero automatic restarts. Private results are in `inline-chain-e2e-final-20261005-0810/{chain-result,chain-restore-result}.json` and `inline-stereo-e2e-20261005-0812/{chain-stereo-result,chain-restore-result}.json`. The two live browser screenshots around Apply showed accumulated xrun count changing from 2 to 3; causality was not measured. These passes qualify settings, persistence and presentation, not zero-xrun or seamless performance. Artifact hashes remain those of the final static publish above; test helper changes require no binary/UI redeployment.

**Remaining acceptance:** actual phone usability, listening, physical Captain actions, reload-gap measurements, rehearsal/xrun/latency qualification and cold boot remain unobserved gates. Internal native MIDI edits arriving during an outstanding apply can keep the intent guard pending until explicit load/discard; no timed success or audible-readiness verdict is inferred. Do not mark these human/performance criteria complete from XML, state or browser checks.

**Read-only T3K control-coverage audit — 2026-10-05T08:44:58.000Z:** at Rix's request, independently enumerated parameter IDs from the actual Pi checkout at `e77b801ce7f75092fb29817e03141d18ece6359b`, installed system `dsp.ttl` declarations of type `lv2:Parameter` and `Tone3000ControlLayout.ts`. All three sets match exactly: **43 parameters, none missing or extra**. The installed system binary still matches the qualified `527c8f…4bc77` digest; both services are active. The sibling Mac checkout has moved to `ef6f178ae1ac6412b55fec6f058d86e640e5aaaf`, so its current source was not substituted for the installed processor's contract. The three layout/order/fallback tests pass. No runtime values, presets, device settings or binaries were changed; this audit adds evidence, not new implementation scope or acceptance.

Parameter completeness is narrower than native-editor parity. Comparing pinned `Faceplate.cpp`, `StereoImageGroup.cpp`, `gallery/StereoPanRail.cpp`, `block/BlockCard.cpp`, `block/BlockEqView.cpp`, `settings/PluginSettingsPage.cpp` and `backend/Backend.h` against the current PiPedal view and bounded state API found these open gaps:

| Native T3K feature | Current PiPedal coverage / gap |
| --- | --- |
| Ordinary tone/gate/pitch/spread/align/pan/solo/polarity/calibration/oversampling controls | All 43 are mapped, across Tone/Space/Pitch/Setup. The Settings surface additionally provides processing policy/profiles. Several normalized faceplate controls still show raw 0–1 rather than T3K's dB, percent, sided milliseconds, crossover Hz or pan readouts; block gain/mix fields already convert to dB/percent. |
| Linked pan motion and exclusive solo | The parameters exist, but native `StereoPanRail` implements mirroring, symmetric re-linking, half-range pan restrictions and clearing the opposite solo in editor callbacks. PiPedal's generic patch controls do not implement those companion actions. Processor source identifies `chainPanLinked` as a UI behaviour flag; exposing it alone does not produce linked knob motion. |
| Auto Balance / Auto Align | Manual balance/alignment controls exist; native start/cancel/poll measurement actions have no PiPedal bridge or buttons. |
| Calibration gauge / normalization override | Calibration settings exist. The bounded block summary omits loaded-model input/output dBu metadata and downstream calibrated handoff status. Native T3K can disable normalization when calibrated output feeds another NAM; PiPedal currently displays the saved normalization flag without that effective-override explanation. Requested Lite/Full is displayed, while actual engine capability remains unknown. |
| EQ curve, spectrum, block meters and reset actions | Six-band type/frequency/gain/Q, power and pre/post editing exist. Native curve/slider visualization, live spectrum, per-block meters and dedicated reset gestures/actions are absent. |
| Model selector and detailed tone information | Category/title/active model ID are shown; no native model-name list, capture calibration details, images/descriptions/tags or catalog favorite/share actions are exposed in the embedded block editor. Model replacement remains T3K authoring work under the selected source-of-truth policy. |
| Native UI preferences and plugin MIDI mapping editor | Show Gate/Pitch/Info Bar/per-block-control visibility preferences and T3K's MIDI Learn/map editor are not mirrored. PiPedal's host System/MIDI settings remain separate; preserving opaque native MIDI data does not mean this panel edits its mappings. |

Recommended future priority is human-readable units, linked-pan/solo semantics and truthful calibration/normalization status before visualization or automatic measurement bridges. Structural stereo/branch changes, swaps, removal/replacement/reordering remain intentionally in T3K, followed by explicit Library Update. No new task is marked complete and existing Human/gig gates remain open. Spec/design/tasks remain Approved; this evidence-only audit does not change the approved contract.

**Owner's next priority and Chocolate investigation — 2026-10-05T09:12:24.000Z:** Rix prioritizes missing usable knobs/settings and Auto Balance over the previously suggested diagnostic-report/UI additions. Pinned `Processor.h`/`Processor.cpp` and `services/AutoMeasure` confirm that native Auto Balance listens for approximately two seconds of signal above its floor, times out after fifteen seconds without enough signal, and applies the measured internal L/R chain mismatch through `outputBalance` on the message thread. This is internal-chain balancing, not loudness matching between different saved PiPedal presets or host T3K instances. Start/cancel/status/result actions are not exposed by the existing PiPedal numeric patch interface; a real plugin bridge and thread/state validation are necessary before offering this button. Auto Align is a separate native probe action that temporarily mutes output, not the same measurement. Next scope refinement should prioritize Auto Balance, unit/pan behaviour and truthful effective calibration/normalization status; no new implementation or completion is claimed by this investigation.

Rix reports a Chocolate v1 connected by USB. Two read-only inspections (`lsusb`, `lsusb -t`, `/proc/asound/seq/clients`, `aconnect -l`, `amidi -l`) show keyboard/mouse/Jogg but **no Chocolate/SINCO USB MIDI or raw MIDI device**. Both PiPedal services remain active; no MIDI inputs, presets or controller firmware/configuration were changed. Asked Rix to power on/reconnect with a known data cable and identify whether a wireless receiver is involved. Device mode/messages and PiPedal usability remain unverified until enumeration and actual switch capture. The [manufacturer downloads page](https://www.m-vave.com/download) identifies CubeSuite USB configuration support for Chocolate; the [original Chocolate protocol investigation](https://github.com/cbix/mvave-chocolate-sysex) demonstrates ALSA SINCO MIDI and Program Change configuration. These sources support a potential MIDI path, not successful operation of this particular attached v1. Do not substitute Chocolate Plus U/HOST instructions or flash firmware to guess the connection. Once enumerated, inspect PC/CC/channel/press-release behaviour before assigning existing PiPedal preset/host control actions; numeric T3K patch-property MIDI remains deferred. This records priorities/device evidence; existing approval stages remain Approved and no requirement or acceptance gate is waived.

**Parent marker delivered — 2026-10-05T09:23:40.000Z:** the four-file frontend change prepends an ordinary display-only TONE3000 cell before the internal projection. Source tracing confirms `Tone3000PedalboardView` supplies focus clearing, `PedalboardView` selects the actual host ID, and `Tone3000ChainView` handles isolated local display IDs without passing them to host model/state setters. Measured layout includes the marker; routing projection and actual audio graph are unchanged. The 15 focused frontend tests (topology/geometry, control layout and rig draft guards) pass. The isolated Pi TypeScript/Vite production build passes with 1,765 modules; no native rebuild or new full package was required.

Guarded static deployment at `/home/nam/.local/state/pipedal-gig-rig/parent-marker-deploy-20261005-0918` reports `index_published: true`, `entry_state: incoming`, verified published files and no changed observed owner fields. Current live `index.html` SHA-256 is `a2e1619645d8402bc5ee797cf81068c4ede099fd153775cde3f9859e8d593a8a`; `assets/main-Cagb-sPm.js` is `80db05494acbfd0ab8b9f39b4517eb31004728abddb3e455ea7769eb273f961c`. This supersedes the earlier static frontend, while its recorded full-package artifact remains historical. Native PID 22923 and automatic restart count zero were unchanged at publication; the private deployment backup retains rollback assets.

Actual Safari showed the owner-selected **Rx Bogner Fullstack - Drop** mono chain with input → stock TONE3000 marker → amp/cab/outboard → output and no enclosing frame/header/duplicate terminals. Rix then selected **Stereo Crunch Verb** independently; that actual captured chain retained its shared prefix, splitter, both branches and join after the marker. Clicking the right-lane VOX block focused its matching settings and highlighted only that internal icon; clicking the parent marker cleared internal focus and restored the stock parent highlight. The preset name remained clean and the accumulated xrun counter stayed at five during these navigation checks. No values, Save/Apply, rig selection or test fixtures were written by this verification. Guarded publication verifies owner-state preservation; navigation evidence is visual plus source tracing, not a new full-state byte comparison or audio-performance qualification. Human phone/listening/controller gates remain pending. Spec, Design and Tasks remain Approved.

**Chocolate detected during live logging — 2026-10-05T09:30:40.000Z:** at Rix's request, restarted only `pipedald`; both services returned active, with audio daemon PID 28784 and automatic restart count zero. Initial USB/raw-MIDI/sequencer inspections still found no controller. A subsequent bounded live kernel/PiPedal journal follow and USB/sound udev monitor captured connection of `4353:4b4d Jieli Technology SINCO` at 2026-10-05T09:30:00.000Z. One initial descriptor read reported error `-71`, followed by successful enumeration and MIDI 1.0 fallback. ALSA now exposes raw port `hw:3,0,0` and sequencer client 28:0, `SINCO MIDI 1`. This supersedes the earlier absence observation. The port is not connected to PiPedal's sequencer input; no input enablement, mappings, switch messages, firmware changes or physical action success are claimed. Both bounded monitors ended normally at their timeout; no additional disconnect was observed during that interval. Next qualification requires switch-event capture and persistent PiPedal input configuration before assigning actions.

**Chocolate switch capture — 2026-10-05T09:39:35.000Z:** Rix confirms the earlier cable was wrong. A fresh sequencer inspection now shows SINCO 28:0 already connected to PiPedal 129:0; this connection was observed, not created by the agent. A bounded sixty-second `aseqdump` subscriber captured three SysEx messages while Rix was asked to press the four switches in order and then confirmed completion. Payloads were `F0 0F 0F 00 01 00 00 00 06 01 01 04 03 03 03 00 00 00 00 00 00 F7`, `F0 09 0D 00 01 00 00 00 06 01 01 04 03 03 04 00 00 00 00 00 00 F7`, and `F0 08 0B 00 01 00 00 00 06 01 01 04 03 03 05 00 00 00 00 00 00 F7`. No CC/Program Change or fourth distinct event was captured; one-to-one physical button identity and message semantics are not established. The simultaneous USB/PiPedal tail recorded no new connection errors during that capture; both services remained active. Existing USB MIDI plumbing works, but preset/control operation is not qualified from these proprietary messages. The protocol investigation linked above documents a standard Program Change mode, but its example configuration envelope differs from these observed payloads; no guessed SysEx configuration write, firmware change or preset mapping was sent. Both monitors exited at their timeout. Next step is inspect the actual Chocolate mode in its official configuration app, then recapture standard MIDI before assigning actions.

**Chocolate standard CC qualification — 2026-10-05T09:52:57.000Z:** Rix configured Custom Control on Android CubeSuite, selecting CC20/21/22/23 for A/B/C/D and momentary behaviour. The first capture observation contained no events; after explicitly asking for another ordered press/release while the subscriber was active, actual `aseqdump` received all eight standard messages: CC20, CC21, CC22 and CC23, each with value 127 followed by 0. ALSA reports channel 0 (zero-based), corresponding to user-facing MIDI channel 1. SINCO remained connected to PiPedal 129:0 and the separate diagnostic subscriber; no new kernel entries appeared in the three-minute connection check. This qualifies transport and the ordered four-switch CC/press-release pattern, superseding the earlier SysEx-only configuration observation. No PiPedal action mappings or preset/control writes were performed by this capture; physical mapped actions, persistence across power cycles and gig qualification remain pending. Use rising-edge bindings for one-shot PiPedal actions so release does not trigger a second action.

**Chocolate four-rig recall verified — 2026-10-05T10:07:48.000Z:** Rix changed CubeSuite to Program Change A. The first ordered capture received channel-1 PC0/1/2/3, but a later PiPedal snapshot remained on a dirty first preset; that first run is not a preset-recall pass. Read-only configuration inspection identified global input `midiChannel: 1` (zero-based channel 2), while ALSA captured channel 0 (user-facing channel 1). The source path `AlsaSequencerImpl::IsChannelSelected` compares these zero-based values directly. UI/plugin program filters were not changed; the earlier general suggestion to adjust plugin Program Change filtering was not the demonstrated cause of this failure.

Corrected only the persisted global input channel to `midiChannel: 0` through the existing `setAlsaSequencerConfiguration` API, preserving both SINCO and MIDI Through connections. Readback matched, and exact before/after current board and preset-index equality passed during this configuration update. Once the owner state was clean, a fresh concurrent MIDI capture and read-only 200 ms preset-selection observer recorded physical A→PC0→preset 17 **Rx - Stereo Fuzz - Drop**, B→PC1→preset 15 **Rx Bogner Fullstack - Drop**, C→PC2→preset 3 **Dumble Spread**, and D→PC3→preset 5 **Matchless Crunch**. Every selected preset reported `presetChanged: false`. These are the first four positions in existing bank 6, **TONE3000 Library**; no new bank, rig reorder, save, preset cloning, plugin mapping or source change was performed by the agent. Final observed selection is the owner's D press, Matchless Crunch; no earlier selection was restored over it. This qualifies real four-switch preset recall, not reload-gap/listening/power-cycle or whole-sprint physical acceptance. Mapping depends on the current bank and preset order. Original Captain qualification and Auto Balance work remain pending.

**Cold-boot audio timing investigation — 2026-10-05T10:48:36.000Z:** Rix reports detected Jogg but stopped audio after restarting the Pi, with manual Audio Settings Apply required to produce sound. In that boot, PiPedal's selected `hw:Audio` was absent through its startup wait and subsequent open attempt, then it logged `Failed to start audio` and opened the null ALSA fallback. Kernel monotonic logs show Jogg first enumerating at approximately 42 seconds, disconnecting at 80 seconds and reconnecting on another port at 83 seconds. Later explicit settings application opened Jogg at 48 kHz, 128 frames, six buffers. Source tracing confirms `WaitForAudioDeviceToComeOnline()` waits five two-second iterations; `RestartAudio()` catches an open failure and recursively starts the dummy/null device. Existing abnormal-stream recovery has bounded retries, but there is no demonstrated later-device recovery from this initial null fallback. Ordering after `sound.target` does not prove the configured USB device exists. This explains the observed timing failure; no generic driver, T3K or plugin-ownership cause is inferred.

Rix then chose a diagnostic power cycle with Jogg powered and connected before the Pi. New boot ID `71bffe56-b0d2-4f78-9cfd-8eb99827622c` shows USB Jogg at approximately 2.615 seconds, `Found ALSA device hw:Audio` at 7.148 seconds and the **first** audio start on Jogg at 8.164 seconds, without a null-device fallback or later audio-thread restart in the inspected boot log. ALSA playback/capture both report RUNNING under daemon PID 977; status reports active with no error or restart, and automatic service restart count is zero. The enabled T3K host on clean saved **Rx - Stereo Fuzz - Drop** and persisted channel-1 SINCO input survive this power cycle. One startup underrun/recovery appears in the log; status initially reported one and later zero, with counter-reset semantics not investigated, so no zero-xrun claim is made. The 8.164-second measurement is driver-start timing, not measured audible readiness. Asked Rix to confirm sound without Apply; listening confirmation is pending at this record. No source, services, device configuration, rig or startup behaviour was changed by the agent for either observation. Powering the interface first demonstrates an early-device startup path; automatic late-device recovery remains an unresolved implementation issue. [5.2] and combined offline/phone/boot acceptance remain open.

### [DES-FILES] Implementation Outputs

| Path / artifact                                                                           | Purpose                                                                                                                                        |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/specs/tone3000-gig-rig/tone3000-gig-rig.md`                                         | Active plan, decisions, setup/configuration record, task status, results and stage/restore checklist.                                          |
| `tools/gig-rig/`                                                                          | Executable preflight, inventory/relabel, install and backup/restore helpers where needed. No separate planning/runbook documents.              |
| `src/PluginHost.cpp` / `src/Lv2Effect.cpp`; `src/PiPedalModel.cpp` / `src/Pedalboard.cpp` | The two bounded Q7 fixes (feature handshake and state-aware reload) applied to the pinned host revision; readback patch/applier and build helpers in `tools/gig-rig/`.                                             |
| `vite/src/pipedal/Tone3000View.tsx`, `Tone3000ControlLayout.ts`, factory/label adapter and build dependencies | Requested frontend presentation; coverage/order/fallback tests and static deploy/rollback helper. |
| `src/Tone3000Preset.*`, `Tone3000Library.*`, focused native tests and existing model/storage/socket/HTTP/config integration | Bounded lossless native preset conversion, fixed-root library, guarded persistent Add/Update/Load and validated upload. |
| `vite/src/pipedal/Tone3000Library.ts`, `Tone3000LibraryDialog.tsx`, model/item integration; `tools/gig-rig/library_e2e.py` | Same-Pi operator flow and reproducible real-source/service qualification helper. |
| Private artifacts                                                                         | Exact `.deb`/`.tar.gz`, rig/state backups and raw audio/log evidence; record non-secret inventory/digests and result summaries in this sprint. |

### [DES-ROLLOUT] Rollout, Gates, and Recovery

Progress Gate 0 → Gate 1 → Gate 2 → Gate 3 → Gate 4 → Gate 5. Both feature-handshake and state-recall blockers are resolved as bounded host fixes (Q7); build and verify them before installing the target host. Preserve the known-good rig; install only the pinned revision plus the bounded diff, then test existing effects. Reuse the installed bundle and audit existing presets/imports first. If a bundle change is needed, back up and stage verified names/data before a new persistent scan/import; reconcile any previously imported labels without discarding user presets. Qualify basic import/recall before dual-rig performance tests. Recover by restoring the previous package/bundle and consistent state backup, then verifying the old rig; do not assume restoring `/var/pipedal` alone rolls back executables.

#### Executed Deployment and Prepared Recovery Procedure

Baseline on Pi: `/home/nam/.local/state/pipedal-gig-rig/baseline-20261004/`. Approved private Mac copy: `/private/tmp/pipedal-gig-rig-private-20261004/baseline-20261004/`, directory 0700/files 0600. Digests verified on both ends:

- `baseline-state.tar.gz`: `cb28b2c5cd44ca3e7f0d0873d1053c00cf9422e1b28408d3957f46983e6c38a6`.
- Original `pipedal_2.0.110_arm64.deb`: `1db12d633a86961ce5c6e07394eda18baaf1344ce0fb942a42ce6c079575c8fa`.

The baseline was captured with `pipedald` stopped and restarted afterward, using GNU tar ACL/xattr capture. It contains `/var/pipedal`, `/etc/pipedal`, `nam`'s TONE3000 configuration and LV2 bundle, the installed service unit and `mod-drop.lv2`. Existing bank 2 / preset 27 “Drop - Bogner” and board/index snapshots are retained privately. The baseline predates Rix's MIDI enablement; carry forward the separately retained MIDI configuration when performing an approved rollback. No private settings/tokens are committed.

The approved corrected build passed its gate, and this initial-deployment command was executed after staging `install.py` **and** sibling `gig_rig.py`, verifying the effective service preset root and exact digests:

```sh
sudo python3 /home/nam/.local/state/pipedal-gig-rig/install.py \
  --package /home/nam/pipedal-gig-rig-build/build/pipedal_2.0.110_arm64.deb \
  --package-sha256 76df498a7dd5bc05cba82f81be4b5c6f7b5f23cb24691c2a2873320138a42236 \
  --bundle /home/nam/tone3000-gig-rig-build/build-gig-rig/plugin/TONE3000_artefacts/Release/LV2/TONE3000.lv2 \
  --binary-sha256 527c8f60560f3c47fb2e7b3bc86f585c598fdd5e4683d90d970657c9fda4bc77 \
  --presets /home/nam/.config/TONE3000/Presets \
  --manifest /home/nam/.local/state/pipedal-gig-rig/staged-labels-corrected/manifest.ttl
```

**Initial deployment complete; do not blindly rerun:** targets now exist and the initial installer deliberately refuses them. Service startup, original “Drop - Bogner” board and enabled MIDI configuration were preserved. Corrected plugin control readback passes the running-service smoke test; playable gig qualification is still pending.

The installer is initial-deployment only and refuses existing/redirected targets or unexpected settings in preset sources. It stages/validates complete trees before apt, stops the daemon before and after package scripts (scripts can briefly restart it), then promotes bundle/presets individually atomically and starts the service. Two promotions are not one transaction. Failure retains artifacts and leaves the daemon stopped; it performs no automatic rollback. Startup success alone does not verify audio. Preserve app-user data and existing PiPedal presets/imports.

The following recovery sequence was technically exercised in both directions (details above); **physical playable verification remains pending**:

1. Retain current state/new artifacts privately, verify baseline/package digests, stop both `pipedald.service` and `pipedaladmind.service`, verify inactive/PID 0 and retain their stopped state.
2. Install the exact retained previous package: `sudo apt-get install -y --allow-downgrades --reinstall /home/nam/.local/state/pipedal-gig-rig/baseline-20261004/pipedal_2.0.110_arm64.deb`; stop both services again after package scripts.
3. Quarantine post-baseline bundle/preset/config additions. Inspect archive paths/link targets and restore the consistent baseline with original ownership, ACLs and xattrs, using GNU tar into reviewed locations. An overlay alone leaves new files behind; replacing the whole store blindly can lose subsequent changes.
4. Restore/carry forward Rix's later MIDI configuration deliberately, run `sudo systemctl daemon-reload`, start `pipedald.service`, then verify original bank/preset, controls, actual audio and Captain connection.
5. Record the complete trial and playable outcome before checking [FR-10]/[5.3]. The executed technical drill does not satisfy the separate physical playable criterion.

`backup.py stage-restore` is a separate helper for its own manifest format: it verifies/extracts into a fresh staging directory and preserves POSIX owners/modes, but not ACLs/xattrs; it neither applies this GNU-tar baseline nor rolls back installed packages. Do not interchange these formats or claim a live restore from unit tests.

#### Stage Checklist — Complete and Validate in [5.4]

Fill device-specific values and results here before declaring this procedure stage-ready.

- [ ] **Power/audio:** document and verify power/amplifier/PA order, interface ports/gain, cooling, cables and safe output levels.
- [ ] **Startup rig:** record startup bank/preset, boot-to-sound time and model/IR identity. Cold boot requires no phone action.
- [ ] **Footswitch:** record PC/CC/channel/bank and displayed numbering; test song select, Split, effects and bypass.
- [ ] **Phone:** record tested hotspot/P2P mode, non-secret SSID and working address; connect with venue Wi-Fi/internet absent. Keep credentials private.
- [ ] **No sound:** check cables/gain/mute, selected interface/input/output, bank/preset and bypass. Record the checks that resolve each tested failure.
- [ ] **Recovery:** record browser reconnect and tested SSH/admin access. Commands: `systemctl status pipedald`, `journalctl -u pipedald`, and, when needed, `sudo systemctl restart pipedald`. Verify the rig returns after the audio interruption.
- [ ] **Restore:** record exact previous/qualified package and plugin digests, backup inventory/location, tested restore commands and playable post-restore result. Restoring data alone does not restore executables.
- [ ] **Rehearsal:** record date/duration, [DES-TEST] results, agent verdict and Rix's listening/physical-control verdict.

The checklist remains unvalidated until its device-specific steps/results are filled in here.

### [DES-QUESTIONS] Open Technical Decisions

#### Decision Register

| ID  | Question                                                                                                                                                          | Status   | Blocking                  | Owner / resolution                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 | SSH host/alias, login user, existing key access, and reachable network? | Resolved | No | Verified key-based SSH to `nam@192.168.1.169` (`rpi5nam`) from this Mac; noninteractive piped commands succeeded. Evidence in [DES-DEPS], [0.1]. |
| Q2 | Exact Pi/software/artifact inventory? | Resolved | No (runtime qualification separate) | Current host linked to the exact isolated source/build/deployment and hashes in [DES-TEST]. Original pre-sprint installed host commit remains unknown; no binary-to-commit assumption. |
| Q3 | Interface/controller, wiring, MIDI behavior, Desktop/Lite, power/cooling and capture? | Partially resolved | Performance/MIDI | Hotone Jogg, MIDI Captain/ALSA connection and Desktop packages verified in [DES-TEST]. Physical wiring, payload/action map, cooling/power and capture remain open. |
| Q4  | Where do procedures and helper scripts live?                                                                                                                      | Resolved | No                        | Setup, results, decisions and stage checklist stay in this sprint. Executable helpers live in `tools/gig-rig/` in this repository.                                                                      |
| Q5 | Intended rigs and source? | Resolved | No (performance verdict separate) | Rix selected Dumble Spread + Matchless Crunch, requested eight T3K defaults and saved Mac content; tsinelas imported with legacy ID. Mac app 0.0.11 verified. Preserve stock banks and use TONE3000 banks (D9). |
| Q6  | Final single/dual-instance board and acceptable measured latency?                                                                                                 | Open     | Final acceptance          | Decide from measurements; preserve NFR-2 unless explicitly revised.                                                                                                                                     |
| Q7  | Resolve the missing runtime `boundedBlockLength` feature and opaque-state recall shortcut through a compatible revision or the proposed bounded source exception? | Resolved | No (was FR-1–FR-3)        | Bounded source exception chosen. No verified-compatible revision exists (shallow single-commit clone at the pinned baseline); apply the two bounded fixes in [DES-COMPAT] (instantiate feature array) and [DES-RELOAD] (state-aware structural identity) via [1.7]/[1.8].                                                                   |
| Q8  | Is an independent LV2 diagnostic host required?                                                                                                                   | Deferred | No                        | Optional troubleshooting only. Actual PiPedal integration tests are sufficient; no missing external tool or experiment is a prerequisite.                                                               |
| Q9 | Expand the source exception to correct pinned JUCE LV2 `patch:Get` handling? | Resolved | No (verification still required) | Rix approved the concrete [DES-UI] correction and continued Pi work. [2.8]/[2.9] passed and the pinned bundle is deployed. Complete actual phone and persistence acceptance separately. |

Q7 is resolved (bounded host fixes; see [DES-COMPAT]/[DES-RELOAD]); Q2 inventory is resolved; Q3 physical/capture inputs remain open; F31's approved correction is deployed and its readback probes pass; Q5 identifies the intended rigs and selected source; Q6 is decided after measurements; Q4 is resolved by D7; Q8 is optional diagnostics only. The gate owners must explicitly resolve failures rather than label risks resolved from source inspection.

<!-- SPRINT-SECTION-END: DESIGN -->

---

<!-- SPRINT-SECTION-START: TASKS -->

## 3. Tasks

### Task Numbering and Execution Rules

Task IDs are stable. [0.0] records sprint preparation; [1.7]/[1.8] resolve host compatibility. Phases 0–5 comprise the active sprint; Phase 6 remains deferred. Update task status, decisions, configuration and results in this file.

Run implementation only after all three approvals are Approved, via `/afx-sprint code tone3000-gig-rig` → `/afx-task code`. Rix has offered SSH-based build/configuration/setup; supplied access and approved task scope govern execution without re-asking for routine authorized steps. Source exceptions must first be resolved in the Spec. Every task requires recorded outputs and technical verification; physical/listening tasks also require Human verification.

### Phase 0 — Documentation, Inputs, Access, and Backup

#### [0.0] Prepare and maintain the sprint (Agent)

<!-- files: docs/specs/tone3000-gig-rig/tone3000-gig-rig.md, docs/specs/tone3000-gig-rig/journal.md -->
<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-10] [NFR-6] [DES-OVR] [DES-EVIDENCE] -->

- [x] Consolidate requirements, evidence, design, tasks, gates, decisions, setup guidance and stage checklist into this self-contained Approved sprint.
- [x] Check local/pinned release sources and ARM64 metadata/digest; distinguish source findings from pending device results.
- [x] Rix approved the scope and resolved Q7 compatibility exception; unresolved measurement inputs remain explicitly tracked.

#### [0.1] Establish supplied SSH access (Rix → Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-10] [DES-DEPS] [DES-SEC] -->

- [x] Establish key-based device access and verify a noninteractive command pipeline. Output: access evidence in [DES-DEPS]/[DES-TEST]; Q1 resolved.

#### [0.2] Inspect the actual device (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [NFR-1] [NFR-6] [DES-COMPAT] [DES-DEPS] -->

- [x] Inspect the device using [DES-DEPS] preflight and record the inventory in [DES-TEST]. Output: compatibility/install evidence and Q2 resolution.

#### [0.3] Confirm hardware and image variant (Rix + Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-3] [NFR-1] [DES-UI] [DES-TEST] -->

- [ ] Record interface/controller, wiring, MIDI behavior, Lite/Desktop, power/cooling and capture method. Output: reproducible hardware record; Q3 resolved.

#### [0.4] Identify available rigs and their source (Rix + Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [DES-STATE] [DES-ORDER] [DES-DATA] -->

- [x] Inspect existing Pi rigs first and select the intended Pi-local or Mac-origin rigs using [DES-STATE]. Output: source/app/inventory record and Q5 resolution; Mac access/transfer only if chosen.

#### [0.5] Resolve implementation scope and procedure destination (Rix + Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [FR-10] [NFR-6] [DES-COMPAT] [DES-DEC] [DES-QUESTIONS] [DES-FILES] -->

- [x] Record staged approvals for the resolved Q7 baseline (pinned revision plus the bounded fixes in [DES-COMPAT]/[DES-RELOAD]). Use this sprint for planning/records and `tools/gig-rig/` for executable helpers. Output: reviewable implementation scope. SSH setup authorization remains applicable.

#### [0.6] Back up the working installation (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-10] [DES-SEC] [DES-ROLLOUT] -->

- [x] Capture consistent `/var/pipedal`, `/etc/pipedal`, existing bundle/unit overrides and exact previous package; copy backup off-device, inspect contents/digest and recovery procedure. Output: recoverable baseline before mutations.

**Gate 0:** inputs/access/scope recorded; consistent off-device backup and previous executable artifacts available. SSH credentials alone are insufficient.

### Phase 1 — Compatible PiPedal Baseline

#### [1.1] Select and pin the host revision (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [NFR-6] [DES-COMPAT] -->

- [ ] Confirm the pinned baseline `787c45014c2501c00ae49a96bc792cfd3abb88a7` against the installed revision read-only; the selected baseline is the pinned commit plus the Q7 bounded fixes. Do not automatically fast-forward the user's checkout. Output: pinned commit, installed revision, and compatibility evidence.

#### [1.2] Verify Pi-native prerequisites (Agent; conditional build)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [NFR-6] [DES-DEPS] -->

- [x] Verify and apply only necessary build prerequisites from [DES-DEPS] against the selected host revision. Output: installed versions and recorded deviations.

#### [1.3] Prepare isolated pinned source (Agent; conditional build)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [NFR-6] [DES-FILES] -->

- [x] Clone/checkout the chosen revision with recursive submodules and configure React dependencies; preserve any existing user tree. If a source exception is needed, isolate it on an appropriate branch. Output: source/submodule commit inventory.

#### [1.4] Build and package once (Agent; conditional build)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [NFR-6] [DES-COMPAT] [DES-ROLLOUT] [DES-DEPS] -->

- [x] After [1.7] and [1.8], build/package the isolated Pi checkout once using [DES-DEPS]. Output: exact installable package, build record, or documented reason a build was unnecessary.

#### [1.5] Install and regression-check (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [FR-6] [DES-ROLLOUT] [DES-TEST] -->

- [ ] Install the exact package if needed and check service/phone audio; existing TooB board must still play. Preserve rollback package. Output: technical and listening regression evidence.

#### [1.6] Record installed provenance (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [NFR-6] [DES-EVIDENCE] -->

- [x] Record package/version, exact source revision/submodules and any bounded diff in this sprint's configuration record; never identify a build by date alone. Output: reproducible host baseline.

#### [1.7] Resolve missing bounded-block runtime feature (Agent; prerequisite to [1.4])

<!-- files: src/PluginHost.cpp, src/Lv2Effect.cpp (bounded fix; Q7 resolved — no compatible revision available) -->
<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [DES-COMPAT] [DES-EVIDENCE] -->

- [x] After staged approvals, apply and verify the bounded `bufs:boundedBlockLength` fix in [DES-COMPAT] via `/afx-task code`, including the mini-host re-check with PiPedal's exact instantiate array. Output: reviewed compatibility resolution.

#### [1.8] Resolve opaque-state reload shortcut (Agent; prerequisite to [1.4])

<!-- files: src/PiPedalModel.cpp, src/Pedalboard.cpp (bounded fix; Q7 resolved — no compatible revision available) -->
<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-3] [DES-RELOAD] [DES-EVIDENCE] -->

- [x] After staged approvals, apply and verify the opaque-state-aware reload fix in [DES-RELOAD] via `/afx-task code` (state-aware structural identity; rebuild for changed state). Output: reviewed reload resolution; actual TONE3000 validation follows in Phase 3.

**Gate 1:** exact installed host supports numeric properties, supplies required runtime features and reloads changed opaque state/pending lilv imports; existing rig still works. [1.7]/[1.8] are mandatory resolutions; Q7 fixes them as bounded local patches.

### Phase 2 — TONE3000 Bundle Qualification

#### [2.1] Verify installed plugin provenance; fetch only if needed (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [NFR-6] [DES-EVIDENCE] [DES-DEPS] -->

- [x] Inspect the installed plugin against [DES-EVIDENCE] and record exact provenance/digest. Fetch a verified replacement/recovery artifact only if needed. Output: installed artifact record and any conditional download rationale.

#### [2.2] Verify runtime libraries (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [DES-DEPS] [DES-COMPAT] [DES-EVIDENCE] -->

- [x] Verify all runtime dependencies and service-user access against [DES-EVIDENCE] and [DES-DEPS]. Output: device dependency evidence.

#### [2.3] Audit existing rigs and labels; stage corrections if needed (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-9] [NFR-6] [DES-ORDER] -->

- [x] Audit the installed rig list and persistent labels using [DES-ORDER]. If corrections are needed, stage and validate them through the task workflow while preserving existing imports. Output: verified inventory/mapping and any necessary label corrections.

#### [2.4] Confirm existing bundle discovery; adjust only if needed (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [DES-DATA] [DES-ROLLOUT] [DES-DEPS] -->

- [x] Verify the existing bundle is discoverable and readable by PiPedal according to [DES-DEPS]/[DES-DATA]. Make only necessary backed-up configuration/location or installation changes. Output: scan-path/access evidence and any change rationale.

#### [2.5] Validate RDF discovery (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [FR-4] [DES-EVIDENCE] -->

- [x] Validate bundle metadata and property count using [DES-EVIDENCE] metadata inspection. Output: discovery evidence; runtime integration is verified in [2.6].

#### [2.6] Instantiate and verify audio/phone controls (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [FR-4] [DES-COMPAT] [DES-UI] [DES-TEST] -->

- [ ] Restart/rescan as needed, add plugin under real service environment without DISPLAY, verify audio and all 43 properties/readbacks/ranges/toggles/enums; confirm sample rate and save/recall behavior. Output: actual PiPedal integration evidence.

#### [2.7] Inspect logs and service state (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [NFR-5] [DES-ERR] -->

- [ ] Inspect PiPedal journal and service-user plugin log for prepare/load errors, scheduling/dependency/permission failures and assertions. Output: log excerpts and baseline counters.

**Gate 2:** actual-host instantiate, audio, 43 generic controls/readbacks and no unresolved errors. Plugin discovery alone does not pass.

#### [2.8] Implement and build the bounded LV2 readback correction (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [NFR-6] [DES-UI] [DES-DEPS] [DES-FILES] -->

- [x] Implement the approved correction and reproducible configure-time patch from [DES-UI]; pin source/patch/dependency provenance and build an isolated corrected LV2 bundle without changing the authoring app. Output: exact bundle and source/artifact digests.

#### [2.9] Verify corrected readback before deployment (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [NFR-5] [DES-UI] [DES-TEST] [DES-ROLLOUT] -->

- [x] Verify all individual/all-property reads, Set→Get ranges/choices, malformed/unknown/subject handling, undersized-buffer safety/retries and state restoration using real plugin responses. Repeat the actual-host gate with the corrected binary, then resume installation/[2.6] and real-service persistence qualification. Output: passing readback diagnostics and preserved original-binary failure evidence.

#### [2.10] Improve TONE3000 control presentation (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [NFR-4] [DES-UI] -->

- [x] Implement the requested grouped, readable, responsive control view through [DES-UI]. Output: reviewable frontend source retaining every advertised numeric property and existing control behavior.

#### [2.11] Verify and deploy the improved presentation (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [NFR-4] [NFR-6] [DES-UI] [DES-TEST] [DES-ROLLOUT] -->

- [ ] Typecheck/build, verify property coverage/fallback and inspect desktop/narrow browser layouts and representative controls against RPC using [DES-UI]. Preserve frontend rollback and record deployment. Output: working display and separate owner usability verdict. Agent checks/deployment passed as recorded in [DES-TEST]; Human verdict and actual phone check remain pending.

### Phase 3 — Pi-Local or Mac-Origin Rig Preparation and Recall

#### [3.1] Select or prepare named rigs on the Pi or Mac (Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-9] [DES-STATE] [DES-ORDER] -->

- [x] Select existing intended rigs or prepare/name them in the Pi or Mac app using [DES-STATE]/[DES-ORDER]. Output: intended performance rig and inventory; factory presets may support initial smoke tests.

#### [3.2] Make chosen rigs available to PiPedal (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-10] [DES-STATE] [DES-DATA] [DES-SEC] -->

- [x] Reuse or stage Pi-local rig data, or transfer Mac-origin data if selected, using [DES-STATE]/[DES-DATA]/[DES-SEC]. Output: verified service-accessible preset store with metadata preserved.

#### [3.3] Reconcile numbering and persistent labels (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-9] [DES-ORDER] -->

- [ ] Rebuild/verify header/ID-based index map on Pi; compare the selected authoring app's PC view and intended labels. Handle already imported PiPedal labels through supported rename or scoped backed-up re-import. Output: every installed named slot selects its expected rig.

#### [3.4] Configure and verify machine/per-instance settings (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [NFR-2] [DES-DATA] -->

- [ ] Configure and verify machine/per-instance settings according to [DES-DATA], including recalled presets. Output: measured and recorded settings.

#### [3.5] Import, wait for readiness, and save each rig (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-3] [DES-STATE] [DES-TEST] -->

- [ ] Select intended named plugin preset; verify preset identity/model/IR readiness and audio before saving a named PiPedal preset. Repeat imports and retain evidence/failures for R6. Output: settled saved host states for all intended rigs.

#### [3.6] Prove full-state offline recall (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-3] [FR-7] [DES-STATE] [DES-TEST] [DES-RELOAD] -->

- [ ] Perform the offline recall and saved-state self-containment checks in [DES-STATE], including the changed-rig cases in [DES-RELOAD]. Output: correct model/IR/settings recall after restart and cold boot, with R20 ruled out.

#### [3.7] Assemble and save the dual-rig song board (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-5] [FR-6] [NFR-2] [DES-ARCH] -->

- [ ] Save two settled TONE3000 states in an A/B Split with shared tuner/delay/reverb; verify routing/levels and both branches. Output: dual-rig measurement board, or an explicit owner-approved scope change.

**Gate 3:** an intended user rig from either the Pi or Mac recalls offline from saved PiPedal state after restart/boot; names/settings correct, deferred-load risk tested. Mac transfer is conditional on the chosen source. A factory-only smoke test or independent-host-only result is insufficient.

#### [3.8] Implement direct native TONE3000 preset codec (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-11] [NFR-6] [DES-LIBRARY] [DES-STATE] -->

- [x] Implement and verify bounded full-state conversion preserving exact embedded assets and session settings, with malformed/legacy/default coverage.

#### [3.9] Implement Pi-local library and targeted saved-rig integration (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-3] [FR-9] [FR-11] [NFR-6] [DES-LIBRARY] [DES-SEC] -->

- [x] Implement fixed-root discovery, validated upload, provenance and Add/Update/Load contracts with stable IDs, effect preservation and failure guards. Verify storage/service paths and app-save readability.

#### [3.10] Implement library UI and run deployed end-to-end checks (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-4] [FR-11] [NFR-4] [NFR-6] [DES-LIBRARY] [DES-UI] [DES-TEST] [DES-ROLLOUT] -->

- [x] Agent: implement the operator flow, build/deploy with exact backups, and verify browser→service→saved state→real plugin paths, changed sources, upload, stable-ID update, restart and offline synthetic recall. Record results and remaining Human gates in Design.
- [ ] Human: Rix confirms usability and intended sound through the actual app/device/phone workflow; physical/listening acceptance is separate from technical E2E.

#### [3.11] Implement bounded state summaries and block/settings editing (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [FR-14] [DES-OPERATE] [DES-LIBRARY] -->

- [x] Extend native codec/DTOs, sparse validated edits and semantic guards; verify exact unedited assets/metadata and legacy defaults plus malformed/routing/IR refusals.

#### [3.12] Implement processing profiles, runtime guards and persistence (Agent)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [FR-14] [DES-OPERATE] [DES-SEC] [DES-RELOAD] -->

- [x] Implement typed fixed-root profile store, optional app defaults, follow metadata, fresh capture/revision APIs, selected forced rebuild, clean-load/snapshot policy and source Update preservation; verify actual storage/runtime paths.

#### [3.13] Implement read-only System and editable Plugin/Blocks UI (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [FR-14] [DES-OPERATE] [DES-UI] -->

- [x] Agent: implement real RPC/observable-backed responsive controls, staged profiles, drafts/errors and reload/snapshot disclosure; complete path trace and frontend gates.
- [ ] Human: verify actual phone and home/studio/live usability and audible effects of selected tweaks.

#### [3.14] Deploy and qualify Plan B on the owner Pi (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [FR-13] [FR-14] [NFR-6] [DES-OPERATE] [DES-TEST] [DES-ROLLOUT] -->

- [x] Agent: capture current consistent baseline, deploy exact qualified artifacts and narrow ACL, verify browser→service→state→save/recall/restart, globals/overrides/overwrite and failure guards, then preserve owner data and restore the captured rig unless newer concurrent owner work must be retained.
- [ ] Human: confirm listening, phone and physical controller behavior; no seamless/gig verdict inferred from technical checks.

#### [3.15] Reuse PiPedal chain display for read-only T3K topology (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-15] [DES-OPERATE] [DES-UI] -->

- [x] Agent: integrate the isolated read-only projection inline with ordinary PiPedal styling and measured footprint; verify source/pure topology guards, actual capture, parent-only block navigation, mono desktop appearance and unchanged owner state.
- [x] Agent: complete final deployed stereo/narrow/surrounding-effects browser checks alongside [3.14] form Apply/Save gate, preserving current owner work.
- [x] Agent: prepend the ordinary TONE3000 parent marker, verify marker/block selection, stock inline mono/stereo connectors, build and publish the static frontend without changing the owner rig.
- [ ] Human: confirm the internal chain presentation is clear on the actual phone/device.

### Phase 4 — Measure and Qualify

#### [4.1] Measure latency, CPU, threads and quality variants (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [NFR-1] [NFR-2] [DES-TEST] -->

- [ ] Run latency, CPU, worker-load and quality comparisons using the qualification configurations and protocol in [DES-TEST]. Output: populated measurements and configuration records.

#### [4.2] Measure full-preset and Split switching (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-5] [NFR-3] [DES-ARCH] [DES-TEST] -->

- [ ] Record output with the selected capture/DAW setup while issuing five full recalls (including same-structure different-state rigs) and repeated A/B actions; verify actual rig identity and quantify gap/click/transition/phase/tails separately. Output: recordings and pass/fail per switching requirement.

#### [4.3] Measure phone response and state sizes (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [NFR-4] [DES-STATE] [DES-TEST] -->

- [ ] Store ≥10 rigs, time five list opens, inspect saved JSON/wire/storage sizes and reload response; record phone/browser/network. Output: measured UI/state-size evidence.

#### [4.4] Run the one-hour rehearsal soak (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [NFR-1] [NFR-5] [DES-TEST] [DES-ERR] -->

- [ ] Play/switch real rigs and effects for ≥1 h, compare xrun/restart counters, inspect logs and audible recording. Output: timed soak evidence and Rix's rehearsal verdict.

#### [4.5] Optional independent-host diagnostics (Agent; conditional)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [NFR-6] [DES-EVIDENCE] [DES-DEPS] -->

- [ ] If actual PiPedal failures need isolation, create/audit a small LV2 helper under `tools/gig-rig/`, distinguish unmodified/corrected host features, and summarize timing/state/DSP findings here. Otherwise mark unnecessary with a reason. Actual-host tests remain mandatory.

**Gate 4:** NFR-1…NFR-5 and FR-5 are measured with pass/fail. Failed dual-instance targets require optimization or explicit owner-approved requirement changes; single-instance fallback is not an automatic pass.

### Phase 5 — Gig Configuration and Handoff

#### [5.1] Bind and test every footswitch action (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-3] [FR-5] [FR-6] [DES-UI] -->

- [ ] Record actual PC/CC/channel/bank and numbering; test song select, Split, effects and bypass with the real device. Output: physical-control map and Human verification.

#### [5.2] Verify phone connectivity and unattended boot/recovery (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-7] [FR-8] [DES-ROLLOUT] [DES-UI] -->

- [ ] Test stock hotspot/P2P with venue Wi-Fi absent, power-cycle the intended startup rig with SSH disconnected, record time to sound and test admin/service recovery. Output: boot/connectivity/recovery evidence.

#### [5.3] Package procedures and prove restore (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-10] [NFR-6] [DES-FILES] [DES-SEC] [DES-ROLLOUT] -->

- [ ] Version needed executable helpers in `tools/gig-rig/`, record setup/inventory/backup/restore procedures and results here, and retain package/plugin, presets/order/settings/names and backups privately. Demonstrate restore and update [DES-TEST]/[DES-ROLLOUT]. Output: verified helpers/artifacts and complete in-sprint handoff record.

#### [5.4] Write and rehearse the stage checklist (Agent + Rix)

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-7] [FR-10] [NFR-5] [DES-ROLLOUT] -->

- [ ] Fill in and validate [DES-ROLLOUT], including no-sound, reconnect/admin restart and known-good restore; rehearse with actual devices and record acceptance/scope exceptions here. Output: validated in-sprint stage procedure and Agent/Human verdicts.

**Gate 5:** physical rehearsal, unattended boot/connectivity, demonstrated restore, versioned helpers and validated in-sprint stage/restore procedure complete. Required evidence cannot remain Pending.

### Phase 6 — Deferred Proposals (Outside Active Sprint)

#### [6.1] Investigate synchronous program restore if R6 remains a blocker

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-3] [DES-STATE] -->

- [ ] Deferred: scope a TONE3000 change only if actual-host evidence requires it. Do not assume “off the audio thread” is automatically thread-safe or bypass review of thread safety and model readiness.

#### [6.2] Investigate a GUI-less LV2 build if required

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [DES-DEPS] -->

- [ ] Deferred: HEADLESS format/editor/link changes require separate design/build/dependency verification; not necessary merely to avoid showing a GUI.

#### [6.3] Investigate plugin atom MIDI routing

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-3] [DES-UI] -->

- [ ] Deferred: PiPedal routing and RT/MIDI integration are broader scope; discuss upstream only when explicitly authorized to communicate.

#### [6.4] Investigate numeric patch-property MIDI bindings

<!-- @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-4] [DES-UI] -->

- [ ] Deferred: require separate UI/runtime binding design and approval. Graduate if broader plugin integration enters scope.

### Cross-Reference Index

| Tasks                  | Spec requirements                                                        | Design sections                                                              |
| ---------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [0.0]                  | [FR-10], [NFR-6]                                                         | [DES-EVIDENCE]                                                               |
| [0.1]–[0.6]            | [FR-1], [FR-2], [FR-3], [FR-10], [NFR-1], [NFR-6]                        | [DES-DEPS], [DES-COMPAT], [DES-SEC], [DES-STATE], [DES-ORDER], [DES-ROLLOUT] |
| [1.1]–[1.8]            | [FR-1], [FR-2], [FR-3], [FR-6], [NFR-6]                                  | [DES-COMPAT], [DES-RELOAD], [DES-DEPS], [DES-ROLLOUT], [DES-EVIDENCE]        |
| [2.1]–[2.11]           | [FR-1], [FR-4], [FR-9], [NFR-4], [NFR-5], [NFR-6]                                 | [DES-EVIDENCE], [DES-COMPAT], [DES-ORDER], [DES-DATA], [DES-UI], [DES-ERR]   |
| [3.1]–[3.7]            | [FR-2], [FR-3], [FR-4], [FR-5], [FR-6], [FR-7], [FR-9], [FR-10], [NFR-2] | [DES-STATE], [DES-ORDER], [DES-DATA], [DES-ARCH], [DES-TEST]                 |
| [3.8]–[3.10] | [FR-2], [FR-3], [FR-4], [FR-9], [FR-11], [NFR-4], [NFR-6] | [DES-LIBRARY], [DES-STATE], [DES-SEC], [DES-UI], [DES-TEST], [DES-ROLLOUT] |
| [3.15] | [FR-15] | [DES-OPERATE], [DES-UI] |
| [3.11]–[3.14] | [FR-12], [FR-13], [FR-14], [NFR-6] | [DES-OPERATE], [DES-LIBRARY], [DES-SEC], [DES-RELOAD], [DES-UI], [DES-TEST], [DES-ROLLOUT] |
| [4.1]–[4.5]            | [FR-1], [FR-5], [NFR-1]–[NFR-6]                                          | [DES-TEST], [DES-EVIDENCE], [DES-ERR]                                        |
| [5.1]–[5.4]            | [FR-3], [FR-5], [FR-6], [FR-7], [FR-8], [FR-10], [NFR-5], [NFR-6]        | [DES-UI], [DES-ROLLOUT], [DES-FILES], [DES-SEC], [DES-TEST]                  |
| [6.1]–[6.4] (deferred) | [FR-1], [FR-2], [FR-3], [FR-4]                                           | [DES-STATE], [DES-DEPS], [DES-UI]                                            |

<!-- SPRINT-SECTION-END: TASKS -->

---

<!-- SPRINT-SECTION-START: SESSIONS -->

## 4. Work Sessions

<!-- LAST SECTION: append task execution evidence here; Agent and Human verification are separate. -->

| Date       | Task  | Action   | Files Modified                                                                              | Agent | Human |
| ---------- | ----- | -------- | ------------------------------------------------------------------------------------------- | ----- | ----- |
| 2026-10-04 | [0.0] | Reviewed | `docs/specs/tone3000-gig-rig/tone3000-gig-rig.md`, `docs/specs/tone3000-gig-rig/journal.md` | [x]   | [ ]   |
| 2026-10-04 | [0.0] | Reviewed | `docs/specs/tone3000-gig-rig/tone3000-gig-rig.md`                                           | [x]   | [ ]   |
| 2026-10-04 | [0.1] | Completed | Pi `/home/nam/.ssh/authorized_keys`; access evidence in this sprint and `journal.md` | [x] | [ ] |
| 2026-10-04 | [0.2], [0.5], [0.6] | Verified | Device inventory/private baseline and approved off-device copy; results in this sprint | [x] | [ ] |
| 2026-10-04 | [1.2]–[1.4], [1.7], [1.8] | Coded / Verified | `src/PluginHost.cpp`, `.hpp`, `src/Pedalboard.cpp`, `.hpp`, `src/CMakeLists.txt`, `src/PedalboardStateTest.cpp`, `src/Tone3000HostTest.cpp`; isolated Pi build | [x] | [ ] |
| 2026-10-04 | [2.1], [2.3], [2.5], [5.3] | Coded / Partially Verified | `tools/gig-rig/` helpers; 23 tests; inventory/labels staged; live restore pending | [x] | [ ] |
| 2026-10-04 | [2.6], [4.5] | Failed gate / Paused | `src/Tone3000HostTest.cpp`; F31 and unapproved repair proposal in Design; no deployment | [ ] | [ ] |
| 2026-10-04 | [0.3], [5.1] | Partially Verified | API/ALSA Captain connection confirmed after Rix enablement; physical events/actions pending | [ ] | [ ] |
| 2026-10-04 | [2.8], [2.9] | Scope approved | Spec source exception, Design readback correction, mapped Tasks; Rix instructed “proceed and then continue the work” at 2026-10-04T02:02:06.000Z | [x] | [x] |
| 2026-10-04 | [1.6], [2.2], [2.4], [2.8], [2.9], [2.6] | Build/deploy verified; qualification underway | Corrected source/artifact digests, 43/43 readback and five expanded tests; real-service smoke; original board restored. Detailed evidence in Design. | [x] | [ ] |
| 2026-10-04 | [0.4], [3.1], [3.2], [2.9], [3.5], [3.6], [5.3] | Technical evidence extended | Owner pair/source selected; nine saved-state smokes, isolated DSP pair, technical recovery and requested factory preset reset. Exact results/limits in Design. | [x] | [ ] |
| 2026-10-04 | [2.10], [2.11] | Implemented / Agent verified | Custom display, label adapter, build dependencies/fail-fast and static rollout helper; live desktop/narrow and RPC checks recorded in Design. Owner usability verdict pending. | [x] | [ ] |
| 2026-10-04T05:39:24.000Z | [3.8]–[3.10] | Implemented / Deployed / Agent E2E verified | Native codec/library/tests; model/storage/socket/HTTP/config/provenance; frontend Library; source E2E helper. Exact deployment, 12-entry recall, actual-browser updates, restart, offline DSP, guarded cleanup and owner restoration are in Design. | [x] | [ ] |
| 2026-10-05T06:18:16.000Z | [3.11]–[3.14] | Plan B scope approved / Picked | Sprint v1.4 requirements, [DES-OPERATE] and mapped tasks; Spec → Design → Tasks reviewed/reapproved under Rix's selected plan and prior delegated approval. Technical execution pending. | [x] | [ ] |

| 2026-10-05T06:53:37.000Z | [3.15] | Read-only chain scope approved / Picked | Rix clarified reuse of the existing PiPedal chain presentation; Spec → Design → Tasks reviewed/reapproved for v1.5 under delegated approval. Source implementation delegated to afx-task. | [x] | [ ] |
| 2026-10-05T07:50:21.000Z | [3.11]–[3.15] | Coded / Native and intermediate UI gates verified | Source, profile deployment and actual-state results in [DES-OPERATE]. Plain inline appearance and disposable browser Apply/Save/recall gate underway; human gates pending. | [x] | [ ] |

| 2026-10-05T08:04:48.000Z | [3.11]–[3.15] | Deployed / Partial browser qualification | Final ordinary inline chain, artifacts, navigation/state comparison and guarded inactive fixture cleanup are recorded in [DES-OPERATE]. Final form/stereo/narrow browser and human gates remain open. | [x] | [ ] |

| 2026-10-05T08:16:57.000Z | [3.14], [3.15] | Agent browser E2E completed / Owner restored | Final inline mono/stereo, real form Apply/Save/export/recall, surrounding-effect navigation, narrow desktop and exact guarded restore/cleanup passed; evidence and performance limitations are in [DES-OPERATE]. Human gates remain pending. | [x] | [ ] |

| 2026-10-05T09:23:40.000Z | [3.15] | Parent marker implemented / Deployed / Agent verified | Four frontend files; stock parent marker and real-parent/internal selection verified on actual mono/stereo owner chains, 15 tests and production build pass, guarded static publish preserves owner state. Exact technical evidence is in [DES-OPERATE]; Human gates pending. | [x] | [ ] |

| 2026-10-05T10:07:48.000Z | [5.1] | Supplementary Chocolate controller physically verified | Detection, standard CC capture, PC capture, global input-channel correction and actual four-rig recall recorded in [DES-OPERATE]. Existing Captain/listening/performance gates remain pending. | [x] | [ ] |

| 2026-10-05T10:48:36.000Z | [5.2] | Boot failure diagnosed / Owner power-sequence experiment observed | Timing and null-fallback source trace, failed delayed-device boot and successful early-Jogg driver start recorded in [DES-OPERATE]. Listening and automatic late-device recovery remain pending; no implementation or configuration changes. | [x] | [ ] |

<!-- SPRINT-SECTION-END: SESSIONS -->
