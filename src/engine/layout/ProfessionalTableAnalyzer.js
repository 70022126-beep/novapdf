import { buildLinesFromWords } from "../pdf-to-word/PageContentNormalizer.js";

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sourceLines(value) {
    return String(value ?? "")
        .split(/\r?\n/)
        .map(cleanText)
        .filter(Boolean);
}

function median(values = []) {
    const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

function dominant(values = []) {
    const counts = new Map();
    values.filter(Boolean).forEach((value) =>
        counts.set(value, (counts.get(value) || 0) + 1)
    );
    return [...counts.entries()].sort((first, second) => second[1] - first[1])[0]?.[0] || null;
}

function wordsInsideBox(words = [], bbox = {}) {
    const left = number(bbox.x);
    const top = number(bbox.y);
    const right = left + number(bbox.width);
    const bottom = top + number(bbox.height);
    if (right <= left || bottom <= top) return [];

    return words.filter((word) => {
        const centerX = number(word.x) + number(word.width) / 2;
        const centerY = number(word.y) + number(word.height) / 2;
        return centerX >= left && centerX <= right && centerY >= top && centerY <= bottom;
    });
}

function typographyForBox(words, bbox) {
    const matches = wordsInsideBox(words, bbox);
    if (!matches.length) return {};
    return {
        fontSize: median(matches.map((word) => word.fontSize)),
        fontFamily: dominant(matches.map((word) => word.fontFamily || word.fontName)),
        bold: matches.filter((word) => word.bold).length / matches.length >= 0.55,
        italic: matches.filter((word) => word.italic).length / matches.length >= 0.55,
        color: dominant(matches.map((word) => word.color)),
    };
}

function detectValueType(text) {
    const value = cleanText(text);
    if (!value) return "empty";
    if (/^[+-]?[\d.,]+\s*%$/.test(value)) return "percentage";
    if (/^(?:S\/\.?|US\$|\$|€|£)\s*[\d.,]+$/i.test(value)) return "currency";
    if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(value)) return "date";
    if (/^[+-]?[\d.,]+$/.test(value)) return "number";
    if (/^(?:sí|si|no|x|✓|✔)$/i.test(value)) return "boolean";
    return "text";
}

function inferAlignment(valueType) {
    return ["number", "currency", "percentage"].includes(valueType)
        ? "right"
        : valueType === "boolean"
          ? "center"
          : "left";
}

function buildGridFromRaw(table) {
    const rawRows = table.structure?.raw || [];
    const anchors = table.columnAnchors || table.structure?.columnAnchors || [];
    const columnCount = Math.max(
        anchors.length,
        ...rawRows.map((row) => row.cells?.length || 0),
        ...((table.rows || []).map((row) => row.length)),
        0
    );

    if (columnCount < 2) {
        return [];
    }

    if (!rawRows.length) {
        return (table.rows || []).map((row, rowIndex) =>
            Array.from({ length: columnCount }, (_, columnIndex) => {
                const lines = sourceLines(row[columnIndex]);
                const text = cleanText(row[columnIndex]);
                const valueType = detectValueType(text);
                return {
                    id: `r${rowIndex + 1}c${columnIndex + 1}`,
                    columnIndex,
                    text,
                    sourceLines: lines,
                    lineCount: Math.max(1, lines.length),
                    rowSpan: 1,
                    columnSpan: 1,
                    valueType,
                    alignment: inferAlignment(valueType),
                };
            })
        );
    }

    const grid = rawRows.map((rawRow, rowIndex) => {
        const cells = Array.from({ length: columnCount }, (_, columnIndex) => ({
            id: `r${rowIndex + 1}c${columnIndex + 1}`,
            columnIndex,
            text: "",
            rowSpan: 1,
            columnSpan: 1,
            valueType: "empty",
            alignment: "left",
        }));

        (rawRow.cells || []).forEach((rawCell, rawCellIndex) => {
            const cellCenter = number(rawCell.bbox?.x, rawCell.x) +
                number(rawCell.bbox?.width) / 2;
            const explicitColumnIndex = Number(rawCell.columnIndex);
            let columnIndex = Number.isFinite(explicitColumnIndex)
                ? explicitColumnIndex
                : rawCellIndex;

            if (!Number.isFinite(explicitColumnIndex) && anchors.length) {
                let nearestDistance = Infinity;
                anchors.forEach((anchor, index) => {
                    const distance = Math.abs(cellCenter - number(anchor));
                    if (distance < nearestDistance) {
                        nearestDistance = distance;
                        columnIndex = index;
                    }
                });
            }

            columnIndex = Math.max(0, Math.min(columnCount - 1, columnIndex));
            const text = cleanText(rawCell.text);
            const lines = sourceLines(rawCell.text);
            const valueType = detectValueType(text);
            let columnSpan = Math.max(1, number(rawCell.columnSpan, 1));

            if (anchors.length > 1 && rawCell.bbox?.width) {
                const right = number(rawCell.bbox.x) + number(rawCell.bbox.width);
                for (let index = columnIndex + 1; index < anchors.length; index += 1) {
                    // El borde derecho de una celda normal coincide con el
                    // ancla de la columna siguiente. Solo existe combinación
                    // cuando la celda penetra de forma material en esa columna.
                    if (right > number(anchors[index]) + 6) {
                        columnSpan = Math.max(columnSpan, index - columnIndex + 1);
                    }
                }
            }

            cells[columnIndex] = {
                id: `r${rowIndex + 1}c${columnIndex + 1}`,
                columnIndex,
                text,
                sourceLines: lines,
                lineCount: Math.max(1, lines.length),
                rowSpan: Math.max(1, number(rawCell.rowSpan, 1)),
                columnSpan: Math.min(columnSpan, columnCount - columnIndex),
                valueType,
                alignment: inferAlignment(valueType),
                bbox: rawCell.bbox,
                shading: rawCell.shading,
            };
        });

        return cells.filter((cell, index) => {
            const coveredByPrevious = cells
                .slice(0, index)
                .some(
                    (previous, previousIndex) =>
                        previousIndex + previous.columnSpan > index
                );
            return !coveredByPrevious;
        });
    });

    const deduplicatedGrid = grid.filter((row, rowIndex) => {
        if (!rowIndex) return true;
        // Varias filas vacías consecutivas son campos distintos de un
        // formulario. Solo se deduplican filas con texto (cabeceras repetidas).
        if (!row.some((cell) => cleanText(cell.text))) return true;
        const signature = row.map((cell) => cleanText(cell.text)).join("\u241F");
        const previousSignature = grid[rowIndex - 1]
            .map((cell) => cleanText(cell.text))
            .join("\u241F");
        return !signature || signature !== previousSignature;
    });

    return deduplicatedGrid.map((row, rowIndex) =>
        row.filter((cell) =>
            !deduplicatedGrid
                .slice(0, rowIndex)
                .some((previousRow, previousRowIndex) =>
                previousRow.some(
                    (previous) =>
                        previous.rowSpan > rowIndex - previousRowIndex &&
                        previous.columnIndex <= cell.columnIndex &&
                        previous.columnIndex + previous.columnSpan > cell.columnIndex
                )
                )
        )
    );
}

function detectHeaderRows(grid) {
    if (!grid.length) return 0;
    const first = grid[0];
    const textCells = first.filter((cell) => cell.valueType === "text" && cell.text);
    return textCells.length >= Math.max(1, Math.ceil(first.length * 0.6)) ? 1 : 0;
}

function detectBorderStyle(table) {
    const score = number(table.structuralScore);
    if (score >= 90) return "grid";
    if (score >= 80) return "light-grid";
    return "borderless";
}

export function enhanceTable(table, index = 0) {
    const grid = buildGridFromRaw(table);
    const hasExplicitHeaders = table.headers?.some(Boolean);
    const isStructuredNative = String(table.source || "").startsWith("pdfplumber-lines");
    const firstRow = grid[0] || [];
    const isContinuationTable =
        number(table.bbox?.y) < 120 &&
        firstRow.length >= 2 &&
        !cleanText(firstRow[0]?.text) &&
        firstRow.slice(1).some((cell) => cleanText(cell.text));
    const headerRows = isContinuationTable
        ? 0
        : hasExplicitHeaders
        ? 1
        : isStructuredNative
          ? 0
          : detectHeaderRows(grid);
    const numericColumns = [];
    const maximumColumns = Math.max(...grid.map((row) => row.length), 0);

    for (let columnIndex = 0; columnIndex < maximumColumns; columnIndex += 1) {
        const values = grid
            .slice(headerRows)
            .map((row) => row[columnIndex]?.valueType)
            .filter(Boolean);
        const numericValues = values.filter((value) =>
            ["number", "currency", "percentage"].includes(value)
        );
        if (values.length && numericValues.length / values.length >= 0.65) {
            numericColumns.push(columnIndex);
        }
    }

    return {
        ...table,
        professional: {
            id: `professional-table-${index + 1}`,
            grid,
            columnCount: maximumColumns,
            headerRows,
            numericColumns,
            borderStyle: detectBorderStyle(table),
            irregular: grid.some((row) => row.length !== maximumColumns),
            hasMergedCells: grid.some((row) =>
                row.some((cell) => cell.columnSpan > 1 || cell.rowSpan > 1)
            ),
        },
    };
}

export function enhancePageTables(analysis, words = []) {
    const enhancedTables = (analysis.tables || []).map((table, index) => {
        const enhanced = enhanceTable(table, index);
        const typography = typographyForBox(words, table.bbox);
        const columnCount = enhanced.professional.columnCount;
        const grid = enhanced.professional.grid.map((row) =>
            row.map((cell) => {
                const cellTypography = typographyForBox(words, cell.bbox);
                const cellWords = wordsInsideBox(words, cell.bbox);
                const nativeCharacters = cellWords.reduce(
                    (total, word) => total + cleanText(word.correctedText ?? word.text).replace(/\s/g, "").length,
                    0
                );
                const cellCharacters = cleanText(cell.text).replace(/\s/g, "").length;
                const reliableNativeGeometry =
                    cellCharacters > 0 &&
                    cellWords.length > 0 &&
                    cellWords.every((word) => String(word.source || "").includes("native")) &&
                    nativeCharacters === cellCharacters;
                const compactLabel =
                    cell.valueType === "text" &&
                    cell.columnIndex < columnCount - 1 &&
                    cell.lineCount <= 2 &&
                    cell.text.length <= 36;
                return {
                    ...cell,
                    ...cellTypography,
                    nativeLines: reliableNativeGeometry
                        ? buildLinesFromWords(cellWords.map((word) => ({ ...word })))
                        : undefined,
                    alignment: compactLabel ? "center" : cell.alignment,
                };
            })
        );
        return {
            ...enhanced,
            professional: {
                ...enhanced.professional,
                grid,
                typography,
            },
        };
    });
    return {
        ...analysis,
        tables: enhancedTables,
        tableCandidates: enhancedTables,
    };
}

export function detectFormFields(lines = []) {
    return lines
        .filter((line) =>
            /(?:_{3,}|\[(?:\s|x)?\]|☐|☑|\b(?:nombre|dni|fecha|firma|dirección|telefono|correo)\s*:)/i.test(
                cleanText(line.text)
            )
        )
        .map((line, index) => {
            const text = cleanText(line.text);
            const labelMatch = /^([^:_]{1,60})\s*[:_]/.exec(text);
            return {
                id: `form-field-${index + 1}`,
                type: /\[(?:\s|x)?\]|☐|☑/.test(text) ? "checkbox" : "text-field",
                label: cleanText(labelMatch?.[1] || text),
                value: labelMatch ? cleanText(text.slice(labelMatch[0].length)) : "",
                bbox: line.bbox,
                confidence: 78,
            };
        });
}
