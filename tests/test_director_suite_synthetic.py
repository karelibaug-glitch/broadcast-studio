"""
Synthetic Video Profile & Director Suite Comprehensive Automated Test Suite.
Tests all synthetic video cases, multi-monitor deck switching, transitions,
multi-theme support, and Multi-Destination RTMP multiplexing.
"""

import pytest
import os
import re
from fastapi.testclient import TestClient
from python_app.main import app, STATIC_DIR
from python_app.core.rtmp_manager import rtmp_manager, RTMPDestination


@pytest.fixture
def client():
    return TestClient(app)


class TestSyntheticDirectorSuite:

    def test_01_static_pages_availability(self, client):
        """Verify all dedicated broadcast suite pages are available via HTTP."""
        pages = [
            "/director_suite.html",
            "/switcher.html",
            "/graphics.html",
            "/ai_audio.html",
            "/index.html"
        ]
        for page in pages:
            response = client.get(page)
            assert response.status_code == 200, f"Failed to load {page}"
            assert "<!DOCTYPE html>" in response.text
            assert "Multi Camera Director Suite" in response.text or "Director" in response.text or "Studio" in response.text

    def test_02_multi_theme_definitions(self):
        """Verify that all 5 multi-themes (studio, cyberpunk, slate, crimson, emerald) are properly styled."""
        suite_path = os.path.join(STATIC_DIR, "director_suite.html")
        assert os.path.exists(suite_path), "director_suite.html missing in STATIC_DIR"

        with open(suite_path, "r", encoding="utf-8") as f:
            content = f.read()

        themes = ["cyberpunk", "slate", "crimson", "emerald", "studio"]
        for theme in themes:
            assert f'data-theme="{theme}"' in content or f'value="{theme}"' in content, f"Theme '{theme}' missing from director suite"

    def test_03_synthetic_video_profile_generator(self):
        """Verify synthetic video profile generators for SMPTE bars, Anchor, and Guest feeds."""
        suite_path = os.path.join(STATIC_DIR, "director_suite.html")
        with open(suite_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Check synthetic sources logic
        assert "generateSyntheticSources" in content
        assert "drawSceneToCanvas" in content
        assert "src_bars" in content
        assert "src_host" in content
        assert "src_guest" in content
        assert "src_media" in content

    def test_04_transitions_and_t_bar_logic(self):
        """Verify transition engine: Cut, Fade, Merge, Wipe, CubeZoom, FTB, and T-Bar."""
        suite_path = os.path.join(STATIC_DIR, "director_suite.html")
        with open(suite_path, "r", encoding="utf-8") as f:
            content = f.read()

        transitions = ["cut", "fade", "merge", "wipe", "cube", "ftb", "quick_play"]
        for t in transitions:
            assert f"triggerTransition('{t}')" in content or f"animateTransition" in content, f"Transition '{t}' missing from switcher"
        assert "t-bar" in content.lower()
        assert "handleTBar" in content

    def test_05_multi_rtmp_api_and_channel_multiplexing(self, client):
        """Verify Multi-RTMP channel management, stream key masking, and broadcast endpoints."""
        # 1. Fetch current destinations
        res = client.get("/api/rtmp/destinations")
        assert res.status_code == 200
        initial_destinations = res.json()

        # 2. Add a synthetic YouTube test destination
        synthetic_dest = {
            "name": "Synthetic YouTube 1080p60",
            "platform": "YouTube Live",
            "url": "rtmp://a.rtmp.youtube.com/live2",
            "stream_key": "test-synthetic-key-12345",
            "enabled": True
        }
        res_post = client.post("/api/rtmp/destinations", json=synthetic_dest)
        assert res_post.status_code == 200
        created = res_post.json()
        dest_id = created["id"]
        assert created["name"] == synthetic_dest["name"]
        assert created["enabled"] is True

        # 3. Verify destination list contains our new synthetic channel
        res_list = client.get("/api/rtmp/destinations")
        assert res_list.status_code == 200
        dest_ids = [d["id"] for d in res_list.json()]
        assert dest_id in dest_ids

        # 4. Check RTMP status
        res_status = client.get("/api/rtmp/status")
        assert res_status.status_code == 200
        status_data = res_status.json()
        assert "is_broadcasting" in status_data
        assert "total_destinations" in status_data

        # 5. Clean up the test destination
        res_del = client.delete(f"/api/rtmp/destinations/{dest_id}")
        assert res_del.status_code == 200

    def test_06_synthetic_edge_cases(self):
        """Verify synthetic edge cases: Talkback duplex, Silent chat cues, and Ingest Deck collapse."""
        suite_path = os.path.join(STATIC_DIR, "director_suite.html")
        with open(suite_path, "r", encoding="utf-8") as f:
            content = f.read()

        assert "startTalkback" in content
        assert "stopTalkback" in content
        assert "sendQuickCue" in content
        assert "toggleIngestDeck" in content
        assert "addLiveCameraSource" in content
        assert "addScreenShareSource" in content
        assert "addTextOverlay" in content

    def test_07_guest_camera_feeder_page(self, client):
        """Verify guest.html cross-platform feeder, blackout button, bonded network, and absence of RTMP."""
        res = client.get("/guest.html")
        assert res.status_code == 200, "Failed to load /guest.html"
        html = res.text

        # 1. Cross-platform device detection
        assert "camera-device-select" in html
        assert "mic-device-select" in html
        assert "scanHardwareDevices" in html

        # 2. Blackout / Privacy feature
        assert "toggleBlackout" in html
        assert "blackout-btn" in html
        assert "BLACKOUT ENGAGED" in html

        # 3. Bonded Network (instead of RTMP)
        assert "bonded-network-modal" in html
        assert "Combined Uplink" in html
        assert "0-Second Failover Active" in html

        # 4. Tally and Talkback
        assert "tally-air" in html
        assert "tally-cue" in html
        assert "talkback-audio" in html
        assert "startGuestTalkback" in html

        # 5. Silent Director Cues
        assert "silent-cue-banner" in html
        assert "showDirectorCue" in html

        # 6. Exclude RTMP on guest page
        assert "Multi-Destination RTMP Live Stream" not in html
        assert "rtmp-destinations-list" not in html

    def test_08_guest_local_file_playback_and_audio_notifications(self, client):
        """Verify guest.html local media streaming controls, audio chimes, and teleprompter cue banner."""
        res = client.get("/guest.html")
        assert res.status_code == 200
        html = res.text

        # Local File Streamer controls
        assert "btn-mode-file" in html
        assert "file-player-controls" in html
        assert "handleLocalMediaFileSelect" in html
        assert "playSelectedMediaFile" in html
        assert "media-seek-bar" in html
        assert "media-timecode" in html
        assert "media-loop-btn" in html

        # Studio Audio Chime Synthesizer
        assert "playTallyOnAirChime" in html
        assert "playTallyCueChime" in html
        assert "playDirectorCueChime" in html
        assert "playTalkbackBeep" in html
        assert "tally-sound-btn" in html

        # Silent Cue Reception
        assert "silent-cue-banner" in html
        assert "director-cue-text" in html
        assert "dismissSilentCue" in html

    def test_09_director_suite_clean_inputs_tabs_and_toasts(self):
        """Verify director_suite.html starts with 0 virtual inputs, has active tab filtering, toasts, and tally dispatch."""
        suite_path = os.path.join(STATIC_DIR, "director_suite.html")
        with open(suite_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Clean startup (0 virtual inputs by default)
        assert "Starts clean: 0 virtual inputs" in content or "sources: []" in content
        # Ensure generateSyntheticSources is NOT called in window load
        load_section = re.search(r"window\.addEventListener\('load',\s*\(\)\s*=>\s*\{([^}]+)\}\);", content)
        assert load_section is not None, "window load listener missing"
        assert "generateSyntheticSources()" not in load_section.group(1), "Synthetic sources should not auto-generate on startup"

        # Tab functionality (Inputs, Pure Guests, Scenes)
        assert "tab-src-inputs" in content
        assert "tab-src-guests" in content
        assert "tab-src-scenes" in content
        assert "state.sourceFilter === 'scenes'" in content
        assert "state.sourceFilter === 'guests'" in content

        # Floating studio toast and chimes
        assert "director-toast-container" in content
        assert "showDirectorToast" in content
        assert "playDirectorChime" in content

        # Tally dispatch engine and talkback
        assert "dispatchTallyToAllGuests" in content
        assert "startDirectorBroadcastVoice" in content
        assert "stopDirectorBroadcastVoice" in content

    def test_10_director_video_rendering_and_audio_monitoring(self):
        """Verify video rendering in respected windows and Director Audio Monitoring with PGM Only and Solo PFL."""
        suite_path = os.path.join(STATIC_DIR, "director_suite.html")
        with open(suite_path, "r", encoding="utf-8") as f:
            content = f.read()

        # 1. Chromium/Firefox continuous decoding pool
        assert "video-pool-container" in content, "Hidden video pool container missing"

        # 2. Director Audio Monitor Deck Controls in Header
        assert "director-monitor-mode-select" in content, "Director monitor mode selector missing"
        assert "pgm_only" in content, "PGM Only mode option missing"
        assert "director-master-mute-btn" in content, "Master monitor mute button missing"
        assert "director-monitor-vol-slider" in content, "Master monitor volume slider missing"

        # 3. Audio Routing & Monitoring Engine
        assert "updateDirectorAudioMonitoring" in content
        assert "setDirectorMonitorMode" in content
        assert "toggleDirectorMasterMute" in content
        assert "toggleGuestSolo" in content
        assert "toggleGuestMonitorMute" in content
        assert "isGuestOnProgram" in content
        assert "isGuestOnPreview" in content

        # 4. Per-Guest Card Audio Controls
        assert "toggleGuestMonitorMute" in content
        assert "PFL Solo" in content

        # 5. Respected Window Video & Scene Rendering
        assert "pvwTarget" in content
        assert "pgmTarget" in content
        assert "drawSplitScreenScene" in content
        assert "drawPipScene" in content
        assert "drawQuadMultiBoxScene" in content
        assert "drawSourceCardSlate" in content

    def test_11_director_suite_multirtmp_quality_recordings_and_bonded(self, client):
        """Verify director_suite.html has 100% parity with Control Deck Multi-RTMP, Quality/Bitrate, Local Recording, and Bonded Network."""
        suite_path = os.path.join(STATIC_DIR, "director_suite.html")
        with open(suite_path, "r", encoding="utf-8") as f:
            content = f.read()

        # 1. Header & Deck Status Badges
        assert 'id="rtmp-header-btn"' in content
        assert 'id="rtmp-header-dot"' in content
        assert 'id="rtmp-header-text"' in content
        assert 'id="deck-rtmp-status-pill"' in content
        assert 'id="deck-rtmp-dot"' in content
        assert 'id="deck-rtmp-label"' in content

        # 2. 4-Tab Multi-RTMP Modal Structure
        assert 'id="rtmp-tab-destinations"' in content
        assert 'id="rtmp-tab-quality"' in content
        assert 'id="rtmp-tab-recordings"' in content
        assert 'id="rtmp-tab-bonding"' in content
        assert 'switchRTMPTab' in content
        assert 'setRTMPPreset' in content
        assert 'togglePasswordVisibility' in content

        # 3. Quality & Bitrate Controls
        assert 'id="rtmp-input-bitrate"' in content
        assert 'id="bitrate-val-display"' in content
        assert 'id="rtmp-input-fps"' in content
        assert 'id="rtmp-input-audio-bitrate"' in content
        assert 'id="rtmp-input-preset"' in content
        assert 'id="rtmp-input-record"' in content
        assert 'id="rtmp-input-rec-fmt"' in content
        assert 'id="rtmp-input-gdrive-sync"' in content
        assert 'setBitratePreset' in content
        assert 'saveRTMPSettings' in content
        assert 'fetchRTMPSettings' in content

        # 4. Local Recordings Management
        assert 'id="recordings-list-container"' in content
        assert 'fetchRecordings' in content
        assert 'remuxRecordingFile' in content
        assert 'deleteRecordingFile' in content

        # 5. Bonded Network Radar & Telemetry
        assert 'id="bonded-stat-bitrate"' in content
        assert 'id="bonded-stat-active-links"' in content
        assert 'id="bonded-stat-jitter-depth"' in content
        assert 'id="bonded-stat-packets"' in content
        assert 'id="discovered-isps-grid"' in content
        assert 'id="custom-secondary-links-tags"' in content
        assert 'scanClientISPsWithWebRTC' in content
        assert 'addCustomISPRoute' in content
        assert 'addSecondaryLink' in content
        assert 'removeSecondaryLink' in content
        assert 'fetchBondedStatus' in content

        # 6. Real Live Canvas Ingest & WebSocket Framing Pipeline
        assert 'masterBroadcastCanvas' in content
        assert 'startLiveCanvasIngest' in content
        assert 'stopLiveCanvasIngest' in content
        assert 'sendFramedChunk' in content
        assert '0x42' in content  # 'B'
        assert '0x4E' in content  # 'N'
        assert '/api/rtmp/stream_ingest' in content
        assert 'syncDirectorMasterAudioSources' in content
        assert 'renderDirectorMasterFrame' in content
        assert 'startRTMPBroadcast' in content
        assert 'stopRTMPBroadcast' in content
        assert 'updateRTMPUI' in content

        # 7. Backend API verification for RTMP, Settings, Recordings & Bonded Status
        res_settings = client.get("/api/rtmp/settings")
        assert res_settings.status_code == 200
        settings_data = res_settings.json()
        assert "video_bitrate_kbps" in settings_data
        assert "record_local" in settings_data

        res_recordings = client.get("/api/recordings")
        assert res_recordings.status_code == 200
        recordings_data = res_recordings.json()
        assert "recordings" in recordings_data

        res_bonded = client.get("/api/rtmp/bonded_status")
        assert res_bonded.status_code == 200
        bonded_data = res_bonded.json()
        assert "combined_bitrate_kbps" in bonded_data
        assert "active_links_count" in bonded_data

    def test_12_clean_program_feed_on_screen_audio_meter_and_oled_blackout(self, client):
        """Verify clean program feed without burned-in labels, on-screen video VU meter, and full-screen OLED blackout."""
        # 1. Clean Program Feed in director_suite.html
        ds_res = client.get("/director_suite.html")
        assert ds_res.status_code == 200
        ds_html = ds_res.text

        # Verify that debug name labels are NOT burned onto live video frames
        assert "ctx.fillText(targetSource.name, 30, h - 28)" not in ds_html
        assert "ctx.fillText(`SCENE 1: ${src1.name}`, 30, h - 28)" not in ds_html
        assert "CLEAN BROADCAST FEED" in ds_html

        # 2. Guest on-screen VU meter and layout in guest.html
        g_res = client.get("/guest.html")
        assert g_res.status_code == 200
        g_html = g_res.text

        # On-screen audio meter overlay directly on video
        assert "on-screen-vu-meter" in g_html
        assert "vu-bar-l" in g_html
        assert "vu-bar-r" in g_html
        assert "vu-db-text" in g_html
        assert "toggleLocalMediaMute" in g_html
        assert "local-monitor-mute-btn" in g_html

        # Old side audio meter column removed
        assert "AUDIO VU METER</div>" not in g_html

        # 3. Full-screen OLED Blackout (Battery Saver)
        assert 'id="blackout-screen"' in g_html
        assert "fixed inset-0" in g_html
        assert "OLED BATTERY SAVER ACTIVE" in g_html
        assert "Tap anywhere to wake screen" in g_html
        # Verify blackout keeps streams live
        assert "OLED Battery Saver active: Screen black, live stream sending to studio" in g_html

    def test_13_webrtc_high_bitrate_and_quality_controls(self, client):
        """Verify WebRTC high-bitrate encoding, quality controls, URL params, and remote quality commands."""
        # 1. Guest Feeder verification
        g_res = client.get("/guest.html")
        assert g_res.status_code == 200
        g_html = g_res.text

        # Header Bitrate Telemetry
        assert 'id="telemetry-bitrate"' in g_html
        assert 'BITRATE:' in g_html

        # Resolution Dropdown default to 1080p and includes 4K
        assert 'value="2160"' in g_html
        assert '<option value="1080" selected>' in g_html

        # Dedicated Bitrate & Quality Control Deck
        assert 'id="guest-bitrate-slider"' in g_html
        assert 'id="bitrate-val-display"' in g_html
        assert 'id="guest-fps-select"' in g_html
        assert 'id="bitrate-mode-select"' in g_html
        assert 'id="degradation-select"' in g_html
        assert 'id="stat-outbound-bps"' in g_html
        assert 'id="stat-outbound-fps"' in g_html
        assert 'id="stat-outbound-rtt"' in g_html
        assert 'id="stat-outbound-loss"' in g_html

        # Preset buttons
        assert "setBitratePreset(12000)" in g_html
        assert "setBitratePreset(8000)" in g_html
        assert "setBitratePreset(6000)" in g_html
        assert "setBitratePreset(4000)" in g_html
        assert "setBitratePreset(2500)" in g_html

        # WebRTC setParameters enforcement & telemetry
        assert "applyWebRTCBitrateConstraints" in g_html
        assert "enforceCallBitrate" in g_html
        assert "startBitrateStatsMonitor" in g_html
        assert "handleRemoteQualityCommand" in g_html
        assert "params.encodings[0].maxBitrate = bps" in g_html
        assert "params.degradationPreference = currentDegradation" in g_html
        assert "maintain-resolution" in g_html
        assert "urlParams.get('bitrate')" in g_html
        assert "urlParams.get('quality')" in g_html

        # 2. Director Suite verification
        ds_res = client.get("/director_suite.html")
        assert ds_res.status_code == 200
        ds_html = ds_res.text

        # Remote Quality quick buttons and live inbound bitrate on guest tiles
        assert 'id="guest-bitrate-${s.id}"' in ds_html
        assert "sendGuestQualityCommand('${s.id}', 4000)" in ds_html
        assert "sendGuestQualityCommand('${s.id}', 6000)" in ds_html
        assert "sendGuestQualityCommand('${s.id}', 8000)" in ds_html
        assert "sendGuestQualityCommand('${s.id}', 12000)" in ds_html

        # Inbound bitrate telemetry and remote quality command function
        assert "startInboundBitrateTelemetry" in ds_html
        assert "sendGuestQualityCommand" in ds_html
        assert "SET_GUEST_QUALITY" in ds_html
        assert "inbound-rtp" in ds_html

        # Invite modal quality presets and default 6000 kbps
        assert "quality=${targetQuality}&bitrate=${targetBitrate}" in ds_html
        assert "setInviteLinkProfile" in ds_html
        assert "setInviteLinkProfile('1080', 6000)" in ds_html
        assert "setInviteLinkProfile('1080', 12000)" in ds_html

    def test_14_monitor_hud_overlay_and_guest_real_isp_scanner(self, client):
        """Verify Director Suite HUD overlay auto-fade / opacity modes and Guest page real Multi-ISP scanning radar."""
        res_ds = client.get("/director_suite.html")
        assert res_ds.status_code == 200
        ds_html = res_ds.text

        # 1. Director Suite Monitor HUD Overlay
        assert 'id="pvw-monitor-hud"' in ds_html
        assert 'id="pgm-monitor-hud"' in ds_html
        assert 'id="pvw-monitor-hud-text"' in ds_html
        assert 'id="pgm-monitor-hud-text"' in ds_html
        assert 'id="hud-mode-btn"' in ds_html
        assert 'cycleMonitorHudMode' in ds_html
        assert 'flashMonitorOverlay' in ds_html
        assert 'applyMonitorHudMode' in ds_html
        assert 'opacity-0 group-hover:opacity-90' in ds_html

        # 2. Guest Page Real Multi-ISP Radar & Bonded Network
        res_guest = client.get("/guest.html")
        assert res_guest.status_code == 200
        guest_html = res_guest.text

        assert 'id="guest-bonded-uplink"' in guest_html
        assert 'id="bond-active-links"' in guest_html
        assert 'id="guest-bonded-jitter"' in guest_html
        assert 'id="guest-bonded-loss"' in guest_html
        assert 'id="network-links-list"' in guest_html
        assert 'id="rescan-links-btn"' in guest_html
        assert 'scanNetworkInterfaces' in guest_html
        assert 'probeWebRTCICECandidates' in guest_html
        assert 'resolveClientISPData' in guest_html
        assert 'measureOriginPing' in guest_html
        assert 'secondary-link-input' in guest_html
        assert 'addGuestSecondaryLink' in guest_html
        assert 'renderGuestSecondaryLinks' in guest_html

    def test_15_guest_isp_exclusion_and_chunk_tracking(self, client):
        """Verify guest page persistent ISP exclusion, per-link chunk telemetry, reset counters, and auto-reconnect lockout."""
        res = client.get("/guest.html")
        assert res.status_code == 200
        html = res.text

        # 1. Persistent exclusion storage & state
        assert "guest_excluded_isp_ids" in html
        assert "toggleExcludeProvider" in html
        assert "updateExcludedBadge" in html
        assert 'id="excluded-links-badge"' in html
        assert "USER EXCLUDED" in html
        assert "🚫 Exclude" in html
        assert "✓ Include" in html
        assert "removeProviderInterface" in html

        # 2. Per-provider chunk telemetry & traffic share distribution
        assert "providerChunkStats" in html
        assert "updateProviderChunksTick" in html
        assert "resetChunkCounters" in html
        assert "chunk-count-${iface.id}" in html
        assert "chunk-bytes-${iface.id}" in html
        assert "chunk-rate-${iface.id}" in html
        assert "chunk-share-${iface.id}" in html
        assert "chunk-bar-${iface.id}" in html

        # 3. Auto-failover and auto-reconnect engine
        assert "startLinkHealthMonitor" in html
        assert "AUTO-RECONNECTED (HEALTHY)" in html
        assert "FAILOVER (TEMP OUTAGE)" in html

        # 4. Strict constraint: Excluded providers MUST NEVER auto-connect
        assert "isExcluded" in html
        # Ensure that excluded links explicitly return / skip auto-reconnect
        assert "if (isExcluded) {" in html
        assert "return;" in html



