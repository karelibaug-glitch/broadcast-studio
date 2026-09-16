# Production Deployment Guide: Pro Broadcast Studio

This guide covers deploying the **Pro Broadcast Studio Engine** to a live production Linux server (Ubuntu 20.04 / 22.04 / 24.04, Debian, AWS EC2, DigitalOcean, Hetzner, Linode, or GCP).

---

## 1. System Requirements & Port Configuration

### Hardware Recommendations
- **CPU**: 2+ Cores (4+ Cores recommended for 1080p 60fps CBR H.264 transcoding)
- **RAM**: 2 GB+ (4 GB recommended)
- **Disk**: 20 GB+ SSD (higher if recording local broadcasts)

### Firewall Ports to Open
| Port | Protocol | Purpose |
| :--- | :--- | :--- |
| **`80`** | TCP | HTTP / Reverse proxy / Let's Encrypt SSL validation |
| **`443`** | TCP | HTTPS / Secure WebSockets (`wss://`) |
| **`8000`** | TCP | Studio HTTP direct port |
| **`8443`** | TCP | Studio HTTPS companion port (for mobile camera feeder without reverse proxy) |

---

## 2. Method A: Deployment with Docker (Recommended)

### Step 1: Clone Repository & Enter Directory
```bash
git clone <your-repository-url> broadcast-studio
cd broadcast-studio
```

### Step 2: Launch via Docker Compose
```bash
docker compose up -d --build
```

### Step 3: Check Running Logs
```bash
docker compose logs -f
```

The studio is now live on `http://<your-server-ip>:8000` and `https://<your-server-ip>:8443`.

---

## 3. Method B: Native Deployment on Ubuntu/Debian Linux

### Step 1: Install System Dependencies & FFmpeg
```bash
sudo apt update && sudo apt install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    build-essential
```

### Step 2: Create Virtual Environment & Install Python Packages
```bash
cd /opt
sudo git clone <your-repository-url> broadcast-studio
cd /opt/broadcast-studio

sudo python3 -m venv venv
sudo ./venv/bin/pip install --upgrade pip
sudo ./venv/bin/pip install -r requirements.txt
```

### Step 3: Create Systemd Service (Auto-Start on Boot)
Create `/etc/systemd/system/broadcast-studio.service`:
```ini
[Unit]
Description=Pro Broadcast Studio Engine
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/broadcast-studio
ExecStart=/opt/broadcast-studio/venv/bin/python3 run.py --no-browser --host 0.0.0.0 --port 8000
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable broadcast-studio
sudo systemctl start broadcast-studio
sudo systemctl status broadcast-studio
```

---

## 4. Production Nginx Reverse Proxy & SSL Setup

Web browsers require **HTTPS** (`https://`) and **Secure WebSockets** (`wss://`) to access mobile cameras, microphones, and WebRTC on any non-localhost domain.

### Step 1: Install Nginx & Certbot
```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

### Step 2: Configure Nginx Site
Create `/etc/nginx/sites-available/studio.conf`:
```nginx
server {
    listen 80;
    server_name studio.yourdomain.com;

    # Allow large media file uploads (recordings/overlays)
    client_max_body_size 500M;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Long timeouts for continuous live streams
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

Enable site:
```bash
sudo ln -s /etc/nginx/sites-available/studio.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Step 3: Obtain Free Let's Encrypt SSL Certificate
```bash
sudo certbot --nginx -d studio.yourdomain.com
```

---

## 5. Verification Checklist

- [x] Python dependencies verified (`fastapi`, `uvicorn`, `websockets`, `aiortc`, `psutil`, `cryptography`, `opencv-python-headless`, etc.)
- [x] FFmpeg installed on system PATH (`ffmpeg -version`)
- [x] Favicon handler registered (prevents 404 logs)
- [x] `--no-browser` headless argument enabled
- [x] WebSocket reverse proxy headers (`Upgrade`, `Connection`) configured with long timeout (`86400s`)
