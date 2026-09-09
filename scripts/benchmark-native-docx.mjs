import { File } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateRenderedWordDocument } from "../src/engine/evaluation/VisualQualityProvider.js";
import { enhancePageTables } from "../src/engine/layout/ProfessionalTableAnalyzer.js";
import { analyzePage } from "../src/engine/layout/PageAnalyzer.js";
import { analyzePageRegions } from "../src/engine/layout/RegionIntelligence.js";
import {
    extractNativeDocumentStructure,
    normalizeStructuredNativePage,
} from "../src/engine/pdf-to-word/NativeDocumentProvider.js";
import { mergeVectorTablesWithAnalysis } from "../src/engine/pdf-to-word/PDFVectorTableExtractor.js";
import { chooseEditableLayout } from "../src/engine/pdf-to-word/EditableLayoutPolicy.js";
import { fetchNativeCleanBackground } from "../src/engine/pdf-to-word/NativeBackgroundProvider.js";
import { needsCleanPositionedBackground } from "../src/engine/pdf-to-word/TableRenderingPolicy.js";
import { renderWordDocument } from "../src/engine/pdf-to-word/WordDocumentRenderer.js";

const argumentsList = process.argv.slice(2);
const pagesArgument = argumentsList.find((value) => value.startsWith("--pages="));
const outputArgument = argumentsList.find((value) => value.startsWith("--output="));
const endpointArgument = argumentsList.find((value) => value.startsWith("--endpoint="));
const layoutArgument = argumentsList.find((value) => value.startsWith("--layout="));
const verbose = argumentsList.includes("--verbose");
const cleanBackgrounds = !argumentsList.includes("--no-clean-backgrounds");
const files = argumentsList.filter((value) => !value.startsWith("--"));

if (!files.length) {
    console.error(
        "Uso: npm run benchmark:docx-native -- --pages=3,4,10 --output=tmp/benchmark.docx C:\\ruta\\documento.pdf"
    );
    process.exitCode = 1;
} else {
    const filename = path.resolve(files[0]);
    const pagesValue = String(pagesArgument?.slice("--pages=".length) || "1").trim();
    let pageNumbers = pagesValue.toLowerCase() === "all"
        ? []
        : pagesValue
            .split(",")
            .map(Number)
            .filter((value) => Number.isInteger(value) && value > 0);
    const outputPath = path.resolve(
        outputArgument?.slice("--output=".length) || "tmp/native-docx-benchmark.docx"
    );
    const endpoint = endpointArgument?.slice("--endpoint=".length) ||
        "http://127.0.0.1:8765/v1/layout";
    const requestedLayout = layoutArgument?.slice("--layout=".length) || "auto";
    if (!["auto", "flow", "positioned"].includes(requestedLayout)) {
        throw new Error("--layout debe ser auto, flow o positioned.");
    }
    const bytes = await readFile(filename);
    const sourceFile = new File([bytes], path.basename(filename), {
        type: "application/pdf",
        lastModified: 0,
    });

    const extracted = await extractNativeDocumentStructure(sourceFile, {
        pages: pageNumbers,
        endpoint,
        timeoutMs: 120_000,
    });
    if (extracted?.error || !extracted?.pages?.size) {
        throw new Error(extracted?.error || "El extractor nativo no devolvió páginas.");
    }
    if (!pageNumbers.length) {
        pageNumbers = [...extracted.pages.keys()].sort((first, second) => first - second);
    }

    const pages = [];
    for (const pageNumber of pageNumbers) {
        const rawPage = extracted.pages.get(pageNumber);
        if (!rawPage) throw new Error(`Falta la página ${pageNumber}.`);
        const normalized = normalizeStructuredNativePage(rawPage, {
            width: rawPage.width,
            height: rawPage.height,
        });
        const baseAnalysis = analyzePage({
            pageNumber,
            width: normalized.dimensions.width,
            height: normalized.dimensions.height,
            words: normalized.content.words,
            lines: normalized.content.lines,
            blocks: [],
            paragraphs: [],
        });
        const analysis = enhancePageTables(
            mergeVectorTablesWithAnalysis(baseAnalysis, normalized.tables),
            normalized.content.words
        );
        const editableLayout = requestedLayout === "auto"
            ? chooseEditableLayout({
                mode: "editable",
                pageType: { type: "digital", confidence: 100 },
                nativeContent: normalized.content,
                nativePage: normalized,
            })
            : requestedLayout;
        const regionAnalysis = analyzePageRegions({
            pageNumber,
            dimensions: normalized.dimensions,
            analysis,
            images: normalized.images,
            pageType: { type: "digital", confidence: 100 },
        });
        const needsBackground = cleanBackgrounds && needsCleanPositionedBackground({
            editableLayout,
            tables: analysis.tables,
            vectorObjectCount: normalized.vectorObjects.length,
            artworkRequiresCompositing: normalized.artworkRequiresCompositing,
        });
        const renderedPage = needsBackground
            ? await fetchNativeCleanBackground(sourceFile, {
                pageNumber,
                endpoint,
                dpi: 144,
                timeoutMs: 60_000,
            })
            : null;
        pages.push({
            pageNumber,
            dimensions: normalized.dimensions,
            pageType: { type: "digital", confidence: 100 },
            extractionMethod: "native-direct-benchmark",
            editableLayout,
            content: normalized.content,
            analysis,
            regionAnalysis,
            renderedPage,
            editableBackground: renderedPage
                ? {
                    role: renderedPage.role,
                    removedWordCount: renderedPage.removedWordCount,
                    removedCoverage: renderedPage.maskedPixelRatio,
                }
                : null,
            images: normalized.images,
            review: { strategy: "automatic" },
            metrics: { qualityRetry: false },
        });
    }

    const model = {
        title: `${path.basename(filename, path.extname(filename))}-native-benchmark`,
        sourceName: path.basename(filename),
        mode: "editable",
        pages,
        embeddedFonts: extracted.embeddedFonts || [],
        report: { pageCount: pages.length, durationMs: 0 },
    };
    const rendered = await renderWordDocument(model);
    await writeFile(outputPath, new Uint8Array(await rendered.blob.arrayBuffer()));
    const quality = await validateRenderedWordDocument(sourceFile, rendered.blob, {
        pageNumbers,
        endpoint,
        dpi: 120,
        timeoutMs: 210_000,
    });
    const reportPath = outputPath.replace(/\.docx$/i, ".quality.json");
    const report = {
        source: filename,
        output: outputPath,
        provider: extracted.provider,
        providerVersion: extracted.version,
        requestedLayout,
        cleanBackgrounds,
        cleanBackgroundPageCount: pages.filter((page) => page.renderedPage).length,
        typography: {
            scope: extracted.fontScope || null,
            analyzedPageCount: extracted.fontPageCount || 0,
            resourceCount: (extracted.embeddedFonts || []).length,
            embeddableFaceCount: (extracted.embeddedFonts || []).filter(
                (font) => font.embedding === "editable" && font.data?.length
            ).length,
            metricSubstitutionFaceCount: (extracted.embeddedFonts || []).filter(
                (font) => font.embedding !== "editable" || !font.data?.length
            ).length,
            families: [...new Set((extracted.embeddedFonts || []).map((font) => font.name))].sort(),
            variants: [...new Set((extracted.embeddedFonts || []).map((font) => font.style || "Regular"))].sort(),
        },
        generationMs: rendered.generationMs,
        outputBytes: rendered.blob.size,
        quality,
        pages: pages.map((page) => ({
            pageNumber: page.pageNumber,
            words: page.content.words.length,
            lines: page.content.lines.length,
            editableLayout: page.editableLayout,
            cleanBackground: Boolean(page.renderedPage),
            removedOverprintedCharacters: extracted.pages.get(page.pageNumber)?.statistics?.removed_overprinted_characters || 0,
            artworkRequiresCompositing: (extracted.pages.get(page.pageNumber)?.images || []).some((image) => image.requires_compositing === true),
            images: page.images.length,
            tables: page.analysis.tables.length,
            tableGeometry: page.analysis.tables.map((table) => ({
                bbox: table.bbox,
                columnAnchors: table.columnAnchors || table.structure?.columnAnchors || [],
                rows: table.professional?.grid?.length || table.rows?.length || 0,
                rowHeights: (table.professional?.grid || []).map((row) => {
                    const singleRow = row
                        .filter((cell) => Number(cell.rowSpan || 1) === 1)
                        .map((cell) => Number(cell.bbox?.height || 0));
                    return singleRow.length
                        ? Math.max(...singleRow)
                        : Math.max(...row.map(
                            (cell) => Number(cell.bbox?.height || 0) /
                                Math.max(1, Number(cell.rowSpan || 1))
                        ), 0);
                }),
                source: table.source,
                nativeCellLines: (table.professional?.grid || []).map((row) => row.map((cell) => ({
                    textLength: String(cell.text || "").length,
                    nativeLines: cell.nativeLines?.length || 0,
                    sourceLines: cell.sourceLines?.length || 0,
                    fontSize: cell.fontSize,
                    bbox: cell.bbox,
                }))),
            })),
        })),
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(verbose ? report : {
        source: report.source,
        output: report.output,
        report: reportPath,
        pages: report.pages.length,
        generationMs: report.generationMs,
        outputBytes: report.outputBytes,
        typography: report.typography,
        visualScore: report.quality.visualScore,
        pageCountMatch: report.quality.pageCountMatch,
        sourcePageCount: report.quality.sourcePageCount,
        outputPageCount: report.quality.outputPageCount,
        issues: report.quality.issues,
    }, null, 2));
}
