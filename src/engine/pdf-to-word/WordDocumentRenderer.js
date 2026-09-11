import {
    AlignmentType,
    BorderStyle,
    Document,
    Footer,
    FrameAnchorType,
    FrameWrap,
    Header,
    HeadingLevel,
    HeightRule,
    HighlightColor,
    HorizontalPositionRelativeFrom,
    ImageRun,
    LineRuleType,
    OverlapType,
    Packer,
    Paragraph,
    SectionType,
    SimpleField,
    Table,
    TableAnchorType,
    TableCell,
    TableLayoutType,
    TableRow,
    Tab,
    TabStopType,
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
import {
    isComplexFlowTable,
    isComplexPositionedTable,
} from "./TableRenderingPolicy.js";

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
        .replace(/(?:[\s_-]*(?:thin|extra[\s_-]*light|light|regular|medium|semi[\s_-]*bold|bold|black|heavy|italic|oblique))+$/i, "")
        .replace(/[^a-z0-9]+/gi, "")
        .toLocaleLowerCase("en");
}

function embeddedFontFamilyFor(value) {
    const requested = canonicalFontFamily(value);
    if (!requested) return null;
    return activeEmbeddedFontFamilies.find(
        (font) => font.transportable &&
            (font.family === requested || font.aliases?.includes(requested))
    )?.familyName || null;
}

function embeddedFontFaceFor(value, { bold = false, italic = false } = {}) {
    const family = canonicalFontFamily(value);
    if (!family) return null;
    const requestedStyle = bold && italic ? "boldItalic" : bold ? "bold" : italic ? "italic" : "regular";
    const faces = activeEmbeddedFontFamilies.filter(
        (font) => font.family === family || font.aliases?.includes(family)
    );
    return faces.find((font) => font.style === requestedStyle) ||
        faces.find((font) => font.style === "regular") || faces[0] || null;
}

function normalizeEmbeddedFontStyle(font = {}) {
    const descriptor = cleanText(font.style) || cleanText(`${font.sourceName || ""} ${font.name || ""}`);
    const bold = /(?:^|[\s_-])(?:bold|black|heavy|semi[\s_-]*bold|demi)(?:$|[\s_-])/i.test(descriptor);
    const italic = /(?:^|[\s_-])(?:italic|oblique)(?:$|[\s_-])/i.test(descriptor);
    if (bold && italic) return "boldItalic";
    if (bold) return "bold";
    if (italic) return "italic";
    return "regular";
}

function normalizeEmbeddedFontsForDocument(fonts = []) {
    const candidatesByFamilyAndStyle = new Map();
    for (const font of fonts || []) {
        const name = cleanText(font?.name);
        const data = font?.data;
        const family = canonicalFontFamily(name);
        const validData = data && Number.isFinite(Number(data.length)) &&
            data.length >= 32 && data.length <= 2 * 1024 * 1024;
        const transportable = Boolean(validData && (!font.embedding || font.embedding === "editable"));
        const characterWidthsEm = font.characterWidthsEm && typeof font.characterWidthsEm === "object"
            ? font.characterWidthsEm : {};
        const hasPortableMetrics = Object.keys(characterWidthsEm).length > 0 ||
            [font.ascentEm, font.descentEm, font.lineGapEm]
                .some((value) => Number.isFinite(Number(value)));
        if (
            !name ||
            !family ||
            UNSAFE_EMBEDDED_FONT_FAMILIES.has(family) ||
            (!transportable && !hasPortableMetrics)
        ) continue;
        const style = normalizeEmbeddedFontStyle(font);
        const key = `${family}:${style}`;
        const candidates = candidatesByFamilyAndStyle.get(key) || [];
        candidates.push({
            id: font.id || `${family}:${style}:${candidates.length}`,
            name,
            data: transportable ? data : null,
            family,
            aliases: [...new Set([
                name,
                font.sourceName,
                ...(font.aliases || []),
            ].map(canonicalFontFamily).filter(Boolean))],
            style,
            transportable,
            spaceAdvanceEm: Number(font.spaceAdvanceEm),
            characterWidthsEm,
            ascentEm: Number(font.ascentEm),
            descentEm: Number(font.descentEm),
            lineGapEm: Number(font.lineGapEm),
            capHeightEm: Number(font.capHeightEm),
            xHeightEm: Number(font.xHeightEm),
            hasKerning: Boolean(font.hasKerning),
        });
        candidatesByFamilyAndStyle.set(key, candidates);
    }
    // Los PDF suelen dividir una misma tipografía en varios subconjuntos. No es
    // seguro aplicar uno de ellos a todos los textos: los glifos ausentes cambian
    // el ancho y pueden desplazar páginas completas. Solo incrustamos familias
    // inequívocas; las fragmentadas usan la sustitución métrica probada.
    const unambiguous = [...candidatesByFamilyAndStyle.values()].flatMap((candidates) => {
        const transportable = candidates.filter((font) => font.transportable);
        if (transportable.length === 1) return transportable;
        // Several unmerged PDF subsets cannot safely represent a complete
        // family. Keep only their best metrics for calibrated substitution.
        const metricCandidate = [...candidates].sort(
            (first, second) =>
                Object.keys(second.characterWidthsEm).length -
                Object.keys(first.characterWidthsEm).length
        )[0];
        return Object.keys(metricCandidate?.characterWidthsEm || {}).length ||
            Number.isFinite(metricCandidate?.ascentEm)
            ? [{ ...metricCandidate, data: null, transportable: false }]
            : [];
    });
    const familyNames = new Map();
    for (const font of unambiguous) {
        if (font.transportable && (font.style === "regular" || !familyNames.has(font.family))) {
            familyNames.set(font.family, font.name);
        }
    }
    return unambiguous.map((font, index) => ({
        ...font,
        familyName: familyNames.get(font.family) || font.name,
        // docx 9.x only emits w:embedRegular. Give each transported face a
        // unique temporary name, then consolidate the family in OOXML below.
        transportName: `NovaPDF Embedded ${index + 1}`,
    }));
}

function usesStableSystemFontMetrics(value) {
    return /^(?:arial|calibri|cambria|courier|georgia|helvetica|symbol|tahoma|times|trebuchet|verdana|wingdings)/i
        .test(cleanText(value).replace(/^[A-Z]{6}\+/i, ""));
}

function nativeWordHorizontalScale(word, fallbackScale) {
    if (!String(word?.source || "").includes("native") || toNumber(word?.rotation) ||
        !Number.isFinite(Number(word?.width)) || Number(word.width) <= 0 ||
        fallbackScale !== NATIVE_TEXT_HORIZONTAL_SCALE ||
        usesStableSystemFontMetrics(word.fontFamily || word.fontName) ||
        (word.correctedText !== undefined && cleanText(word.correctedText) !== cleanText(word.text))) {
        return fallbackScale;
    }
    const face = embeddedFontFaceFor(word.fontFamily || word.fontName, word);
    const widths = face?.characterWidthsEm;
    const characters = Array.from(cleanText(word.text));
    if (!characters.length || !widths) return fallbackScale;
    const advances = characters.map((character) => Number(widths[String(character.codePointAt(0))]));
    if (advances.some((advance) => !Number.isFinite(advance) || advance <= 0)) return fallbackScale;
    const fontSize = clamp(toNumber(word.fontSize, word.height * 0.82), 1, 400);
    const tracking = Number.isFinite(Number(word.characterSpacing))
        ? Number(word.characterSpacing) * Math.max(0, characters.length - 1) : 0;
    const nominalWidth = fontSize * advances.reduce((sum, advance) => sum + advance, 0) + tracking;
    const ratio = Number(word.width) / nominalWidth;
    if (!Number.isFinite(ratio) || ratio < 0.75 || ratio > 1.25) return fallbackScale;
    // Word rounds w:w to integer percentages. Sub-percent corrections turn
    // into a full 1 % change and produced measurable regressions in Arial
    // tables. Keep a dead band; real condensed/expanded text still benefits.
    if (Math.abs(ratio - fallbackScale / 100) < 0.015) return fallbackScale;
    return clamp(Math.round(ratio * 100), 80, 120);
}

function nativeSpaceAdvanceFactor(word, fontFamily) {
    // A PDF subset can omit or remap its space glyph. Applying that value to
    // thousands of synthetic Word spacer runs accumulates rounding drift even
    // when every visible word is correct. Common Office/PDF fonts already match
    // the cross-reader heuristic, so keep that stable path. Distinct display
    // fonts (Shrikhand, Amaranth, Canva Sans...) benefit from their real advance.
    const commonFamily = usesStableSystemFontMetrics(fontFamily);
    const measured = commonFamily ? NaN : Number(
        embeddedFontFaceFor(word?.fontFamily || word?.fontName, word)?.spaceAdvanceEm
    );
    if (Number.isFinite(measured) && measured >= 0.12 && measured <= 0.8) return measured;
    if (/courier/i.test(fontFamily)) return 0.6;
    return /times/i.test(fontFamily) ? 0.25 : 0.278;
}

function nativeKerningThreshold(word, fontSize) {
    const explicit = Number(word?.kerning);
    if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit * 2);
    const face = embeddedFontFaceFor(word?.fontFamily || word?.fontName, word);
    return face?.transportable && face.hasKerning
        ? Math.max(2, Math.round(fontSize * 2))
        : undefined;
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
    // docx emits lowercase GUIDs. Some Word-compatible readers decode font
    // keys only with uppercase hex and silently replace otherwise valid fonts.
    // Casing changes neither the GUID nor the embedded font's XOR bytes.
    let xml = await entry.async("string");
    const grouped = new Map();
    for (const font of embeddedFonts) {
        const escapedTransportName = escapeXmlAttribute(font.transportName);
        const pattern = new RegExp(
            `<w:font w:name="${escapedTransportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">[\\s\\S]*?<\\/w:font>`
        );
        const node = xml.match(pattern)?.[0];
        if (!node) continue;
        const relationship = node.match(/<w:embedRegular\b[^>]*(?:\/>|>[\s\S]*?<\/w:embedRegular>)/)?.[0];
        if (!relationship) continue;
        const family = grouped.get(font.family) || {
            familyName: font.familyName,
            fallback: embeddedFontFallback(font.familyName),
            relationships: [],
        };
        const tag = {
            regular: "w:embedRegular",
            bold: "w:embedBold",
            italic: "w:embedItalic",
            boldItalic: "w:embedBoldItalic",
        }[font.style] || "w:embedRegular";
        family.relationships.push(relationship.replaceAll("w:embedRegular", tag));
        grouped.set(font.family, family);
        xml = xml.replace(node, "");
    }
    const familyNodes = [...grouped.values()].map((family) => (
        `<w:font w:name="${escapeXmlAttribute(family.familyName)}">` +
        `<w:altName w:val="${escapeXmlAttribute(family.fallback)}"/>` +
        `<w:family w:val="auto"/><w:pitch w:val="variable"/>` +
        family.relationships.join("") +
        "</w:font>"
    )).join("");
    xml = xml.replace("</w:fonts>", `${familyNodes}</w:fonts>`).replace(
        /w:fontKey="(\{[0-9a-f-]+\})"/gi,
        (_match, key) => `w:fontKey="${key.toUpperCase()}"`
    );
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
    const measuredFace = embeddedFontFaceFor(family);
    if (measuredFace && !measuredFace.transportable) {
        // Licensing or incomplete subsets can prevent embedding. Use a
        // deterministic Word family while retaining the source advances for
        // horizontal calibration instead of asking Word to guess a fallback.
        return embeddedFontFallback(family);
    }
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

function median(values = []) {
    const sorted = values
        .map(Number)
        .filter(Number.isFinite)
        .sort((first, second) => first - second);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
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
    const textBox = page.analysis?.spatial?.textBox || {};
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

function createWordRuns(words, {
    firstBreak = false,
    preserveGaps = false,
    horizontalScale = NATIVE_TEXT_HORIZONTAL_SCALE,
    artworkContainsDecorations = false,
    preserveNativeScriptMetrics = false,
    leadingTab = false,
} = {}) {
    if (!words.length) {
        return [];
    }

    const runs = [];
    const baselineWords = words.filter((word) => !word.superscript && !word.subscript &&
        Number.isFinite(Number(word.y)) && Number.isFinite(Number(word.height)) && Number(word.height) > 0);
    const referenceBottom = baselineWords.length
        ? average(baselineWords.map((word) => toNumber(word.y) + toNumber(word.height)))
        : null;
    words.forEach((word, index) => {
        const isNative = String(word.source || "").includes("native");
        const nativeScript = preserveNativeScriptMetrics && isNative && (word.superscript || word.subscript);
        // Measured digital titles are not OCR guesses: the OCR safety cap of
        // 48 pt used to shrink 72–96 pt cover/slide headings.
        const fontSize = clamp(toNumber(word.fontSize, word.height * 0.82), isNative ? 1 : 6, isNative ? 400 : 48);
        const fontFamily = normalizeWordFontFamily(
            word.fontFamily || word.fontName,
            fontSize
        );
        const previous = words[index - 1];
        // w:vertAlign would shrink the already-small PDF script a second time.
        // Explicit half-point baseline offsets keep its original font size.
        const nativeScriptPosition = nativeScript && referenceBottom !== null &&
            Number.isFinite(Number(word.y)) && Number.isFinite(Number(word.height))
            ? Math.round((referenceBottom - toNumber(word.y) - toNumber(word.height)) * 2)
            : null;
        const hasMeasuredGap =
            preserveGaps &&
            index > 0 &&
            Number.isFinite(Number(word.x)) &&
            Number.isFinite(Number(previous?.x)) &&
            Number.isFinite(Number(previous?.width));

        if (hasMeasuredGap && leadingTab && index === 1) {
            runs.push(new TextRun({ children: [new Tab()], font: fontFamily, size: Math.round(fontSize * 2) }));
        } else if (hasMeasuredGap) {
            const measuredGap = Math.max(
                0,
                toNumber(word.x) - (toNumber(previous.x) + toNumber(previous.width))
            );
            const spaceFactor = nativeSpaceAdvanceFactor(word, fontFamily);
            const scaledSpaceFactor = spaceFactor * horizontalScale / 100;
            // Word/LibreOffice no siempre comprimen un espacio aislado con
            // w:spacing negativo. Reducir su cuerpo invisible y añadir solo
            // espaciado positivo conserva el ancho sin provocar saltos extra.
            const spaceSize = Math.max(1, Math.floor(Math.min(
                fontSize, measuredGap / scaledSpaceFactor
            ) * 2));
            if (measuredGap > 0.1) {
                runs.push(
                    new TextRun({
                        text: " ",
                        size: spaceSize,
                        font: fontFamily,
                        scale: horizontalScale,
                        characterSpacing: pointsToTwips(
                            clamp(measuredGap - (spaceSize / 2) * scaledSpaceFactor, 0, 72)
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
                ? nativeWordHorizontalScale(word, horizontalScale)
                : undefined,
            bold: Boolean(word.bold),
            italics: Boolean(word.italic),
            underline: word.underline && !(artworkContainsDecorations && word.vectorUnderline)
                ? { type: UnderlineType.SINGLE, color: word.color }
                : undefined,
            strike: Boolean(word.strike && !(artworkContainsDecorations && word.vectorStrike)),
            position: nativeScriptPosition !== null ? String(nativeScriptPosition) : undefined,
            superScript: nativeScriptPosition === null && Boolean(word.superscript),
            subScript: nativeScriptPosition === null && Boolean(word.subscript),
            color: String(word.color || "").replace(/^#/, "") || undefined,
            characterSpacing: Number.isFinite(Number(word.characterSpacing))
                ? pointsToTwips(word.characterSpacing)
                : undefined,
            kern: nativeKerningThreshold(word, fontSize),
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

function startsNumberedList(text) {
    const value = cleanText(text);
    return /^(\d+|[a-zA-Z]|[ivxlcdmIVXLCDM]+)[.)]\s+/.test(value);
}

function dehyphenateLineWords(validLines = []) {
    if (!validLines?.length) return [];
    if (validLines.length === 1) {
        return (validLines[0].words || []).map((word) => ({ ...word }));
    }

    const words = [];
    validLines.forEach((line) => {
        const lineWords = (line.words || []).map((word) => ({ ...word }));
        if (!lineWords.length) return;

        if (words.length > 0) {
            const previousWord = words[words.length - 1];
            const prevText = cleanText(previousWord.correctedText ?? previousWord.text);
            const firstWord = lineWords[0];
            const firstText = cleanText(firstWord.correctedText ?? firstWord.text);

            if (
                /^[a-záéíóúñA-ZÁÉÍÓÚÑ]{2,}[-‐‑\u00ad]$/i.test(prevText) &&
                /^[a-záéíóúñ]/i.test(firstText)
            ) {
                const combined = prevText.replace(/[-‐‑\u00ad]$/, "") + firstText;
                previousWord.text = combined;
                if (previousWord.correctedText) previousWord.correctedText = combined;
                previousWord.width = toNumber(previousWord.width) + toNumber(firstWord.width);
                lineWords.shift();
            }
        }
        words.push(...lineWords);
    });

    return words;
}

function createParagraphFromLines(lines, page, margins, options = {}) {
    const validLines = (lines || []).filter((line) => cleanText(line.text));
    const isBullet = Boolean(options.isBullet);
    const words = dehyphenateLineWords(validLines);
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
    const headingText = cleanText(options.text);
    const isStructuredHeading = startsStructuredHeading(headingText);
    const isLargeTitle = (averageFontSize >= 15 && validLines.length <= 2) || (averageFontSize >= 20);
    const isHeading = !isBullet && (isStructuredHeading || isLargeTitle);
    const isNumberedList = !isBullet && !isHeading && startsNumberedList(headingText);

    let headingLevel = undefined;
    if (isHeading) {
        if (averageFontSize >= 22) headingLevel = HeadingLevel.HEADING_1;
        else if (averageFontSize >= 16) headingLevel = HeadingLevel.HEADING_2;
        else if (averageFontSize >= 12 || isStructuredHeading) headingLevel = HeadingLevel.HEADING_3;
    }

    const indent = clamp(toNumber(bbox.x) - margins.left, 0, page.dimensions.width * 0.35);
    const rightIndent = clamp(
        page.dimensions.width -
            margins.right -
            (toNumber(bbox.x) + toNumber(bbox.width)) -
            WORD_LAYOUT_TOLERANCE_POINTS,
        0,
        page.dimensions.width * 0.35
    );
    const hangingIndentTwips = isNumberedList ? pointsToTwips(18) : undefined;
    const leftIndentTwips = isNumberedList
        ? pointsToTwips(indent + 18)
        : indent > 2
          ? pointsToTwips(indent)
          : undefined;
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
        heading: headingLevel,
        bullet: isBullet ? { level: 0 } : undefined,
        indent:
            !isBullet && (leftIndentTwips !== undefined || rightIndent > 2)
                ? {
                    left: leftIndentTwips,
                    right: rightIndent > 2 ? pointsToTwips(rightIndent) : undefined,
                    hanging: hangingIndentTwips,
                }
                : undefined,
        spacing: {
            before: pointsToTwips(sourceGap),
            after: 0,
            line: pointsToTwips(lineHeight),
            lineRule: LineRuleType.ATLEAST,
        },
        keepNext: Boolean(isHeading),
        widowControl: true,
    });
}

function parsePageNumberParts(lineText, pageNumber, totalPages) {
    const text = cleanText(lineText);
    if (!text) return null;

    const matchExplicit = /^(.*?)\b(?:p[aá]g(?:ina)?\.?\s*)(\d{1,4})(?:\s*(?:\/|de)\s*(\d{1,4}))?(.*)$/i.exec(text);
    if (matchExplicit) {
        return {
            prefix: matchExplicit[1] ? matchExplicit[1].trim() + " " : "",
            hasLabel: true,
            label: text.match(/\b(?:p[aá]g(?:ina)?\.?\s*)/i)?.[0] || "Página ",
            currentPage: matchExplicit[2],
            hasTotal: Boolean(matchExplicit[3]),
            totalSeparator: text.includes("/") ? " / " : " de ",
            totalPages: matchExplicit[3] || String(totalPages),
            suffix: matchExplicit[4] ? " " + matchExplicit[4].trim() : "",
        };
    }

    const matchSlash = /^(.*?)\b(\d{1,4})\s*(\/|de)\s*(\d{1,4})(.*)$/i.exec(text);
    if (matchSlash && !/[a-zA-Z]{3,}/.test(matchSlash[1])) {
        return {
            prefix: matchSlash[1] ? matchSlash[1].trim() + " " : "",
            hasLabel: false,
            currentPage: matchSlash[2],
            hasTotal: true,
            totalSeparator: ` ${matchSlash[3]} `,
            totalPages: matchSlash[4] || String(totalPages),
            suffix: matchSlash[5] ? " " + matchSlash[5].trim() : "",
        };
    }

    const matchDashes = /^[-–—]\s*(\d{1,4})\s*[-–—]$/.exec(text);
    if (matchDashes) {
        return {
            prefix: "- ",
            hasLabel: false,
            currentPage: matchDashes[1],
            hasTotal: false,
            suffix: " -",
        };
    }

    const matchNumber = /^(\d{1,4})$/.exec(text);
    if (matchNumber) {
        return {
            prefix: "",
            hasLabel: false,
            currentPage: matchNumber[1],
            hasTotal: false,
            suffix: "",
        };
    }

    return null;
}

function getSectionPageNumberStart(footer, page, totalPages) {
    for (const line of footer?.lines || []) {
        const parts = parsePageNumberParts(line.text, page.pageNumber, totalPages);
        const value = Number(parts?.currentPage);
        if (Number.isInteger(value) && value > 0 && value <= 9999) {
            return value;
        }
    }
    return null;
}

function createZoneParagraphs(zone, page, margins, totalPages = 1) {
    if (!zone?.lines?.length) {
        return [];
    }

    return zone.lines.map((line) => {
        const pageParts = parsePageNumberParts(line.text, page.pageNumber, totalPages);
        if (pageParts) {
            const words = line.words || [];
            const fontFamily = normalizeWordFontFamily(
                words[0]?.fontFamily || words[0]?.fontName || "Arial",
                10
            );
            const fontSizeHalfPoints = words[0]?.fontSize
                ? Math.round(toNumber(words[0].fontSize) * 2)
                : 20;
            const color = words[0]?.color
                ? String(words[0].color).replace(/^#/, "")
                : undefined;
            const bold = Boolean(words[0]?.bold);
            const italics = Boolean(words[0]?.italic);

            const children = [];
            if (pageParts.prefix) {
                children.push(new TextRun({ text: pageParts.prefix, font: fontFamily, size: fontSizeHalfPoints, color, bold, italics }));
            }
            if (pageParts.hasLabel && pageParts.label) {
                children.push(new TextRun({ text: pageParts.label, font: fontFamily, size: fontSizeHalfPoints, color, bold, italics }));
            }
            children.push(new SimpleField("PAGE", String(pageParts.currentPage)));
            if (pageParts.hasTotal) {
                children.push(new TextRun({ text: pageParts.totalSeparator, font: fontFamily, size: fontSizeHalfPoints, color, bold, italics }));
                const extractedTotal = Number(pageParts.totalPages);
                if (extractedTotal === Number(totalPages)) {
                    children.push(new SimpleField("NUMPAGES", String(pageParts.totalPages)));
                } else {
                    // Un PDF puede ser un extracto (por ejemplo, páginas 169–230).
                    // NUMPAGES devolvería 62 y alteraría el contenido original.
                    children.push(new TextRun({
                        text: String(pageParts.totalPages),
                        font: fontFamily,
                        size: fontSizeHalfPoints,
                        color,
                        bold,
                        italics,
                    }));
                }
            }
            if (pageParts.suffix) {
                children.push(new TextRun({ text: pageParts.suffix, font: fontFamily, size: fontSizeHalfPoints, color, bold, italics }));
            }

            const alignment = inferAlignment(line.bbox, page.dimensions.width, [line]);
            return new Paragraph({
                children,
                alignment,
                spacing: { before: 0, after: 0 },
            });
        }

        return createParagraphFromLines([line], page, margins, {
            bbox: line.bbox,
            text: line.text,
        });
    });
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

function planNativeCellLines(lines, fallbackFontSize) {
    const metrics = lines.map((line) => {
        const baseWords = line.words.filter((word) => !word.superscript && !word.subscript &&
            Number.isFinite(Number(word.y)));
        return {
            fontSize: average((baseWords.length ? baseWords : line.words)
                .map((word) => toNumber(word.fontSize, fallbackFontSize))),
            baseline: baseWords.length && baseWords.every((word) => Number.isFinite(word.baselineY))
                ? average(baseWords.map((word) => word.baselineY)) : null,
            // A raised reference must not move the line's body reference top.
            top: baseWords.length ? average(baseWords.map((word) => Number(word.y))) : toNumber(line.bbox?.y),
        };
    });
    const heights = metrics.map((metric, index) => {
        const normalHeight = Math.max(7, metric.fontSize * 1.15);
        const next = metrics[index + 1];
        // Font ascent changes the top of glyphs, not the source baseline.
        // Older services and OCR keep the geometry-only fallback.
        const advance = next
            ? Math.max(1, metric.baseline !== null && next.baseline !== null
                ? next.baseline - metric.baseline : next.top - metric.top)
            : normalHeight;
        return { ...metric, advance, lineHeight: Math.min(normalHeight, advance) };
    });
    return heights.map((metric, index) => ({
        ...metric,
        // The next paragraph's exact line box sets the next baseline. Using
        // the current one accumulates drift whenever adjacent font sizes differ.
        after: heights[index + 1] ? Math.max(0, metric.advance - heights[index + 1].lineHeight) : 0,
    }));
}

function nativeBulletTabPosition(words, cellBox) {
    const [marker, firstText] = words;
    if (!marker || !firstText || !/^[•▪◦‣·]$/.test(cleanText(marker.text))) return null;
    if (![marker, firstText].every((word) => String(word.source || "").includes("native") &&
        Number.isFinite(word.x) && !toNumber(word.rotation))) return null;
    if (!Number.isFinite(marker.width) || marker.width <= 0 ||
        !Number.isFinite(cellBox?.x) || !Number.isFinite(cellBox?.width)) return null;
    const offset = firstText.x - marker.x;
    const position = firstText.x - cellBox.x;
    // A real tab fixes the text start even when Word substitutes the bullet
    // font. Reject tight/malformed geometry that could jump to a default tab.
    return offset >= Math.max(marker.width + 0.5, toNumber(marker.fontSize, 9) * 0.7) &&
        marker.x >= cellBox.x && position > 0 && position < cellBox.width ? position : null;
}

function createTableCell(
    value,
    isHeader,
    widthTwips,
    {
        fontSizeHalfPoints = 18,
        verticalMarginTwips = 70,
        horizontalMarginTwips = 90,
        nativeRowGeometry = false,
    } = {}
) {
    const cell = typeof value === "object" && value !== null
        ? value
        : { text: value };
    const nativeLines = (cell.nativeLines || []).filter((line) => line.words?.length);
    const preserveCellGeometry = nativeRowGeometry || nativeLines.length > 0;
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
    const nativeLineLayout = planNativeCellLines(nativeLines, fontPoints);
    const nativeParagraphs = nativeLines.map((line, index) => {
        const { fontSize: lineFontSize, lineHeight: exactLineHeight, after, top } = nativeLineLayout[index];
        const hasScript = line.words.some((word) => word.superscript || word.subscript);
        const sourceTop = (hasScript ? top : toNumber(line.bbox?.y)) - toNumber(cell.bbox?.y);
        const baselineCompensation = clamp(lineFontSize * 0.13, 1.2, 3.2);
        const leftInset = Math.max(0, toNumber(line.bbox?.x) - toNumber(cell.bbox?.x));
        const availableWidth = Math.max(1, widthTwips / POINT_TO_TWIP - leftInset);
        // Full native lines are sensitive to half-point font and twip rounding.
        // Reserve 1% only on near-full cell lines, never by shrinking the document.
        const horizontalScale = toNumber(line.bbox?.width) >= availableWidth * 0.97 ? 99 : 100;
        const bulletTab = nativeBulletTabPosition(line.words, cell.bbox);
        return new Paragraph({
            children: createWordRuns(line.words, {
                preserveGaps: true, horizontalScale, preserveNativeScriptMetrics: true,
                leadingTab: bulletTab !== null,
            }),
            tabStops: bulletTab !== null ? [{ type: TabStopType.LEFT, position: pointsToTwips(bulletTab) }] : undefined,
            run: { font: fontFamily, size: Math.round(lineFontSize * 2) },
            alignment: AlignmentType.LEFT,
            indent: {
                left: pointsToTwips(Math.max(0, toNumber(line.bbox?.x) - toNumber(cell.bbox?.x))),
                // Tolera el pequeño desfase de métricas de la fuente instalada
                // sin mandar la última palabra a una línea extra recortada.
                right: -pointsToTwips(2),
            },
            spacing: {
                before: index === 0 ? pointsToTwips(Math.max(0, sourceTop - baselineCompensation)) : 0,
                after: pointsToTwips(after),
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
            top: preserveCellGeometry ? 0 : verticalMarginTwips,
            right: preserveCellGeometry ? 0 : horizontalMarginTwips,
            bottom: preserveCellGeometry ? 0 : verticalMarginTwips,
            left: preserveCellGeometry ? 0 : horizontalMarginTwips,
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

function hasNativeRowGeometry(row) {
    // An empty continuation cell still belongs to the measured native row.
    // Its default padding otherwise shifts text in neighboring Word cells.
    return row.some((cell) => cell?.nativeLines?.length) && row.every((cell) =>
        cell?.nativeLines?.length || (!cleanText(cell?.text) &&
            !cell?.sourceLines?.some(cleanText) && toNumber(cell?.bbox?.height) > 0 &&
            toNumber(cell?.bbox?.width) > 0));
}

function createWordTable(table, { floating = false, leftMargin = 0, printableWidth = 0 } = {}) {
    const normalized = normalizeTableRows(table);

    if (!normalized) {
        return null;
    }

    let columnWidths = [...normalized.columnWidths];
    let indentPoints = Math.max(0, toNumber(table.bbox?.x) - leftMargin);

    if (!floating && printableWidth > 0) {
        if (indentPoints > printableWidth * 0.25) {
            indentPoints = Math.max(0, printableWidth * 0.08);
        }
        const availableWidth = Math.max(72, printableWidth - indentPoints);
        const currentTableWidth = columnWidths.reduce((sum, width) => sum + width, 0);

        if (currentTableWidth > availableWidth) {
            const scale = availableWidth / currentTableWidth;
            columnWidths = columnWidths.map((width) => Math.max(4, width * scale));
        }
    }

    const columnWidthsTwips = columnWidths.map(pointsToTwips);
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
        const nativeRowGeometry = hasNativeRowGeometry(row);
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
        const nativeRowGeometry = hasNativeRowGeometry(row);
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
                nativeRowGeometry,
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
        indent: !floating && indentPoints > 0
            ? { size: pointsToTwips(indentPoints), type: WidthType.DXA }
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
    return /^[•●○▪◦‣·✓✔]\s*/.test(cleanText(text));
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

function createHorizontalRuleParagraph(rule, margins, pageWidth) {
    const ruleX = toNumber(rule.bbox?.x, margins.left);
    const ruleWidth = toNumber(rule.bbox?.width, pageWidth - margins.left - margins.right);
    const leftIndent = clamp(ruleX - margins.left, 0, pageWidth * 0.4);
    const rightIndent = clamp(pageWidth - margins.right - (ruleX + ruleWidth), 0, pageWidth * 0.4);
    const color = rule.strokingColor || rule.color || "9CA3AF";
    const cleanColor = String(color).replace(/^#/, "") || "000000";
    const size = clamp(Math.round(toNumber(rule.lineWidth, 1) * 6), 2, 24);

    return new Paragraph({
        children: [
            new TextRun({
                text: "",
                size: 2,
            }),
        ],
        border: {
            bottom: {
                style: BorderStyle.SINGLE,
                size,
                color: cleanColor,
            },
        },
        indent: {
            left: leftIndent > 2 ? pointsToTwips(leftIndent) : undefined,
            right: rightIndent > 2 ? pointsToTwips(rightIndent) : undefined,
        },
        spacing: {
            before: pointsToTwips(4),
            after: pointsToTwips(4),
            line: 20,
            lineRule: LineRuleType.EXACT,
        },
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
    const neuralFormulas = page.analysis?.neuralFormulas || [];

    (page.analysis?.paragraphs || []).forEach((paragraph) => {
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
                isInsideZone(group, header) ||
                isInsideZone(group, footer) ||
                (page.analysis?.tables || []).some((table) => isTextGroupInsideTable(group, table))
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

    const printableWidth = Math.max(100, page.dimensions.width - margins.left - margins.right);
    const complexTables = [];
    (page.analysis?.tables || []).forEach((table) => {
        if (isComplexFlowTable(table)) {
            // Las tablas realmente extremas conservan cuadrícula y geometría en
            // una placa limpia; sus líneas se añaden luego como texto editable.
            complexTables.push(table);
            return;
        }
        const element = createWordTable(table, {
            floating: false,
            leftMargin: margins.left,
            printableWidth,
        });
        if (element) {
            elements.push({
                type: "table",
                y: toNumber(table.bbox?.y),
                bbox: table.bbox,
                element,
            });
        }
    });

    // Si hay tablas ultra-complejas y existe una imagen de fondo limpia, añadirla
    // como placa detrás del contenido para preservar la estructura visual.
    if (complexTables.length && page.renderedPage && !page.review?.excludeImages) {
        floatingImages.unshift(
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

    const complexTableTextFrames = (page.content?.lines || [])
        .filter((line) => complexTables.some((table) => isTextGroupInsideTable(line, table)))
        .flatMap((line) => splitLineByComplexTableCells(line, complexTables))
        .filter((line) => complexTables.some((table) => isTextGroupInsideTable(line, table)))
        .flatMap((line) => splitLineByLargeMeasuredGaps(line))
        .map((line, index) => {
            const region = {
                id: `p${page.pageNumber}-flow-table-line-${index + 1}`,
                type: "text",
                bbox: line.bbox,
                text: line.text,
                words: line.words || [],
                lines: [line],
            };
            return createRotatedTextFrame(region) || createTextFrame(region, page);
        });


    (page.vectorObjects || []).forEach((shape) => {
        const bbox = shape.bbox || {};
        const isHorizontalLine =
            toNumber(bbox.height) <= 3.5 &&
            toNumber(bbox.width) >= 36 &&
            !(page.analysis?.tables || []).some((t) => boxOverlapRatio(t.bbox, bbox) > 0.25) &&
            !isInsideZone(shape, header) &&
            !isInsideZone(shape, footer);

        if (isHorizontalLine) {
            elements.push({
                type: "horizontal-rule",
                y: toNumber(bbox.y),
                bbox,
                element: createHorizontalRuleParagraph(shape, margins, page.dimensions.width),
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
        const fallbackLines = [
            ...(page.analysis?.lines || []),
            ...(page.content?.lines || []),
        ];
        fallbackLines.forEach((line) => {
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
    let previousBottom = toNumber(page.analysis?.spatial?.textBox?.y, margins.top);
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
            if (entry.type === "table" || entry.type === "horizontal-rule") {
                return entry.element;
            }
            return entry.element;
        })
        .filter(Boolean);
    const children = [
        ...floatingImages.filter(Boolean),
        ...complexTableTextFrames.filter(Boolean),
        ...flowChildren,
    ];

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
    // The PDF bbox and Word's exact line box do not share the same vertical
    // origin. Keep the visually calibrated value; OpenType ascent/descent and
    // lineGap are retained in the font resource for diagnostics, not applied
    // blindly to paragraph height.
    const orderedLines = [...(region.lines || [])].sort(
        (first, second) => toNumber(first.bbox?.y) - toNumber(second.bbox?.y)
    );
    const measuredAdvances = orderedLines.slice(1).map((line, index) =>
        toNumber(line.bbox?.y) - toNumber(orderedLines[index].bbox?.y)
    ).filter((advance) => advance > 0);
    const measuredLineAdvance = measuredAdvances.length
        ? median(measuredAdvances)
        : 0;
    const estimatedLineHeight = measuredLineAdvance > 0
        ? clamp(
            measuredLineAdvance,
            Math.max(7, (averageFontSize || 10) * 0.95),
            (averageFontSize || 10) * 2.1
        )
        : Math.max(7, (averageFontSize || 10) * 1.15);
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

    orderedLines.forEach((line, index) => {
        children.push(...createWordRuns(line.words || [], {
            firstBreak: index > 0,
            // En títulos, listas y rótulos la separación horizontal también
            // forma parte del diseño. Los párrafos justificados quedan a cargo
            // del motor de Word para evitar duplicar la expansión de espacios.
            // En un cuadro multilínea Word ya controla los espacios y la
            // justificación. Reinyectar separaciones PDF por palabra acumula
            // cientos de puntos cuando un proveedor usa coordenadas anidadas.
            preserveGaps:
                lineCount === 1 && alignment !== AlignmentType.JUSTIFIED,
            horizontalScale: nativeHorizontalScale,
            artworkContainsDecorations:
                page.renderedPage?.role === "clean-editable-background" &&
                !page.review?.excludeImages,
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
    const multiLineReserve = lineCount > 1
        ? Math.max(
            (averageFontSize || 10) * 2,
            toNumber(bbox.width) * 0.06
        )
        : 0;
    const horizontalReserve = alignment === AlignmentType.CENTER
        ? Math.max(8, singleLineReserve, multiLineReserve, toNumber(bbox.width) * 0.12)
        : Math.max(
            4,
            singleLineReserve,
            multiLineReserve,
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
    let baselineCompensation = clamp(
        (averageFontSize || 10) * 0.13 + (usesSmallQuicksand ? 1 : 0),
        1.2,
        4.2
    );
    const nativeBaselines = words.filter((word) => String(word.source || "").includes("native") &&
        Number.isFinite(word.baselineY)).map((word) => word.baselineY);
    const measuredAscent = average(nativeBaselines) - toNumber(bbox.y);
    if (lineCount === 1 && averageFontSize >= 30 && nativeBaselines.length === words.length &&
        embeddedFontFamilyFor(words[0]?.fontFamily || words[0]?.fontName) &&
        measuredAscent > 0 && measuredAscent < averageFontSize * 0.68 &&
        Math.max(...nativeBaselines) - Math.min(...nativeBaselines) < averageFontSize * 0.1) {
        // Deep-descender display fonts expose a PDF box far above/below their
        // true baseline. The Arial-sized 4.2 pt cap is inappropriate here.
        // Approximate the baseline in Word's exact line box (80% of its height)
        // only for this measured single-line case; ordinary text keeps its policy.
        baselineCompensation = Math.max(baselineCompensation, estimatedLineHeight * 0.8 - measuredAscent);
    }

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

const POSITIONED_TEXT_REGION_TYPES = new Set([
    "text",
    "heading",
    "list-item",
    "text-box",
    "caption",
    "footnote",
    "form-field",
]);

function positionedLineKey(line = {}) {
    const bbox = line.bbox || {};
    return [
        cleanText(line.text).toLocaleLowerCase("es"),
        Math.round(toNumber(bbox.x) * 2),
        Math.round(toNumber(bbox.y) * 2),
        Math.round(toNumber(bbox.width) * 2),
    ].join("|");
}

function positionedLinesBoundingBox(lines = []) {
    const valid = lines.filter((line) => line?.bbox);
    if (!valid.length) return { x: 0, y: 0, width: 0, height: 0 };
    const left = Math.min(...valid.map((line) => toNumber(line.bbox.x)));
    const top = Math.min(...valid.map((line) => toNumber(line.bbox.y)));
    const right = Math.max(
        ...valid.map((line) => toNumber(line.bbox.x) + toNumber(line.bbox.width))
    );
    const bottom = Math.max(
        ...valid.map((line) => toNumber(line.bbox.y) + toNumber(line.bbox.height))
    );
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function sourceLinesForPositionedRegion(region, pageLines = [], coveredLineKeys = new Set()) {
    const regionLineKeys = new Set((region.lines || []).map(positionedLineKey));
    const exact = pageLines.filter(
        (line) =>
            !coveredLineKeys.has(positionedLineKey(line)) &&
            regionLineKeys.has(positionedLineKey(line))
    );
    if (exact.length) return exact;

    const regionText = cleanText(region.text).toLocaleLowerCase("es");
    return pageLines.filter((line) => {
        if (coveredLineKeys.has(positionedLineKey(line))) return false;
        const text = cleanText(line.text).toLocaleLowerCase("es");
        return text && regionText.includes(text) &&
            boxOverlapRatio(region.bbox, line.bbox) >= 0.82;
    });
}

function canGroupPositionedLines(lines = []) {
    if (lines.length < 2 || lines.length > 24) return false;
    // Una lista mezcla sangrías (viñeta, rótulo y cuerpo). Word justificaría
    // las líneas con salto manual y separaría el rótulo hasta el margen derecho.
    // Mantenerlas como cuadros independientes conserva cada coordenada PDF.
    if (lines.some((line) => startsBullet(line.text))) return false;
    const ordered = [...lines].sort(
        (first, second) => toNumber(first.bbox?.y) - toNumber(second.bbox?.y)
    );
    const fontSizes = ordered.flatMap((line) => (line.words || [])
        .map((word) => toNumber(word.fontSize, word.height * 0.82))
        .filter((value) => value > 0));
    const typicalFontSize = median(fontSizes) || 10;
    if (
        fontSizes.length &&
        Math.max(...fontSizes) > Math.max(typicalFontSize * 1.45, typicalFontSize + 3)
    ) {
        return false;
    }

    const advances = ordered.slice(1).map((line, index) =>
        toNumber(line.bbox?.y) - toNumber(ordered[index].bbox?.y)
    );
    if (advances.some((advance) => advance <= 0 || advance > typicalFontSize * 2.15)) {
        return false;
    }
    const typicalAdvance = median(advances) || typicalFontSize * 1.15;
    if (
        advances.some(
            (advance) =>
                Math.abs(advance - typicalAdvance) > Math.max(2.25, typicalAdvance * 0.22)
        )
    ) {
        return false;
    }

    return ordered.every((line) => splitLineByLargeMeasuredGaps(line).length === 1);
}

function createPositionedRegionFrames(region, page) {
    const lines = (region.lines || []).filter((line) => cleanText(line.text));
    if (!lines.length) return [];
    if (canGroupPositionedLines(lines)) {
        const ordered = [...lines].sort(
            (first, second) => toNumber(first.bbox?.y) - toNumber(second.bbox?.y)
        );
        // Las líneas normalizadas siempre conservan coordenadas de página; las
        // palabras de algunos proveedores solo exponen `bbox` anidado. Usar
        // word.x/word.y en esos casos enviaba el párrafo a (0, 0), superponiendo
        // y ocultando bloques enteros en Word.
        const bbox = positionedLinesBoundingBox(ordered);
        return [createTextFrame({ ...region, lines: ordered, bbox }, page)];
    }
    return lines
        .flatMap((line) => splitLineByLargeMeasuredGaps(line))
        .map((line, index) => {
            const lineRegion = {
                ...region,
                id: `${region.id || `p${page.pageNumber}-region`}-line-${index + 1}`,
                bbox: line.bbox,
                text: line.text,
                words: line.words || [],
                lines: [line],
            };
            return createRotatedTextFrame(lineRegion) || createTextFrame(lineRegion, page);
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

function createLayeredFidelityPageChildren(page, { separateDocumentZones = false } = {}) {
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
        // Un fondo limpio puede ser necesario por máscaras, firmas o arte PDF;
        // eso no convierte automáticamente sus tablas en imágenes. Mantener la
        // cuadrícula nativa encima del fondo conserva selección de filas/celdas.
        const editableTables = pageTables.filter(
            (table) => !isComplexPositionedTable(table)
        );
        const complexTables = pageTables.filter(isComplexPositionedTable);
        const renderedTables = new Set();
        const renderedFormulas = new Set();
        const coveredLineKeys = new Set();
        const orderedRegions = [...(page.regionAnalysis?.regions || [])].sort(
            (first, second) =>
                toNumber(first.readingOrder, Number.MAX_SAFE_INTEGER) -
                    toNumber(second.readingOrder, Number.MAX_SAFE_INTEGER) ||
                toNumber(first.bbox?.y) - toNumber(second.bbox?.y) ||
                toNumber(first.bbox?.x) - toNumber(second.bbox?.x)
        );

        orderedRegions.forEach((region) => {
            if (
                (isInsideZone(region, header) &&
                    (separateDocumentZones || isZoneExcluded(page, "header"))) ||
                (isInsideZone(region, footer) &&
                    (separateDocumentZones || isZoneExcluded(page, "footer")))
            ) {
                return;
            }

            if (region.type === "table") {
                const sourceTable = editableTables.find(
                    (table) =>
                        table === region.content ||
                        boxOverlapRatio(table.bbox, region.bbox) >= 0.88
                );
                if (sourceTable && !renderedTables.has(sourceTable)) {
                    const element = createWordTable(sourceTable, { floating: true });
                    if (element) children.push(element);
                    renderedTables.add(sourceTable);
                }
                return;
            }

            if (region.type === "formula" && region.source === "neural-layout") {
                children.push(createFormulaFrame(region));
                renderedFormulas.add(region);
                return;
            }

            if (!POSITIONED_TEXT_REGION_TYPES.has(region.type)) return;
            const safeLines = sourceLinesForPositionedRegion(
                region,
                page.content?.lines || [],
                coveredLineKeys
            ).filter(
                (line) =>
                    !editableTables.some(
                        (table) => boxOverlapRatio(table.bbox, line.bbox) >= 0.55
                    ) &&
                    !formulaRegions.some(
                        (formula) => boxOverlapRatio(formula.bbox, line.bbox) >= 0.58
                    )
            );
            if (!safeLines.length) return;
            safeLines.forEach((line) => coveredLineKeys.add(positionedLineKey(line)));
            createPositionedRegionFrames({ ...region, lines: safeLines }, page)
                .filter(Boolean)
                .forEach((element) => children.push(element));
        });

        // Compatibilidad con proveedores que no hayan creado regiones para
        // todos los elementos. Se añaden por coordenadas y sin duplicar texto.
        editableTables
            .filter((table) => !renderedTables.has(table))
            .sort((first, second) => toNumber(first.bbox?.y) - toNumber(second.bbox?.y))
            .forEach((table) => {
                const element = createWordTable(table, { floating: true });
                if (element) children.push(element);
            });
        formulaRegions
            .filter((formula) => !renderedFormulas.has(formula))
            .forEach((region) => children.push(createFormulaFrame(region)));

        (page.content?.lines || [])
            .filter((line) => !coveredLineKeys.has(positionedLineKey(line)))
            .flatMap((line) => splitLineByComplexTableCells(line, complexTables))
            .flatMap((line) => splitLineByLargeMeasuredGaps(line))
            .forEach((line, index) => {
                const lineRegion = {
                    id: `p${page.pageNumber}-fixed-line-${index + 1}`,
                    type: "text",
                    bbox: line.bbox,
                    text: line.text,
                    words: line.words || [],
                    lines: [line],
                };
                if (
                    (isInsideZone(lineRegion, header) &&
                        (separateDocumentZones || isZoneExcluded(page, "header"))) ||
                    (isInsideZone(lineRegion, footer) &&
                        (separateDocumentZones || isZoneExcluded(page, "footer"))) ||
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

function createSection(page, mode, totalPages = 1) {
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
    const pageNumberStart = getSectionPageNumberStart(footer, page, totalPages);

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
                ...(pageNumberStart
                    ? { pageNumbers: { start: pageNumberStart } }
                    : {}),
            },
        },
        headers:
            effectiveMode === "editable" &&
            header &&
            !isZoneExcluded(page, "header") &&
            (!cleanText(page.review?.correctedText) || page.review?.wordCorrectionApplied)
                ? {
                    default: new Header({
                        children: createZoneParagraphs(header, page, margins, totalPages),
                    }),
                }
                : { default: new Header({ children: [new Paragraph({ children: [] })] }) },
        footers:
            effectiveMode === "editable" &&
            footer &&
            !isZoneExcluded(page, "footer") &&
            (!cleanText(page.review?.correctedText) || page.review?.wordCorrectionApplied)
                ? {
                    default: new Footer({
                        children: createZoneParagraphs(footer, page, margins, totalPages),
                    }),
                }
                : { default: new Footer({ children: [new Paragraph({ children: [] })] }) },
        children:
            effectiveMode === "visual"
                ? createFidelityPageChildren(page)
                : effectiveMode === "fidelity"
                  ? createLayeredFidelityPageChildren(page)
                  // Para modo editable:
                  // - "positioned": páginas de diseño gráfico (portadas, formularios vacíos,
                  //   páginas con pocas palabras) → texto con frames precisos superpuestos
                  // - "flow": páginas de texto/tablas digitales → párrafos fluidos y
                  //   tablas nativas Word via createWordTable({ floating: false })
                  : page.editableLayout === "positioned"
                    ? createLayeredFidelityPageChildren(page, {
                        separateDocumentZones: true,
                    })
                    : createEditablePageChildren(page),
    };
}

export async function renderWordDocument(model, onProgress) {
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    onProgress?.({ percent: 94, stage: "docx", detail: "Aplicando estilos y secciones…" });

    const embeddedFonts = globalThis.process?.env?.NOVAPDF_DISABLE_EMBEDDED_FONTS === "1"
        ? []
        : normalizeEmbeddedFontsForDocument(model.embeddedFonts);
    const transportedFonts = embeddedFonts.filter((font) => font.transportable);
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
            fonts: transportedFonts.map(({ transportName: name, data }) => ({ name, data })),
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
                .map((page) => createSection(page, model.mode, model.pages.length)),
        });
    } finally {
        activeEmbeddedFontFamilies = previousEmbeddedFontFamilies;
    }

    onProgress?.({ percent: 97, stage: "packing", detail: "Empaquetando el archivo DOCX…" });
    const packedBlob = await Packer.toBlob(document);
    const blob = await addEmbeddedFontFallbacks(packedBlob, transportedFonts);
    const finishedAt = globalThis.performance?.now?.() ?? Date.now();

    return {
        blob,
        generationMs: Math.round(finishedAt - startedAt),
    };
}

export function releaseWordDocumentResources(model) {
    let releasedBytes = 0;
    for (const page of model?.pages || []) {
        if (page.renderedPage?.data) {
            releasedBytes += page.renderedPage.data.byteLength || page.renderedPage.data.length || 0;
            page.renderedPage.data = null;
        }
        for (const image of page.images || []) {
            if (!image?.data) continue;
            releasedBytes += image.data.byteLength || image.data.length || 0;
            image.data = null;
        }
    }
    for (const font of model?.embeddedFonts || []) {
        if (!font?.data) continue;
        releasedBytes += font.data.byteLength || font.data.length || 0;
        font.data = null;
    }
    return releasedBytes;
}

// Exportado para pruebas unitarias del renderizado de tablas.
export function __normalizeTableRowsForTests(table) {
    return normalizeTableRows(table);
}

export function __groupParagraphLinesForTests(paragraph) {
    return groupParagraphLines(paragraph);
}

export const __planNativeCellLinesForTests = planNativeCellLines;
export const __dehyphenateLineWordsForTests = dehyphenateLineWords;
export const __startsNumberedListForTests = startsNumberedList;
export const __parsePageNumberPartsForTests = parsePageNumberParts;
