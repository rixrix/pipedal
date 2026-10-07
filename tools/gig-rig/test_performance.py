"""Deterministic counter attribution, timing and evidence privacy tests."""

import copy
from pathlib import Path
import tempfile
import unittest

from performance import Metrics, collect, process_stat


def sample(elapsed, cpu=20, xruns=10, pid=100, restarts=0, start=123):
    return {"elapsed_s": elapsed, "coherent": True, "errors": [],
            "service": {"pid": pid, "restarts": restarts, "start_monotonic_us": start},
            "audio": {"active": True, "restarting": False, "cpuUsage": cpu, "underruns": xruns},
            "process": {"cpu_ticks": 100, "start_ticks": start}, "threads": {}}


class PerformanceTests(unittest.TestCase):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [4.1] [4.4]"""

    def test_counter_offsets_and_irregular_cpu_intervals(self):
        metrics = Metrics(100)
        metrics.add(sample(0, 20, 100))
        metrics.add(sample(1, 40, 101))
        metrics.add(sample(3, 100, 103))
        result = metrics.summary(3)
        self.assertEqual(result["observed_xrun_delta_lower_bound"], 3)
        self.assertAlmostEqual(result["pipedal_cpu_percent_time_weighted_mean"], 170 / 3)
        self.assertEqual(result["pipedal_cpu_percent_peak"], 100)
        self.assertEqual(result["counter_continuity_gaps"], 0)
        self.assertFalse(result["qualification_passed"])

    def test_xrun_reset_is_not_a_negative_delta_or_clean_run(self):
        metrics = Metrics(100)
        metrics.add(sample(0, xruns=12))
        metrics.add(sample(1, xruns=0))
        metrics.add(sample(2, xruns=2))
        result = metrics.summary(2)
        self.assertEqual(result["counter_resets_detected"], 1)
        self.assertEqual(result["counter_continuity_gaps"], 1)
        self.assertEqual(result["observed_xrun_delta_lower_bound"], 2)

    def test_pid_reuse_restart_and_restart_counter_reset(self):
        metrics = Metrics(100)
        metrics.add(sample(0, xruns=100, restarts=4))
        metrics.add(sample(1, xruns=2, restarts=5, start=456))
        metrics.add(sample(2, xruns=3, restarts=0, start=456))
        result = metrics.summary(2)
        self.assertEqual(result["service_identity_changes"], 1)
        self.assertEqual(result["observed_service_restart_delta"], 1)
        self.assertEqual(result["restart_counter_resets"], 1)
        self.assertEqual(result["counter_continuity_gaps"], 2)
        self.assertEqual(result["observed_xrun_delta_lower_bound"], 0)

    def test_api_gap_and_audio_restart_exclude_cpu_coverage(self):
        metrics = Metrics(100)
        first = sample(0)
        gap = sample(1)
        gap.pop("audio")
        gap["errors"] = ["audio:ConnectionError"]
        last = sample(2)
        last["audio"]["restarting"] = True
        for value in (first, gap, last):
            metrics.add(value)
        result = metrics.summary(2)
        self.assertEqual(result["cpu_coverage_s"], 0)
        self.assertFalse(result["all_audio_samples_active"])
        self.assertEqual(result["audio_restarting_samples"], 1)

    def test_missing_process_or_service_data_is_not_a_restart(self):
        metrics = Metrics(100)
        first, second, third = sample(0), sample(1), sample(2)
        first.pop("process")
        third.pop("service")
        third["coherent"] = False
        for value in (first, second, third):
            metrics.add(value)
        self.assertEqual(metrics.summary(2)["service_identity_changes"], 0)
        self.assertEqual(metrics.summary(2)["counter_continuity_gaps"], 1)

    def test_process_system_worker_cpu_units_and_new_threads(self):
        metrics = Metrics(100)
        first, second = sample(0), sample(2)
        first["system_ticks"] = {"total": 1000, "idle": 600}
        second["system_ticks"] = {"total": 1200, "idle": 650}
        second["process"]["cpu_ticks"] = 400
        first["threads"] = {"7": {"cpu_ticks": 10, "start_ticks": 99, "lv2_worker": True}}
        second["threads"] = {"7": {"cpu_ticks": 110, "start_ticks": 99, "lv2_worker": True},
                             "8": {"cpu_ticks": 10000, "start_ticks": 100, "lv2_worker": True}}
        metrics.add(first)
        metrics.add(second)
        self.assertEqual(second["process_cpu_percent_one_core"], 150)
        self.assertEqual(second["lv2_worker_cpu_percent_one_core_observed"], 50)
        self.assertEqual(second["system_cpu_percent_all_cores"], 75)

    def test_missing_hardware_metrics_do_not_become_zero(self):
        metrics = Metrics(100)
        metrics.add(sample(0))
        self.assertIsNone(metrics.summary(1)["throttle_bits_observed_or"])
        metrics.add({**sample(1), "throttle_bits": 0x10000})
        metrics.add({**sample(2), "throttle_bits": 0x50004})
        result = metrics.summary(2)
        self.assertEqual(result["throttle_bits_observed_or"], 0x50004)
        self.assertEqual(result["new_throttle_bits_observed"], 0x40004)

    def test_proc_stat_handles_spaces_and_parentheses_in_command(self):
        fields = ["0"] * 20
        fields[0], fields[11], fields[12], fields[19] = "S", "200", "100", "400"
        self.assertEqual(process_stat("123 (worker ) unusual) " + " ".join(fields)),
                         {"cpu_ticks": 300, "start_ticks": 400})

    def test_monotonic_schedule_private_files_and_no_overwrite(self):
        now = [0.0]

        class FakeProbe:
            def read(self):
                result = sample(now[0])
                result.pop("elapsed_s")
                return copy.deepcopy(result)

        def sleep(seconds):
            now[0] += seconds

        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "evidence"
            result = collect(FakeProbe(), output, 2.5, 1, lambda: now[0], sleep, 100)
            self.assertEqual(result["observed_duration_s"], 2.5)
            self.assertEqual(result["sample_count"], 4)
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            for file in output.iterdir():
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            original = (output / "samples.jsonl").read_bytes()
            with self.assertRaises(FileExistsError):
                collect(FakeProbe(), output, 2, 1, lambda: now[0], sleep, 100)
            self.assertEqual((output / "samples.jsonl").read_bytes(), original)

    def test_invalid_duration_never_creates_evidence(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "evidence"
            for value in (0, -1, float("nan"), float("inf")):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    collect(None, output, value, 1)
            self.assertFalse(output.exists())

    def test_private_output_rejects_actual_git_worktrees(self):
        with tempfile.TemporaryDirectory() as root:
            repository = Path(root) / "repository"
            repository.mkdir()
            # Linked worktrees use a file rather than a .git directory.
            (repository / ".git").write_text("gitdir: /private/git/worktrees/test\n")
            output = repository / "private" / "evidence"
            with self.assertRaises(ValueError):
                collect(None, output, 1, 1)
            self.assertFalse(output.exists())

    def test_probe_overhead_does_not_shorten_observation_window(self):
        now = [0.0]

        class SlowProbe:
            def read(self):
                now[0] += 0.2 if now[0] == 0 else 0.1
                value = sample(now[0])
                value.pop("elapsed_s")
                return value

        def sleep(seconds):
            now[0] += seconds

        with tempfile.TemporaryDirectory() as root:
            result = collect(SlowProbe(), Path(root) / "evidence", 2.5, 1, lambda: now[0], sleep, 100)
            self.assertGreaterEqual(result["observed_duration_s"], 2.5)
            self.assertAlmostEqual(result["initial_sample_delay_s"], 0.2)

    def test_duplicate_sample_monotonic_time_is_rejected(self):
        metrics = Metrics(100)
        metrics.add(sample(1))
        with self.assertRaises(ValueError):
            metrics.add(sample(1))


if __name__ == "__main__":
    unittest.main()
