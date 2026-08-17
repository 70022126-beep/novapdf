import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyzePage } from "../src/engine/layout/PageAnalyzer.js";
import { normalizeNativeContent } from "../src/engine/pdf-to-word/PageContentNormalizer.js";
import { detectPageType } from "../src/engine/pdf-to-word/PageTypeDetector.js";

const argumentsList = process.argv.slice(2);
const maxPagesArgument = argumentsList.find((argument) => argument.startsWith("--max-pages="));
const maxPages = Math.max(1, Number(maxPagesArgument?.split("=")[1]) || Infinity);
const includePageDetails = argumentsList.includes("--details");
const complexPagesOnly = argumentsList.includes("--complex-only");
const paths = argumentsList.filter((argument) => !argument.startsWith("--"));

if (!paths.length) {
    console.error(
        "Uso: npm run benchmark:pdf -- --max-pages=5 archivo1.pdf archivo2.pdf"
    );
    process.exitCode = 1;
} else {
    const collectionStartedAt = performance.now();
    const results = [];

    for (const path of paths) {
        const startedAt = performance.now();
        const heapBefore = process.memoryUsage().heapUsed;
        const bytes = await readFile(path);
        const loadingTask = getDocument({
            data: new Uint8Array(bytes),
            disableWorker: true,
            useSystemFonts: true,
        });
        const pdf = await loadingTask.promise;
        const pageLimit = Math.min(pdf.numPages, maxPages);
        const types = { digital: 0, scanned: 0, hybrid: 0 };
        let characters = 0;
        const pages = [];

        for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            const viewport = page.getViewport({ scale: 1 });
            const textContent = await page.getTextContent();
            const pageType = detectPageType({
                textItems: textContent.items,
                width: viewport.width,
                height: viewport.height,
            });

            types[pageType.type] += 1;
            characters += pageType.characterCount;
            if (includePageDetails) {
                const nativeContent = normalizeNativeContent(textContent, viewport);
                const structure = analyzePage({
                    pageNumber,
                    width: viewport.width,
                    height: viewport.height,
                    words: nativeContent.words,
                    lines: nativeContent.lines,
                    blocks: nativeContent.blocks,
                    paragraphs: nativeContent.paragraphs,
                });
                pages.push({
                    pageNumber,
                    type: pageType.type,
                    nativeCharacters: pageType.characterCount,
                    textItems: textContent.items.length,
                    textDensity: Number(pageType.textDensity.toFixed(5)),
                    confidence: Number(pageType.confidence.toFixed(3)),
                    width: Number(viewport.width.toFixed(2)),
                    height: Number(viewport.height.toFixed(2)),
                    lines: structure.lines.length,
                    paragraphs: structure.paragraphs.length,
                    tables: structure.tables.length,
                    columns: structure.columns.count,
                });
            }
            page.cleanup();
        }

        await loadingTask.destroy();
        const durationMs = performance.now() - startedAt;
        const heapAfter = process.memoryUsage().heapUsed;

        results.push({
            file: basename(path),
            bytes: bytes.length,
            totalPages: pdf.numPages,
            analyzedPages: pageLimit,
            types,
            nativeCharacters: characters,
            durationMs: Math.round(durationMs),
            pagesPerSecond: Number((pageLimit / (durationMs / 1000)).toFixed(2)),
            heapDeltaMB: Number(((heapAfter - heapBefore) / 1024 / 1024).toFixed(2)),
            ...(includePageDetails
                ? {
                    pages: complexPagesOnly
                        ? pages.filter(
                            (page) =>
                                page.type !== "digital" ||
                                page.tables > 0 ||
                                page.columns > 1
                        )
                        : pages,
                }
                : {}),
        });
    }

    const durationMs = performance.now() - collectionStartedAt;
    console.log(
        JSON.stringify(
            {
                files: results.length,
                durationMs: Math.round(durationMs),
                results,
            },
            null,
            2
        )
    );
}
