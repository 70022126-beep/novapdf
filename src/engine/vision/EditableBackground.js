import { overlapsProtectedRegion } from "./VisualRegionSegmenter.js";

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function normalizeBox(box, dimensions, padding = 0) {
    const x = clamp(number(box.x) - padding, 0, dimensions.width);
    const y = clamp(number(box.y) - padding, 0, dimensions.height);
    const right = clamp(
        number(box.x) + number(box.width) + padding,
        0,
        dimensions.width
    );
    const bottom = clamp(
        number(box.y) + number(box.height) + padding,
        0,
        dimensions.height
    );
    return {
        x,
        y,
        width: Math.max(0, right - x),
        height: Math.max(0, bottom - y),
    };
}

function area(box = {}) {
    return Math.max(0, number(box.width)) * Math.max(0, number(box.height));
}

export function buildTextRemovalPlan(
    words = [],
    protectedRegions = [],
    dimensions = {},
    { minimumConfidence = 42, padding = 1.15 } = {}
) {
    const accepted = [];
    const rejected = [];

    words.forEach((word, index) => {
        const bbox = normalizeBox(word, dimensions, padding);
        let reason = "";
        if (!String(word.text || "").trim()) reason = "empty";
        else if (number(word.confidence, 100) < minimumConfidence) reason = "low-confidence";
        else if (bbox.width < 1 || bbox.height < 1) reason = "invalid-geometry";
        else if (overlapsProtectedRegion(bbox, protectedRegions, 0.12)) reason = "protected-visual";

        const entry = { id: `mask-${index + 1}`, bbox, word, reason };
        if (reason) rejected.push(entry);
        else accepted.push(entry);
    });

    const pageArea = Math.max(1, number(dimensions.width) * number(dimensions.height));
    return {
        accepted,
        rejected,
        coverage: accepted.reduce((sum, entry) => sum + area(entry.bbox), 0) / pageArea,
        protectedRegionCount: protectedRegions.length,
    };
}

function sampleBackgroundColor(context, box, canvasWidth, canvasHeight) {
    const padding = Math.max(2, Math.round(Math.min(box.width, box.height) * 0.18));
    const sampleBox = {
        x: clamp(Math.floor(box.x - padding), 0, canvasWidth - 1),
        y: clamp(Math.floor(box.y - padding), 0, canvasHeight - 1),
        width: clamp(Math.ceil(box.width + padding * 2), 1, canvasWidth),
        height: clamp(Math.ceil(box.height + padding * 2), 1, canvasHeight),
    };
    sampleBox.width = Math.min(sampleBox.width, canvasWidth - sampleBox.x);
    sampleBox.height = Math.min(sampleBox.height, canvasHeight - sampleBox.y);
    const imageData = context.getImageData(
        sampleBox.x,
        sampleBox.y,
        sampleBox.width,
        sampleBox.height
    );
    const data = imageData.data;
    const luminances = [];
    const colors = [];
    const step = Math.max(4, Math.floor(data.length / 2_000 / 4) * 4);

    for (let index = 0; index < data.length; index += step) {
        const red = data[index];
        const green = data[index + 1];
        const blue = data[index + 2];
        const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
        if (luminance >= 150) {
            luminances.push(luminance);
            colors.push([red, green, blue]);
        }
    }

    if (!colors.length) return [255, 255, 255];
    const sorted = colors
        .map((color, index) => ({ color, luminance: luminances[index] }))
        .sort((a, b) => a.luminance - b.luminance);
    const selected = sorted.slice(Math.floor(sorted.length * 0.55));
    return [0, 1, 2].map((channel) => Math.round(
        selected.reduce((sum, entry) => sum + entry.color[channel], 0) /
            Math.max(1, selected.length)
    ));
}

export function createEditableBackground(
    sourceCanvas,
    words = [],
    protectedRegions = [],
    { renderedScale = 1, pageWidth, pageHeight, minimumConfidence = 42 } = {}
) {
    if (!sourceCanvas) throw new Error("No se proporciono un fondo para limpiar.");
    const dimensions = {
        width: number(pageWidth, sourceCanvas.width / renderedScale),
        height: number(pageHeight, sourceCanvas.height / renderedScale),
    };
    const plan = buildTextRemovalPlan(words, protectedRegions, dimensions, {
        minimumConfidence,
    });
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!context) throw new Error("No se pudo construir el fondo editable.");
    context.drawImage(sourceCanvas, 0, 0);

    plan.accepted.forEach((entry) => {
        const box = {
            x: Math.floor(entry.bbox.x * renderedScale),
            y: Math.floor(entry.bbox.y * renderedScale),
            width: Math.max(1, Math.ceil(entry.bbox.width * renderedScale)),
            height: Math.max(1, Math.ceil(entry.bbox.height * renderedScale)),
        };
        const [red, green, blue] = sampleBackgroundColor(
            context,
            box,
            canvas.width,
            canvas.height
        );
        context.save();
        context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
        context.fillRect(box.x, box.y, box.width, box.height);
        context.restore();
    });

    return {
        canvas,
        plan,
        metadata: {
            role: "clean-editable-background",
            removedWordCount: plan.accepted.length,
            preservedWordCount: plan.rejected.length,
            protectedRegionCount: protectedRegions.length,
            removedCoverage: plan.coverage,
        },
    };
}
