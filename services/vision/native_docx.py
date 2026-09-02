"""Conversor DOCX nativo opcional para PDFs digitales.

pdf2docx se utiliza como un segundo candidato, nunca como sustituto ciego del
motor regional. El frontend valida ambos DOCX contra el PDF original y solo
conserva este candidato cuando mejora la calidad de forma medible.
"""

from __future__ import annotations

import importlib.metadata
import tempfile
import time
from pathlib import Path
from typing import Any


def native_docx_status() -> dict[str, Any]:
    try:
        version = importlib.metadata.version("pdf2docx")
        import pymupdf

        return {
            "available": True,
            "converter": "pdf2docx",
            "version": version,
            "pymupdf_version": getattr(pymupdf, "VersionBind", None),
        }
    except (ImportError, importlib.metadata.PackageNotFoundError):
        return {
            "available": False,
            "converter": "pdf2docx",
            "version": None,
            "pymupdf_version": None,
        }


def convert_native_pdf_to_docx(
    pdf_content: bytes,
    page_indices: list[int],
) -> tuple[bytes, dict[str, Any]]:
    if not pdf_content.startswith(b"%PDF-"):
        raise ValueError("Archivo PDF no valido.")
    if not page_indices:
        raise ValueError("El rango de paginas esta vacio.")

    try:
        from pdf2docx import Converter
    except ImportError as error:
        raise RuntimeError("El candidato DOCX nativo no esta instalado.") from error

    started_at = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="novapdf-native-docx-") as directory:
        workspace = Path(directory)
        source_path = workspace / "source.pdf"
        output_path = workspace / "candidate.docx"
        source_path.write_bytes(pdf_content)

        converter = Converter(str(source_path))
        try:
            converter.convert(
                str(output_path),
                pages=page_indices,
                multi_processing=False,
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
