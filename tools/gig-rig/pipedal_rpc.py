#!/usr/bin/env python3
"""Small synchronous client for PiPedal's existing WebSocket protocol."""

import argparse
from collections import deque
import json
from pathlib import Path
import sys
import time


class PiPedalRpc:
    """Correlate replies while retaining unsolicited runtime notifications.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-UI] [DES-TEST] [2.6] [3.5]
    """

    def __init__(self, url="ws://127.0.0.1/pipedal", timeout=10, transport=None):
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        if transport is None:
            import websocket
            transport = websocket.create_connection(url, timeout=timeout)
        self.socket = transport
        self.timeout = timeout
        self.next_id = 0
        self.events = deque(maxlen=128)

    def close(self):
        self.socket.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def send(self, message, body=None):
        """Send an existing API notification without expecting an acknowledgement.

        @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STATE] [3.5]
        """
        packet = [{"message": message}]
        if body is not None:
            packet.append(body)
        self.socket.send(json.dumps(packet))

    def request(self, message, body=None):
        """Wait only for this request's reply; report server errors explicitly.

        @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [FR-4] [2.6]
        """
        self.next_id += 1
        identifier = self.next_id
        packet = [{"message": message, "replyTo": identifier}]
        if body is not None:
            packet.append(body)
        self.socket.send(json.dumps(packet))
        deadline = time.monotonic() + self.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"No reply to {message}")
            self.socket.settimeout(remaining)
            raw = self.socket.recv()
            if not raw:
                raise ConnectionError("PiPedal closed the connection")
            data = json.loads(raw)
            if not isinstance(data, list) or len(data) not in (1, 2) or not isinstance(data[0], dict):
                raise ValueError("Invalid PiPedal message")
            header = data[0]
            result = data[1] if len(data) == 2 else None
            if header.get("reply") == identifier:
                if header.get("message") == "error":
                    raise RuntimeError(f"{message}: {result}")
                return result
            self.events.append(data)
            if "replyTo" in header:
                self.socket.send(json.dumps([{"message": header.get("message", ""),
                                              "reply": header["replyTo"]}]))


def main():
    """Issue explicit API requests; large/private bodies can stay in local files.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-FILES] [DES-SEC] [5.3]
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("message")
    parser.add_argument("--url", default="ws://127.0.0.1/pipedal")
    body_group = parser.add_mutually_exclusive_group()
    body_group.add_argument("--body", help="JSON request body")
    body_group.add_argument("--body-file", type=Path, help="File containing a JSON body")
    parser.add_argument("--send", action="store_true", help="Notification with no reply")
    parser.add_argument("--timeout", type=float, default=10)
    args = parser.parse_args()
    try:
        raw = args.body_file.read_text() if args.body_file else args.body
        body = json.loads(raw) if raw is not None else None
        with PiPedalRpc(args.url, args.timeout) as rpc:
            if args.send:
                rpc.send(args.message, body)
            else:
                print(json.dumps(rpc.request(args.message, body), indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, TimeoutError, ImportError) as error:
        print(f"pipedal_rpc: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
