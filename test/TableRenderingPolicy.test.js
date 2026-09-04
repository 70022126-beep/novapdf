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

test("conserva campos y firmas aunque la página tenga pocos trazos vectoriales", () => {
    for (const vectorObjectCount of [1, 2, 6, 11, 12]) {
        assert.equal(needsCleanPositionedBackground({
            editableLayout: "positioned", vectorObjectCount,
        }), true, `Debe conservar ${vectorObjectCount} trazos`);
    }
    for (const vectorObjectCount of [0, -1, NaN, Infinity, undefined]) {
        assert.equal(needsCleanPositionedBackground({
            editableLayout: "positioned", vectorObjectCount,
        }), false);
    }
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

test("compone máscaras PDF incluso si un dibujo fue detectado como tabla", () => {
    const page = { editableLayout: "positioned", artworkRequiresCompositing: true,
        tables: [{ professional: { columnCount: 3 } }], vectorObjectCount: 0 };
    assert.equal(needsCleanPositionedBackground(page), true);
    assert.equal(needsCleanPositionedBackground({ ...page, artworkRequiresCompositing: false }), false);
    assert.equal(needsCleanPositionedBackground({ ...page, editableLayout: "flow" }), false);
});
