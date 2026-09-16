import os
import pytest
from fastapi.testclient import TestClient
from python_app.main import app
from python_app.core.ssl_helper import get_or_create_ssl_cert, get_local_ip_addresses
from python_app.core.hardware_manager import hardware_manager

client = TestClient(app)

def test_ssl_generation_and_ip_detection(tmp_path):
    """Test self-signed SSL cert generation with dynamic LAN IPs."""
    ssl_dir = str(tmp_path / "ssl")
    
    # Check IP detection
    ips = get_local_ip_addresses()
    assert isinstance(ips, list)
    assert len(ips) > 0
    assert "127.0.0.1" in ips

    # Generate cert
    cert_path, key_path = get_or_create_ssl_cert(ssl_dir=ssl_dir)
    assert os.path.exists(cert_path)
    assert os.path.exists(key_path)
    
    with open(cert_path, 'r') as f:
        cert_content = f.read()
    assert "BEGIN CERTIFICATE" in cert_content

    with open(key_path, 'r') as f:
        key_content = f.read()
    assert "BEGIN RSA PRIVATE KEY" in key_content

def test_hardware_manager_device_discovery():
    """Test device discovery on the host machine."""
    devices = hardware_manager.list_capture_devices()
    assert isinstance(devices, list)
    # Hardware manager should always return a list (either physical devices or fallback test pattern)
    assert len(devices) >= 1
    dev = devices[0]
    assert "id" in dev
    assert "name" in dev
    assert "backend" in dev

def test_api_hardware_devices():
    """Test /api/hardware/devices endpoint."""
    response = client.get("/api/hardware/devices")
    assert response.status_code == 200
    data = response.json()
    assert "status" in data
    assert data["status"] == "ok"
    assert "devices" in data
    assert isinstance(data["devices"], list)

def test_api_system_security():
    """Test /api/system/security endpoint."""
    response = client.get("/api/system/security")
    assert response.status_code == 200
    data = response.json()
    assert "status" in data
    assert "is_ssl_configured" in data
    assert "recommended_https_port" in data
    assert "lan_ips" in data
    assert isinstance(data["lan_ips"], list)

def test_api_hardware_stream_chunk():
    """Test that hardware manager generates proper multipart MJPEG frame chunks."""
    gen = hardware_manager.generate_mjpeg_stream(0)
    chunk = next(gen)
    assert b"--frame" in chunk
    assert b"Content-Type: image/jpeg" in chunk
    gen.close()
