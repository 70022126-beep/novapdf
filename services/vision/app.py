"""Servicio local de vision documental para NovaPDF.

Expone PP-StructureV3 mediante un contrato estable y reducido. El frontend nunca
necesita conocer la estructura interna de PaddleOCR y puede volver a su motor
integrado cuando este servicio no esta iniciado.
"""

from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
import cv2
import pypdfium2 as pdfium
import truststore
from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError

try:
    from .document_store import DocumentNotFoundError, DocumentStore
    from .device_selector import select_device
    from .docx_quality import soffice_status, validate_docx_visual_quality
    from .job_pool import BoundedJobPool, JobTimeoutError, QueueFullError
    from .native_background import render_clean_background
    from .native_docx import convert_native_pdf_to_docx, native_docx_status
    from .native_pdf import extract_native_document, parse_page_selection
    from .resource_budget import resource_budget
    from .session_security import SessionManager, is_allowed_origin
except ImportError:  # uvicorn iniciado desde services/vision
    from document_store import DocumentNotFoundError, DocumentStore
    from device_selector import select_device
    from docx_quality import soffice_status, validate_docx_visual_quality
    from job_pool import BoundedJobPool, JobTimeoutError, QueueFullError
    from native_background import render_clean_background
    from native_docx import convert_native_pdf_to_docx, native_docx_status
    from native_pdf import extract_native_document, parse_page_selection
    from resource_budget import resource_budget
    from session_security import SessionManager, is_allowed_origin


APP_VERSION = "1.17.0"
MAX_IMAGE_PIXELS = int(os.getenv("NOVAPDF_VISION_MAX_PIXELS", "50000000"))
MAX_PDF_BYTES = int(os.getenv("NOVAPDF_VISION_MAX_PDF_BYTES", str(256 * 1024 * 1024)))
MAX_DOCX_BYTES = int(os.getenv("NOVAPDF_QUALITY_MAX_DOCX_BYTES", str(256 * 1024 * 1024)))
MAX_NATIVE_PAGES = int(os.getenv("NOVAPDF_VISION_MAX_NATIVE_PAGES", "1000"))
MAX_QUALITY_PAGES = int(os.getenv("NOVAPDF_QUALITY_MAX_PAGES", "400"))
DEVICE_REQUESTED = os.getenv("NOVAPDF_VISION_DEVICE", "auto")
DEVICE_DECISION = select_device(DEVICE_REQUESTED)
DEVICE = DEVICE_DECISION.selected
LANGUAGE = os.getenv("NOVAPDF_VISION_LANGUAGE", "es")
PRELOAD_MODELS = os.getenv("NOVAPDF_VISION_PRELOAD", "true").lower() not in {
    "0",
    "false",
    "no",
}
SERVICE_ROOT = Path(__file__).resolve().parent
RUNTIME_ROOT = Path(
    os.getenv("NOVAPDF_VISION_RUNTIME", str(SERVICE_ROOT / ".runtime"))
).resolve()
DOCUMENT_STORE_BYTES = int(
    os.getenv("NOVAPDF_DOCUMENT_STORE_BYTES", str(2 * 1024 * 1024 * 1024))
)
DOCUMENT_TTL_SECONDS = int(os.getenv("NOVAPDF_DOCUMENT_TTL_SECONDS", str(24 * 60 * 60)))
OCR_WORKERS = int(os.getenv("NOVAPDF_OCR_WORKERS", "1"))
OCR_QUEUE_SIZE = int(os.getenv("NOVAPDF_OCR_QUEUE_SIZE", "4"))
BACKGROUND_WORKERS = int(os.getenv("NOVAPDF_BACKGROUND_WORKERS", "2"))
BACKGROUND_QUEUE_SIZE = int(os.getenv("NOVAPDF_BACKGROUND_QUEUE_SIZE", "8"))
OCR_JOB_TIMEOUT_SECONDS = float(os.getenv("NOVAPDF_OCR_JOB_TIMEOUT_SECONDS", "180"))
BACKGROUND_JOB_TIMEOUT_SECONDS = float(
    os.getenv("NOVAPDF_BACKGROUND_JOB_TIMEOUT_SECONDS", "90")
)
SESSION_AUTH_ENABLED = os.getenv("NOVAPDF_SESSION_AUTH", "true").lower() not in {
    "0", "false", "no"
}
SESSION_TTL_SECONDS = int(os.getenv("NOVAPDF_SESSION_TTL_SECONDS", "1800"))
MODEL_CACHE_ROOT = Path(
    os.getenv("NOVAPDF_VISION_MODEL_CACHE", str(SERVICE_ROOT / ".models"))
).resolve()
MODEL_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(MODEL_CACHE_ROOT / "paddlex"))
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "bos")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
truststore.inject_into_ssl()

_pipeline: Any | None = None
_pipeline_error: str | None = None
_pipeline_loading = False
_pipeline_lock = threading.Lock()
_device_fallback_reason: str | None = None
document_store = DocumentStore(
    RUNTIME_ROOT,
    maximum_bytes=DOCUMENT_STORE_BYTES,
    ttl_seconds=DOCUMENT_TTL_SECONDS,
)
ocr_jobs = BoundedJobPool("ocr", OCR_WORKERS, OCR_QUEUE_SIZE)
background_jobs = BoundedJobPool(
    "background", BACKGROUND_WORKERS, BACKGROUND_QUEUE_SIZE
)
session_manager = SessionManager(ttl_seconds=SESSION_TTL_SECONDS)


def _plain(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def _get_pipeline() -> Any:
    global _pipeline, _pipeline_error, DEVICE, _device_fallback_reason
    if _pipeline is not None:
        return _pipeline
    with _pipeline_lock:
        if _pipeline is not None:
            return _pipeline
        from paddleocr import PPStructureV3

        attempted_devices = [DEVICE]
        if DEVICE.startswith("gpu"):
            attempted_devices.append("cpu")
        last_error: Exception | None = None
        for candidate in attempted_devices:
            try:
                _pipeline = PPStructureV3(
                    lang=LANGUAGE,
                    device=candidate,
                    use_doc_orientation_classify=True,
                    use_doc_unwarping=True,
                    use_textline_orientation=True,
                    use_seal_recognition=True,
                    use_table_recognition=True,
                    use_formula_recognition=True,
                    use_region_detection=True,
                )
                if candidate != DEVICE:
                    _device_fallback_reason = (
                        f"{DEVICE} falló ({type(last_error).__name__}); se activó CPU."
                    )
                DEVICE = candidate
                _pipeline_error = None
                break
            except Exception as error:  # pragma: no cover - depende del runtime neuronal
                last_error = error
                _pipeline = None
        if _pipeline is None and last_error is not None:
            _pipeline_error = f"{type(last_error).__name__}: {last_error}"
            raise last_error
    return _pipeline


def _preload_pipeline() -> None:
    global _pipeline_loading
    _pipeline_loading = True
    try:
        _get_pipeline()
    except Exception:
        pass
    finally:
        _pipeline_loading = False


@asynccontextmanager
async def lifespan(_: FastAPI):
    if PRELOAD_MODELS and _pipeline is None and not _pipeline_loading:
        threading.Thread(
            target=_preload_pipeline,
            name="novapdf-vision-preload",
            daemon=True,
        ).start()
    yield


app = FastAPI(title="NovaPDF Neural Vision", version=APP_VERSION, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(127\.0\.0\.1|localhost)(:\d+)?",
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Accept", "Content-Type", "X-NovaPDF-Session"],
)


@app.middleware("http")
async def protect_local_api(request: Request, call_next):
    protected = request.url.path.startswith("/v1/") and request.url.path != "/v1/session"
    if (
        SESSION_AUTH_ENABLED
        and protected
        and request.method != "OPTIONS"
        and not session_manager.validate(request.headers.get("X-NovaPDF-Session"))
    ):
        response = JSONResponse(
            status_code=401,
            content={"detail": "Sesión local ausente o expirada."},
        )
        origin = request.headers.get("Origin")
        if origin and is_allowed_origin(origin):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        return response
    return await call_next(request)


def _bbox_from_polygon(polygon: Any) -> list[float] | None:
    points = _plain(polygon) or []
    if not points:
        return None
    if len(points) == 4 and not isinstance(points[0], list):
        return [float(value) for value in points]
    xs = [float(point[0]) for point in points if len(point) >= 2]
    ys = [float(point[1]) for point in points if len(point) >= 2]
    if not xs or not ys:
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


def _text_lines(result: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not result:
        return []
    texts = list(result.get("rec_texts") or [])
    scores = list(result.get("rec_scores") or [])
    boxes = list(result.get("rec_boxes") or result.get("rec_polys") or [])
    lines: list[dict[str, Any]] = []
    for index, text in enumerate(texts):
        value = str(text or "").strip()
        bbox = _bbox_from_polygon(boxes[index]) if index < len(boxes) else None
        if not value or not bbox:
            continue
        lines.append(
            {
                "id": f"ocr-line-{index + 1}",
                "text": value,
                "confidence": float(scores[index]) if index < len(scores) else 0.75,
                "bbox": bbox,
                "bbox_format": "xyxy",
            }
        )
    return lines


def _union_line_boxes(lines: list[dict[str, Any]]) -> list[float] | None:
    boxes = [line.get("bbox") for line in lines if line.get("bbox")]
    if not boxes:
        return None
    return [
        min(float(box[0]) for box in boxes),
        min(float(box[1]) for box in boxes),
        max(float(box[2]) for box in boxes),
        max(float(box[3]) for box in boxes),
    ]


def _box_overlap_ratio(first: list[float], second: list[float]) -> float:
    left = max(float(first[0]), float(second[0]))
    top = max(float(first[1]), float(second[1]))
    right = min(float(first[2]), float(second[2]))
    bottom = min(float(first[3]), float(second[3]))
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    first_area = max(1.0, (float(first[2]) - float(first[0])) *
                     (float(first[3]) - float(first[1])))
    second_area = max(1.0, (float(second[2]) - float(second[0])) *
                      (float(second[3]) - float(second[1])))
    return intersection / min(first_area, second_area)


def _visual_mark_regions(image: np.ndarray) -> list[dict[str, Any]]:
    height, width = image.shape[:2]
    page_area = max(1, width * height)
    hsv = cv2.cvtColor(image, cv2.COLOR_RGB2HSV)
    mask = cv2.inRange(
        hsv,
        np.array([0, 65, 0], dtype=np.uint8),
        np.array([179, 255, 242], dtype=np.uint8),
    )
    mask = cv2.morphologyEx(
        mask,
        cv2.MORPH_CLOSE,
        np.ones((3, 5), dtype=np.uint8),
        iterations=1,
    )
    mask = cv2.dilate(
        mask,
        np.ones((5, 11), dtype=np.uint8),
        iterations=2,
    )
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    regions: list[dict[str, Any]] = []
    for contour in contours:
        x, y, box_width, box_height = cv2.boundingRect(contour)
        area_ratio = box_width * box_height / page_area
        if box_width < width * 0.035 or box_height < height * 0.022:
            continue
        if area_ratio < 0.0015 or area_ratio > 0.12:
            continue
        density = cv2.countNonZero(
            mask[y:y + box_height, x:x + box_width]
        ) / max(1, box_width * box_height)
        center_y = (y + box_height / 2) / max(1, height)
        aspect_ratio = box_width / max(1, box_height)
        if center_y < 0.18:
            label = "graphic"
        elif center_y >= 0.45:
            label = "signature" if aspect_ratio >= 2.3 and density < 0.64 else "stamp"
        else:
            label = "graphic"
        regions.append(
            {
                "id": f"visual-mark-{len(regions) + 1}",
                "label": label,
                "confidence": min(0.94, 0.7 + density * 0.25),
                "bbox": [x, y, x + box_width, y + box_height],
                "bbox_format": "xyxy",
                "text": "",
                "reading_order": 10_000 + len(regions),
                "protected": True,
                "visual_metrics": {
                    "color_density": round(float(density), 4),
                    "area_ratio": round(float(area_ratio), 6),
                },
            }
        )
    return regions


def _table_payload(table: dict[str, Any] | None) -> dict[str, Any]:
    if not table:
        return {}
    table_lines = _text_lines(table.get("table_ocr_pred") or {})
    return {
        "html": str(table.get("pred_html") or ""),
        "cells": [
            {"bbox": _bbox_from_polygon(box), "bbox_format": "xyxy"}
            for box in table.get("cell_box_list") or []
        ],
        "text_lines": table_lines,
    }


def _normalize_result(raw: dict[str, Any], width: int, height: int) -> dict[str, Any]:
    if isinstance(raw.get("res"), dict):
        raw = raw["res"]
    parsing = list(raw.get("parsing_res_list") or [])
    tables = list(raw.get("table_res_list") or [])
    formulas = list(raw.get("formula_res_list") or [])
    seals = list(raw.get("seal_res_list") or [])
    table_index = 0
    formula_index = 0
    regions: list[dict[str, Any]] = []

    for index, block in enumerate(parsing):
        label = str(block.get("block_label") or "text")
        normalized_label = label.lower().replace("-", "_")
        region: dict[str, Any] = {
            "id": f"paddle-block-{block.get('block_id', index)}",
            "label": label,
            "confidence": float(block.get("score") or block.get("confidence") or 0.85),
            "bbox": _plain(block.get("block_bbox") or []),
            "bbox_format": "xyxy",
            "text": str(block.get("block_content") or ""),
            "reading_order": int(block.get("block_order") or index),
        }
        if "table" in normalized_label and table_index < len(tables):
            region.update(_table_payload(tables[table_index]))
            table_index += 1
        if normalized_label in {"formula", "equation", "math"} and formula_index < len(formulas):
            formula = formulas[formula_index]
            region["latex"] = str(formula.get("rec_formula") or region["text"])
            formula_index += 1
        regions.append(region)

    for index in range(formula_index, len(formulas)):
        formula = formulas[index]
        regions.append(
            {
                "id": f"paddle-formula-{index + 1}",
                "label": "formula",
                "confidence": float(formula.get("score") or 0.85),
                "bbox": _bbox_from_polygon(formula.get("rec_polys")) or [],
                "bbox_format": "xyxy",
                "latex": str(formula.get("rec_formula") or ""),
                "reading_order": len(regions),
            }
        )

    for index, seal in enumerate(seals):
        seal_lines = _text_lines(seal)
        bbox = _union_line_boxes(seal_lines)
        if not bbox:
            seal_boxes = [
                _bbox_from_polygon(box)
                for box in seal.get("dt_polys") or []
            ]
            seal_boxes = [box for box in seal_boxes if box]
            bbox = _union_line_boxes(
                [{"bbox": box} for box in seal_boxes]
            )
        if not bbox:
            continue
        confidence = (
            sum(float(line["confidence"]) for line in seal_lines) / len(seal_lines)
            if seal_lines
            else 0.78
        )
        regions.append(
            {
                "id": f"paddle-seal-{index + 1}",
                "label": "seal",
                "confidence": confidence,
                "bbox": bbox,
                "bbox_format": "xyxy",
                "text": " ".join(line["text"] for line in seal_lines),
                "text_lines": seal_lines,
                "reading_order": len(regions),
                "protected": True,
            }
        )

    return {
        "provider": "pp-structure-v3",
        "model": "PP-StructureV3",
        "version": APP_VERSION,
        "image_width": width,
        "image_height": height,
        "regions": regions,
        "text_lines": _text_lines(raw.get("overall_ocr_res") or {}),
        "orientation": int(
            (raw.get("doc_preprocessor_res") or {}).get("angle") or 0
        ),
    }


@app.post("/v1/session")
def create_local_session(request: Request) -> dict[str, Any]:
    if not is_allowed_origin(request.headers.get("Origin")):
        raise HTTPException(status_code=403, detail="Origen no autorizado.")
    return {**session_manager.issue(), "version": APP_VERSION}


@app.get("/health")
def health(load: bool = False) -> dict[str, Any]:
    if load and _pipeline is None:
        try:
            _get_pipeline()
        except Exception:
            pass
    document_renderer = soffice_status()
    native_docx_converter = native_docx_status()
    return {
        "status": (
            "ready" if _pipeline is not None
            else "loading" if _pipeline_loading
            else "degraded" if _pipeline_error
            else "idle"
        ),
        "version": APP_VERSION,
        "device": DEVICE,
        "device_selection": {
            **DEVICE_DECISION.as_dict(),
            "active": DEVICE,
            "fallback_reason": _device_fallback_reason,
        },
        "language": LANGUAGE,
        "model_loaded": _pipeline is not None,
        "model_loading": _pipeline_loading,
        "native_pdf_extractor": "pdfplumber",
        "native_clean_background": "pymupdf-object-redaction",
        "native_docx_converter": native_docx_converter,
        "docx_visual_validator": (
            "ready" if document_renderer["available"] else "unavailable"
        ),
        "document_renderer": document_renderer,
        "queues": {
            "ocr": ocr_jobs.stats(),
            "background": background_jobs.stats(),
        },
        "document_store": document_store.stats(),
        "resource_budget": resource_budget(),
        "session_auth": {
            "enabled": SESSION_AUTH_ENABLED,
            **session_manager.stats(),
        },
        "error": _pipeline_error,
    }


def _read_pdf_upload(pdf: UploadFile) -> bytes:
    content = pdf.file.read(MAX_PDF_BYTES + 1)
    if not content or len(content) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="El PDF supera el limite permitido.")
    if not content.startswith(b"%PDF-"):
        raise HTTPException(status_code=400, detail="Archivo PDF no valido.")
    return content


def _pdf_page_count(content: bytes) -> int:
    try:
        document = pdfium.PdfDocument(content)
        page_total = len(document)
        document.close()
        return page_total
    except Exception as error:
        raise HTTPException(status_code=400, detail="No se pudo abrir el PDF de origen.") from error


def _registered_pdf(document_id: str) -> bytes:
    try:
        return document_store.read(document_id)
    except DocumentNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/v1/documents")
def register_document(pdf: UploadFile = File(...)) -> dict[str, Any]:
    """Registra el PDF una sola vez y devuelve un id de contenido estable."""
    content = _read_pdf_upload(pdf)
    metadata = document_store.register(
        content,
        filename=pdf.filename or "document.pdf",
        page_count=_pdf_page_count(content),
    )
    return {**metadata, "version": APP_VERSION}


@app.delete("/v1/documents/{document_id}")
def delete_document(document_id: str) -> dict[str, Any]:
    try:
        deleted = document_store.delete(document_id)
    except DocumentNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return {"document_id": document_id, "deleted": deleted, "version": APP_VERSION}


@app.post("/v1/convert/native-docx")
def native_docx(
    pdf: UploadFile = File(...),
    pages: str = Form("all"),
) -> Response:
    content = _read_pdf_upload(pdf)
    if not native_docx_status()["available"]:
        raise HTTPException(status_code=503, detail="El candidato DOCX nativo no esta instalado.")

    page_total = _pdf_page_count(content)

    page_indices = parse_page_selection(pages, page_total, MAX_NATIVE_PAGES)
    if not page_indices:
        raise HTTPException(status_code=400, detail="El rango de paginas esta vacio.")
    try:
        result, metadata = convert_native_pdf_to_docx(content, page_indices)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(
            status_code=422,
            detail=f"No se pudo generar el candidato DOCX: {type(error).__name__}",
        ) from error

    return Response(
        content=result,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "X-NovaPDF-Converter": str(metadata.get("converter") or "pdf2docx"),
            "X-NovaPDF-Converter-Version": str(metadata.get("version") or "unknown"),
            "X-NovaPDF-Duration-Ms": str(metadata.get("duration_ms") or 0),
        },
    )


def _native_document_result(
    content: bytes,
    pages: str = "all",
    include_tables: bool = True,
    include_fonts: bool = True,
    font_scope: str = "document",
) -> dict[str, Any]:
    try:
        result = extract_native_document(
            content,
            pages=pages,
            include_tables=include_tables,
            include_fonts=include_fonts,
            font_scope="document" if font_scope == "document" else "selection",
            maximum_pages=MAX_NATIVE_PAGES,
        )
        return {**result, "version": APP_VERSION}
    except Exception as error:
        raise HTTPException(
            status_code=422,
            detail=f"No se pudo analizar la estructura PDF: {type(error).__name__}",
        ) from error


@app.post("/v1/native-document")
def native_document(
    pdf: UploadFile = File(...),
    pages: str = Form("all"),
    include_tables: bool = Form(True),
    include_fonts: bool = Form(True),
    font_scope: str = Form("document"),
) -> dict[str, Any]:
    return _native_document_result(
        _read_pdf_upload(pdf), pages, include_tables, include_fonts, font_scope
    )


@app.post("/v1/documents/{document_id}/native-document")
def registered_native_document(
    document_id: str,
    pages: str = Form("all"),
    include_tables: bool = Form(True),
    include_fonts: bool = Form(True),
    font_scope: str = Form("document"),
) -> dict[str, Any]:
    return _native_document_result(
        _registered_pdf(document_id), pages, include_tables, include_fonts, font_scope
    )


def _native_background_response(
    content: bytes,
    page: int,
    dpi: int,
    padding_points: float,
) -> Response:
    if page < 1:
        raise HTTPException(status_code=400, detail="La pagina debe ser mayor que cero.")
    if dpi < 96 or dpi > 180:
        raise HTTPException(status_code=400, detail="El DPI debe estar entre 96 y 180.")
    if padding_points < 0 or padding_points > 4:
        raise HTTPException(status_code=400, detail="El margen de limpieza no es valido.")
    try:
        result, metadata = background_jobs.run(
            render_clean_background,
            content,
            page - 1,
            dpi=dpi,
            padding_points=padding_points,
            timeout_seconds=BACKGROUND_JOB_TIMEOUT_SECONDS,
        )
    except QueueFullError as error:
        raise HTTPException(status_code=429, detail=str(error)) from error
    except JobTimeoutError as error:
        raise HTTPException(status_code=504, detail=str(error)) from error
    except IndexError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(
            status_code=422,
            detail=f"No se pudo crear el fondo editable: {type(error).__name__}",
        ) from error

    return Response(
        content=result,
        media_type="image/png",
        headers={
            "X-NovaPDF-Version": APP_VERSION,
            "X-NovaPDF-Page-Width": str(metadata["page_width"]),
            "X-NovaPDF-Page-Height": str(metadata["page_height"]),
            "X-NovaPDF-Pixel-Width": str(metadata["pixel_width"]),
            "X-NovaPDF-Pixel-Height": str(metadata["pixel_height"]),
            "X-NovaPDF-Removed-Words": str(metadata["removed_word_count"]),
            "X-NovaPDF-Masked-Ratio": str(metadata["masked_pixel_ratio"]),
            "X-NovaPDF-Background-Strategy": str(metadata["strategy"]),
        },
    )


@app.post("/v1/native-background")
def native_background(
    pdf: UploadFile = File(...),
    page: int = Form(...),
    dpi: int = Form(144),
    padding_points: float = Form(1.25),
) -> Response:
    """Compatibilidad: recibe el PDF completo cuando el cliente no usa registro."""
    return _native_background_response(
        _read_pdf_upload(pdf), page, dpi, padding_points
    )


@app.post("/v1/documents/{document_id}/native-background")
def registered_native_background(
    document_id: str,
    page: int = Form(...),
    dpi: int = Form(144),
    padding_points: float = Form(1.25),
) -> Response:
    return _native_background_response(
        _registered_pdf(document_id), page, dpi, padding_points
    )


@app.post("/v1/quality/docx")
def docx_quality(
    pdf: UploadFile = File(...),
    docx: UploadFile = File(...),
    pages: str = Form("all"),
    dpi: int = Form(120),
) -> dict[str, Any]:
    pdf_content = pdf.file.read(MAX_PDF_BYTES + 1)
    docx_content = docx.file.read(MAX_DOCX_BYTES + 1)
    if not pdf_content or len(pdf_content) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="El PDF supera el limite permitido.")
    if not docx_content or len(docx_content) > MAX_DOCX_BYTES:
        raise HTTPException(status_code=413, detail="El DOCX supera el limite permitido.")
    if not pdf_content.startswith(b"%PDF-"):
        raise HTTPException(status_code=400, detail="Archivo PDF no valido.")
    if not docx_content.startswith(b"PK"):
        raise HTTPException(status_code=400, detail="Archivo DOCX no valido.")
    if dpi < 72 or dpi > 180:
        raise HTTPException(status_code=400, detail="El DPI debe estar entre 72 y 180.")

    try:
        source_document = pdfium.PdfDocument(pdf_content)
        source_page_total = len(source_document)
        source_document.close()
    except Exception as error:
        raise HTTPException(status_code=400, detail="No se pudo abrir el PDF de origen.") from error

    source_page_indices = parse_page_selection(pages, source_page_total)
    if not source_page_indices:
        raise HTTPException(status_code=400, detail="El rango de paginas esta vacio.")
    if len(source_page_indices) > MAX_QUALITY_PAGES:
        raise HTTPException(status_code=413, detail="Demasiadas paginas para validar.")
    try:
        result = validate_docx_visual_quality(
            pdf_content,
            docx_content,
            source_page_indices,
            dpi=dpi,
        )
        return {**result, "version": APP_VERSION}
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(
            status_code=422,
            detail=f"No se pudo validar visualmente el DOCX: {type(error).__name__}",
        ) from error


@app.post("/v1/layout")
def layout(
    image: UploadFile = File(...),
    page_width: float = Form(...),
    page_height: float = Form(...),
    coordinate_space: str = Form("page-points"),
) -> dict[str, Any]:
    del page_width, page_height, coordinate_space
    try:
        content = image.file.read()
        pil_image = Image.open(BytesIO(content)).convert("RGB")
    except (UnidentifiedImageError, OSError) as error:
        raise HTTPException(status_code=400, detail="Imagen de pagina no valida.") from error
    if pil_image.width * pil_image.height > MAX_IMAGE_PIXELS:
        raise HTTPException(status_code=413, detail="La pagina supera el limite de pixeles.")

    try:
        def predict() -> Any:
            pipeline = _get_pipeline()
            with _pipeline_lock:
                results = pipeline.predict(
                    np.asarray(pil_image),
                    use_doc_orientation_classify=True,
                    use_doc_unwarping=True,
                    use_textline_orientation=True,
                    use_seal_recognition=True,
                    use_table_recognition=True,
                    use_formula_recognition=True,
                    use_region_detection=True,
                    format_block_content=True,
                    use_wired_table_cells_trans_to_html=True,
                    use_wireless_table_cells_trans_to_html=True,
                    use_ocr_results_with_table_cells=True,
                )
                return next(iter(results), None)

        result = ocr_jobs.run(
            predict,
            timeout_seconds=OCR_JOB_TIMEOUT_SECONDS,
        )
        if result is None:
            raise RuntimeError("El modelo no devolvio resultados.")
        raw = _plain(result.json)
        normalized = _normalize_result(raw, pil_image.width, pil_image.height)
        visual_marks = _visual_mark_regions(np.asarray(pil_image))
        for visual_mark in visual_marks:
            if any(
                _box_overlap_ratio(visual_mark["bbox"], region.get("bbox") or [0, 0, 0, 0])
                >= 0.78
                for region in normalized["regions"]
                if region.get("label") in {
                    "image",
                    "figure",
                    "photo",
                    "seal",
                    "stamp",
                    "signature",
                }
            ):
                continue
            normalized["regions"].append(visual_mark)
        normalized["visual_mark_count"] = len(
            [region for region in normalized["regions"] if region["id"].startswith("visual-mark-")]
        )
        return normalized
    except QueueFullError as error:
        raise HTTPException(status_code=429, detail=str(error)) from error
    except JobTimeoutError as error:
        raise HTTPException(status_code=504, detail=str(error)) from error
    except HTTPException:
        raise
    except Exception as error:  # pragma: no cover - depende del runtime neuronal
        raise HTTPException(
            status_code=503,
            detail=f"Proveedor neuronal no disponible: {type(error).__name__}",
        ) from error
