# Production Multi-Stage Dockerfile for Pro Broadcast Studio
FROM python:3.11-slim

# Prevent python from buffering stdout/stderr and writing pyc files
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Install system dependencies: FFmpeg, OpenGL/GLib libraries (required for OpenCV & WebRTC)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

# Create recording & SSL directories
RUN mkdir -p recordings ssl uploads

# Expose primary HTTP (8000) and HTTPS companion (8443) ports
EXPOSE 8000 8443

# Start the broadcast studio engine in headless mode
CMD ["python3", "run.py", "--no-browser", "--host", "0.0.0.0", "--port", "8000"]
