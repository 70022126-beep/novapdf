function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function boxArea(box = {}) {
    return Math.max(0, number(box.width)) * Math.max(0, number(box.height));
}

function rangeOverlap(firstStart, firstEnd, secondStart, secondEnd) {
    return Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart));
}

function mergeCoordinates(values, tolerance = 1.8) {
    const groups = [];
    [...values].sort((a, b) => a - b).forEach((value) => {
        const group = groups.find(
            (entry) => Math.abs(entry.reduce((sum, item) => sum + item, 0) /
                entry.length - value) <= tolerance
        );
        if (group) group.push(value);
        else groups.push([value]);
    });
    return groups.map(
        (group) => group.reduce((sum, value) => sum + value, 0) / group.length
    );
}

function segmentsConnect(first, second) {
    if (first.orientation === second.orientation) {
        if (first.orientation === "horizontal") {
            return Math.abs(first.y - second.y) <= 1.8 &&
                rangeOverlap(
                    first.x - 2,
                    first.x + first.width + 2,
                    second.x,
                    second.x + second.width
                ) > 0;
        }
        return Math.abs(first.x - second.x) <= 1.8 &&
            rangeOverlap(
                first.y - 2,
                first.y + first.height + 2,
                second.y,
                second.y + second.height
            ) > 0;
    }

    const horizontal = first.orientation === "horizontal" ? first : second;
    const vertical = first.orientation === "vertical" ? first : second;
    return vertical.x >= horizontal.x - 2 &&
        vertical.x <= horizontal.x + horizontal.width + 2 &&
        horizontal.y >= vertical.y - 2 &&
        horizontal.y <= vertical.y + vertical.height + 2;
}

function clusterSegments(segments) {
    const pending = new Set(segments.map((_, index) => index));
    const clusters = [];
    while (pending.size) {
        const first = pending.values().next().value;
        pending.delete(first);
        const queue = [first];
        const cluster = [];
        while (queue.length) {
            const index = queue.pop();
            const current = segments[index];
            cluster.push(current);
            for (const candidateIndex of [...pending]) {
                if (segmentsConnect(current, segments[candidateIndex])) {
                    pending.delete(candidateIndex);
                    queue.push(candidateIndex);
                }
            }
        }
        clusters.push(cluster);
    }
    return clusters;
}

function segmentKey(segment) {
    return [
        segment.orientation,
        Math.round(segment.x * 2),
        Math.round(segment.y * 2),
        Math.round(segment.width * 2),
        Math.round(segment.height * 2),
    ].join(":");
}

function deduplicateSegments(segments) {
    const unique = new Map();
    segments.forEach((segment) => unique.set(segmentKey(segment), segment));
    return [...unique.values()];
}

function boundaryCoverage(segments, x, top, bottom) {
    const relevant = segments.filter(
        (segment) =>
            segment.orientation === "vertical" &&
            Math.abs(segment.x - x) <= 2.2
    );
    const intervals = relevant
        .map((segment) => [
            Math.max(top, segment.y),
            Math.min(bottom, segment.y + segment.height),
        ])
        .filter(([start, end]) => end > start)
        .sort((first, second) => first[0] - second[0]);
    let covered = 0;
    let cursor = -Infinity;
    intervals.forEach(([start, end]) => {
        const effectiveStart = Math.max(start, cursor);
        if (end > effectiveStart) covered += end - effectiveStart;
        cursor = Math.max(cursor, end);
    });
    return covered / Math.max(1, bottom - top);
}

function wordsInside(words, box) {
    return (words || []).filter((word) => {
        const centerX = number(word.x) + number(word.width) / 2;
        const centerY = number(word.y) + number(word.height) / 2;
        return centerX >= box.x - 1 &&
            centerX <= box.x + box.width + 1 &&
            centerY >= box.y - 1 &&
            centerY <= box.y + box.height + 1;
    });
}

function textFromWords(words) {
    return [...words]
        .sort((first, second) => {
            const height = Math.max(2, Math.min(number(first.height), number(second.height)));
            if (Math.abs(number(first.y) - number(second.y)) > height * 0.55) {
                return number(first.y) - number(second.y);
            }
            return number(first.x) - number(second.x);
        })
        .map((word) => cleanText(word.text))
        .filter(Boolean)
        .join(" ");
}

function tableFromCluster(cluster, words, dimensions, index) {
    const horizontal = cluster.filter((segment) => segment.orientation === "horizontal");
    const vertical = cluster.filter((segment) => segment.orientation === "vertical");
    const xCoordinates = mergeCoordinates(vertical.map((segment) => segment.x));
    const yCoordinates = mergeCoordinates(horizontal.map((segment) => segment.y));
    if (xCoordinates.length < 2 || yCoordinates.length < 2) return null;

    const x = xCoordinates[0];
    const y = yCoordinates[0];
    const right = xCoordinates.at(-1);
    const bottom = yCoordinates.at(-1);
    const bbox = { x, y, width: right - x, height: bottom - y };
    if (
        bbox.width < 72 ||
        bbox.height < 28 ||
        boxArea(bbox) < 2_500 ||
        boxArea(bbox) > boxArea(dimensions) * 0.92
    ) {
        return null;
    }

    const raw = [];
    const rows = [];
    for (let rowIndex = 0; rowIndex < yCoordinates.length - 1; rowIndex += 1) {
        const top = yCoordinates[rowIndex];
        const rowBottom = yCoordinates[rowIndex + 1];
        if (rowBottom - top < 3) continue;
        const cells = [];
        const row = [];
        let columnIndex = 0;
        while (columnIndex < xCoordinates.length - 1) {
            let columnSpan = 1;
            while (
                columnIndex + columnSpan < xCoordinates.length - 1 &&
                boundaryCoverage(
                    vertical,
                    xCoordinates[columnIndex + columnSpan],
                    top,
                    rowBottom
                ) < 0.58
            ) {
                columnSpan += 1;
            }
            const cellRight = xCoordinates[columnIndex + columnSpan];
            const cellBox = {
                x: xCoordinates[columnIndex],
                y: top,
                width: cellRight - xCoordinates[columnIndex],
                height: rowBottom - top,
            };
            const text = textFromWords(wordsInside(words, cellBox));
            cells.push({
                text,
                bbox: cellBox,
                rowSpan: 1,
                columnSpan,
            });
            row.push(text);
            for (let offset = 1; offset < columnSpan; offset += 1) row.push("");
            columnIndex += columnSpan;
        }
        raw.push({ cells });
        rows.push(row);
    }
    if (rows.length < 2) return null;

    return {
        id: `vector-table-${index + 1}`,
        bbox,
        rows,
        headers: [],
        confidence: 98,
        structuralScore: 98,
        source: "native-vector",
        columnAnchors: xCoordinates.slice(0, -1),
        structure: {
            raw,
            columnAnchors: xCoordinates.slice(0, -1),
            vectorGrid: {
                xCoordinates,
                yCoordinates,
            },
        },
    };
}

export function buildVectorTablesFromSegments(segments, words, dimensions) {
    return clusterSegments(deduplicateSegments(segments))
        .map((cluster, index) => tableFromCluster(cluster, words, dimensions, index))
        .filter(Boolean)
        .sort((first, second) => first.bbox.y - second.bbox.y);
}

function readMinMax(args) {
    const raw = args?.[2];
    if (!raw) return null;
    const values = Array.from(raw.length !== undefined ? raw : Object.values(raw)).map(Number);
    return values.length >= 4 && values.slice(0, 4).every(Number.isFinite)
        ? values.slice(0, 4)
        : null;
}

function transformPoint(matrix, x, y) {
    return {
        x: number(matrix?.[0], 1) * x + number(matrix?.[2]) * y + number(matrix?.[4]),
        y: number(matrix?.[1]) * x + number(matrix?.[3], 1) * y + number(matrix?.[5]),
    };
}

function convertRectangle(viewport, rectangle) {
    const first = transformPoint(viewport.transform, rectangle[0], rectangle[1]);
    const second = transformPoint(viewport.transform, rectangle[2], rectangle[3]);
    return [first.x, first.y, second.x, second.y];
}

export async function extractVectorSegments(page, pdfjsLib, viewport) {
    try {
        const operatorList = await page.getOperatorList();
        const segments = [];
        operatorList.fnArray.forEach((operator, index) => {
            if (operator !== pdfjsLib.OPS.constructPath) return;
            const minMax = readMinMax(operatorList.argsArray[index]);
            if (!minMax) return;
            const converted = convertRectangle(viewport, minMax);
            const x = Math.min(converted[0], converted[2]);
            const y = Math.min(converted[1], converted[3]);
            const width = Math.abs(converted[2] - converted[0]);
            const height = Math.abs(converted[3] - converted[1]);
            if (width >= 16 && height <= 2.6) {
                segments.push({ orientation: "horizontal", x, y: y + height / 2, width, height: 0.5 });
            } else if (height >= 8 && width <= 2.6) {
                segments.push({ orientation: "vertical", x: x + width / 2, y, width: 0.5, height });
            }
        });
        return segments;
    } catch {
        return [];
    }
}

export async function extractVectorTables(page, pdfjsLib, viewport, words = []) {
    const segments = await extractVectorSegments(page, pdfjsLib, viewport);
    return buildVectorTablesFromSegments(segments, words, {
        width: viewport.width,
        height: viewport.height,
    });
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
    return intersection / Math.max(1, Math.min(boxArea(first), boxArea(second)));
}

function tableQuality(table = {}) {
    const rows = table.rows || [];
    const rowCount = rows.length;
    const columnCount = Math.max(...rows.map((row) => row?.length || 0), 0);
    const populated = rows.reduce(
        (total, row) => total + (row || []).filter((cell) => cleanText(cell)).length,
        0
    );
    const capacity = Math.max(1, rowCount * columnCount);
    return (
        number(table.structuralScore) +
        Math.min(20, rowCount * 2) +
        Math.min(10, columnCount * 1.5) +
        Math.min(8, Math.log2(capacity + 1)) +
        (populated / capacity) * 4
    );
}

export function mergeVectorTablesWithAnalysis(analysis, vectorTables = []) {
    const tables = [...(analysis.tables || [])];
    vectorTables.forEach((table) => {
        const duplicateIndex = tables.findIndex(
            (candidate) => overlapRatio(candidate.bbox, table.bbox) >= 0.7
        );
        if (duplicateIndex >= 0) {
            if (tableQuality(tables[duplicateIndex]) < tableQuality(table)) {
                tables[duplicateIndex] = table;
            }
        } else {
            tables.push(table);
        }
    });
    return { ...analysis, tables, vectorTableCount: vectorTables.length };
}
