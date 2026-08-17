function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value) {
    return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
    return cleanText(value)
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
}

function rowsFromHtml(html = "") {
    return [...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map((rowMatch) =>
            [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
                .map((cellMatch) => decodeHtml(cellMatch[1]))
        )
        .filter((row) => row.length);
}

function rawRowsFromHtml(html = "") {
    return [...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map((rowMatch) => ({
            cells: [...rowMatch[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)]
                .map((cellMatch) => {
                    const attributes = cellMatch[1] || "";
                    const rowSpan = /rowspan\s*=\s*["']?(\d+)/i.exec(attributes)?.[1];
                    const columnSpan = /colspan\s*=\s*["']?(\d+)/i.exec(attributes)?.[1];
                    return {
                        text: decodeHtml(cellMatch[2]),
                        rowSpan: Math.max(1, number(rowSpan, 1)),
                        columnSpan: Math.max(1, number(columnSpan, 1)),
                        bbox: null,
                    };
                }),
        }))
        .filter((row) => row.cells.length);
}

function normalizeRows(region) {
    if (Array.isArray(region.rows) && region.rows.length) {
        return region.rows.map((row) => {
            const cells = Array.isArray(row) ? row : row.cells || [];
            return cells.map((cell) => cleanText(cell?.text ?? cell?.value ?? cell));
        });
    }
    if (region.html) return rowsFromHtml(region.html);
    if (!Array.isArray(region.cells) || !region.cells.length) return [];

    const rowCount = Math.max(
        0,
        ...region.cells.map((cell) => number(cell.row_index ?? cell.rowIndex ?? cell.row, 0) + 1)
    );
    const columnCount = Math.max(
        0,
        ...region.cells.map(
            (cell) => number(cell.column_index ?? cell.columnIndex ?? cell.column, 0) + 1
        )
    );
    const rows = Array.from({ length: rowCount }, () =>
        Array.from({ length: columnCount }, () => "")
    );
    region.cells.forEach((cell) => {
        const row = number(cell.row_index ?? cell.rowIndex ?? cell.row, 0);
        const column = number(cell.column_index ?? cell.columnIndex ?? cell.column, 0);
        if (rows[row]?.[column] !== undefined) {
            rows[row][column] = cleanText(cell.text ?? cell.value);
        }
    });
    return rows;
}

function normalizeCellBox(cell, tableBox) {
    const bbox = cell.bbox || cell.box;
    if (!bbox) return null;
    if (Array.isArray(bbox)) {
        const [x, y, width, height] = bbox.map(Number);
        return { x, y, width, height };
    }
    return {
        x: number(bbox.x, tableBox.x),
        y: number(bbox.y, tableBox.y),
        width: number(bbox.width),
        height: number(bbox.height),
    };
}

function buildNeuralTable(region, index) {
    const rows = normalizeRows(region);
    if (!rows.length || Math.max(...rows.map((row) => row.length), 0) < 2) return null;
    const htmlRawRows = region.html ? rawRowsFromHtml(region.html) : [];
    const rawRows = htmlRawRows.length ? htmlRawRows : rows.map((row, rowIndex) => ({
        cells: row.map((text, columnIndex) => {
            const sourceCell = (region.cells || []).find(
                (cell) =>
                    number(cell.row_index ?? cell.rowIndex ?? cell.row, -1) === rowIndex &&
                    number(cell.column_index ?? cell.columnIndex ?? cell.column, -1) === columnIndex
            );
            return {
                text,
                bbox: sourceCell ? normalizeCellBox(sourceCell, region.bbox) : null,
                rowSpan: Math.max(
                    1,
                    number(sourceCell?.row_span ?? sourceCell?.rowSpan, 1)
                ),
                columnSpan: Math.max(
                    1,
                    number(sourceCell?.column_span ?? sourceCell?.columnSpan, 1)
                ),
            };
        }),
    }));

    return {
        id: `neural-table-${index + 1}`,
        bbox: region.bbox,
        rows,
        headers: rows[0] || [],
        confidence: region.confidence,
        structuralScore: Math.max(82, number(region.confidence, 82)),
        source: "neural-layout",
        structure: { raw: rawRows, columnAnchors: [] },
        neural: {
            providerRegionId: region.id,
            html: region.html || "",
        },
    };
}

function overlaps(first = {}, second = {}) {
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

export function mergeVisionLayoutWithAnalysis(analysis, vision) {
    const neuralRegions = (vision?.regions || []).filter(
        (region) => region.source === "neural-layout"
    );
    if (!neuralRegions.length) {
        return {
            ...analysis,
            visionLayout: {
                provider: vision?.provider || "novapdf-vision-local",
                model: vision?.model || null,
                neural: false,
                formulaCount: 0,
                tableCount: 0,
            },
        };
    }

    const tables = [...(analysis.tables || [])];
    const neuralTables = neuralRegions
        .filter((region) => region.type === "table")
        .map(buildNeuralTable)
        .filter(Boolean);
    neuralTables.forEach((table) => {
        if (!tables.some((candidate) => overlaps(candidate.bbox, table.bbox) >= 0.72)) {
            tables.push(table);
        }
    });
    const formulas = neuralRegions
        .filter((region) => region.type === "formula")
        .map((region, index) => ({
            id: region.id || `neural-formula-${index + 1}`,
            bbox: region.bbox,
            confidence: region.confidence,
            text: region.text,
            latex: region.latex || region.text,
            source: "neural-layout",
        }));

    return {
        ...analysis,
        tables,
        neuralFormulas: formulas,
        visionLayout: {
            provider: vision.provider,
            model: vision.model || null,
            neural: true,
            formulaCount: formulas.length,
            tableCount: neuralTables.length,
            handwritingCount: neuralRegions.filter(
                (region) => region.type === "handwriting"
            ).length,
        },
    };
}

export {
    normalizeRows as __normalizeNeuralTableRowsForTests,
    rawRowsFromHtml as __neuralRawRowsFromHtmlForTests,
};
