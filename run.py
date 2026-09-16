#!/usr/bin/env python3
"""
Universal Cross-Platform Launcher for Pro Broadcast Studio (Python Core)
Runs on Windows, macOS, and Linux.
"""

import argparse
import sys
import os
import webbrowser
import threading
import time

# Ensure UTF-8 output encoding on Windows consoles
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

import uvicorn

# Ensure project root is in sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def open_browser(url: str, delay: float = 1.2):
    def _open():
        time.sleep(delay)
        print(f"\n[Launcher] Opening Studio in browser: {url}")
        webbrowser.open(url)
    threading.Thread(target=_open, daemon=True).start()


def main():
    parser = argparse.ArgumentParser(description="Pro Broadcast Studio Python Media Engine")
    parser.add_argument("--host", default="0.0.0.0", help="Host address to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind (default: 8000)")
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically open browser")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
    parser.add_argument("--ssl", "--https", dest="ssl", action="store_true", help="Run primary port directly on HTTPS")
    parser.add_argument("--https-port", type=int, default=8443, help="Secondary HTTPS companion port (default: 8443)")

    args = parser.parse_args()

    # Detect actual LAN IP for remote devices
    from python_app.core.ssl_helper import get_local_ip_addresses, get_or_create_ssl_cert
    lan_ips = [ip for ip in get_local_ip_addresses() if ip not in ("127.0.0.1", "0.0.0.0")]
    primary_ip = lan_ips[0] if lan_ips else "127.0.0.1"

    cert_path, key_path = get_or_create_ssl_cert()

    if args.ssl:
        # User explicitly requested primary port to be HTTPS
        os.environ["STUDIO_SSL_ACTIVE"] = "1"
        os.environ["STUDIO_HTTP_PORT"] = str(args.port)
        os.environ["STUDIO_HTTPS_PORT"] = str(args.port)
        protocol = "https"
        ws_protocol = "wss"
        local_url = f"https://localhost:{args.port}"
        lan_info = f"https://{primary_ip}:{args.port}"
        companion_info = None
        main_ssl_kwargs = {
            "ssl_keyfile": key_path,
            "ssl_certfile": cert_path,
        }
    else:
        # Dual mode: primary port is HTTP, companion port is HTTPS
        os.environ["STUDIO_SSL_ACTIVE"] = "0"
        os.environ["STUDIO_HTTP_PORT"] = str(args.port)
        os.environ["STUDIO_HTTPS_PORT"] = str(args.https_port)
        protocol = "http"
        ws_protocol = "ws"
        local_url = f"http://localhost:{args.port}"
        lan_info = f"http://{primary_ip}:{args.port}"
        companion_info = f"https://{primary_ip}:{args.https_port}"
        main_ssl_kwargs = {}

        # Launch background HTTPS companion server so HTTPS works out-of-the-box
        def _run_https_companion():
            try:
                from python_app.main import app as companion_app
                https_cfg = uvicorn.Config(
                    companion_app,
                    host=args.host,
                    port=args.https_port,
                    ssl_keyfile=key_path,
                    ssl_certfile=cert_path,
                    log_level="warning"
                )
                https_srv = uvicorn.Server(https_cfg)
                https_srv.run()
            except Exception as ex:
                print(f"[Launcher] Note: Secondary HTTPS companion on port {args.https_port} did not start: {ex}")

        companion_thread = threading.Thread(target=_run_https_companion, daemon=True)
        companion_thread.start()

    print("=" * 68)
    print(" 🎛️  PRO BROADCAST STUDIO (PYTHON ENGINE - DUAL HTTP & HTTPS)")
    print("=" * 68)
    print(f" Local Control Desk (HTTP) : {local_url}")
    if companion_info:
        print(f" Local Control Desk (HTTPS): https://localhost:{args.https_port}")
    print(f" Remote LAN Access (HTTP)  : {lan_info}")
    if companion_info:
        print(f" Remote LAN Access (HTTPS) : {companion_info} [Mobile Cams & Capture Cards]")
    print(f" WebSockets Endpoint       : {ws_protocol}://localhost:{args.port}/ws")
    print(f" Direct MJPEG Stream       : {local_url}/api/stream/mjpeg")
    print("=" * 68)
    print(" Press Ctrl+C to stop the studio engine.\n")

    if not args.no_browser:
        open_browser(local_url)

    if args.reload:
        uvicorn.run(
            "python_app.main:app",
            host=args.host,
            port=args.port,
            reload=True,
            log_level="info",
            **main_ssl_kwargs
        )
    else:
        from python_app.main import app
        uvicorn.run(
            app,
            host=args.host,
            port=args.port,
            reload=False,
            log_level="info",
            **main_ssl_kwargs
        )


if __name__ == "__main__":
    main()
