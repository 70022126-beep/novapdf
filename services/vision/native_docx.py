"""Conversor DOCX nativo opcional para PDFs digitales.

pdf2docx se utiliza como un segundo candidato, nunca como sustituto ciego del
motor regional. El frontend valida ambos DOCX contra el PDF original y solo
conserva este candidato cuando mejora la calidad de forma medible.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


SERVICE_ROOT = Path(__file__).resolve().parent
WORKER_PATH = SERVICE_ROOT / "pdf2docx_worker.py"


def _isolated_python() -> Path | None:
    configured = os.getenv("NOVAPDF_PDF2DOCX_PYTHON")
    candidates = [
        Path(configured) if configured else None,
        SERVICE_ROOT / ".venv-pdf2docx" / "Scripts" / "python.exe",
        SERVICE_ROOT / ".venv-pdf2docx" / "bin" / "python",
    ]
    return next((path for path in candidates if path and path.is_file()), None)


def native_docx_status() -> dict[str, Any]:
    isolated = _isolated_python()
    if isolated:
        try:
            result = subprocess.run(
                [str(isolated), str(WORKER_PATH), "--status"],
                check=True,
                capture_output=True,
                text=True,
                timeout=20,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            return {
                **json.loads(result.stdout),
                "isolated": True,
                "python": str(isolated),
            }
        except (OSError, ValueError, subprocess.SubprocessError, json.JSONDecodeError):
            return {
                "available": False,
                "converter": "pdf2docx-isolated",
                "version": None,
                "pymupdf_version": None,
                "isolated": True,
                "python": str(isolated),
            }
    try:
        version = importlib.metadata.version("pdf2docx")
        import pymupdf

        return {
            "available": True,
            "converter": "pdf2docx",
            "version": version,
            "pymupdf_version": getattr(pymupdf, "VersionBind", None),
            "isolated": False,
            "python": sys.executable,
        }
    except (ImportError, importlib.metadata.PackageNotFoundError):
        return {
            "available": False,
            "converter": "pdf2docx",
            "version": None,
            "pymupdf_version": None,
            "isolated": False,
            "python": sys.executable,
        }


def convert_native_pdf_to_docx(
    pdf_content: bytes,
    page_indices: list[int],
) -> tuple[bytes, dict[str, Any]]:
    if not pdf_content.startswith(b"%PDF-"):
        raise ValueError("Archivo PDF no valido.")
    if not page_indices:
        raise ValueError("El rango de paginas esta vacio.")

    started_at = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="novapdf-native-docx-") as directory:
        workspace = Path(directory)
        source_path = workspace / "source.pdf"
        output_path = workspace / "candidate.docx"
        source_path.write_bytes(pdf_content)

        isolated = _isolated_python()
        if isolated:
            try:
                subprocess.run(
                    [
                        str(isolated), str(WORKER_PATH),
                        "--source", str(source_path),
                        "--output", str(output_path),
                        "--pages", ",".join(str(page) for page in page_indices),
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=600,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                )
            except subprocess.TimeoutExpired as error:
                raise RuntimeError("pdf2docx aislado excedió el tiempo permitido.") from error
            except subprocess.CalledProcessError as error:
                detail = (error.stderr or error.stdout or "").strip()[-500:]
                raise RuntimeError(f"pdf2docx aislado falló: {detail}") from error
        else:
            try:
                from pdf2docx import Converter
            except ImportError as error:
                raise RuntimeError("El candidato DOCX nativo no esta instalado.") from error
            converter = Converter(str(source_path))
            try:
                converter.convert(
                    str(output_path), pages=page_indices, multi_processing=False
                )
            finally:
                converter.close()

        if not output_path.is_file():
            raise RuntimeError("pdf2docx no genero el documento esperado.")
        content = output_path.read_bytes()

    if not content.startswith(b"PK"):
        raise RuntimeError("El candidato generado no es un DOCX valido.")
    status = native_docx_status()
    return content, {
        **status,
        "duration_ms": round((time.perf_counter() - started_at) * 1000),
        "pages": len(page_indices),
        "output_bytes": len(content),
    }
