function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
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
                const text = cleanText(row[columnIndex]);
                const valueType = detectValueType(text);
                return {
                    id: `r${rowIndex + 1}c${columnIndex + 1}`,
                    text,
                    rowSpan: 1,
                    columnSpan: 1,
                    valueType,
                    alignment: inferAlignment(valueType),
                };
            })
        );
    }

    return rawRows.map((rawRow, rowIndex) => {
        const cells = Array.from({ length: columnCount }, (_, columnIndex) => ({
            id: `r${rowIndex + 1}c${columnIndex + 1}`,
            text: "",
            rowSpan: 1,
            columnSpan: 1,
            valueType: "empty",
            alignment: "left",
        }));

        (rawRow.cells || []).forEach((rawCell, rawCellIndex) => {
            const cellCenter = number(rawCell.bbox?.x, rawCell.x) +
                number(rawCell.bbox?.width) / 2;
            let columnIndex = rawCellIndex;

            if (anchors.length) {
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
            const valueType = detectValueType(text);
            let columnSpan = Math.max(1, number(rawCell.columnSpan, 1));

            if (anchors.length > 1 && rawCell.bbox?.width) {
                const right = number(rawCell.bbox.x) + number(rawCell.bbox.width);
                for (let index = columnIndex + 1; index < anchors.length; index += 1) {
                    if (right >= anchors[index] - 6) {
                        columnSpan = Math.max(columnSpan, index - columnIndex + 1);
                    }
                }
            }

            cells[columnIndex] = {
                id: `r${rowIndex + 1}c${columnIndex + 1}`,
                text,
                rowSpan: Math.max(1, number(rawCell.rowSpan, 1)),
                columnSpan: Math.min(columnSpan, columnCount - columnIndex),
                valueType,
                alignment: inferAlignment(valueType),
                bbox: rawCell.bbox,
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
    const headerRows = table.headers?.some(Boolean) ? 1 : detectHeaderRows(grid);
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

export function enhancePageTables(analysis) {
    const enhancedTables = (analysis.tables || []).map(enhanceTable);
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
