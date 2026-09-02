import test from "node:test";
import assert from "node:assert/strict";
import { File } from "node:buffer";

import {
    deriveNativeBackgroundEndpoint,
    fetchNativeCleanBackground,
} from "../src/engine/pdf-to-word/NativeBackgroundProvider.js";

test("deriva el fondo nativo únicamente desde un servicio local", () => {
    assert.equal(
        deriveNativeBackgroundEndpoint("http://127.0.0.1:8765/v1/layout"),
        "http://127.0.0.1:8765/v1/native-background"
    );
    assert.equal(deriveNativeBackgroundEndpoint("https://example.com/v1/layout"), null);
});

test("normaliza la placa limpia y su geometría", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(Uint8Array.from([137, 80, 78, 71]), {
        status: 200,
        headers: {
            "Content-Type": "image/png",
            "X-NovaPDF-Page-Width": "595",
            "X-NovaPDF-Page-Height": "842",
            "X-NovaPDF-Pixel-Width": "1190",
            "X-NovaPDF-Pixel-Height": "1684",
            "X-NovaPDF-Removed-Words": "6",
            "X-NovaPDF-Masked-Ratio": "0.024",
            "X-NovaPDF-Background-Strategy": "pdf-object-redaction",
        },
    });
    try {
        const file = new File(["%PDF-test"], "fixture.pdf", { type: "application/pdf" });
        const result = await fetchNativeCleanBackground(file, { pageNumber: 1 });

        assert.equal(result.role, "clean-editable-background");
        assert.equal(result.width, 595);
        assert.equal(result.pixelHeight, 1684);
        assert.equal(result.removedWordCount, 6);
        assert.equal(result.maskedPixelRatio, 0.024);
        assert.equal(result.strategy, "pdf-object-redaction");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
