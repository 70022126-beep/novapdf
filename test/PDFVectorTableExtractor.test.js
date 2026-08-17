import test from "node:test";
import assert from "node:assert/strict";

import {
    buildVectorTablesFromSegments,
    mergeVectorTablesWithAnalysis,
} from "../src/engine/pdf-to-word/PDFVectorTableExtractor.js";

test("reconstruye una tabla vectorial y conserva celdas combinadas", () => {
    const segments = [
        { orientation: "horizontal", x: 10, y: 10, width: 200, height: 0.5 },
        { orientation: "horizontal", x: 10, y: 50, width: 200, height: 0.5 },
        { orientation: "horizontal", x: 10, y: 90, width: 200, height: 0.5 },
        { orientation: "vertical", x: 10, y: 10, width: 0.5, height: 80 },
        { orientation: "vertical", x: 210, y: 10, width: 0.5, height: 80 },
        { orientation: "vertical", x: 110, y: 50, width: 0.5, height: 40 },
    ];
    const words = [
        { text: "Encabezado", x: 35, y: 20, width: 65, height: 12 },
        { text: "A", x: 35, y: 62, width: 10, height: 12 },
        { text: "B", x: 145, y: 62, width: 10, height: 12 },
    ];
    const tables = buildVectorTablesFromSegments(
        segments,
        words,
        { width: 300, height: 200 }
    );

    assert.equal(tables.length, 1);
    assert.equal(tables[0].rows.length, 2);
    assert.equal(tables[0].structure.raw[0].cells[0].columnSpan, 2);
    assert.equal(tables[0].rows[1][0], "A");
    assert.equal(tables[0].rows[1][1], "B");
});

test("una rejilla vectorial fiable sustituye una tabla heuristica solapada", () => {
    const heuristic = {
        id: "heuristic",
        bbox: { x: 10, y: 10, width: 200, height: 80 },
        structuralScore: 70,
    };
    const vector = {
        id: "vector",
        bbox: { x: 10, y: 10, width: 200, height: 80 },
        structuralScore: 98,
    };
    const merged = mergeVectorTablesWithAnalysis({ tables: [heuristic] }, [vector]);

    assert.equal(merged.tables.length, 1);
    assert.equal(merged.tables[0].id, "vector");
    assert.equal(merged.vectorTableCount, 1);
});

test("conserva la tabla secundaria con mas filas y columnas aunque su score base sea menor", () => {
    const secondary = {
        id: "pdfplumber",
        bbox: { x: 10, y: 10, width: 200, height: 180 },
        structuralScore: 96,
        rows: Array.from({ length: 8 }, (_, row) =>
            Array.from({ length: 5 }, (_, column) => `r${row}c${column}`)
        ),
    };
    const partialVector = {
        id: "vector-partial",
        bbox: { x: 10, y: 10, width: 200, height: 180 },
        structuralScore: 98,
        rows: Array.from({ length: 3 }, (_, row) =>
            Array.from({ length: 5 }, (_, column) => `r${row}c${column}`)
        ),
    };
    const merged = mergeVectorTablesWithAnalysis(
        { tables: [] },
        [secondary, partialVector]
    );

    assert.equal(merged.tables.length, 1);
    assert.equal(merged.tables[0].id, "pdfplumber");
});
