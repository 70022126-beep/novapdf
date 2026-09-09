"""Registro persistente y acotado de PDF para no retransmitirlos por página."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class DocumentNotFoundError(FileNotFoundError):
    pass


class DocumentStore:
    def __init__(
        self,
        root: Path,
        maximum_bytes: int,
        ttl_seconds: int = 24 * 60 * 60,
    ):
        self.root = Path(root).resolve()
        self.documents_root = self.root / "documents"
        self.database_path = self.root / "documents.sqlite3"
        self.maximum_bytes = max(1, int(maximum_bytes))
        self.ttl_seconds = max(60, int(ttl_seconds))
        self.documents_root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.database_path, timeout=15)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    filename TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    page_count INTEGER NOT NULL,
                    created_at REAL NOT NULL,
                    last_accessed_at REAL NOT NULL
                )
                """
            )

    def _path(self, document_id: str) -> Path:
        if len(document_id) != 64 or any(char not in "0123456789abcdef" for char in document_id):
            raise DocumentNotFoundError("Identificador de documento no válido.")
        path = (self.documents_root / f"{document_id}.pdf").resolve()
        if path.parent != self.documents_root:
            raise DocumentNotFoundError("Identificador de documento no válido.")
        return path

    def register(self, content: bytes, filename: str, page_count: int) -> dict[str, Any]:
        document_id = hashlib.sha256(content).hexdigest()
        path = self._path(document_id)
        now = time.time()
        with self._lock:
            reused = path.exists()
            if not reused:
                temporary = path.with_suffix(".tmp")
                temporary.write_bytes(content)
                os.replace(temporary, path)
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT INTO documents(id, filename, size_bytes, page_count, created_at, last_accessed_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        filename=excluded.filename,
                        page_count=excluded.page_count,
                        last_accessed_at=excluded.last_accessed_at
                    """,
                    (document_id, filename or "document.pdf", len(content), page_count, now, now),
                )
            self.prune(exclude_id=document_id)
        return {
            "document_id": document_id,
            "filename": filename or "document.pdf",
            "size_bytes": len(content),
            "page_count": int(page_count),
            "reused": reused,
            "expires_at": now + self.ttl_seconds,
        }

    def read(self, document_id: str) -> bytes:
        path = self._path(document_id)
        with self._lock:
            if not path.is_file():
                self._delete_metadata(document_id)
                raise DocumentNotFoundError("El documento registrado ya no está disponible.")
            now = time.time()
            with self._connect() as connection:
                row = connection.execute(
                    "SELECT created_at FROM documents WHERE id = ?", (document_id,)
                ).fetchone()
                if row is None or now - float(row["created_at"]) > self.ttl_seconds:
                    self.delete(document_id)
                    raise DocumentNotFoundError("El registro del documento expiró.")
                connection.execute(
                    "UPDATE documents SET last_accessed_at = ? WHERE id = ?",
                    (now, document_id),
                )
            return path.read_bytes()

    def delete(self, document_id: str) -> bool:
        path = self._path(document_id)
        with self._lock:
            existed = path.exists()
            path.unlink(missing_ok=True)
            self._delete_metadata(document_id)
            return existed

    def _delete_metadata(self, document_id: str) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM documents WHERE id = ?", (document_id,))

    def prune(self, exclude_id: str | None = None) -> dict[str, int]:
        now = time.time()
        removed = 0
        freed = 0
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM documents ORDER BY last_accessed_at ASC"
            ).fetchall()
            total = sum(int(row["size_bytes"]) for row in rows)
            for row in rows:
                expired = now - float(row["created_at"]) > self.ttl_seconds
                over_budget = total > self.maximum_bytes
                if row["id"] == exclude_id or not (expired or over_budget):
                    continue
                self._path(str(row["id"])).unlink(missing_ok=True)
                connection.execute("DELETE FROM documents WHERE id = ?", (row["id"],))
                size = int(row["size_bytes"])
                total -= size
                freed += size
                removed += 1
        return {"removed": removed, "freed_bytes": freed}

    def stats(self) -> dict[str, Any]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM documents"
            ).fetchone()
        return {
            "documents": int(row["count"]),
            "bytes": int(row["bytes"]),
            "maximum_bytes": self.maximum_bytes,
            "ttl_seconds": self.ttl_seconds,
            "root": str(self.root),
        }
