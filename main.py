"""
Vercel Serverless Entrypoint for FastAPI Application
"""
import sys
import os

# Ensure project root is on sys.path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from python_app.main import app
