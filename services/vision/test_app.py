import unittest

import cv2
import numpy as np

from .app import _normalize_result, _visual_mark_regions
from .docx_quality import compare_page_images
from .native_pdf import normalize_word, parse_page_selection


class VisionNormalizationTests(unittest.TestCase):
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

        self.assertEqual(result["version"], "1.3.0")
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


if __name__ == "__main__":
    unittest.main()
