"""
token_manager.py — Copilot Auth (Python port of tokenManager.js)

Reads COPILOT_TOKEN or GITHUB_TOKEN from the environment.
  • Long token (≥100 chars) → assumed to be a Copilot JWT, used directly.
  • Short token             → GitHub OAuth token, exchanged for a Copilot JWT.

Tokens are cached in memory for 29 minutes.
"""
import http.client
import json
import os
import time
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

# Load .env from the project root
load_dotenv(Path(__file__).parent / ".env")

EXCHANGE_ENDPOINTS = [
    ("api.github.com", "/copilot_internal/v2/token"),
    ("api.githubcopilot.com", "/token"),
]

COPILOT_HEADERS = {
    "Editor-Version": "vscode/1.85.0",
    "Editor-Plugin-Version": "copilot-chat/0.12.0",
    "Copilot-Integration-Id": "vscode-chat",
    "User-Agent": "python-pipeline/1.0.0",
}

_cache: Optional[dict] = None  # {"token": str, "expires_at": float (ms)}


def _exchange_oauth_token(oauth_token: str) -> tuple[str, float]:
    """Exchange a GitHub OAuth token for a Copilot JWT."""
    request_headers = {
        "Authorization": f"token {oauth_token}",
        "Accept": "application/json",
        "X-GitHub-Api-Version": "2023-07-07",
        **COPILOT_HEADERS,
    }

    for host, path in EXCHANGE_ENDPOINTS:
        connection = http.client.HTTPSConnection(host, timeout=10)
        try:
            connection.request("GET", path, headers=request_headers)
            response = connection.getresponse()
            payload = response.read().decode("utf-8")
            if response.status != 200:
                continue
            data = json.loads(payload)
            token = data.get("token")
            if not token:
                continue
            expires_at = data.get("expires_at")
            expires_in = data.get("expires_in", 29 * 60)
            expiry = (
                float(expires_at) * 1000
                if expires_at
                else (time.time() * 1000) + (float(expires_in) * 1000)
            )
            print(f"[TokenManager] Exchanged OAuth token via {host}{path}")
            return token, expiry
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        finally:
            connection.close()

    raise RuntimeError("OAuth exchange failed — check your GITHUB_TOKEN")


def get_token() -> str:
    """Get a valid Copilot token (from cache, env, or OAuth exchange)."""
    global _cache

    if _cache and time.time() * 1000 < float(_cache["expires_at"]) - 60_000:
        return _cache["token"]

    env_token = os.getenv("COPILOT_TOKEN") or os.getenv("GITHUB_TOKEN")
    if not env_token:
        raise RuntimeError("Set COPILOT_TOKEN or GITHUB_TOKEN in the environment.")

    # Long token → Copilot JWT, use directly
    if len(env_token) >= 100:
        _cache = {
            "token": env_token,
            "expires_at": (time.time() * 1000) + (29 * 60 * 1000),
        }
        print("[TokenManager] Using COPILOT_TOKEN from env")
        return env_token

    # Short token → exchange
    print("[TokenManager] Exchanging GITHUB_TOKEN for Copilot token...")
    token, expires_at = _exchange_oauth_token(env_token)
    _cache = {"token": token, "expires_at": expires_at}
    return token


def clear_token():
    """Force-clear the cached token (e.g. after a 401 response)."""
    global _cache
    _cache = None
