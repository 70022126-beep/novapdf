import {
    AlignmentType,
    BorderStyle,
    Document,
    Footer,
    FrameAnchorType,
    FrameWrap,
    Header,
    HeightRule,
    HighlightColor,
    HorizontalPositionRelativeFrom,
    ImageRun,
    OverlapType,
    Packer,
    Paragraph,
    SectionType,
    Table,
    TableAnchorType,
    TableCell,
    TableRow,
    TextRun,
    TextWrappingSide,
    TextWrappingType,
    UnderlineType,
    VerticalAlign,
    VerticalPositionRelativeFrom,
    WidthType,
} from "docx";
import { createEditableMath, normalizeFormulaText } from "./MathFormulaRenderer.js";

const POINT_TO_TWIP = 20;
const POINT_TO_PIXEL = 96 / 72;
const POINT_TO_EMU = 12_700;

function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function pointsToTwips(points) {
    return Math.round(toNumber(points) * POINT_TO_TWIP);
}

function average(values) {
    return values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : 0;
}

function boxOverlapRatio(first = {}, second = {}) {
    const left = Math.max(toNumber(first.x), toNumber(second.x));
    const top = Math.max(toNumber(first.y), toNumber(second.y));
    const right = Math.min(
        toNumber(first.x) + toNumber(first.width),
        toNumber(second.x) + toNumber(second.width)
    );
    const bottom = Math.min(
        toNumber(first.y) + toNumber(first.height),
        toNumber(second.y) + toNumber(second.height)
    );
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const smallest = Math.max(
        1,
        Math.min(
            toNumber(first.width) * toNumber(first.height),
            toNumber(second.width) * toNumber(second.height)
        )
    );
    return intersection / smallest;
}

function getZone(page, type) {
    return page.analysis?.zones?.find((zone) => zone.type === type) || null;
}

function isZoneExcluded(page, type) {
    return type === "header"
        ? Boolean(page.review?.excludeHeader)
        : Boolean(page.review?.excludeFooter);
}

function getPageMargins(page) {
    const { width, height } = page.dimensions;
    const textBox = page.analysis.spatial.textBox;
    const left = clamp(textBox.x || 36, 18, Math.min(90, width * 0.18));
    const right = clamp(
        width - (textBox.x + textBox.width) || 36,
        18,
        Math.min(90, width * 0.18)
    );
    const top = clamp(textBox.y || 36, 24, Math.min(90, height * 0.14));
    const bottom = clamp(
        height - (textBox.y + textBox.height) || 36,
        24,
        Math.min(90, height * 0.14)
    );

    return { left, right, top, bottom };
}

function inferAlignment(bbox, pageWidth) {
    const left = toNumber(bbox?.x);
    const width = toNumber(bbox?.width);
    const rightGap = pageWidth - left - width;
    const center = left + width / 2;

    if (width < pageWidth * 0.72 && Math.abs(center - pageWidth / 2) < pageWidth * 0.06) {
        return AlignmentType.CENTER;
    }

    if (left > pageWidth * 0.48 && rightGap < pageWidth * 0.13) {
        return AlignmentType.RIGHT;
    }

    if (width > pageWidth * 0.68) {
        return AlignmentType.JUSTIFIED;
    }

    return AlignmentType.LEFT;
}

function createWordRuns(words, { firstBreak = false } = {}) {
    if (!words.length) {
        return [];
    }

    return words.map((word, index) => {
        const fontSize = clamp(toNumber(word.fontSize, word.height * 0.82), 8, 48);

        return new TextRun({
            text: `${index > 0 ? " " : ""}${cleanText(
                word.correctedText ?? word.text
            )}`,
            break: firstBreak && index === 0 ? 1 : undefined,
            size: Math.round(fontSize * 2),
            font: word.fontFamily || "Arial",
            bold: Boolean(word.bold),
            italics: Boolean(word.italic),
            underline: word.underline
                ? { type: UnderlineType.SINGLE, color: word.color }
                : undefined,
            strike: Boolean(word.strike),
            superScript: Boolean(word.superscript),
            subScript: Boolean(word.subscript),
            color: String(word.color || "").replace(/^#/, "") || undefined,
            characterSpacing: Number.isFinite(Number(word.characterSpacing))
                ? pointsToTwips(word.characterSpacing)
                : undefined,
            kern: Number.isFinite(Number(word.kerning))
                ? Math.round(Number(word.kerning) * 2)
                : undefined,
            highlight:
                String(word.source || "").includes("ocr") &&
                toNumber(word.confidence, 100) < 70
                    ? HighlightColor.YELLOW
                    : undefined,
            language: { value: "es-PE" },
        });
    });
}

function createParagraphFromLines(lines, page, margins, options = {}) {
    const validLines = (lines || []).filter((line) => cleanText(line.text));
    const words = validLines.flatMap((line) => line.words || []);
    const bbox = options.bbox || {
        x: Math.min(...validLines.map((line) => toNumber(line.bbox?.x, margins.left))),
        width: Math.max(...validLines.map((line) => toNumber(line.bbox?.width))),
    };
    const runs = [];

    validLines.forEach((line, lineIndex) => {
        const lineWords = line.words || [];
        if (lineWords.length) {
            runs.push(...createWordRuns(lineWords, { firstBreak: lineIndex > 0 }));
        } else {
            runs.push(
                new TextRun({
                    text: cleanText(line.text),
                    break: lineIndex > 0 ? 1 : undefined,
                    font: "Arial",
                    size: 20,
                })
            );
        }
    });

    const averageFontSize = average(
        words.map((word) => toNumber(word.fontSize, word.height * 0.82)).filter(Boolean)
    );
    const medianPageFont = Math.max(9, page.analysis.statistics.averageWordHeight * 0.82);
    const looksLikeHeading =
        averageFontSize >= medianPageFont * 1.28 && cleanText(options.text).length <= 180;
    const indent = clamp(toNumber(bbox.x) - margins.left, 0, page.dimensions.width * 0.35);

    return new Paragraph({
        children: runs.length ? runs : [new TextRun(cleanText(options.text))],
        alignment: inferAlignment(bbox, page.dimensions.width),
        indent: indent > 2 ? { left: pointsToTwips(indent) } : undefined,
        spacing: {
            before: looksLikeHeading ? pointsToTwips(4) : 0,
            after: pointsToTwips(looksLikeHeading ? 6 : 3),
            line: Math.round(clamp(averageFontSize || 11, 9, 28) * 25),
        },
        keepNext: looksLikeHeading,
        widowControl: true,
    });
}

function createZoneParagraphs(zone, page, margins) {
    if (!zone?.lines?.length) {
        return [];
    }

    return zone.lines.map((line) =>
        createParagraphFromLines([line], page, margins, {
            bbox: line.bbox,
            text: line.text,
        })
    );
}

function normalizeTableRows(table) {
    const professional = table.professional;
    if (professional?.grid?.length && professional.columnCount >= 2) {
        const grid = professional.grid.map((row) =>
            row.map((cell) => ({
                ...cell,
                text: cleanText(cell.text),
                columnSpan: Math.max(1, toNumber(cell.columnSpan, 1)),
                rowSpan: Math.max(1, toNumber(cell.rowSpan, 1)),
            }))
        );
        const headerCount = Math.max(0, professional.headerRows || 0);
        return {
            headers: headerCount ? grid[0] : [],
            headerRows: headerCount ? grid.slice(0, headerCount) : [],
            rows: grid.slice(headerCount),
            maximumColumns: professional.columnCount,
            borderStyle: professional.borderStyle,
            professional: true,
        };
    }

    const rows = Array.isArray(table.rows) ? table.rows : [];
    const headers = Array.isArray(table.headers) ? table.headers : [];
    const maximumColumns = Math.max(
        headers.length,
        ...rows.map((row) => (Array.isArray(row) ? row.length : 0)),
        0
    );

    if (maximumColumns < 2 || rows.length < 2) {
        return null;
    }

    const normalizedRows = rows.map((row) =>
        Array.from({ length: maximumColumns }, (_, index) => cleanText(row[index]))
    );
    const hasExplicitHeaders = headers.some(Boolean);
    const firstRowLooksLikeHeader = normalizedRows[0].some(
        (value) => value && !/^[\d.,%$€£\-()]+$/.test(value)
    );
    const normalizedHeaders = hasExplicitHeaders
        ? Array.from({ length: maximumColumns }, (_, index) => cleanText(headers[index]))
        : firstRowLooksLikeHeader
          ? normalizedRows.shift()
          : [];

    return {
        headers: normalizedHeaders,
        headerRows: normalizedHeaders.length ? [normalizedHeaders] : [],
        rows: normalizedRows,
        maximumColumns,
        borderStyle: "grid",
        professional: false,
    };
}

function createTableCell(
    value,
    isHeader,
    widthPercent,
    {
        fontSizeHalfPoints = 18,
        verticalMarginTwips = 70,
        horizontalMarginTwips = 90,
    } = {}
) {
    const cell = typeof value === "object" && value !== null
        ? value
        : { text: value };
    const alignment = {
        center: AlignmentType.CENTER,
        right: AlignmentType.RIGHT,
        left: AlignmentType.LEFT,
    }[cell.alignment] || AlignmentType.LEFT;

    return new TableCell({
        width: {
            size: widthPercent * Math.max(1, toNumber(cell.columnSpan, 1)),
            type: WidthType.PERCENTAGE,
        },
        columnSpan: Math.max(1, toNumber(cell.columnSpan, 1)),
        rowSpan: Math.max(1, toNumber(cell.rowSpan, 1)),
        verticalAlign: VerticalAlign.CENTER,
        shading: isHeader
            ? { fill: "E8F0FE" }
            : cell.shading
              ? { fill: String(cell.shading).replace(/^#/, "") }
              : undefined,
        margins: {
            marginUnitType: WidthType.DXA,
            top: verticalMarginTwips,
            right: horizontalMarginTwips,
            bottom: verticalMarginTwips,
            left: horizontalMarginTwips,
        },
        children: [
            new Paragraph({
                children: [
                    new TextRun({
                        text: cleanText(cell.text),
                        bold: isHeader,
                        font: "Arial",
                        size: isHeader
                            ? Math.min(20, fontSizeHalfPoints + 1)
                            : fontSizeHalfPoints,
                    }),
                ],
                alignment,
                spacing: { after: 0 },
            }),
        ],
    });
}

function createWordTable(table, { floating = false } = {}) {
    const normalized = normalizeTableRows(table);

    if (!normalized) {
        return null;
    }

    const widthPercent = 100 / normalized.maximumColumns;
    const rows = [];
    const rowCount = Math.max(
        1,
        normalized.headerRows.length +
            normalized.rows.length +
            (table.caption || table.tableTitle ? 1 : 0)
    );
    const detectedTableHeight = Math.max(0, toNumber(table.bbox?.height));
    const denseTableReserve = rowCount > 18
        ? clamp(rowCount * 0.3 + 10, 12, 30)
        : 0;
    const targetRowHeight = detectedTableHeight > 0
        ? clamp((detectedTableHeight - denseTableReserve) / rowCount, 7, 28)
        : 17;
    const fontPoints = clamp(targetRowHeight * 0.45, 5.5, 9);
    const fontSizeHalfPoints = Math.round(fontPoints * 2);
    const verticalMarginTwips = detectedTableHeight > 0 ? 0 : 70;
    const horizontalMarginTwips = detectedTableHeight > 0 ? 30 : 90;
    const rowHeight = detectedTableHeight > 0
        ? { value: pointsToTwips(targetRowHeight), rule: HeightRule.EXACT }
        : undefined;

    if (table.caption || table.tableTitle) {
        rows.push(
            new TableRow({
                cantSplit: true,
                height: rowHeight,
                children: [
                    new TableCell({
                        columnSpan: normalized.maximumColumns,
                        shading: { fill: "F8FAFC" },
                        children: [
                            new Paragraph({
                                children: [
                                    new TextRun({
                                        text: cleanText(table.tableTitle || table.caption),
                                        bold: true,
                                        font: "Arial",
                                        size: Math.min(20, fontSizeHalfPoints + 1),
                                    }),
                                ],
                                alignment: AlignmentType.CENTER,
                            }),
                        ],
                    }),
                ],
            })
        );
    }

    normalized.headerRows.forEach((headerRow) => {
        rows.push(
            new TableRow({
                tableHeader: true,
                cantSplit: true,
                height: rowHeight,
                children: headerRow.map((cell) =>
                    createTableCell(cell, true, widthPercent, {
                        fontSizeHalfPoints,
                        verticalMarginTwips,
                        horizontalMarginTwips,
                    })
                ),
            })
        );
    });

    normalized.rows.forEach((row) => {
        rows.push(
            new TableRow({
                cantSplit: true,
                height: rowHeight,
                children: row.map((text) =>
                    createTableCell(text, false, widthPercent, {
                        fontSizeHalfPoints,
                        verticalMarginTwips,
                        horizontalMarginTwips,
                    })
                ),
            })
        );
    });

    const border = normalized.borderStyle === "borderless"
        ? { color: "FFFFFF", size: 0, style: BorderStyle.NONE }
        : {
            color: normalized.borderStyle === "light-grid" ? "E2E8F0" : "CBD5E1",
            size: normalized.borderStyle === "light-grid" ? 2 : 4,
            style: BorderStyle.SINGLE,
        };

    return new Table({
        rows,
        width: floating
            ? {
                size: pointsToTwips(Math.max(36, toNumber(table.bbox?.width, 360))),
                type: WidthType.DXA,
            }
            : { size: 100, type: WidthType.PERCENTAGE },
        float: floating
            ? {
                horizontalAnchor: TableAnchorType.PAGE,
                verticalAnchor: TableAnchorType.PAGE,
                absoluteHorizontalPosition: pointsToTwips(table.bbox?.x),
                absoluteVerticalPosition: pointsToTwips(table.bbox?.y),
                leftFromText: 0,
                rightFromText: 0,
                topFromText: 0,
                bottomFromText: 0,
                overlap: OverlapType.OVERLAP,
            }
            : undefined,
        borders: {
            top: border,
            bottom: border,
            left: border,
            right: border,
            insideHorizontal: border,
            insideVertical: border,
        },
    });
}

function centerY(bbox) {
    return toNumber(bbox?.y) + toNumber(bbox?.height) / 2;
}

function isInsideZone(item, zone) {
    if (!zone) {
        return false;
    }

    const itemCenter = centerY(item.bbox);
    return itemCenter >= toNumber(zone.bbox?.y) &&
        itemCenter <= toNumber(zone.bbox?.y) + toNumber(zone.bbox?.height);
}

function createEditablePageChildren(page) {
    if (
        cleanText(page.review?.correctedText) &&
        !page.review?.wordCorrectionApplied
    ) {
        return String(page.review.correctedText)
            .split(/\n+/)
            .map((text) => cleanText(text))
            .filter(Boolean)
            .map(
                (text) =>
                    new Paragraph({
                        children: [new TextRun({ text, font: "Arial", size: 20 })],
                        alignment: AlignmentType.JUSTIFIED,
                        spacing: { after: pointsToTwips(4), line: 276 },
                    })
            );
    }

    const header = getZone(page, "header");
    const footer = getZone(page, "footer");
    const elements = [];
    const neuralFormulas = page.analysis.neuralFormulas || [];

    page.analysis.paragraphs.forEach((paragraph) => {
        if (
            isInsideZone(paragraph, header) ||
            isInsideZone(paragraph, footer) ||
            page.analysis.tables.some(
                (table) => boxOverlapRatio(table.bbox, paragraph.bbox) >= 0.55
            ) ||
            neuralFormulas.some(
                (formula) => boxOverlapRatio(formula.bbox, paragraph.bbox) >= 0.6
            )
        ) {
            return;
        }

        elements.push({
            y: toNumber(paragraph.bbox?.y),
            bbox: paragraph.bbox,
            element: createTextFrame(
                {
                    ...paragraph,
                    type: "text",
                    bbox: paragraph.bbox,
                    text: paragraph.text,
                },
                page
            ),
        });
    });

    neuralFormulas.forEach((formula) => {
        elements.push({
            y: toNumber(formula.bbox?.y),
            bbox: formula.bbox,
            element: createFormulaFrame(formula),
        });
    });

    page.analysis.tables.forEach((table) => {
        const element = createWordTable(table, { floating: true });
        if (element) {
            elements.push({ y: toNumber(table.bbox?.y), bbox: table.bbox, element });
        }
    });

    (page.review?.excludeImages ? [] : page.images || []).forEach((image, index) => {
        elements.push({
            y: toNumber(image.y),
            bbox: image,
            element: createFloatingImage(image, page, { zIndex: index + 5 }),
        });
    });

    if (!elements.length) {
        page.analysis.lines.forEach((line) => {
            if (!isInsideZone(line, header) && !isInsideZone(line, footer)) {
                elements.push({
                    y: toNumber(line.bbox?.y),
                    bbox: line.bbox,
                    element: createTextFrame(
                        {
                            type: "text",
                            bbox: line.bbox,
                            text: line.text,
                            words: line.words || [],
                            lines: [line],
                        },
                        page
                    ),
                });
            }
        });
    }
    const children = elements.sort((a, b) => a.y - b.y).map((entry) => entry.element);

    return children.length
        ? children
        : [new Paragraph({ children: [new TextRun("Página sin texto reconocible.")] })];
}

function createFidelityPageChildren(page) {
    const image = page.renderedPage;

    if (!image) {
        return [new Paragraph({ children: [new TextRun("Página no disponible.")] })];
    }

    const maximumWidth = Math.max(1, page.dimensions.width - 2);
    const maximumHeight = Math.max(1, page.dimensions.height - 2);

    return [
        new Paragraph({
            children: [
                new ImageRun({
                    type: image.type,
                    data: image.data,
                    transformation: {
                        width: Math.round(maximumWidth * POINT_TO_PIXEL),
                        height: Math.round(maximumHeight * POINT_TO_PIXEL),
                    },
                    altText: {
                        title: `Página ${page.pageNumber}`,
                        description: "Página preservada visualmente por NovaPDF",
                        name: `novapdf-page-${page.pageNumber}`,
                    },
                }),
            ],
            spacing: { before: 0, after: 0, line: 1 },
        }),
    ];
}

function createFloatingImage(image, page, { background = false, zIndex = 5 } = {}) {
    const width = Math.max(1, toNumber(image.width, page.dimensions.width));
    const height = Math.max(1, toNumber(image.height, page.dimensions.height));
    const x = Math.max(0, toNumber(image.x));
    const y = Math.max(0, toNumber(image.y));

    return new Paragraph({
        children: [
            new ImageRun({
                type: image.type || "png",
                data: image.data,
                transformation: {
                    width: Math.round(width * POINT_TO_PIXEL),
                    height: Math.round(height * POINT_TO_PIXEL),
                },
                floating: {
                    horizontalPosition: {
                        relative: HorizontalPositionRelativeFrom.PAGE,
                        offset: Math.round(x * POINT_TO_EMU),
                    },
                    verticalPosition: {
                        relative: VerticalPositionRelativeFrom.PAGE,
                        offset: Math.round(y * POINT_TO_EMU),
                    },
                    allowOverlap: true,
                    lockAnchor: true,
                    behindDocument: background,
                    layoutInCell: false,
                    zIndex,
                    wrap: {
                        type: background ? TextWrappingType.NONE : TextWrappingType.SQUARE,
                        side: TextWrappingSide.BOTH_SIDES,
                        margins: { top: 0, right: 0, bottom: 0, left: 0 },
                    },
                },
                altText: {
                    title: background
                        ? `Fondo de página ${page.pageNumber}`
                        : `Región gráfica de página ${page.pageNumber}`,
                    description: background
                        ? "Fondo preservado con capa de texto editable"
                        : "Imagen posicionada y editable recuperada por NovaPDF",
                    name: `novapdf-layer-${page.pageNumber}-${zIndex}`,
                },
            }),
        ],
        spacing: { before: 0, after: 0, line: 1 },
    });
}

function createTextFrame(region, page) {
    const bbox = region.bbox || {};
    const words = region.words?.length
        ? region.words
        : (region.lines || []).flatMap((line) => line.words || []);
    const children = [];

    (region.lines || []).forEach((line, index) => {
        children.push(...createWordRuns(line.words || [], { firstBreak: index > 0 }));
    });

    if (!children.length) {
        children.push(
            new TextRun({
                text: cleanText(region.text),
                font: region.type === "formula" ? "Cambria Math" : "Arial",
                size: 20,
            })
        );
    }

    const averageFontSize = average(
        words.map((word) => toNumber(word.fontSize, word.height * 0.82)).filter(Boolean)
    );

    return new Paragraph({
        children,
        alignment: inferAlignment(bbox, page.dimensions.width),
        frame: {
            type: "absolute",
            position: {
                x: pointsToTwips(Math.max(0, bbox.x)),
                y: pointsToTwips(Math.max(0, bbox.y)),
            },
            width: pointsToTwips(Math.max(18, bbox.width)),
            height: pointsToTwips(
                Math.max(averageFontSize || 10, toNumber(bbox.height, 12))
            ),
            anchor: {
                horizontal: FrameAnchorType.PAGE,
                vertical: FrameAnchorType.PAGE,
            },
            wrap: FrameWrap.NONE,
            anchorLock: true,
            rule: HeightRule.EXACT,
            space: { horizontal: 0, vertical: 0 },
        },
        spacing: { before: 0, after: 0, line: 1 },
        keepLines: true,
    });
}

function createFormulaFrame(region) {
    const bbox = region.bbox || {};
    const latex = cleanText(region.latex || region.text);
    return new Paragraph({
        children: latex
            ? [createEditableMath(latex)]
            : [new TextRun({ text: normalizeFormulaText(region.text), font: "Cambria Math" })],
        frame: {
            type: "absolute",
            position: {
                x: pointsToTwips(Math.max(0, toNumber(bbox.x))),
                y: pointsToTwips(Math.max(0, toNumber(bbox.y))),
            },
            width: pointsToTwips(Math.max(24, toNumber(bbox.width, 72))),
            height: pointsToTwips(Math.max(14, toNumber(bbox.height, 18))),
            anchor: {
                horizontal: FrameAnchorType.PAGE,
                vertical: FrameAnchorType.PAGE,
            },
            wrap: FrameWrap.NONE,
            anchorLock: true,
            rule: HeightRule.EXACT,
            space: { horizontal: 0, vertical: 0 },
        },
        spacing: { before: 0, after: 0, line: 1 },
    });
}

function createCorrectedPageFrame(page) {
    return new Paragraph({
        children: [
            new TextRun({
                text: cleanText(page.review?.correctedText),
                font: "Arial",
                size: 20,
            }),
        ],
        frame: {
            type: "absolute",
            position: { x: pointsToTwips(24), y: pointsToTwips(24) },
            width: pointsToTwips(Math.max(72, page.dimensions.width - 48)),
            height: pointsToTwips(Math.max(72, page.dimensions.height - 48)),
            anchor: {
                horizontal: FrameAnchorType.PAGE,
                vertical: FrameAnchorType.PAGE,
            },
            wrap: FrameWrap.NONE,
            anchorLock: true,
            rule: HeightRule.EXACT,
        },
        spacing: { before: 0, after: 0 },
    });
}

function createLayeredFidelityPageChildren(page) {
    const children = [];
    const header = getZone(page, "header");
    const footer = getZone(page, "footer");

    if (page.renderedPage && !page.review?.excludeImages) {
        children.push(
            createFloatingImage(
                {
                    ...page.renderedPage,
                    x: 0,
                    y: 0,
                    width: page.dimensions.width,
                    height: page.dimensions.height,
                },
                page,
                { background: true, zIndex: 0 }
            )
        );
    }

    if (
        !page.review?.excludeImages &&
        page.renderedPage?.role !== "clean-editable-background"
    ) {
        (page.images || []).forEach((image, index) => {
            children.push(createFloatingImage(image, page, { zIndex: index + 5 }));
        });
    }

    if (
        cleanText(page.review?.correctedText) &&
        !page.review?.wordCorrectionApplied
    ) {
        children.push(createCorrectedPageFrame(page));
        return children;
    }

    if (page.renderedPage?.role === "clean-editable-background") {
        const formulaRegions = (page.regionAnalysis?.regions || []).filter(
            (region) => region.type === "formula" && region.source === "neural-layout"
        );
        const editableTables = page.analysis?.tables || [];
        editableTables.forEach((table) => {
            const element = createWordTable(table, { floating: true });
            if (element) children.push(element);
        });
        formulaRegions.forEach((region) => children.push(createFormulaFrame(region)));
        (page.content?.lines || []).forEach((line, index) => {
            const lineRegion = {
                id: `p${page.pageNumber}-fixed-line-${index + 1}`,
                type: "text",
                bbox: line.bbox,
                text: line.text,
                words: line.words || [],
                lines: [line],
            };
            if (
                (isInsideZone(lineRegion, header) && isZoneExcluded(page, "header")) ||
                (isInsideZone(lineRegion, footer) && isZoneExcluded(page, "footer")) ||
                formulaRegions.some(
                    (formula) => boxOverlapRatio(formula.bbox, lineRegion.bbox) >= 0.58
                ) ||
                editableTables.some(
                    (table) => boxOverlapRatio(table.bbox, lineRegion.bbox) >= 0.55
                )
            ) {
                return;
            }
            children.push(createTextFrame(lineRegion, page));
        });

        return children.length
            ? children
            : [new Paragraph({ children: [new TextRun("Pagina sin contenido reconstruible.")] })];
    }

    (page.regionAnalysis?.regions || []).forEach((region) => {
        if (
            (isInsideZone(region, header) && isZoneExcluded(page, "header")) ||
            (isInsideZone(region, footer) && isZoneExcluded(page, "footer"))
        ) {
            return;
        }

        if (region.type === "table") {
            const table = createWordTable(region.content, { floating: true });
            if (table) children.push(table);
            return;
        }

        if (
            [
                "text",
                "heading",
                "list-item",
                "text-box",
                "caption",
                "footnote",
                "formula",
                "form-field",
            ].includes(region.type)
        ) {
            children.push(
                region.type === "formula" && region.source === "neural-layout"
                    ? createFormulaFrame(region)
                    : createTextFrame(region, page)
            );
        }
    });

    return children.length
        ? children
        : [new Paragraph({ children: [new TextRun("Página sin contenido reconstruible.")] })];
}

function correctionKey(word) {
    return [
        cleanText(word.text).toLowerCase(),
        Math.round(toNumber(word.x) * 2) / 2,
        Math.round(toNumber(word.y) * 2) / 2,
    ].join("|");
}

function preparePageCorrections(page) {
    const correctedText = cleanText(page.review?.correctedText);
    if (!correctedText || !page.content?.words?.length) return page;

    const correctedWords = correctedText.split(/\s+/).filter(Boolean);
    const sourceWords = page.content.words;
    if (correctedWords.length !== sourceWords.length) {
        page.review.wordCorrectionApplied = false;
        return page;
    }

    const replacements = new Map();
    sourceWords.forEach((word, index) => {
        const key = correctionKey(word);
        const queue = replacements.get(key) || [];
        queue.push(correctedWords[index]);
        replacements.set(key, queue);
        word.correctedText = correctedWords[index];
    });

    const applyToWords = (words = []) => {
        const consumed = new Map();
        words.forEach((word) => {
            const key = correctionKey(word);
            const index = consumed.get(key) || 0;
            const value = replacements.get(key)?.[index];
            if (value !== undefined) {
                word.correctedText = value;
                consumed.set(key, index + 1);
            }
        });
    };

    (page.analysis?.paragraphs || []).forEach((paragraph) => {
        applyToWords(paragraph.words);
        (paragraph.lines || []).forEach((line) => applyToWords(line.words));
    });
    (page.regionAnalysis?.regions || []).forEach((region) => {
        applyToWords(region.words);
        (region.lines || []).forEach((line) => applyToWords(line.words));
    });
    page.review.wordCorrectionApplied = true;
    return page;
}

function createSection(page, mode) {
    const effectiveMode =
        page.review?.strategy && page.review.strategy !== "automatic"
            ? page.review.strategy
            : mode;
    const { width, height } = page.dimensions;
    // Se escribe el tamaño físico directamente. La bandera LANDSCAPE de docx
    // vuelve a intercambiar ancho y alto y LibreOffice puede insertar una hoja
    // adicional por sección; con w > h ambos programas infieren la orientación.
    const margins = effectiveMode === "fidelity" || effectiveMode === "visual"
        ? { top: 1, right: 1, bottom: 1, left: 1 }
        : getPageMargins(page);
    const header = getZone(page, "header");
    const footer = getZone(page, "footer");

    return {
        properties: {
            type: SectionType.NEXT_PAGE,
            page: {
                size: {
                    width: pointsToTwips(width),
                    height: pointsToTwips(height),
                },
                margin: {
                    top: pointsToTwips(margins.top),
                    right: pointsToTwips(margins.right),
                    bottom: pointsToTwips(margins.bottom),
                    left: pointsToTwips(margins.left),
                    header: pointsToTwips(Math.max(8, margins.top * 0.35)),
                    footer: pointsToTwips(Math.max(8, margins.bottom * 0.35)),
                },
            },
        },
        headers:
            effectiveMode === "editable" &&
            header &&
            !isZoneExcluded(page, "header") &&
            (!cleanText(page.review?.correctedText) || page.review?.wordCorrectionApplied)
                ? {
                    default: new Header({
                        children: createZoneParagraphs(header, page, margins),
                    }),
                }
                : undefined,
        footers:
            effectiveMode === "editable" &&
            footer &&
            !isZoneExcluded(page, "footer") &&
            (!cleanText(page.review?.correctedText) || page.review?.wordCorrectionApplied)
                ? {
                    default: new Footer({
                        children: createZoneParagraphs(footer, page, margins),
                    }),
                }
                : undefined,
        children:
            effectiveMode === "visual"
                ? createFidelityPageChildren(page)
                : effectiveMode === "fidelity"
                  ? createLayeredFidelityPageChildren(page)
                  : createEditablePageChildren(page),
    };
}

export async function renderWordDocument(model, onProgress) {
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    onProgress?.({ percent: 94, stage: "docx", detail: "Aplicando estilos y secciones…" });

    const document = new Document({
        creator: "NovaPDF",
        title: model.title,
        description:
            model.mode === "fidelity"
                ? "Documento convertido por NovaPDF en modo de máxima fidelidad."
                : "Documento editable convertido por el motor híbrido de NovaPDF.",
        styles: {
            default: {
                document: {
                    run: { font: "Arial", size: 22, language: { value: "es-PE" } },
                    paragraph: { spacing: { after: 60 } },
                },
            },
        },
        sections: model.pages
            .map(preparePageCorrections)
            .map((page) => createSection(page, model.mode)),
    });

    onProgress?.({ percent: 97, stage: "packing", detail: "Empaquetando el archivo DOCX…" });
    const blob = await Packer.toBlob(document);
    const finishedAt = globalThis.performance?.now?.() ?? Date.now();

    return {
        blob,
        generationMs: Math.round(finishedAt - startedAt),
    };
}

// Exportado para pruebas unitarias del renderizado de tablas.
export function __normalizeTableRowsForTests(table) {
    return normalizeTableRows(table);
}
