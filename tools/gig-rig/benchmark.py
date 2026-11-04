#!/usr/bin/env python3
"""Exploratory dual-TONE3000 buffer observations with exact audio-settings recovery.

No listening, loaded-engine, physical latency or qualification verdict is
generated. Unsafe CPU/xrun cases stop early and retain their partial evidence.
@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [DES-SEC] [4.1]
"""

import argparse
from copy import deepcopy
import json
import math
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlsplit

from build_bank import SPLIT, SHARED, walk_items
from performance import Probe, collect
from pipedal_rpc import PiPedalRpc
from qualification import private_destination, signature, write_private
from state_summary import PLUGIN, summarize_input

CASES = ((16, 6), (16, 4), (32, 4))


class SafetyStop(RuntimeError):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [4.1]"""
    def __init__(self, reason, sample=None):
        super().__init__(reason)
        self.reason, self.sample = reason, sample


class SafetyMonitor:
    """Stop after >10 observed xruns or 3 CPU>90 observations spanning >=2s.

    These are exposure limits, not musical-quality acceptance thresholds.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [4.1]
    """
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.last_xruns = None
        self.observed_xruns = 0
        self.high_since = None
        self.high_observations = 0

    def observe(self, audio):
        if not isinstance(audio, dict) or audio.get("active") is not True or audio.get("restarting") is not False:
            raise SafetyStop("audio_inactive_or_restarting")
        xruns, cpu = audio.get("underruns"), audio.get("cpuUsage")
        if (isinstance(xruns, bool) or not isinstance(xruns, int) or xruns < 0
                or isinstance(cpu, bool) or not isinstance(cpu, (int, float)) or not math.isfinite(cpu) or cpu < 0):
            raise SafetyStop("invalid_audio_counters")
        if self.last_xruns is not None:
            if xruns < self.last_xruns:
                raise SafetyStop("xrun_counter_reset_during_case")
            self.observed_xruns += xruns - self.last_xruns
        self.last_xruns = xruns
        if self.observed_xruns > 10:
            raise SafetyStop("observed_xruns_exceeded_10")
        now = self.clock()
        if cpu > 90:
            if self.high_since is None:
                self.high_since = now
            self.high_observations += 1
            if self.high_observations >= 3 and now - self.high_since >= 2:
                raise SafetyStop("cpu_above_90_sustained")
        else:
            self.high_since = None
            self.high_observations = 0


def selection(rpc, bank, preset):
    """Refuse a controller/client selection change without loading any preset.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [4.1]
    """
    if (rpc.request("getBankIndex").get("selectedBank") != bank
            or rpc.request("getPresets").get("selectedInstanceId") != preset):
        raise SafetyStop("selected_bank_or_preset_changed")


def board_context(rpc, bank, preset, identifiers, expected=None):
    """Audit both enabled A/B instances and stored assets before/after each case.

    Cached state is not a fresh state capture or engine-ready observation.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-ARCH] [DES-TEST] [4.1]
    """
    selection(rpc, bank, preset)
    board = rpc.request("currentPedalboard")
    items = list(walk_items(board))
    tones = [item for item in items if item.get("uri") == PLUGIN]
    if len(tones) != 2 or {item.get("instanceId") for item in tones} != set(identifiers) or any(item.get("isEnabled") is not True for item in tones):
        raise SafetyStop("expected_enabled_dual_instances_missing")
    splits = [item for item in items if item.get("uri") == SPLIT]
    if len(splits) != 1 or splits[0].get("isEnabled") is not True:
        raise SafetyStop("expected_enabled_ab_split_missing")
    split = splits[0]
    controls = {item["key"]: item["value"] for item in split.get("controlValues", [])}
    top, bottom = split.get("topChain", []), split.get("bottomChain", [])
    if (controls.get("splitType") != 0 or controls.get("select") not in (0, 1)
            or len(top) != 1 or len(bottom) != 1 or {top[0].get("instanceId"), bottom[0].get("instanceId")} != set(identifiers)):
        raise SafetyStop("ab_routing_contract_changed")
    if any(len([item for item in items if item.get("uri") == uri and item.get("isEnabled") is True]) != 1 for uri in SHARED):
        raise SafetyStop("enabled_shared_tuner_delay_reverb_missing")
    summaries = summarize_input(board)["states"]
    if len(summaries) != 2 or {state.get("instance_id") for state in summaries} != set(identifiers):
        raise SafetyStop("dual_full_state_observation_missing")
    state_signatures = {}
    for state in summaries:
        if (state.get("lv2_state_valid") is not True or state.get("restore_prefers_program")
                or not state.get("active_preset_id") or not state.get("active_preset_name")):
            raise SafetyStop("dual_valid_state_identity_missing")
        models = [block for block in state.get("blocks", []) if block["type"] in ("nam", "ir")]
        if not models or any(not model["active_model_bytes_present"] for model in models):
            raise SafetyStop("dual_embedded_model_assets_missing")
        identifier = state["instance_id"]
        state_signatures[identifier] = {"id": state["active_preset_id"], "name": state["active_preset_name"],
                                        "signature": signature(state)}
        value = rpc.request("getPatchProperty", {"instanceId": identifier, "propertyUri": PLUGIN + ":osEnabled"})
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value != 0:
            raise SafetyStop("dual_oversampling_not_authoritative_1x")
    if expected is not None and state_signatures != expected:
        raise SafetyStop("stored_dual_identity_or_assets_changed")
    return {"bank": bank, "preset": preset, "t3k_instance_ids": list(identifiers), "states": summaries,
            "state_signatures": state_signatures, "split_controls": controls,
            "host_layout": [{"uri": item.get("uri"), "instance_id": item.get("instanceId"),
                             "enabled": item.get("isEnabled"), "control_values": item.get("controlValues", [])} for item in items],
            "oversampling_readback": 0, "readiness_proven": False,
            "multicore": "not queried or changed; machine default/source inference must be recorded separately"}


def wait_ready(rpc, bank, preset, wanted, timeout=30, monitor=None,
               clock=time.monotonic, sleep=time.sleep):
    """Bound startup to30s; require 3 matching active observations, not models ready.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [4.1]
    """
    deadline = clock() + timeout
    consecutive = 0
    original_timeout = getattr(rpc, "timeout", None)
    def request(message):
        remaining = deadline - clock()
        if remaining <= 0:
            raise TimeoutError("Audio startup observation deadline exhausted")
        if original_timeout is not None:
            rpc.timeout = min(2, remaining)
        return rpc.request(message)
    try:
        while clock() < deadline:
            if (request("getBankIndex").get("selectedBank") != bank
                    or request("getPresets").get("selectedInstanceId") != preset):
                raise SafetyStop("selected_bank_or_preset_changed")
            settings = request("getJackServerSettings")
            audio = request("getJackStatus")
            if isinstance(audio, dict) and audio.get("active") is True and audio.get("restarting") is False:
                if monitor is not None:
                    monitor.observe(audio)
                consecutive = consecutive + 1 if settings == wanted else 0
                if consecutive >= 3:
                    return {"settings_readback": settings, "audio": audio,
                            "note": "API settings readback; physical latency/driver geometry and loaded engines not verified"}
            else:
                consecutive = 0
            sleep(min(0.25, max(0, deadline - clock())))
    finally:
        if original_timeout is not None:
            rpc.timeout = original_timeout
    raise TimeoutError("Audio/settings did not become active and match within30seconds")


def thread_snapshot(probe, command=subprocess.run):
    """Record bounded thread scheduler metadata, never command-line arguments.

    Only exact lv2_worker threads contribute to the existing CPU metric;
    these names/scheduler fields do not quantify T3K RT-pool CPU separately.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [4.1]
    """
    before = probe.service_status()
    pid = before.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        raise ValueError("No running daemon PID for thread observation")
    argv = ["ps", "-L", "-p", str(pid), "-o", "tid,comm,cls,rtprio,pri"]
    result = command(argv, capture_output=True, text=True, timeout=2, check=False)
    if result.returncode or len(result.stdout) > 65536 or len(result.stdout.splitlines()) > 1024:
        raise ValueError("Missing or oversized read-only thread snapshot")
    after = probe.service_status()
    return {"command": argv, "service": before, "service_identity_stable": before == after,
            "thread_scheduler_table": result.stdout,
            "limit": "Kernel thread names can truncate; lv2_worker is not the TONE3000 RT worker pool; no per-T3K-worker CPU verdict"}


class GuardedProbe:
    """Preserve collector behavior while bounding risky exploratory exposure.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [4.1]
    """
    def __init__(self, probe, rpc, bank, preset, monitor):
        self.probe, self.rpc, self.bank, self.preset, self.monitor = probe, rpc, bank, preset, monitor

    def read(self):
        sample = self.probe.read()
        try:
            selection(self.rpc, self.bank, self.preset)
            if not sample.get("coherent"):
                raise SafetyStop("incoherent_or_stopped_service")
            self.monitor.observe(sample.get("audio"))
        except SafetyStop as error:
            error.sample = sample
            raise
        return sample


def case_status(summary):
    """Return exploratory failure reasons without fabricating qualification.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [4.1]
    """
    reasons = [key for key in ("sample_errors", "incoherent_samples", "audio_restarting_samples",
        "observed_xrun_delta_lower_bound", "counter_continuity_gaps", "counter_resets_detected",
        "service_identity_changes", "observed_service_restart_delta", "restart_counter_resets") if summary.get(key, 0)]
    if summary.get("all_audio_samples_active") is not True:
        reasons.append("audio_not_continuously_observed_active")
    if summary.get("observed_duration_s", 0) < 60:
        reasons.append("less_than_60_seconds_observed")
    mean, peak = summary.get("pipedal_cpu_percent_time_weighted_mean"), summary.get("pipedal_cpu_percent_peak")
    cpu_met = (not isinstance(mean, bool) and isinstance(mean, (int, float)) and math.isfinite(mean)
               and not isinstance(peak, bool) and isinstance(peak, (int, float)) and math.isfinite(peak)
               and mean <= 60 and peak <= 60)
    if not cpu_met:
        reasons.append("observed_cpu_target_not_met")
    return {"status": "observed_without_reported_failures" if not reasons else "observed_failures",
            "failure_reasons": reasons, "cpu_target_met_in_observation": cpu_met,
            "qualification_passed": False}


def run(rpc, probe, bank, preset, identifiers, output, collector=collect,
        ready=wait_ready, threads=thread_snapshot, clock=time.monotonic):
    """Measure requested cases, recovering all original settings after any failure.

    No board, bank, preset or multicore setting is changed by this helper.
    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [DES-SEC] [4.1]
    """
    if len(identifiers) != 2 or len(set(identifiers)) != 2 or any(isinstance(i, bool) or not isinstance(i, int) or i < 0 for i in identifiers):
        raise ValueError("Two distinct explicit T3K instance IDs required")
    original_context = board_context(rpc, bank, preset, identifiers)
    original = rpc.request("getJackServerSettings")
    if original.get("valid") is not True or original.get("isJackAudio") is not False or original.get("sampleRate") != 48000:
        raise ValueError("Existing valid ALSA48k settings required before benchmark")
    ready(rpc, bank, preset, original)
    output.mkdir(mode=0o700)
    write_private(output, "original-audio-settings.json", original)
    write_private(output, "original-board-observation.json", original_context)
    result = {"bank": bank, "preset": preset, "t3k_instance_ids": identifiers, "cases": [],
              "qualification_passed": False, "readiness_proven": False, "settings_restored": False,
              "multicore_comparison": "pending; no machine preference changed",
              "limits": ["Stored-state context does not certify installed/healthy model engines.",
                         "No listening, loopback latency, physical controls or final one-hour verdict.",
                         "Metadata/selection polling adds observer work; changes between observations may be missed.",
                         "lv2_worker CPU excludes TONE3000 RT-pool threads; see scheduler snapshots."]}
    mutation_attempted = False
    failure = None
    try:
        for number, (frames, periods) in enumerate(CASES, 1):
            prefix = f"{number:02d}-{frames}x{periods}"
            case = {"buffer_size": frames, "number_of_buffers": periods, "sample_rate": 48000,
                    "status": "pending", "qualification_passed": False}
            result["cases"].append(case)
            monitor = SafetyMonitor(clock)
            case_directory = output / prefix
            try:
                context = board_context(rpc, bank, preset, identifiers, original_context["state_signatures"])
                write_private(output, prefix + "-board-before.json", context)
                wanted = {**deepcopy(original), "bufferSize": frames, "numberOfBuffers": periods}
                mutation_attempted = True  # A lost reply can still apply settings.
                rpc.request("setJackServerSettings", wanted)
                observed = ready(rpc, bank, preset, wanted, monitor=monitor)
                write_private(output, prefix + "-settings-readback.json", observed)
                context = board_context(rpc, bank, preset, identifiers, original_context["state_signatures"])
                write_private(output, prefix + "-board-after-startup.json", context)
                before = threads(probe)
                write_private(output, prefix + "-threads-before.json", before)
                if before.get("service_identity_stable") is not True:
                    raise SafetyStop("service_changed_during_thread_snapshot")
                summary = collector(GuardedProbe(probe, rpc, bank, preset, monitor), case_directory, 60, 1)
                case.update(case_status(summary), performance_summary=summary)
                case["observed_xruns_including_startup_poll"] = monitor.observed_xruns
                if monitor.observed_xruns:
                    case["status"] = "observed_failures"
                    case["failure_reasons"].append("xruns_during_startup_or_sampling")
                after = threads(probe)
                write_private(output, prefix + "-threads-after.json", after)
                board_context(rpc, bank, preset, identifiers, original_context["state_signatures"])
                if rpc.request("getJackServerSettings") != wanted or after.get("service_identity_stable") is not True:
                    raise SafetyStop("settings_or_service_changed_after_case")
            except SafetyStop as error:
                case.update(status="aborted_unsafe", failure_reasons=[error.reason],
                            observed_xrun_delta_before_abort=monitor.observed_xruns,
                            full_60_seconds_observed=False)
                write_private(output, prefix + "-abort.json", {"reason": error.reason, "sample": error.sample})
                # Return to the retained safe starting settings before any
                # next case. Never leave an aborted tiny-buffer case running.
                rpc.request("setJackServerSettings", deepcopy(original))
                ready(rpc, bank, preset, original)
            except Exception as error:
                case.update(status="failed", failure_type=type(error).__name__)
                write_private(output, prefix + "-failure.json", {"type": type(error).__name__, "message": str(error)})
                raise
    except Exception as error:
        failure = error
        result["failure_type"] = type(error).__name__
    finally:
        try:
            if mutation_attempted:
                rpc.request("setJackServerSettings", deepcopy(original))
                ready(rpc, bank, preset, original)
            result["settings_restored"] = rpc.request("getJackServerSettings") == original
            selection(rpc, bank, preset)
            board_context(rpc, bank, preset, identifiers, original_context["state_signatures"])
            result["dual_selection_preserved"] = True
            if not result["settings_restored"]:
                raise RuntimeError("Exact original audio settings were not restored")
        except Exception as error:
            failure = failure or error
            result["restoration_failure_type"] = type(error).__name__
            write_private(output, "restoration-failure.json", {"type": type(error).__name__, "message": str(error)})
        result["exploratory_observations_clean"] = (failure is None and len(result["cases"]) == len(CASES)
            and all(case["status"] == "observed_without_reported_failures" for case in result["cases"]))
        write_private(output, "result.json", result)
    return result, failure


def main(argv=None):
    """Explicit current bank/preset/instances are required before audio changes.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FILES] [DES-SEC] [DES-TEST] [4.1]
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="ws://127.0.0.1/pipedal")
    parser.add_argument("--service", default="pipedald.service")
    parser.add_argument("--bank", type=int, required=True)
    parser.add_argument("--preset", type=int, required=True)
    parser.add_argument("--t3k-instance", type=int, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    probe = None
    try:
        output = private_destination(args.output)
        parsed = urlsplit(args.url)
        if parsed.scheme not in ("ws", "wss") or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.username or parsed.password:
            raise ValueError("Benchmark must run on the Pi with an explicit credential-free loopback service URL")
        probe = Probe(args.url, args.service)
        # Settings applies RestartAudio synchronously; allow its reply time.
        # Startup observation requests are separately capped by wait_ready.
        with PiPedalRpc(args.url, timeout=15) as rpc:
            result, error = run(rpc, probe, args.bank, args.preset, args.t3k_instance, output)
        print(json.dumps({"cases": [{key: case.get(key) for key in ("buffer_size", "number_of_buffers", "status", "failure_reasons")} for case in result["cases"]],
                          "settings_restored": result["settings_restored"], "qualification_passed": False,
                          "exploratory_observations_clean": result["exploratory_observations_clean"]}))
        return 1 if error or not result["exploratory_observations_clean"] else 0
    except Exception as error:
        print("benchmark: " + type(error).__name__ + "; see private evidence if created", file=sys.stderr)
        return 1
    finally:
        if probe is not None:
            probe.close()


if __name__ == "__main__":
    sys.exit(main())
