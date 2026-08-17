const PROTECTED_REGION_TYPES = new Set([
    "photo",
    "graphic",
    "signature",
    "stamp",
    "scribble",
    "stain",
]);

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function boxArea(box = {}) {
    return Math.max(0, number(box.width)) * Math.max(0, number(box.height));
}

function intersectionArea(first = {}, second = {}) {
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
    return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function boxesAreNear(first, second, paddingX, paddingY) {
    return !(
        first.x + first.width + paddingX < second.x ||
        second.x + second.width + paddingX < first.x ||
        first.y + first.height + paddingY < second.y ||
        second.y + second.height + paddingY < first.y
    );
}

function unionBoxes(boxes) {
    const left = Math.min(...boxes.map((box) => number(box.x)));
    const top = Math.min(...boxes.map((box) => number(box.y)));
    const right = Math.max(...boxes.map((box) => number(box.x) + number(box.width)));
    const bottom = Math.max(...boxes.map((box) => number(box.y) + number(box.height)));
    return {
        x: left,
        y: top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
    };
}

function weightedAverage(entries, key) {
    const total = entries.reduce((sum, entry) => sum + number(entry.sampleCount, 1), 0);
    if (!total) return 0;
    return entries.reduce(
        (sum, entry) => sum + number(entry[key]) * number(entry.sampleCount, 1),
        0
    ) / total;
}

export function classifyVisualRegion({ bbox, dimensions, metrics = {} }) {
    const pageArea = Math.max(1, boxArea(dimensions));
    const areaRatio = boxArea(bbox) / pageArea;
    const aspectRatio = number(bbox.width) / Math.max(1, number(bbox.height));
    const centerY = (number(bbox.y) + number(bbox.height) / 2) /
        Math.max(1, number(dimensions.height));
    const inkDensity = number(metrics.inkDensity);
    const colorfulness = number(metrics.colorfulness);
    const tonalVariance = number(metrics.tonalVariance);
    const edgeDensity = number(metrics.edgeDensity);
    const colorInkDensity = number(metrics.colorInkDensity);

    if (
        areaRatio >= 0.025 &&
        (tonalVariance >= 1_050 || colorfulness >= 30) &&
        inkDensity >= 0.14
    ) {
        return {
            type: "photo",
            confidence: clamp(70 + tonalVariance / 90 + colorfulness / 4, 70, 96),
            strategy: "preserve-image",
            protected: true,
        };
    }

    if (
        colorInkDensity >= 0.035 &&
        colorfulness >= 20 &&
        areaRatio <= 0.075 &&
        aspectRatio >= 0.55 &&
        aspectRatio <= 1.75
    ) {
        return {
            type: "stamp",
            confidence: clamp(68 + colorInkDensity * 140 + colorfulness / 5, 68, 94),
            strategy: "preserve-image",
            protected: true,
        };
    }

    if (
        centerY >= 0.5 &&
        areaRatio <= 0.055 &&
        aspectRatio >= 2.1 &&
        inkDensity >= 0.018 &&
        inkDensity <= 0.34 &&
        edgeDensity >= 0.07
    ) {
        return {
            type: "signature",
            confidence: clamp(64 + aspectRatio * 2.4 + edgeDensity * 35, 64, 91),
            strategy: "preserve-image",
            protected: true,
        };
    }

    if (
        areaRatio <= 0.035 &&
        (aspectRatio >= 4.8 || aspectRatio <= 0.2) &&
        inkDensity <= 0.28 &&
        edgeDensity >= 0.045
    ) {
        return {
            type: "scribble",
            confidence: clamp(60 + edgeDensity * 50 + Math.min(12, aspectRatio), 60, 88),
            strategy: "preserve-image",
            protected: true,
        };
    }

    if (
        areaRatio >= 0.004 &&
        areaRatio <= 0.08 &&
        tonalVariance >= 420 &&
        inkDensity >= 0.28 &&
        edgeDensity < 0.09
    ) {
        return {
            type: "stain",
            confidence: clamp(58 + inkDensity * 45 + tonalVariance / 180, 58, 86),
            strategy: "preserve-image",
            protected: true,
        };
    }

    if (areaRatio >= 0.01 && edgeDensity >= 0.035 && inkDensity >= 0.012) {
        return {
            type: "text-candidate",
            confidence: clamp(61 + edgeDensity * 45 + Math.min(12, aspectRatio), 61, 92),
            strategy: "printed-ocr",
            protected: false,
        };
    }

    return {
        type: "graphic",
        confidence: 56,
        strategy: "preserve-image",
        protected: true,
    };
}

export function buildOCRRoutingPlan(regions = [], dimensions = {}) {
    const pageArea = Math.max(1, boxArea(dimensions));
    const ocrRegions = regions.filter(
        (region) =>
            ["printed-ocr", "handwriting-ocr"].includes(region.strategy) &&
            region.confidence >= 62
    );
    const protectedRegions = regions.filter(
        (region) => region.protected && region.confidence >= 66
    );
    const ocrCoverage = ocrRegions.reduce(
        (sum, region) => sum + boxArea(region.bbox),
        0
    ) / pageArea;
    const protectedCoverage = protectedRegions.reduce(
        (sum, region) => sum + boxArea(region.bbox),
        0
    ) / pageArea;
    const regionalCandidate =
        ocrRegions.length >= 2 &&
        ocrRegions.length <= 32 &&
        ocrCoverage >= 0.055 &&
        ocrCoverage <= 0.93;

    return {
        strategy: regionalCandidate ? "regional" : "global",
        ocrRegions,
        protectedRegions,
        ocrCoverage,
        protectedCoverage,
        reason: regionalCandidate
            ? "Se detectaron zonas de texto separables antes del OCR."
            : "La segmentacion no es suficientemente estable; se usara OCR global seguro.",
    };
}

function estimateBackground(imageData, width, height) {
    const data = imageData.data;
    const points = [
        [1, 1],
        [Math.max(1, width - 2), 1],
        [1, Math.max(1, height - 2)],
        [Math.max(1, width - 2), Math.max(1, height - 2)],
        [Math.floor(width / 2), 1],
        [Math.floor(width / 2), Math.max(1, height - 2)],
    ];
    const luminances = points.map(([x, y]) => {
        const index = (y * width + x) * 4;
        return data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    }).sort((a, b) => a - b);
    return luminances[Math.floor(luminances.length / 2)] || 255;
}

function analyzeTile(imageData, width, height, box, background) {
    const data = imageData.data;
    let samples = 0;
    let ink = 0;
    let colored = 0;
    let luminanceTotal = 0;
    let luminanceSquared = 0;
    let colorTotal = 0;
    let edges = 0;
    let comparisons = 0;
    const step = 2;

    for (let y = box.y; y < Math.min(height, box.y + box.height); y += step) {
        let previousLuminance = null;
        for (let x = box.x; x < Math.min(width, box.x + box.width); x += step) {
            const index = (y * width + x) * 4;
            const red = data[index];
            const green = data[index + 1];
            const blue = data[index + 2];
            const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
            const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
            const difference = Math.abs(background - luminance);
            samples += 1;
            luminanceTotal += luminance;
            luminanceSquared += luminance * luminance;
            colorTotal += spread;
            if (difference >= 22 || luminance <= 190) ink += 1;
            if (spread >= 28 && luminance <= 238) colored += 1;
            if (previousLuminance !== null) {
                comparisons += 1;
                if (Math.abs(previousLuminance - luminance) >= 34) edges += 1;
            }
            previousLuminance = luminance;
        }
    }

    const mean = samples ? luminanceTotal / samples : background;
    return {
        ...box,
        sampleCount: samples,
        inkDensity: samples ? ink / samples : 0,
        colorInkDensity: samples ? colored / samples : 0,
        colorfulness: samples ? colorTotal / samples : 0,
        tonalVariance: samples ? Math.max(0, luminanceSquared / samples - mean * mean) : 0,
        edgeDensity: comparisons ? edges / comparisons : 0,
    };
}

function clusterTiles(tiles, cellSize) {
    const pending = new Set(tiles.map((_, index) => index));
    const clusters = [];

    while (pending.size) {
        const firstIndex = pending.values().next().value;
        pending.delete(firstIndex);
        const queue = [firstIndex];
        const entries = [];

        while (queue.length) {
            const index = queue.pop();
            const current = tiles[index];
            entries.push(current);
            for (const candidateIndex of [...pending]) {
                const candidate = tiles[candidateIndex];
                if (boxesAreNear(current, candidate, cellSize * 0.7, cellSize * 0.45)) {
                    pending.delete(candidateIndex);
                    queue.push(candidateIndex);
                }
            }
        }

        clusters.push(entries);
    }

    return clusters;
}

export function segmentPageVisuals(
    sourceCanvas,
    { pageWidth, pageHeight, maximumSide = 1_400 } = {}
) {
    if (!sourceCanvas) throw new Error("No se proporciono una pagina para segmentar.");
    const sourceWidth = Math.max(1, sourceCanvas.width);
    const sourceHeight = Math.max(1, sourceCanvas.height);
    const scale = Math.min(1, maximumSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!context) throw new Error("No se pudo analizar visualmente la pagina.");
    context.drawImage(sourceCanvas, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    const background = estimateBackground(imageData, width, height);
    const cellSize = clamp(Math.round(Math.min(width, height) / 22), 28, 54);
    const activeTiles = [];

    for (let y = 0; y < height; y += cellSize) {
        for (let x = 0; x < width; x += cellSize) {
            const tile = analyzeTile(
                imageData,
                width,
                height,
                {
                    x,
                    y,
                    width: Math.min(cellSize, width - x),
                    height: Math.min(cellSize, height - y),
                },
                background
            );
            if (
                tile.inkDensity >= 0.008 &&
                tile.inkDensity <= 0.91 &&
                (tile.edgeDensity >= 0.018 || tile.tonalVariance >= 170)
            ) {
                activeTiles.push(tile);
            }
        }
    }

    const dimensions = {
        width: number(pageWidth, sourceWidth),
        height: number(pageHeight, sourceHeight),
    };
    const toPageX = dimensions.width / width;
    const toPageY = dimensions.height / height;
    const minimumArea = width * height * 0.00045;
    const regions = clusterTiles(activeTiles, cellSize)
        .map((entries, index) => {
            const rasterBox = unionBoxes(entries);
            if (boxArea(rasterBox) < minimumArea) return null;
            const bbox = {
                x: Math.max(0, rasterBox.x * toPageX - 2),
                y: Math.max(0, rasterBox.y * toPageY - 2),
                width: Math.min(
                    dimensions.width - rasterBox.x * toPageX,
                    rasterBox.width * toPageX + 4
                ),
                height: Math.min(
                    dimensions.height - rasterBox.y * toPageY,
                    rasterBox.height * toPageY + 4
                ),
            };
            const metrics = {
                inkDensity: weightedAverage(entries, "inkDensity"),
                colorInkDensity: weightedAverage(entries, "colorInkDensity"),
                colorfulness: weightedAverage(entries, "colorfulness"),
                tonalVariance: weightedAverage(entries, "tonalVariance"),
                edgeDensity: weightedAverage(entries, "edgeDensity"),
            };
            const classification = classifyVisualRegion({ bbox, dimensions, metrics });
            return {
                id: `vision-${index + 1}`,
                bbox,
                metrics,
                ...classification,
                source: "visual-segmentation",
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
    const routing = buildOCRRoutingPlan(regions, dimensions);

    canvas.width = 1;
    canvas.height = 1;
    canvas.remove();

    return {
        provider: "novapdf-vision-local",
        dimensions,
        regions,
        routing,
        statistics: {
            backgroundLuminance: Math.round(background),
            analyzedPixels: width * height,
            activeTileCount: activeTiles.length,
            protectedRegionCount: routing.protectedRegions.length,
            ocrRegionCount: routing.ocrRegions.length,
        },
    };
}

export function isProtectedVisualType(type) {
    return PROTECTED_REGION_TYPES.has(type);
}

export function overlapsProtectedRegion(box, regions = [], threshold = 0.18) {
    const area = Math.max(1, boxArea(box));
    return regions.some((region) => intersectionArea(box, region.bbox || region) / area >= threshold);
}
