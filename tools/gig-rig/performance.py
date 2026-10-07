#!/usr/bin/env python3
"""Read-only PiPedal performance evidence; never certifies gig qualification."""

import argparse
import datetime
import json
import math
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import time

from pipedal_rpc import PiPedalRpc


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def process_stat(text):
    """Parse only CPU/start counters; do not emit command names.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [NFR-2] [DES-TEST] [4.1]
    """
    tail = text[text.rindex(")") + 2:].split()
    return {"cpu_ticks": int(tail[11]) + int(tail[12]), "start_ticks": int(tail[19])}


class Probe:
    """Collect selected status fields without requesting boards/presets/settings.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [NFR-2] [NFR-5] [DES-TEST] [4.1] [4.4]
    """

    def __init__(self, url, service, timeout=2):
        self.url, self.service, self.timeout = url, service, timeout
        self.rpc = None

    def close(self):
        if self.rpc:
            self.rpc.close()
            self.rpc = None

    def command(self, argv):
        result = subprocess.run(argv, capture_output=True, text=True, timeout=self.timeout, check=False)
        if result.returncode:
            raise RuntimeError("Read-only probe command failed")
        return result.stdout.strip()

    def service_status(self):
        raw = self.command(["systemctl", "show", self.service,
                            "--property=MainPID,NRestarts,ActiveState,SubState,ExecMainStartTimestampMonotonic"])
        fields = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
        return {"pid": int(fields["MainPID"]), "restarts": int(fields["NRestarts"]),
                "start_monotonic_us": int(fields["ExecMainStartTimestampMonotonic"] or 0),
                "active": fields["ActiveState"] == "active", "running": fields["SubState"] == "running"}

    def read(self):
        sample = {"timestamp": timestamp(), "errors": []}
        try:
            sample["service_before"] = self.service_status()
        except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
            sample["errors"].append("service_before:" + type(error).__name__)
        try:
            if self.rpc is None:
                self.rpc = PiPedalRpc(self.url, self.timeout)
            raw = self.rpc.request("getJackStatus")
            if not isinstance(raw, dict):
                raise ValueError("Status is not an object")
            status = {}
            for key in ("active", "restarting"):
                if not isinstance(raw.get(key), bool):
                    raise ValueError("Invalid audio flag")
                status[key] = raw[key]
            for key in ("cpuUsage", "underruns", "temperaturemC"):
                value = raw.get(key)
                if not number(value):
                    raise ValueError("Invalid numeric audio status")
                status[key] = value
            if status["cpuUsage"] < 0 or not isinstance(status["underruns"], int) or status["underruns"] < 0:
                raise ValueError("Invalid CPU/xrun value")
            if status["temperaturemC"] <= -100000:
                status["temperaturemC"] = None
            sample["audio"] = status
        except Exception as error:
            # Exception strings/server bodies can contain private details.
            sample["errors"].append("audio:" + type(error).__name__)
            try:
                self.close()
            except Exception:
                self.rpc = None
        try:
            sample["service"] = self.service_status()
        except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
            sample["errors"].append("service:" + type(error).__name__)
        service = sample.get("service", {})
        sample["coherent"] = (sample.get("service_before") == service and bool(service.get("pid"))
                              and service.get("active") is True and service.get("running") is True)
        try:
            values = [int(v) for v in Path("/proc/stat").read_text().splitlines()[0].split()[1:9]]
            sample["system_ticks"] = {"total": sum(values), "idle": values[3] + values[4]}
            sample["load_average"] = [float(v) for v in Path("/proc/loadavg").read_text().split()[:3]]
        except (OSError, ValueError, IndexError) as error:
            sample["errors"].append("system:" + type(error).__name__)
        pid = sample.get("service", {}).get("pid", 0)
        if pid:
            try:
                base = Path("/proc") / str(pid)
                sample["process"] = process_stat((base / "stat").read_text())
                sample["threads"] = {}
                for task in (base / "task").iterdir():
                    try:
                        value = process_stat((task / "stat").read_text())
                        value["lv2_worker"] = (task / "comm").read_text().strip() == "lv2_worker"
                        sample["threads"][task.name] = value
                    except (OSError, ValueError, IndexError):
                        sample["errors"].append("thread_unavailable")
            except (OSError, ValueError, IndexError) as error:
                sample["errors"].append("process:" + type(error).__name__)
        for key, command, pattern in [("temperature_c", "measure_temp", r"temp=(-?\d+(?:\.\d+)?)'C"),
                                      ("throttle_bits", "get_throttled", r"throttled=0x([0-9a-fA-F]+)")]:
            try:
                match = re.fullmatch(pattern, self.command(["vcgencmd", command]))
                if not match:
                    raise ValueError("Unrecognized hardware metric")
                sample[key] = int(match[1], 16) if key == "throttle_bits" else float(match[1])
            except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
                sample["errors"].append(key + ":" + type(error).__name__)
        return sample


class Metrics:
    """Derive observed counters, flag discontinuities and preserve qualification limits.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [NFR-2] [NFR-5] [DES-TEST] [4.1] [4.4]
    """

    def __init__(self, ticks_per_second):
        if not number(ticks_per_second) or ticks_per_second <= 0:
            raise ValueError("CPU tick frequency must be finite and positive")
        self.hz = ticks_per_second
        self.samples = []
        self.counter_gaps = self.counter_resets = self.service_changes = self.restart_resets = 0
        self.observed_xruns = self.observed_restarts = 0
        self.cpu_area = self.cpu_coverage = 0

    @staticmethod
    def identity(sample):
        service = sample.get("service", {})
        return service.get("pid"), service.get("start_monotonic_us"), sample.get("process", {}).get("start_ticks")

    def add(self, sample):
        if self.samples:
            previous = self.samples[-1]
            dt = sample["elapsed_s"] - previous["elapsed_s"]
            if dt <= 0:
                raise ValueError("Sample monotonic times must increase")
            old_service, service = previous.get("service"), sample.get("service")
            same_service = bool(old_service and service and service.get("pid")
                                and service.get("pid") == old_service.get("pid")
                                and service.get("start_monotonic_us") == old_service.get("start_monotonic_us"))
            old_process, process = previous.get("process"), sample.get("process")
            same_process = same_service and (not old_process or not process
                                             or old_process["start_ticks"] == process["start_ticks"])
            old_restart = previous.get("service", {}).get("restarts")
            new_restart = sample.get("service", {}).get("restarts")
            if isinstance(old_restart, int) and isinstance(new_restart, int):
                if new_restart < old_restart:
                    self.restart_resets += 1
                else:
                    self.observed_restarts += new_restart - old_restart
            if old_service and service and (old_service.get("pid") != service.get("pid")
                    or old_service.get("start_monotonic_us") != service.get("start_monotonic_us")
                    or (old_process and process and old_process["start_ticks"] != process["start_ticks"])):
                self.service_changes += 1
            old_audio, audio = previous.get("audio"), sample.get("audio")
            coherent = (sample.get("coherent") and previous.get("coherent") and same_process
                        and old_restart == new_restart)
            if coherent and old_audio and audio and old_audio["active"] and audio["active"] \
                    and not old_audio["restarting"] and not audio["restarting"]:
                delta = audio["underruns"] - old_audio["underruns"]
                if delta < 0:
                    self.counter_resets += 1
                    self.counter_gaps += 1
                else:
                    self.observed_xruns += delta
                    self.cpu_area += dt * (old_audio["cpuUsage"] + audio["cpuUsage"]) / 2
                    self.cpu_coverage += dt
            else:
                self.counter_gaps += 1
            if same_process and sample.get("process") and previous.get("process"):
                delta = sample["process"]["cpu_ticks"] - previous["process"]["cpu_ticks"]
                if delta >= 0:
                    sample["process_cpu_percent_one_core"] = 100 * delta / self.hz / dt
                worker_ticks = 0
                for tid, thread in sample.get("threads", {}).items():
                    old = previous.get("threads", {}).get(tid)
                    if old and thread["start_ticks"] == old["start_ticks"] and thread["cpu_ticks"] >= old["cpu_ticks"]:
                        if thread["lv2_worker"] and old["lv2_worker"]:
                            worker_ticks += thread["cpu_ticks"] - old["cpu_ticks"]
                sample["lv2_worker_cpu_percent_one_core_observed"] = 100 * worker_ticks / self.hz / dt
            current_system, old_system = sample.get("system_ticks"), previous.get("system_ticks")
            if current_system and old_system:
                total = current_system["total"] - old_system["total"]
                idle = current_system["idle"] - old_system["idle"]
                if total > 0 and 0 <= idle <= total:
                    sample["system_cpu_percent_all_cores"] = 100 * (total - idle) / total
        self.samples.append(sample)

    def summary(self, requested_duration):
        cpus = [s["audio"]["cpuUsage"] for s in self.samples if s.get("audio", {}).get("active")
                and not s["audio"]["restarting"] and s.get("coherent")]
        throttles = [s["throttle_bits"] for s in self.samples if "throttle_bits" in s]
        temperatures = [s["temperature_c"] for s in self.samples if "temperature_c" in s]
        summary = {"requested_duration_s": requested_duration,
                "observed_duration_s": self.samples[-1]["elapsed_s"] - self.samples[0]["elapsed_s"] if self.samples else 0,
                "collector_elapsed_s": self.samples[-1]["elapsed_s"] if self.samples else 0,
                "initial_sample_delay_s": self.samples[0]["elapsed_s"] if self.samples else None,
                "sample_count": len(self.samples), "sample_errors": sum(bool(s["errors"]) for s in self.samples),
                "incoherent_samples": sum(not s.get("coherent") for s in self.samples),
                "maximum_schedule_lag_s": max((s.get("schedule_lag_s", 0) for s in self.samples), default=0),
                "pipedal_cpu_percent_sample_mean": statistics.fmean(cpus) if cpus else None,
                "pipedal_cpu_percent_peak": max(cpus) if cpus else None,
                "pipedal_cpu_percent_time_weighted_mean": self.cpu_area / self.cpu_coverage if self.cpu_coverage else None,
                "cpu_coverage_s": self.cpu_coverage,
                "all_audio_samples_active": bool(self.samples) and all(s.get("audio", {}).get("active") is True for s in self.samples),
                "audio_restarting_samples": sum(s.get("audio", {}).get("restarting") is True for s in self.samples),
                "observed_xrun_delta_lower_bound": self.observed_xruns, "counter_continuity_gaps": self.counter_gaps,
                "counter_resets_detected": self.counter_resets, "service_identity_changes": self.service_changes,
                "observed_service_restart_delta": self.observed_restarts, "restart_counter_resets": self.restart_resets,
                "maximum_temperature_c": max(temperatures) if temperatures else None,
                "throttle_bits_first": throttles[0] if throttles else None,
                "throttle_bits_last": throttles[-1] if throttles else None,
                "throttle_bits_observed_or": self.throttle_union(throttles) if throttles else None,
                "new_throttle_bits_observed": self.throttle_union(throttles) & ~throttles[0] if throttles else None,
                "qualification_passed": False,
                "limits": ["No latency/listening/rig-identity/assertion or log verification.",
                           "Sampling cannot exclude failures between observations or hidden counter resets.",
                           "PiPedal CPU is its audio-driver metric; process/worker CPU uses one-core units.",
                           "System CPU aggregates all cores and excludes idle/iowait; load average is separate.",
                           "Worker CPU includes only unchanged threads explicitly named lv2_worker; other plugin threads are excluded.",
                           "Historical throttle bits may predate this run; unchanged bits do not prove no new throttling."]}
        for metric in ("process_cpu_percent_one_core", "lv2_worker_cpu_percent_one_core_observed", "system_cpu_percent_all_cores"):
            values = [s[metric] for s in self.samples if metric in s]
            summary[metric + "_sample_mean"] = statistics.fmean(values) if values else None
            summary[metric + "_peak"] = max(values) if values else None
        return summary

    @staticmethod
    def throttle_union(values):
        result = 0
        for value in values:
            result |= value
        return result


def collect(probe, output, duration, interval, clock=time.monotonic, sleep=time.sleep, ticks_per_second=None):
    """Capture monotonic observations to private new files; never overwrite evidence.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [NFR-2] [NFR-5] [DES-SEC] [DES-TEST] [4.1] [4.4]
    """
    if not all(number(v) and v > 0 for v in (duration, interval)):
        raise ValueError("Duration and interval must be finite and positive")
    output = Path(output).resolve()
    # A deployed helper may live in the private evidence directory rather
    # than tools/gig-rig. Only actual Git worktrees identify repositories.
    if any((parent / ".git").exists() for parent in (output, *output.parents)):
        raise ValueError("Private evidence must remain outside the source repository")
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    os.chmod(output, 0o700)
    metrics = Metrics(ticks_per_second or os.sysconf("SC_CLK_TCK"))
    start, index, baseline = clock(), 0, None
    started_at = timestamp()
    with os.fdopen(os.open(output / "samples.jsonl", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        while True:
            target = 0 if baseline is None else baseline + min(index * interval, duration)
            remaining = start + target - clock()
            if remaining > 0:
                sleep(remaining)
            sample = probe.read()
            sample["elapsed_s"] = clock() - start
            sample["schedule_lag_s"] = max(0, sample["elapsed_s"] - target)
            if baseline is None:
                baseline = sample["elapsed_s"]
            metrics.add(sample)
            stream.write(json.dumps(sample, allow_nan=False, sort_keys=True) + "\n")
            stream.flush()
            if sample["elapsed_s"] - baseline >= duration:
                break
            index = max(index + 1, math.floor((sample["elapsed_s"] - baseline) / interval) + 1)
    summary = metrics.summary(duration)
    summary.update({"started_at": started_at, "finished_at": timestamp(), "sampling_interval_s": interval,
                    "cpu_average_method": "trapezoids between coherent active consecutive status samples"})
    with os.fdopen(os.open(output / "summary.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        json.dump(summary, stream, allow_nan=False, indent=2, sort_keys=True)
        stream.write("\n")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="ws://127.0.0.1/pipedal")
    parser.add_argument("--service", default="pipedald.service")
    parser.add_argument("--duration", type=float, default=60)
    parser.add_argument("--interval", type=float, default=1)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9@_.-]+\.service", args.service):
        parser.error("Invalid service unit name")
    probe = Probe(args.url, args.service)
    try:
        result = collect(probe, args.output, args.duration, args.interval)
        print(json.dumps({"summary": str(args.output / "summary.json"), "sample_count": result["sample_count"],
                          "observed_duration_s": result["observed_duration_s"], "qualification_passed": False}))
        return 0
    except (OSError, ValueError) as error:
        print("performance: " + type(error).__name__, file=sys.stderr)
        return 1
    finally:
        probe.close()


if __name__ == "__main__":
    sys.exit(main())
