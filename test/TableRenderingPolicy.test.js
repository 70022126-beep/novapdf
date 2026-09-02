import test from "node:test";
import assert from "node:assert/strict";
import {
    isComplexPositionedTable,
    needsCleanPositionedBackground,
} from "../src/engine/pdf-to-word/TableRenderingPolicy.js";

test("reserva el fondo limpio para cronogramas con demasiadas columnas", () => {
    assert.equal(isComplexPositionedTable({ professional: { columnCount: 22 } }), true);
    assert.equal(isComplexPositionedTable({ professional: { columnCount: 5 } }), false);
    assert.equal(isComplexPositionedTable({
        professional: { columnCount: 4, grid: Array.from({ length: 39 }, () => []) },
    }), true);
    assert.equal(isComplexPositionedTable({
        professional: { columnCount: 5, grid: Array.from({ length: 6 }, () => []) },
    }), true);
    assert.equal(isComplexPositionedTable({
        professional: { columnCount: 3, grid: Array.from({ length: 6 }, () => []) },
    }), false);
});

test("conserva arte vectorial solo cuando no duplicará una tabla Word normal", () => {
    assert.equal(needsCleanPositionedBackground({
        editableLayout: "positioned",
        tables: [],
        vectorObjectCount: 98,
    }), true);
    assert.equal(needsCleanPositionedBackground({
        editableLayout: "positioned",
        tables: [{ professional: { columnCount: 5 } }],
        vectorObjectCount: 500,
    }), false);
    assert.equal(needsCleanPositionedBackground({
        editableLayout: "positioned",
        tables: [{ professional: { columnCount: 19 } }],
        vectorObjectCount: 600,
    }), true);
    assert.equal(needsCleanPositionedBackground({
        editableLayout: "positioned",
        tables: [
            { professional: { columnCount: 3, grid: Array.from({ length: 2 }, () => []) } },
            { professional: { columnCount: 2, grid: Array.from({ length: 7 }, () => []) } },
        ],
        vectorObjectCount: 20,
    }), true);
    assert.equal(needsCleanPositionedBackground({
        editableLayout: "flow",
        tables: [],
        vectorObjectCount: 98,
    }), false);
});
