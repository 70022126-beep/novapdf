import unittest
from unittest.mock import MagicMock, patch

from .table_text_audit import audit_table_text, compare_cell_text


class TableTextAuditTests(unittest.TestCase):
    box = {"x": 0, "y": 0, "width": 100, "height": 100}

    @staticmethod
    def text(value, y=20, dx=0):
        return [{"text": char, "origin": (10 + index * 5 + dx, y),
                 "bbox": (10 + index * 5 + dx, y - 8, 15 + index * 5 + dx, y + 2), "size": 10}
                for index, char in enumerate(value)]

    def test_detects_missing_characters_separately_from_geometry(self):
        result = compare_cell_text(self.text("Texto"), self.text("Text", 22, 1), self.box)
        self.assertEqual(result["unmatchedSourceCharacters"], 1)
        self.assertEqual(result["unmatchedOutputCharacters"], 0)
        self.assertEqual(result["meanAbsoluteHorizontalErrorPt"], 1)
        self.assertEqual(result["medianBaselineShiftPt"], 2)
        self.assertFalse(result["exactNormalizedText"])

    def test_measures_accumulated_baseline_drift_and_ignores_stream_order(self):
        source = self.text("ABC") + self.text("DEF", 35)
        candidate = self.text("DEF", 38) + self.text("ABC", 21)
        result = compare_cell_text(source, candidate, self.box)
        self.assertTrue(result["exactNormalizedText"])
        self.assertEqual(result["baselineDriftRangePt"], 2)
        self.assertEqual(result["maxAbsoluteBaselineErrorPt"], 3)

    def test_empty_cell_does_not_invent_a_perfect_geometry_score(self):
        result = compare_cell_text([], [], self.box)
        self.assertTrue(result["exactNormalizedText"])
        self.assertIsNone(result["meanAbsoluteBaselineErrorPt"])

    def test_out_of_cell_character_is_reported_missing(self):
        result = compare_cell_text(self.text("X"), self.text("X", 120), self.box)
        self.assertEqual(result["unmatchedSourceCharacters"], 1)

    def test_superscript_stays_in_reading_order_after_baseline_shift(self):
        body = self.text("Texto")
        raised = {"text": "1", "origin": (36, 16), "bbox": (36, 11, 39, 17), "size": 6}
        moved = {**raised, "origin": (36, 15), "bbox": (36, 10, 39, 16)}
        result = compare_cell_text(body + [raised], [moved] + body, self.box)
        self.assertTrue(result["exactNormalizedText"])
        self.assertEqual(result["unmatchedSourceCharacters"], 0)

    def test_rejects_invalid_cell_geometry(self):
        with self.assertRaises(ValueError):
            compare_cell_text([], [], {**self.box, "width": float("nan")})

    def test_short_ordinal_with_equal_counts_of_body_and_raised_characters(self):
        body = [{**char, "size": 9} for char in self.text("1.")]
        suffix = [{"text": char, "origin": (21 + index * 3, 17),
                   "bbox": (21 + index * 3, 12, 24 + index * 3, 18), "size": 6}
                  for index, char in enumerate("er")]
        moved = [{**char, "origin": (char["origin"][0], 16)} for char in suffix]
        self.assertTrue(compare_cell_text(body + suffix, moved + body, self.box)["exactNormalizedText"])

    def test_audit_reports_degenerate_cells_without_stopping_other_cells(self):
        document = MagicMock()
        document.__enter__.return_value = document
        document.__len__.return_value = 1
        document.__getitem__.return_value.get_text.return_value = {"blocks": []}
        cells = [{"bbox": {**self.box, "height": 0}}, {"bbox": self.box}, {}]
        report = {"pages": [{"pageNumber": 1, "tableGeometry": [{"nativeCellLines": [cells]}]}]}
        with patch("services.vision.table_text_audit.pymupdf.open", return_value=document):
            result = audit_table_text("source.pdf", "output.pdf", report)
        self.assertEqual(result["summary"]["comparedCells"], 1)
        self.assertEqual(result["summary"]["skippedCells"], 2)
        self.assertEqual(result["cells"][0]["reason"], "invalid_cell_geometry")
