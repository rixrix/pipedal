# TONE3000 on PiPedal — Gig Rig Blueprint (Option A)

**Status:** Draft v1 — awaiting Rix's review. No code has been changed in this repo for this work.
**Owner:** Rix (rixrix). **Authored by:** Claude (session 011y3Q2dDy4uf9oTL5Kq4kyS), 2026-10-04.
**Scope of this file:** the single source of truth for running the TONE3000 NAM plugin inside PiPedal on a Raspberry Pi 5 for live use. Any agent or person picking this up should be able to continue from here without the original chat.

> Working rule for this repo (`rixrix/pipedal`, fork of `rerdavies/pipedal`): **do not modify PiPedal source for this work unless a task in §8 explicitly calls for it, and record every such change in §10 (Decision log).** This file is documentation only.

---

## Table of contents
1. Context and goal
2. Requirements
3. Verified facts (with evidence)
4. Constraints and non-goals
5. Technical design
6. Risk register
7. Environments and tooling
8. Tasks by phase (with gates and acceptance criteria)
9. Measurement protocol
10. Decision log
11. Open questions
12. Appendices (scripts, samples, commands, glossary, references)

---

## 1. Context and goal

Rix has a Raspberry Pi 5 (8 GB) running **Raspberry Pi OS Trixie (Debian 13)** with **PiPedal** installed and working. He wants to use **TONE3000**'s NAM amp-modelling plugin for **gigging** on that Pi: design rigs on his MacBook Air (Apple Silicon) in the official TONE3000 standalone app, then play them live on the Pi, switching rigs from a footswitch and tweaking from a phone.

Two architectures were studied (see the "NAM" Claude project docs `tone3000-headless-research.md` and `option-a-pipedal-gig-plan.md`):

- **Option A (chosen):** load the TONE3000 **LV2** build inside PiPedal. PiPedal remains the appliance (audio engine, web UI, presets, MIDI, hotspot). Zero new daemon code.
- **Option B (deferred):** a new headless `tone3000d` daemon with its own web UI. Only worth it if tone browsing/model swapping from the phone at the gig becomes a must.

**Goal statement:** A Pi 5 that boots into PiPedal, runs one or two TONE3000 LV2 instances with rigs built on the Mac, switches rigs by MIDI footswitch, exposes TONE3000's knobs on the phone, needs no network or TONE3000 account on stage, and is measured to be stable for a full set.

---

## 2. Requirements

### 2.1 Functional
| ID   | Requirement                                                                                                                                                    | Priority |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR1  | TONE3000 LV2 appears in PiPedal's plugin list and can be added to a pedalboard                                                                                 | Must     |
| FR2  | A rig (`.t3kpreset`) built in the Mac standalone can be loaded into the Pi instance without a display, network, or TONE3000 account                            | Must     |
| FR3  | Each rig can be captured as a **PiPedal preset** and recalled by name from the phone UI and by MIDI Program Change from a footswitch                           | Must     |
| FR4  | TONE3000's faceplate parameters (gate, tone stack, levels, spread/align, pitch, oversampling, calibration — 43 total) are adjustable from the PiPedal phone UI | Must     |
| FR5  | Instant (gap-free) switching between two rigs mid-song via a MIDI-bound PiPedal A/B Split holding two TONE3000 instances                                       | Should   |
| FR6  | PiPedal's own effects (TooB tuner, delay, reverb, etc.) usable before/after TONE3000 and MIDI-bindable                                                         | Should   |
| FR7  | Pi boots to a playable state unattended (no login, no phone needed)                                                                                            | Must     |
| FR8  | Phone connects via PiPedal hotspot/P2P when no venue Wi-Fi                                                                                                     | Should   |
| FR9  | Rig preset list in PiPedal shows human-readable names (not "(empty)")                                                                                          | Should   |
| FR10 | Repeatable install/restore procedure for the whole rig (scripts + backups)                                                                                     | Must     |

### 2.2 Non-functional
| ID   | Requirement                            | Target                                                                                                      |
| ---- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| NFR1 | Round-trip latency                     | PiPedal 16×4 or 32×4 buffers at 48 kHz (≈4–6 ms per PiPedal docs) with no xruns over 1 h                    |
| NFR2 | CPU headroom                           | ≤ 60 % PiPedal-reported CPU with 2 TONE3000 instances (A2 models, 1× oversampling) + tuner + delay + reverb |
| NFR3 | Rig switch gap (PiPedal preset change) | measured and documented; acceptable if ≤ 1 s and silent (no clicks)                                         |
| NFR4 | Phone UI responsiveness                | preset list opens < 2 s with ≥ 10 rigs stored                                                               |
| NFR5 | Stability                              | 1 h soak at rehearsal: no crashes, no `pipedald` restarts, no JUCE asserts in log                           |
| NFR6 | Reproducibility                        | every step in §8 is a command or script checked into the gig-config folder                                  |

---

## 3. Verified facts (with evidence)

All facts below were verified on 2026-10-04 from source checkouts (JUCE 9.0.3; tone3000-plugin `ef6f178` = v0.0.11; pipedal `787c450` = `main`, which is this fork's `main`), official release assets, or an empirical test. "LV2.cpp" = `modules/juce_audio_plugin_client/juce_audio_plugin_client_LV2.cpp` in JUCE.

### 3.1 TONE3000 release and binary
| #   | Fact                                                                                                                                                                                                                                                                                     | Evidence                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | Latest release **v0.0.11** (2026-10-01) ships `TONE3000-v0.0.11-linux-aarch64.tar.gz` containing `TONE3000` (standalone), `TONE3000.vst3`, **`TONE3000.lv2/{libTONE3000.so,manifest.ttl,dsp.ttl,ui.ttl}`**, `TONE3000.clap`, `install.sh`, `README.txt`, 8 `factory-presets/*.t3kpreset` | https://github.com/tone-3000/tone3000-plugin/releases/download/v0.0.11/TONE3000-v0.0.11-linux-aarch64.tar.gz ; listed as "Linux (ARM64)" on https://www.tone3000.com/plugin/download |
| F2  | Built with GCC 13.3 on Ubuntu 24.04-arm; needs `GLIBC_2.38`, `GLIBCXX_3.4.32`. `NEEDED`: libX11.so.6, libasound.so.2, libfontconfig.so.1, libstdc++, libm, libgcc_s, libc — **the LV2 .so links libX11 and fontconfig** even though no UI is ever shown by PiPedal                       | `objdump -T/-p` on the tarball's binaries                                                                                                                                            |
| F3  | Trixie = glibc 2.41 / GCC 14.2 → official binary runs. (Bookworm = glibc 2.36 → would not; irrelevant now, Rix is on Trixie)                                                                                                                                                             | https://www.debian.org/News/2025/20250809                                                                                                                                            |
| F4  | `install.sh` is per-user (`~/.lv2`, `~/.vst3`, `~/.clap`, `~/.local/bin`, presets → `~/.config/TONE3000/Presets/Factory`). PiPedal does not scan `~/.lv2` (F25) so the bundle must be copied to a PiPedal path manually                                                                  | `script/installer/linux/install.sh`                                                                                                                                                  |
| F5  | MIT licence                                                                                                                                                                                                                                                                              | repo `LICENSE`                                                                                                                                                                       |

### 3.2 What the TONE3000 LV2 exposes (JUCE 9.0.3 wrapper)
| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Evidence                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| F6  | Parameters are **`lv2:Parameter` patch properties** (`rdfs:range atom:Float`, `lv2:default/minimum/maximum`, `lv2:toggled` / `lv2:enumeration` + `lv2:scalePoint` for discrete ones), listed under `patch:writable` and `patch:readable`. **43 parameters.** Only control ports: `latency` (out), `freeWheeling` (in), `enabled` (in, `lv2:designation lv2:enabled` = bypass)                                                                                                                                                      | LV2.cpp 1122-1168, 1268-1284, 1383-1410; built `dsp.ttl`                                                          |
| F7  | Ports (index: symbol): 0 `audio_in_1`, 1 `audio_in_2`, 2 `audio_out_1`, 3 `audio_out_2`, 4 `in` (atom: `midi:MidiEvent`, `patch:Message`, `time:Position`), 5 `out` (atom), 6 `latency`, 7 `freeWheeling`, 8 `enabled`                                                                                                                                                                                                                                                                                                             | mini-host port dump (§3.4)                                                                                        |
| F8  | `lv2:requiredFeature urid:map, opts:options, bufs:boundedBlockLength`; `lv2:extensionData state:interface`; `lv2:optionalFeature lv2:hardRTCapable`. `instantiate` returns **nullptr** if `opts:options` or the `bufs:maxBlockLength` option is missing. `prepareToPlay` runs at instantiate with `maxBlockLength`                                                                                                                                                                                                                 | LV2.cpp 1251-1258, 1490-1519, 850-862                                                                             |
| F9  | State = one key `https://www.tone3000.com/plugin:StateString` = base64 of `getStateInformation()` (full chain incl. **embedded model bytes**). Restore also accepts key `https://www.tone3000.com/plugin:Program` (`atom:Int`) → `setCurrentProgram(i)`. No `state:threadSafeRestore`, `mapPath`, `makePath`                                                                                                                                                                                                                       | LV2.cpp 92, 746-798                                                                                               |
| F10 | `manifest.ttl` lists **128** `pset:Preset` entries `<https://www.tone3000.com/plugin:preset1>` … `:preset128`, each `state:state [ <…:Program> "N"^^xsd:int ]` with **N = 0…127** (so `:presetK` ↔ program K−1). `rdfs:label` is whatever `getProgramName()` returned on the **build machine** → **all "(empty)"** in the official build                                                                                                                                                                                           | LV2.cpp 989-997; tarball `manifest.ttl`                                                                           |
| F11 | `setCurrentProgram(n)` called off the JUCE message thread is **deferred** (`pendingHostProgram` + `triggerAsyncUpdate`). It then loads `presetManager.list()[n]`: **user presets first** (case-insensitive name sort, then re-ordered by `order.json`), **then factory**; out-of-range index ignored; re-selecting the active preset is a no-op                                                                                                                                                                                    | tone3000-plugin `plugin/src/ProcessorPresets.cpp:324-372`, `PresetManager.cpp:183-244`                            |
| F12 | A JUCE LV2 on Linux starts its own **message thread at instantiate** (`detail::MessageThread`), independent of any editor; it calls `XOpenDisplay` and silently continues without a display                                                                                                                                                                                                                                                                                                                                        | JUCE `detail/juce_LinuxMessageThread.h:43-92`, `juce_XWindowSystem_linux.cpp:3373-3395`                           |
| F13 | Linux paths: presets `~/.config/TONE3000/Presets/*.t3kpreset`, order `~/.config/TONE3000/Presets/order.json` (JSON array of ids `user:<uuid>` / `factory:<id>`), user factory overlay `Presets/Factory`, system factory `/usr/share/TONE3000/Presets/Factory`; machine settings `~/.config/TONE3000/preferences.settings` (keys `multiCore`, `namSlimSizeDefault`, `calibrateInput`, `inputCalibrationLevel`, `osEnabled`, `osFactor`); log `~/.config/TONE3000/TONE3000.log`; local model stash `~/.config/TONE3000/LocalModels/` | `PresetManager.cpp:16-22,34,73-76,298-319`, `ProcessorState.cpp:21-62`                                            |
| F14 | `.t3kpreset` = `"T3KH"` header + ValueTree body; embeds model bytes (`ModelCache/CachedModel`), so loading on another machine needs no network. Factory presets are 0.6–4.5 MB                                                                                                                                                                                                                                                                                                                                                     | `PresetFile.h`, `ProcessorState.cpp:238-262`, `ProcessorHistory.cpp:170-192`, `plugin/docs/local-models.md:93-97` |
| F15 | After a preset load the plugin emits **`patch:Set` on its atom out for every faceplate parameter** (36 observed). It never emits `state:StateChanged` (it only reports `programChanged`)                                                                                                                                                                                                                                                                                                                                           | `ProcessorPresets.cpp:137-190`; LV2.cpp 840-848; mini-host count                                                  |
| F16 | Presets deliberately exclude calibration, oversampling, solo, input mode, MIDI map, window size; `preferences.settings` seeds those per machine                                                                                                                                                                                                                                                                                                                                                                                    | tone3000-plugin README "Settings and where they live"                                                             |
| F17 | `-DHEADLESS=ON` builds VST3 only and leaves `hasEditor()` true → not a route to a GUI-less LV2 (source build not needed on Trixie anyway)                                                                                                                                                                                                                                                                                                                                                                                          | `plugin/CMakeLists.txt:38-80`, `Processor.cpp:2067-2080`                                                          |

### 3.3 PiPedal behaviour (this fork's `main`, 787c450)
| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence (paths in this repo)                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| F18 | Features passed at instantiate: `urid:map/unmap`, `log:log`, **`opts:options`** (sampleRate, `bufsz:minBlockLength` = `maxBlockLength` = `nominalBlockLength` = host buffer, `bufsz:sequenceSize` 16 KiB), `state:mapPath/makePath/freePath`, filebrowser, `worker:schedule`. Required-feature check passes for F8 (`opts:options`, `bufsz:boundedBlockLength` are in the supported list). The sampleRate *option* is hard-coded 44100 but JUCE uses the instantiate argument | `src/Lv2Effect.cpp:95,172-210`, `src/OptionsFeature.cpp:58-98`, `src/PluginHost.cpp:974-981,1180-1202`                         |
| F19 | **Released 2.0.110 (2026-07-27) rejects plugins whose patch properties are `atom:Float`** (`hasUnsupportedPatchProperties`, comment "e.g. Juce LV2 plugins"). `main` since **PR #563 (commit `d70b1174`, merged 2026-09-13)** accepts `atom:Float` and renders them with generic controls (`PatchPropertyControl.tsx`). `atom:Path` → file chooser; `atom:String` ignored; other types still reject                                                                           | `src/PluginHost.cpp:714-871,1045-1095,2234-2318`; `vite/src/pipedal/PluginControlView.tsx:712-732`, `PatchPropertyControl.tsx` |
| F20 | **MIDI is not delivered to plugin atom ports** (`writeMidiEvent` commented out; "No routing or handling implemented (yet)"). PiPedal consumes Program Change for its own preset switching (CC0 = bank select)                                                                                                                                                                                                                                                                 | `src/AudioHost.cpp:939-944,981-991`, `src/Lv2Effect.cpp:771-780`, `src/pch.h:26-28`                                            |
| F21 | MIDI bindings target **control ports** and the `__bypass` pseudo-port only; patch properties are not offered. The pedalboard **Split** item (A/B, Mix, L/R) is bindable                                                                                                                                                                                                                                                                                                       | `src/Lv2Pedalboard.cpp:380-450,855-861`, `vite/src/pipedal/MidiBindingsDialog.tsx:159-227`                                     |
| F22 | LV2 `pset:Preset`s with `state:state` are imported **once per plugin URI** into PiPedal's "plugin presets" store with the ttl label, as "lilv presets" (`lilvPresetUri`). Loading one: full pedalboard reload → in `Lv2Effect` ctor: lilv state restore → **immediate `Save()`** → `RestoreState(saved)` → `lilvPresetUri` cleared                                                                                                                                            | `src/PluginHost.cpp:1922-1998`, `src/PiPedalModel.cpp:370-399,2590-2620`, `src/Lv2Effect.cpp:273-290`                          |
| F23 | Plugin state is re-captured when the plugin emits `patch:Set` / `state:StateChanged` on its out port (`MaybeLv2StateChanged`/`Lv2StateChanged` → `UpdatePluginState` → `GetLv2State`), and **always re-synced from live instances when a PiPedal preset is saved** (`SyncLv2State`)                                                                                                                                                                                           | `src/Lv2Effect.cpp:1324-1350`, `src/PiPedalModel.cpp:535-566,1003-1030,1060-1070`, `src/AudioHost.cpp:2505-2528`               |
| F24 | Loading a PiPedal preset builds a **new `Lv2Pedalboard` on the model thread** (every plugin re-instantiated and state-restored in its ctor, never on the audio thread), then swaps on the RT thread. **Snapshots** apply control values only; their `lv2State` application is commented out → snapshots cannot switch TONE3000 rigs                                                                                                                                           | `src/PiPedalModel.cpp:1372-1385,3094-3113`, `src/AudioHost.cpp:160-234,1934-1945`, `src/Pedalboard.cpp:328-360`                |
| F25 | LV2 scan = `lv2_path` from config: default `/usr/lib/lv2:/usr/local/lib/lv2:/usr/modep/lv2` (`/etc/pipedal/config/config.json`), user override `/var/pipedal/config/config.json`; `LV2_PATH` env is set explicitly so `~/.lv2` is **not** scanned                                                                                                                                                                                                                             | `src/PluginHost.cpp:463-468`, `config/config.json:14`, `src/PiPedalConfiguration.cpp:55`                                       |
| F26 | Service: `User=pipedal_d`, **HOME=`/var/pipedal/home`** (useradd `-m --home /var/pipedal/home`), groups `audio`,`netdev`; unit has `LimitRTPRIO=95`, `LimitMEMLOCK=infinity`, `Nice=-9`, `Restart=always`, `Type=notify`, no seccomp/`ProtectSystem`                                                                                                                                                                                                                          | `src/ConfigMain.cpp:1146-1155`, `src/templates/pipedald.service.template`                                                      |
| F27 | Audio thread SCHED_RR prio 90; plugins get a fixed block = ALSA period per cycle (UI offers 16…2048); sample rates probed per device; plugin-spawned RT threads are allowed by the limits above                                                                                                                                                                                                                                                                               | `src/SchedulerPriority.cpp:34-42`, `src/AlsaDriver.cpp:569-593,1856-1865`, `vite/src/pipedal/AudioDeviceDialog.tsx:78`         |
| F28 | State serialisation: `atom:String` stored verbatim in JSON preset files; no PiPedal-side size cap found; websocketpp default `max_message_size` (32 MB) not overridden                                                                                                                                                                                                                                                                                                        | `src/StateInterface.cpp:60-75,108-136,226-255`, `src/WebServer.cpp:64,561`                                                     |
| F29 | PiPedal guidance: "16x4 audio buffer configuration is a highly recommended choice"; MOTU M2 @48k: 16×3 = 3.9 ms, 32×4 = 5.7 ms, 64×4 = 8.6 ms; TooB NAM: "practically unlimited NAM instances on Pi 5"; no numeric A2 CPU figures anywhere public                                                                                                                                                                                                                             | `docs/Configuring.md:96-97`, `docs/AudioLatency.md:21-32`, `docs/ReleaseNotes.md:196-199`                                      |
| F30 | Building from source is supported on Pi OS (≥ 2 GB RAM, node ≥ 22, apt list in `docs/BuildPrerequisites.md`); `./build-prod.sh` then `sudo ./makePackage.sh` → `.deb`. Cross-compiling unsupported                                                                                                                                                                                                                                                                            | `docs/BuildingPiPedalFromSource.md`, `docs/BuildPrerequisites.md`, `build-prod.sh`                                             |

### 3.4 Empirical test (2026-10-04, x86-64 sandbox, no display)
Built the TONE3000 LV2 from source (Ubuntu 24.04, GCC 13.3; Eigen 3.4 substituted for the GitLab submodule via a one-line equivalent edit in `NAM/lstm.h` because GitLab was blocked in the sandbox) and ran it in a 200-line lilv host offering exactly PiPedal's feature set (§12.3). `HOME` held one preset: factory "Marshall Bluesbreaker" (2 NAM A2 + stereo IR).

| Test                                                                  | Result                                                                                                                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instantiate without `DISPLAY`                                         | OK, 5.8 ms                                                                                                                                                                       |
| Required features reported by lilv                                    | `urid:map`, `opts:options`, `bufs:boundedBlockLength`                                                                                                                            |
| Patch parameters found                                                | 43                                                                                                                                                                               |
| `pset:Preset` entries                                                 | 128; `:preset1` ↔ Program 0; all labelled "(empty)"                                                                                                                              |
| Apply `:preset1` via `lilv_state_restore`                             | returns immediately (deferred); plugin log: preset loaded, 3 models "queued for load" from embedded bytes, "NAM model prepared" ×2, "IR prepared"; output changed within ≈130 ms |
| PiPedal's exact sequence (restore → immediate save → restore that) ×6 | immediate save = default chain (5.5 KB), **deferred load wins 6/6**; 36 `patch:Set` events follow (→ PiPedal re-captures, F23)                                                   |
| Save after load                                                       | 1,760,266-byte state ttl; single `StateString` key, 1.32 MB base64                                                                                                               |
| Restore that state into a fresh instance                              | 25.7 ms; `lilv_state_equals` with the saved state = **YES**                                                                                                                      |
| DSP load (2.1 GHz Xeon core, multi-core on)                           | 16-sample blocks 8.6–13.7 %; 64: 5–7 %; 256: ≈5 % — *not a Pi number*                                                                                                            |
| GCC 12 compile (Bookworm-class)                                       | fails on `AudioDSPTools/.../ResamplingContainer.h:89` unless `-fpermissive`; with it the full LV2 builds (not needed on Trixie)                                                  |

---

## 4. Constraints and non-goals

**Hard constraints (from §3):**
- C1. PiPedal must be ≥ commit `d70b1174` (this fork's `main` qualifies); the released `.deb` 2.0.110 cannot show the plugin (F19).
- C2. No MIDI reaches the plugin (F20): TONE3000's own PC/CC map is unusable; all live control goes through PiPedal presets, bypass, and the Split.
- C3. TONE3000 knobs are not MIDI-bindable (F21) — phone UI only.
- C4. Rig switching = PiPedal preset load = plugin re-instantiation + state restore (F24); snapshots do not work for TONE3000.
- C5. Preset files must live under `/var/pipedal/home/.config/TONE3000/Presets/` owned by `pipedal_d` (F13, F26).
- C6. Preset numbering follows TONE3000's list order (F11) and is frozen into the manifest labels we write (F10) — keep names prefixed `01 …`, `02 …` and never add files on the Pi without re-checking.

**Non-goals (v1):**
- Browsing/downloading tones on the Pi (that's Option B).
- Editing the chain (blocks, models, per-block EQ) from the phone. Chain edits happen on the Mac.
- Patching PiPedal or TONE3000 source. Candidate patches are listed in §8 Phase 6 for later.
- Hotspot/P2P configuration beyond PiPedal's stock feature.

---

## 5. Technical design

### 5.1 System overview
```
                 MacBook Air (design time)                      Raspberry Pi 5 / Trixie (gig time)
┌─────────────────────────────────────────┐          ┌───────────────────────────────────────────────┐
│ TONE3000 standalone (official .pkg)     │          │ pipedald (built from this fork's main)        │
│  - sign in, browse/download A2 models   │  copy    │  ALSA 48 kHz, 16x4 / 32x4, SCHED_RR 90        │
│  - build chain, save rigs as presets    │ ───────▶ │  LV2_PATH: /usr/local/lib/lv2 (+defaults)     │
│ ~/Library/Application Support/TONE3000/ │ scp/rsync│  /var/pipedal/home/.config/TONE3000/           │
│    Presets/01 Clean.t3kpreset           │          │     Presets/*.t3kpreset, order.json            │
│    Presets/02 Crunch.t3kpreset          │          │     preferences.settings, TONE3000.log         │
│    Presets/order.json                   │          │  /usr/local/lib/lv2/TONE3000.lv2 (official     │
└─────────────────────────────────────────┘          │     v0.0.11 aarch64, manifest labels rewritten)│
                                                     └───────────────┬───────────────────────────────┘
                                                                     │ WebSocket (LAN or PiPedal hotspot)
                                                     ┌───────────────┴───────────────┐
                                                     │ Phone browser: PiPedal web UI  │
                                                     │  presets, TONE3000 knobs, bypass│
                                                     └────────────────────────────────┘
          USB MIDI footswitch ──▶ pipedald: PC → PiPedal preset (song); CC → Split A/B, TooB fx, bypass
```

### 5.2 Pedalboard layout (per PiPedal preset = one song)
```
in ─▶ TooB Tuner ─▶ ┌─ Split (A/B, MIDI-bound) ─┐ ─▶ TooB Delay ─▶ TooB Reverb ─▶ out
                    │ A: TONE3000 #1 (rhythm)   │       (MIDI on/off)   (MIDI on/off)
                    │ B: TONE3000 #2 (lead)     │
                    └───────────────────────────┘
```
- One PiPedal **preset per song**; it stores both TONE3000 states (each ≈1–5 MB) plus effect settings.
- **Intra-song** changes: Split A/B (instant, no reload), effect bypasses, TONE3000 bypass. **Song-to-song**: PiPedal preset change (full reload; gap measured in §9).
- Single-instance variant (lower CPU): drop the Split; rig changes only via presets.

### 5.3 How a rig gets into the LV2 instance (the bridge)
```
 Mac standalone            Pi filesystem                    PiPedal                      TONE3000 LV2 (JUCE)
 ──────────────            ─────────────                    ───────                      ───────────────────
 save "01 Clean"  ──▶  Presets/01 Clean.t3kpreset
                        (models embedded, F14)
                                                   user picks plugin preset "01 Clean"
                                                   (imported from manifest, F22)
                                                   ──▶ reload pedalboard
                                                       Lv2Effect ctor:
                                                       lilv_state_restore(pset:preset1) ─▶ retrieve(): key :Program = 0
                                                                                           ─▶ setCurrentProgram(0)  [deferred to JUCE msg thread, F11]
                                                       Save() ─────────────────────────▶ store(): StateString (still default)  ← F22 race, see R6
                                                       RestoreState(saved default) ───▶ setStateInformation(default)
                                                                                      msg thread: loadPreset(list[0]) → chain restored,
                                                                                      models built from embedded bytes, 36× patch:Set out (F15)
                                                       MaybeLv2StateChanged ◀──────────┘
                                                       UpdatePluginState → GetLv2State ─▶ store(): StateString = full rig (≈1.3 MB)
                                                   user clicks Save preset → SyncLv2State (F23) → PiPedal preset holds the rig
 next gig:  PiPedal preset load ─▶ new instance ─▶ retrieve(): StateString ─▶ setStateInformation(rig) ─▶ ready (≈26 ms + model build)
```
Verified end-to-end in §3.4 except the PiPedal UI click itself (Gate 3).

### 5.4 Preset numbering contract
- TONE3000 program *n* = entry *n* of: user presets (name-sorted, then `order.json`), then factory (F11).
- PiPedal shows manifest preset *k* (`:presetk`) ↔ program *k−1* (F10).
- We **rewrite the 128 labels** in `manifest.ttl` from a `names.txt` that mirrors the Mac's list order (§12.1) **before** PiPedal first scans the bundle (import is once per URI, F22). If labels need changing later: edit them in PiPedal's plugin-preset UI, or clear PiPedal's stored plugin presets for the URI and restart.
- Convention: name rigs `01 Clean`, `02 Crunch`, … on the Mac so sort order = intended order; keep `order.json` in sync by copying it.

### 5.5 File and path map (Pi)
| Item                     | Path                                                                   | Owner                  |
| ------------------------ | ---------------------------------------------------------------------- | ---------------------- |
| LV2 bundle               | `/usr/local/lib/lv2/TONE3000.lv2/`                                     | root (readable by all) |
| Rig presets              | `/var/pipedal/home/.config/TONE3000/Presets/*.t3kpreset`, `order.json` | `pipedal_d:pipedal_d`  |
| Machine settings         | `/var/pipedal/home/.config/TONE3000/preferences.settings`              | `pipedal_d`            |
| Plugin log               | `/var/pipedal/home/.config/TONE3000/TONE3000.log`                      | `pipedal_d`            |
| Local model stash (auto) | `/var/pipedal/home/.config/TONE3000/LocalModels/`                      | `pipedal_d`            |
| PiPedal config           | `/var/pipedal/config/config.json` (`lv2_path`)                         | root                   |
| PiPedal presets/banks    | `/var/pipedal/` (storage) — back up whole dir                          | `pipedal_d`            |
| Service                  | `systemctl status pipedald`; `journalctl -u pipedald -f`               | —                      |

### 5.6 `preferences.settings` (machine-wide, per F13/F16)
JUCE `PropertiesFile` XML. Let the plugin create it on first run, then edit; expected shape:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<PROPERTIES>
  <VALUE name="multiCore" val="1"/>            <!-- 1 = use RT worker pool (default) -->
  <VALUE name="namSlimSizeDefault" val="0.0"/> <!-- 0.0 = lite default size for new blocks -->
  <VALUE name="osEnabled" val="0"/>            <!-- oversampling off for CPU -->
  <VALUE name="osFactor" val="0"/>
  <VALUE name="calibrateInput" val="0"/>
  <VALUE name="inputCalibrationLevel" val="12.0"/>
</PROPERTIES>
```
(Verify exact key spellings against the file the plugin writes; keys per `ProcessorState.cpp:21-28`.)

### 5.7 MIDI map (gig)
| Control           | Target                     | Mechanism                               |
| ----------------- | -------------------------- | --------------------------------------- |
| Footswitch PC 0…n | PiPedal preset *n* (song)  | PiPedal native (F20)                    |
| CC A              | Split A/B select           | PiPedal MIDI binding on the Split (F21) |
| CC B / C          | TooB Delay / Reverb on-off | PiPedal binding (control ports)         |
| CC D              | TONE3000 bypass            | PiPedal `__bypass` binding (F21)        |
| (none)            | TONE3000 knobs             | phone UI only (C3)                      |

### 5.8 Boot and failure behaviour
- `pipedald` is `Restart=always`, `Type=notify` (F26). On crash it restarts into the last pedalboard.
- TONE3000 instantiation on restart: state restore from PiPedal preset (no folder preset needed at this point; the folder is only needed when *loading a plugin preset* via the manifest).
- If the preset folder is missing, selecting a plugin preset silently does nothing (F11, out-of-range ignored) — the plugin log shows no "[Presets] Loaded preset" line.

---

## 6. Risk register

| #   | Risk                                                                              | Status                          | Evidence / mitigation / residual                                                                                                          |
| --- | --------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Official binary incompatible with Pi OS                                           | **Resolved**                    | Trixie confirmed (F3)                                                                                                                     |
| R2  | PiPedal hides the plugin                                                          | **Resolved → Phase 1**          | F19; build this fork's `main` (F30)                                                                                                       |
| R3  | LV2 needs a display                                                               | **Resolved**                    | F12 + §3.4; install `libx11-6 libfontconfig1` if Lite (F2)                                                                                |
| R4  | MIDI PC → TONE3000 presets                                                        | **Resolved as impossible (C2)** | design §5.2/5.7                                                                                                                           |
| R5  | No headless way to load a rig                                                     | **Resolved**                    | §5.3 verified in §3.4                                                                                                                     |
| R6  | F22 race wipes the loading preset                                                 | **Mitigated, low residual**     | deferred load won 6/6; re-capture via F15/F23. If it misfires: re-select the plugin preset. Permanent fix = TONE3000 fork patch (Phase 6) |
| R7  | 128 "(empty)" labels                                                              | **Mitigated**                   | §5.4 + script §12.1                                                                                                                       |
| R8  | Numbering drift                                                                   | **Mitigated**                   | C6 convention; §12.1 regenerates labels from `names.txt`                                                                                  |
| R9  | Multi-MB states in PiPedal presets / web broadcasts                               | **Open — measure**              | F28; NFR4 test in §9                                                                                                                      |
| R10 | Preset-switch gap                                                                 | **Open — measure**              | F24; §9; design keeps intra-song changes on the Split                                                                                     |
| R11 | CPU on Pi 5 (A2, 16-sample blocks, 2 instances)                                   | **Open — measure**              | F29; §9; defaults oversampling off, multi-core on                                                                                         |
| R12 | Plugin RT threads under pipedald                                                  | **Resolved**                    | F26/F27                                                                                                                                   |
| R13 | Snapshots don't switch rigs                                                       | **Resolved (C4)**               | —                                                                                                                                         |
| R14 | Knobs not MIDI-bindable                                                           | **Resolved (C3)**               | —                                                                                                                                         |
| R15 | Mac vs Pi mismatch of non-preset settings                                         | **Resolved**                    | F16; §5.6                                                                                                                                 |
| R16 | PiPedal's 44100 sampleRate option                                                 | **Resolved**                    | F18 vs F8                                                                                                                                 |
| R17 | In-process crash takes audio down                                                 | **Open — soak**                 | NFR5                                                                                                                                      |
| R18 | PiPedal build on Trixie (apt names changed since Bookworm, e.g. `libasound2t64`?) | **Open**                        | Phase 1 step 1 verifies the apt list; record deviations in §10                                                                            |
| R19 | PiPedal `main` regressions vs the release                                         | **Open**                        | Phase 1 Gate includes existing TooB rig still working                                                                                     |

---

## 7. Environments and tooling

| Environment                           | Use                                                                                                           | Notes                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Pi 5 (Trixie)**                     | all builds and tests                                                                                          | only supported PiPedal build host (F30). Reach via SSH from Rix's Mac                          |
| **MacBook Air (Apple Silicon)**       | TONE3000 standalone, rig design, file transfer                                                                | official `.pkg`; presets at `~/Library/Application Support/TONE3000/Presets/`                  |
| **Claude Cowork VM on the Mac**       | read/edit files in connected folders, run scripts, SSH to the Pi *if* the account's network policy allows LAN | Ubuntu 22.04 arm64, no root → cannot build. Connected folders: this repo and `tone3000-plugin` |
| **Docker on the Mac** (fallback only) | arm64 TONE3000 source build                                                                                   | not required on Trixie; Dockerfile in §12.4                                                    |
| **Cloud sandbox**                     | x86 proof-of-mechanism done (§3.4)                                                                            | no Pi access                                                                                   |

Repos:
- `rixrix/pipedal` (this repo) — `main` = upstream `787c450`. Blueprint lives here. Any PiPedal change → branch `gig/<topic>`, logged in §10.
- `rixrix/tone3000-plugin` — reference only; untouched unless Phase 6.
- Gig config (scripts, `names.txt`, `preferences.settings`, backups) → folder `tools/gig-rig/` in this repo *or* a separate `nam-gig-rig` repo (decide in §11 Q4). Until decided, scripts are inlined in §12.

---

## 8. Tasks by phase

Conventions: every task has an owner (Rix / Agent), an output, and the gate it feeds. "Agent" = whoever continues this work with tool access to the Pi; otherwise the agent prepares commands and Rix runs them. Tick boxes as completed and append dated notes under the task.

### Phase 0 — Inputs and access
- [ ] **P0.1 (Rix)** Provide Pi SSH access: hostname/IP, user, key. Agent tests `ssh <host> true`.
- [ ] **P0.2 (Rix)** Run on the Pi and paste:
  ```sh
  cat /etc/os-release | head -2; ldd --version | head -1
  dpkg -l pipedal | tail -1; pipedalconfig --version 2>/dev/null
  ls /usr/local/lib/lv2 /usr/lib/lv2 2>/dev/null | head
  free -h | head -2; df -h / | tail -1; nproc
  cat /var/pipedal/config/config.json 2>/dev/null
  aplay -l; amidi -l
  ```
- [ ] **P0.3 (Rix)** Hardware: audio interface model, MIDI footswitch/controller model, Pi image Lite vs Desktop.
- [ ] **P0.4 (Rix)** Connect `~/Library/Application Support/TONE3000` to the Cowork task (or state that no rigs exist yet → start with the 8 factory presets).
- [ ] **P0.5 (Rix)** Go-aheads: (a) rebuild and reinstall PiPedal from `main` on the Pi; (b) create files under `/var/pipedal/home/.config/TONE3000/`.
- [ ] **P0.6 (Agent)** Back up `/var/pipedal` and `/etc/pipedal` to the Mac before any change (`sudo tar czf pipedal-backup-$(date +%F).tgz /var/pipedal /etc/pipedal`).

**Gate 0:** P0.1–P0.5 answered; backup taken.

### Phase 1 — PiPedal from `main` (needed unless P0.2 shows a post-2026-09-13 build)
- [ ] **P1.1** Confirm fork `main` == upstream `main` or decide to fast-forward (`git fetch https://github.com/rerdavies/pipedal.git main`; compare).
- [ ] **P1.2** On the Pi: install prerequisites per `docs/BuildPrerequisites.md` (cmake ninja-build build-essential g++ git nodejs npm liblilv-dev libboost-dev libsystemd-dev catch libasound2-dev uuid-dev authbind libavahi-client-dev libnm-dev libicu-dev libsdbus-c++-dev libzip-dev google-perftools libgoogle-perftools-dev libpipewire-0.3-dev libbz2-dev libssl-dev librsvg2-dev). Record any Trixie package-name deviations in §10 (R18).
- [ ] **P1.3** `git clone --recurse-submodules https://github.com/rixrix/pipedal.git ~/src/pipedal && cd ~/src/pipedal && ./react-config`
- [ ] **P1.4** `./build-prod.sh` (expect 30–60 min; `-j3` per the script; watch RAM) then `sudo ./makePackage.sh` → `build/pipedal_<ver>_arm64.deb`.
- [ ] **P1.5** `sudo apt install ./build/pipedal_*.deb`; `sudo systemctl restart pipedald`; open the web UI; confirm existing TooB pedalboard still plays (R19).
- [ ] **P1.6** Record installed version/commit in §10.

**Gate 1:** PiPedal runs from a build that includes commit `d70b1174`; existing rig works.

### Phase 2 — Install the TONE3000 LV2
- [ ] **P2.1** On the Pi: `cd /tmp && curl -LO https://github.com/tone-3000/tone3000-plugin/releases/download/v0.0.11/TONE3000-v0.0.11-linux-aarch64.tar.gz && tar xzf TONE3000-v0.0.11-linux-aarch64.tar.gz` (verify `sha256sum`, record in §10).
- [ ] **P2.2** `sudo apt install -y libx11-6 libfontconfig1 libasound2` (no-ops if present).
- [ ] **P2.3** Create `names.txt` (preset names in TONE3000 list order; for a first test use the 8 factory names in alphabetical order) and run the relabel script (§12.1) on the extracted `TONE3000.lv2/manifest.ttl`.
- [ ] **P2.4** `sudo mkdir -p /usr/local/lib/lv2 && sudo cp -r TONE3000-v0.0.11-linux-aarch64/TONE3000.lv2 /usr/local/lib/lv2/ && sudo chmod -R a+rX /usr/local/lib/lv2/TONE3000.lv2`
- [ ] **P2.5** `lv2ls | grep tone3000` and `lv2info https://www.tone3000.com/plugin | grep -c Parameter` (expect 43-ish lines) — install `lilv-utils` if missing.
- [ ] **P2.6** `sudo systemctl restart pipedald`; in the web UI add "TONE3000" to a test pedalboard; confirm passthrough audio and that the knobs render (F19).
- [ ] **P2.7** Check `journalctl -u pipedald --since -5min` for errors; check `/var/pipedal/home/.config/TONE3000/TONE3000.log` exists and shows `prepareToPlay`.

**Gate 2:** TONE3000 instantiates inside PiPedal, passes audio, shows 43 controls, no errors in logs.

### Phase 3 — Rig pipeline (Mac → Pi)
- [ ] **P3.1 (Mac)** In the TONE3000 standalone build/rename rigs as `01 …`, `02 …`; note the order shown in the preset browser (enable "preset PC numbers" view in Plugin Settings to see indices).
- [ ] **P3.2** Copy presets: `rsync -av "$HOME/Library/Application Support/TONE3000/Presets/" pi:/tmp/t3k-presets/` then on the Pi `sudo -u pipedal_d mkdir -p /var/pipedal/home/.config/TONE3000/Presets && sudo cp -r /tmp/t3k-presets/. /var/pipedal/home/.config/TONE3000/Presets/ && sudo chown -R pipedal_d:pipedal_d /var/pipedal/home/.config/TONE3000`. (First test may use the tarball's `factory-presets/` instead.)
- [ ] **P3.3** Regenerate `names.txt` from the Pi folder listing (`ls Presets/*.t3kpreset | sort -f`, then apply `order.json` if present) and re-run §12.1 **if** the order differs from P2.3; if PiPedal already imported labels, fix them in its plugin-preset UI or clear and re-import.
- [ ] **P3.4** Write `/var/pipedal/home/.config/TONE3000/preferences.settings` (§5.6) after the plugin has created it once; restart `pipedald`.
- [ ] **P3.5** In PiPedal: TONE3000 → plugin presets → select "01 …"; wait ≥ 2 s; verify tone changed and the log shows `[Presets] Loaded preset: 01 …` and `[ModelLoader] NAM model prepared`. Save PiPedal preset "01 …". Repeat for each rig.
- [ ] **P3.6** Restart `pipedald`; load PiPedal preset "01 …"; verify the rig is back (state path, no folder dependency).
- [ ] **P3.7** Build the two-instance Split board (§5.2) for one song; save.

**Gate 3:** A Mac-built rig plays on the Pi from a PiPedal preset after a service restart.

### Phase 4 — Measure (fill §9 tables)
- [ ] **P4.1** CPU: 1 and 2 TONE3000 instances; 16×4 and 32×4; multi-core on/off; A2 lite vs full models.
- [ ] **P4.2** Preset-switch gap: record Pi output into the Mac DAW while switching presets; measure silence/click.
- [ ] **P4.3** Phone UI: time to open preset list and to load a preset with ≥ 10 rigs stored; note PiPedal preset file sizes (`du -sh /var/pipedal`).
- [ ] **P4.4** 1-hour soak with the Split board; `journalctl -u pipedald` for xruns/asserts/restarts.
- [ ] **P4.5** Run `minihost` on the Pi (§12.3) for independent instantiate/restore/DSP numbers.

**Gate 4:** NFR1–NFR5 recorded with pass/fail; if R10/R11 fail, decide single-instance design or model size changes.

### Phase 5 — Gig configuration and hand-off
- [ ] **P5.1** MIDI bindings per §5.7; test every footswitch action.
- [ ] **P5.2** Hotspot/P2P enabled and tested with the phone; auto-start verified by power-cycle (time to sound).
- [ ] **P5.3** Backups: `/var/pipedal`, `/etc/pipedal`, `Presets/`, `names.txt`, `preferences.settings`, the exact `.tar.gz` of TONE3000 → gig-config folder/repo.
- [ ] **P5.4** Write the "stage checklist" (power order, what to do if no sound, how to restart `pipedald` from the phone) at the end of this file.

**Gate 5:** rehearsal run-through with the real footswitch; checklist exists.

### Phase 6 — Optional upstream work (only if Phase 4/5 shows a need)
- [ ] **P6.1** TONE3000 fork: make `setCurrentProgram` synchronous off the audio thread (fixes R6) — ~3 lines in `plugin/src/ProcessorPresets.cpp:347-360`, mirrors what `setStateInformation` already does.
- [ ] **P6.2** TONE3000 fork: `hasEditor()` false under `HEADLESS` and add `LV2` to the HEADLESS format list → GUI-less LV2 without libX11/fontconfig link.
- [ ] **P6.3** PiPedal: deliver MIDI to plugin atom ports (`src/AudioHost.cpp:939-944`, `src/Lv2Effect.cpp:771-780`) → would re-enable TONE3000's PC/CC map. Discuss with rerdavies before investing (see `docs/` contribution notes).
- [ ] **P6.4** PiPedal: allow MIDI bindings on numeric patch properties (extends PR #563).

---

## 9. Measurement protocol (fill in during Phase 4)

| Measurement                                   | Method                           | Result | Date |
| --------------------------------------------- | -------------------------------- | ------ | ---- |
| CPU, 1× TONE3000, 16×4, multi-core on         | PiPedal status bar, 60 s average |        |      |
| CPU, 2× TONE3000 (Split), 16×4                | same                             |        |      |
| CPU, 2× TONE3000, 32×4                        | same                             |        |      |
| Xruns over 10 min at chosen buffer            | `journalctl -u pipedald`         |        |      |
| Preset-switch gap (ms) and clicks             | DAW recording, 5 switches        |        |      |
| Instantiate + state restore time (ms)         | `minihost` on Pi                 |        |      |
| Load-to-ready after plugin-preset select (ms) | `minihost`/log timestamps        |        |      |
| PiPedal preset file size per rig              | `du -sh`, JSON size              |        |      |
| Phone preset list open time (10 rigs)         | stopwatch                        |        |      |
| Boot to sound (s)                             | power-cycle, stopwatch           |        |      |
| 1 h soak: restarts/asserts                    | `journalctl`                     |        |      |

---

## 10. Decision log

| Date       | Decision / change                                                                         | Rationale                                                                            |
| ---------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 2026-10-03 | Chose Option A (LV2 in PiPedal) over Option B (new daemon) for gigging                    | PiPedal is the proven appliance; TONE3000 DSP reused unchanged; zero new daemon code |
| 2026-10-04 | PiPedal must be built from fork `main` (787c450)                                          | released 2.0.110 rejects `atom:Float` patch properties (F19)                         |
| 2026-10-04 | Use the official TONE3000 v0.0.11 aarch64 binary; no TONE3000 build                       | Rix is on Trixie (F3)                                                                |
| 2026-10-04 | Rig switching via PiPedal presets + MIDI-bound Split; TONE3000's own MIDI map is not used | PiPedal delivers no MIDI to plugins (F20)                                            |
| 2026-10-04 | Rewrite manifest labels from `names.txt` before first scan                                | all 128 labels are "(empty)" (F10); import is once per URI (F22)                     |
| 2026-10-04 | No PiPedal/TONE3000 source changes in Phases 0–5                                          | user instruction; candidates parked in Phase 6                                       |

(Append new rows; never delete.)

---

## 11. Open questions

| #   | Question                                                                          | Needed for                          | Owner         |
| --- | --------------------------------------------------------------------------------- | ----------------------------------- | ------------- |
| Q1  | Pi SSH host/user; can the Cowork VM reach it?                                     | Phase 0                             | Rix           |
| Q2  | PiPedal installed from `.deb` or built from source? (P0.2 output)                 | whether Phase 1 is needed           | Rix           |
| Q3  | Audio interface and MIDI footswitch models                                        | buffer settings (§9), §5.7 bindings | Rix           |
| Q4  | Gig-config location: `tools/gig-rig/` in this repo vs separate `nam-gig-rig` repo | Phase 5                             | Rix           |
| Q5  | Do rigs already exist on the Mac, or start with the 8 factory presets?            | Phase 3                             | Rix           |
| Q6  | Single-instance or two-instance (Split) default board?                            | depends on R11 measurement          | after Phase 4 |

---

## 12. Appendices

### 12.1 Relabel the 128 manifest presets
`names.txt`: one name per line in TONE3000 list order (user presets name-sorted/`order.json`, then factory). Lines beyond the file's count stay "(empty)".
```sh
#!/usr/bin/env bash
# usage: relabel-manifest.sh TONE3000.lv2/manifest.ttl names.txt
set -euo pipefail
ttl="$1"; names="$2"; cp "$ttl" "$ttl.bak"
i=1
while IFS= read -r name || [ -n "$name" ]; do
  [ -z "$name" ] && { i=$((i+1)); continue; }
  esc=${name//\"/\\\"}
  # replace the label inside the block that starts with <...:preset${i}>
  awk -v n="$i" -v lbl="$esc" '
    $0 ~ "<https://www.tone3000.com/plugin:preset" n ">" {inblk=1}
    inblk && /rdfs:label/ {sub(/rdfs:label "[^"]*"/, "rdfs:label \"" lbl "\""); inblk=0}
    {print}' "$ttl" > "$ttl.tmp" && mv "$ttl.tmp" "$ttl"
  i=$((i+1))
done < "$names"
grep -c 'rdfs:label "(empty)"' "$ttl" || true   # how many slots remain unnamed
```
Verify: `grep -A3 'preset1>' manifest.ttl`.

### 12.2 Generate `names.txt` from the Pi preset folder
```sh
# mirrors PresetManager order when order.json is absent: case-insensitive name sort of user presets, then factory
cd /var/pipedal/home/.config/TONE3000/Presets
ls *.t3kpreset 2>/dev/null | sed 's/\.t3kpreset$//' | sort -f > /tmp/names.txt
ls Factory/*.t3kpreset 2>/dev/null | sed 's#Factory/##; s/\.t3kpreset$//' | sort -f >> /tmp/names.txt
cat -n /tmp/names.txt
```
If `order.json` exists, the ordered ids come first in file order (F11) — adjust by hand and double-check in the Mac standalone's PC-number view.

### 12.3 `minihost.cpp` — independent LV2 check (build on the Pi)
Source was delivered in chat on 2026-10-04 and should be stored in the gig-config folder. Build/run:
```sh
sudo apt install -y liblilv-dev lv2-dev lilv-utils build-essential pkg-config
g++ -std=c++17 -O1 -o minihost minihost.cpp $(pkg-config --cflags --libs lilv-0)
# args: <plugin uri> <block size> <1-based preset number>; HOME decides which Presets folder is used
sudo -u pipedal_d env HOME=/var/pipedal/home LV2_PATH=/usr/local/lib/lv2 ./minihost https://www.tone3000.com/plugin 16 1
```
It prints required features, ports, patch-parameter count, instantiate time, preset-apply behaviour, state sizes, state round-trip equality, and DSP load per block size. `PIPEDAL_SEQUENCE=1` reproduces PiPedal's restore→save→restore sequence (R6).

### 12.4 Docker fallback for an aarch64 TONE3000 source build (Apple Silicon Mac)
Not needed on Trixie; kept for completeness.
```Dockerfile
FROM --platform=linux/arm64 debian:trixie
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake ninja-build git pkg-config ca-certificates \
    libgtk-3-dev libasound2-dev libjack-jackd2-dev libcurl4-openssl-dev libfreetype6-dev \
    libfontconfig1-dev libx11-dev libxcomposite-dev libxcursor-dev libxi-dev libxinerama-dev \
    libxrandr-dev libxrender-dev libxext-dev lv2-dev lilv-utils
WORKDIR /src
# git clone --recurse-submodules https://github.com/tone-3000/tone3000-plugin.git /src
# echo T3K_PUBLISHABLE_KEY=t3k_pub_x > .env
# cmake -B build -S . -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=cmake/linux-toolchain.cmake -DBUILD_AAX=OFF -DBUILD_CLAP=OFF -G Ninja
# cmake --build build --target TONE3000_LV2 -j$(nproc)   → build/plugin/TONE3000_artefacts/Release/LV2/TONE3000.lv2
```

### 12.5 Useful one-liners (Pi)
```sh
journalctl -u pipedald -f                                   # live service log
tail -f /var/pipedal/home/.config/TONE3000/TONE3000.log     # plugin log (preset loads, model builds)
lv2info https://www.tone3000.com/plugin | less              # ttl as seen by lilv
sudo systemctl restart pipedald
sudo tar czf ~/pipedal-backup-$(date +%F).tgz /var/pipedal /etc/pipedal
```

### 12.6 Glossary
- **A2** — NAM "Architecture 2" models (lower CPU than A1); `.nam` files.
- **Patch property** — LV2 parameter carried as `patch:Set` atoms instead of a control port.
- **pset:Preset** — LV2 preset resource in `manifest.ttl`; JUCE uses it to carry a program index.
- **StateString** — JUCE's single LV2 state key holding the base64 plugin state.
- **Split** — PiPedal's built-in A/B / Mix / L-R router item.
- **Snapshot** — PiPedal sub-preset (control values only; does not restore LV2 state, F24).
- **TooB** — PiPedal author's own LV2 plugin suite (NAM, tuner, delay, reverb…).

### 12.7 References
- TONE3000 plugin repo: https://github.com/tone-3000/tone3000-plugin (v0.0.11; `plugin/docs/native-ui.md`, `README.md` "Settings and where they live")
- TONE3000 downloads: https://www.tone3000.com/plugin/download ; API: https://www.tone3000.com/api
- PiPedal upstream: https://github.com/rerdavies/pipedal ; docs https://rerdavies.github.io/pipedal/ (`Configuring`, `AudioLatency`, `BuildingPiPedalFromSource`, `BuildPrerequisites`, `ReleaseNotes`)
- PiPedal PR #563 "Support numeric (atom:Float) LV2 patch properties" (merged 2026-09-13, commit `d70b1174`)
- JUCE 9.0.3 LV2 client: `modules/juce_audio_plugin_client/juce_audio_plugin_client_LV2.cpp`
- Pi OS Trixie announcement: https://www.raspberrypi.com/news/trixie-the-new-version-of-raspberry-pi-os/
- Earlier analysis docs (Claude project "NAM"): `tone3000-headless-research.md`, `option-a-pipedal-gig-plan.md`

---

## 13. Stage checklist (to be written in Phase 5)
_(placeholder — fill after rehearsal)_
