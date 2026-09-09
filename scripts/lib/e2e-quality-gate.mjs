import JSZip from "jszip";

import { calculateCER, calculateWER } from "../../src/engine/evaluation/EvaluationMetrics.js";

function cleanText(value) {
    return String(value ?? "")
        .normalize("NFC")
        .replace(/\s+/g, " ")
        .trim();
}

function decodeXml(value) {
    return String(value ?? "")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&amp;", "&");
}

function xmlText(xml) {
    return cleanText(
        [...String(xml || "").matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
            .map((match) => decodeXml(match[1]))
            .join(" ")
    );
}

function countMatches(value, expression) {
    return [...String(value || "").matchAll(expression)].length;
}

function characterInventory(value) {
    const inventory = new Map();
    for (const character of cleanText(value).toLocaleLowerCase("es").replace(/\s/g, "")) {
        inventory.set(character, (inventory.get(character) || 0) + 1);
    }
    return inventory;
}

export function createTextProfile(value) {
    const inventory = characterInventory(value);
    return {
        characters: [...inventory.values()].reduce((total, count) => total + count, 0),
        codePoints: Object.fromEntries(
            [...inventory.entries()].map(([character, count]) => [String(character.codePointAt(0)), count])
        ),
    };
}

function calculateProfileCoverage(reference = {}, candidate = {}) {
    const expected = reference.codePoints || {};
    const actual = candidate.codePoints || {};
    const referenceCharacters = Number(reference.characters) || 0;
    const missingCharacters = Object.entries(expected).reduce(
        (total, [codePoint, count]) => total + Math.max(0, Number(count) - Number(actual[codePoint] || 0)),
        0
    );
    return {
        referenceCharacters,
        missingCharacters,
        coverage: referenceCharacters
            ? Number((((referenceCharacters - missingCharacters) / referenceCharacters) * 100).toFixed(4))
            : 100,
    };
}

export function calculateCharacterCoverage(reference, candidate) {
    const expected = characterInventory(reference);
    const actual = characterInventory(candidate);
    let referenceCharacters = 0;
    let missingCharacters = 0;
    for (const [character, count] of expected) {
        referenceCharacters += count;
        missingCharacters += Math.max(0, count - (actual.get(character) || 0));
    }
    return {
        referenceCharacters,
        missingCharacters,
        coverage: referenceCharacters
            ? Number((((referenceCharacters - missingCharacters) / referenceCharacters) * 100).toFixed(4))
            : 100,
    };
}

export async function inspectDocx(buffer) {
    const archive = await JSZip.loadAsync(buffer);
    const documentXml = await archive.file("word/document.xml")?.async("string") || "";
    const fontTableXml = await archive.file("word/fontTable.xml")?.async("string") || "";
    const text = xmlText(documentXml);
    const cells = [...documentXml.matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)]
        .map((match) => xmlText(match[1]));
    const tableShapes = [...documentXml.matchAll(/<w:tbl(?:\s[^>]*)?>([\s\S]*?)<\/w:tbl>/g)]
        .map((match) => ({
            rows: countMatches(match[1], /<w:tr(?:\s[^>]*)?>/g),
            cells: countMatches(match[1], /<w:tc(?:\s[^>]*)?>/g),
        }));
    const fonts = new Set();
    for (const match of documentXml.matchAll(/w:(?:ascii|hAnsi|eastAsia|cs)="([^"]+)"/g)) {
        fonts.add(decodeXml(match[1]));
    }
    for (const match of fontTableXml.matchAll(/<w:font\s+w:name="([^"]+)"/g)) {
        fonts.add(decodeXml(match[1]));
    }
    const embeddedFontFiles = Object.keys(archive.files).filter(
        (name) => /^word\/fonts\//i.test(name) && !archive.files[name].dir
    );
    const mediaFiles = Object.keys(archive.files).filter(
        (name) => /^word\/media\//i.test(name) && !archive.files[name].dir
    );

    return {
        text,
        textProfile: createTextProfile(text),
        characters: Array.from(text).length,
        words: text ? text.split(/\s+/).length : 0,
        paragraphs: countMatches(documentXml, /<w:p(?:\s[^>]*)?>/g),
        tables: countMatches(documentXml, /<w:tbl(?:\s[^>]*)?>/g),
        tableShapes,
        cells: cells.length,
        nonEmptyCells: cells.filter(Boolean).length,
        sections: countMatches(documentXml, /<w:sectPr(?:\s[^>]*)?>/g),
        frames: countMatches(documentXml, /<w:framePr(?:\s[^>]*)?\/?\s*>/g),
        drawings: countMatches(documentXml, /<w:drawing(?:\s[^>]*)?>/g),
        images: mediaFiles.length,
        embeddedFonts: embeddedFontFiles.length,
        fontFamilies: [...fonts].sort((first, second) => first.localeCompare(second)),
    };
}

export function publicDocxMetrics(metrics) {
    const { text: _text, ...summary } = metrics;
    return summary;
}

export function compareText(referenceMetrics, candidateMetrics) {
    if (!referenceMetrics?.text && !referenceMetrics?.textProfile) return null;
    const hasPlainReference = Boolean(referenceMetrics.text);
    const cer = hasPlainReference
        ? calculateCER(referenceMetrics.text, candidateMetrics?.text || "")
        : null;
    const wer = hasPlainReference
        ? calculateWER(referenceMetrics.text, candidateMetrics?.text || "")
        : null;
    const referenceFonts = new Set(
        (referenceMetrics.fontFamilies || []).map((font) => String(font).toLocaleLowerCase("en"))
    );
    const candidateFonts = new Set(
        (candidateMetrics?.fontFamilies || []).map((font) => String(font).toLocaleLowerCase("en"))
    );
    const referenceShapes = (referenceMetrics.tableShapes || []).map(
        (table) => `${Number(table.rows) || 0}x${Number(table.cells) || 0}`
    );
    const remainingShapes = (candidateMetrics?.tableShapes || []).map(
        (table) => `${Number(table.rows) || 0}x${Number(table.cells) || 0}`
    );
    const exactTableShapeMatches = referenceShapes.reduce((matches, shape) => {
        const index = remainingShapes.indexOf(shape);
        if (index < 0) return matches;
        remainingShapes.splice(index, 1);
        return matches + 1;
    }, 0);
    const tableCellCoverage = referenceMetrics.cells
        ? Number((Math.min(1, (candidateMetrics?.cells || 0) / referenceMetrics.cells) * 100).toFixed(4))
        : 100;
    return {
        cerPercent: cer ? Number((cer.cer * 100).toFixed(4)) : null,
        werPercent: wer ? Number((wer.wer * 100).toFixed(4)) : null,
        characterCoverage: hasPlainReference
            ? calculateCharacterCoverage(referenceMetrics.text, candidateMetrics?.text || "")
            : calculateProfileCoverage(referenceMetrics.textProfile, candidateMetrics?.textProfile),
        tableCellCoverage,
        tableStructure: {
            referenceTables: referenceMetrics.tables || 0,
            candidateTables: candidateMetrics?.tables || 0,
            referenceCells: referenceMetrics.cells || 0,
            candidateCells: candidateMetrics?.cells || 0,
            cellCoverage: tableCellCoverage,
            exactShapeMatches: exactTableShapeMatches,
            exactShapeCoverage: referenceShapes.length
                ? Number(((exactTableShapeMatches / referenceShapes.length) * 100).toFixed(4))
                : 100,
        },
        fontCoverage: {
            referenceFamilies: referenceFonts.size,
            candidateFamilies: candidateFonts.size,
            matchedFamilies: [...referenceFonts].filter((font) => candidateFonts.has(font)).length,
            coverage: referenceFonts.size
                ? Number((([...referenceFonts].filter((font) => candidateFonts.has(font)).length /
                    referenceFonts.size) * 100).toFixed(4))
                : 100,
        },
    };
}

export function compareVisualPages(current, previous, maximumRegression = 0.25) {
    if (current?.status !== "completed" || previous?.status !== "completed") return [];
    const previousPages = new Map(
        (previous.pages || []).map((page) => [Number(page.sourcePageNumber), page])
    );
    return (current.pages || []).flatMap((page) => {
        const baseline = previousPages.get(Number(page.sourcePageNumber));
        if (!baseline) return [];
        const delta = Number((Number(page.visualScore) - Number(baseline.visualScore)).toFixed(4));
        return delta < -Math.abs(maximumRegression)
            ? [{ pageNumber: Number(page.sourcePageNumber), baseline: Number(baseline.visualScore), current: Number(page.visualScore), delta }]
            : [];
    });
}

export function evaluateQualityGate({
    currentVisual,
    previousVisual,
    currentDocx,
    previousDocx,
    thresholds = {},
}) {
    const limits = {
        maximumPageRegression: Number(thresholds.maximumPageRegression ?? 0.25),
        minimumTextCoverage: Number(thresholds.minimumTextCoverage ?? 99.9),
        minimumTableCellCoverage: Number(thresholds.minimumTableCellCoverage ?? 100),
        requirePageCountMatch: thresholds.requirePageCountMatch !== false,
        requireVisualValidation: thresholds.requireVisualValidation !== false,
    };
    const failures = [];
    if (limits.requireVisualValidation && currentVisual?.status !== "completed") {
        failures.push({
            code: "visual_validation_unavailable",
            status: currentVisual?.status || "missing",
            error: currentVisual?.error || null,
        });
    }
    if (limits.requireVisualValidation && previousVisual && previousVisual.status !== "completed") {
        failures.push({
            code: "visual_baseline_unavailable",
            status: previousVisual.status || "missing",
            error: previousVisual.error || null,
        });
    }
    if (limits.requirePageCountMatch && currentVisual?.status === "completed" && !currentVisual.pageCountMatch) {
        failures.push({ code: "page_count_changed", expected: currentVisual.sourcePageCount, actual: currentVisual.outputPageCount });
    }
    const pageRegressions = compareVisualPages(
        currentVisual,
        previousVisual,
        limits.maximumPageRegression
    );
    if (pageRegressions.length) failures.push({ code: "page_visual_regression", pages: pageRegressions });

    const textComparison = compareText(previousDocx, currentDocx);
    if (textComparison && textComparison.characterCoverage.coverage < limits.minimumTextCoverage) {
        failures.push({ code: "text_loss", ...textComparison.characterCoverage });
    }
    if (textComparison && textComparison.tableCellCoverage < limits.minimumTableCellCoverage) {
        failures.push({ code: "table_cell_loss", coverage: textComparison.tableCellCoverage });
    }
    return { passed: failures.length === 0, thresholds: limits, failures, textComparison, pageRegressions };
}
