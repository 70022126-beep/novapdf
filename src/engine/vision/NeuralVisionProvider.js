import {
    buildOCRRoutingPlan,
    segmentPageVisuals,
} from "./VisualRegionSegmenter.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8765/v1/layout";
const CIRCUIT_RETRY_MS = 60_000;
const endpointFailures = new Map();
const endpointReady = new Set();

const LABEL_MAP = new Map([
    ["text", "text-candidate"],
    ["paragraph", "text-candidate"],
    ["plain_text", "text-candidate"],
    ["sectionheader", "heading"],
    ["section_header", "heading"],
    ["paragraphtitle", "heading"],
    ["paragraph_title", "heading"],
    ["doc_title", "heading"],
    ["document_title", "heading"],
    ["title", "heading"],
    ["heading", "heading"],
    ["header", "page-header"],
    ["pageheader", "page-header"],
    ["page_header", "page-header"],
    ["footer", "page-footer"],
    ["pagefooter", "page-footer"],
    ["page_footer", "page-footer"],
    ["listitem", "list-item"],
    ["list_item", "list-item"],
    ["caption", "caption"],
    ["figure_title", "caption"],
    ["table_title", "caption"],
    ["footnote", "footnote"],
    ["reference", "footnote"],
    ["aside_text", "text-candidate"],
    ["number", "page-footer"],
    ["table", "table"],
    ["form", "form-field"],
    ["form_field", "form-field"],
    ["equation", "formula"],
    ["formula", "formula"],
    ["math", "formula"],
    ["picture", "photo"],
    ["image", "photo"],
    ["figure", "photo"],
    ["photo", "photo"],
    ["graphic", "graphic"],
    ["header_image", "graphic"],
    ["footer_image", "graphic"],
    ["signature", "signature"],
    ["seal", "stamp"],
    ["stamp", "stamp"],
    ["handwriting", "handwriting"],
    ["handwritten", "handwriting"],
    ["scribble", "scribble"],
    ["strikeout", "scribble"],
    ["stain", "stain"],
]);

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeLabel(label) {
    const key = cleanText(label).toLowerCase().replace(/[\s-]+/g, "_");
    return LABEL_MAP.get(key) || LABEL_MAP.get(key.replace(/_/g, "")) || "graphic";
}

function strategyForType(type) {
    if (["text-candidate", "heading", "page-header", "page-footer", "list-item", "caption", "footnote"].includes(type)) {
        return "printed-ocr";
    }
    if (type === "handwriting") return "handwriting-ocr";
    if (type === "table") return "table-structure";
    if (type === "formula") return "formula-ocr";
    if (type === "form-field") return "form-structure";
    return "preserve-image";
}

function isProtectedType(type) {
    return ["photo", "graphic", "signature", "stamp", "scribble", "stain"].includes(type);
}

function boxFromPolygon(polygon = []) {
    const points = Array.isArray(polygon[0])
        ? polygon.map(([x, y]) => ({ x, y }))
        : polygon;
    if (!points.length) return null;
    const xs = points.map((point) => number(point.x, point[0])).filter(Number.isFinite);
    const ys = points.map((point) => number(point.y, point[1])).filter(Number.isFinite);
    if (!xs.length || !ys.length) return null;
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return {
        x: left,
        y: top,
        width: Math.max(0, Math.max(...xs) - left),
        height: Math.max(0, Math.max(...ys) - top),
    };
}

function readBox(region = {}) {
    if (region.bbox && !Array.isArray(region.bbox)) return { ...region.bbox };
    if (Array.isArray(region.bbox) && region.bbox.length >= 4) {
        const [x, y, third, fourth] = region.bbox.map(Number);
        const bboxFormat = region.bbox_format || region.bboxFormat || "xywh";
        return bboxFormat === "xyxy"
            ? { x, y, width: third - x, height: fourth - y }
            : { x, y, width: third, height: fourth };
    }
    return boxFromPolygon(region.polygon || region.poly || []);
}

function scaleBox(box, response, dimensions) {
    const sourceWidth = number(
        response.image_width ?? response.imageWidth ?? response.width,
        dimensions.width
    );
    const sourceHeight = number(
        response.image_height ?? response.imageHeight ?? response.height,
        dimensions.height
    );
    const looksNormalized =
        number(box.x) >= 0 &&
        number(box.y) >= 0 &&
        number(box.x) + number(box.width) <= 1.01 &&
        number(box.y) + number(box.height) <= 1.01;
    const scaleX = looksNormalized ? dimensions.width : dimensions.width / Math.max(1, sourceWidth);
    const scaleY = looksNormalized ? dimensions.height : dimensions.height / Math.max(1, sourceHeight);
    const x = clamp(number(box.x) * scaleX, 0, dimensions.width);
    const y = clamp(number(box.y) * scaleY, 0, dimensions.height);
    const right = clamp((number(box.x) + number(box.width)) * scaleX, x, dimensions.width);
    const bottom = clamp((number(box.y) + number(box.height)) * scaleY, y, dimensions.height);
    return { x, y, width: right - x, height: bottom - y };
}

function normalizeTextLines(sourceLines, response, dimensions, prefix = "neural-line") {
    return (sourceLines || []).map((source, index) => {
        const rawBox = readBox(source);
        if (!rawBox) return null;
        const bbox = scaleBox(rawBox, response, dimensions);
        const text = cleanText(source.text);
        if (!text || bbox.width < 1 || bbox.height < 1) return null;
        const confidenceValue = number(
            source.confidence ?? source.score ?? source.probability,
            0.75
        );
        return {
            id: source.id || `${prefix}-${index + 1}`,
            text,
            bbox,
            confidence: clamp(
                confidenceValue <= 1 ? confidenceValue * 100 : confidenceValue,
                0,
                100
            ),
            source: "neural-ocr-line",
        };
    }).filter(Boolean);
}

export function normalizeNeuralVisionResponse(response = {}, dimensions = {}) {
    const pageDimensions = {
        width: Math.max(1, number(dimensions.width)),
        height: Math.max(1, number(dimensions.height)),
    };
    const sourceRegions = response.regions || response.blocks || response.layout || [];
    const regions = sourceRegions.map((source, index) => {
        const rawBox = readBox(source);
        if (!rawBox) return null;
        const bbox = scaleBox(rawBox, response, pageDimensions);
        if (bbox.width < 1 || bbox.height < 1) return null;
        const type = normalizeLabel(source.label || source.type || source.category);
        const confidenceValue = number(
            source.confidence ?? source.score ?? source.probability,
            0.75
        );
        const confidence = confidenceValue <= 1 ? confidenceValue * 100 : confidenceValue;
        return {
            id: source.id || `neural-${index + 1}`,
            type,
            source: "neural-layout",
            bbox,
            confidence: clamp(confidence, 0, 100),
            strategy: strategyForType(type),
            protected: isProtectedType(type),
            text: cleanText(source.text),
            latex: cleanText(source.latex || source.math || source.formula),
            html: String(source.html || ""),
            cells: source.cells || source.table?.cells || [],
            rows: source.rows || source.table?.rows || [],
            textLines: normalizeTextLines(
                source.text_lines || source.textLines || [],
                response,
                pageDimensions,
                `neural-region-${index + 1}-line`
            ),
            readingOrder: number(source.reading_order ?? source.readingOrder, index),
            providerPayload: {
                label: source.label || source.type || source.category,
                polygon: source.polygon || source.poly || null,
            },
        };
    }).filter(Boolean);
    const routing = buildOCRRoutingPlan(regions, pageDimensions);
    const textLines = normalizeTextLines(
        response.text_lines || response.textLines || [],
        response,
        pageDimensions
    );

    return {
        provider: response.provider || "neural-local",
        model: response.model || response.model_name || "unknown",
        version: response.version || null,
        dimensions: pageDimensions,
        regions,
        textLines,
        orientation: number(response.orientation, 0),
        routing,
        statistics: {
            neuralRegionCount: regions.length,
            protectedRegionCount: routing.protectedRegions.length,
            ocrRegionCount: routing.ocrRegions.length,
            tableRegionCount: regions.filter((region) => region.type === "table").length,
            formulaRegionCount: regions.filter((region) => region.type === "formula").length,
            handwritingRegionCount: regions.filter((region) => region.type === "handwriting").length,
            neuralTextLineCount: textLines.length,
        },
        neural: { status: "connected" },
    };
}

function isLoopbackEndpoint(endpoint) {
    try {
        const url = new URL(endpoint);
        return (
            ["http:", "https:"].includes(url.protocol) &&
            ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
        );
    } catch {
        return false;
    }
}

function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error("No se pudo preparar la pagina para vision neuronal."));
        }, "image/png");
    });
}

async function probeNeuralEndpoint(endpoint, signal) {
    if (endpointReady.has(endpoint)) return;
    const healthUrl = new URL("/health", endpoint).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
        const response = await fetch(healthUrl, {
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        endpointReady.add(endpoint);
    } catch (error) {
        if (signal?.aborted) throw new DOMException("Conversion cancelada.", "AbortError");
        throw new Error("El servicio neuronal local no esta iniciado.", { cause: error });
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}

async function requestNeuralLayout(
    canvas,
    { endpoint, dimensions, timeoutMs = 120_000, signal } = {}
) {
    if (!isLoopbackEndpoint(endpoint)) {
        throw new Error("El proveedor neuronal debe ejecutarse en este equipo.");
    }
    const lastFailure = endpointFailures.get(endpoint) || 0;
    if (Date.now() - lastFailure < CIRCUIT_RETRY_MS) {
        throw new Error("El proveedor neuronal local continua temporalmente inactivo.");
    }
    await probeNeuralEndpoint(endpoint, signal);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });

    try {
        const form = new FormData();
        form.append("image", await canvasToBlob(canvas), "page.png");
        form.append("page_width", String(dimensions.width));
        form.append("page_height", String(dimensions.height));
        form.append("coordinate_space", "page-points");
        const response = await fetch(endpoint, {
            method: "POST",
            body: form,
            signal: controller.signal,
            headers: { Accept: "application/json" },
        });
        if (!response.ok) {
            throw new Error(`El proveedor neuronal respondio ${response.status}.`);
        }
        const payload = await response.json();
        const normalized = normalizeNeuralVisionResponse(payload, dimensions);
        if (!normalized.regions.length) {
            throw new Error("El proveedor neuronal no devolvio regiones utilizables.");
        }
        endpointFailures.delete(endpoint);
        endpointReady.add(endpoint);
        return normalized;
    } catch (error) {
        endpointFailures.set(endpoint, Date.now());
        if (signal?.aborted) throw new DOMException("Conversion cancelada.", "AbortError");
        throw error;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}

export async function analyzePageWithVision(
    canvas,
    {
        provider = "auto",
        endpoint = DEFAULT_ENDPOINT,
        pageWidth,
        pageHeight,
        signal,
        timeoutMs,
    } = {}
) {
    const dimensions = { width: pageWidth, height: pageHeight };
    if (provider === "local") {
        return segmentPageVisuals(canvas, { pageWidth, pageHeight });
    }

    try {
        return await requestNeuralLayout(canvas, {
            endpoint,
            dimensions,
            timeoutMs,
            signal,
        });
    } catch (error) {
        if (error?.name === "AbortError" && signal?.aborted) throw error;
        const fallback = segmentPageVisuals(canvas, { pageWidth, pageHeight });
        return {
            ...fallback,
            neural: {
                status: "fallback",
                provider,
                endpoint,
                reason: cleanText(error?.message || "Proveedor neuronal no disponible."),
            },
        };
    }
}

export function resetVisionProviderCircuit() {
    endpointFailures.clear();
    endpointReady.clear();
}

export { DEFAULT_ENDPOINT as DEFAULT_NEURAL_VISION_ENDPOINT };
