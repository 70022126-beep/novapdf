"""Sesiones efímeras para proteger la API local de otros procesos web."""

from __future__ import annotations

import secrets
import threading
import time
from typing import Any
from urllib.parse import urlparse


LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def is_allowed_origin(origin: str | None) -> bool:
    if not origin:
        return True
    try:
        parsed = urlparse(origin)
        return parsed.scheme in {"http", "https"} and parsed.hostname in LOOPBACK_HOSTS
    except ValueError:
        return False


class SessionManager:
    def __init__(self, ttl_seconds: int = 30 * 60, maximum_sessions: int = 64):
        self.ttl_seconds = max(60, int(ttl_seconds))
        self.maximum_sessions = max(1, int(maximum_sessions))
        self._sessions: dict[str, float] = {}
        self._lock = threading.Lock()

    def _prune(self, current_time: float) -> None:
        expired = [token for token, expiry in self._sessions.items() if expiry <= current_time]
        for token in expired:
            self._sessions.pop(token, None)
        if len(self._sessions) <= self.maximum_sessions:
            return
        for token, _ in sorted(self._sessions.items(), key=lambda item: item[1])[
            : len(self._sessions) - self.maximum_sessions
        ]:
            self._sessions.pop(token, None)

    def issue(self) -> dict[str, Any]:
        current_time = time.time()
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._prune(current_time)
            self._sessions[token] = current_time + self.ttl_seconds
        return {
            "token": token,
            "expires_at": current_time + self.ttl_seconds,
            "ttl_seconds": self.ttl_seconds,
        }

    def validate(self, token: str | None) -> bool:
        if not token:
            return False
        current_time = time.time()
        with self._lock:
            self._prune(current_time)
            expiry = self._sessions.get(token)
            if expiry is None or expiry <= current_time:
                return False
            self._sessions[token] = current_time + self.ttl_seconds
            return True

    def stats(self) -> dict[str, int]:
        with self._lock:
            self._prune(time.time())
            return {
                "active": len(self._sessions),
                "maximum": self.maximum_sessions,
                "ttl_seconds": self.ttl_seconds,
            }

