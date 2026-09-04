"""Compare native table text in an original PDF and a rendered DOCX PDF.

This is a diagnostic, not OCR accuracy or a replacement for visual review.
Cell boxes and page mapping come from benchmark-native-docx's JSON report.
No document content is changed and no data leaves the local computer.
"""

from __future__ import annotations

import argparse
from difflib import SequenceMatcher
import json
import math
from pathlib import Path
from statistics import mean, median
import unicodedata

import pymupdf


def page_characters(page):
    characters = []
    for block in page.get_text("rawdict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                for char in span["chars"]:
                    # Ligatures and full-width forms are comparable; whitespace
                    # is excluded because Word may encode measured gaps as runs.
                    for value in unicodedata.normalize("NFKC", char["c"]):
                        if not value.isspace():
                            characters.append({"text": value, "bbox": char["bbox"],
                                               "origin": char["origin"], "size": span["size"]})
    return characters


def characters_in_cell(characters, box):
    x, y, width, height = (float(box[key]) for key in ("x", "y", "width", "height"))
    if not all(math.isfinite(value) for value in (x, y, width, height)) or min(width, height) <= 0:
        raise ValueError("Cell geometry must be finite and have positive dimensions.")
    selected = [char for char in characters
                if x <= (char["bbox"][0] + char["bbox"][2]) / 2 < x + width
                and y <= (char["bbox"][1] + char["bbox"][3]) / 2 < y + height]
    # Build body lines before inserting small raised/lowered references. A
    # superscript must not become its own line or alter the next line's anchor.
    typical_size = median(char["size"] for char in selected) if selected else 0
    body = [char for char in selected if char["size"] > typical_size * 0.8]
    scripts = [char for char in selected if char["size"] <= typical_size * 0.8]
    lines = []
    for char in sorted(body, key=lambda item: item["origin"][1]):
        target = lines[-1] if lines else None
        if target is None or abs(char["origin"][1] - target["baseline"]) > max(
                2, max(char["size"], target["size"]) * 0.4):
            target = {"chars": [], "baseline": char["origin"][1], "size": char["size"]}
            lines.append(target)
        target["chars"].append(char)
    for char in scripts:
        target = min(lines, key=lambda line: abs(char["origin"][1] - line["baseline"]), default=None)
        if target is None or abs(char["origin"][1] - target["baseline"]) > target["size"] * 0.8:
            target = {"chars": [], "baseline": char["origin"][1], "size": char["size"]}
            lines.append(target)
        target["chars"].append(char)
    return [char for line in sorted(lines, key=lambda line: line["baseline"])
            for char in sorted(line["chars"], key=lambda item: item["origin"][0])]


def compare_cell_text(reference, candidate, box):
    source = characters_in_cell(reference, box)
    output = characters_in_cell(candidate, box)
    source_text = "".join(char["text"] for char in source)
    output_text = "".join(char["text"] for char in output)
    # Keep pathological cells from triggering unbounded quadratic alignment.
    if max(len(source), len(output)) > 10000:
        return {"status": "skipped", "reason": "cell_character_limit",
                "sourceCharacters": len(source), "outputCharacters": len(output)}
    matching = SequenceMatcher(None, source_text, output_text, autojunk=False).get_matching_blocks()
    pairs = [(source[block.a + offset], output[block.b + offset])
             for block in matching for offset in range(block.size)]
    dx = [right["origin"][0] - left["origin"][0] for left, right in pairs]
    dy = [right["origin"][1] - left["origin"][1] for left, right in pairs]
    metric = lambda values, operation: round(operation(values), 3) if values else None
    return {
        "status": "compared", "sourceCharacters": len(source), "outputCharacters": len(output),
        "matchedCharacters": len(pairs),
        "unmatchedSourceCharacters": len(source) - len(pairs),
        "unmatchedOutputCharacters": len(output) - len(pairs),
        "exactNormalizedText": source_text == output_text,
        "meanAbsoluteHorizontalErrorPt": metric([abs(value) for value in dx], mean),
        "meanAbsoluteBaselineErrorPt": metric([abs(value) for value in dy], mean),
        "medianBaselineShiftPt": metric(dy, median),
        "maxAbsoluteBaselineErrorPt": metric([abs(value) for value in dy], max),
        "baselineDriftRangePt": round(max(dy) - min(dy), 3) if dy else None,
    }


def audit_table_text(source_path, rendered_path, report, selected_pages=None):
    results = []
    with pymupdf.open(source_path) as source, pymupdf.open(rendered_path) as candidate:
        pages = report["pages"]
        if len(candidate) != len(pages):
            raise ValueError("Rendered page count does not match the benchmark mapping.")
        for output_index, page in enumerate(pages):
            page_number = page["pageNumber"]
            if selected_pages is not None and page_number not in selected_pages:
                continue
            if not 1 <= page_number <= len(source):
                raise ValueError(f"Source page {page_number} does not exist.")
            reference = page_characters(source[page_number - 1])
            output = page_characters(candidate[output_index])
            for table_index, table in enumerate(page.get("tableGeometry", [])):
                seen = set()
                for row_index, row in enumerate(table.get("nativeCellLines", [])):
                    for column_index, cell in enumerate(row):
                        box = cell.get("bbox")
                        identity = {"page": page_number, "table": table_index + 1,
                                    "row": row_index + 1, "column": column_index + 1, "bbox": box}
                        try:
                            key = tuple(float(box[name]) for name in ("x", "y", "width", "height"))
                        except (KeyError, TypeError, ValueError):
                            key = ()
                        if not key or not all(math.isfinite(value) for value in key) or min(key[2:]) <= 0:
                            results.append({**identity, "status": "skipped", "reason": "invalid_cell_geometry"})
                            continue
                        key = tuple(round(value, 3) for value in key)
                        if key in seen:
                            continue
                        seen.add(key)
                        results.append({**identity, **compare_cell_text(reference, output, box)})
    compared = [cell for cell in results if cell["status"] == "compared"]
    return {"source": str(source_path), "rendered": str(rendered_path),
            "note": "Native text diagnostic; whitespace normalized; not CER/WER or proof of visible ink.",
            "summary": {"cells": len(results), "comparedCells": len(compared),
                        "skippedCells": len(results) - len(compared),
                        "cellsWithTextDifferences": sum(not cell["exactNormalizedText"] for cell in compared),
                        "unmatchedSourceCharacters": sum(cell["unmatchedSourceCharacters"] for cell in compared),
                        "unmatchedOutputCharacters": sum(cell["unmatchedOutputCharacters"] for cell in compared)},
            "cells": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--rendered", type=Path, required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--pages", help="Comma-separated original page numbers (default: all).")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    protected = [args.report, args.rendered] + ([args.source] if args.source else [])
    report = json.loads(args.report.read_text(encoding="utf-8"))
    source = args.source or Path(report["source"])
    protected.append(source)
    if args.output.resolve() in {path.resolve() for path in protected}:
        parser.error("The output must not overwrite an input.")
    pages = {int(value) for value in args.pages.split(",")} if args.pages else None
    result = audit_table_text(source, args.rendered, report, pages)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result["summary"]))


if __name__ == "__main__":
    main()
