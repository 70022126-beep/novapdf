import test from "node:test";
import assert from "node:assert/strict";

import { chooseEditableLayout } from "../src/engine/pdf-to-word/EditableLayoutPolicy.js";

test("posiciona texto digital denso para conservar la paginación PDF", () => {
    assert.equal(chooseEditableLayout({ mode: "editable", pageType: { type: "digital" },
        nativeContent: { words: Array.from({ length: 400 }, () => ({})) },
        nativePage: { tables: [] } }), "positioned");
});

test("mantiene flujo en páginas simples de extensión intermedia", () => {
    assert.equal(chooseEditableLayout({ mode: "editable", pageType: { type: "digital" },
        nativeContent: { words: Array.from({ length: 150 }, () => ({})) },
        nativePage: { vectorObjects: [], tables: [] } }), "flow");
});

test("posiciona páginas digitales con tablas para conservar su geometría", () => {
    assert.equal(
        chooseEditableLayout({
            mode: "editable",
            pageType: { type: "digital" },
            nativeContent: { words: Array.from({ length: 446 }, () => ({})) },
            nativePage: { vectorObjects: Array.from({ length: 81 }, () => ({})), tables: [{}] },
        }),
        "positioned"
    );
});

test("reserva el posicionamiento absoluto para portadas digitales dispersas", () => {
    assert.equal(
        chooseEditableLayout({
            mode: "editable",
            pageType: { type: "digital" },
            nativeContent: { words: Array.from({ length: 6 }, () => ({})) },
            nativePage: { vectorObjects: Array.from({ length: 98 }, () => ({})), tables: [] },
        }),
        "positioned"
    );
});

test("conserva posicionadas las portadas híbridas con arte y poco texto nativo", () => {
    assert.equal(
        chooseEditableLayout({
            mode: "editable",
            pageType: { type: "hybrid" },
            nativeContent: { words: Array.from({ length: 6 }, () => ({})) },
            nativePage: { vectorObjects: Array.from({ length: 98 }, () => ({})), tables: [] },
        }),
        "positioned"
    );
});
