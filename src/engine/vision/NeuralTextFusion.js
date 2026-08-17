import { buildLinesFromWords } from "../pdf-to-word/PageContentNormalizer.js";

const TEXTUAL_TYPES = new Set([
    "text-candidate",
    "heading",
    "page-header",
    "page-footer",
    "list-item",
    "caption",
    "footnote",
]);

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value) {
    return String(value ?? "")
        .replace(/^\s*#{1,6}\s*/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function getBoundingBox(items = []) {
    if (!items.length) return { x: 0, y: 0, width: 0, height: 0 };
    const x = Math.min(...items.map((item) => number(item.x)));
    const y = Math.min(...items.map((item) => number(item.y)));
    const right = Math.max(
        ...items.map((item) => number(item.x) + number(item.width))
    );
    const bottom = Math.max(
        ...items.map((item) => number(item.y) + number(item.height))
    );
    return { x, y, width: right - x, height: bottom - y };
}

function fontSizeForRegion(region) {
    const height = Math.max(1, number(region.bbox?.height));
    if (region.type === "heading") return Math.min(18, Math.max(10, height * 0.58));
    if (["page-header", "page-footer", "footnote", "caption"].includes(region.type)) {
        return Math.min(10, Math.max(7, height * 0.3));
    }
    return Math.min(12, Math.max(8.5, height / Math.max(1, Math.round(height / 11.5))));
}

function wrapTokens(tokens, region, fontSize) {
    if (!tokens.length) return [];
    const capacity = Math.max(8, Math.floor(number(region.bbox?.width) / (fontSize * 0.5)));
    const maximumLines = Math.max(
        1,
        Math.floor(number(region.bbox?.height) / Math.max(1, fontSize * 0.9))
    );
    const desiredLines = Math.min(
        maximumLines,
        Math.max(1, Math.ceil(tokens.join(" ").length / capacity))
    );
    const targetCharacters = Math.max(1, Math.ceil(tokens.join(" ").length / desiredLines));
    const lines = [];
    let line = [];
    let characters = 0;

    tokens.forEach((token, index) => {
        const addition = token.length + (line.length ? 1 : 0);
        const remainingTokens = tokens.length - index;
        const remainingLines = desiredLines - lines.length;
        if (
            line.length &&
            characters + addition > targetCharacters &&
            remainingTokens >= remainingLines
        ) {
            lines.push(line);
            line = [];
            characters = 0;
        }
        line.push(token);
        characters += token.length + (line.length > 1 ? 1 : 0);
    });
    if (line.length) lines.push(line);
    return lines;
}

function wordsFromRegion(region, provider) {
    const text = cleanText(region.text);
    const tokens = text.match(/\S+/g) || [];
    if (!tokens.length) return [];
    const fontSize = fontSizeForRegion(region);
    const wrappedLines = wrapTokens(tokens, region, fontSize);
    const lineHeight = number(region.bbox.height) / Math.max(1, wrappedLines.length);
    const confidence = Math.max(0, Math.min(100, number(region.confidence, 75)));

    return wrappedLines.flatMap((lineTokens, lineIndex) => {
        const totalUnits = lineTokens.reduce((sum, token) => sum + token.length, 0) +
            Math.max(0, lineTokens.length - 1) * 0.55;
        const usableWidth = number(region.bbox.width);
        let cursor = number(region.bbox.x);

        return lineTokens.map((token, wordIndex) => {
            const width = usableWidth * (token.length / Math.max(1, totalUnits));
            const gap = usableWidth * (0.55 / Math.max(1, totalUnits));
            const word = {
                text: token,
                x: cursor,
                y: number(region.bbox.y) + lineIndex * lineHeight,
                width,
                height: Math.max(1, Math.min(lineHeight, fontSize * 1.15)),
                confidence,
                source: "neural-ocr",
                provider,
                providerRegionId: region.id,
                semanticType: region.type,
                readingOrder: number(region.readingOrder),
                fontFamily: "Arial",
                fontSize,
                bold: region.type === "heading",
                italic: false,
                direction: "ltr",
            };
            cursor += width + (wordIndex < lineTokens.length - 1 ? gap : 0);
            return word;
        });
    });
}

function intersectionRatio(first = {}, second = {}) {
    const left = Math.max(number(first.x), number(second.x));
    const top = Math.max(number(first.y), number(second.y));
    const right = Math.min(
        number(first.x) + number(first.width),
        number(second.x) + number(second.width)
    );
    const bottom = Math.min(
        number(first.y) + number(first.height),
        number(second.y) + number(second.height)
    );
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const wordArea = Math.max(1, number(first.width) * number(first.height));
    return intersection / wordArea;
}

function semanticRegionForLine(line, regions = []) {
    let selected = null;
    let selectedOverlap = 0;
    regions.forEach((region) => {
        if (!TEXTUAL_TYPES.has(region.type)) return;
        const overlap = intersectionRatio(line.bbox, region.bbox);
        if (overlap > selectedOverlap) {
            selected = region;
            selectedOverlap = overlap;
        }
    });
    return selectedOverlap >= 0.12 ? selected : null;
}

function wordsFromTextLine(line, region, provider) {
    const tokens = cleanText(line.text).match(/\S+/g) || [];
    if (!tokens.length) return [];
    const bbox = line.bbox || {};
    const totalUnits = tokens.reduce((sum, token) => sum + token.length, 0) +
        Math.max(0, tokens.length - 1) * 0.55;
    const usableWidth = Math.max(1, number(bbox.width));
    const height = Math.max(1, number(bbox.height));
    const fontSize = Math.min(
        region?.type === "heading" ? 22 : 16,
        Math.max(7, height * 0.82)
    );
    let cursor = number(bbox.x);

    return tokens.map((token, index) => {
        const width = usableWidth * (token.length / Math.max(1, totalUnits));
        const gap = usableWidth * (0.55 / Math.max(1, totalUnits));
        const word = {
            text: token,
            x: cursor,
            y: number(bbox.y),
            width,
            height,
            confidence: number(line.confidence, region?.confidence ?? 75),
            source: "neural-ocr",
            provider,
            providerLineId: line.id,
            providerRegionId: region?.id || null,
            semanticType: region?.type || "text-candidate",
            readingOrder: number(region?.readingOrder, line.readingOrder),
            fontFamily: "Arial",
            fontSize,
            bold: region?.type === "heading",
            italic: false,
            direction: "ltr",
        };
        cursor += width + (index < tokens.length - 1 ? gap : 0);
        return word;
    });
}

function contentFromExactTextLines(vision) {
    const regions = vision?.regions || [];
    const protectedRegions = vision?.routing?.protectedRegions || [];
    const provider = vision?.provider || "neural-local";
    const sourceLines = (vision?.textLines || [])
        .filter(
            (line) =>
                cleanText(line.text) &&
                !protectedRegions.some(
                    (region) => intersectionRatio(line.bbox, region.bbox) >= 0.45
                )
        )
        .map((line, index) => {
            const region = semanticRegionForLine(line, regions);
            const words = wordsFromTextLine(line, region, provider);
            return {
                id: line.id || `neural-exact-line-${index + 1}`,
                text: words.map((word) => word.text).join(" "),
                words,
                bbox: line.bbox,
                confidence: number(line.confidence, region?.confidence ?? 75),
                source: "neural-ocr",
                semanticType: region?.type || "text-candidate",
                readingOrder: number(region?.readingOrder, index),
                providerRegionId: region?.id || null,
            };
        })
        .filter((line) => line.words.length)
        .sort(
            (first, second) =>
                first.readingOrder - second.readingOrder ||
                number(first.bbox?.y) - number(second.bbox?.y) ||
                number(first.bbox?.x) - number(second.bbox?.x)
        );

    if (!sourceLines.length) return null;
    const grouped = new Map();
    sourceLines.forEach((line) => {
        const key = line.providerRegionId || line.id;
        const entries = grouped.get(key) || [];
        entries.push(line);
        grouped.set(key, entries);
    });
    const blocks = [...grouped.entries()].map(([key, lines]) => {
        const words = lines.flatMap((line) => line.words);
        return {
            id: `neural-text-${key}`,
            text: lines.map((line) => line.text).join(" "),
            words,
            lines,
            bbox: getBoundingBox(words),
            confidence: lines.reduce((sum, line) => sum + line.confidence, 0) /
                Math.max(1, lines.length),
            source: "neural-ocr",
            semanticType: lines[0].semanticType,
            readingOrder: lines[0].readingOrder,
            providerRegionId: lines[0].providerRegionId,
        };
    });
    const words = sourceLines.flatMap((line) => line.words);
    const confidence = sourceLines.reduce((sum, line) => sum + line.confidence, 0) /
        Math.max(1, sourceLines.length);

    return {
        text: sourceLines.map((line) => line.text).join("\n"),
        words,
        lines: sourceLines,
        blocks,
        paragraphs: blocks,
        confidence,
        source: "neural-ocr-exact",
        provider,
        model: vision?.model || null,
        regionCount: blocks.length,
        exactGeometry: true,
    };
}

export function neuralVisionToContent(vision) {
    const exactContent = contentFromExactTextLines(vision);
    if (exactContent) return exactContent;

    const textualRegions = (vision?.regions || [])
        .filter(
            (region) =>
                region.source === "neural-layout" &&
                TEXTUAL_TYPES.has(region.type) &&
                cleanText(region.text)
        )
        .sort(
            (first, second) =>
                number(first.readingOrder) - number(second.readingOrder) ||
                number(first.bbox?.y) - number(second.bbox?.y) ||
                number(first.bbox?.x) - number(second.bbox?.x)
        );
    const blocks = textualRegions.map((region) => {
        const words = wordsFromRegion(region, vision?.provider || "neural-local");
        return {
            id: `neural-text-${region.id}`,
            text: words.map((word) => word.text).join(" "),
            words,
            bbox: getBoundingBox(words),
            confidence: number(region.confidence),
            source: "neural-ocr",
            semanticType: region.type,
            readingOrder: number(region.readingOrder),
            providerRegionId: region.id,
        };
    }).filter((block) => block.words.length);
    const words = blocks.flatMap((block) => block.words);
    const confidence = blocks.length
        ? blocks.reduce((sum, block) => sum + block.confidence, 0) / blocks.length
        : 0;

    return {
        text: blocks.map((block) => block.text).join("\n"),
        words,
        lines: buildLinesFromWords(words),
        blocks,
        paragraphs: blocks,
        confidence,
        source: "neural-ocr",
        provider: vision?.provider || "neural-local",
        model: vision?.model || null,
        regionCount: blocks.length,
    };
}

export function fuseNeuralTextWithOCR(ocrContent = {}, vision) {
    const neuralContent = neuralVisionToContent(vision);
    if (!neuralContent.words.length) return ocrContent;

    const neuralBoxes = neuralContent.blocks.map((block) => block.bbox);
    const supplementalWords = (ocrContent?.words || []).filter(
        (word) => !neuralBoxes.some((box) => intersectionRatio(word, box) >= 0.35)
    );
    const words = [...neuralContent.words, ...supplementalWords];
    const supplementalLines = buildLinesFromWords(supplementalWords);
    const lines = [...neuralContent.lines, ...supplementalLines].sort(
        (first, second) =>
            number(first.bbox?.y) - number(second.bbox?.y) ||
            number(first.bbox?.x) - number(second.bbox?.x)
    );

    return {
        ...ocrContent,
        text: lines.map((line) => line.text).join("\n"),
        words,
        lines,
        blocks: neuralContent.blocks,
        paragraphs: neuralContent.paragraphs,
        confidence: neuralContent.confidence,
        source: supplementalWords.length ? "neural-ocr+fallback" : "neural-ocr",
        provider: neuralContent.provider,
        model: neuralContent.model,
        neuralWordCount: neuralContent.words.length,
        supplementalOCRWordCount: supplementalWords.length,
    };
}

export function getNeuralFallbackRegions(vision) {
    return (vision?.routing?.ocrRegions || []).filter(
        (region) =>
            region.strategy === "handwriting-ocr" ||
            !TEXTUAL_TYPES.has(region.type) ||
            !cleanText(region.text)
    );
}

export { TEXTUAL_TYPES as __NEURAL_TEXTUAL_TYPES_FOR_TESTS };
