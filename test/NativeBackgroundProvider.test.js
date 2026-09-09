import test from "node:test";
import assert from "node:assert/strict";
import { File } from "node:buffer";

import {
    deriveDocumentRegistryEndpoint,
    deriveNativeBackgroundEndpoint,
    fetchNativeCleanBackground,
    registerNativeDocument,
} from "../src/engine/pdf-to-word/NativeBackgroundProvider.js";
import { primeLocalServiceSession } from "../src/engine/service/LocalServiceSession.js";

primeLocalServiceSession("http://127.0.0.1:8765", "test-session", Date.now() + 60 * 60_000);

test("deriva el fondo nativo únicamente desde un servicio local", () => {
    assert.equal(
        deriveNativeBackgroundEndpoint("http://127.0.0.1:8765/v1/layout"),
        "http://127.0.0.1:8765/v1/native-background"
    );
    assert.equal(deriveNativeBackgroundEndpoint("https://example.com/v1/layout"), null);
    assert.equal(
        deriveDocumentRegistryEndpoint("http://localhost:8765/v1/layout"),
        "http://localhost:8765/v1/documents"
    );
});

test("registra el PDF una sola vez y usa su id en fondos posteriores", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), body: options.body });
        if (String(url).endsWith("/v1/documents")) {
            return Response.json({ document_id: "a".repeat(64), page_count: 8, size_bytes: 9 });
        }
        return new Response(Uint8Array.from([137, 80, 78, 71]), { status: 200 });
    };
    try {
        const file = new File(["%PDF-test"], "fixture.pdf", { type: "application/pdf" });
        const registration = await registerNativeDocument(file);
        await fetchNativeCleanBackground(file, {
            pageNumber: 3,
            documentId: registration.documentId,
        });
        assert.equal(calls.length, 2);
        assert.match(calls[1].url, new RegExp(`/v1/documents/${"a".repeat(64)}/native-background$`));
        assert.equal(calls[1].body.has("pdf"), false);
        assert.equal(calls[1].body.get("page"), "3");
    } finally {
        globalThis.fetch = originalFetch;
    }
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
