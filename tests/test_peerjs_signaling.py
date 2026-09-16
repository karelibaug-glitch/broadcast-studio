# pylint: skip-file
"""
Unit tests for the Built-in PeerJS WebRTC Signaling Engine.
"""

import pytest
from fastapi.testclient import TestClient
from python_app.main import app


def test_peerjs_id_generation():
    client = TestClient(app)
    response = client.get("/peerjs/peerjs/id")
    assert response.status_code == 200
    peer_id = response.text.strip()
    assert len(peer_id) > 0


def test_peerjs_websocket_handshake_and_message_relay():
    client = TestClient(app)

    with client.websocket_connect("/peerjs/peerjs?key=peerjs&id=test-host-room-100") as ws_host:
        host_ack = ws_host.receive_json()
        assert host_ack.get("type") == "OPEN"

        with client.websocket_connect("/peerjs/peerjs?key=peerjs&id=test-guest-feeder-100") as ws_guest:
            guest_ack = ws_guest.receive_json()
            assert guest_ack.get("type") == "OPEN"

            # 1. Guest sends WebRTC OFFER to Host
            offer_payload = {
                "type": "OFFER",
                "src": "test-guest-feeder-100",
                "dst": "test-host-room-100",
                "payload": {"sdp": "v=0\r\no=- 1234 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n", "type": "offer"}
            }
            ws_guest.send_json(offer_payload)

            # Host receives relayed OFFER
            relayed_offer = ws_host.receive_json()
            assert relayed_offer.get("type") == "OFFER"
            assert relayed_offer.get("src") == "test-guest-feeder-100"
            assert relayed_offer.get("payload", {}).get("type") == "offer"

            # 2. Host sends WebRTC ANSWER to Guest
            answer_payload = {
                "type": "ANSWER",
                "src": "test-host-room-100",
                "dst": "test-guest-feeder-100",
                "payload": {"sdp": "v=0\r\no=- 5678 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n", "type": "answer"}
            }
            ws_host.send_json(answer_payload)

            # Guest receives relayed ANSWER
            relayed_answer = ws_guest.receive_json()
            assert relayed_answer.get("type") == "ANSWER"
            assert relayed_answer.get("src") == "test-host-room-100"
            assert relayed_answer.get("payload", {}).get("type") == "answer"

            # 3. Candidate relay test (Sent WITHOUT src by client, server must attach it)
            candidate_payload = {
                "type": "CANDIDATE",
                "dst": "test-host-room-100",
                "payload": {"candidate": "candidate:1 1 UDP 2130706431 192.168.1.50 50000 typ host"}
            }
            ws_guest.send_json(candidate_payload)

            relayed_candidate = ws_host.receive_json()
            assert relayed_candidate.get("type") == "CANDIDATE"
            assert relayed_candidate.get("src") == "test-guest-feeder-100"

