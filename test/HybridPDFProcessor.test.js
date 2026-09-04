import test from "node:test";
import assert from "node:assert/strict";

import { chooseEditableLayout } from "../src/engine/pdf-to-word/EditableLayoutPolicy.js";

test("mantiene flujo en texto digital denso sin tablas", () => {
    assert.equal(chooseEditableLayout({ mode: "editable", pageType: { type: "digital" },
        nativeContent: { words: Array.from({ length: 400 }, () => ({})) },
        nativePage: { tables: [] } }), "flow");
});

test("usa flujo para páginas digitales densas con tablas (tablas nativas en Word)", () => {
    assert.equal(
        chooseEditableLayout({
            mode: "editable",
            pageType: { type: "digital" },
            nativeContent: { words: Array.from({ length: 446 }, () => ({})) },
            nativePage: { vectorObjects: Array.from({ length: 81 }, () => ({})), tables: [{}] },
        }),
        "flow"
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

