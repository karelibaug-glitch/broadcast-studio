"""
Standard Vercel serverless function entrypoint
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from python_app.main import app
