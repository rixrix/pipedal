"""Reply correlation/error handling for the existing PiPedal protocol."""

import json
import unittest
from pipedal_rpc import PiPedalRpc


class Transport:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.sent = []

    def send(self, raw):
        self.sent.append(json.loads(raw))

    def settimeout(self, value):
        assert value > 0

    def recv(self):
        return json.dumps(next(self.replies))


class RpcTests(unittest.TestCase):
    """Do not mistake asynchronous events for successful API replies.

    @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-TEST] [2.6] [3.5]
    """

    def test_correlated_reply_after_notification(self):
        transport = Transport([[{"message": "onControlChanged"}, {"value": 0.5}],
                               [{"reply": 1, "message": "getJackStatus"}, {"active": True}]])
        rpc = PiPedalRpc(transport=transport)
        self.assertEqual(rpc.request("getJackStatus"), {"active": True})
        self.assertEqual(len(rpc.events), 1)
        self.assertEqual(transport.sent[0], [{"message": "getJackStatus", "replyTo": 1}])

    def test_server_error_is_not_success(self):
        transport = Transport([[{"reply": 1, "message": "error"}, "Plugin not loaded"]])
        with self.assertRaisesRegex(RuntimeError, "Plugin not loaded"):
            PiPedalRpc(transport=transport).request("getPatchProperty", {"instanceId": 1})

    def test_notification_ack_and_closed_connection(self):
        transport = Transport([[{"message": "onVuUpdate", "replyTo": 7}, []],
                               [{"reply": 1, "message": "hello"}, 2]])
        self.assertEqual(PiPedalRpc(transport=transport).request("hello"), 2)
        self.assertEqual(transport.sent[1], [{"message": "onVuUpdate", "reply": 7}])
        transport = Transport([])
        transport.recv = lambda: ""
        with self.assertRaises(ConnectionError):
            PiPedalRpc(transport=transport).request("hello")


if __name__ == "__main__":
    unittest.main()
