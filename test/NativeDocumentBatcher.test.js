import test from "node:test";
import assert from "node:assert/strict";
import { extractNativeDocumentInBatches } from "../src/engine/pdf-to-word/NativeDocumentBatcher.js";

test("extrae documentos extensos en lotes sin perder páginas", async () => {
    const calls = [];
    const result = await extractNativeDocumentInBatches({}, Array.from({ length: 235 }, (_, i) => i + 1),
        async (_file, pages, options) => {
            calls.push({ pages, options });
            return { provider: "test", pageCount: 235,
                pages: new Map(pages.map((page) => [page, { page_number: page }])) };
        }, { batchSize: 100 });
    assert.deepEqual(calls.map(({ pages }) => pages.length), [100, 100, 35]);
    assert.deepEqual(calls.map(({ options }) => options.includeFonts), [true, false, false]);
    assert.deepEqual(calls.map(({ options }) => options.batchIndex), [0, 1, 2]);
    assert.equal(result.pages.size, 235);
    assert.equal(result.pages.get(235).page_number, 235);
});

test("respeta cancelación antes del siguiente lote", async () => {
    const controller = new AbortController();
    await assert.rejects(
        extractNativeDocumentInBatches({}, [1, 2, 3], async () => {
            controller.abort();
            return { pages: new Map([[1, {}]]) };
        }, { batchSize: 1, signal: controller.signal }),
        { name: "AbortError" }
    );
});

test("combina tipografías incrustables sin duplicarlas entre lotes", async () => {
    const result = await extractNativeDocumentInBatches({}, [1, 2], async (_file, pages) => ({
        pages: new Map([[pages[0], {}]]),
        embeddedFonts: [{ id: "font-1", name: "Quicksand Light", data: new Uint8Array(64) }],
    }), { batchSize: 1 });

    assert.equal(result.embeddedFonts.length, 1);
    assert.equal(result.embeddedFonts[0].name, "Quicksand Light");
});
