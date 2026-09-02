"""Raster clean plates for editable PDF-to-Word reconstruction.

The page artwork is preserved as a compact PNG while selectable PDF words are
removed. Word can then place editable text over the clean plate without losing
logos, vector drawings, borders or page decorations.
"""

from __future__ import annotations

from typing import Any

import cv2
import numpy as np
import pymupdf


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        result = float(value)
        return result if np.isfinite(result) else fallback
    except (TypeError, ValueError):
        return fallback


def build_text_mask(
    words: list[dict[str, Any]],
    image_width: int,
    image_height: int,
    scale: float,
    padding_points: float = 1.25,
) -> np.ndarray:
    """Build a bounded antialias-safe mask from top-origin PDF word boxes."""
    mask = np.zeros((image_height, image_width), dtype=np.uint8)
    padding = max(1, int(round(max(0.0, padding_points) * scale)))
    for word in words:
        left = int(np.floor(_number(word.get("x0")) * scale)) - padding
        top = int(np.floor(_number(word.get("top")) * scale)) - padding
        right = int(np.ceil(_number(word.get("x1")) * scale)) + padding
        bottom = int(np.ceil(_number(word.get("bottom")) * scale)) + padding
        left = max(0, min(image_width, left))
        right = max(0, min(image_width, right))
        top = max(0, min(image_height, top))
        bottom = max(0, min(image_height, bottom))
        if right > left and bottom > top:
            cv2.rectangle(mask, (left, top), (right - 1, bottom - 1), 255, -1)
    return mask


def remove_text_from_rgb(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Remove glyphs while interpolating nearby paper/background colours."""
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("La imagen de fondo debe ser RGB.")
    if mask.shape != image.shape[:2]:
        raise ValueError("La máscara no coincide con la imagen.")
    if not np.any(mask):
        return image.copy()

    # TELEA preserves thin vector borders around the masked glyphs better than
    # replacing every box with white, and also works on coloured cover bands.
    bgr = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
    cleaned = cv2.inpaint(bgr, mask, 3, cv2.INPAINT_TELEA)
    return cv2.cvtColor(cleaned, cv2.COLOR_BGR2RGB)


def render_clean_background(
    pdf_content: bytes,
    page_index: int,
    *,
    dpi: int = 144,
    padding_points: float = 1.25,
) -> tuple[bytes, dict[str, Any]]:
    """Render one page after removing native text at PDF-object level.

    Removing text before rasterization is essential for dense tables. Pixel
    inpainting sees neighbouring cell borders as fill colours and can create
    dark wedges. PyMuPDF redactions remove only text objects while explicitly
    retaining vector line art and images, so the clean plate stays faithful.
    """
    if dpi < 96 or dpi > 180:
        raise ValueError("El DPI debe estar entre 96 y 180.")
    scale = dpi / 72.0
    document = pymupdf.open(stream=pdf_content, filetype="pdf")
    try:
        if page_index < 0 or page_index >= len(document):
            raise IndexError("La página solicitada no existe.")
        page = document[page_index]
        page_width = float(page.rect.width)
        page_height = float(page.rect.height)
        words = list(page.get_text("words", sort=False) or [])
        padding = max(0.0, float(padding_points))
        masked_area = 0.0
        for word in words:
            left, top, right, bottom = map(float, word[:4])
            rect = pymupdf.Rect(
                max(0.0, left - padding),
                max(0.0, top - padding),
                min(page_width, right + padding),
                min(page_height, bottom + padding),
            )
            if rect.is_empty:
                continue
            masked_area += rect.get_area()
            page.add_redact_annot(rect, fill=None, cross_out=False)
        if words:
            page.apply_redactions(
                images=pymupdf.PDF_REDACT_IMAGE_NONE,
                graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                text=pymupdf.PDF_REDACT_TEXT_REMOVE,
            )
        pixmap = page.get_pixmap(
            matrix=pymupdf.Matrix(scale, scale),
            colorspace=pymupdf.csRGB,
            alpha=False,
        )
        result = pixmap.tobytes("png")
        pixel_width = int(pixmap.width)
        pixel_height = int(pixmap.height)
    finally:
        document.close()

    return result, {
        "page_number": page_index + 1,
        "page_width": float(page_width),
        "page_height": float(page_height),
        "pixel_width": pixel_width,
        "pixel_height": pixel_height,
        "dpi": dpi,
        "removed_word_count": len(words),
        "masked_pixel_ratio": round(masked_area / max(1.0, page_width * page_height), 6),
        "strategy": "pdf-object-redaction",
    }
