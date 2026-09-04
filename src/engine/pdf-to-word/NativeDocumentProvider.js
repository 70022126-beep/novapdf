import { buildLinesFromWords, countCharacters } from "./PageContentNormalizer.js";

const DEFAULT_LAYOUT_ENDPOINT = "http://127.0.0.1:8765/v1/layout";

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function contentTokens(content) {
    return new Set(
        (content?.words || [])
            .flatMap((word) => cleanText(word.text).toLocaleLowerCase("es").match(/[\p{L}\p{N}]+/gu) || [])
    );
}

function repairTextFromPrimary(value, primaryWords = []) {
    return String(value ?? "").replace(/[\p{L}\p{N}�]+/gu, (token) => {
        if (!token.includes("�")) return token;
        const replacement = primaryWords.find((candidate) => {
            const candidateText = cleanText(candidate.text);
            if (candidateText.length !== token.length) return false;
            return [...token].every(
                (character, index) =>
                    character === "�" ||
                    character.toLocaleLowerCase("es") ===
                        candidateText[index]?.toLocaleLowerCase("es")
            );
        });
        return replacement ? cleanText(replacement.text) : token;
    });
}

export function repairNativeTableText(tables = [], primary = {}) {
    const primaryWords = primary?.words || [];
    const repair = (value) => repairTextFromPrimary(value, primaryWords);
    return tables.map((table) => ({
        ...table,
        rows: (table.rows || []).map((row) => (row || []).map(repair)),
        headers: (table.headers || []).map(repair),
        structure: {
            ...(table.structure || {}),
            raw: (table.structure?.raw || []).map((row) => ({
                ...row,
                cells: (row.cells || []).map((cell) => ({
                    ...cell,
                    text: repair(cell.text),
                })),
            })),
        },
    }));
}

function repairSecondaryText(primary, secondary) {
    const primaryWords = primary?.words || [];
    const words = (secondary?.words || []).map((word) => {
        const text = cleanText(word.text);
        if (!text.includes("�")) return word;

        const compatible = primaryWords.filter((candidate) => {
            const candidateText = cleanText(candidate.text);
            if (candidateText.length !== text.length) return false;
            return [...text].every(
                (character, index) =>
                    character === "�" ||
                    character.toLocaleLowerCase("es") ===
                        candidateText[index]?.toLocaleLowerCase("es")
            );
        });
        if (!compatible.length) return word;

        const centerX = number(word.x) + number(word.width) / 2;
        const centerY = number(word.y) + number(word.height) / 2;
        const replacement = compatible.reduce((best, candidate) => {
            const distance = Math.hypot(
                centerX - (number(candidate.x) + number(candidate.width) / 2),
                centerY - (number(candidate.y) + number(candidate.height) / 2)
            );
            return !best || distance < best.distance ? { candidate, distance } : best;
        }, null)?.candidate;

        return replacement ? { ...word, text: cleanText(replacement.text) } : word;
    });

    return {
        ...secondary,
        words,
        text: words.map((word) => cleanText(word.text)).join(" "),
        lines: buildLinesFromWords(words),
    };
}

function decodeBase64Bytes(value) {
    const encoded = String(value || "").replace(/\s+/g, "");
    if (!encoded) return null;
    try {
        const binary = globalThis.atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
    } catch {
        return null;
    }
}

function normalizeEmbeddedFont(font = {}, index = 0) {
    const data = decodeBase64Bytes(font.data_base64 ?? font.dataBase64);
    const name = cleanText(font.name || font.source_name || font.sourceName);
    if (!name || !data?.length || data.length > 2 * 1024 * 1024) return null;
    const rawWidths = font.character_widths_em ?? font.characterWidthsEm;
    const characterWidthsEm = Object.fromEntries(Object.entries(
        rawWidths && typeof rawWidths === "object" ? rawWidths : {}
    ).filter(([codePoint, width]) => /^\d+$/.test(codePoint) &&
        Number.isFinite(Number(width)) && Number(width) >= 0.02 && Number(width) <= 4
    ).slice(0, 512).map(([codePoint, width]) => [codePoint, Number(width)]));
    const spaceAdvanceEm = Number(font.space_advance_em ?? font.spaceAdvanceEm);
    return {
        id: font.sha256 || `embedded-font-${index + 1}`,
        name,
        sourceName: cleanText(font.source_name ?? font.sourceName),
        style: cleanText(font.style || "Regular"),
        unitsPerEm: Number.isFinite(Number(font.units_per_em ?? font.unitsPerEm))
            ? Number(font.units_per_em ?? font.unitsPerEm) : undefined,
        spaceAdvanceEm: Number.isFinite(spaceAdvanceEm) && spaceAdvanceEm >= 0.02 && spaceAdvanceEm <= 4
            ? spaceAdvanceEm : undefined,
        characterWidthsEm,
        extension: cleanText(font.extension || "ttf").toLowerCase(),
        embedding: cleanText(font.embedding || "editable"),
        data,
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

function normalizeFamily(fontName = "") {
    const family = cleanText(fontName)
        .replace(/^[A-Z]{6}\+/i, "")
        .replace(/["']/g, "")
        .split(",")[0]
        .replace(/[-_ ]+(bold|black|heavy|semibold|demi|italic|oblique).*$/i, "")
        .trim();
    // Conservamos la familia lógica para que el renderizador pueda escoger la
    // sustitución según el tamaño y no aplique una única métrica a títulos y
    // texto pequeño.
    if (/^quicksand/i.test(family)) return "Quicksand";
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

export function isPlausibleNativeTable(table = {}, pageHeight = 0) {
    if (table.source !== "pdfplumber-text") return true;
    const rows = table.rows || [];
    if (rows.length < 8) return true;
    if (number(table.bbox?.height) / Math.max(1, number(pageHeight, 1)) < 0.42) {
        return true;
    }

    const values = rows.flat().map(cleanText).filter(Boolean);
    if (!values.length) return false;
    const isLetter = (character) => /[a-záéíóúüñ]/i.test(character || "");
    const isLowercase = (character) =>
        /[a-záéíóúüñ]/.test(character || "");
    const shortRatio =
        values.filter((value) => value.length <= 2 && /^[a-záéíóúüñ]+$/i.test(value))
            .length / values.length;
    let boundaries = 0;
    let fragmentedBoundaries = 0;

    rows.forEach((row) => {
        const cells = (row || []).map(cleanText);
        for (let index = 0; index < cells.length - 1; index += 1) {
            const left = cells[index];
            const right = cells[index + 1];
            if (!left || !right || !isLetter(left.at(-1)) || !isLetter(right[0])) {
                continue;
            }
            boundaries += 1;
            if (left.length <= 2 || isLowercase(right[0])) {
                fragmentedBoundaries += 1;
            }
        }
    });

    return (
        shortRatio < 0.1 &&
        fragmentedBoundaries / Math.max(1, boundaries) < 0.32
    );
}

function normalizeTable(table, index, scaleX, scaleY, pageHeight) {
    const bbox = readBox(table.bbox, scaleX, scaleY);
    if (!bbox || bbox.width < 12 || bbox.height < 12) return null;
    const rows = (table.rows || []).map((row) =>
        (row || []).map((cell) => cleanText(cell))
    );
    const columnCount = Math.max(...rows.map((row) => row.length), 0);
    const isBorderedNativeTable = String(table.source || "").startsWith(
        "pdfplumber-lines"
    );
    if (
        !rows.length ||
        columnCount < 2 ||
        (rows.length < 2 && !isBorderedNativeTable)
    ) {
        return null;
    }
    const columnAnchors = (table.column_anchors || table.columnAnchors || []).map(
        (anchor) => number(anchor) * scaleX
    );
    const normalized = {
        id: table.id || `secondary-native-table-${index + 1}`,
        bbox,
        rows,
        headers: (table.headers || []).map((cell) => cleanText(cell)),
        confidence: number(table.confidence, 0.9) * 100,
        structuralScore: number(table.structural_score ?? table.structuralScore, 90),
        source: table.source || "pdfplumber",
        columnAnchors,
        structure: normalizeRawStructure(table.structure, scaleX, scaleY),
    };
    return isPlausibleNativeTable(normalized, pageHeight) ? normalized : null;
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

function applyVectorTextDecorations(words = [], vectorObjects = [], tables = []) {
    const cellBoxes = tables.flatMap((table) => [
        table.bbox,
        ...(table.structure?.raw || []).flatMap((row) => (row.cells || []).map((cell) => cell.bbox)),
    ]).filter(Boolean);
    const horizontalSegments = vectorObjects.filter((shape) => {
        const width = number(shape.bbox?.width);
        const height = number(shape.bbox?.height);
        const left = number(shape.bbox?.x);
        const right = left + width;
        const y = number(shape.bbox?.y);
        const isCellBorder = cellBoxes.some((box) => {
            const overlap = Math.max(0, Math.min(right, box.x + box.width) - Math.max(left, box.x));
            return overlap >= box.width * 0.75 &&
                (Math.abs(y - box.y) <= 1 || Math.abs(y - (box.y + box.height)) <= 1);
        });
        if (isCellBorder) return false;
        return width >= 3 && height <= Math.max(2.5, number(shape.lineWidth, 0.5) * 2.5) &&
            width >= height * 3;
    });

    if (!horizontalSegments.length) return words;

    return words.map((word) => {
        const left = number(word.x);
        const right = left + number(word.width);
        const top = number(word.y);
        const height = Math.max(1, number(word.height));
        const bottom = top + height;
        let underline = Boolean(word.underline);
        let strike = Boolean(word.strike);

        horizontalSegments.forEach((shape) => {
            const shapeLeft = number(shape.bbox?.x);
            const shapeRight = shapeLeft + number(shape.bbox?.width);
            const overlap = Math.max(0, Math.min(right, shapeRight) - Math.max(left, shapeLeft));
            if (overlap < Math.min(4, number(word.width) * 0.48)) return;

            const segmentY = number(shape.bbox?.y) + number(shape.bbox?.height) / 2;
            if (segmentY >= bottom - height * 0.08 && segmentY <= bottom + Math.max(2.8, height * 0.3)) {
                underline = true;
            } else if (segmentY >= top + height * 0.34 && segmentY <= top + height * 0.72) {
                strike = true;
            }
        });

        return underline || strike ? {
            ...word, underline, strike,
            // Keep provenance: a clean page plate already contains these
            // vector strokes, but editable flow still needs Word formatting.
            vectorUnderline: underline && !word.underline,
            vectorStrike: strike && !word.strike,
        } : word;
    });
}

function normalizeEmbeddedImage(image, index, scaleX, scaleY) {
    const bbox = readBox(image.bbox, scaleX, scaleY);
    const data = decodeBase64Bytes(image.data_base64 ?? image.dataBase64);
    if (!bbox || bbox.width <= 0 || bbox.height <= 0 || !data?.length) return null;
    const mimeType = String(image.mime_type ?? image.mimeType ?? "image/png").toLowerCase();
    return {
        id: image.id || `secondary-native-image-${index + 1}`,
        name: image.name || "",
        ...bbox,
        data,
        type: mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png",
        pixelWidth: Math.max(1, number(image.width, bbox.width)),
        pixelHeight: Math.max(1, number(image.height, bbox.height)),
        nativeEmbedded: Boolean(image.native_embedded ?? image.nativeEmbedded ?? true),
        source: "native-embedded",
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
        const baseline = word.baseline_y ?? word.baselineY;
        return {
            id: word.id || `secondary-native-word-${index + 1}`,
            text,
            ...bbox,
            confidence: Math.min(100, Math.max(0, number(word.confidence, 1) * 100)),
            source: "native-secondary",
            fontName,
            fontFamily: normalizeFamily(fontName),
            fontSize: Math.max(1, number(word.font_size ?? word.fontSize, bbox.height) * scaleY),
            baselineY: typeof baseline === "number" && Number.isFinite(baseline)
                ? baseline * scaleY : undefined,
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
    const vectorObjects = [
        ...(page.lines || []),
        ...(page.rectangles || []),
        ...(page.curves || []),
    ].map((shape) => normalizeShape(shape, scaleX, scaleY)).filter(Boolean);
    const tables = (page.tables || []).map((table, index) =>
        normalizeTable(table, index, scaleX, scaleY, number(dimensions.height, height))
    ).filter(Boolean);
    const decoratedWords = applyVectorTextDecorations(words, vectorObjects, tables);
    const images = (page.images || []).map((image, index) =>
        normalizeEmbeddedImage(image, index, scaleX, scaleY)
    ).filter(Boolean);

    return {
        pageNumber: number(page.page_number ?? page.pageNumber),
        dimensions: { width: number(dimensions.width, width), height: number(dimensions.height, height) },
        rotation: number(page.rotation),
        content: {
            text: decoratedWords.map((word) => word.text).join(" "),
            confidence: decoratedWords.length ? 100 : 0,
            words: decoratedWords,
            lines: buildLinesFromWords(decoratedWords),
            blocks: [],
            paragraphs: [],
            source: "native-secondary",
        },
        tables,
        vectorObjects,
        images,
        // Keep the signal even when the image decoder returned geometry only.
        artworkRequiresCompositing: (page.images || []).some((image) =>
            image.requires_compositing === true || image.requiresCompositing === true),
        annotations: page.annotations || [],
        statistics: page.statistics || {},
        provider: "pdfplumber",
    };
}

export function selectBestNativeContent(primary, secondary) {
    if (!secondary?.words?.length) return primary;
    const repairedSecondary = repairSecondaryText(primary, secondary);
    if (!primary?.words?.length) return repairedSecondary;
    const primaryCharacters = countCharacters(primary);
    const secondaryCharacters = countCharacters(repairedSecondary);
    const coverage = secondaryCharacters / Math.max(1, primaryCharacters);
    const styleCoverage = repairedSecondary.words.filter(
        (word) => word.fontName || word.color || word.rotation || word.embeddedFont
    ).length / Math.max(1, repairedSecondary.words.length);
    const primaryTokens = contentTokens(primary);
    const secondaryTokens = contentTokens(repairedSecondary);
    const tokenAgreement = [...secondaryTokens].filter((token) => primaryTokens.has(token))
        .length / Math.max(1, secondaryTokens.size);
    const trustworthyCleanSubset =
        secondaryTokens.size >= 2 && tokenAgreement >= 0.9 && coverage >= 0.45;

    // PDF.js a veces expone texto invisible, repetido o fuera del recorte. El
    // segundo extractor es preferible si conserva casi todo el vocabulario y
    // aporta tipografía, aunque su conteo sea menor por haber eliminado ruido.
    if (
        styleCoverage < 0.75 ||
        (coverage < 0.72 && !trustworthyCleanSubset) ||
        (coverage < 0.88 && tokenAgreement < 0.86)
    ) {
        return primary;
    }
    return {
        ...repairedSecondary,
        verification: {
            selected: "pdfplumber",
            primaryCharacters,
            secondaryCharacters,
            coverage,
            styleCoverage,
            tokenAgreement,
        },
    };
}

export async function extractNativeDocumentStructure(
    file,
    {
        pages = [],
        endpoint = DEFAULT_LAYOUT_ENDPOINT,
        includeFonts = true,
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
        form.append("include_fonts", includeFonts ? "true" : "false");
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
            embeddedFonts: (payload.fonts || [])
                .map(normalizeEmbeddedFont)
                .filter(Boolean),
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
