"""Validacion visual local de documentos DOCX generados por NovaPDF.

LibreOffice se usa unicamente como renderizador de referencia: convierte el
DOCX a PDF dentro de un directorio temporal. Luego PDFium y OpenCV comparan la
geometria y la tinta de cada pagina con el PDF de origen.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Iterable

import cv2
import numpy as np
import pypdfium2 as pdfium


SOFFICE_CANDIDATES = (
    Path(r"C:\Program Files\LibreOffice\program\soffice.com"),
    Path(r"C:\Program Files\LibreOffice\program\soffice.exe"),
    Path(r"C:\Program Files (x86)\LibreOffice\program\soffice.com"),
    Path(r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"),
)
DEFAULT_TIMEOUT_SECONDS = int(os.getenv("NOVAPDF_DOCX_RENDER_TIMEOUT", "180"))


def find_soffice() -> Path | None:
    configured = os.getenv("NOVAPDF_SOFFICE_PATH", "").strip()
    if configured:
        path = Path(configured).expanduser()
        if path.is_file():
            return path.resolve()
    discovered = shutil.which("soffice")
    if discovered:
        return Path(discovered).resolve()
    return next((path for path in SOFFICE_CANDIDATES if path.is_file()), None)


def soffice_status() -> dict[str, Any]:
    executable = find_soffice()
    if executable is None:
        return {
            "available": False,
            "renderer": "libreoffice",
            "version": None,
            "path": None,
        }
    version = None
    try:
        completed = subprocess.run(
            [str(executable), "--headless", "--version"],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        version = (completed.stdout or completed.stderr).strip() or None
    except (OSError, subprocess.SubprocessError):
        pass
    return {
        "available": True,
        "renderer": "libreoffice",
        "version": version,
        "path": str(executable),
    }


def _write_document(path: Path, content: bytes) -> None:
    path.write_bytes(content)


def render_docx_to_pdf(
    docx_content: bytes,
    workspace: Path,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> bytes:
    executable = find_soffice()
    if executable is None:
        raise RuntimeError("LibreOffice no esta instalado o no se encontro soffice.exe.")

    input_path = workspace / "novapdf-output.docx"
    output_path = workspace / "novapdf-output.pdf"
    profile_path = workspace / "libreoffice-profile"
    profile_path.mkdir(parents=True, exist_ok=True)
    _write_document(input_path, docx_content)
    profile_uri = profile_path.resolve().as_uri()
    completed = subprocess.run(
        [
            str(executable),
            "--headless",
            "--nologo",
            "--nodefault",
            "--nolockcheck",
            "--nofirststartwizard",
            f"-env:UserInstallation={profile_uri}",
            "--convert-to",
            "pdf:writer_pdf_Export",
            "--outdir",
            str(workspace),
            str(input_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0 or not output_path.is_file():
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(
            f"LibreOffice no pudo volver a renderizar el DOCX{': ' + detail if detail else '.'}"
        )
    return output_path.read_bytes()


def _page_to_gray(document: pdfium.PdfDocument, page_index: int, dpi: int) -> np.ndarray:
    page = document[page_index]
    bitmap = page.render(scale=dpi / 72.0, rotation=0)
    image = bitmap.to_numpy()
    if image.ndim == 2:
        gray = image
    elif image.shape[2] == 4:
        gray = cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
    else:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    bitmap.close()
    page.close()
    return np.ascontiguousarray(gray)


def _ink_mask(gray: np.ndarray) -> np.ndarray:
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    _, mask = cv2.threshold(
        blurred,
        0,
        255,
        cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU,
    )
    return mask


def _safe_ratio(numerator: float, denominator: float, empty_value: float = 1.0) -> float:
    return float(numerator / denominator) if denominator > 0 else empty_value


def compare_page_images(
    reference_gray: np.ndarray,
    candidate_gray: np.ndarray,
    dpi: int,
) -> dict[str, Any]:
    reference_height, reference_width = reference_gray.shape[:2]
    candidate_height, candidate_width = candidate_gray.shape[:2]
    reference_aspect = reference_width / max(1, reference_height)
    candidate_aspect = candidate_width / max(1, candidate_height)
    aspect_delta = abs(candidate_aspect - reference_aspect) / max(0.001, reference_aspect)

    resized = cv2.resize(
        candidate_gray,
        (reference_width, reference_height),
        interpolation=cv2.INTER_AREA if candidate_width > reference_width else cv2.INTER_CUBIC,
    )
    reference_float = reference_gray.astype(np.float32) / 255.0
    candidate_float = resized.astype(np.float32) / 255.0
    shift_x = shift_y = 0.0
    if float(reference_float.std()) > 0.01 and float(candidate_float.std()) > 0.01:
        (shift_x, shift_y), _ = cv2.phaseCorrelate(reference_float, candidate_float)
        if abs(shift_x) > reference_width * 0.12 or abs(shift_y) > reference_height * 0.12:
            shift_x = shift_y = 0.0
    aligned = cv2.warpAffine(
        resized,
        np.float32([[1, 0, -shift_x], [0, 1, -shift_y]]),
        (reference_width, reference_height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=255,
    )

    pixel_similarity = 1.0 - float(
        np.mean(np.abs(reference_gray.astype(np.float32) - aligned.astype(np.float32))) / 255.0
    )
    reference_ink = _ink_mask(reference_gray)
    candidate_ink = _ink_mask(aligned)
    intersection = cv2.countNonZero(cv2.bitwise_and(reference_ink, candidate_ink))
    union = cv2.countNonZero(cv2.bitwise_or(reference_ink, candidate_ink))
    ink_iou = _safe_ratio(intersection, union)

    reference_edges = cv2.Canny(reference_gray, 80, 180)
    candidate_edges = cv2.Canny(aligned, 80, 180)
    tolerance = max(1, int(round(dpi / 90)))
    kernel = np.ones((tolerance * 2 + 1, tolerance * 2 + 1), dtype=np.uint8)
    reference_dilated = cv2.dilate(reference_edges, kernel)
    candidate_dilated = cv2.dilate(candidate_edges, kernel)
    reference_count = cv2.countNonZero(reference_edges)
    candidate_count = cv2.countNonZero(candidate_edges)
    reference_match = cv2.countNonZero(cv2.bitwise_and(reference_edges, candidate_dilated))
    candidate_match = cv2.countNonZero(cv2.bitwise_and(candidate_edges, reference_dilated))
    edge_recall = _safe_ratio(reference_match, reference_count)
    edge_precision = _safe_ratio(candidate_match, candidate_count)
    edge_similarity = _safe_ratio(
        2 * edge_precision * edge_recall,
        edge_precision + edge_recall,
    )

    shift_points_x = shift_x * 72.0 / dpi
    shift_points_y = shift_y * 72.0 / dpi
    geometry_penalty = min(0.18, aspect_delta * 1.8)
    visual_score = max(
        0.0,
        min(
            1.0,
            pixel_similarity * 0.20 + ink_iou * 0.45 + edge_similarity * 0.35 - geometry_penalty,
        ),
    )
    issues: list[str] = []
    if aspect_delta > 0.02:
        issues.append("page_geometry_changed")
    if max(abs(shift_points_x), abs(shift_points_y)) > 8:
        issues.append("content_shift")
    if ink_iou < 0.5:
        issues.append("low_content_overlap")
    if edge_similarity < 0.6:
        issues.append("layout_mismatch")

    return {
        "visual_score": round(visual_score * 100, 2),
        "pixel_similarity": round(pixel_similarity * 100, 2),
        "ink_overlap": round(ink_iou * 100, 2),
        "edge_similarity": round(edge_similarity * 100, 2),
        "horizontal_shift_points": round(shift_points_x, 2),
        "vertical_shift_points": round(shift_points_y, 2),
        "aspect_ratio_delta": round(aspect_delta * 100, 3),
        "issues": issues,
    }


def _unique_issues(pages: Iterable[dict[str, Any]], initial: Iterable[str]) -> list[str]:
    return list(dict.fromkeys([*initial, *(issue for page in pages for issue in page["issues"])]))


def compare_pdf_documents(
    source_pdf: bytes,
    rendered_pdf: bytes,
    source_page_indices: list[int],
    dpi: int = 120,
) -> dict[str, Any]:
    source = pdfium.PdfDocument(source_pdf)
    candidate = pdfium.PdfDocument(rendered_pdf)
    source_page_count = len(source_page_indices)
    candidate_page_count = len(candidate)
    compared_page_count = min(source_page_count, candidate_page_count)
    page_results: list[dict[str, Any]] = []
    issues: list[str] = []
    try:
        for output_index in range(compared_page_count):
            source_index = source_page_indices[output_index]
            if source_index < 0 or source_index >= len(source):
                continue
            reference = _page_to_gray(source, source_index, dpi)
            rendered = _page_to_gray(candidate, output_index, dpi)
            metrics = compare_page_images(reference, rendered, dpi)
            page_results.append(
                {
                    "source_page_number": source_index + 1,
                    "output_page_number": output_index + 1,
                    **metrics,
                }
            )
        if candidate_page_count > source_page_count:
            issues.append("extra_output_pages")
        elif candidate_page_count < source_page_count:
            issues.append("missing_output_pages")
        mean_score = (
            sum(page["visual_score"] for page in page_results) / len(page_results)
            if page_results
            else 0.0
        )
        page_count_factor = compared_page_count / max(1, source_page_count, candidate_page_count)
        overall_score = mean_score * page_count_factor
        if overall_score < 75:
            issues.append("visual_fidelity_below_target")
        return {
            "status": "completed",
            "renderer": "libreoffice",
            "dpi": dpi,
            "source_page_count": source_page_count,
            "output_page_count": candidate_page_count,
            "compared_page_count": len(page_results),
            "page_count_match": source_page_count == candidate_page_count,
            "visual_score": round(overall_score, 2),
            "target_score": 85,
            "passed": overall_score >= 85 and source_page_count == candidate_page_count,
            "issues": _unique_issues(page_results, issues),
            "pages": page_results,
        }
    finally:
        source.close()
        candidate.close()


def validate_docx_visual_quality(
    source_pdf: bytes,
    docx_content: bytes,
    source_page_indices: list[int],
    dpi: int = 120,
) -> dict[str, Any]:
    started_at = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="novapdf-quality-") as temporary:
        workspace = Path(temporary)
        rendered_pdf = render_docx_to_pdf(docx_content, workspace)
        result = compare_pdf_documents(
            source_pdf,
            rendered_pdf,
            source_page_indices,
            dpi=dpi,
        )
    result["duration_ms"] = round((time.perf_counter() - started_at) * 1000)
    result["renderer_version"] = soffice_status()["version"]
    return result
