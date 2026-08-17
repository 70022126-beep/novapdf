function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function boxCenter(box = {}) {
    return {
        x: number(box.x) + number(box.width) / 2,
        y: number(box.y) + number(box.height) / 2,
    };
}

function overlapRatio(first = {}, second = {}) {
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
    const smallest = Math.max(
        1,
        Math.min(
            number(first.width) * number(first.height),
            number(second.width) * number(second.height)
        )
    );
    return intersection / smallest;
}

function averageWordHeight(words = []) {
    return words.length
        ? words.reduce((sum, word) => sum + number(word.fontSize, word.height), 0) /
              words.length
        : 0;
}

function classifyTextRegion(paragraph, dimensions, medianFontSize) {
    const text = cleanText(paragraph.text);
    const normalized = text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    const fontSize = averageWordHeight(paragraph.words);
    const center = boxCenter(paragraph.bbox);
    const shortText = text.length <= 180;

    if (
        /(?:[=≈≠≤≥±×÷∑√∫∞∆π]|\b(?:sen|cos|tan|log|lim)\b|\d+\s*[⁄/]\s*\d+)/i.test(
            text
        )
    ) {
        return "formula";
    }

    if (/^(?:[•●▪◦‣–—-]|\(?\d+[.)]|[a-z][.)])\s+/i.test(text)) {
        return "list-item";
    }

    if (
        /(?:_{3,}|\[(?:\s|x)?\]|☐|☑|\b(?:firma|dni|fecha|nombre|dirección|telefono|correo)\s*:)/i.test(
            text
        )
    ) {
        return "form-field";
    }

    if (/^(?:figura|imagen|gr[aá]fico|tabla|fuente|fotograf[ií]a)\b/i.test(text)) {
        return "caption";
    }

    if (
        shortText &&
        fontSize >= Math.max(13, medianFontSize * 1.28) &&
        !/[.!?]$/.test(text)
    ) {
        return "heading";
    }

    if (
        center.y >= dimensions.height * 0.82 &&
        fontSize > 0 &&
        fontSize <= medianFontSize * 0.82
    ) {
        return "footnote";
    }

    if (
        paragraph.bbox.width < dimensions.width * 0.58 &&
        paragraph.bbox.height > medianFontSize * 1.5
    ) {
        return "text-box";
    }

    if (/^(?:cap[ií]tulo|secci[oó]n|anexo)\b/.test(normalized)) {
        return "heading";
    }

    return "text";
}

function classifyImageRegion(image, dimensions) {
    const center = boxCenter(image);
    const ratio = number(image.width) / Math.max(1, number(image.height));
    const metrics = image.visualMetrics || {};

    if (
        center.y > dimensions.height * 0.62 &&
        ratio > 2.2 &&
        image.height < dimensions.height * 0.18
    ) {
        return "signature";
    }

    if (
        center.y > dimensions.height * 0.55 &&
        ratio >= 0.72 &&
        ratio <= 1.35 &&
        image.width < dimensions.width * 0.28 &&
        number(metrics.inkDensity) > 0.08
    ) {
        return "stamp";
    }

    if (number(metrics.colorfulness) >= 24 || number(metrics.tonalVariance) >= 900) {
        return "photo";
    }

    return "graphic";
}

function assignColumns(regions, pageWidth) {
    const contentRegions = regions.filter(
        (region) => region.bbox.width < pageWidth * 0.72 && region.type !== "table"
    );
    const sorted = [...contentRegions].sort((a, b) => a.bbox.x - b.bbox.x);
    const columns = [];

    sorted.forEach((region) => {
        const center = boxCenter(region.bbox).x;
        let column = columns.find(
            (candidate) => Math.abs(candidate.center - center) <= pageWidth * 0.16
        );
        if (!column) {
            column = { center, regions: [] };
            columns.push(column);
        }
        column.regions.push(region);
        column.center =
            column.regions.reduce((sum, entry) => sum + boxCenter(entry.bbox).x, 0) /
            column.regions.length;
    });

    columns.sort((a, b) => a.center - b.center);
    columns.forEach((column, index) => {
        column.regions.forEach((region) => {
            region.columnIndex = index;
        });
    });

    regions.forEach((region) => {
        if (region.columnIndex === undefined) {
            region.columnIndex = -1;
        }
    });

    return columns;
}

function orderRegions(regions, pageWidth) {
    const columns = assignColumns(regions, pageWidth);
    const spanning = regions
        .filter((region) => region.columnIndex === -1)
        .sort((a, b) => a.bbox.y - b.bbox.y);
    const ordered = [];
    let segmentTop = 0;

    const appendSegment = (bottom) => {
        columns.forEach((column) => {
            column.regions
                .filter(
                    (region) =>
                        boxCenter(region.bbox).y >= segmentTop &&
                        boxCenter(region.bbox).y < bottom
                )
                .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
                .forEach((region) => ordered.push(region));
        });
    };

    spanning.forEach((region) => {
        appendSegment(region.bbox.y);
        ordered.push(region);
        segmentTop = region.bbox.y + region.bbox.height;
    });
    appendSegment(Infinity);

    const remaining = regions.filter((region) => !ordered.includes(region));
    remaining
        .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
        .forEach((region) => ordered.push(region));

    ordered.forEach((region, index) => {
        region.readingOrder = index;
    });

    return ordered;
}

function linkCaptions(regions) {
    const visualRegions = regions.filter((region) =>
        ["photo", "graphic", "signature", "stamp"].includes(region.type)
    );

    regions
        .filter((region) => region.type === "caption")
        .forEach((caption) => {
            const captionCenter = boxCenter(caption.bbox);
            let nearest = null;
            let nearestDistance = Infinity;

            visualRegions.forEach((visual) => {
                const visualCenter = boxCenter(visual.bbox);
                const verticalDistance = captionCenter.y - visualCenter.y;
                const horizontalDistance = Math.abs(captionCenter.x - visualCenter.x);
                const distance = Math.abs(verticalDistance) + horizontalDistance * 0.35;
                if (
                    verticalDistance >= -visual.bbox.height * 0.3 &&
                    distance < nearestDistance
                ) {
                    nearest = visual;
                    nearestDistance = distance;
                }
            });

            if (nearest) {
                caption.parentRegionId = nearest.id;
            }
        });
}

export function analyzePageRegions({
    pageNumber,
    dimensions,
    analysis,
    images = [],
    visualRegions = [],
    pageType,
}) {
    const regions = [];
    const tableBoxes = analysis.tables.map((table) => table.bbox);
    const formulaBoxes = (analysis.neuralFormulas || []).map((formula) => formula.bbox);
    const medianFontSize = Math.max(9, number(analysis.statistics.averageWordHeight) * 0.82);

    analysis.tables.forEach((table, index) => {
        regions.push({
            id: `p${pageNumber}-table-${index + 1}`,
            type: "table",
            source: pageType.type === "digital" ? "native" : "ocr",
            confidence: number(table.confidence, 70),
            bbox: table.bbox,
            content: table,
            editable: true,
        });
    });

    (analysis.neuralFormulas || []).forEach((formula, index) => {
        regions.push({
            id: formula.id || `p${pageNumber}-neural-formula-${index + 1}`,
            type: "formula",
            source: "neural-layout",
            confidence: number(formula.confidence, 75),
            bbox: formula.bbox,
            text: cleanText(formula.text || formula.latex),
            latex: cleanText(formula.latex),
            editable: true,
        });
    });

    analysis.paragraphs.forEach((paragraph, index) => {
        if (
            tableBoxes.some((box) => overlapRatio(box, paragraph.bbox) > 0.45) ||
            formulaBoxes.some((box) => overlapRatio(box, paragraph.bbox) > 0.6)
        ) {
            return;
        }
        const type = classifyTextRegion(paragraph, dimensions, medianFontSize);
        const rotation = average(
            paragraph.words
                .map((word) => number(word.rotation))
        );
        regions.push({
            id: `p${pageNumber}-${type}-${index + 1}`,
            type,
            source: paragraph.words.some((word) => word.source === "ocr")
                ? paragraph.words.some((word) => word.source === "native")
                    ? "hybrid"
                    : "ocr"
                : "native",
            confidence: average(
                paragraph.words
                    .map((word) => number(word.confidence))
                    .filter((value) => value > 0)
            ),
            bbox: paragraph.bbox,
            text: paragraph.text,
            words: paragraph.words,
            lines: paragraph.lines,
            rotation,
            rotated: Math.abs(rotation) >= 2,
            editable: true,
        });
    });

    images.forEach((image, index) => {
        const type = classifyImageRegion(image, dimensions);
        regions.push({
            id: `p${pageNumber}-${type}-${index + 1}`,
            type,
            source: "image",
            confidence: type === "graphic" || type === "photo" ? 82 : 68,
            bbox: {
                x: image.x,
                y: image.y,
                width: image.width,
                height: image.height,
            },
            image,
            editable: false,
        });
    });

    visualRegions.forEach((visual, index) => {
        if (
            regions.some(
                (region) =>
                    region.source === "image" &&
                    overlapRatio(region.bbox, visual.bbox) >= 0.72
            )
        ) {
            return;
        }

        regions.push({
            id: `p${pageNumber}-vision-${visual.type}-${index + 1}`,
            type: visual.type,
            source: "visual-segmentation",
            confidence: number(visual.confidence, 66),
            bbox: { ...visual.bbox },
            visualMetrics: visual.metrics,
            strategy: visual.strategy || "preserve-image",
            protected: true,
            editable: false,
        });
    });

    linkCaptions(regions);
    const ordered = orderRegions(regions, dimensions.width);
    const counts = ordered.reduce((result, region) => {
        result[region.type] = (result[region.type] || 0) + 1;
        return result;
    }, {});

    return {
        pageNumber,
        regions: ordered,
        counts,
        columnCount: Math.max(
            1,
            ...ordered.map((region) => region.columnIndex + 1)
        ),
        lowConfidenceRegions: ordered.filter(
            (region) => region.confidence > 0 && region.confidence < 70
        ).length,
        rotatedTextRegions: ordered.filter((region) => region.rotated).length,
    };
}

function average(values) {
    return values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 100;
}
