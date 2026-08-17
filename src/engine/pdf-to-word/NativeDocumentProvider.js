import { buildLinesFromWords, countCharacters } from "./PageContentNormalizer.js";

const DEFAULT_LAYOUT_ENDPOINT = "http://127.0.0.1:8765/v1/layout";

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
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

function normalizeFamily(fontName = "") {
    const family = cleanText(fontName)
        .replace(/^[A-Z]{6}\+/i, "")
        .replace(/["']/g, "")
        .split(",")[0]
        .replace(/[-_ ]+(bold|black|heavy|semibold|demi|italic|oblique).*$/i, "")
        .trim();
    return family || "Arial";
}

function readBox(value, scaleX = 1, scaleY = 1) {
    if (!value) return null;
    if (!Array.isArray(value)) {
        return {
            x: number(value.x) * scaleX,
            y: number(value.y) * scaleY,
            width: number(value.width) * scaleX,
            height: number(value.height) * scaleY,
        };
    }
    if (value.length < 4) return null;
    const [x, y, third, fourth] = value.map(Number);
    if (![x, y, third, fourth].every(Number.isFinite)) return null;
    return {
        x: x * scaleX,
        y: y * scaleY,
        width: Math.max(0, (third - x) * scaleX),
        height: Math.max(0, (fourth - y) * scaleY),
    };
}

function normalizeRawStructure(structure = {}, scaleX = 1, scaleY = 1) {
    return {
        ...structure,
        raw: (structure.raw || []).map((row) => ({
            ...row,
            cells: (row.cells || []).map((cell) => ({
                ...cell,
                bbox: readBox(cell.bbox, scaleX, scaleY),
            })),
        })),
        columnAnchors: (structure.column_anchors || structure.columnAnchors || []).map(
            (anchor) => number(anchor) * scaleX
        ),
    };
}

function normalizeTable(table, index, scaleX, scaleY) {
    const bbox = readBox(table.bbox, scaleX, scaleY);
    if (!bbox || bbox.width < 12 || bbox.height < 12) return null;
    const rows = (table.rows || []).map((row) =>
        (row || []).map((cell) => cleanText(cell))
    );
    if (rows.length < 2 || Math.max(...rows.map((row) => row.length), 0) < 2) {
        return null;
    }
    const columnAnchors = (table.column_anchors || table.columnAnchors || []).map(
        (anchor) => number(anchor) * scaleX
    );
    return {
        id: table.id || `secondary-native-table-${index + 1}`,
        bbox,
        rows,
        headers: [],
        confidence: number(table.confidence, 0.9) * 100,
        structuralScore: number(table.structural_score ?? table.structuralScore, 90),
        source: table.source || "pdfplumber",
        columnAnchors,
        structure: normalizeRawStructure(table.structure, scaleX, scaleY),
    };
}

function normalizeShape(shape, scaleX, scaleY) {
    const bbox = readBox(shape.bbox, scaleX, scaleY);
    if (!bbox) return null;
    return {
        ...shape,
        bbox,
        lineWidth: number(shape.line_width ?? shape.lineWidth, 1) *
            Math.min(scaleX, scaleY),
    };
}

export function normalizeStructuredNativePage(page = {}, dimensions = {}) {
    const width = Math.max(1, number(page.width, dimensions.width));
    const height = Math.max(1, number(page.height, dimensions.height));
    const scaleX = Math.max(0.01, number(dimensions.width, width) / width);
    const scaleY = Math.max(0.01, number(dimensions.height, height) / height);
    const words = (page.words || []).map((word, index) => {
        const bbox = readBox(word.bbox, scaleX, scaleY);
        const text = cleanText(word.text);
        if (!bbox || !text || bbox.width <= 0 || bbox.height <= 0) return null;
        const fontName = cleanText(word.font_name || word.fontName || "Arial");
        return {
            id: word.id || `secondary-native-word-${index + 1}`,
            text,
            ...bbox,
            confidence: Math.min(100, Math.max(0, number(word.confidence, 1) * 100)),
            source: "native-secondary",
            fontName,
            fontFamily: normalizeFamily(fontName),
            fontSize: Math.max(1, number(word.font_size ?? word.fontSize, bbox.height) * scaleY),
            bold: Boolean(word.bold),
            italic: Boolean(word.italic),
            color: word.color || null,
            strokingColor: word.stroking_color || word.strokingColor || null,
            rotation: number(word.rotation),
            direction: word.direction || "ltr",
            embeddedFont: Boolean(word.embedded_font ?? word.embeddedFont),
            characterSpacing: number(word.character_spacing ?? word.characterSpacing) * scaleX,
            kerning: number(word.kerning),
            sourceOrder: number(word.source_order ?? word.sourceOrder, index),
        };
    }).filter(Boolean);
    const tables = (page.tables || []).map((table, index) =>
        normalizeTable(table, index, scaleX, scaleY)
    ).filter(Boolean);
    const vectorObjects = [
        ...(page.lines || []),
        ...(page.rectangles || []),
        ...(page.curves || []),
    ].map((shape) => normalizeShape(shape, scaleX, scaleY)).filter(Boolean);

    return {
        pageNumber: number(page.page_number ?? page.pageNumber),
        dimensions: { width: number(dimensions.width, width), height: number(dimensions.height, height) },
        rotation: number(page.rotation),
        content: {
            text: words.map((word) => word.text).join(" "),
            confidence: words.length ? 100 : 0,
            words,
            lines: buildLinesFromWords(words),
            blocks: [],
            paragraphs: [],
            source: "native-secondary",
        },
        tables,
        vectorObjects,
        images: page.images || [],
        annotations: page.annotations || [],
        statistics: page.statistics || {},
        provider: "pdfplumber",
    };
}

export function selectBestNativeContent(primary, secondary) {
    if (!secondary?.words?.length) return primary;
    if (!primary?.words?.length) return secondary;
    const primaryCharacters = countCharacters(primary);
    const secondaryCharacters = countCharacters(secondary);
    const coverage = secondaryCharacters / Math.max(1, primaryCharacters);
    const styleCoverage = secondary.words.filter(
        (word) => word.fontName || word.color || word.rotation || word.embeddedFont
    ).length / Math.max(1, secondary.words.length);

    if (coverage < 0.88 || styleCoverage < 0.75) return primary;
    return {
        ...secondary,
        verification: {
            selected: "pdfplumber",
            primaryCharacters,
            secondaryCharacters,
            coverage,
            styleCoverage,
        },
    };
}

export async function extractNativeDocumentStructure(
    file,
    {
        pages = [],
        endpoint = DEFAULT_LAYOUT_ENDPOINT,
        signal,
        timeoutMs = 45_000,
    } = {}
) {
    if (!file || !isLoopbackEndpoint(endpoint)) return null;
    const nativeEndpoint = new URL("/v1/native-document", endpoint).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
        const form = new FormData();
        form.append("pdf", file, file.name || "document.pdf");
        form.append("pages", pages.length ? pages.join(",") : "all");
        form.append("include_tables", "true");
        const response = await fetch(nativeEndpoint, {
            method: "POST",
            body: form,
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`El extractor nativo secundario respondio ${response.status}.`);
        }
        const payload = await response.json();
        return {
            provider: payload.provider || "pdfplumber",
            version: payload.version || null,
            pageCount: number(payload.page_count),
            pages: new Map(
                (payload.pages || []).map((page) => [number(page.page_number), page])
            ),
        };
    } catch (error) {
        if (signal?.aborted) throw new DOMException("Conversion cancelada.", "AbortError");
        return {
            provider: "pdfplumber",
            version: null,
            pages: new Map(),
            error: cleanText(error?.message || "Extractor nativo no disponible."),
        };
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}
