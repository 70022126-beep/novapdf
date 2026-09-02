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
    LineRuleType,
    OverlapType,
    Packer,
    Paragraph,
    SectionType,
    Table,
    TableAnchorType,
    TableCell,
    TableLayoutType,
    TableRow,
    TextRun,
    TextDirection,
    TextWrappingSide,
    TextWrappingType,
    UnderlineType,
    VerticalAlign,
    VerticalPositionRelativeFrom,
    WidthType,
} from "docx";
import { createEditableMath, normalizeFormulaText } from "./MathFormulaRenderer.js";
import { isComplexPositionedTable } from "./TableRenderingPolicy.js";

const POINT_TO_TWIP = 20;
const POINT_TO_PIXEL = 96 / 72;
const POINT_TO_EMU = 12_700;
// Los anchos de pdfplumber ya están expresados en puntos PDF. Comprimir todos
// los glifos nativos al 95 % alejaba Arial/Times de su geometría original y
// reducía artificialmente el solapamiento visual en documentos nacidos en Word.
const NATIVE_TEXT_HORIZONTAL_SCALE = 100;
const WORD_LAYOUT_TOLERANCE_POINTS = 6;
const WORD_TABLE_ROW_OVERHEAD_POINTS = 1.8;
// Symbol fonts often expose private-use glyph maps that Word and LibreOffice
// interpret differently. Regular document fonts are safe to transport when
// the PDF embedding permission allows it; keeping them makes the DOCX portable
// and avoids metric drift on machines without Microsoft fonts installed.
const UNSAFE_EMBEDDED_FONT_FAMILIES = new Set([
    "symbol",
    "wingdings",
]);
let activeEmbeddedFontFamilies = [];

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

function canonicalFontFamily(value) {
    return cleanText(value)
        .replace(/^[A-Z]{6}\+/i, "")
        .replace(/[^a-z0-9]+/gi, " ")
        .replace(/\b(?:thin|extra light|extralight|light|regular|medium|semi bold|semibold|bold|black|heavy|italic|oblique)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase("en");
}

function embeddedFontFamilyFor(value) {
    const requested = canonicalFontFamily(value);
    if (!requested) return null;
    return activeEmbeddedFontFamilies.find(
        (font) => canonicalFontFamily(font.name) === requested
    )?.name || null;
}

function normalizeEmbeddedFontsForDocument(fonts = []) {
    const candidatesByFamily = new Map();
    for (const font of fonts || []) {
        const name = cleanText(font?.name);
        const sourceName = cleanText(font?.sourceName);
        const data = font?.data;
        const family = canonicalFontFamily(name);
        if (
            !name ||
            !family ||
            UNSAFE_EMBEDDED_FONT_FAMILIES.has(family) ||
            !data ||
            !Number.isFinite(Number(data.length)) ||
            data.length < 32 ||
            data.length > 2 * 1024 * 1024 ||
            (font.embedding && font.embedding !== "editable") ||
            /(?:bold|black|heavy|semibold|demi|italic|oblique)/i.test(sourceName)
        ) continue;
        const candidates = candidatesByFamily.get(family) || [];
        candidates.push({ name, data });
        candidatesByFamily.set(family, candidates);
    }
    // Los PDF suelen dividir una misma tipografía en varios subconjuntos. No es
    // seguro aplicar uno de ellos a todos los textos: los glifos ausentes cambian
    // el ancho y pueden desplazar páginas completas. Solo incrustamos familias
    // inequívocas; las fragmentadas usan la sustitución métrica probada.
    return [...candidatesByFamily.values()]
        .filter((candidates) => candidates.length === 1)
        .map(([font]) => font);
}

function embeddedFontFallback(name) {
    return /^quicksand/i.test(cleanText(name)) ? "Lucida Sans Unicode" : "Arial";
}

function escapeXmlAttribute(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

async function addEmbeddedFontFallbacks(blob, embeddedFonts) {
    if (!embeddedFonts.length) return blob;
    const { default: JSZip } = await import("jszip");
    const archive = await JSZip.loadAsync(await blob.arrayBuffer());
    const entry = archive.file("word/fontTable.xml");
    if (!entry) return blob;
    let xml = await entry.async("string");
    for (const font of embeddedFonts) {
        const name = escapeXmlAttribute(font.name);
        const opening = `<w:font w:name="${name}">`;
        if (!xml.includes(opening) || xml.includes(
            `${opening}<w:altName w:val="${escapeXmlAttribute(embeddedFontFallback(font.name))}"/>`
        )) continue;
        xml = xml.replace(
            opening,
            `${opening}<w:altName w:val="${escapeXmlAttribute(embeddedFontFallback(font.name))}"/>`
        );
    }
    archive.file("word/fontTable.xml", xml);
    return archive.generateAsync({
        type: "blob",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
    });
}

function normalizeWordFontFamily(value, fontSize = 0) {
    const family = cleanText(value)
        .replace(/^[A-Z]{6}\+/i, "")
        .replace(/[-_ ]+(bold|black|heavy|semibold|demi|italic|oblique).*$/i, "")
        .trim();
    if (!family) return "Arial";
    const embeddedFamily = embeddedFontFamilyFor(family);
    if (embeddedFamily) return embeddedFamily;
    if (/^quicksand/i.test(family)) {
        const sizeSpecificFallback = toNumber(fontSize) >= 30
            ? globalThis.process?.env?.NOVAPDF_QUICKSAND_FALLBACK_LARGE
            : globalThis.process?.env?.NOVAPDF_QUICKSAND_FALLBACK_SMALL;
        const benchmarkFallback = cleanText(
            sizeSpecificFallback || globalThis.process?.env?.NOVAPDF_QUICKSAND_FALLBACK
        );
        if (benchmarkFallback) return benchmarkFallback;
        return toNumber(fontSize) >= 30 ? "Century Gothic" : "Lucida Sans Unicode";
    }
    if (/^(?:arial|arialmt)/i.test(family)) return "Arial";
    if (/^timesnewroman(?:ps|psmt)?$/i.test(family)) return "Times New Roman";
    if (/^couriernew(?:ps|psmt)?$/i.test(family)) return "Courier New";
    if (/^symbolmt$/i.test(family)) return "Symbol";
    if (/^wingdings(?:-regular)?$/i.test(family)) return "Wingdings";
    return family;
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

    // Word y LibreOffice redondean las medidas PDF de forma distinta. Reservar
    // unos puntos invisibles en los bordes derecho e inferior evita que una
    // linea o el salto de seccion creen una pagina adicional.
    return {
        left,
        right: Math.max(18, right - WORD_LAYOUT_TOLERANCE_POINTS),
        top,
        bottom: Math.max(24, bottom - WORD_LAYOUT_TOLERANCE_POINTS),
    };
}

function inferAlignment(bbox, pageWidth, lines = []) {
    const left = toNumber(bbox?.x);
    const width = toNumber(bbox?.width);
    const rightGap = pageWidth - left - width;
    const center = left + width / 2;
    const contentLines = (lines || []).filter((line) => cleanText(line.text));
    const justifiedCandidates = contentLines.length > 1
        ? contentLines.slice(0, -1)
        : [];
    const fullWidthLineRatio = justifiedCandidates.length
        ? justifiedCandidates.filter(
            (line) => toNumber(line.bbox?.width) >= width * 0.86
        ).length / justifiedCandidates.length
        : 0;
    const contentWordCount = contentLines.reduce(
        (total, line) =>
            total +
            ((line.words || []).length || cleanText(line.text).split(/\s+/).filter(Boolean).length),
        0
    );
    const contentText = contentLines.map((line) => cleanText(line.text)).join(" ");
    const letters = contentText.match(/[\p{L}]/gu) || [];
    const uppercaseRatio = letters.length
        ? letters.filter((letter) => letter === letter.toLocaleUpperCase("es")).length /
            letters.length
        : 0;
    const shortCenteredText = contentLines.length
        ? contentLines.length <= 2 &&
            contentWordCount <= 10 &&
            (width < pageWidth * 0.58 || uppercaseRatio >= 0.82)
        : width < pageWidth * 0.56;

    // En documentos legales, los espacios expandidos del PDF son la senal mas
    // fiable de justificacion. La ultima linea se excluye porque normalmente es
    // corta aunque el parrafo sea justificado.
    if (
        width > pageWidth * 0.32 &&
        justifiedCandidates.length >= 2 &&
        fullWidthLineRatio >= 0.66
    ) {
        return AlignmentType.JUSTIFIED;
    }

    if (
        shortCenteredText &&
        width < pageWidth * 0.72 &&
        Math.abs(center - pageWidth / 2) < pageWidth * 0.025 &&
        Math.abs(left - rightGap) < pageWidth * 0.05
    ) {
        return AlignmentType.CENTER;
    }

    if (left > pageWidth * 0.48 && rightGap < pageWidth * 0.13) {
        return AlignmentType.RIGHT;
    }

    if (width > pageWidth * 0.72 && contentLines.length > 1) {
        return AlignmentType.JUSTIFIED;
    }

    return AlignmentType.LEFT;
}

function createWordRuns(words, { firstBreak = false, preserveGaps = false, horizontalScale = NATIVE_TEXT_HORIZONTAL_SCALE } = {}) {
    if (!words.length) {
        return [];
    }

    const runs = [];
    words.forEach((word, index) => {
        const fontSize = clamp(toNumber(word.fontSize, word.height * 0.82), 6, 48);
        const fontFamily = normalizeWordFontFamily(
            word.fontFamily || word.fontName,
            fontSize
        );
        const previous = words[index - 1];
        const hasMeasuredGap =
            preserveGaps &&
            index > 0 &&
            Number.isFinite(Number(word.x)) &&
            Number.isFinite(Number(previous?.x)) &&
            Number.isFinite(Number(previous?.width));

        if (hasMeasuredGap) {
            const measuredGap = Math.max(
                0,
                toNumber(word.x) - (toNumber(previous.x) + toNumber(previous.width))
            );
            const spaceFactor = /courier/i.test(fontFamily)
                ? 0.6
                : /times/i.test(fontFamily) ? 0.25 : 0.278;
            // Word/LibreOffice no siempre comprimen un espacio aislado con
            // w:spacing negativo. Reducir su cuerpo invisible y añadir solo
            // espaciado positivo conserva el ancho sin provocar saltos extra.
            const spaceSize = Math.max(1, Math.floor(Math.min(fontSize, measuredGap / spaceFactor) * 2));
            if (measuredGap > 0.1) {
                runs.push(
                    new TextRun({
                        text: " ",
                        size: spaceSize,
                        font: fontFamily,
                        scale: horizontalScale,
                        characterSpacing: pointsToTwips(
                            clamp(measuredGap - (spaceSize / 2) * spaceFactor, 0, 72)
                        ),
                        language: { value: "es-PE" },
                    })
                );
            }
        }

        runs.push(new TextRun({
            text: `${index > 0 && !hasMeasuredGap ? " " : ""}${cleanText(
                word.correctedText ?? word.text
            )}`,
            break: firstBreak && index === 0 ? 1 : undefined,
            size: Math.round(fontSize * 2),
            font: fontFamily,
            scale: String(word.source || "").includes("native")
                ? horizontalScale
                : undefined,
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
        }));
    });
    return runs;
}

function createParagraphFromLines(lines, page, margins, options = {}) {
    const validLines = (lines || []).filter((line) => cleanText(line.text));
    const isBullet = Boolean(options.isBullet);
    const words = validLines.flatMap((line) => line.words || []).map((word) => ({ ...word }));
    if (isBullet && words.length) {
        const firstText = cleanText(words[0].correctedText ?? words[0].text);
        const stripped = firstText.replace(/^[•▪◦‣·]\s*/, "");
        if (stripped) {
            words[0].text = stripped;
            words[0].correctedText = stripped;
        } else {
            words.shift();
        }
    }
    const bbox = options.bbox || {
        x: Math.min(...validLines.map((line) => toNumber(line.bbox?.x, margins.left))),
        width: Math.max(...validLines.map((line) => toNumber(line.bbox?.width))),
    };
    const inferredAlignment = inferAlignment(bbox, page.dimensions.width, validLines);
    const alignment = inferredAlignment;
    const runs = [];
    const preserveSourceLines = Boolean(options.preserveSourceLines);

    if (!preserveSourceLines && words.length) {
        runs.push(...createWordRuns(words));
    } else {
        validLines.forEach((line, lineIndex) => {
            const lineWords = line.words || [];
            if (lineWords.length) {
                runs.push(
                    ...createWordRuns(lineWords, {
                        firstBreak: lineIndex > 0,
                        preserveGaps: preserveSourceLines,
                    })
                );
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
    }

    const averageFontSize = average(
        words.map((word) => toNumber(word.fontSize, word.height * 0.82)).filter(Boolean)
    );
    const indent = clamp(toNumber(bbox.x) - margins.left, 0, page.dimensions.width * 0.35);
    const rightIndent = clamp(
        page.dimensions.width -
            margins.right -
            (toNumber(bbox.x) + toNumber(bbox.width)) -
            WORD_LAYOUT_TOLERANCE_POINTS,
        0,
        page.dimensions.width * 0.35
    );
    const sourceGap = clamp(toNumber(options.beforePoints), 0, 72);
    const sourceLineHeight =
        toNumber(options.bbox?.height) > 0 && validLines.length
            ? toNumber(options.bbox.height) / validLines.length
            : averageFontSize * 1.15;
    const lineHeight = clamp(
        sourceLineHeight || averageFontSize * 1.15 || 12,
        Math.max(8, averageFontSize || 8),
        42
    );

    return new Paragraph({
        children: runs.length ? runs : [new TextRun(cleanText(options.text))],
        alignment,
        bullet: isBullet ? { level: 0 } : undefined,
        indent:
            !isBullet && (indent > 2 || rightIndent > 2)
                ? {
                    left: indent > 2 ? pointsToTwips(indent) : undefined,
                    right: rightIndent > 2 ? pointsToTwips(rightIndent) : undefined,
                }
                : undefined,
        spacing: {
            before: pointsToTwips(sourceGap),
            after: 0,
            line: pointsToTwips(lineHeight),
            lineRule: LineRuleType.EXACT,
        },
        keepNext: false,
        widowControl: false,
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
    const deriveColumnWidths = (maximumColumns) => {
        const tableWidth = Math.max(36, toNumber(table.bbox?.width, maximumColumns * 72));
        const tableLeft = toNumber(table.bbox?.x);
        const anchors = (table.columnAnchors || table.structure?.columnAnchors || [])
            .map((anchor) => toNumber(anchor, Number.NaN))
            .filter(Number.isFinite)
            .slice(0, maximumColumns);
        let widths = [];

        if (anchors.length === maximumColumns) {
            const tableRight = tableLeft + tableWidth;
            widths = anchors.map((anchor, index) =>
                index + 1 < anchors.length
                    ? anchors[index + 1] - anchor
                    : tableRight - anchor
            );
        }

        if (widths.length !== maximumColumns || widths.some((width) => width < 4)) {
            widths = Array.from({ length: maximumColumns }, () => tableWidth / maximumColumns);
        }

        const total = widths.reduce((sum, width) => sum + width, 0);
        const scale = tableWidth / Math.max(1, total);
        return widths.map((width) => Math.max(4, width * scale));
    };

    const professional = table.professional;
    if (professional?.grid?.length && professional.columnCount >= 2) {
        const grid = professional.grid.map((row) =>
            row.map((cell) => ({
                ...cell,
                text: cleanText(cell.text),
                columnSpan: Math.max(1, toNumber(cell.columnSpan, 1)),
                rowSpan: Math.max(1, toNumber(cell.rowSpan, 1)),
            }))
        ).filter((row) => row.length > 0);
        if (!grid.length) return null;
        const headerCount = Math.max(0, professional.headerRows || 0);
        return {
            headers: headerCount ? grid[0] : [],
            headerRows: headerCount ? grid.slice(0, headerCount) : [],
            rows: grid.slice(headerCount),
            maximumColumns: professional.columnCount,
            columnWidths: deriveColumnWidths(professional.columnCount),
            borderStyle: professional.borderStyle,
            typography: professional.typography || {},
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
    const explicitHeaders = hasExplicitHeaders
        ? Array.from({ length: maximumColumns }, (_, index) => cleanText(headers[index]))
        : [];
    const rowSignature = (row) =>
        row.map((value) => cleanText(value).toLocaleLowerCase("es")).join("\u241F");

    // pdfplumber conserva la cabecera tanto en `headers` como en la primera
    // fila de `rows`. Si ambas representan la misma fila, no debe generarse
    // una segunda cabecera editable dentro del cuerpo de la tabla.
    if (
        explicitHeaders.length &&
        normalizedRows.length &&
        rowSignature(normalizedRows[0]) === rowSignature(explicitHeaders)
    ) {
        normalizedRows.shift();
    }

    const normalizedHeaders = hasExplicitHeaders
        ? explicitHeaders
        : firstRowLooksLikeHeader
          ? normalizedRows.shift()
          : [];

    return {
        headers: normalizedHeaders,
        headerRows: normalizedHeaders.length ? [normalizedHeaders] : [],
        rows: normalizedRows,
        maximumColumns,
        columnWidths: deriveColumnWidths(maximumColumns),
        borderStyle: "grid",
        typography: {},
        professional: false,
    };
}

function createTableCell(
    value,
    isHeader,
    widthTwips,
    {
        fontSizeHalfPoints = 18,
        verticalMarginTwips = 70,
        horizontalMarginTwips = 90,
    } = {}
) {
    const cell = typeof value === "object" && value !== null
        ? value
        : { text: value };
    const nativeLines = (cell.nativeLines || []).filter((line) => line.words?.length);
    const alignment = {
        center: AlignmentType.CENTER,
        right: AlignmentType.RIGHT,
        left: AlignmentType.LEFT,
    }[cell.alignment] || AlignmentType.LEFT;
    const resolvedAlignment = isHeader ? AlignmentType.CENTER : alignment;
    const sourceLines = (cell.sourceLines || [])
        .map(cleanText)
        .filter(Boolean);
    const textLines = sourceLines.length
        ? sourceLines
        : String(cell.text ?? "")
            .split(/\r?\n/)
            .map(cleanText)
            .filter(Boolean);
    const safeLines = textLines.length ? textLines : [""];
    const fontPoints = clamp(
        toNumber(cell.fontSize, fontSizeHalfPoints / 2),
        5,
        14
    );
    const availableLineHeight = toNumber(cell.bbox?.height) > 0
        ? (
            toNumber(cell.bbox.height) -
            (verticalMarginTwips * 2) / POINT_TO_TWIP
        ) / safeLines.length
        : fontPoints * 1.16;
    const lineHeightPoints = clamp(
        availableLineHeight,
        fontPoints * 1.02,
        fontPoints * 1.34
    );
    const fontFamily = normalizeWordFontFamily(
        cell.fontFamily || cell.fontName || "Arial",
        fontPoints
    );
    const textColor = typeof cell.color === "string"
        ? cell.color.replace(/^#/, "") || undefined
        : undefined;
    const nativeParagraphs = nativeLines.map((line, index) => {
        const lineFontSize = average(line.words.map((word) => toNumber(word.fontSize, fontPoints)));
        const normalLineHeight = Math.max(7, lineFontSize * 1.15);
        const nextLine = nativeLines[index + 1];
        const sourceAdvance = nextLine
            ? Math.max(1, toNumber(nextLine.bbox?.y) - toNumber(line.bbox?.y))
            : normalLineHeight;
        const exactLineHeight = Math.min(normalLineHeight, sourceAdvance);
        const sourceTop = toNumber(line.bbox?.y) - toNumber(cell.bbox?.y);
        const baselineCompensation = clamp(lineFontSize * 0.13, 1.2, 3.2);
        const leftInset = Math.max(0, toNumber(line.bbox?.x) - toNumber(cell.bbox?.x));
        const availableWidth = Math.max(1, widthTwips / POINT_TO_TWIP - leftInset);
        // Full native lines are sensitive to half-point font and twip rounding.
        // Reserve 1% only on near-full cell lines, never by shrinking the document.
        const horizontalScale = toNumber(line.bbox?.width) >= availableWidth * 0.97 ? 99 : 100;
        return new Paragraph({
            children: createWordRuns(line.words, { preserveGaps: true, horizontalScale }),
            alignment: AlignmentType.LEFT,
            indent: {
                left: pointsToTwips(Math.max(0, toNumber(line.bbox?.x) - toNumber(cell.bbox?.x))),
                // Tolera el pequeño desfase de métricas de la fuente instalada
                // sin mandar la última palabra a una línea extra recortada.
                right: -pointsToTwips(2),
            },
            spacing: {
                before: index === 0 ? pointsToTwips(Math.max(0, sourceTop - baselineCompensation)) : 0,
                after: nextLine ? pointsToTwips(Math.max(0, sourceAdvance - exactLineHeight)) : 0,
                line: pointsToTwips(exactLineHeight),
                lineRule: LineRuleType.EXACT,
            },
            keepNext: false,
            widowControl: false,
        });
    });

    return new TableCell({
        width: {
            size: widthTwips,
            type: WidthType.DXA,
        },
        columnSpan: Math.max(1, toNumber(cell.columnSpan, 1)) > 1
            ? Math.max(1, toNumber(cell.columnSpan, 1))
            : undefined,
        rowSpan: Math.max(1, toNumber(cell.rowSpan, 1)) > 1
            ? Math.max(1, toNumber(cell.rowSpan, 1))
            : undefined,
        verticalAlign: nativeParagraphs.length ? VerticalAlign.TOP : VerticalAlign.CENTER,
        // Preserve a PDF cell's own fill, including an explicit absence of
        // shading. Grey is only a fallback for inferred/non-native headers.
        shading: cell.shading
            ? { fill: String(cell.shading).replace(/^#/, "") }
            : isHeader && cell.shading !== null
              ? { fill: "F2F2F2" }
              : undefined,
        margins: {
            marginUnitType: WidthType.DXA,
            top: nativeParagraphs.length ? 0 : verticalMarginTwips,
            right: nativeParagraphs.length ? 0 : horizontalMarginTwips,
            bottom: nativeParagraphs.length ? 0 : verticalMarginTwips,
            left: nativeParagraphs.length ? 0 : horizontalMarginTwips,
        },
        children: nativeParagraphs.length ? nativeParagraphs : [
            new Paragraph({
                children: [
                    ...safeLines.map((line, index) =>
                        new TextRun({
                            text: line,
                            break: index > 0 ? 1 : undefined,
                            bold: isHeader || Boolean(cell.bold),
                            italics: Boolean(cell.italic),
                            font: fontFamily,
                            size: Math.round(fontPoints * 2),
                            color: textColor,
                        })
                    ),
                ],
                alignment: resolvedAlignment,
                spacing: {
                    before: 0,
                    after: 0,
                    line: pointsToTwips(lineHeightPoints),
                    lineRule: LineRuleType.EXACT,
                },
            }),
        ],
    });
}

function createWordTable(table, { floating = false, leftMargin = 0 } = {}) {
    const normalized = normalizeTableRows(table);

    if (!normalized) {
        return null;
    }

    const columnWidthsTwips = normalized.columnWidths.map(pointsToTwips);
    const tableWidthTwips = columnWidthsTwips.reduce((sum, width) => sum + width, 0);
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
    const inferredFontPoints = toNumber(normalized.typography?.fontSize);
    const fontPoints = inferredFontPoints > 0
        ? clamp(inferredFontPoints, 5.5, 12)
        : detectedTableHeight > 0
        ? clamp(targetRowHeight * 0.34, 6, 9)
        : clamp(targetRowHeight * 0.45, 5.5, 9);
    const fontSizeHalfPoints = Math.round(fontPoints * 2);
    const verticalMarginTwips = detectedTableHeight > 0 ? 30 : 70;
    const horizontalMarginTwips = detectedTableHeight > 0 ? 30 : 90;
    const rowHeightFor = (row) => {
        const nativeRowGeometry = row.length > 0 && row.every((cell) => cell?.nativeLines?.length);
        const singleRowHeights = (row || [])
            .filter((cell) => Math.max(1, toNumber(cell?.rowSpan, 1)) === 1)
            .map((cell) => toNumber(cell?.bbox?.height));
        const sourceHeight = singleRowHeights.length
            ? Math.max(0, ...singleRowHeights)
            : Math.max(
                0,
                ...(row || []).map(
                    (cell) =>
                        toNumber(cell?.bbox?.height) /
                        Math.max(1, toNumber(cell?.rowSpan, 1))
                )
            );
        const resolvedHeight = sourceHeight > 0
            ? clamp(
                sourceHeight -
                    (floating && detectedTableHeight > 0 && !nativeRowGeometry
                        ? WORD_TABLE_ROW_OVERHEAD_POINTS
                        : 0),
                7,
                360
            )
            : targetRowHeight;
        return detectedTableHeight > 0
            ? {
                value: pointsToTwips(resolvedHeight),
                rule:
                    floating && sourceHeight > 0
                        ? HeightRule.EXACT
                        : HeightRule.ATLEAST,
            }
            : undefined;
    };

    if (table.caption || table.tableTitle) {
        rows.push(
            new TableRow({
                cantSplit: true,
                height: rowHeightFor([]),
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

    const createRowCells = (row, isHeader) => {
        let nextColumn = 0;
        return row.map((cell) => {
            const explicitColumn = Number(cell?.columnIndex);
            const columnIndex = Number.isFinite(explicitColumn)
                ? explicitColumn
                : nextColumn;
            const span = Math.max(1, toNumber(cell?.columnSpan, 1));
            const widthTwips = columnWidthsTwips
                .slice(columnIndex, columnIndex + span)
                .reduce((sum, width) => sum + width, 0);
            nextColumn = columnIndex + span;
            return createTableCell(cell, isHeader, Math.max(80, widthTwips), {
                fontSizeHalfPoints,
                verticalMarginTwips,
                horizontalMarginTwips,
            });
        });
    };

    normalized.headerRows.forEach((headerRow) => {
        rows.push(
            new TableRow({
                tableHeader: true,
                cantSplit: true,
                height: rowHeightFor(headerRow),
                children: createRowCells(headerRow, true),
            })
        );
    });

    normalized.rows.forEach((row) => {
        rows.push(
            new TableRow({
                cantSplit: true,
                height: rowHeightFor(row),
                children: createRowCells(row, false),
            })
        );
    });

    const border = normalized.borderStyle === "borderless"
        ? { color: "FFFFFF", size: 0, style: BorderStyle.NONE }
        : {
            color: normalized.borderStyle === "light-grid" ? "9CA3AF" : "000000",
            size: normalized.borderStyle === "light-grid" ? 2 : 4,
            style: BorderStyle.SINGLE,
        };

    return new Table({
        rows,
        width: { size: tableWidthTwips, type: WidthType.DXA },
        columnWidths: columnWidthsTwips,
        layout: TableLayoutType.FIXED,
        indent: !floating
            ? { size: pointsToTwips(toNumber(table.bbox?.x) - leftMargin), type: WidthType.DXA }
            : undefined,
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

function pointInsideBox(x, y, box, padding = 2) {
    return (
        x >= toNumber(box?.x) - padding &&
        x <= toNumber(box?.x) + toNumber(box?.width) + padding &&
        y >= toNumber(box?.y) - padding &&
        y <= toNumber(box?.y) + toNumber(box?.height) + padding
    );
}

function wordBoundingBox(words = []) {
    if (!words.length) return { x: 0, y: 0, width: 0, height: 0 };
    const left = Math.min(...words.map((word) => toNumber(word.x)));
    const top = Math.min(...words.map((word) => toNumber(word.y)));
    const right = Math.max(
        ...words.map((word) => toNumber(word.x) + toNumber(word.width))
    );
    const bottom = Math.max(
        ...words.map((word) => toNumber(word.y) + toNumber(word.height))
    );
    return { x: left, y: top, width: right - left, height: bottom - top };
}

export function splitLineByComplexTableCells(line = {}, tables = []) {
    const words = (line.words || []).filter((word) => cleanText(word.text));
    if (!words.length || !tables.length) return [line];

    const cells = tables.flatMap((table, tableIndex) =>
        (table.structure?.raw || []).flatMap((row, rowIndex) =>
            (row.cells || [])
                .filter((cell) => cell.bbox)
                .map((cell, cellIndex) => ({
                    key: `${tableIndex}:${rowIndex}:${cellIndex}`,
                    tableIndex,
                    bbox: cell.bbox,
                }))
        )
    );
    const groups = new Map();
    words.forEach((word) => {
        const x = toNumber(word.x) + toNumber(word.width) / 2;
        const y = toNumber(word.y) + toNumber(word.height) / 2;
        const containingCells = cells
            .filter((cell) => pointInsideBox(x, y, cell.bbox, 0.45))
            .sort(
                (first, second) =>
                    toNumber(first.bbox.width) * toNumber(first.bbox.height) -
                    toNumber(second.bbox.width) * toNumber(second.bbox.height)
            );
        const cell = containingCells[0];
        const tableIndex = tables.findIndex((table) => pointInsideBox(x, y, table.bbox, 0.45));
        const key = cell?.key || (tableIndex >= 0 ? `table-${tableIndex}-unmapped` : "outside");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(word);
    });

    if (groups.size <= 1) return [line];
    return [...groups.values()]
        .map((groupWords, index) => ({
            ...line,
            id: `${line.id || "source-line"}-cell-${index + 1}`,
            words: groupWords.sort((first, second) => toNumber(first.x) - toNumber(second.x)),
            text: groupWords.map((word) => cleanText(word.text)).join(" "),
            bbox: wordBoundingBox(groupWords),
        }))
        .sort((first, second) => toNumber(first.bbox.x) - toNumber(second.bbox.x));
}

export function splitLineByLargeMeasuredGaps(line = {}) {
    const words = (line.words || [])
        .filter((word) => cleanText(word.text))
        .sort((first, second) => toNumber(first.x) - toNumber(second.x));
    if (words.length < 2) return [line];

    const sizes = words
        .map((word) => toNumber(word.fontSize, toNumber(word.height) * 0.82))
        .filter((value) => value > 0)
        .sort((first, second) => first - second);
    const medianSize = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 10;
    const splitThreshold = Math.max(18, medianSize * 3.2);
    const groups = [[words[0]]];

    words.slice(1).forEach((word) => {
        const current = groups.at(-1);
        const previous = current.at(-1);
        const gap = toNumber(word.x) - (toNumber(previous.x) + toNumber(previous.width));
        if (gap > splitThreshold) groups.push([word]);
        else current.push(word);
    });
    if (groups.length === 1) return [line];

    return groups.map((groupWords, index) => ({
        ...line,
        id: `${line.id || "source-line"}-gap-${index + 1}`,
        words: groupWords,
        text: groupWords.map((word) => cleanText(word.text)).join(" "),
        bbox: wordBoundingBox(groupWords),
    }));
}

function isTextGroupInsideTable(group, table) {
    if (boxOverlapRatio(table.bbox, group.bbox) >= 0.35) {
        return true;
    }

    const words = (group.words || []).filter((word) => cleanText(word.text));
    if (!words.length) {
        return false;
    }
    const coveredWords = words.filter((word) =>
        pointInsideBox(
            toNumber(word.x) + toNumber(word.width) / 2,
            toNumber(word.y) + toNumber(word.height) / 2,
            table.bbox
        )
    ).length;
    return coveredWords / words.length >= 0.6;
}

function startsBullet(text) {
    return /^[•▪◦‣·]\s*/.test(cleanText(text));
}

function startsStructuredHeading(text) {
    const value = cleanText(text);
    return /^\d+(?:\.\d+){0,4}\.?\s+[A-ZÁÉÍÓÚÑ]/.test(value) ||
        (/^[A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9\s.,:;()-]{3,80}$/.test(value) &&
            value.split(/\s+/).length <= 12);
}

function groupParagraphLines(paragraph = {}) {
    const lines = (paragraph.lines || [])
        .filter((line) => cleanText(line.text))
        .sort((first, second) => toNumber(first.bbox?.y) - toNumber(second.bbox?.y));
    if (lines.length < 2) {
        return lines.length
            ? [{ ...paragraph, lines, words: lines.flatMap((line) => line.words || []) }]
            : [];
    }

    const groups = [];
    lines.forEach((line) => {
        const current = groups.at(-1);
        const referenceX = toNumber(current?.[0]?.bbox?.x);
        const previousLine = current?.at(-1);
        const previousBottom =
            toNumber(previousLine?.bbox?.y) + toNumber(previousLine?.bbox?.height);
        const verticalGap = toNumber(line.bbox?.y) - previousBottom;
        const sourceLineHeight = Math.max(
            7,
            toNumber(previousLine?.bbox?.height, toNumber(line.bbox?.height, 10))
        );
        const indentationChanged =
            current && Math.abs(toNumber(line.bbox?.x) - referenceX) > 12;
        const startsNewStructure = startsBullet(line.text) || startsStructuredHeading(line.text);
        const hasParagraphGap = current && verticalGap > Math.max(5, sourceLineHeight * 0.62);
        if (!current || indentationChanged || startsNewStructure || hasParagraphGap) {
            groups.push([line]);
        } else {
            current.push(line);
        }
    });

    return groups.map((group) => {
        const left = Math.min(...group.map((line) => toNumber(line.bbox?.x)));
        const top = Math.min(...group.map((line) => toNumber(line.bbox?.y)));
        const right = Math.max(
            ...group.map(
                (line) => toNumber(line.bbox?.x) + toNumber(line.bbox?.width)
            )
        );
        const bottom = Math.max(
            ...group.map(
                (line) => toNumber(line.bbox?.y) + toNumber(line.bbox?.height)
            )
        );
        return {
            ...paragraph,
            text: group.map((line) => cleanText(line.text)).join(" "),
            words: group.flatMap((line) => line.words || []),
            lines: group,
            isBullet: startsBullet(group[0]?.text),
            bbox: { x: left, y: top, width: right - left, height: bottom - top },
        };
    });
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
    const margins = getPageMargins(page);
    const elements = [];
    const floatingImages = [];
    const neuralFormulas = page.analysis.neuralFormulas || [];

    page.analysis.paragraphs.forEach((paragraph) => {
        if (
            isInsideZone(paragraph, header) ||
            isInsideZone(paragraph, footer) ||
            neuralFormulas.some(
                (formula) => boxOverlapRatio(formula.bbox, paragraph.bbox) >= 0.6
            )
        ) {
            return;
        }

        groupParagraphLines(paragraph).forEach((group) => {
            if (
                page.analysis.tables.some((table) => isTextGroupInsideTable(group, table))
            ) {
                return;
            }
            elements.push({
                type: "paragraph",
                y: toNumber(group.bbox?.y),
                bbox: group.bbox,
                paragraph: group,
            });
        });
    });

    neuralFormulas.forEach((formula) => {
        elements.push({
            type: "formula",
            y: toNumber(formula.bbox?.y),
            bbox: formula.bbox,
            formula,
        });
    });

    page.analysis.tables.forEach((table) => {
        const element = createWordTable(table, { floating: false, leftMargin: margins.left });
        if (element) {
            elements.push({
                type: "table",
                y: toNumber(table.bbox?.y),
                bbox: table.bbox,
                element,
            });
        }
    });

    (page.review?.excludeImages ? [] : page.images || []).forEach((image, index) => {
        const imageRegion = (page.regionAnalysis?.regions || []).find(
            (region) =>
                region.source === "image" &&
                boxOverlapRatio(region.bbox, image) >= 0.72
        );
        const protectedInk =
            Boolean(image.cleanedTextLayer || image.nativeEmbedded) ||
            ["signature", "stamp"].includes(imageRegion?.type);
        floatingImages.push(
            createFloatingImage(image, page, {
                background: protectedInk,
                zIndex: index + 5,
            })
        );
    });

    if (!elements.length) {
        page.analysis.lines.forEach((line) => {
            if (!isInsideZone(line, header) && !isInsideZone(line, footer)) {
                elements.push({
                    type: "paragraph",
                    y: toNumber(line.bbox?.y),
                    bbox: line.bbox,
                    paragraph: {
                        bbox: line.bbox,
                        text: line.text,
                        words: line.words || [],
                        lines: [line],
                    },
                });
            }
        });
    }
    let previousBottom = toNumber(page.analysis.spatial?.textBox?.y, margins.top);
    const flowChildren = elements
        .sort((a, b) => a.y - b.y)
        .map((entry) => {
            const gap = Math.max(0, entry.y - previousBottom);
            previousBottom = Math.max(
                previousBottom,
                entry.y + toNumber(entry.bbox?.height)
            );
            if (entry.type === "paragraph") {
                return createParagraphFromLines(
                    entry.paragraph.lines,
                    page,
                    margins,
                    {
                        bbox: entry.bbox,
                        text: entry.paragraph.text,
                        beforePoints: gap,
                        isBullet: entry.paragraph.isBullet,
                    }
                );
            }
            if (entry.type === "formula") {
                const latex = cleanText(entry.formula.latex || entry.formula.text);
                return new Paragraph({
                    children: latex
                        ? [createEditableMath(latex)]
                        : [new TextRun({ text: normalizeFormulaText(entry.formula.text) })],
                    spacing: {
                        before: pointsToTwips(gap),
                        after: 0,
                    },
                });
            }
            if (entry.type === "table") {
                return entry.element;
            }
            return entry.element;
        })
        .filter(Boolean);
    const children = [...floatingImages.filter(Boolean), ...flowChildren];

    return children.length
        ? children
        : [new Paragraph({ children: [] })];
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
            spacing: { before: 0, after: 0 },
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
                        type: TextWrappingType.NONE,
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
        spacing: {
            before: 0,
            after: 0,
            line: 20,
            lineRule: LineRuleType.EXACT,
        },
    });
}

function createTextFrame(region, page) {
    const bbox = region.bbox || {};
    const words = region.words?.length
        ? region.words
        : (region.lines || []).flatMap((line) => line.words || []);
    const averageFontSize = average(
        words.map((word) => toNumber(word.fontSize, word.height * 0.82)).filter(Boolean)
    );
    const lineCount = Math.max(1, (region.lines || []).length);
    const estimatedLineHeight = Math.max(7, (averageFontSize || 10) * 1.15);
    const usesSmallQuicksand =
        averageFontSize > 0 &&
        averageFontSize < 30 &&
        words.some((word) => /^quicksand/i.test(cleanText(word.fontFamily || word.fontName)));
    // Quicksand Light from Office PDFs renders around 3 % wider in Word/LO at
    // caption and heading sizes. Constrain only that range; the large Eureka
    // logotype already matches its source geometry.
    const nativeHorizontalScale = usesSmallQuicksand ? 97 : NATIVE_TEXT_HORIZONTAL_SCALE;
    const frameHeight = Math.max(
        estimatedLineHeight * lineCount + 3,
        toNumber(bbox.height, estimatedLineHeight) + 3
    );
    const alignment = inferAlignment(bbox, page.dimensions.width, region.lines);
    const children = [];

    (region.lines || []).forEach((line, index) => {
        children.push(...createWordRuns(line.words || [], {
            firstBreak: index > 0,
            // En títulos, listas y rótulos la separación horizontal también
            // forma parte del diseño. Los párrafos justificados quedan a cargo
            // del motor de Word para evitar duplicar la expansión de espacios.
            preserveGaps: alignment !== AlignmentType.JUSTIFIED,
            horizontalScale: nativeHorizontalScale,
        }));
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

    const singleLineReserve = lineCount === 1
        ? Math.max(
            8,
            (averageFontSize || 10) * 0.9,
            toNumber(bbox.width) * 0.22
        )
        : 0;
    const horizontalReserve = alignment === AlignmentType.CENTER
        ? Math.max(8, singleLineReserve, toNumber(bbox.width) * 0.12)
        : Math.max(
            4,
            singleLineReserve,
            (averageFontSize || 10) * 0.6,
            toNumber(bbox.width) * 0.015
        );
    const frameX = alignment === AlignmentType.CENTER
        ? Math.max(0, toNumber(bbox.x) - horizontalReserve / 2)
        : alignment === AlignmentType.RIGHT
          ? Math.max(0, toNumber(bbox.x) - horizontalReserve)
          : Math.max(0, toNumber(bbox.x));
    const frameWidth = Math.max(18, toNumber(bbox.width) + horizontalReserve);
    // El origen Y de pdfplumber corresponde al borde superior visible del
    // glifo; Word posiciona primero la caja de línea y añade el ascendente.
    // La comparación a 120 dpi de Arial 11–12 pt sitúa este ascendente en
    // 1,4–1,6 pt. Una compensación del 22 % elevaba el texto cerca de 1 pt.
    const baselineCompensation = clamp(
        (averageFontSize || 10) * 0.13 + (usesSmallQuicksand ? 1 : 0),
        1.2,
        4.2
    );

    return new Paragraph({
        children,
        alignment,
        frame: {
            type: "absolute",
            position: {
                x: pointsToTwips(frameX),
                y: pointsToTwips(Math.max(0, toNumber(bbox.y) - baselineCompensation)),
            },
            width: pointsToTwips(frameWidth),
            height: pointsToTwips(frameHeight),
            anchor: {
                horizontal: FrameAnchorType.PAGE,
                vertical: FrameAnchorType.PAGE,
            },
            wrap: FrameWrap.NONE,
            anchorLock: true,
            rule: HeightRule.ATLEAST,
            space: { horizontal: 0, vertical: 0 },
        },
        spacing: {
            before: 0,
            after: 0,
            line: pointsToTwips(estimatedLineHeight),
            lineRule: LineRuleType.EXACT,
        },
        keepLines: true,
    });
}

function normalizedQuarterTurn(words = []) {
    const rotations = words
        .map((word) => ((Math.round(toNumber(word.rotation) / 90) * 90) % 360 + 360) % 360)
        .filter((rotation) => rotation === 90 || rotation === 270);
    if (!rotations.length || rotations.length < Math.ceil(words.length * 0.6)) return 0;
    return rotations.filter((rotation) => rotation === 90).length >= rotations.length / 2
        ? 90
        : 270;
}

function createRotatedTextFrame(region) {
    const bbox = region.bbox || {};
    const words = region.words || [];
    const rotation = normalizedQuarterTurn(words);
    if (!rotation) return null;
    const width = Math.max(8, toNumber(bbox.width, 12));
    const height = Math.max(12, toNumber(bbox.height, 24));
    const border = { color: "FFFFFF", size: 0, style: BorderStyle.NONE };
    const paragraph = new Paragraph({
        children: createWordRuns(words, { preserveGaps: true }),
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT },
    });

    return new Table({
        rows: [
            new TableRow({
                cantSplit: true,
                height: { value: pointsToTwips(height), rule: HeightRule.EXACT },
                children: [
                    new TableCell({
                        width: { size: pointsToTwips(width), type: WidthType.DXA },
                        verticalAlign: VerticalAlign.CENTER,
                        textDirection: rotation === 90
                            ? TextDirection.BOTTOM_TO_TOP_LEFT_TO_RIGHT
                            : TextDirection.TOP_TO_BOTTOM_RIGHT_TO_LEFT,
                        margins: { top: 0, right: 0, bottom: 0, left: 0 },
                        borders: { top: border, right: border, bottom: border, left: border },
                        children: [paragraph],
                    }),
                ],
            }),
        ],
        width: { size: pointsToTwips(width), type: WidthType.DXA },
        columnWidths: [pointsToTwips(width)],
        layout: TableLayoutType.FIXED,
        float: {
            horizontalAnchor: TableAnchorType.PAGE,
            verticalAnchor: TableAnchorType.PAGE,
            absoluteHorizontalPosition: pointsToTwips(bbox.x),
            absoluteVerticalPosition: pointsToTwips(bbox.y),
            leftFromText: 0,
            rightFromText: 0,
            topFromText: 0,
            bottomFromText: 0,
            overlap: OverlapType.OVERLAP,
        },
        borders: {
            top: border,
            right: border,
            bottom: border,
            left: border,
            insideHorizontal: border,
            insideVertical: border,
        },
    });
}

function createPositionedSectionAnchor() {
    return new Paragraph({
        children: [
            new TextRun({
                text: "\u200B",
                color: "FFFFFF",
                size: 2,
            }),
        ],
        spacing: {
            before: 0,
            after: 0,
            line: 20,
            lineRule: LineRuleType.EXACT,
        },
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
            rule: HeightRule.ATLEAST,
            space: { horizontal: 0, vertical: 0 },
        },
        spacing: { before: 0, after: 0 },
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

    if (
        page.renderedPage?.role === "clean-editable-background" ||
        page.editableLayout === "positioned"
    ) {
        const formulaRegions = (page.regionAnalysis?.regions || []).filter(
            (region) => region.type === "formula" && region.source === "neural-layout"
        );
        const pageTables = page.analysis?.tables || [];
        const usesLayeredTableBackground =
            page.renderedPage?.role === "clean-editable-background" &&
            pageTables.length > 0;
        const editableTables = usesLayeredTableBackground
            ? []
            : pageTables.filter((table) => !isComplexPositionedTable(table));
        const complexTables = usesLayeredTableBackground
            ? pageTables
            : pageTables.filter(isComplexPositionedTable);
        editableTables.forEach((table) => {
            const element = createWordTable(table, { floating: true });
            if (element) children.push(element);
        });
        formulaRegions.forEach((region) => children.push(createFormulaFrame(region)));
        const positionedLines = (page.content?.lines || [])
            .flatMap((line) => splitLineByComplexTableCells(line, complexTables))
            .flatMap((line) => splitLineByLargeMeasuredGaps(line));
        positionedLines.forEach((line, index) => {
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
            children.push(
                createRotatedTextFrame(lineRegion) || createTextFrame(lineRegion, page)
            );
        });

        children.push(createPositionedSectionAnchor());
        return children;
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

    children.push(createPositionedSectionAnchor());
    return children;
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
    (page.analysis?.tables || []).forEach((table) => {
        (table.professional?.grid || []).forEach((row) => {
            row.forEach((cell) => {
                (cell.nativeLines || []).forEach((line) => applyToWords(line.words));
            });
        });
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
    const positionedEditable =
        effectiveMode === "editable" && page.editableLayout === "positioned";
    // Se escribe el tamaño físico directamente. La bandera LANDSCAPE de docx
    // vuelve a intercambiar ancho y alto y LibreOffice puede insertar una hoja
    // adicional por sección; con w > h ambos programas infieren la orientación.
    const margins =
        effectiveMode === "fidelity" || effectiveMode === "visual" || positionedEditable
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
            !positionedEditable &&
            header &&
            !isZoneExcluded(page, "header") &&
            (!cleanText(page.review?.correctedText) || page.review?.wordCorrectionApplied)
                ? {
                    default: new Header({
                        children: createZoneParagraphs(header, page, margins),
                    }),
                }
                : { default: new Header({ children: [new Paragraph({ children: [] })] }) },
        footers:
            effectiveMode === "editable" &&
            !positionedEditable &&
            footer &&
            !isZoneExcluded(page, "footer") &&
            (!cleanText(page.review?.correctedText) || page.review?.wordCorrectionApplied)
                ? {
                    default: new Footer({
                        children: createZoneParagraphs(footer, page, margins),
                    }),
                }
                : { default: new Footer({ children: [new Paragraph({ children: [] })] }) },
        children:
            effectiveMode === "visual"
                ? createFidelityPageChildren(page)
                : effectiveMode === "fidelity"
                  ? createLayeredFidelityPageChildren(page)
                  : positionedEditable
                    ? createLayeredFidelityPageChildren(page)
                  : createEditablePageChildren(page),
    };
}

export async function renderWordDocument(model, onProgress) {
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    onProgress?.({ percent: 94, stage: "docx", detail: "Aplicando estilos y secciones…" });

    const embeddedFonts = globalThis.process?.env?.NOVAPDF_DISABLE_EMBEDDED_FONTS === "1"
        ? []
        : normalizeEmbeddedFontsForDocument(model.embeddedFonts);
    const previousEmbeddedFontFamilies = activeEmbeddedFontFamilies;
    let document;
    activeEmbeddedFontFamilies = embeddedFonts;
    try {
        document = new Document({
            creator: "NovaPDF",
            title: model.title,
            description:
                model.mode === "fidelity"
                    ? "Documento convertido por NovaPDF en modo de máxima fidelidad."
                    : "Documento editable convertido por el motor híbrido de NovaPDF.",
            fonts: embeddedFonts.map(({ name, data }) => ({ name, data })),
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
    } finally {
        activeEmbeddedFontFamilies = previousEmbeddedFontFamilies;
    }

    onProgress?.({ percent: 97, stage: "packing", detail: "Empaquetando el archivo DOCX…" });
    const packedBlob = await Packer.toBlob(document);
    const blob = await addEmbeddedFontFallbacks(packedBlob, embeddedFonts);
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

export function __groupParagraphLinesForTests(paragraph) {
    return groupParagraphLines(paragraph);
}
