import { calculateCER, calculateWER } from "../../src/engine/evaluation/EvaluationMetrics.js";

export const OCR_CORPUS_CATEGORIES = Object.freeze([
    "clean_scan",
    "noisy_scan",
    "form_table",
    "hybrid",
]);

export const DEFAULT_OCR_CORPUS_QUOTAS = Object.freeze({
    clean_scan: 30,
    noisy_scan: 30,
    form_table: 20,
    hybrid: 20,
});

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function cleanOCRText(value) {
    return String(value ?? "")
        .normalize("NFC")
        .replace(/[\u00ad\u200b-\u200d\ufeff]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function readBox(value = {}) {
    const source = value.bbox || value.box || value;
    if (Array.isArray(source) && source.length >= 4) {
        const [first, second, third, fourth] = source.map(Number);
        const format = value.bbox_format || value.bboxFormat || "xywh";
        return format === "xyxy"
            ? { x: first, y: second, width: third - first, height: fourth - second }
            : { x: first, y: second, width: third, height: fourth };
    }
    return {
        x: number(source.x ?? source.left),
        y: number(source.y ?? source.top),
        width: number(source.width, number(source.right) - number(source.left)),
        height: number(source.height, number(source.bottom) - number(source.top)),
    };
}

function normalizeBox(value, dimensions) {
    const box = readBox(value);
    const space = value?.coordinateSpace || value?.space || value?.bboxSpace || "pixel";
    if (space !== "normalized") return box;
    return {
        x: box.x * dimensions.width,
        y: box.y * dimensions.height,
        width: box.width * dimensions.width,
        height: box.height * dimensions.height,
    };
}

function overlapRatio(first, second) {
    const left = Math.max(first.x, second.x);
    const top = Math.max(first.y, second.y);
    const right = Math.min(first.x + first.width, second.x + second.width);
    const bottom = Math.min(first.y + first.height, second.y + second.height);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const firstArea = Math.max(1, first.width * first.height);
    return intersection / firstArea;
}

export function normalizePaddleLines(payload = {}) {
    const direct = Array.isArray(payload.text_lines) ? payload.text_lines : [];
    const regional = (payload.regions || []).flatMap((region) => {
        if (Array.isArray(region.text_lines) && region.text_lines.length) {
            return region.text_lines;
        }
        return region.text && region.bbox
            ? [{
                text: region.text,
                confidence: region.confidence,
                bbox: region.bbox,
                bbox_format: region.bbox_format,
            }]
            : [];
    });
    return [...direct, ...regional].map((line, index) => ({
        id: line.id || `paddle-${index + 1}`,
        text: cleanOCRText(line.text),
        confidence: Math.max(0, Math.min(100,
            number(line.confidence, 0.75) <= 1
                ? number(line.confidence, 0.75) * 100
                : number(line.confidence, 75)
        )),
        bbox: readBox(line),
    })).filter((line) => line.text && line.bbox.width > 0 && line.bbox.height > 0);
}

export function parseTesseractTSV(tsv = "") {
    const rows = String(tsv).trim().split(/\r?\n/);
    if (rows.length < 2) return [];
    const headers = rows[0].split("\t");
    const index = Object.fromEntries(headers.map((header, position) => [header, position]));
    const groups = new Map();
    for (const row of rows.slice(1)) {
        const values = row.split("\t");
        const text = cleanOCRText(values[index.text]);
        const confidence = number(values[index.conf], -1);
        if (!text || confidence < 0) continue;
        const key = ["page_num", "block_num", "par_num", "line_num"]
            .map((field) => values[index[field]] || "0").join(":");
        const word = {
            text,
            confidence,
            bbox: {
                x: number(values[index.left]),
                y: number(values[index.top]),
                width: number(values[index.width]),
                height: number(values[index.height]),
            },
        };
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(word);
    }
    return [...groups.entries()].map(([id, words]) => {
        const left = Math.min(...words.map((word) => word.bbox.x));
        const top = Math.min(...words.map((word) => word.bbox.y));
        const right = Math.max(...words.map((word) => word.bbox.x + word.bbox.width));
        const bottom = Math.max(...words.map((word) => word.bbox.y + word.bbox.height));
        return {
            id: `tesseract-${id}`,
            text: cleanOCRText(words.map((word) => word.text).join(" ")),
            confidence: words.reduce((sum, word) => sum + word.confidence, 0) / words.length,
            bbox: { x: left, y: top, width: right - left, height: bottom - top },
        };
    });
}

export function hypothesisForRegion(lines = [], region = {}, dimensions = {}) {
    const regionBox = normalizeBox(region, dimensions);
    const matching = lines.filter((line) => {
        const box = readBox(line);
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        return (
            centerX >= regionBox.x &&
            centerX <= regionBox.x + regionBox.width &&
            centerY >= regionBox.y &&
            centerY <= regionBox.y + regionBox.height
        ) || overlapRatio(box, regionBox) >= 0.5;
    }).sort((first, second) => (
        first.bbox.y - second.bbox.y || first.bbox.x - second.bbox.x
    ));
    return {
        text: cleanOCRText(matching.map((line) => line.text).join(" ")),
        confidence: matching.length
            ? matching.reduce((sum, line) => sum + number(line.confidence), 0) / matching.length
            : 0,
        lineCount: matching.length,
    };
}

function textPlausibility(text) {
    const characters = Array.from(cleanOCRText(text));
    if (!characters.length) return 0;
    const useful = characters.filter((character) => /[\p{L}\p{N}\p{P}\p{Zs}]/u.test(character)).length;
    return useful / characters.length;
}

export function chooseRegionalFusion(region = {}, paddle = {}, tesseract = {}) {
    const paddleText = cleanOCRText(paddle.text);
    const tesseractText = cleanOCRText(tesseract.text);
    if (!paddleText) return { ...tesseract, engine: "tesseract", reason: "paddle_empty" };
    if (!tesseractText) return { ...paddle, engine: "paddle", reason: "tesseract_empty" };

    const type = String(region.type || "text").toLowerCase();
    const paddlePrior = ["table", "form", "stamp", "seal", "rotated", "photo"].includes(type)
        ? 7 : 0;
    const tesseractPrior = type === "clean_text" ? 3 : 0;
    const agreement = 1 - calculateCER(
        paddleText.toLocaleLowerCase("es"),
        tesseractText.toLocaleLowerCase("es")
    ).cer;
    const paddleScore = number(paddle.confidence) * 0.7
        + textPlausibility(paddleText) * 20
        + Math.max(0, agreement) * 10
        + paddlePrior;
    const tesseractScore = number(tesseract.confidence) * 0.7
        + textPlausibility(tesseractText) * 20
        + Math.max(0, agreement) * 10
        + tesseractPrior;
    return paddleScore >= tesseractScore
        ? { ...paddle, engine: "paddle", reason: "calibrated_regional_score" }
        : { ...tesseract, engine: "tesseract", reason: "calibrated_regional_score" };
}

export function evaluateRegion(referenceText, hypothesis = {}) {
    const reference = cleanOCRText(referenceText);
    const actual = cleanOCRText(hypothesis.text);
    const cer = calculateCER(reference, actual);
    const wer = calculateWER(reference, actual);
    return {
        cer: Number((cer.cer * 100).toFixed(2)),
        wer: Number((wer.wer * 100).toFixed(2)),
        characterErrors: cer.errors,
        referenceCharacters: cer.referenceCharacters,
        wordErrors: wer.errors,
        referenceWords: wer.referenceWords,
        hypothesisCharacters: actual.length,
        confidence: Number(number(hypothesis.confidence).toFixed(2)),
    };
}

export function aggregateRegionMetrics(regions = []) {
    const characterErrors = regions.reduce((sum, region) => sum + region.characterErrors, 0);
    const referenceCharacters = regions.reduce((sum, region) => sum + region.referenceCharacters, 0);
    const wordErrors = regions.reduce((sum, region) => sum + region.wordErrors, 0);
    const referenceWords = regions.reduce((sum, region) => sum + region.referenceWords, 0);
    return {
        regions: regions.length,
        cer: referenceCharacters
            ? Number(((characterErrors / referenceCharacters) * 100).toFixed(2)) : 0,
        wer: referenceWords
            ? Number(((wordErrors / referenceWords) * 100).toFixed(2)) : 0,
        characterErrors,
        referenceCharacters,
        wordErrors,
        referenceWords,
        meanConfidence: regions.length
            ? Number((regions.reduce((sum, region) => sum + region.confidence, 0) / regions.length).toFixed(2))
            : 0,
    };
}

export function validateOCRCorpus(manifest = {}, annotations = new Map()) {
    const quotas = { ...DEFAULT_OCR_CORPUS_QUOTAS, ...(manifest.quotas || {}) };
    const samples = Array.isArray(manifest.samples) ? manifest.samples : [];
    const errors = [];
    const ids = new Set();
    const counts = Object.fromEntries(OCR_CORPUS_CATEGORIES.map((category) => [category, 0]));
    const verified = Object.fromEntries(OCR_CORPUS_CATEGORIES.map((category) => [category, 0]));
    let rotated = 0;
    let photographs = 0;
    for (const sample of samples) {
        if (!sample.id || ids.has(sample.id)) errors.push(`ID duplicado o vacío: ${sample.id || "(vacío)"}`);
        ids.add(sample.id);
        if (!OCR_CORPUS_CATEGORIES.includes(sample.category)) {
            errors.push(`Categoría inválida en ${sample.id}: ${sample.category}`);
            continue;
        }
        counts[sample.category] += 1;
        const annotation = annotations.get(sample.id);
        if (sample.categoryReview !== "human_verified") {
            errors.push(`${sample.id}: categoría sin verificación humana.`);
        }
        if (!annotation || annotation.status !== "human_verified") {
            errors.push(`${sample.id}: transcripción sin verificación humana.`);
        } else if (!(annotation.regions || []).some((region) => !region.ignore && cleanOCRText(region.text))) {
            errors.push(`${sample.id}: no contiene regiones transcritas.`);
        } else {
            verified[sample.category] += 1;
        }
        const tags = new Set(sample.tags || []);
        if (number(sample.rotation) % 360 !== 0 || tags.has("rotated")) rotated += 1;
        if (tags.has("photo") || tags.has("photograph")) photographs += 1;
    }
    for (const category of OCR_CORPUS_CATEGORIES) {
        if (counts[category] < number(quotas[category])) {
            errors.push(`${category}: ${counts[category]}/${quotas[category]} páginas.`);
        }
    }
    if (!rotated) errors.push("Falta al menos una muestra rotada.");
    if (!photographs) errors.push("Falta al menos una fotografía documental.");
    return {
        valid: errors.length === 0,
        errors,
        samples: samples.length,
        quotas,
        counts,
        verified,
        rotated,
        photographs,
    };
}
