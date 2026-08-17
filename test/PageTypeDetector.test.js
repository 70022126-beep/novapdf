import test from "node:test";
import assert from "node:assert/strict";

import { detectPageType } from "../src/engine/pdf-to-word/PageTypeDetector.js";

test("clasifica páginas digitales, escaneadas e híbridas", () => {
    const digital = detectPageType({
        textItems: Array.from({ length: 24 }, (_, index) => ({
            str: `contenido-${index}`,
            width: 42,
            height: 10,
        })),
        width: 612,
        height: 792,
    });
    const scanned = detectPageType({ textItems: [], width: 612, height: 792 });
    const hybrid = detectPageType({
        textItems: [{ str: "Texto parcial", width: 55, height: 10 }],
        width: 612,
        height: 792,
    });

    assert.equal(digital.type, "digital");
    assert.equal(scanned.type, "scanned");
    assert.equal(hybrid.type, "hybrid");
});

