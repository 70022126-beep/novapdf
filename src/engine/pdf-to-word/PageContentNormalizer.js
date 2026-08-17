// Normaliza la extracción nativa de PDF.js y el resultado OCR a un mismo
// sistema de coordenadas (puntos PDF, origen superior izquierdo).

function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function median(values = []) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function getBoundingBox(items = []) {
    if (!items.length) {
        return { x: 0, y: 0, width: 0, height: 0 };
    }

    const x = Math.min(...items.map((item) => toNumber(item.x)));
    const y = Math.min(...items.map((item) => toNumber(item.y)));
    const right = Math.max(
        ...items.map((item) => toNumber(item.x) + toNumber(item.width))
    );
    const bottom = Math.max(
        ...items.map((item) => toNumber(item.y) + toNumber(item.height))
    );

    return {
        x,
        y,
        width: Math.max(0, right - x),
        height: Math.max(0, bottom - y),
    };
}

function inferFontStyle(fontName = "", fontFamily = "") {
    const descriptor = `${fontName} ${fontFamily}`.toLowerCase();

    return {
        bold: /(bold|black|heavy|semibold|demi)/.test(descriptor),
        italic: /(italic|oblique|kursiv)/.test(descriptor),
    };
}

function normalizeFontFamily(fontName = "", fontFamily = "") {
    const candidate = cleanText(fontFamily || fontName)
        .replace(/^[A-Z]{6}\+/i, "")
        .replace(/["']/g, "")
        .split(",")[0]
        .trim();

    if (!candidate || /^(sans-serif|serif|monospace)$/i.test(candidate)) {
        return "Arial";
    }

    return candidate;
}

function splitNativeItem(item, style, pageHeight) {
    const text = String(item?.str ?? "");
    const tokens = [...text.matchAll(/\S+/g)];

    if (!tokens.length) {
        return [];
    }

    const transform = Array.isArray(item.transform) ? item.transform : [];
    const x = toNumber(transform[4]);
    const height = Math.max(
        1,
        toNumber(item.height, Math.abs(toNumber(transform[3], 10)))
    );
    const width = Math.max(0, toNumber(item.width));
    const y = Math.max(0, pageHeight - toNumber(transform[5]) - height);
    const estimatedCharacterWidth = width / Math.max(1, text.length);
    const fontStyle = inferFontStyle(item.fontName, style?.fontFamily);
    const rotation = Math.round(
        (Math.atan2(toNumber(transform[1]), toNumber(transform[0], 1)) * 180) /
            Math.PI
    );
    const embeddedFont = /^[A-Z]{6}\+/i.test(String(item.fontName || ""));

    return tokens.map((match) => {
        const token = cleanText(match[0]);
        const start = match.index ?? 0;

        return {
            text: token,
            x: x + start * estimatedCharacterWidth,
            y,
            width: Math.max(estimatedCharacterWidth, token.length * estimatedCharacterWidth),
            height,
            confidence: 100,
            source: "native",
            fontName: item.fontName || null,
            fontFamily: normalizeFontFamily(item.fontName, style?.fontFamily),
            fontSize: height,
            bold: fontStyle.bold,
            italic: fontStyle.italic,
            direction: item.dir || "ltr",
            rotation,
            embeddedFont,
            characterSpacing: 0,
            kerning: 0,
        };
    });
}

export function buildLinesFromWords(words = []) {
    const sorted = [...words].sort((a, b) => {
        const centerA = toNumber(a.y) + toNumber(a.height) / 2;
        const centerB = toNumber(b.y) + toNumber(b.height) / 2;
        const tolerance = Math.max(
            2.5,
            Math.min(toNumber(a.height, 10), toNumber(b.height, 10)) * 0.45
        );

        if (Math.abs(centerA - centerB) > tolerance) {
            return centerA - centerB;
        }

        return toNumber(a.x) - toNumber(b.x);
    });

    const groups = [];

    for (const word of sorted) {
        const centerY = toNumber(word.y) + toNumber(word.height) / 2;
        const tolerance = Math.max(3, toNumber(word.height, 10) * 0.48);
        let group = groups.find(
            (candidate) => Math.abs(candidate.centerY - centerY) <= tolerance
        );

        if (!group) {
            group = { centerY, words: [] };
            groups.push(group);
        }

        group.words.push(word);
        group.centerY =
            group.words.reduce(
                (sum, entry) => sum + toNumber(entry.y) + toNumber(entry.height) / 2,
                0
            ) / group.words.length;
    }

    return groups
        .sort((a, b) => a.centerY - b.centerY)
        .map((group, index) => {
            const lineWords = [...group.words].sort(
                (a, b) => toNumber(a.x) - toNumber(b.x)
            );
            const bbox = getBoundingBox(lineWords);
            const medianHeight = median(
                lineWords.map((word) => toNumber(word.height)).filter(Boolean)
            );
            const baseline = median(
                lineWords
                    .filter((word) => toNumber(word.height) >= medianHeight * 0.82)
                    .map((word) => toNumber(word.y) + toNumber(word.height))
            );

            lineWords.forEach((word) => {
                const wordHeight = toNumber(word.height);
                if (!baseline || !medianHeight || wordHeight >= medianHeight * 0.82) {
                    return;
                }
                const wordBottom = toNumber(word.y) + wordHeight;
                if (wordBottom < baseline - medianHeight * 0.12) {
                    word.superscript = true;
                } else if (toNumber(word.y) > baseline - medianHeight * 0.42) {
                    word.subscript = true;
                }
            });

            return {
                id: `source-line-${index + 1}`,
                text: lineWords.map((word) => cleanText(word.text)).filter(Boolean).join(" "),
                words: lineWords,
                bbox,
            };
        })
        .filter((line) => line.text);
}

export function normalizeNativeContent(textContent = {}, viewport = {}) {
    const pageHeight = toNumber(viewport.height);
    const styles = textContent.styles || {};
    const words = (textContent.items || []).flatMap((item) =>
        splitNativeItem(item, styles[item.fontName], pageHeight)
    );

    return {
        text: words.map((word) => word.text).join(" "),
        confidence: words.length ? 100 : 0,
        words,
        lines: buildLinesFromWords(words),
        blocks: [],
        paragraphs: [],
        source: "native",
    };
}

function scaleWord(word, ratio) {
    return {
        ...word,
        x: toNumber(word.x) * ratio,
        y: toNumber(word.y) * ratio,
        width: toNumber(word.width) * ratio,
        height: toNumber(word.height) * ratio,
        fontFamily: "Arial",
        fontSize: Math.max(8, toNumber(word.height) * ratio * 0.82),
        bold: false,
        italic: false,
        source: "ocr",
    };
}

export function normalizeOCRContent(ocrResult = {}, renderedScale = 1) {
    const ratio = 1 / Math.max(0.01, toNumber(renderedScale, 1));
    const words = (ocrResult.words || []).map((word) => scaleWord(word, ratio));

    return {
        ...ocrResult,
        words,
        lines: buildLinesFromWords(words),
        blocks: [],
        paragraphs: [],
        source: "ocr",
    };
}

function intersectionRatio(first, second) {
    const left = Math.max(toNumber(first.x), toNumber(second.x));
    const top = Math.max(toNumber(first.y), toNumber(second.y));
    const right = Math.min(
        toNumber(first.x) + toNumber(first.width),
        toNumber(second.x) + toNumber(second.width)
    );
    const bottom = Math.min(
        toNumber(first.y) + toNumber(first.height),
        toNumber(second.y) + toNumber(second.height)
    );
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const smallestArea = Math.min(
        Math.max(1, toNumber(first.width) * toNumber(first.height)),
        Math.max(1, toNumber(second.width) * toNumber(second.height))
    );

    return intersection / smallestArea;
}

function normalizeComparableText(text) {
    return cleanText(text)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase();
}

export function mergeNativeAndOCR(nativeContent, ocrContent) {
    const nativeWords = nativeContent?.words || [];
    const ocrWords = ocrContent?.words || [];
    const gridSize = 48;
    const nativeGrid = new Map();

    nativeWords.forEach((word) => {
        const startX = Math.floor(toNumber(word.x) / gridSize);
        const endX = Math.floor((toNumber(word.x) + toNumber(word.width)) / gridSize);
        const startY = Math.floor(toNumber(word.y) / gridSize);
        const endY = Math.floor((toNumber(word.y) + toNumber(word.height)) / gridSize);

        for (let x = startX; x <= endX; x += 1) {
            for (let y = startY; y <= endY; y += 1) {
                const key = `${x}:${y}`;
                const entries = nativeGrid.get(key) || [];
                entries.push(word);
                nativeGrid.set(key, entries);
            }
        }
    });

    const supplementalWords = ocrWords.filter((word) => {
        const centerX = toNumber(word.x) + toNumber(word.width) / 2;
        const centerY = toNumber(word.y) + toNumber(word.height) / 2;
        const cellX = Math.floor(centerX / gridSize);
        const cellY = Math.floor(centerY / gridSize);
        const candidates = [];

        for (let x = cellX - 1; x <= cellX + 1; x += 1) {
            for (let y = cellY - 1; y <= cellY + 1; y += 1) {
                candidates.push(...(nativeGrid.get(`${x}:${y}`) || []));
            }
        }

        const ocrText = normalizeComparableText(word.text);

        return !candidates.some((nativeWord) => {
            const overlap = intersectionRatio(word, nativeWord);
            const sameText =
                ocrText && ocrText === normalizeComparableText(nativeWord.text);
            return overlap >= 0.3 || (sameText && overlap >= 0.08);
        });
    });

    const words = [...nativeWords, ...supplementalWords];
    const ocrConfidenceValues = supplementalWords
        .map((word) => toNumber(word.confidence))
        .filter((value) => value > 0);

    return {
        text: words.map((word) => word.text).join(" "),
        confidence: ocrConfidenceValues.length
            ? ocrConfidenceValues.reduce((sum, value) => sum + value, 0) /
              ocrConfidenceValues.length
            : 100,
        words,
        lines: buildLinesFromWords(words),
        blocks: [],
        paragraphs: [],
        source: "hybrid",
        nativeWordCount: nativeWords.length,
        supplementalOCRWordCount: supplementalWords.length,
    };
}

export function countCharacters(content = {}) {
    return (content.words || []).reduce(
        (total, word) => total + cleanText(word.text).replace(/\s/g, "").length,
        0
    );
}
