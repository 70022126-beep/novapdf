import test from "node:test";
import assert from "node:assert/strict";

import {
    clearConversionCache,
    createDocumentResourceCacheKey,
    createPageCacheKey,
    getCachedDocumentResources,
    setCachedDocumentResources,
} from "../src/engine/pdf-to-word/ConversionCache.js";

test("la caché cambia cuando cambia la arquitectura de visión o fondo", () => {
    const file = { name: "documento.pdf", size: 1200, lastModified: 10 };
    const first = createPageCacheKey(file, 1, {
        mode: "editable",
        advancedVision: true,
        cleanEditableBackground: true,
        visionVersion: "3.5.0",
    });
    const second = createPageCacheKey(file, 1, {
        mode: "editable",
        advancedVision: true,
        cleanEditableBackground: true,
        visionVersion: "3.6.0",
    });
    const withoutBackground = createPageCacheKey(file, 1, {
        mode: "editable",
        advancedVision: true,
        cleanEditableBackground: false,
        visionVersion: "3.5.0",
    });

    assert.notEqual(first, second);
    assert.notEqual(first, withoutBackground);
});

test("conserva recursos tipográficos de documento aunque las páginas salgan de caché", () => {
    const file = { name: "extenso.pdf", size: 9000, lastModified: 20 };
    const key = createDocumentResourceCacheKey(file, {
        visionEndpoint: "http://127.0.0.1:8765/v1/layout",
        visionVersion: "3.27.0-font-resources",
    });
    const resources = {
        fontScope: "document",
        fontPageCount: 235,
        embeddedFonts: [{ id: "font-1", data: new Uint8Array(64) }],
    };

    setCachedDocumentResources(key, resources);
    assert.equal(getCachedDocumentResources(key).fontPageCount, 235);
    assert.equal(getCachedDocumentResources(key).embeddedFonts[0].data.length, 64);
    clearConversionCache(file);
    assert.equal(getCachedDocumentResources(key), null);
});
