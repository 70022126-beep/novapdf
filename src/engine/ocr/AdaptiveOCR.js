import { PSM } from "tesseract.js";

import { preprocessForOCR } from "./ImagePreprocessor";
import {
    deskewCanvas,
    mapClockwiseWordsToSource,
    rotateCanvasClockwise,
} from "./DocumentGeometry";
import ocrEngine from "./OCREngine";
import { rankOCRResults } from "./OCRScoring";

const SPANISH_WORDS = new Set([
    "de", "la", "el", "que", "en", "y", "los", "las", "para", "con", "por",
    "una", "del", "se", "al", "como", "más", "documento", "página",
]);
const ENGLISH_WORDS = new Set([
    "the", "of", "and", "to", "in", "is", "for", "with", "that", "this", "from",
    "page", "document", "on", "as", "are", "by", "an",
]);

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function detectTextLanguage(text) {
    const words = cleanText(text)
        .toLowerCase()
        .match(/[a-záéíóúüñ]+/g) || [];
    let spanish = 0;
    let english = 0;

    words.forEach((word) => {
        if (SPANISH_WORDS.has(word)) spanish += 1;
        if (ENGLISH_WORDS.has(word)) english += 1;
        if (/[áéíóúüñ]/.test(word)) spanish += 1.5;
    });

    if (spanish === 0 && english === 0) return "unknown";
    if (spanish > 0 && english > 0 && Math.min(spanish, english) / Math.max(spanish, english) > 0.55) {
        return "mixed";
    }
    return spanish >= english ? "spa" : "eng";
}

function levenshtein(first, second) {
    const rows = first.length + 1;
    const columns = second.length + 1;
    const previous = Array.from({ length: columns }, (_, index) => index);
    const current = new Array(columns);

    for (let row = 1; row < rows; row += 1) {
        current[0] = row;
        for (let column = 1; column < columns; column += 1) {
            current[column] = Math.min(
                current[column - 1] + 1,
                previous[column] + 1,
                previous[column - 1] +
                    (first[row - 1].toLowerCase() === second[column - 1].toLowerCase()
                        ? 0
                        : 1)
            );
        }
        for (let column = 0; column < columns; column += 1) {
            previous[column] = current[column];
        }
    }

    return previous[columns - 1];
}

function applyDictionaryCorrections(result, dictionary = []) {
    if (!dictionary.length || !result.words?.length) {
        return { result, correctionCount: 0 };
    }

    let correctionCount = 0;
    const words = result.words.map((word) => {
        if (Number(word.confidence) >= 82 || cleanText(word.text).length < 4) {
            return word;
        }
        const candidate = dictionary.find((entry) => {
            const maximumDistance = cleanText(word.text).length >= 8 ? 2 : 1;
            return levenshtein(cleanText(word.text), cleanText(entry)) <= maximumDistance;
        });
        if (!candidate) return word;
        correctionCount += 1;
        return { ...word, originalText: word.text, text: candidate, corrected: true };
    });

    return {
        result: {
            ...result,
            words,
            text: words.map((word) => word.text).join(" "),
        },
        correctionCount,
    };
}

function releaseCanvas(canvas) {
    if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
        canvas.remove();
    }
}

async function recognizeWithAbort(canvas, onProgress, options, signal) {
    if (signal?.aborted) {
        throw new DOMException("Conversión cancelada.", "AbortError");
    }

    const recognition = ocrEngine.recognize(canvas, onProgress, options);
    if (!signal) return recognition;

    let abortHandler;
    const aborted = new Promise((_, reject) => {
        abortHandler = () => {
            ocrEngine.terminate().finally(() => {
                reject(new DOMException("Conversión cancelada.", "AbortError"));
            });
        };
        signal.addEventListener("abort", abortHandler, { once: true });
    });

    try {
        return await Promise.race([recognition, aborted]);
    } finally {
        signal.removeEventListener("abort", abortHandler);
    }
}

export async function recognizeAdaptive(
    canvas,
    {
        dpi,
        onProgress,
        signal,
        dictionary = [],
        regionType = "text",
        retryThreshold = 76,
        experimentalHandwriting = false,
    } = {}
) {
    const attempts = [];
    const reportProgress = (attempt, message) => {
        const fraction = Number(message?.progress) || 0;
        onProgress?.({
            ...message,
            progress: Math.min(1, (attempt + fraction) / 3),
            attempt: attempt + 1,
        });
    };
    const first = await recognizeWithAbort(
        canvas,
        (message) => reportProgress(0, message),
        {
            dpi,
            pageSegmentationMode:
                regionType === "sparse-text" ? PSM.SPARSE_TEXT : PSM.AUTO,
        },
        signal
    );
    attempts.push({ ...first, variant: "original" });

    if (Number(first.confidence) < retryThreshold || first.words.length < 4) {
        const geometry = deskewCanvas(canvas);
        const adaptiveCanvas = preprocessForOCR(geometry.canvas, {
            contrast: 1.28,
            brightness: 4,
            grayscale: true,
            adaptive: true,
            windowSize: 21,
            offset: 11,
        });
        try {
            const adaptive = await recognizeWithAbort(
                adaptiveCanvas,
                (message) => reportProgress(1, message),
                { dpi, pageSegmentationMode: PSM.AUTO },
                signal
            );
            attempts.push({
                ...adaptive,
                variant: geometry.angle
                    ? "deskew+adaptive-threshold"
                    : "adaptive-threshold",
                deskewAngle: geometry.angle,
            });
        } finally {
            releaseCanvas(adaptiveCanvas);
            if (geometry.owned) releaseCanvas(geometry.canvas);
        }
    }

    const currentBestConfidence = Math.max(
        ...attempts.map((attempt) => Number(attempt.confidence) || 0)
    );
    if (currentBestConfidence < 64) {
        const highContrastCanvas = preprocessForOCR(canvas, {
            contrast: 1.42,
            brightness: 6,
            grayscale: true,
            threshold: 174,
        });
        try {
            const highContrast = await recognizeWithAbort(
                highContrastCanvas,
                (message) => reportProgress(2, message),
                { dpi, pageSegmentationMode: PSM.SPARSE_TEXT },
                signal
            );
            attempts.push({ ...highContrast, variant: "high-contrast" });
        } finally {
            releaseCanvas(highContrastCanvas);
        }
    }

    const orientationConfidence = Math.max(
        ...attempts.map((attempt) => Number(attempt.confidence) || 0)
    );
    if (orientationConfidence < 42 && canvas.width * canvas.height <= 22_000_000) {
        const rotatedCanvas = rotateCanvasClockwise(canvas);
        try {
            const oriented = await recognizeWithAbort(
                rotatedCanvas,
                (message) => reportProgress(2, message),
                { dpi, pageSegmentationMode: PSM.AUTO },
                signal
            );
            attempts.push({
                ...oriented,
                words: mapClockwiseWordsToSource(oriented.words, canvas.height),
                variant: "orientation-90",
                orientationDegrees: 90,
            });
        } finally {
            releaseCanvas(rotatedCanvas);
        }
    }

    if (experimentalHandwriting) {
        const handwritingCanvas = preprocessForOCR(canvas, {
            contrast: 1.2,
            brightness: 8,
            grayscale: true,
            adaptive: true,
            windowSize: 25,
            offset: 8,
        });
        try {
            const handwriting = await recognizeWithAbort(
                handwritingCanvas,
                (message) => reportProgress(2, message),
                { dpi, pageSegmentationMode: PSM.SINGLE_BLOCK },
                signal
            );
            attempts.push({
                ...handwriting,
                variant: "experimental-handwriting",
                experimental: true,
            });
        } finally {
            releaseCanvas(handwritingCanvas);
        }
    }

    const ranked = rankOCRResults(attempts);
    const selected = ranked.best || attempts[0];
    const corrected = applyDictionaryCorrections(selected, dictionary);

    return {
        ...corrected.result,
        language: detectTextLanguage(corrected.result.text),
        attempts: attempts.map((attempt) => ({
            variant: attempt.variant,
            confidence: attempt.confidence,
            words: attempt.words.length,
            deskewAngle: attempt.deskewAngle || 0,
            orientationDegrees: attempt.orientationDegrees || 0,
            experimental: Boolean(attempt.experimental),
        })),
        correctionCount: corrected.correctionCount,
        selectedVariant: selected.variant,
        adaptiveScore: selected.scoring?.score || selected.confidence,
        deskewAngle: selected.deskewAngle || 0,
        orientationDegrees: selected.orientationDegrees || 0,
    };
}
