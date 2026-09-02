import test from "node:test";
import assert from "node:assert/strict";

import { chooseEditableLayout } from "../src/engine/pdf-to-word/EditableLayoutPolicy.js";

test("mantiene flujo en texto digital denso sin tablas", () => {
    assert.equal(chooseEditableLayout({ mode: "editable", pageType: { type: "digital" },
        nativeContent: { words: Array.from({ length: 400 }, () => ({})) },
        nativePage: { tables: [] } }), "flow");
});

test("ancla tablas digitales densas para evitar desbordamientos de flujo", () => {
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
