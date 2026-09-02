"""Extraccion estructural de PDFs digitales para NovaPDF.

Este modulo complementa PDF.js con un segundo motor independiente. Conserva
geometria, tipografia, color, objetos vectoriales y tablas sin involucrar el
pipeline neuronal, por lo que tambien sirve como verificacion cruzada.
"""

from __future__ import annotations

import base64
import hashlib
import math
import re
from io import BytesIO
from typing import Any


def _font_family_name(data: bytes, fallback: str) -> str:
    try:
        from fontTools.ttLib import TTFont

        font = TTFont(BytesIO(data), lazy=True)
        try:
            names = font["name"].names
            for name_id in (16, 1):
                for record in names:
                    if record.nameID == name_id:
                        value = str(record.toUnicode() or "").strip()
                        if value:
                            return value
        finally:
            font.close()
    except Exception:
        pass
    return re.sub(r"^[A-Z]{6}\+", "", str(fallback or "Embedded Font")).strip()


def _font_style_name(data: bytes) -> str:
    try:
        from fontTools.ttLib import TTFont

        font = TTFont(BytesIO(data), lazy=True)
        try:
            names = font["name"].names
            for name_id in (17, 2):
                for record in names:
                    if record.nameID == name_id:
                        value = str(record.toUnicode() or "").strip()
                        if value:
                            return value
        finally:
            font.close()
    except Exception:
        pass
    return "Regular"


def _font_allows_editable_embedding(data: bytes) -> bool:
    """Honor the OpenType OS/2 embedding permissions before exporting."""
    try:
        from fontTools.ttLib import TTFont

        font = TTFont(BytesIO(data), lazy=True)
        try:
            fs_type = int(getattr(font.get("OS/2"), "fsType", 0) or 0)
        finally:
            font.close()
    except Exception:
        return False
    if fs_type == 0:
        return True
    if fs_type & 0x0002 or fs_type & 0x0200:
        return False
    return bool(fs_type & 0x0008)


def _merge_font_subsets(fonts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge compatible PDF subsets so Word receives the complete glyph set."""
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    for font in fonts:
        key = (
            str(font.get("name") or "").casefold(),
            str(font.get("style") or "Regular").casefold(),
            str(font.get("extension") or "").lower(),
        )
        grouped.setdefault(key, []).append(font)

    merged_fonts: list[dict[str, Any]] = []
    for (_name, _style, extension), candidates in grouped.items():
        if len(candidates) < 2 or extension != "ttf":
            merged_fonts.extend(candidates)
            continue
        try:
            from fontTools.merge import Merger

            merged = Merger().merge([BytesIO(font["data"]) for font in candidates])
            output = BytesIO()
            merged.save(output)
            merged.close()
            data = output.getvalue()
            if not data or len(data) > 2 * 1024 * 1024 or not _font_allows_editable_embedding(data):
                raise ValueError("Merged font is not safe to embed.")
            first = candidates[0]
            merged_fonts.append({
                **first,
                "data": data,
                "source_name": ",".join(dict.fromkeys(
                    str(font.get("source_name") or "") for font in candidates
                )),
                "merged_subset_count": len(candidates),
            })
        except Exception:
            merged_fonts.extend(candidates)
    return merged_fonts


def _extract_embeddable_fonts(
    content: bytes,
    page_indices: list[int],
    maximum_total_bytes: int = 8 * 1024 * 1024,
) -> list[dict[str, Any]]:
    try:
        import pymupdf
    except Exception:
        return []

    fonts: list[dict[str, Any]] = []
    seen: set[str] = set()
    total_bytes = 0
    document = pymupdf.open(stream=content, filetype="pdf")
    try:
        xrefs = sorted({
            int(font[0])
            for page_index in page_indices
            for font in document.get_page_fonts(page_index, full=True)
            if font and int(font[0]) > 0
        })
        for xref in xrefs:
            try:
                source_name, extension, _font_type, data = document.extract_font(xref)
            except Exception:
                continue
            extension = str(extension or "").lower()
            data = bytes(data or b"")
            if extension not in {"ttf", "otf"} or not data or len(data) > 2 * 1024 * 1024:
                continue
            digest = hashlib.sha256(data).hexdigest()
            if digest in seen or total_bytes + len(data) > maximum_total_bytes:
                continue
            if not _font_allows_editable_embedding(data):
                continue
            seen.add(digest)
            total_bytes += len(data)
            fonts.append({
                "name": _font_family_name(data, source_name),
                "source_name": source_name,
                "extension": extension,
                "style": _font_style_name(data),
                "data": data,
                "embedding": "editable",
            })
    finally:
        document.close()
    result = []
    for font in _merge_font_subsets(fonts):
        data = bytes(font.pop("data", b""))
        if not data:
            continue
        result.append({
            **font,
            "sha256": hashlib.sha256(data).hexdigest(),
            "data_base64": base64.b64encode(data).decode("ascii"),
            "byte_length": len(data),
        })
    return result


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
    if not box and kind == "line":
        # Las decoraciones PDF (subrayado/tachado) suelen ser segmentos sin
        # altura o anchura. No deben descartarse como cajas degeneradas: se
        # normalizan al grosor real del trazo para poder asociarlas al texto.
        x0 = _number(item.get("x0"))
        x1 = _number(item.get("x1"), x0)
        top = _number(item.get("top", item.get("y0")))
        bottom = _number(item.get("bottom", item.get("y1")), top)
        line_width = max(0.1, _number(item.get("linewidth", item.get("line_width")), 0.5))
        left = min(x0, x1)
        right = max(x0, x1)
        upper = min(top, bottom)
        lower = max(top, bottom)
        box = [
            left,
            upper,
            right if right > left else left + line_width,
            lower if lower > upper else upper + line_width,
        ]
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


def embedded_image_payload(
    item: dict[str, Any],
    index: int,
    rotation: float = 0.0,
) -> dict[str, Any] | None:
    """Extract an image XObject without rasterizing the complete PDF page.

    Keeping the original object is essential for signatures and stamps: a page
    screenshot also contains the selectable text that happens to cross the image.
    """
    box = _bbox(item)
    if not box:
        return None
    srcsize = list(item.get("srcsize") or [0, 0])
    width = int(_number(srcsize[0] if srcsize else 0))
    height = int(_number(srcsize[1] if len(srcsize) > 1 else 0))
    payload = {
        "id": f"native-image-{index + 1}",
        "bbox": box,
        "bbox_format": "xyxy",
        "name": str(item.get("name") or ""),
        "width": width,
        "height": height,
    }
    stream = item.get("stream")
    if not stream or width <= 0 or height <= 0:
        return payload

    try:
        raw = bytes(stream.get_rawdata() or b"")
        normalized_rotation = int(round(_number(rotation) / 90.0) * 90) % 360
        if raw.startswith(b"\xff\xd8\xff") and normalized_rotation == 0:
            payload.update(
                {
                    "data_base64": base64.b64encode(raw).decode("ascii"),
                    "mime_type": "image/jpeg",
                    "native_embedded": True,
                }
            )
            return payload

        from PIL import Image

        image = None
        if raw:
            try:
                candidate = Image.open(BytesIO(raw))
                candidate.load()
                image = candidate
            except Exception:
                image = None

        if image is None:
            decoded = bytes(stream.get_data() or b"")
            pixels = width * height
            if len(decoded) == pixels:
                image = Image.frombytes("L", (width, height), decoded)
            elif len(decoded) == pixels * 3:
                image = Image.frombytes("RGB", (width, height), decoded)
            elif len(decoded) == pixels * 4:
                image = Image.frombytes("CMYK", (width, height), decoded).convert("RGB")
            else:
                return payload

        if normalized_rotation:
            image = image.rotate(normalized_rotation, expand=True)
            payload["width"] = image.width
            payload["height"] = image.height
            payload["rotation_applied"] = normalized_rotation

        output = BytesIO()
        if image.mode not in {"1", "L", "LA", "P", "RGB", "RGBA"}:
            image = image.convert("RGB")
        image.save(output, format="PNG", optimize=True)
        payload.update(
            {
                "data_base64": base64.b64encode(output.getvalue()).decode("ascii"),
                "mime_type": "image/png",
                "native_embedded": True,
            }
        )
    except Exception:
        # Geometry is still useful for diagnostics and the frontend crop fallback.
        pass
    return payload


def _image_rotations(page: Any) -> dict[str, float]:
    """Return the display rotation applied to each PDF image XObject."""
    try:
        from pdfminer.layout import LTFigure
    except Exception:
        return {}

    rotations: dict[str, float] = {}

    def walk(node: Any) -> None:
        if isinstance(node, LTFigure):
            matrix = list(getattr(node, "matrix", ()) or ())
            if len(matrix) >= 2:
                rotations[str(getattr(node, "name", ""))] = math.degrees(
                    math.atan2(_number(matrix[1]), _number(matrix[0], 1))
                )
        if hasattr(node, "__iter__"):
            for child in node:
                walk(child)

    walk(page.layout)
    return rotations


def _cell_text(page: Any, cell: Any) -> str:
    if not cell:
        return ""
    try:
        return re.sub(r"\s+", " ", page.crop(cell).extract_text() or "").strip()
    except Exception:
        return ""


def _repair_fragmented_line_table(
    normalized_rows: list[list[str]],
    raw_rows: list[dict[str, Any]],
    x_coordinates: list[float],
    table_box: list[float],
    source: str,
) -> tuple[list[list[str]], list[dict[str, Any]], list[str]]:
    """Collapse sliced multi-line headers and recover vertical cell merges."""
    headers: list[str] = []
    if source == "lines" and len(raw_rows) >= 4 and len(x_coordinates) >= 3:
        column_count = len(x_coordinates) - 1
        first_cells = raw_rows[0].get("cells", [])
        has_grouped_header = any(
            _number(cell.get("columnSpan"), 1) > 1 for cell in first_cells
        )
        body_start = next(
            (
                index
                for index, row in enumerate(raw_rows[1:], 1)
                if len(row.get("cells", [])) >= column_count
                and not any(
                    str(cell.get("text") or "").strip()
                    for cell in row.get("cells", [])
                )
            ),
            0,
        )
        # Algunos formularios dibujan líneas internas únicamente para envolver
        # el texto de la cabecera. pdfplumber las interpreta como 3-4 filas
        # diminutas. Cuando existe una cabecera agrupada y después comienza una
        # fila completa vacía, reconstruimos dos niveles semánticos: los campos
        # simples abarcan ambas filas y el campo agrupado conserva sus hijos.
        if has_grouped_header and 2 <= body_start <= 5:
            header_rows = raw_rows[:body_start]
            header_cells = [
                cell for row in header_rows for cell in row.get("cells", [])
            ]
            header_top = min(
                (_number(cell.get("bbox", {}).get("y")) for cell in header_cells),
                default=_number(table_box[1]),
            )
            body_top = min(
                (
                    _number(cell.get("bbox", {}).get("y"))
                    for cell in raw_rows[body_start].get("cells", [])
                ),
                default=header_top,
            )
            first_bottom = max(
                (
                    _number(cell.get("bbox", {}).get("y"))
                    + _number(cell.get("bbox", {}).get("height"))
                    for cell in first_cells
                ),
                default=header_top,
            )

            top_cells: list[dict[str, Any]] = []
            child_cells: list[dict[str, Any]] = []
            flat_headers = [""] * column_count
            for first_cell in first_cells:
                start = int(_number(first_cell.get("columnIndex")))
                span = max(1, int(_number(first_cell.get("columnSpan"), 1)))
                if span > 1:
                    grouped = dict(first_cell)
                    grouped["rowSpan"] = 1
                    top_cells.append(grouped)
                    flat_headers[start] = str(grouped.get("text") or "").strip()
                    for column_index in range(start, min(start + span, column_count)):
                        candidates = [
                            cell
                            for row in header_rows[1:]
                            for cell in row.get("cells", [])
                            if int(_number(cell.get("columnIndex"))) == column_index
                            and str(cell.get("text") or "").strip()
                        ]
                        text = " ".join(
                            dict.fromkeys(
                                str(cell.get("text") or "").strip()
                                for cell in candidates
                            )
                        )
                        left = x_coordinates[column_index]
                        right = x_coordinates[column_index + 1]
                        child_cells.append(
                            {
                                "text": text,
                                "bbox": {
                                    "x": left,
                                    "y": first_bottom,
                                    "width": max(0.0, right - left),
                                    "height": max(0.0, body_top - first_bottom),
                                },
                                "rowSpan": 1,
                                "columnSpan": 1,
                                "columnIndex": column_index,
                            }
                        )
                else:
                    fragments = [
                        str(cell.get("text") or "").strip()
                        for row in header_rows
                        for cell in row.get("cells", [])
                        if int(_number(cell.get("columnIndex"))) == start
                        and str(cell.get("text") or "").strip()
                    ]
                    text = " ".join(dict.fromkeys(fragments))
                    merged = dict(first_cell)
                    merged["text"] = text
                    merged["bbox"] = {
                        "x": x_coordinates[start],
                        "y": header_top,
                        "width": max(0.0, x_coordinates[start + 1] - x_coordinates[start]),
                        "height": max(0.0, body_top - header_top),
                    }
                    merged["rowSpan"] = 2
                    top_cells.append(merged)
                    flat_headers[start] = text

            if child_cells:
                child_values = [""] * column_count
                for cell in child_cells:
                    child_values[int(cell["columnIndex"])] = str(cell.get("text") or "")
                raw_rows = [
                    {"cells": top_cells},
                    {"cells": child_cells},
                    *raw_rows[body_start:],
                ]
                normalized_rows = [
                    flat_headers,
                    child_values,
                    *normalized_rows[body_start:],
                ]
                headers = flat_headers

    if source == "lines" and len(normalized_rows) >= 4:
        row_heights = [
            max(
                (
                    _number(cell.get("bbox", {}).get("height"))
                    for cell in row.get("cells", [])
                ),
                default=0.0,
            )
            for row in raw_rows
        ]
        body_start = next(
            (
                index
                for index, height in enumerate(row_heights)
                if index >= 2 and height >= 24
            ),
            0,
        )
        column_count = max((len(row) for row in normalized_rows), default=0)
        first_row = normalized_rows[0] if normalized_rows else []
        coherent_first_row = (
            sum(bool(str(value or "").strip()) for value in first_row)
            >= max(2, math.ceil(column_count * 0.6))
        )

        # Una cabecera real de una sola fila (p. ej. "Etapa | Integrantes")
        # no debe fusionarse con la primera fila de datos solo porque esa fila
        # sea baja. La reparación multirrenglón se reserva para cabeceras
        # realmente fragmentadas y dispersas.
        if coherent_first_row:
            headers = [str(value or "").strip() for value in first_row]

        if not coherent_first_row and 2 <= body_start <= 6 and column_count >= 2:
            headers = [
                re.sub(
                    r"\s+",
                    " ",
                    " ".join(
                        row[column_index]
                        for row in normalized_rows[:body_start]
                        if column_index < len(row) and row[column_index]
                    ),
                ).strip()
                for column_index in range(column_count)
            ]
            if sum(bool(value) for value in headers) >= max(2, math.ceil(column_count * 0.6)):
                header_cells = [
                    cell
                    for row in raw_rows[:body_start]
                    for cell in row.get("cells", [])
                ]
                top = min(
                    (_number(cell.get("bbox", {}).get("y")) for cell in header_cells),
                    default=_number(table_box[1]),
                )
                bottom = max(
                    (
                        _number(cell.get("bbox", {}).get("y"))
                        + _number(cell.get("bbox", {}).get("height"))
                        for cell in header_cells
                    ),
                    default=top,
                )
                merged_header = {"cells": []}
                for column_index, text in enumerate(headers):
                    left = x_coordinates[column_index]
                    right = (
                        x_coordinates[column_index + 1]
                        if column_index + 1 < len(x_coordinates)
                        else _number(table_box[2])
                    )
                    merged_header["cells"].append(
                        {
                            "text": text,
                            "bbox": {
                                "x": left,
                                "y": top,
                                "width": max(0.0, right - left),
                                "height": max(0.0, bottom - top),
                            },
                            "rowSpan": 1,
                            "columnSpan": 1,
                            "columnIndex": column_index,
                        }
                    )
                normalized_rows = [headers, *normalized_rows[body_start:]]
                raw_rows = [merged_header, *raw_rows[body_start:]]
            else:
                headers = []

    row_tops = [
        min(
            (_number(cell.get("bbox", {}).get("y")) for cell in row.get("cells", [])),
            default=0.0,
        )
        for row in raw_rows
    ]
    for row_index, row in enumerate(raw_rows):
        for cell in row.get("cells", []):
            box = cell.get("bbox", {})
            bottom = _number(box.get("y")) + _number(box.get("height"))
            row_span = 1
            for next_top in row_tops[row_index + 1 :]:
                if next_top and bottom > next_top + 2:
                    row_span += 1
                else:
                    break
            cell["rowSpan"] = max(_number(cell.get("rowSpan"), 1), row_span)

    return normalized_rows, raw_rows, headers


def _cell_background_color(box: dict[str, float], fills: list[dict[str, Any]]) -> str | None:
    """Recover a cell's fill without mistaking a small text highlight for it."""
    left, top = _number(box.get("x")), _number(box.get("y"))
    width, height = _number(box.get("width")), _number(box.get("height"))
    area = width * height
    if area <= 0:
        return None
    candidates = []
    for fill in fills:
        x0, y0 = _number(fill.get("x0")), _number(fill.get("top"))
        x1, y1 = _number(fill.get("x1")), _number(fill.get("bottom"))
        overlap = max(0.0, min(left + width, x1) - max(left, x0)) * max(
            0.0, min(top + height, y1) - max(top, y0)
        )
        if overlap / area >= 0.9:
            color = _color(fill.get("non_stroking_color"))
            if color:
                candidates.append(((x1 - x0) * (y1 - y0), color))
    # A local cell fill takes precedence over a page- or table-wide background.
    return min(candidates, key=lambda candidate: candidate[0])[1] if candidates else None


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
                    "columnIndex": start,
                }
            )
        # Las filas vacías de formularios son contenido estructural: representan
        # campos que el usuario debe completar. Se conservan siempre que exista
        # una geometría real de celdas.
        if raw_cells:
            normalized_rows.append(normalized_values)
            raw_rows.append({"cells": raw_cells})

    column_count = max((len(row) for row in normalized_rows), default=0)
    # Una tabla con bordes puede continuar en una página mediante una sola
    # fila alta. Descartarla convierte sus celdas en cuadros de texto sueltos,
    # elimina la cuadrícula y provoca solapamientos entre columnas. La
    # estrategia basada solo en texto sí mantiene el mínimo de dos filas para
    # evitar falsos positivos en párrafos ordinarios.
    if column_count < 2 or not normalized_rows or (
        len(normalized_rows) < 2 and source != "lines"
    ):
        return None
    normalized_rows, raw_rows, headers = _repair_fragmented_line_table(
        normalized_rows,
        raw_rows,
        x_coordinates,
        table_box,
        source,
    )
    fills = [
        obj
        for obj in [*(getattr(page, "rects", None) or []), *(getattr(page, "curves", None) or [])]
        if not _is_table_border_object(obj)
    ]
    for row in raw_rows:
        for cell in row.get("cells", []):
            # Null is intentional: a native cell without a fill should not
            # receive an invented grey header background in the Word renderer.
            cell["shading"] = _cell_background_color(cell.get("bbox", {}), fills)
    return {
        "id": f"pdfplumber-table-{index + 1}",
        "bbox": table_box,
        "bbox_format": "xyxy",
        "rows": normalized_rows,
        "headers": headers,
        "column_anchors": x_coordinates[:-1],
        "confidence": 0.96 if source == "lines" else 0.84,
        "structural_score": 96 if source == "lines" else 84,
        "source": f"pdfplumber-{source}",
        "structure": {"raw": raw_rows, "column_anchors": x_coordinates[:-1]},
    }


def _is_table_border_object(obj: dict[str, Any]) -> bool:
    """Keep real rules, not the edges of fill-only text/cell backgrounds.

    Office PDFs often paint one shaded rectangle behind every text line.
    pdfplumber's ``lines`` strategy treats all four edges of those fills as
    borders, splitting a multiline header into artificial rows. A stroked
    rectangle is still a border; a narrow filled rectangle is still a rule
    (Word frequently exports real rules as 0.5-point black filled strips).
    Only broad, explicitly fill-only rectangles are excluded from detection.
    The original page is retained for text, images, colours and backgrounds.
    """
    if obj.get("stroke") is not False or not obj.get("fill"):
        return True
    is_rectangle = obj.get("object_type") == "rect"
    if obj.get("object_type") == "curve":
        # Some writers encode the same rectangle as four line segments.
        # Leave compound paths, diagonals and Bezier curves untouched.
        points = [(round(_number(x), 4), round(_number(y), 4)) for x, y in obj.get("pts", [])]
        path = obj.get("path") or []
        is_rectangle = (
            len(set(points)) == 4
            and len({x for x, _ in points}) == 2
            and len({y for _, y in points}) == 2
            and sum(command[0] == "m" for command in path) <= 1
            and all(command[0] in {"m", "l", "h"} for command in path)
            and all(a[0] == b[0] or a[1] == b[1] for a, b in zip(points, points[1:] + points[:1]))
        )
    if not is_rectangle:
        return True
    width = abs(_number(obj.get("width"), _number(obj.get("x1")) - _number(obj.get("x0"))))
    height = abs(_number(obj.get("height"), _number(obj.get("bottom")) - _number(obj.get("top"))))
    return min(width, height) <= 5.0


def _extract_tables(page: Any) -> list[dict[str, Any]]:
    settings = {
        "vertical_strategy": "lines",
        "horizontal_strategy": "lines",
        # Los bordes dibujados como rectángulos finos producen dos líneas a
        # 3-4 pt y pdfplumber las interpreta como columnas vacías. Cinco puntos
        # une ambos lados del mismo trazo sin afectar columnas reales.
        "snap_tolerance": 5,
        "join_tolerance": 5,
        "intersection_tolerance": 5,
    }
    # Filtering affects only the geometry used by TableFinder, never the
    # original PDF content or the text/decoration extraction that follows.
    geometry_page = page.filter(_is_table_border_object) if hasattr(page, "filter") else page
    tables = list(geometry_page.find_tables(table_settings=settings) or [])
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
    payloads = [
        payload
        for index, table in enumerate(tables)
        if (payload := _table_payload(page, table, index, source)) is not None
    ]
    return [payload for payload in payloads if is_plausible_text_table(payload, page)]


def is_plausible_text_table(payload: dict[str, Any], page: Any) -> bool:
    """Rejects prose that pdfplumber's text strategy split into fake columns."""
    if payload.get("source") != "pdfplumber-text":
        return True

    rows = payload.get("rows") or []
    if len(rows) < 8:
        return True

    box = payload.get("bbox") or []
    if isinstance(box, dict):
        table_height = _number(box.get("height"))
    else:
        table_height = max(0.0, _number(box[3]) - _number(box[1])) if len(box) >= 4 else 0.0
    page_height = max(1.0, _number(getattr(page, "height", 0), 1.0))
    if table_height / page_height < 0.42:
        return True

    non_empty = [str(cell or "").strip() for row in rows for cell in row if str(cell or "").strip()]
    if not non_empty:
        return False

    short_ratio = sum(len(value) <= 2 and value.isalpha() for value in non_empty) / len(non_empty)
    boundaries = 0
    fragmented = 0
    for row in rows:
        values = [str(cell or "").strip() for cell in row]
        for left, right in zip(values, values[1:]):
            if not left or not right or not left[-1].isalpha() or not right[0].isalpha():
                continue
            boundaries += 1
            if len(left) <= 2 or right[0].islower():
                fragmented += 1

    fragmentation_ratio = fragmented / max(1, boundaries)
    return short_ratio < 0.10 and fragmentation_ratio < 0.32


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
    image_rotations = _image_rotations(page)
    images = [
        payload
        for index, item in enumerate(page.images or [])
        if (
            payload := embedded_image_payload(
                item,
                index,
                image_rotations.get(str(item.get("name") or ""), 0.0),
            )
        ) is not None
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
    include_fonts: bool = True,
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
            # Fonts are a document-level resource. Scan every page once so a
            # batched conversion receives complete PDF subsets, including
            # glyphs that only appear in later batches.
            "fonts": _extract_embeddable_fonts(
                content,
                list(range(len(document.pages))),
            ) if include_fonts else [],
        }
