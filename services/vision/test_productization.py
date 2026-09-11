import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from .app import app
from .device_selector import select_device
from . import model_manager
from .session_security import SessionManager, is_allowed_origin


class SessionSecurityTests(unittest.TestCase):
    def test_session_tokens_are_required_and_loopback_origins_are_allowed(self):
        client = TestClient(app)
        self.assertEqual(client.post("/v1/documents").status_code, 401)
        session_response = client.post(
            "/v1/session", headers={"Origin": "http://127.0.0.1:4173"}
        )
        self.assertEqual(session_response.status_code, 200)
        token = session_response.json()["token"]
        authenticated = client.post(
            "/v1/documents", headers={"X-NovaPDF-Session": token}
        )
        self.assertEqual(authenticated.status_code, 422)
        self.assertEqual(
            client.post(
                "/v1/session", headers={"Origin": "https://malicious.example"}
            ).status_code,
            403,
        )

    def test_session_manager_rejects_unknown_tokens(self):
        manager = SessionManager(ttl_seconds=60, maximum_sessions=2)
        issued = manager.issue()
        self.assertTrue(manager.validate(issued["token"]))
        self.assertFalse(manager.validate("not-issued"))
        self.assertTrue(is_allowed_origin("http://localhost:5173"))
        self.assertFalse(is_allowed_origin("https://example.com"))


class DeviceSelectionTests(unittest.TestCase):
    def test_auto_prefers_gpu_and_falls_back_to_cpu(self):
        self.assertEqual(select_device("auto", lambda: True).selected, "gpu:0")
        fallback = select_device("gpu:0", lambda: False)
        self.assertEqual(fallback.selected, "cpu")
        self.assertEqual(fallback.reason, "gpu-unavailable-fallback")
        self.assertEqual(select_device("cpu", lambda: True).selected, "cpu")


class ModelIntegrityTests(unittest.TestCase):
    def test_manifest_detects_tampered_model_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            model_root = Path(temporary).resolve()
            model_file = model_root / "paddlex" / "official_models" / "model" / "weights.bin"
            model_file.parent.mkdir(parents=True)
            model_file.write_bytes(b"verified-model")
            manifest = model_root / "model-manifest.json"
            manifest.write_text(
                json.dumps({
                    "files": [{
                        "path": model_file.relative_to(model_root).as_posix(),
                        "size_bytes": model_file.stat().st_size,
                        "sha256": hashlib.sha256(model_file.read_bytes()).hexdigest(),
                    }],
                    "total_bytes": model_file.stat().st_size,
                }),
                encoding="utf-8",
            )
            with patch.object(model_manager, "MODEL_ROOT", model_root):
                self.assertTrue(model_manager.verify_manifest(manifest)["valid"])
                model_file.write_bytes(b"tampered-model")
                result = model_manager.verify_manifest(manifest)
            self.assertFalse(result["valid"])
            self.assertEqual(result["failures"][0]["reason"], "sha256")


if __name__ == "__main__":
    unittest.main()
