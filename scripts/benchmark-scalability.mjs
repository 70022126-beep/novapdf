import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import process from "node:process";

import JSZip from "jszip";

import { renderWordDocument } from "../src/engine/pdf-to-word/WordDocumentRenderer.js";

const PAGE_COUNTS = [100, 400, 1000];
const OUTPUT_ROOT = path.resolve("benchmarks/scalability/history");
const MAX_RSS_MB = Number(process.env.NOVAPDF_SCALE_MAX_RSS_MB || 1536);
const MAX_MS_PER_PAGE = Number(process.env.NOVAPDF_SCALE_MAX_MS_PER_PAGE || 250);

function makePage(pageNumber) {
    const text = `Página sintética ${pageNumber} de escalabilidad NovaPDF`;
    const word = {
        text,
        x: 72,
        y: 86,
        width: 280,
        height: 12,
        fontSize: 11,
        fontFamily: "Arial",
    };
    const line = {
        id: `line-${pageNumber}`,
        text,
        bbox: { x: 72, y: 86, width: 280, height: 12 },
        words: [word],
    };
    return {
        pageNumber,
        editableLayout: "flow",
        dimensions: { width: 595, height: 842 },
        content: { words: [word], lines: [line] },
        images: [],
        review: {},
        analysis: {
            zones: [],
            lines: [line],
            tables: [],
            paragraphs: [{ id: `paragraph-${pageNumber}`, lines: [line], bbox: line.bbox }],
            spatial: { textBox: { x: 72, y: 72, width: 451, height: 698 } },
            statistics: {},
        },
    };
}

async function measure(pageCount) {
    global.gc?.();
    const rssBefore = process.memoryUsage().rss;
    let peakRss = rssBefore;
    const sampler = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 20);
    const startedAt = performance.now();
    try {
        const result = await renderWordDocument({
            title: `NovaPDF scale ${pageCount}`,
            mode: "editable",
            pages: Array.from({ length: pageCount }, (_, index) => makePage(index + 1)),
            embeddedFonts: [],
        });
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        const durationMs = performance.now() - startedAt;
        const archive = await JSZip.loadAsync(await result.blob.arrayBuffer());
        const documentXml = await archive.file("word/document.xml").async("string");
        const sectionCount = (documentXml.match(/<w:sectPr[ >]/g) || []).length;
        return {
            pageCount,
            sectionCount,
            paginationMatch: sectionCount === pageCount,
            durationMs: Math.round(durationMs),
            millisecondsPerPage: Number((durationMs / pageCount).toFixed(2)),
            outputBytes: result.blob.size,
            rssBeforeMB: Number((rssBefore / 1024 / 1024).toFixed(2)),
            peakRssMB: Number((peakRss / 1024 / 1024).toFixed(2)),
            rssDeltaMB: Number(((peakRss - rssBefore) / 1024 / 1024).toFixed(2)),
        };
    } finally {
        clearInterval(sampler);
    }
}

const previousFontSetting = process.env.NOVAPDF_DISABLE_EMBEDDED_FONTS;
process.env.NOVAPDF_DISABLE_EMBEDDED_FONTS = "1";
const results = [];
try {
    for (const pageCount of PAGE_COUNTS) results.push(await measure(pageCount));
} finally {
    if (previousFontSetting === undefined) delete process.env.NOVAPDF_DISABLE_EMBEDDED_FONTS;
    else process.env.NOVAPDF_DISABLE_EMBEDDED_FONTS = previousFontSetting;
}

const failures = results.flatMap((result) => {
    const issues = [];
    if (!result.paginationMatch) issues.push(`${result.pageCount}: paginación ${result.sectionCount}`);
    if (result.peakRssMB > MAX_RSS_MB) issues.push(`${result.pageCount}: RAM ${result.peakRssMB} MB`);
    if (result.millisecondsPerPage > MAX_MS_PER_PAGE) {
        issues.push(`${result.pageCount}: ${result.millisecondsPerPage} ms/página`);
    }
    return issues;
});
const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    thresholds: { maximumPeakRssMB: MAX_RSS_MB, maximumMillisecondsPerPage: MAX_MS_PER_PAGE },
    passed: failures.length === 0,
    failures,
    results,
};

await mkdir(OUTPUT_ROOT, { recursive: true });
const timestamp = report.generatedAt.replaceAll(":", "-");
await writeFile(path.join(OUTPUT_ROOT, `${timestamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.resolve("benchmarks/scalability/latest.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
