"""Proceso aislado para pdf2docx; no debe importar PaddleOCR ni su OpenCV."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
from pathlib import Path


def status() -> dict[str, str | bool | None]:
    try:
        import pymupdf

        return {
            "available": True,
            "converter": "pdf2docx-isolated",
            "version": importlib.metadata.version("pdf2docx"),
            "pymupdf_version": getattr(pymupdf, "VersionBind", None),
        }
    except (ImportError, importlib.metadata.PackageNotFoundError):
        return {
            "available": False,
            "converter": "pdf2docx-isolated",
            "version": None,
            "pymupdf_version": None,
        }


def convert(source: Path, output: Path, pages: str) -> None:
    from pdf2docx import Converter

    page_indices = [int(value) for value in pages.split(",") if value.strip()]
    converter = Converter(str(source))
    try:
        converter.convert(str(output), pages=page_indices, multi_processing=False)
    finally:
        converter.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--pages", default="")
    arguments = parser.parse_args()
    if arguments.status:
        print(json.dumps(status()))
        return
    if not arguments.source or not arguments.output or not arguments.pages:
        parser.error("source, output y pages son obligatorios")
    convert(arguments.source, arguments.output, arguments.pages)


if __name__ == "__main__":
    main()
