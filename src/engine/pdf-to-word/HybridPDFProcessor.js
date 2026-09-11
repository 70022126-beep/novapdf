import { analyzePage } from "../layout/PageAnalyzer.js";
import { analyzePageRegions } from "../layout/RegionIntelligence.js";
import { analyzeDocumentStructure } from "../layout/DocumentStructureAnalyzer.js";
import {
    detectFormFields,
    enhancePageTables,
} from "../layout/ProfessionalTableAnalyzer.js";
import { recognizeAdaptive } from "../ocr/AdaptiveOCR.js";
import { OCR_MODES, resolveOCRPolicy } from "./OCRPolicy.js";
import {
    needsCleanPositionedBackground,
} from "./TableRenderingPolicy.js";
import { extractNativeDocumentInBatches } from "./NativeDocumentBatcher.js";
import { detectPageType } from "./PageTypeDetector.js";
import {
    countCharacters,
    buildLinesFromWords,
    mergeNativeAndOCR,
    normalizeNativeContent,
    normalizeOCRContent,
} from "./PageContentNormalizer.js";
import {
    cropPageImageRegions,
    inspectPageImages,
} from "./PDFImageExtractor.js";
import {
    createPageCacheKey,
    createDocumentResourceCacheKey,
    getCachedDocumentResources,
    getCachedPage,
    getConversionCacheStats,
    setCachedPage,
    setCachedDocumentResources,
} from "./ConversionCache.js";
import { normalizePageRange } from "./PageRange.js";
import { analyzePageWithVision } from "../vision/NeuralVisionProvider.js";
import { createEditableBackground } from "../vision/EditableBackground.js";
import {
    fetchNativeCleanBackground,
    registerNativeDocument,
} from "./NativeBackgroundProvider.js";
import {
    createOrResumeConversionSession,
    loadPageCheckpoints,
    savePageCheckpoint,
    updateConversionSession,
} from "./PersistentConversionStore.js";
import { mergeVisionLayoutWithAnalysis } from "../layout/NeuralLayoutFusion.js";
import {
    fuseNeuralTextWithOCR,
    getNeuralFallbackRegions,
    neuralVisionToContent,
} from "../vision/NeuralTextFusion.js";
import {
    extractVectorTables,
    mergeVectorTablesWithAnalysis,
} from "./PDFVectorTableExtractor.js";
import {
    extractNativeDocumentStructure,
    normalizeStructuredNativePage,
    repairNativeTableText,
    selectBestNativeContent,
} from "./NativeDocumentProvider.js";
import { chooseEditableLayout } from "./EditableLayoutPolicy.js";
import { resolveClientResourceBudget } from "./ResourceBudget.js";

export { normalizePageRange } from "./PageRange.js";

let pdfjsPromise = null;

async function getPdfjs() {
    if (!pdfjsPromise) {
        pdfjsPromise = import("pdfjs-dist").then((pdfjsLib) => {
            pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
                "pdfjs-dist/build/pdf.worker.min.mjs",
                import.meta.url
            ).toString();
            return pdfjsLib;
        });
    }

    return pdfjsPromise;
}

function now() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function getHeapSize() {
    const size = globalThis.performance?.memory?.usedJSHeapSize;
    return Number.isFinite(size) ? size : null;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function boxOverlapRatio(first = {}, second = {}) {
    const left = Math.max(Number(first.x) || 0, Number(second.x) || 0);
    const top = Math.max(Number(first.y) || 0, Number(second.y) || 0);
    const right = Math.min(
        (Number(first.x) || 0) + (Number(first.width) || 0),
        (Number(second.x) || 0) + (Number(second.width) || 0)
    );
    const bottom = Math.min(
        (Number(first.y) || 0) + (Number(first.height) || 0),
        (Number(second.y) || 0) + (Number(second.height) || 0)
    );
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const minimumArea = Math.max(
        1,
        Math.min(
            (Number(first.width) || 0) * (Number(first.height) || 0),
            (Number(second.width) || 0) * (Number(second.height) || 0)
        )
    );
    return intersection / minimumArea;
}

export function selectRecoverableVisualRegions(vision, embeddedRegions, dimensions) {
    const pageArea = Math.max(1, dimensions.width * dimensions.height);
    const recoverableTypes = new Set([
        "photo",
        "graphic",
        "signature",
        "stamp",
        "scribble",
        "stain",
    ]);
    const regions = (embeddedRegions || []).map((region, index) => ({
        ...region,
        id: region.id || `embedded-image-${index + 1}`,
        regionType: region.type || "photo",
        source: region.source || "pdf-image",
    }));

    (vision?.routing?.protectedRegions || []).forEach((region) => {
        const area = Number(region.bbox?.width || 0) * Number(region.bbox?.height || 0);
        if (
            !recoverableTypes.has(region.type) ||
            area < 240 ||
            area / pageArea > 0.42 ||
            regions.some((candidate) => boxOverlapRatio(candidate, region.bbox) >= 0.72)
        ) {
            return;
        }
        regions.push({
            ...region.bbox,
            id: region.id,
            regionType: region.type,
            source: region.source,
            confidence: region.confidence,
        });
    });
    return regions;
}

function selectCleanPlateProtectedRegions(regions, dimensions) {
    const protectedTypes = new Set(["signature", "stamp", "scribble", "stain"]);
    const pageArea = Math.max(1, dimensions.width * dimensions.height);
    return (regions || []).filter((region) => {
        const regionArea =
            Number(region.bbox?.width || 0) * Number(region.bbox?.height || 0);
        return protectedTypes.has(region.type) && regionArea / pageArea <= 0.12;
    });
}

function calculateRenderScale(viewport, preferredScale, maximumMegapixels = 20) {
    const longestSide = Math.max(viewport.width, viewport.height);
    const pixelLimit = 4600;
    const scaleForLimit = longestSide > 0 ? pixelLimit / longestSide : preferredScale;
    const scaleForMemory = Math.sqrt(
        (Math.max(2, maximumMegapixels) * 1_000_000) /
            Math.max(1, viewport.width * viewport.height)
    );
    return clamp(
        Math.min(preferredScale, scaleForLimit, scaleForMemory),
        1.1,
        preferredScale
    );
}

async function renderPage(page, scale) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", {
        alpha: false,
        willReadFrequently: false,
    });

    if (!context) {
        throw new Error("El navegador no pudo crear el lienzo de conversión.");
    }

    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    context.save();
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();

    await page.render({ canvasContext: context, canvas, viewport }).promise;

    return { canvas, viewport };
}

async function canvasToPng(canvas) {
    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => {
            if (result) {
                resolve(result);
            } else {
                reject(new Error("No se pudo codificar la página como imagen PNG."));
            }
        }, "image/png");
    });

    return new Uint8Array(await blob.arrayBuffer());
}

function releaseCanvas(canvas) {
    if (!canvas) {
        return;
    }

    canvas.width = 1;
    canvas.height = 1;
    canvas.remove();
}

function throwIfCancelled(isCancelled, signal) {
    if (isCancelled?.() || signal?.aborted) {
        throw new DOMException("Conversión cancelada.", "AbortError");
    }
}

function cropCanvas(sourceCanvas, region, renderedScale) {
    const sourceX = Math.max(0, Math.floor(region.x * renderedScale));
    const sourceY = Math.max(0, Math.floor(region.y * renderedScale));
    const sourceWidth = Math.min(
        sourceCanvas.width - sourceX,
        Math.max(1, Math.ceil(region.width * renderedScale))
    );
    const sourceHeight = Math.min(
        sourceCanvas.height - sourceY,
        Math.max(1, Math.ceil(region.height * renderedScale))
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, sourceWidth);
    canvas.height = Math.max(1, sourceHeight);
    const context = canvas.getContext("2d", { alpha: false });
    context?.drawImage(
        sourceCanvas,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        sourceWidth,
        sourceHeight
    );
    return canvas;
}

function offsetOCRContent(content, region) {
    const words = content.words.map((word) => ({
        ...word,
        x: word.x + region.x,
        y: word.y + region.y,
    }));
    return { ...content, words, lines: buildLinesFromWords(words) };
}

async function recognizeHybridRegions({
    canvas,
    regions,
    renderedScale,
    dpi,
    reportProgress,
    signal,
    dictionary,
    waitIfPaused,
    experimentalHandwriting,
}) {
    const results = [];
    const metadata = [];
    const usableRegions = regions.filter(
        (region) => region.width * region.height >= 1_200
    );

    for (let index = 0; index < usableRegions.length; index += 1) {
        await waitIfPaused?.();
        throwIfCancelled(null, signal);
        const region = usableRegions[index];
        const regionCanvas = cropCanvas(canvas, region, renderedScale);
        try {
            const result = await recognizeAdaptive(regionCanvas, {
                dpi,
                signal,
                dictionary,
                regionType: region.strategy === "handwriting-ocr"
                    ? "handwriting"
                    : region.width > region.height * 3
                      ? "sparse-text"
                      : "text",
                experimentalHandwriting:
                    experimentalHandwriting || region.strategy === "handwriting-ocr",
                onProgress: (message) => {
                    const fraction = (index + (Number(message.progress) || 0)) /
                        Math.max(1, usableRegions.length);
                    reportProgress(
                        0.25 + fraction * 0.5,
                        "region-ocr",
                        `OCR selectivo: región ${index + 1} de ${usableRegions.length}…`
                    );
                },
            });
            results.push(offsetOCRContent(normalizeOCRContent(result, renderedScale), region));
            metadata.push({
                language: result.language,
                attempts: result.attempts || [],
                correctionCount: result.correctionCount || 0,
                selectedVariant: result.selectedVariant,
            });
        } finally {
            releaseCanvas(regionCanvas);
        }
    }

    const words = results.flatMap((result) => result.words);
    return {
        text: words.map((word) => word.text).join(" "),
        words,
        lines: buildLinesFromWords(words),
        blocks: [],
        paragraphs: [],
        confidence: results.length
            ? results.reduce((sum, result) => sum + Number(result.confidence || 0), 0) /
                results.length
            : 0,
        source: "ocr-regions",
        regionCount: results.length,
        language: metadata.find((entry) => entry.language !== "unknown")?.language ||
            "unknown",
        attempts: metadata.flatMap((entry) => entry.attempts),
        correctionCount: metadata.reduce(
            (total, entry) => total + entry.correctionCount,
            0
        ),
        selectedVariants: metadata.map((entry) => entry.selectedVariant).filter(Boolean),
    };
}

function refinePageType(
    detectedType,
    {
        imageCount = 0,
        nativeImageCount = 0,
        vectorObjectCount = 0,
        secondaryWordCount = 0,
    } = {}
) {
    const vectorDocumentWithoutRaster =
        detectedType.type === "hybrid" &&
        nativeImageCount === 0 &&
        secondaryWordCount > 0 &&
        (vectorObjectCount >= 12 || secondaryWordCount >= 2);

    if (vectorDocumentWithoutRaster) {
        return {
            ...detectedType,
            type: "digital",
            confidence: Math.max(0.9, detectedType.confidence),
            reason:
                "La estructura PDF confirma texto y gráficos vectoriales sin imágenes rasterizadas.",
        };
    }

    const hasRasterEvidence = nativeImageCount > 0 || vectorObjectCount < 12;
    const imageDominantWithLimitedText =
        imageCount > 0 &&
        hasRasterEvidence &&
        detectedType.type === "digital" &&
        detectedType.characterCount < 250 &&
        detectedType.textDensity < 0.012;

    if (!imageDominantWithLimitedText) {
        return detectedType;
    }

    return {
        ...detectedType,
        type: "hybrid",
        confidence: Math.max(0.7, Math.min(0.92, detectedType.confidence)),
        reason:
            "La página combina una imagen dominante con una capa de texto nativo limitada.",
    };
}

function calculateQualityScore({ pageType, analysis, content }) {
    if (!content.words.length) {
        return 0;
    }

    if (pageType.type === "digital") {
        const textSignal = Math.min(1, pageType.characterCount / 500);
        return Math.round((0.88 + textSignal * 0.11) * 100);
    }

    const confidence = Math.max(0, Math.min(100, analysis.statistics.averageConfidence));
    const densitySignal = Math.min(1, analysis.statistics.textDensity / 8);
    return Math.round(confidence * 0.85 + densitySignal * 15);
}

function createProgressReporter(onProgress, pageIndex, pageCount, pageNumber, startedAt) {
    const start = 8;
    const available = 82;
    const pageSpan = available / Math.max(1, pageCount);

    return (fraction, stage, detail = "") => {
        const completedPages = pageIndex + clamp(fraction, 0, 1);
        const elapsed = now() - startedAt;
        const etaMs = completedPages > 0
            ? Math.max(0, (elapsed / completedPages) * (pageCount - completedPages))
            : null;
        onProgress?.({
            percent: Math.round(
                start + pageIndex * pageSpan + clamp(fraction, 0, 1) * pageSpan
            ),
            stage,
            detail,
            pageNumber,
            pageCount,
            etaMs: etaMs === null ? null : Math.round(etaMs),
        });
    };
}

function summarizeDocument(pages, startedAt, initialHeap, peakCanvasPixels, mode) {
    const durationMs = Math.max(1, now() - startedAt);
    const counts = { digital: 0, scanned: 0, hybrid: 0 };
    let nativeCharacters = 0;
    let ocrCharacters = 0;
    let wordCount = 0;
    let imageCount = 0;
    let embeddedImageCount = 0;
    let tableCount = 0;
    let regionCount = 0;
    let formFieldCount = 0;
    let lowConfidenceRegions = 0;
    let rotatedTextRegions = 0;
    let visualRegionCount = 0;
    let protectedVisualRegions = 0;
    let cleanedBackgroundWords = 0;
    let neuralVisionPages = 0;
    let neuralFallbackPages = 0;
    let neuralFormulaRegions = 0;
    let neuralTableRegions = 0;
    let handwritingRegions = 0;
    let secondaryNativePages = 0;
    let secondaryNativeTables = 0;
    let cacheHits = 0;
    let qualityTotal = 0;

    pages.forEach((page) => {
        counts[page.pageType.type] += 1;
        nativeCharacters += page.metrics.nativeCharacters;
        ocrCharacters += page.metrics.ocrCharacters;
        wordCount += page.metrics.wordCount;
        imageCount += page.metrics.imageCount;
        embeddedImageCount += page.metrics.embeddedImageCount;
        tableCount += page.metrics.tableCount;
        regionCount += page.metrics.regionCount || 0;
        formFieldCount += page.metrics.formFieldCount || 0;
        lowConfidenceRegions += page.metrics.lowConfidenceRegions || 0;
        rotatedTextRegions += page.regionAnalysis?.rotatedTextRegions || 0;
        visualRegionCount += page.vision?.regions?.length || 0;
        protectedVisualRegions += page.vision?.routing?.protectedRegions?.length || 0;
        cleanedBackgroundWords += page.editableBackground?.removedWordCount || 0;
        neuralVisionPages += page.vision?.neural?.status === "connected" ? 1 : 0;
        neuralFallbackPages += page.vision?.neural?.status === "fallback" ? 1 : 0;
        neuralFormulaRegions += page.analysis?.visionLayout?.formulaCount || 0;
        neuralTableRegions += page.analysis?.visionLayout?.tableCount || 0;
        handwritingRegions += page.analysis?.visionLayout?.handwritingCount || 0;
        secondaryNativePages += page.metrics.nativeExtractor === "pdfplumber" ? 1 : 0;
        secondaryNativeTables += page.metrics.secondaryNativeTableCount || 0;
        cacheHits += page.metrics.cacheHit ? 1 : 0;
        qualityTotal += page.metrics.qualityScore;
    });

    const finalHeap = getHeapSize();

    return {
        mode,
        pageCount: pages.length,
        pageTypes: counts,
        durationMs: Math.round(durationMs),
        pagesPerMinute: Number(((pages.length * 60000) / durationMs).toFixed(2)),
        nativeCharacters,
        ocrCharacters,
        wordCount,
        imageCount,
        embeddedImageCount,
        tableCount,
        regionCount,
        formFieldCount,
        lowConfidenceRegions,
        rotatedTextRegions,
        visualRegionCount,
        protectedVisualRegions,
        cleanedBackgroundWords,
        neuralVisionPages,
        neuralFallbackPages,
        neuralFormulaRegions,
        neuralTableRegions,
        handwritingRegions,
        secondaryNativePages,
        secondaryNativeTables,
        cacheHits,
        cache: getConversionCacheStats(),
        estimatedQuality: pages.length
            ? Math.round(qualityTotal / pages.length)
            : 0,
        peakCanvasMegapixels: Number((peakCanvasPixels / 1_000_000).toFixed(2)),
        memoryDeltaMB:
            initialHeap !== null && finalHeap !== null
                ? Number(((finalHeap - initialHeap) / 1024 / 1024).toFixed(2))
                : null,
    };
}

function zoneSignature(zone) {
    return (zone?.lines || [])
        .map((line) => String(line.text || ""))
        .join(" ")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\d+/g, "#")
        .replace(/[^a-z0-9#]+/gi, " ")
        .trim()
        .toLowerCase();
}

function stabilizeHeaderAndFooterZones(pages) {
    const frequencies = { header: new Map(), footer: new Map() };

    pages.forEach((page) => {
        ["header", "footer"].forEach((type) => {
            const zone = page.analysis.zones.find((candidate) => candidate.type === type);
            const signature = zoneSignature(zone);
            if (signature) {
                frequencies[type].set(
                    signature,
                    (frequencies[type].get(signature) || 0) + 1
                );
            }
        });
    });

    const repetitionThreshold = Math.max(2, Math.ceil(pages.length * 0.3));

    pages.forEach((page) => {
        const acceptedZones = [];

        ["header", "footer"].forEach((type) => {
            const zone = page.analysis.zones.find((candidate) => candidate.type === type);
            if (!zone) {
                return;
            }

            const signature = zoneSignature(zone);
            const repeated =
                pages.length > 1 &&
                signature &&
                (frequencies[type].get(signature) || 0) >= repetitionThreshold;
            const boxTop = Number(zone.bbox?.y) || 0;
            const boxBottom = boxTop + (Number(zone.bbox?.height) || 0);
            const extremeMargin =
                type === "header"
                    ? boxTop <= page.dimensions.height * 0.035
                    : boxBottom >= page.dimensions.height * 0.965;

            if (repeated || extremeMargin) {
                acceptedZones.push(zone);
            }
        });

        const reservedLines = new Set(
            acceptedZones.flatMap((zone) => zone.lines || [])
        );
        const bodyLines = page.analysis.lines.filter((line) => !reservedLines.has(line));
        const bodyZone = bodyLines.length
            ? {
                type: "body",
                lines: bodyLines,
                bbox: page.analysis.spatial.textBox,
            }
            : null;

        page.analysis.zones = [...acceptedZones, ...(bodyZone ? [bodyZone] : [])];
        page.analysis.layout.hasHeader = acceptedZones.some(
            (zone) => zone.type === "header"
        );
        page.analysis.layout.hasFooter = acceptedZones.some(
            (zone) => zone.type === "footer"
        );
    });
}

function clonePage(page) {
    return typeof structuredClone === "function" ? structuredClone(page) : page;
}

export async function processPDFForWord(
    file,
    {
        mode = "editable",
        ocrMode = "auto",
        onProgress,
        isCancelled,
        signal,
        pageRange = "all",
        excludeImages = false,
        maximumCanvasMegapixels = 20,
        ocrDictionary = [],
        useCache = true,
        cacheMemoryMB = 96,
        waitIfPaused,
        experimentalHandwriting = false,
        advancedVision = true,
        cleanEditableBackground = true,
        visionProvider = "auto",
        visionEndpoint = "http://127.0.0.1:8765/v1/layout",
        visionTimeoutMs = 120_000,
        persistentProcessing = true,
        persistentStorageMB = 1024,
        resumeSessionId = null,
    } = {}
) {
    if (!file) {
        throw new Error("Selecciona un archivo PDF primero.");
    }

    const resourceBudget = resolveClientResourceBudget({
        requestedCanvasMegapixels: maximumCanvasMegapixels,
        requestedCacheMB: cacheMemoryMB,
        requestedPersistentMB: persistentStorageMB,
    });
    maximumCanvasMegapixels = resourceBudget.maximumCanvasMegapixels;
    cacheMemoryMB = resourceBudget.cacheMemoryMB;
    persistentStorageMB = resourceBudget.persistentStorageMB;

    const startedAt = now();
    if (!OCR_MODES.includes(ocrMode)) throw new Error("Selecciona una opción OCR válida.");
    const initialHeap = getHeapSize();
    const pdfjsLib = await getPdfjs();
    onProgress?.({ percent: 3, stage: "loading", detail: "Abriendo el PDF…" });

    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const selectedPages = normalizePageRange(pageRange, pdf.numPages);
    if (!selectedPages.length) {
        await loadingTask.destroy();
        throw new Error("El rango de páginas seleccionado no contiene páginas válidas.");
    }
    const pages = [];
    let peakCanvasPixels = 0;
    let secondaryNativeDocument = null;
    let registeredNativeDocument = null;
    let persistentSession = null;
    let persistenceError = null;
    const cacheOptions = {
        mode, ocrMode, ocrDictionary, experimentalHandwriting, maximumCanvasMegapixels,
        extractImages: !excludeImages, advancedVision, cleanEditableBackground,
        visionProvider, visionEndpoint,
        visionVersion: "3.27.0-font-resources",
    };
    const cacheKeys = new Map(selectedPages.map((pageNumber) => [
        pageNumber, createPageCacheKey(file, pageNumber, cacheOptions),
    ]));
    const cachedPages = new Map();
    if (persistentProcessing) {
        try {
            const persistence = await createOrResumeConversionSession(
                file,
                { ...cacheOptions, pageRange, persistentStorageMB },
                selectedPages,
                {
                    sessionId: resumeSessionId,
                    maximumBytes: Math.max(128, Number(persistentStorageMB) || 1024) * 1024 * 1024,
                }
            );
            persistentSession = persistence.session;
            const checkpoints = await loadPageCheckpoints(
                persistentSession.id,
                selectedPages
            );
            checkpoints.forEach((page, pageNumber) => cachedPages.set(pageNumber, page));
            if (checkpoints.size) {
                onProgress?.({
                    percent: 4,
                    stage: "resume",
                    detail: `Reanudando ${checkpoints.size} página(s) desde almacenamiento persistente…`,
                });
            }
        } catch (error) {
            persistenceError = error;
            console.warn("Persistencia de conversión no disponible:", error);
        }
    }
    if (useCache) {
        selectedPages.forEach((pageNumber) => {
            if (cachedPages.has(pageNumber)) return;
            const cached = getCachedPage(cacheKeys.get(pageNumber));
            if (cached) cachedPages.set(pageNumber, cached);
        });
    }
    const pagesRequiringExtraction = selectedPages.filter(
        (pageNumber) => !cachedPages.has(pageNumber)
    );
    const documentResourceCacheKey = createDocumentResourceCacheKey(file, cacheOptions);
    const cachedDocumentResources = useCache
        ? getCachedDocumentResources(documentResourceCacheKey)
        : null;

    if (
        cleanEditableBackground &&
        advancedVision &&
        visionProvider !== "local" &&
        mode !== "visual"
    ) {
        try {
            registeredNativeDocument = await registerNativeDocument(file, {
                endpoint: visionEndpoint,
                timeoutMs: Math.min(visionTimeoutMs, 60_000),
                signal,
            });
        } catch (error) {
            console.warn("Registro único del PDF no disponible; se usará compatibilidad:", error);
        }
    }

    if (advancedVision && visionProvider !== "local" && selectedPages.length) {
        onProgress?.({
            percent: 5,
            stage: "native-structure",
            detail: "Verificando fuentes, vectores y tablas con el segundo extractor…",
        });
        secondaryNativeDocument = await extractNativeDocumentInBatches(
            file,
            pagesRequiringExtraction.length
                ? pagesRequiringExtraction
                : cachedDocumentResources
                  ? []
                  : [selectedPages[0]],
            (source, batch, batchOptions) => extractNativeDocumentStructure(source, {
                pages: batch, endpoint: visionEndpoint, signal,
                includeFonts: batchOptions.includeFonts,
                fontScope: batchOptions.fontScope,
                timeoutMs: Math.min(visionTimeoutMs, 45_000),
                documentId: registeredNativeDocument?.documentId,
            }),
            {
                batchSize: 100,
                signal,
                onBatch: ({ completed, total }) => onProgress?.({
                    percent: 5,
                    stage: "native-structure",
                    detail: total
                        ? `Analizando estructura nativa por lotes: ${completed}/${total} páginas…`
                        : "Verificando estructura nativa…",
                }),
            }
        );
        if (!secondaryNativeDocument.embeddedFonts.length && cachedDocumentResources) {
            secondaryNativeDocument = {
                ...secondaryNativeDocument,
                ...cachedDocumentResources,
            };
        } else if (secondaryNativeDocument.embeddedFonts.length && useCache) {
            setCachedDocumentResources(
                documentResourceCacheKey,
                {
                    provider: secondaryNativeDocument.provider,
                    version: secondaryNativeDocument.version,
                    pageCount: secondaryNativeDocument.pageCount,
                    fontScope: secondaryNativeDocument.fontScope,
                    fontPageCount: secondaryNativeDocument.fontPageCount,
                    embeddedFonts: secondaryNativeDocument.embeddedFonts,
                },
                Math.max(16, cacheMemoryMB) * 1024 * 1024
            );
        }
    }

    try {
        for (let pageIndex = 0; pageIndex < selectedPages.length; pageIndex += 1) {
            await waitIfPaused?.();
            throwIfCancelled(isCancelled, signal);
            const pageNumber = selectedPages[pageIndex];
            const reportProgress = createProgressReporter(
                onProgress,
                pageIndex,
                selectedPages.length,
                pageNumber,
                startedAt
            );
            const cacheKey = cacheKeys.get(pageNumber);
            const cachedPage = cachedPages.get(pageNumber) || null;

            if (cachedPage) {
                const reusedPage = clonePage(cachedPage);
                reusedPage.metrics = {
                    ...reusedPage.metrics,
                    durationMs: 0,
                    cacheHit: true,
                };
                pages.push(reusedPage);
                reportProgress(
                    1,
                    "cache",
                    `Página ${pageNumber} recuperada de la caché.`
                );
                continue;
            }

            const pageStartedAt = now();
            const page = await pdf.getPage(pageNumber);

            try {
                const viewport = page.getViewport({ scale: 1 });
                reportProgress(0.05, "analyzing", "Detectando regiones y tipo de página…");
                throwIfCancelled(isCancelled, signal);

                const textContent = await page.getTextContent({
                    includeMarkedContent: true,
                    disableNormalization: false,
                });
                const detectedPageType = detectPageType({
                    textItems: textContent.items,
                    width: viewport.width,
                    height: viewport.height,
                });
                const primaryNativeContent = normalizeNativeContent(textContent, viewport);
                const secondaryNativePageRaw = secondaryNativeDocument?.pages?.get(pageNumber);
                const secondaryNativePageNormalized = secondaryNativePageRaw
                    ? normalizeStructuredNativePage(secondaryNativePageRaw, {
                        width: viewport.width,
                        height: viewport.height,
                    })
                    : null;
                const secondaryNativePage = secondaryNativePageNormalized
                    ? {
                        ...secondaryNativePageNormalized,
                        tables: repairNativeTableText(
                            secondaryNativePageNormalized.tables,
                            primaryNativeContent
                        ),
                    }
                    : null;
                const nativeContent = selectBestNativeContent(
                    primaryNativeContent,
                    secondaryNativePage?.content
                );
                const imageInspection = await inspectPageImages(page, pdfjsLib, viewport);
                const imageCount = imageInspection.count;
                const originalPageType = refinePageType(detectedPageType, {
                    imageCount,
                    nativeImageCount: secondaryNativePage?.images?.length || 0,
                    vectorObjectCount: secondaryNativePage?.vectorObjects?.length || 0,
                    artworkRequiresCompositing: secondaryNativePage?.artworkRequiresCompositing,
                    secondaryWordCount: secondaryNativePage?.content?.words?.length || 0,
                });
                const ocrPolicy = resolveOCRPolicy({
                    ocrMode, mode, pageType: originalPageType.type,
                    nativeWordCount: nativeContent.words.length,
                    pageNumber,
                    isBlank: nativeContent.words.length === 0 &&
                        (await page.getOperatorList()).fnArray.length === 0,
                });
                // Forced OCR must not merge the old text layer or native table text
                // back into the recognized result.
                const pageType = ocrPolicy.forceOCR
                    ? { ...originalPageType, type: "scanned" }
                    : originalPageType;
                const vectorTables = pageType.type === "scanned"
                    ? []
                    : await extractVectorTables(
                        page,
                        pdfjsLib,
                        viewport,
                        nativeContent.words
                    );
                const nativeTables = pageType.type === "scanned"
                    ? []
                    : [
                        ...(secondaryNativePage?.tables || []),
                        ...vectorTables,
                    ];
                const editableLayout = chooseEditableLayout({
                    mode,
                    pageType,
                    nativeContent,
                    nativePage: { ...secondaryNativePage, tables: nativeTables },
                });
                let pageContent = nativeContent;
                let renderedPage = null;
                let extractedImages = [];
                const nativeEmbeddedImages = (secondaryNativePage?.images || []).filter(
                    (image) => image.data?.length
                );
                const needsPositionedBackground = needsCleanPositionedBackground({
                    editableLayout,
                    tables: nativeTables,
                    vectorObjectCount: secondaryNativePage?.vectorObjects?.length || 0,
                    artworkRequiresCompositing:
                        secondaryNativePage?.artworkRequiresCompositing === true,
                });
                let extractionMethod = nativeContent.source === "native-secondary"
                    ? "native-cross-validated"
                    : "native";
                let ocrCharacters = 0;
                let visionAnalysis = null;
                let editableBackground = null;
                let ocrMetadata = {
                    language: "unknown",
                    attempts: [],
                    correctionCount: 0,
                    selectedVariants: [],
                };

                if (mode === "visual") {
                    const renderScale = calculateRenderScale(
                        viewport,
                        2,
                        maximumCanvasMegapixels
                    );
                    reportProgress(0.24, "rendering", "Capturando la página visual exacta…");
                    const rendered = await renderPage(page, renderScale);
                    try {
                        peakCanvasPixels = Math.max(
                            peakCanvasPixels,
                            rendered.canvas.width * rendered.canvas.height
                        );
                        renderedPage = {
                            data: await canvasToPng(rendered.canvas),
                            type: "png",
                            width: viewport.width,
                            height: viewport.height,
                            pixelWidth: rendered.canvas.width,
                            pixelHeight: rendered.canvas.height,
                        };
                    } finally {
                        releaseCanvas(rendered.canvas);
                    }
                    extractionMethod = "visual-snapshot";
                } else if (ocrPolicy.useOCR) {
                    const renderScale = calculateRenderScale(
                        viewport,
                        3,
                        maximumCanvasMegapixels
                    );
                    reportProgress(0.18, "rendering", "Preparando regiones para OCR adaptativo…");
                    const rendered = await renderPage(page, renderScale);
                    try {
                        peakCanvasPixels = Math.max(
                            peakCanvasPixels,
                            rendered.canvas.width * rendered.canvas.height
                        );
                        const dpi = Math.round(renderScale * 72);
                        let normalizedOCR;

                        if (advancedVision) {
                            reportProgress(
                                0.22,
                                "vision",
                                "Separando texto, firmas, sellos, manchas y elementos visuales…"
                            );
                            visionAnalysis = await analyzePageWithVision(rendered.canvas, {
                                provider: visionProvider,
                                endpoint: visionEndpoint,
                                pageWidth: viewport.width,
                                pageHeight: viewport.height,
                                signal,
                                timeoutMs: visionTimeoutMs,
                            });

                            if (pageType.type === "scanned") {
                                const neuralContent = neuralVisionToContent(visionAnalysis);
                                if (neuralContent.words.length >= 4) {
                                    normalizedOCR = neuralContent;
                                    extractionMethod = "neural-layout-ocr";
                                    ocrMetadata = {
                                        language: "auto",
                                        attempts: [],
                                        correctionCount: 0,
                                        selectedVariants: [
                                            visionAnalysis.model || visionAnalysis.provider,
                                        ].filter(Boolean),
                                    };
                                }
                            }
                        }

                        if (pageType.type === "hybrid" && imageInspection.regions.length) {
                            normalizedOCR = await recognizeHybridRegions({
                                canvas: rendered.canvas,
                                regions: imageInspection.regions,
                                renderedScale: renderScale,
                                dpi,
                                reportProgress,
                                signal,
                                dictionary: ocrDictionary,
                                waitIfPaused,
                                experimentalHandwriting,
                            });
                            ocrMetadata = {
                                language: normalizedOCR.language,
                                attempts: normalizedOCR.attempts,
                                correctionCount: normalizedOCR.correctionCount,
                                selectedVariants: normalizedOCR.selectedVariants,
                            };
                        }

                        if (
                            pageType.type === "scanned" &&
                            visionAnalysis?.routing.strategy === "regional"
                        ) {
                            const visualOCRRegions = getNeuralFallbackRegions(visionAnalysis).map(
                                (region) => ({
                                    ...region.bbox,
                                    visualRegionId: region.id,
                                    strategy: region.strategy,
                                    type: region.type,
                                })
                            );
                            if (visualOCRRegions.length) {
                                const regionalOCR = await recognizeHybridRegions({
                                    canvas: rendered.canvas,
                                    regions: visualOCRRegions,
                                    renderedScale: renderScale,
                                    dpi,
                                    reportProgress,
                                    signal,
                                    dictionary: ocrDictionary,
                                    waitIfPaused,
                                    experimentalHandwriting,
                                });
                                if (
                                    regionalOCR.words.length >= 4 &&
                                    Number(regionalOCR.confidence) >= 45
                                ) {
                                    normalizedOCR = fuseNeuralTextWithOCR(
                                        regionalOCR,
                                        visionAnalysis
                                    );
                                    extractionMethod = normalizedOCR.neuralWordCount
                                        ? "neural-layout+region-ocr"
                                        : "vision-region-ocr";
                                    ocrMetadata = {
                                        language: regionalOCR.language,
                                        attempts: regionalOCR.attempts,
                                        correctionCount: regionalOCR.correctionCount,
                                        selectedVariants: regionalOCR.selectedVariants,
                                    };
                                }
                            }
                        }

                        if (!normalizedOCR || normalizedOCR.words.length < 4) {
                            await waitIfPaused?.();
                            const adaptiveResult = await recognizeAdaptive(rendered.canvas, {
                                dpi,
                                signal,
                                dictionary: ocrDictionary,
                                onProgress: (ocrProgress) => {
                                    const fraction = Number(ocrProgress?.progress);
                                    reportProgress(
                                        0.25 +
                                            (Number.isFinite(fraction) ? fraction : 0) *
                                                0.55,
                                        "ocr",
                                        pageType.type === "scanned"
                                            ? "Reconociendo texto escaneado…"
                                            : "Completando regiones híbridas…"
                                    );
                                },
                                experimentalHandwriting,
                            });
                            normalizedOCR = normalizeOCRContent(
                                adaptiveResult,
                                renderScale
                            );
                            ocrMetadata = {
                                language: adaptiveResult.language,
                                attempts: adaptiveResult.attempts || [],
                                correctionCount: adaptiveResult.correctionCount || 0,
                                selectedVariants: [adaptiveResult.selectedVariant].filter(Boolean),
                            };
                        }

                        normalizedOCR = fuseNeuralTextWithOCR(
                            normalizedOCR,
                            visionAnalysis
                        );

                        ocrCharacters = countCharacters(normalizedOCR);

                        const recoverableImageRegions = selectRecoverableVisualRegions(
                            visionAnalysis,
                            imageInspection.regions,
                            { width: viewport.width, height: viewport.height }
                        );
                        if (!excludeImages && recoverableImageRegions.length) {
                            extractedImages = await cropPageImageRegions(
                                rendered.canvas,
                                recoverableImageRegions,
                                renderScale
                            );
                        }

                        if (
                            mode === "fidelity" &&
                            pageType.type === "scanned" &&
                            !excludeImages &&
                            cleanEditableBackground &&
                            normalizedOCR?.words?.length
                        ) {
                            const cleaned = createEditableBackground(
                                rendered.canvas,
                                normalizedOCR.words,
                                selectCleanPlateProtectedRegions(
                                    visionAnalysis?.routing?.protectedRegions,
                                    { width: viewport.width, height: viewport.height }
                                ),
                                {
                                    renderedScale: renderScale,
                                    pageWidth: viewport.width,
                                    pageHeight: viewport.height,
                                }
                            );
                            try {
                                renderedPage = {
                                    data: await canvasToPng(cleaned.canvas),
                                    type: "png",
                                    width: viewport.width,
                                    height: viewport.height,
                                    pixelWidth: cleaned.canvas.width,
                                    pixelHeight: cleaned.canvas.height,
                                    role: "clean-editable-background",
                                };
                                editableBackground = cleaned.metadata;
                            } finally {
                                releaseCanvas(cleaned.canvas);
                            }
                        }

                        if (
                            mode === "fidelity" &&
                            pageType.type === "scanned" &&
                            !excludeImages
                        ) {
                            renderedPage = renderedPage || {
                                data: await canvasToPng(rendered.canvas),
                                type: "png",
                                width: viewport.width,
                                height: viewport.height,
                                pixelWidth: rendered.canvas.width,
                                pixelHeight: rendered.canvas.height,
                                role: "editable-background",
                            };
                        }

                        if (pageType.type === "hybrid") {
                            pageContent = mergeNativeAndOCR(nativeContent, normalizedOCR);
                            extractionMethod = normalizedOCR.neuralWordCount
                                ? "native+neural-layout"
                                : "native+region-ocr";
                        } else {
                            pageContent = normalizedOCR;
                            extractionMethod = extractionMethod === "vision-region-ocr"
                                ? extractionMethod
                                : "adaptive-ocr";
                        }

                        if (
                            mode === "fidelity" &&
                            pageType.type === "hybrid" &&
                            !excludeImages &&
                            cleanEditableBackground &&
                            pageContent.words.length
                        ) {
                            const cleaned = createEditableBackground(
                                rendered.canvas,
                                pageContent.words,
                                selectCleanPlateProtectedRegions(
                                    visionAnalysis?.routing?.protectedRegions,
                                    { width: viewport.width, height: viewport.height }
                                ),
                                {
                                    renderedScale: renderScale,
                                    pageWidth: viewport.width,
                                    pageHeight: viewport.height,
                                }
                            );
                            try {
                                renderedPage = {
                                    data: await canvasToPng(cleaned.canvas),
                                    type: "png",
                                    width: viewport.width,
                                    height: viewport.height,
                                    pixelWidth: cleaned.canvas.width,
                                    pixelHeight: cleaned.canvas.height,
                                    role: "clean-editable-background",
                                };
                                editableBackground = cleaned.metadata;
                            } finally {
                                releaseCanvas(cleaned.canvas);
                            }
                        }
                    } finally {
                        releaseCanvas(rendered.canvas);
                    }
                } else if (
                    !excludeImages &&
                    (
                        imageInspection.regions.length ||
                        mode === "fidelity" ||
                        needsPositionedBackground
                    )
                ) {
                    if (
                        mode === "editable" &&
                        editableLayout !== "positioned" &&
                        !needsPositionedBackground &&
                        nativeEmbeddedImages.length
                    ) {
                        reportProgress(
                            0.68,
                            "images",
                            "Recuperando firmas e imágenes originales…"
                        );
                        extractedImages = nativeEmbeddedImages;
                    } else {
                        const renderScale = calculateRenderScale(
                            viewport,
                            2,
                            maximumCanvasMegapixels
                        );
                        reportProgress(0.68, "images", "Clasificando y recuperando imágenes…");
                        const rendered = await renderPage(page, renderScale);
                        try {
                        peakCanvasPixels = Math.max(
                            peakCanvasPixels,
                            rendered.canvas.width * rendered.canvas.height
                        );
                        if (imageInspection.regions.length) {
                            if (nativeContent.words.length) {
                                const cleanedImages = createEditableBackground(
                                    rendered.canvas,
                                    nativeContent.words,
                                    [],
                                    {
                                        renderedScale: renderScale,
                                        pageWidth: viewport.width,
                                        pageHeight: viewport.height,
                                        padding: 0.25,
                                    }
                                );
                                try {
                                    extractedImages = (
                                        await cropPageImageRegions(
                                            cleanedImages.canvas,
                                            imageInspection.regions,
                                            renderScale
                                        )
                                    ).map((image) => ({
                                        ...image,
                                        cleanedTextLayer: true,
                                    }));
                                } finally {
                                    releaseCanvas(cleanedImages.canvas);
                                }
                            } else {
                                extractedImages = await cropPageImageRegions(
                                    rendered.canvas,
                                    imageInspection.regions,
                                    renderScale
                                );
                            }
                        }
                        if (
                            (mode === "fidelity" || needsPositionedBackground) &&
                            cleanEditableBackground &&
                            nativeContent.words.length
                        ) {
                            let nativeBackground = null;
                            if (
                                needsPositionedBackground &&
                                advancedVision &&
                                visionProvider !== "local"
                            ) {
                                try {
                                    nativeBackground = await fetchNativeCleanBackground(file, {
                                        pageNumber,
                                        endpoint: visionEndpoint,
                                        dpi: 144,
                                        timeoutMs: Math.min(visionTimeoutMs, 45_000),
                                        signal,
                                        documentId: registeredNativeDocument?.documentId,
                                    });
                                } catch {
                                    // El limpiador local del navegador sigue siendo una
                                    // recuperación válida si el servicio no está disponible.
                                }
                            }
                            if (nativeBackground) {
                                renderedPage = nativeBackground;
                                editableBackground = {
                                    provider: nativeBackground.provider,
                                    strategy: nativeBackground.strategy,
                                    removedWordCount: nativeBackground.removedWordCount,
                                    maskedPixelRatio: nativeBackground.maskedPixelRatio,
                                };
                            } else {
                                const cleaned = createEditableBackground(
                                    rendered.canvas,
                                    nativeContent.words,
                                    [],
                                    {
                                        renderedScale: renderScale,
                                        pageWidth: viewport.width,
                                        pageHeight: viewport.height,
                                    }
                                );
                                try {
                                    renderedPage = {
                                        data: await canvasToPng(cleaned.canvas),
                                        type: "png",
                                        width: viewport.width,
                                        height: viewport.height,
                                        pixelWidth: cleaned.canvas.width,
                                        pixelHeight: cleaned.canvas.height,
                                        role: "clean-editable-background",
                                    };
                                    editableBackground = cleaned.metadata;
                                } finally {
                                    releaseCanvas(cleaned.canvas);
                                }
                            }
                        }
                        } finally {
                            releaseCanvas(rendered.canvas);
                        }
                    }
                }

                throwIfCancelled(isCancelled, signal);
                reportProgress(0.86, "layout", "Reconstruyendo regiones, tablas y lectura…");
                const baseAnalysis = analyzePage({
                        pageNumber,
                        width: viewport.width,
                        height: viewport.height,
                        words: pageContent.words,
                        lines: pageContent.lines,
                        blocks: pageContent.blocks,
                        paragraphs: pageContent.paragraphs,
                    });
                const analysis = enhancePageTables(
                    mergeVectorTablesWithAnalysis(
                        mergeVisionLayoutWithAnalysis(baseAnalysis, visionAnalysis),
                        nativeTables
                    ),
                    pageContent.words
                );
                const formFields = detectFormFields(analysis.lines);
                const regionAnalysis = analyzePageRegions({
                    pageNumber,
                    dimensions: { width: viewport.width, height: viewport.height },
                    analysis,
                    images: extractedImages,
                    pageType,
                    visualRegions: visionAnalysis?.routing?.protectedRegions || [],
                });
                const nativeCharacters = countCharacters(nativeContent);
                const qualityScore =
                    mode === "visual"
                        ? 100
                        : calculateQualityScore({
                            pageType,
                            analysis,
                            content: pageContent,
                        });
                const pageResult = {
                    pageNumber,
                    originalPageType,
                    ocrMode,
                    dimensions: { width: viewport.width, height: viewport.height },
                    pageType,
                    extractionMethod,
                    content: pageContent,
                    analysis,
                    regionAnalysis,
                    formFields,
                    images: extractedImages,
                    renderedPage,
                    vision: visionAnalysis,
                    editableBackground,
                    editableLayout,
                    ocr: ocrMetadata,
                    review: {
                        strategy: "automatic",
                        excludeHeader: false,
                        excludeFooter: false,
                        excludeImages,
                        correctedText: "",
                    },
                    metrics: {
                        durationMs: Math.round(now() - pageStartedAt),
                        nativeCharacters,
                        ocrCharacters,
                        wordCount: pageContent.words.length,
                        imageCount,
                        embeddedImageCount:
                            extractedImages.length + (renderedPage ? 1 : 0),
                        tableCount: analysis.tables.length,
                        vectorTableCount: vectorTables.length,
                        secondaryNativeTableCount:
                            secondaryNativePage?.tables?.length || 0,
                        secondaryNativeWordCount:
                            secondaryNativePage?.content?.words?.length || 0,
                        nativeExtractor:
                            nativeContent.source === "native-secondary"
                                ? "pdfplumber"
                                : "pdfjs",
                        nativeExtractorStatus:
                            secondaryNativeDocument?.error
                                ? "fallback"
                                : secondaryNativePage
                                  ? "cross-validated"
                                  : "unavailable",
                        columnCount: regionAnalysis.columnCount,
                        regionCount: regionAnalysis.regions.length,
                        formFieldCount: formFields.length,
                        lowConfidenceRegions: regionAnalysis.lowConfidenceRegions,
                        averageConfidence: analysis.statistics.averageConfidence,
                        qualityScore,
                        cacheHit: false,
                        ocrAttemptCount: ocrMetadata.attempts.length,
                        visualRegionCount: visionAnalysis?.regions?.length || 0,
                        protectedVisualRegionCount:
                            visionAnalysis?.routing?.protectedRegions?.length || 0,
                        cleanedBackgroundWords:
                            editableBackground?.removedWordCount || 0,
                        visionProvider: visionAnalysis?.provider || "none",
                        neuralVisionStatus: visionAnalysis?.neural?.status || "local",
                        neuralFormulaRegions:
                            analysis.visionLayout?.formulaCount || 0,
                        neuralTableRegions:
                            analysis.visionLayout?.tableCount || 0,
                        handwritingRegions:
                            analysis.visionLayout?.handwritingCount || 0,
                    },
                };

                pages.push(pageResult);
                if (persistentSession && !persistenceError) {
                    try {
                        await savePageCheckpoint(
                            persistentSession.id,
                            pageNumber,
                            clonePage(pageResult)
                        );
                    } catch (error) {
                        persistenceError = error;
                        console.warn("No se pudo guardar el checkpoint de página:", error);
                        await updateConversionSession(persistentSession.id, {
                            status: "failed",
                            error: error?.message || String(error),
                        }).catch(() => null);
                    }
                }
                if (useCache) {
                    setCachedPage(
                        cacheKey,
                        clonePage(pageResult),
                        Math.max(16, cacheMemoryMB) * 1024 * 1024
                    );
                }
                reportProgress(1, "page-complete", `Página ${pageNumber} completada.`);
            } finally {
                page.cleanup();
            }
        }
    } catch (error) {
        if (persistentSession && !persistenceError) {
            await updateConversionSession(persistentSession.id, {
                status: error?.name === "AbortError" ? "paused" : "failed",
                error: error?.message || String(error),
            }).catch(() => null);
        }
        throw error;
    } finally {
        await loadingTask.destroy();
    }

    stabilizeHeaderAndFooterZones(pages);

    const documentStructure = analyzeDocumentStructure(pages);

    const report = summarizeDocument(
        pages,
        startedAt,
        initialHeap,
        peakCanvasPixels,
        mode
    );
    const fontResources = secondaryNativeDocument?.embeddedFonts || [];
    report.typography = {
        scope: secondaryNativeDocument?.fontScope || null,
        analyzedPageCount: secondaryNativeDocument?.fontPageCount || 0,
        resourceCount: fontResources.length,
        embeddableFaceCount: fontResources.filter(
            (font) => font.embedding === "editable" && font.data?.length
        ).length,
        metricSubstitutionFaceCount: fontResources.filter(
            (font) => font.embedding !== "editable" || !font.data?.length
        ).length,
        aliasCount: fontResources.reduce(
            (total, font) => total + (font.aliases?.length || 0),
            0
        ),
        variants: [...new Set(fontResources.map((font) => font.style || "Regular"))].sort(),
    };
    report.scalability = {
        persistent: Boolean(persistentSession),
        sessionId: persistentSession?.id || null,
        resumedPages: [...cachedPages.keys()].length,
        checkpointedPages: persistentSession
            ? pages.filter((page) => !page.metrics.cacheHit).length
            : 0,
        persistenceStatus: persistenceError ? "degraded" : persistentSession ? "ready" : "disabled",
        persistenceError: persistenceError?.message || null,
        documentRegisteredOnce: Boolean(registeredNativeDocument?.documentId),
        registeredDocumentReused: registeredNativeDocument?.reused === true,
        sourceUploadStrategy: registeredNativeDocument?.documentId
            ? "single-upload-document-id"
            : "legacy-per-request-fallback",
        ramBudgetMB: Math.max(16, Number(cacheMemoryMB) || 96),
        persistentBudgetMB: Math.max(128, Number(persistentStorageMB) || 1024),
        renderBudgetMegapixels: Number(maximumCanvasMegapixels) || 20,
        browserHeapLimitMB: Number(
            (resourceBudget.browserHeapLimitBytes / 1024 / 1024).toFixed(1)
        ),
        workingSetBudgetMB: Number(
            (resourceBudget.workingSetBudgetBytes / 1024 / 1024).toFixed(1)
        ),
        detectedDeviceMemoryGB: resourceBudget.detectedDeviceMemoryGB,
    };
    if (persistentSession && !persistenceError) {
        try {
            await updateConversionSession(persistentSession.id, {
                status: "ready",
                completedPages: [...selectedPages],
                report: {
                    pageCount: report.pageCount,
                    durationMs: report.durationMs,
                    peakCanvasMegapixels: report.peakCanvasMegapixels,
                    memoryDeltaMB: report.memoryDeltaMB,
                },
            });
        } catch (error) {
            report.scalability.persistenceStatus = "degraded";
            report.scalability.persistenceError = error?.message || String(error);
        }
    }
    onProgress?.({
        percent: 92,
        stage: "document",
        detail: "Construyendo el documento Word…",
        pageCount: pages.length,
    });

    return {
        title: file.name.replace(/\.pdf$/i, ""),
        sourceName: file.name,
        mode,
        pages,
        embeddedFonts: secondaryNativeDocument?.embeddedFonts || [],
        report,
        documentStructure,
        selectedPages,
        options: {
            ocrMode,
            pageRange,
            excludeImages,
            maximumCanvasMegapixels,
            cacheMemoryMB,
            experimentalHandwriting,
            advancedVision,
            cleanEditableBackground,
            visionProvider,
            visionEndpoint,
            visionTimeoutMs,
            persistentProcessing,
            persistentStorageMB,
            persistenceSessionId: persistentSession?.id || null,
            visionVersion: "3.27.0-font-resources",
        },
    };
}
