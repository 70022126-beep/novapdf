import test from "node:test";
import assert from "node:assert/strict";
import { resolveOCRPolicy } from "../src/engine/pdf-to-word/OCRPolicy.js";
import { createPageCacheKey } from "../src/engine/pdf-to-word/ConversionCache.js";
import { isNativeDocxCandidateEligible } from "../src/engine/pdf-to-word/NativeDocxCandidate.js";

for (const pageType of ["digital", "hybrid", "scanned"]) {
    test(`política OCR explícita para página ${pageType}`, () => {
        const page = { pageType, nativeWordCount: 15, pageNumber: 2 };
        assert.equal(resolveOCRPolicy({ ...page, ocrMode: "auto" }).useOCR, pageType !== "digital");
        assert.deepEqual(resolveOCRPolicy({ ...page, ocrMode: "never" }), { useOCR: false, forceOCR: false });
        assert.deepEqual(resolveOCRPolicy({ ...page, ocrMode: "always" }), { useOCR: true, forceOCR: true });
    });
}

test("sin OCR no produce silenciosamente una página escaneada vacía", () => {
    assert.throws(() => resolveOCRPolicy({ ocrMode: "never", pageType: "scanned", pageNumber: 7 }), /página 7.*Activa OCR/);
});

test("páginas vacías y modo visual nunca activan OCR", () => {
    for (const ocrMode of ["auto", "never", "always"]) {
        assert.equal(resolveOCRPolicy({ ocrMode, isBlank: true }).useOCR, false);
        assert.equal(resolveOCRPolicy({ ocrMode, mode: "visual", pageType: "scanned" }).useOCR, false);
    }
});

test("rechaza políticas inválidas sin convertirlas en automático", () => {
    for (const ocrMode of ["", "forced", null, false]) {
        assert.throws(() => resolveOCRPolicy({ ocrMode }), /válida/);
    }
});

test("la caché separa OCR, diccionario, escritura manual y resolución", () => {
    const file = { name: "test.pdf", size: 123, lastModified: 1 };
    const variants = [{}, { ocrMode: "never" }, { ocrMode: "always" },
        { ocrDictionary: ["NovaPDF"] }, { experimentalHandwriting: true },
        { maximumCanvasMegapixels: 32 }];
    assert.equal(new Set(variants.map((options) => createPageCacheKey(file, 1, options))).size, variants.length);
});

test("un candidato nativo no puede sustituir la elección OCR forzado", () => {
    assert.equal(isNativeDocxCandidateEligible({ mode: "editable", options: { ocrMode: "always" }, pages: [{}] }), false);
});
