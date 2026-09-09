"""Render private OCR corpus pages and create non-authoritative annotation drafts."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import pymupdf


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def _resolve(base: Path, value: str) -> Path:
    candidate = Path(value).expanduser()
    return candidate.resolve() if candidate.is_absolute() else (base / candidate).resolve()


def _require_private_output(base: Path, target: Path) -> None:
    private_root = base.resolve() if base.name.lower() == "private" else (base / "private").resolve()
    try:
        target.relative_to(private_root)
    except ValueError as error:
        raise ValueError(f"La salida privada debe quedar dentro de {private_root}.") from error


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare(manifest_path: Path, force: bool = False, maximum: int | None = None) -> dict[str, Any]:
    manifest_path = manifest_path.resolve()
    base = manifest_path.parent
    manifest = _read_json(manifest_path)
    dpi = max(96, min(600, int(manifest.get("renderDpi") or 220)))
    samples = list(manifest.get("samples") or [])
    if maximum is not None:
        samples = samples[:maximum]

    documents: dict[Path, pymupdf.Document] = {}
    source_hashes: dict[Path, str] = {}
    rendered = 0
    drafts_created = 0
    preserved_annotations = 0
    failures: list[dict[str, str]] = []

    try:
        for sample in samples:
            sample_id = str(sample.get("id") or "").strip()
            try:
                if not sample_id:
                    raise ValueError("Muestra sin id.")
                source = _resolve(base, str(sample.get("sourcePdf") or ""))
                if not source.is_file():
                    raise FileNotFoundError(f"No existe el PDF fuente: {source.name}")
                page_number = int(sample.get("page") or 0)
                rotation = int(sample.get("rotation") or 0) % 360
                if rotation not in {0, 90, 180, 270}:
                    raise ValueError("rotation debe ser 0, 90, 180 o 270.")
                private_prefix = "" if base.name.lower() == "private" else "private/"
                image_path = _resolve(base, str(sample.get("image") or f"{private_prefix}images/{sample_id}.png"))
                annotation_path = _resolve(
                    base,
                    str(sample.get("annotation") or f"{private_prefix}annotations/{sample_id}.json"),
                )
                _require_private_output(base, image_path)
                _require_private_output(base, annotation_path)

                document = documents.get(source)
                if document is None:
                    document = pymupdf.open(source)
                    documents[source] = document
                    source_hashes[source] = _sha256(source)
                if page_number < 1 or page_number > len(document):
                    raise ValueError(f"Página {page_number} fuera de 1..{len(document)}.")

                page = document[page_number - 1]
                matrix = pymupdf.Matrix(dpi / 72, dpi / 72).prerotate(rotation)
                pixmap = page.get_pixmap(matrix=matrix, alpha=False, colorspace=pymupdf.csRGB)
                image_path.parent.mkdir(parents=True, exist_ok=True)
                pixmap.save(image_path)
                rendered += 1

                if annotation_path.exists() and not force:
                    preserved_annotations += 1
                    continue
                annotation = {
                    "schemaVersion": 1,
                    "sampleId": sample_id,
                    "status": "draft",
                    "annotator": "",
                    "reviewer": "",
                    "reviewedAt": None,
                    "sourceFingerprint": source_hashes[source],
                    "image": {
                        "sha256": _sha256(image_path),
                        "width": pixmap.width,
                        "height": pixmap.height,
                        "dpi": dpi,
                        "rotation": rotation,
                    },
                    "instructions": (
                        "Transcribir literalmente. No corregir ortografía del documento. "
                        "Ajustar bbox por región y marcar ignore solo para contenido no evaluable."
                    ),
                    "regions": [{
                        "id": "region-001",
                        "type": "text",
                        "coordinateSpace": "normalized",
                        "bbox": {"x": 0, "y": 0, "width": 1, "height": 1},
                        "language": "spa",
                        "readingOrder": 1,
                        "text": "",
                        "ignore": False,
                        "cells": [],
                    }],
                }
                _write_json(annotation_path, annotation)
                drafts_created += 1
            except Exception as error:  # noqa: BLE001 - resumen controlado por muestra
                failures.append({"sampleId": sample_id or "(vacío)", "error": str(error)})
    finally:
        for document in documents.values():
            document.close()

    return {
        "manifest": manifest_path.name,
        "requestedSamples": len(samples),
        "rendered": rendered,
        "draftsCreated": drafts_created,
        "preservedAnnotations": preserved_annotations,
        "failures": failures,
        "privacy": "No se imprimieron rutas absolutas, imágenes ni transcripciones.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepara imágenes y borradores del corpus OCR privado.")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--force", action="store_true", help="Reemplaza anotaciones existentes.")
    parser.add_argument("--max-pages", type=int, default=None)
    arguments = parser.parse_args()
    result = prepare(arguments.manifest, arguments.force, arguments.max_pages)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result["failures"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
