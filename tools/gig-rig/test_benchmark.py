"""Audio-setting recovery, context guards and bounded unsafe-case checks."""

from copy import deepcopy
from pathlib import Path
import subprocess
import tempfile
import unittest

import benchmark as bench
from test_build_bank import BankMock, inputs
from build_bank import construct_dual


class RpcMock:
    def __init__(self):
        entries = inputs()
        self.board = construct_dual(entries[0]["board"], entries[0]["item"], entries[1]["item"], BankMock().request("plugins")[1:], 100)
        self.bank, self.preset = 5, 34
        self.settings = {"valid": True, "isJackAudio": False, "sampleRate": 48000,
                         "bufferSize": 32, "numberOfBuffers": 4, "alsaInputDevice": "device",
                         "alsaOutputDevice": "device", "isOnboarding": False, "retainedField": "exact"}
        self.calls = []
        self.audio = {"active": True, "restarting": False, "underruns": 0, "cpuUsage": 20}

    def request(self, message, body=None):
        self.calls.append((message, deepcopy(body)))
        if message == "getBankIndex":
            return {"selectedBank": self.bank}
        if message == "getPresets":
            return {"selectedInstanceId": self.preset}
        if message == "currentPedalboard":
            return deepcopy(self.board)
        if message == "getPatchProperty":
            return 0
        if message == "getJackServerSettings":
            return deepcopy(self.settings)
        if message == "setJackServerSettings":
            self.settings = deepcopy(body)
            return None
        if message == "getJackStatus":
            return deepcopy(self.audio)
        raise AssertionError("Unexpected protocol message " + message)


class ProbeMock:
    def read(self):
        return {"coherent": True, "errors": [], "audio": {"active": True, "restarting": False, "underruns": 0, "cpuUsage": 20}}

    def service_status(self):
        return {"pid": 123, "restarts": 0, "start_monotonic_us": 50, "active": True, "running": True}


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def ready(rpc, bank, preset, wanted, **kwargs):
    bench.selection(rpc, bank, preset)
    if rpc.settings != wanted:
        raise ValueError("Wrong API readback")
    return {"settings_readback": deepcopy(wanted), "audio": deepcopy(rpc.audio)}


def collector(probe, output, duration, interval):
    assert (duration, interval) == (60, 1)
    probe.read()
    return {"observed_duration_s": 60, "all_audio_samples_active": True,
            "pipedal_cpu_percent_time_weighted_mean": 20, "pipedal_cpu_percent_peak": 30,
            "observed_xrun_delta_lower_bound": 0}


class BenchmarkTests(unittest.TestCase):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [4.1]"""

    def execute(self, rpc, directory, sample_collector=collector, wait=ready):
        return bench.run(rpc, ProbeMock(), 5, 34, [102, 103], Path(directory) / "evidence",
                         collector=sample_collector, ready=wait,
                         threads=lambda probe: {"service_identity_stable": True})

    def test_matrix_changes_only_buffers_and_restores_every_original_field(self):
        rpc = RpcMock()
        original = deepcopy(rpc.settings)
        with tempfile.TemporaryDirectory() as directory:
            result, failure = self.execute(rpc, directory)
            self.assertIsNone(failure)
            self.assertEqual(rpc.settings, original)
            self.assertTrue(result["settings_restored"] and result["dual_selection_preserved"])
            self.assertTrue(result["exploratory_observations_clean"])
            self.assertFalse(result["qualification_passed"] or result["readiness_proven"])
            updates = [body for message, body in rpc.calls if message == "setJackServerSettings"]
            self.assertEqual([(value["bufferSize"], value["numberOfBuffers"]) for value in updates], [(16, 6), (16, 4), (32, 4), (32, 4)])
            for value in updates:
                self.assertEqual({k: v for k, v in value.items() if k not in ("bufferSize", "numberOfBuffers")},
                                 {k: v for k, v in original.items() if k not in ("bufferSize", "numberOfBuffers")})
            self.assertFalse(any(message in ("openBank", "loadPreset", "updateCurrentPedalboard") for message, _ in rpc.calls))

    def test_wrong_current_preset_or_disabled_branch_refused_before_settings_mutation(self):
        for change in ("selection", "disabled"):
            rpc = RpcMock()
            if change == "selection":
                rpc.preset = 99
            else:
                rpc.board["items"][1]["bottomChain"][0]["isEnabled"] = False
            with tempfile.TemporaryDirectory() as directory, self.assertRaises(bench.SafetyStop):
                self.execute(rpc, directory)
            self.assertFalse(any(message == "setJackServerSettings" for message, _ in rpc.calls))

    def test_failed_collector_always_restores_safe_original_audio(self):
        rpc = RpcMock()
        original = deepcopy(rpc.settings)
        def fail(*args):
            raise RuntimeError("Injected collector error")
        with tempfile.TemporaryDirectory() as directory:
            result, error = self.execute(rpc, directory, fail)
            self.assertIsInstance(error, RuntimeError)
            self.assertEqual(rpc.settings, original)
            self.assertTrue(result["settings_restored"])
            self.assertEqual(len(result["cases"]), 1)
            self.assertEqual(result["cases"][0]["status"], "failed")

    def test_unsafe_abort_returns_safe_audio_before_next_case_and_never_passes(self):
        rpc = RpcMock()
        def unsafe(*args):
            raise bench.SafetyStop("observed_xruns_exceeded_10", {"audio": {"underruns": 11}})
        with tempfile.TemporaryDirectory() as directory:
            result, failure = self.execute(rpc, directory, unsafe)
            self.assertIsNone(failure)
            self.assertTrue(result["settings_restored"])
            self.assertFalse(result["exploratory_observations_clean"])
            self.assertEqual([case["status"] for case in result["cases"]], ["aborted_unsafe"] * 3)
            updates = [body for message, body in rpc.calls if message == "setJackServerSettings"]
            self.assertEqual([(v["bufferSize"], v["numberOfBuffers"]) for v in updates],
                             [(16, 6), (32, 4), (16, 4), (32, 4), (32, 4), (32, 4), (32, 4)])

    def test_startup_failure_restores_original_settings(self):
        rpc = RpcMock()
        def startup(rpc, bank, preset, wanted, **kwargs):
            if wanted["bufferSize"] == 16:
                raise TimeoutError("Startup failed")
            return ready(rpc, bank, preset, wanted)
        with tempfile.TemporaryDirectory() as directory:
            result, failure = self.execute(rpc, directory, wait=startup)
            self.assertIsInstance(failure, TimeoutError)
            self.assertEqual(rpc.settings["bufferSize"], 32)
            self.assertTrue(result["settings_restored"])

    def test_safety_monitor_counts_only_observed_xrun_deltas_and_sustained_cpu(self):
        clock = Clock()
        monitor = bench.SafetyMonitor(clock)
        audio = {"active": True, "restarting": False, "underruns": 3104, "cpuUsage": 95}
        monitor.observe(audio)
        clock.now = 1
        monitor.observe(audio)
        clock.now = 2
        with self.assertRaisesRegex(bench.SafetyStop, "cpu_above_90_sustained"):
            monitor.observe(audio)
        monitor = bench.SafetyMonitor(clock)
        audio["cpuUsage"] = 20
        monitor.observe(audio)
        audio["underruns"] += 10
        monitor.observe(audio)
        self.assertEqual(monitor.observed_xruns, 10)
        audio["underruns"] += 1
        with self.assertRaisesRegex(bench.SafetyStop, "observed_xruns_exceeded_10"):
            monitor.observe(audio)
        monitor = bench.SafetyMonitor(clock)
        monitor.observe(audio)
        audio["underruns"] = 0
        with self.assertRaisesRegex(bench.SafetyStop, "counter_reset"):
            monitor.observe(audio)

    def test_bounded_ready_timeout_and_settings_match(self):
        rpc, clock = RpcMock(), Clock()
        rpc.audio["active"] = False
        with self.assertRaises(TimeoutError):
            bench.wait_ready(rpc, 5, 34, rpc.settings, timeout=1, clock=clock, sleep=clock.sleep)
        self.assertEqual(clock.now, 1)
        rpc.audio["active"] = True
        self.assertEqual(bench.wait_ready(rpc, 5, 34, rpc.settings, clock=clock, sleep=clock.sleep)["settings_readback"], rpc.settings)

    def test_thread_command_records_names_scheduler_not_arguments_and_bounds_output(self):
        def command(argv, **kwargs):
            self.assertEqual(argv, ["ps", "-L", "-p", "123", "-o", "tid,comm,cls,rtprio,pri"])
            self.assertEqual(kwargs["timeout"], 2)
            return subprocess.CompletedProcess(argv, 0, "TID COMMAND CLS RTPRIO PRI\n123 T3K worker FF 80 120\n", "")
        result = bench.thread_snapshot(ProbeMock(), command)
        self.assertTrue(result["service_identity_stable"])
        self.assertIn("T3K worker", result["thread_scheduler_table"])
        self.assertIn("not the TONE3000", result["limit"])
        with self.assertRaises(ValueError):
            bench.thread_snapshot(ProbeMock(), lambda argv, **kw: subprocess.CompletedProcess(argv, 0, "x" * 65537, ""))

    def test_context_change_during_sampling_aborts_before_returning_sample(self):
        rpc = RpcMock()
        probe = bench.GuardedProbe(ProbeMock(), rpc, 5, 34, bench.SafetyMonitor())
        rpc.preset = 999
        with self.assertRaises(bench.SafetyStop) as error:
            probe.read()
        self.assertEqual(error.exception.reason, "selected_bank_or_preset_changed")
        self.assertIsNotNone(error.exception.sample)

    def test_metric_failures_and_cpu_headroom_remain_exploratory(self):
        summary = collector(bench.GuardedProbe(ProbeMock(), RpcMock(), 5, 34, bench.SafetyMonitor()), None, 60, 1)
        summary["observed_xrun_delta_lower_bound"] = 1
        summary["pipedal_cpu_percent_peak"] = 61
        status = bench.case_status(summary)
        self.assertEqual(status["status"], "observed_failures")
        self.assertFalse(status["qualification_passed"] or status["cpu_target_met_in_observation"])


if __name__ == "__main__":
    unittest.main()
