import unittest
from io import BytesIO
from unittest.mock import patch

import cv2
import numpy as np
import pdfplumber
import pymupdf

from .app import APP_VERSION, _normalize_result, _visual_mark_regions
from .docx_quality import compare_page_images
from .native_background import build_text_mask, remove_text_from_rgb, render_clean_background
from .native_pdf import (
    _extract_tables,
    _cell_background_color,
    _is_table_border_object,
    _merge_font_subsets,
    _font_character_metrics,
    _relative_page_geometry,
    _table_payload,
    _repair_fragmented_line_table,
    _shape_payload,
    embedded_image_payload,
    is_plausible_text_table,
    normalize_word,
    extract_page,
    parse_page_selection,
)


class VisionNormalizationTests(unittest.TestCase):
    def test_font_character_metrics_export_real_space_and_glyph_advances(self):
        from fontTools.fontBuilder import FontBuilder
        from fontTools.pens.ttGlyphPen import TTGlyphPen

        builder = FontBuilder(1000, isTTF=True)
        glyph_order = [".notdef", "space", "A"]
        builder.setupGlyphOrder(glyph_order)
        glyphs = {}
        for name in glyph_order:
            pen = TTGlyphPen(None)
            glyphs[name] = pen.glyph()
        builder.setupGlyf(glyphs)
        builder.setupHorizontalMetrics({".notdef": (500, 0), "space": (250, 0), "A": (600, 0)})
        builder.setupHorizontalHeader(ascent=800, descent=-200)
        builder.setupCharacterMap({32: "space", 65: "A"})
        builder.setupNameTable({"familyName": "Metric Test", "styleName": "Regular"})
        builder.setupOS2()
        builder.setupPost()
        builder.setupMaxp()
        output = BytesIO()
        builder.save(output)

        metrics = _font_character_metrics(output.getvalue(), {"A"})

        self.assertEqual(metrics["units_per_em"], 1000)
        self.assertEqual(metrics["space_advance_em"], 0.25)
        self.assertEqual(metrics["character_widths_em"], {"32": 0.25, "65": 0.6})
        self.assertEqual(metrics["ascent_em"], 0.8)
        self.assertEqual(metrics["descent_em"], 0.2)
        self.assertFalse(metrics["has_kerning"])
        self.assertEqual(_font_character_metrics(b"not-a-font", {"A"}), {})

    def test_overprinted_letters_keep_last_colour_without_removing_real_repetitions(self):
        with pymupdf.open() as document:
            page = document.new_page(width=300, height=200)
            page.insert_text((30, 60), "LLAMA 0011", fontsize=12, color=(0, 0, 0))
            page.insert_text((30, 60), "LLAMA 0011", fontsize=12, color=(1, 0, 0))
            page.insert_text((30, 100), "LLAMA 0011", fontsize=12, color=(0, 0, 1))
            source = document.tobytes()
        with pdfplumber.open(BytesIO(source)) as document:
            result = extract_page(document.pages[0], 1, include_tables=False)
        self.assertEqual([word["text"] for word in result["words"]], ["LLAMA", "0011", "LLAMA", "0011"])
        self.assertEqual(result["statistics"]["removed_overprinted_characters"], 10)
        self.assertEqual(result["words"][0]["color"], "#FF0000")
        self.assertEqual(result["words"][2]["color"], "#0000FF")

    def test_pdf_masks_request_composition_before_decoding(self):
        class Stream:
            attrs = {}

        stream = Stream()
        item = {"x0": 0, "x1": 100, "top": 0, "bottom": 100, "srcsize": (0, 0), "stream": stream}
        self.assertFalse(embedded_image_payload(item, 0)["requires_compositing"])
        for attributes in ({"SMask": object()}, {"Mask": [0, 0]}, {"ImageMask": True}):
            stream.attrs = attributes
            self.assertTrue(embedded_image_payload(item, 0)["requires_compositing"])

    def test_object_redaction_preserves_sparse_form_rules_but_removes_text(self):
        # Real PDF-object path: older tests exercised only pixel inpainting.
        # The rule crosses the text redaction box and must survive it.
        with pymupdf.open() as document:
            page = document.new_page(width=300, height=200)
            page.insert_text((40, 60), "Nombre", fontsize=12)
            page.insert_text((250, 180), "194", fontsize=11)
            page.draw_line((40, 62), (220, 62), color=(0, 0, 0), width=1)
            page.draw_line((40, 120), (220, 120), color=(0, 0, 0), width=1)
            page.draw_rect(pymupdf.Rect(220, 80, 240, 100),
                           color=(0, 0.5, 0), fill=(0, 0.5, 0))
            source = document.tobytes()

        output, metadata = render_clean_background(source, 0, dpi=144)
        image = cv2.imdecode(np.frombuffer(output, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(metadata["strategy"], "pdf-object-redaction")
        self.assertEqual(metadata["removed_word_count"], 2)
        self.assertEqual(image.shape[:2], (400, 600))
        self.assertLess(image[124, 90:430].mean(), 80)
        self.assertLess(image[240, 90:430].mean(), 80)
        self.assertTrue(np.all(image[180, 460] == [0, 128, 0]) or
                        np.all(image[180, 460] == [0, 127, 0]))
        self.assertGreater(image[90:120, 80:180].mean(), 254)
        self.assertGreater(image[330:365, 495:545].mean(), 254)
        # Conversion must not change the user's original PDF.
        with pymupdf.open(stream=source, filetype="pdf") as original:
            self.assertIn("Nombre", original[0].get_text())
            self.assertIn("194", original[0].get_text())

    def test_font_subset_merge_falls_back_without_losing_invalid_fonts(self):
        fonts = [
            {"name": "Example", "style": "Regular", "extension": "ttf", "data": b"bad-a"},
            {"name": "Example", "style": "Regular", "extension": "ttf", "data": b"bad-b"},
        ]

        merged = _merge_font_subsets(fonts)

        self.assertEqual([font["data"] for font in merged], [b"bad-a", b"bad-b"])

    def test_font_subset_merge_uses_the_final_internal_family_name(self):
        class MergedFont:
            @staticmethod
            def save(output):
                output.write(b"merged-font-bytes")

            @staticmethod
            def close():
                return None

        class FakeMerger:
            @staticmethod
            def merge(_streams):
                return MergedFont()

        fonts = [
            {"name": "Display", "style": "Regular", "extension": "ttf", "data": b"subset-a"},
            {"name": "Display", "style": "Regular", "extension": "ttf", "data": b"subset-b"},
        ]

        with (
            patch("fontTools.merge.Merger", return_value=FakeMerger()),
            patch("services.vision.native_pdf._font_allows_editable_embedding", return_value=True),
            patch("services.vision.native_pdf._font_family_name", return_value="Display Light"),
            patch("services.vision.native_pdf._font_style_name", return_value="Light"),
        ):
            merged = _merge_font_subsets(fonts)

        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["name"], "Display Light")
        self.assertEqual(merged[0]["style"], "Light")
        self.assertEqual(merged[0]["data"], b"merged-font-bytes")

    def test_font_subset_merge_keeps_restricted_faces_separate(self):
        fonts = [
            {
                "name": "Licensed Sans",
                "style": "Regular",
                "extension": "ttf",
                "embedding": "editable",
                "data": b"editable-subset",
            },
            {
                "name": "Licensed Sans",
                "style": "Regular",
                "extension": "ttf",
                "embedding": "restricted",
                "data": b"restricted-subset-a",
            },
            {
                "name": "Licensed Sans",
                "style": "Regular",
                "extension": "ttf",
                "embedding": "restricted",
                "data": b"restricted-subset-b",
            },
        ]

        merged = _merge_font_subsets(fonts)

        self.assertEqual(len(merged), 3)
        self.assertEqual(
            [font["embedding"] for font in merged],
            ["editable", "restricted", "restricted"],
        )
        self.assertEqual(
            [font["data"] for font in merged],
            [b"editable-subset", b"restricted-subset-a", b"restricted-subset-b"],
        )

    def test_clean_background_masks_only_the_requested_word_boxes(self):
        mask = build_text_mask(
            [{"x0": 10, "top": 12, "x1": 30, "bottom": 22}],
            100,
            80,
            2,
            padding_points=1,
        )

        self.assertEqual(mask[24, 20], 255)
        self.assertEqual(mask[5, 5], 0)
        self.assertGreater(np.count_nonzero(mask), 0)
        self.assertLess(np.count_nonzero(mask), mask.size * 0.2)

    def test_clean_background_preserves_vector_ink_outside_text(self):
        page = np.full((90, 120, 3), 255, dtype=np.uint8)
        cv2.line(page, (5, 70), (115, 70), (20, 100, 20), 2)
        cv2.putText(page, "PDF", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)
        mask = np.zeros(page.shape[:2], dtype=np.uint8)
        cv2.rectangle(mask, (15, 18), (70, 45), 255, -1)

        cleaned = remove_text_from_rgb(page, mask)

        self.assertTrue(np.all(cleaned[70, 8] == page[70, 8]))
        self.assertGreater(cleaned[30:42, 20:65].mean(), page[30:42, 20:65].mean())

    def test_preserves_a_single_bordered_continuation_row(self):
        class Row:
            cells = [(0, 0, 80, 60), (80, 0, 180, 60), (180, 0, 300, 60)]

        class Table:
            bbox = (0, 0, 300, 60)
            cells = Row.cells
            rows = [Row()]

            @staticmethod
            def extract():
                return [["Criterio", "Nivel esperado", "Nivel destacado"]]

        class Page:
            @staticmethod
            def crop(_cell):
                class Crop:
                    @staticmethod
                    def extract_text():
                        return ""
                return Crop()

        payload = _table_payload(Page(), Table(), 0, "lines")

        self.assertIsNotNone(payload)
        self.assertEqual(len(payload["rows"]), 1)
        self.assertEqual(len(payload["structure"]["raw"][0]["cells"]), 3)

    def test_rebuilds_a_two_level_grouped_form_header(self):
        anchors = [0.0, 20.0, 100.0, 180.0, 240.0, 300.0, 360.0, 420.0]

        def cell(column, text, y, height, span=1):
            return {
                "text": text,
                "bbox": {
                    "x": anchors[column],
                    "y": y,
                    "width": anchors[column + span] - anchors[column],
                    "height": height,
                },
                "rowSpan": 1,
                "columnSpan": span,
                "columnIndex": column,
            }

        raw = [
            {"cells": [
                cell(0, "", 0, 20), cell(1, "Título del", 0, 20),
                cell(2, "IE", 0, 20), cell(3, "Jurado", 0, 20, 3),
                cell(6, "Puntaje", 0, 20),
            ]},
            {"cells": [
                cell(0, "N.°", 20, 20), cell(1, "proyecto", 20, 20),
                cell(2, "IE", 20, 10), cell(3, "1", 20, 20),
                cell(4, "2", 20, 20), cell(5, "3", 20, 20),
                cell(6, "total", 20, 20),
            ]},
            {"cells": [cell(2, "", 30, 10)]},
            {"cells": [cell(0, "", 35, 5), cell(1, "", 35, 5), cell(6, "", 35, 5)]},
            {"cells": [cell(column, "", 40, 25) for column in range(7)]},
        ]
        rows = [
            ["", "Título del", "IE", "Jurado", "", "", "Puntaje"],
            ["N.°", "proyecto", "IE", "1", "2", "3", "total"],
            ["", "", "", "", "", "", ""],
            ["", "", "", "", "", "", ""],
            ["", "", "", "", "", "", ""],
        ]

        repaired_rows, repaired_raw, headers = _repair_fragmented_line_table(
            rows, raw, anchors, [0, 0, 420, 65], "lines"
        )

        self.assertEqual(len(repaired_rows), 3)
        self.assertEqual(headers[1], "Título del proyecto")
        self.assertEqual(headers[6], "Puntaje total")
        self.assertEqual(repaired_raw[0]["cells"][1]["rowSpan"], 2)
        self.assertEqual(repaired_raw[0]["cells"][3]["columnSpan"], 3)
        self.assertEqual(
            [cell["text"] for cell in repaired_raw[1]["cells"]], ["1", "2", "3"]
        )

    def test_preserves_empty_form_rows_as_editable_cells(self):
        class Row:
            def __init__(self, cells):
                self.cells = cells

        class Table:
            bbox = (0, 0, 200, 90)
            cells = [(0, 0, 100, 30), (100, 0, 200, 30),
                     (0, 30, 100, 60), (100, 30, 200, 60),
                     (0, 60, 100, 90), (100, 60, 200, 90)]
            rows = [Row(cells[:2]), Row(cells[2:4]), Row(cells[4:])]

            @staticmethod
            def extract():
                return [["Campo", "Valor"], [None, None], ["Firma", None]]

        class Page:
            @staticmethod
            def crop(_cell):
                class Crop:
                    @staticmethod
                    def extract_text():
                        return ""
                return Crop()

        payload = _table_payload(Page(), Table(), 0, "lines")
        self.assertEqual(len(payload["rows"]), 3)
        self.assertEqual(payload["rows"][1], ["", ""])
        self.assertEqual(len(payload["structure"]["raw"][1]["cells"]), 2)

    def test_table_detector_merges_both_edges_of_thick_borders(self):
        received = []

        class Page:
            chars = []

            def find_tables(self, table_settings):
                received.append(table_settings)
                return []

        self.assertEqual(_extract_tables(Page()), [])
        self.assertEqual(received[0]["snap_tolerance"], 5)
        self.assertEqual(received[0]["join_tolerance"], 5)

    def test_table_detector_keeps_strokes_and_filled_rules_not_text_shading(self):
        shaded = {
            "object_type": "rect", "stroke": False, "fill": True,
            "width": 210, "height": 14.5,
        }
        self.assertFalse(_is_table_border_object(shaded))
        self.assertTrue(_is_table_border_object({**shaded, "stroke": True}))
        self.assertTrue(_is_table_border_object({**shaded, "height": 0.5}))
        self.assertTrue(_is_table_border_object({**shaded, "width": 4, "height": 200}))
        self.assertTrue(_is_table_border_object({"object_type": "char"}))
        self.assertTrue(_is_table_border_object({"object_type": "rect", "width": 200, "height": 20}))
        self.assertTrue(_is_table_border_object({**shaded, "object_type": "curve", "pts": [(0, 0), (100, 14), (200, 0)]}))

    def test_shaded_multiline_header_has_no_artificial_rows(self):
        with pymupdf.open() as document:
            page = document.new_page(width=400, height=180)
            anchors = [20, 240, 300, 380]
            shade = (0.949, 0.949, 0.949)
            # A full cell fill plus the line-sized fills emitted by Office.
            for left, right in zip(anchors, anchors[1:]):
                page.draw_rect((left, 20, right, 50), color=None, fill=shade)
            for box in [(24, 28, 236, 42), (244, 28, 296, 42),
                        (304, 20.5, 376, 35), (304, 35, 376, 49.5)]:
                page.draw_rect(box, color=None, fill=shade)
            for y in [20, 50, 66, 82]:
                page.draw_rect((20, y, 380, y + 0.5), color=None, fill=(0, 0, 0))
            for x in anchors:
                page.draw_rect((x, 20, x + 0.5, 82.5), color=None, fill=(0, 0, 0))
            page.insert_text((30, 39), "Student name", fontsize=11)
            page.insert_text((250, 39), "Grade", fontsize=11)
            page.insert_text((310, 32), "School", fontsize=11)
            page.insert_text((310, 46), "level", fontsize=11)
            pdf_bytes = document.tobytes()

        with pdfplumber.open(BytesIO(pdf_bytes)) as source:
            original = source.pages[0]
            original_rect_count = len(original.rects)
            tables = _extract_tables(original)
            self.assertEqual(len(original.rects), original_rect_count)

        self.assertEqual(len(tables), 1)
        self.assertEqual(len(tables[0]["rows"]), 3)
        self.assertEqual(tables[0]["rows"][0], ["Student name", "Grade", "School\nlevel"])
        self.assertEqual(tables[0]["rows"][1:], [["", "", ""], ["", "", ""]])
        self.assertAlmostEqual(tables[0]["structure"]["raw"][0]["cells"][0]["bbox"]["height"], 30, delta=0.5)
        self.assertEqual(tables[0]["structure"]["raw"][0]["cells"][0]["shading"], "#F2F2F2")
        self.assertIsNone(tables[0]["structure"]["raw"][1]["cells"][0]["shading"])

    def test_cell_fill_prefers_local_background_and_ignores_text_highlights(self):
        box = {"x": 20, "y": 20, "width": 100, "height": 40}
        fills = [
            {"x0": 0, "top": 0, "x1": 600, "bottom": 800, "non_stroking_color": 1},
            {"x0": 20, "top": 20, "x1": 120, "bottom": 60, "non_stroking_color": (0.2, 0.4, 0.8)},
            {"x0": 25, "top": 25, "x1": 80, "bottom": 35, "non_stroking_color": (1, 1, 0)},
        ]
        self.assertEqual(_cell_background_color(box, fills), "#3366CC")
        self.assertIsNone(_cell_background_color(box, fills[-1:]))
        self.assertIsNone(_cell_background_color({"width": 0, "height": 10}, fills))

    def test_repairs_a_fragmented_multiline_table_header_and_rowspan(self):
        rows = [
            ["", "", "", "N.° de", ""],
            ["Área", "", "Áreas de", "", "Docente"],
            ["", "Competencias", "", "estudiantes", ""],
            ["curricular", "", "participación", "", "asesor"],
            ["", "", "", "participantes", ""],
            ["Ciencia y Tecnología", "Indaga", "Indagación", "2", "1"],
            ["", "Diseña", "", "2", "1"],
        ]
        anchors = [100.0, 180.0, 300.0, 365.0, 425.0, 485.0]
        raw_rows = []
        for row_index in range(5):
            raw_rows.append(
                {
                    "cells": [
                        {
                            "text": rows[row_index][column_index],
                            "bbox": {
                                "x": anchors[column_index],
                                "y": 540 + row_index * 8,
                                "width": anchors[column_index + 1] - anchors[column_index],
                                "height": 8,
                            },
                            "rowSpan": 1,
                            "columnSpan": 1,
                            "columnIndex": column_index,
                        }
                        for column_index in range(5)
                    ]
                }
            )
        raw_rows.extend(
            [
                {
                    "cells": [
                        {
                            "text": rows[5][column_index],
                            "bbox": {
                                "x": anchors[column_index],
                                "y": 580,
                                "width": anchors[column_index + 1] - anchors[column_index],
                                "height": 80 if column_index in (0, 2) else 40,
                            },
                            "rowSpan": 1,
                            "columnSpan": 1,
                            "columnIndex": column_index,
                        }
                        for column_index in range(5)
                    ]
                },
                {
                    "cells": [
                        {
                            "text": rows[6][column_index],
                            "bbox": {
                                "x": anchors[column_index],
                                "y": 620,
                                "width": anchors[column_index + 1] - anchors[column_index],
                                "height": 40,
                            },
                            "rowSpan": 1,
                            "columnSpan": 1,
                            "columnIndex": column_index,
                        }
                        for column_index in (1, 3, 4)
                    ]
                },
            ]
        )

        repaired_rows, repaired_raw, headers = _repair_fragmented_line_table(
            rows, raw_rows, anchors, [100, 540, 485, 660], "lines"
        )

        self.assertEqual(len(repaired_rows), 3)
        self.assertEqual(headers[0], "Área curricular")
        self.assertEqual(headers[3], "N.° de estudiantes participantes")
        self.assertEqual(repaired_raw[1]["cells"][0]["rowSpan"], 2)

    def test_does_not_merge_a_coherent_header_with_the_first_data_row(self):
        rows = [
            ["Etapa", "Integrantes de la comisión"],
            ["I. E.", "Comité de Gestión Pedagógica"],
            ["UGEL", "Director y especialistas"],
            ["DRE", "Director regional"],
        ]
        raw_rows = [
            {
                "cells": [
                    {
                        "text": value,
                        "bbox": {
                            "x": 100 + column * 80,
                            "y": 400 + row * 20,
                            "width": 80,
                            "height": 20 if row < 2 else 48,
                        },
                        "columnIndex": column,
                    }
                    for column, value in enumerate(values)
                ]
            }
            for row, values in enumerate(rows)
        ]

        repaired_rows, _, headers = _repair_fragmented_line_table(
            rows, raw_rows, [100, 180, 260], [100, 400, 260, 536], "lines"
        )

        self.assertEqual(repaired_rows, rows)
        self.assertEqual(headers, rows[0])

    def test_preserves_exact_text_lines_and_seals(self):
        result = _normalize_result(
            {
                "res": {
                    "overall_ocr_res": {
                        "rec_texts": ["Texto principal"],
                        "rec_scores": [0.94],
                        "rec_boxes": [[10, 20, 180, 40]],
                    },
                    "parsing_res_list": [
                        {
                            "block_id": 1,
                            "block_label": "text",
                            "block_bbox": [10, 20, 180, 80],
                            "block_content": "Texto principal",
                            "block_order": 0,
                        }
                    ],
                    "seal_res_list": [
                        {
                            "rec_texts": ["COLEGIO"],
                            "rec_scores": [0.86],
                            "rec_boxes": [[220, 300, 320, 340]],
                        }
                    ],
                    "doc_preprocessor_res": {"angle": 0},
                }
            },
            600,
            800,
        )

        self.assertEqual(result["version"], APP_VERSION)
        self.assertEqual(result["text_lines"][0]["text"], "Texto principal")
        seal = next(region for region in result["regions"] if region["label"] == "seal")
        self.assertEqual(seal["bbox"], [220.0, 300.0, 320.0, 340.0])
        self.assertTrue(seal["protected"])

    def test_detects_colored_stamps_as_protected_regions(self):
        image = np.full((800, 600, 3), 245, dtype=np.uint8)
        image[560:640, 360:520] = [25, 70, 190]
        regions = _visual_mark_regions(image)

        self.assertTrue(regions)
        self.assertEqual(regions[0]["label"], "stamp")
        self.assertTrue(regions[0]["protected"])

    def test_normalizes_native_pdf_words_with_typography_and_color(self):
        word = normalize_word(
            {
                "text": "NovaPDF",
                "x0": 10,
                "x1": 70,
                "top": 20,
                "bottom": 32,
                "fontname": "ABCDEF+Arial-Bold",
                "size": 12,
                "chars": [
                    {
                        "fontname": "ABCDEF+Arial-Bold",
                        "size": 12,
                        "x0": 10,
                        "x1": 18,
                        "upright": True,
                        "non_stroking_color": (0.1, 0.2, 0.8),
                        "matrix": (12, 0, 0, 12, 10, 20),
                    }
                ],
            },
            0,
        )

        self.assertEqual(word["bbox"], [10.0, 20.0, 70.0, 32.0])
        self.assertEqual(word["color"], "#1A33CC")
        self.assertTrue(word["bold"])
        self.assertTrue(word["embedded_font"])

    def test_parses_sparse_native_page_ranges(self):
        self.assertEqual(parse_page_selection("3, 8-10, 100", 12), [2, 7, 8, 9])

    def test_native_baseline_comes_from_pdf_text_matrix_not_font_box(self):
        with pymupdf.open() as document:
            page = document.new_page(width=300, height=200)
            page.insert_text((40, 60), "Grande", fontsize=14)
            page.insert_text((40, 74), "Pequena", fontsize=9)
            source = document.tobytes()
        with pdfplumber.open(BytesIO(source)) as document:
            for page, origin in ((document.pages[0], 0), (document.pages[0].crop((20, 20, 280, 180)), 20)):
                words = extract_page(page, 1, include_tables=False)["words"]
                self.assertAlmostEqual(words[0]["baseline_y"], 60 - origin)
                self.assertAlmostEqual(words[1]["baseline_y"], 74 - origin)
                self.assertNotAlmostEqual(words[1]["bbox"][1] - words[0]["bbox"][1], 14)

    def test_page_origin_translates_nested_tables_images_and_baselines_once(self):
        original = {"bbox": [20, -8, 120, 42], "column_anchors": [20, 60],
                    "structure": {"raw": [{"cells": [{"bbox": {"x": 20, "y": -8, "width": 40, "height": 50}}]}]},
                    "words": [{"bbox": [25, 2, 60, 12], "baseline_y": 11}, {"baseline_y": None}]}
        relative = _relative_page_geometry(original, 20, -8)
        self.assertEqual(relative["bbox"], [0, 0, 100, 50])
        self.assertEqual(relative["column_anchors"], [0, 40])
        self.assertEqual(relative["structure"]["raw"][0]["cells"][0]["bbox"], {"x": 0, "y": 0, "width": 40, "height": 50})
        self.assertEqual(relative["words"][0], {"bbox": [5, 10, 40, 20], "baseline_y": 19})
        self.assertIsNone(relative["words"][1]["baseline_y"])
        self.assertEqual(original["bbox"], [20, -8, 120, 42], "no mutar la geometría del PDF")

    def test_nonzero_mediabox_matches_the_renderers_visible_page_origin(self):
        with pymupdf.open() as document:
            page = document.new_page(width=300, height=200)
            page.set_mediabox(pymupdf.Rect(12, 8, 312, 208))
            page.insert_text((40, 60), "Origen", fontsize=12)
            source = document.tobytes()
            expected_baseline = page.get_text("dict")["blocks"][0]["lines"][0]["spans"][0]["origin"][1]
        with pdfplumber.open(BytesIO(source)) as document:
            result = extract_page(document.pages[0], 1, include_tables=False)
        self.assertAlmostEqual(result["words"][0]["baseline_y"], expected_baseline, places=3)
        self.assertAlmostEqual(result["words"][0]["bbox"][0], 40, places=3)

    def test_native_baseline_is_optional_for_invalid_or_rotated_geometry(self):
        word = {"text": "X", "x0": 10, "x1": 20, "top": 30, "bottom": 40}
        invalid = [None, {}, {"top": 30, "y1": float("nan"), "matrix": (1, 0, 0, 1, 10, 70)},
                   {"top": 30, "y1": 80, "matrix": (0, 1, -1, 0, 10, 70)}]
        for char in invalid:
            with self.subTest(char=char):
                self.assertIsNone(normalize_word({**word, "chars": [char] if char else []}, 0)["baseline_y"])

    def test_preserves_zero_height_lines_for_text_decorations(self):
        line = _shape_payload(
            {
                "x0": 20,
                "x1": 90,
                "top": 44,
                "bottom": 44,
                "linewidth": 0.5,
            },
            0,
            "line",
        )

        self.assertEqual(line["bbox"], [20.0, 44.0, 90.0, 44.5])

    def test_extracts_an_embedded_rgb_image_without_page_text(self):
        class Stream:
            @staticmethod
            def get_rawdata():
                return b"compressed"

            @staticmethod
            def get_data():
                return bytes([255, 0, 0, 0, 255, 0])

        image = embedded_image_payload(
            {
                "name": "Signature",
                "x0": 10,
                "x1": 30,
                "top": 40,
                "bottom": 50,
                "srcsize": (2, 1),
                "stream": Stream(),
            },
            0,
        )

        self.assertEqual(image["bbox"], [10.0, 40.0, 30.0, 50.0])
        self.assertEqual(image["mime_type"], "image/png")
        self.assertTrue(image["native_embedded"])
        self.assertTrue(image["data_base64"].startswith("iVBOR"))

        rotated = embedded_image_payload(
            {
                "x0": 10,
                "x1": 30,
                "top": 40,
                "bottom": 50,
                "srcsize": (2, 1),
                "stream": Stream(),
            },
            0,
            90,
        )
        self.assertEqual(rotated["rotation_applied"], 90)
        self.assertEqual((rotated["width"], rotated["height"]), (1, 2))

    def test_rejects_a_legal_paragraph_split_into_fake_table_columns(self):
        class Page:
            height = 842

        fake_table = {
            "source": "pdfplumber-text",
            "bbox": [113, 72, 510, 752],
            "rows": [
                ["E", "XPEDIENTE : N° 00294", "0-0305-JP", "C-01"],
                ["D", "ocumento Nacional de Identi", "dad N°", "70022126"],
                ["d", "omicilio real en Jr. Tumbes", "con Av.", "Martinelly"],
                ["P", "rovincia de Chincheros", "Departamento", "Apurímac"],
                ["p", "roceso de Alimentos", "seguido", "en mi contra"],
                ["m", "enores alimentistas", "de iniciales", "L.M.D.J.S"],
                ["Q", "ue habiendo sido notificado", "del presente", "proceso"],
                ["a", "ctuados la Resolución", "de fecha", "octubre"],
            ],
        }

        self.assertFalse(is_plausible_text_table(fake_table, Page()))

    def test_visual_quality_scores_identical_pages_near_one_hundred(self):
        page = np.full((600, 420), 255, dtype=np.uint8)
        cv2.rectangle(page, (35, 60), (385, 520), 0, 2)
        cv2.putText(page, "NovaPDF", (70, 150), cv2.FONT_HERSHEY_SIMPLEX, 1.2, 0, 2)

        metrics = compare_page_images(page, page.copy(), dpi=120)

        self.assertGreater(metrics["visual_score"], 99)
        self.assertEqual(metrics["issues"], [])

    def test_visual_quality_detects_missing_layout(self):
        reference = np.full((600, 420), 255, dtype=np.uint8)
        cv2.putText(reference, "Contenido importante", (25, 180), cv2.FONT_HERSHEY_SIMPLEX, 0.8, 0, 2)
        candidate = np.full_like(reference, 255)

        metrics = compare_page_images(reference, candidate, dpi=120)

        self.assertLess(metrics["visual_score"], 75)
        self.assertIn("low_content_overlap", metrics["issues"])

    def test_visual_quality_does_not_reward_disjoint_edges(self):
        reference = np.full((600, 420), 255, dtype=np.uint8)
        candidate = np.full_like(reference, 255)
        cv2.rectangle(reference, (25, 30), (105, 110), 0, 2)
        cv2.rectangle(candidate, (300, 470), (380, 550), 0, 2)

        metrics = compare_page_images(reference, candidate, dpi=120)

        self.assertEqual(metrics["edge_similarity"], 0)
        self.assertLess(metrics["visual_score"], 25)
        self.assertIn("layout_mismatch", metrics["issues"])

    def test_visual_quality_preserves_a_truly_blank_page(self):
        blank = np.full((600, 420), 255, dtype=np.uint8)

        metrics = compare_page_images(blank, blank.copy(), dpi=120)

        self.assertEqual(metrics["visual_score"], 100)
        self.assertEqual(metrics["issues"], [])


if __name__ == "__main__":
    unittest.main()
