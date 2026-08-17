"""Extraccion estructural de PDFs digitales para NovaPDF.

Este modulo complementa PDF.js con un segundo motor independiente. Conserva
geometria, tipografia, color, objetos vectoriales y tablas sin involucrar el
pipeline neuronal, por lo que tambien sirve como verificacion cruzada.
"""

from __future__ import annotations

import math
import re
from io import BytesIO
from typing import Any


def parse_page_selection(value: str, total_pages: int, maximum_pages: int = 400) -> list[int]:
    raw = str(value or "all").strip().lower()
    if raw in {"", "all", "todas", "todo"}:
        return list(range(min(total_pages, maximum_pages)))

    selected: set[int] = set()
    for token in raw.split(","):
        part = token.strip()
        if not part:
            continue
        if "-" in part:
            first_raw, last_raw = part.split("-", 1)
            if not first_raw.strip().isdigit() or not last_raw.strip().isdigit():
                continue
            first = int(first_raw)
            last = int(last_raw)
            if first > last:
                first, last = last, first
            for page_number in range(first, last + 1):
                if 1 <= page_number <= total_pages:
                    selected.add(page_number - 1)
                if len(selected) >= maximum_pages:
                    break
        elif part.isdigit():
            page_number = int(part)
            if 1 <= page_number <= total_pages:
                selected.add(page_number - 1)
        if len(selected) >= maximum_pages:
            break
    return sorted(selected)


def _number(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else fallback
    except (TypeError, ValueError):
        return fallback


def _bbox(item: dict[str, Any] | None) -> list[float] | None:
    if not item:
        return None
    x0 = _number(item.get("x0"))
    x1 = _number(item.get("x1"), x0)
    top = _number(item.get("top", item.get("y0")))
    bottom = _number(item.get("bottom", item.get("y1")), top)
    if x1 <= x0 or bottom <= top:
        return None
    return [x0, top, x1, bottom]


def _color(value: Any) -> str | None:
    if value is None:
        return None
    channels = list(value) if isinstance(value, (list, tuple)) else [value]
    if not channels:
        return None
    numeric = [_number(channel) for channel in channels]
    if len(numeric) == 1:
        rgb = [numeric[0]] * 3
    elif len(numeric) >= 4:
        cyan, magenta, yellow, black = numeric[:4]
        rgb = [
            1 - min(1, cyan + black),
            1 - min(1, magenta + black),
            1 - min(1, yellow + black),
        ]
    else:
        rgb = (numeric + [numeric[-1]] * 3)[:3]
    if max(rgb, default=0) <= 1.01:
        rgb = [channel * 255 for channel in rgb]
    return "#" + "".join(f"{max(0, min(255, round(channel))):02X}" for channel in rgb)


def _rotation(char: dict[str, Any] | None) -> float:
    matrix = list((char or {}).get("matrix") or [])
    if len(matrix) < 2:
        return 0.0 if (char or {}).get("upright", True) else 90.0
    return round(math.degrees(math.atan2(_number(matrix[1]), _number(matrix[0], 1))), 2)


def _character_spacing(chars: list[dict[str, Any]]) -> float:
    gaps = []
    for first, second in zip(chars, chars[1:]):
        gap = _number(second.get("x0")) - _number(first.get("x1"))
        if -2 <= gap <= 12:
            gaps.append(gap)
    if not gaps:
        return 0.0
    gaps.sort()
    return round(gaps[len(gaps) // 2], 3)


def normalize_word(word: dict[str, Any], index: int) -> dict[str, Any] | None:
    text = re.sub(r"\s+", " ", str(word.get("text") or "")).strip()
    box = _bbox(word)
    if not text or not box:
        return None
    chars = list(word.get("chars") or [])
    reference = chars[0] if chars else word
    font_name = str(reference.get("fontname") or word.get("fontname") or "Arial")
    font_size = _number(reference.get("size", word.get("size")), box[3] - box[1])
    descriptor = font_name.lower()
    color = _color(reference.get("non_stroking_color"))
    return {
        "id": f"native-word-{index + 1}",
        "text": text,
        "bbox": box,
        "bbox_format": "xyxy",
        "font_name": font_name,
        "font_size": font_size,
        "bold": bool(re.search(r"bold|black|heavy|semibold|demi", descriptor)),
        "italic": bool(re.search(r"italic|oblique|kursiv", descriptor)),
        "color": color,
        "stroking_color": _color(reference.get("stroking_color")),
        "rotation": _rotation(reference),
        "upright": bool(reference.get("upright", True)),
        "direction": str(word.get("direction") or "ltr"),
        "character_spacing": _character_spacing(chars),
        "embedded_font": bool(re.match(r"^[A-Z]{6}\+", font_name)),
        "confidence": 1.0,
        "source_order": index,
    }


def _shape_payload(item: dict[str, Any], index: int, kind: str) -> dict[str, Any] | None:
    box = _bbox(item)
    if not box:
        return None
    return {
        "id": f"{kind}-{index + 1}",
        "type": kind,
        "bbox": box,
        "bbox_format": "xyxy",
        "line_width": _number(item.get("linewidth", item.get("line_width")), 1),
        "stroke": _color(item.get("stroking_color")),
        "fill": _color(item.get("non_stroking_color")),
    }


def _cell_text(page: Any, cell: Any) -> str:
    if not cell:
        return ""
    try:
        return re.sub(r"\s+", " ", page.crop(cell).extract_text() or "").strip()
    except Exception:
        return ""


def _table_payload(page: Any, table: Any, index: int, source: str) -> dict[str, Any] | None:
    table_box = list(table.bbox or [])
    if len(table_box) != 4:
        return None
    extracted_rows = table.extract() or []
    all_cells = [list(cell) for cell in (table.cells or []) if cell]
    x_coordinates = sorted({round(_number(cell[0]), 3) for cell in all_cells})
    if all_cells:
        x_coordinates.append(round(max(_number(cell[2]) for cell in all_cells), 3))
    x_coordinates = sorted(set(x_coordinates))
    raw_rows = []
    normalized_rows = []

    for row_index, row in enumerate(table.rows or []):
        row_values = list(extracted_rows[row_index]) if row_index < len(extracted_rows) else []
        raw_cells = []
        normalized_values = []
        for column_index, cell in enumerate(row.cells or []):
            text = str(row_values[column_index] or "").strip() if column_index < len(row_values) else ""
            normalized_values.append(text)
            if not cell:
                continue
            box = list(cell)
            start = min(
                range(len(x_coordinates)),
                key=lambda position: abs(x_coordinates[position] - _number(box[0])),
            ) if x_coordinates else column_index
            end = min(
                range(len(x_coordinates)),
                key=lambda position: abs(x_coordinates[position] - _number(box[2])),
            ) if x_coordinates else column_index + 1
            raw_cells.append(
                {
                    "text": text or _cell_text(page, cell),
                    "bbox": {
                        "x": _number(box[0]),
                        "y": _number(box[1]),
                        "width": max(0.0, _number(box[2]) - _number(box[0])),
                        "height": max(0.0, _number(box[3]) - _number(box[1])),
                    },
                    "rowSpan": 1,
                    "columnSpan": max(1, end - start),
                }
            )
        if any(normalized_values):
            normalized_rows.append(normalized_values)
            raw_rows.append({"cells": raw_cells})

    if len(normalized_rows) < 2 or max((len(row) for row in normalized_rows), default=0) < 2:
        return None
    return {
        "id": f"pdfplumber-table-{index + 1}",
        "bbox": table_box,
        "bbox_format": "xyxy",
        "rows": normalized_rows,
        "column_anchors": x_coordinates[:-1],
        "confidence": 0.96 if source == "lines" else 0.84,
        "structural_score": 96 if source == "lines" else 84,
        "source": f"pdfplumber-{source}",
        "structure": {"raw": raw_rows, "column_anchors": x_coordinates[:-1]},
    }


def _extract_tables(page: Any) -> list[dict[str, Any]]:
    settings = {
        "vertical_strategy": "lines",
        "horizontal_strategy": "lines",
        "snap_tolerance": 3,
        "join_tolerance": 3,
        "intersection_tolerance": 4,
    }
    tables = list(page.find_tables(table_settings=settings) or [])
    source = "lines"
    if not tables and len(page.chars or []) >= 20:
        source = "text"
        text_settings = {
            "vertical_strategy": "text",
            "horizontal_strategy": "text",
            "min_words_vertical": 3,
            "min_words_horizontal": 2,
            "text_x_tolerance": 2,
            "text_y_tolerance": 3,
            "intersection_tolerance": 5,
        }
        tables = list(page.find_tables(table_settings=text_settings) or [])
    return [
        payload
        for index, table in enumerate(tables)
        if (payload := _table_payload(page, table, index, source)) is not None
    ]


def extract_page(page: Any, page_number: int, include_tables: bool = True) -> dict[str, Any]:
    words_raw = page.extract_words(
        x_tolerance=2,
        y_tolerance=3,
        keep_blank_chars=False,
        use_text_flow=False,
        extra_attrs=["fontname", "size", "upright"],
        return_chars=True,
    )
    words = [
        normalized
        for index, word in enumerate(words_raw or [])
        if (normalized := normalize_word(word, index)) is not None
    ]
    lines = [
        payload
        for index, item in enumerate(page.lines or [])
        if (payload := _shape_payload(item, index, "line")) is not None
    ]
    rectangles = [
        payload
        for index, item in enumerate(page.rects or [])
        if (payload := _shape_payload(item, index, "rectangle")) is not None
    ]
    curves = [
        payload
        for index, item in enumerate(page.curves or [])
        if (payload := _shape_payload(item, index, "curve")) is not None
    ]
    images = [
        {
            "id": f"native-image-{index + 1}",
            "bbox": box,
            "bbox_format": "xyxy",
            "name": str(item.get("name") or ""),
            "width": int(_number(item.get("srcsize", [0, 0])[0] if item.get("srcsize") else 0)),
            "height": int(_number(item.get("srcsize", [0, 0])[1] if item.get("srcsize") else 0)),
        }
        for index, item in enumerate(page.images or [])
        if (box := _bbox(item)) is not None
    ]
    annotations = []
    for index, item in enumerate(page.annots or []):
        box = _bbox(item) or list(item.get("rect") or [])
        annotations.append(
            {
                "id": f"annotation-{index + 1}",
                "subtype": str(item.get("subtype") or item.get("type") or "unknown"),
                "bbox": box if len(box) == 4 else None,
                "bbox_format": "xyxy",
                "contents": str(item.get("contents") or ""),
            }
        )
    tables = _extract_tables(page) if include_tables else []
    return {
        "page_number": page_number,
        "width": _number(page.width),
        "height": _number(page.height),
        "rotation": int(_number(getattr(page, "rotation", 0))),
        "words": words,
        "tables": tables,
        "lines": lines,
        "rectangles": rectangles,
        "curves": curves,
        "images": images,
        "annotations": annotations,
        "statistics": {
            "character_count": sum(len(word["text"].replace(" ", "")) for word in words),
            "word_count": len(words),
            "table_count": len(tables),
            "vector_object_count": len(lines) + len(rectangles) + len(curves),
            "image_count": len(images),
            "annotation_count": len(annotations),
        },
    }


def extract_native_document(
    content: bytes,
    pages: str = "all",
    include_tables: bool = True,
    maximum_pages: int = 400,
) -> dict[str, Any]:
    import pdfplumber

    with pdfplumber.open(BytesIO(content)) as document:
        selected = parse_page_selection(pages, len(document.pages), maximum_pages)
        results = [
            extract_page(document.pages[index], index + 1, include_tables)
            for index in selected
        ]
        return {
            "provider": "pdfplumber",
            "page_count": len(document.pages),
            "processed_page_count": len(results),
            "pages": results,
        }
