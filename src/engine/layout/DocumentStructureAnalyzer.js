function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
    return cleanText(value)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\d+/g, "#")
        .replace(/[^a-z0-9#]+/gi, " ")
        .trim()
        .toLowerCase();
}

function firstTextRegion(page) {
    return page.regionAnalysis?.regions.find((region) =>
        ["text", "heading", "list-item", "text-box"].includes(region.type)
    );
}

function lastTextRegion(page) {
    return [...(page.regionAnalysis?.regions || [])]
        .reverse()
        .find((region) => ["text", "list-item", "text-box"].includes(region.type));
}

function headersMatch(first, second) {
    const firstHeaders = first?.content?.headers || first?.content?.rows?.[0] || [];
    const secondHeaders = second?.content?.headers || second?.content?.rows?.[0] || [];
    if (!firstHeaders.length || firstHeaders.length !== secondHeaders.length) {
        return false;
    }

    return firstHeaders.every(
        (value, index) => normalizeText(value) === normalizeText(secondHeaders[index])
    );
}

function detectTableContinuations(pages) {
    const continuations = [];

    for (let index = 0; index < pages.length - 1; index += 1) {
        const currentTables = (pages[index].regionAnalysis?.regions || []).filter(
            (region) => region.type === "table"
        );
        const nextTables = (pages[index + 1].regionAnalysis?.regions || []).filter(
            (region) => region.type === "table"
        );
        const current = currentTables[currentTables.length - 1];
        const next = nextTables[0];

        if (!current || !next || !headersMatch(current, next)) {
            continue;
        }

        const continuationId = `table-flow-${continuations.length + 1}`;
        current.continuationId = continuationId;
        current.continuesOnPage = pages[index + 1].pageNumber;
        next.continuationId = continuationId;
        next.continuedFromPage = pages[index].pageNumber;
        continuations.push({
            id: continuationId,
            fromPage: pages[index].pageNumber,
            toPage: pages[index + 1].pageNumber,
        });
    }

    return continuations;
}

function detectParagraphContinuations(pages) {
    const continuations = [];

    for (let index = 0; index < pages.length - 1; index += 1) {
        const current = lastTextRegion(pages[index]);
        const next = firstTextRegion(pages[index + 1]);
        if (!current || !next) {
            continue;
        }

        const currentText = cleanText(current.text);
        const nextText = cleanText(next.text);
        const currentLooksOpen =
            currentText.endsWith("-") ||
            (currentText.length > 50 && !/[.!?:;»”)]$/.test(currentText));
        const nextLooksContinuous = /^[a-záéíóúüñ(]/.test(nextText);

        if (!currentLooksOpen || !nextLooksContinuous) {
            continue;
        }

        const continuationId = `paragraph-flow-${continuations.length + 1}`;
        current.continuationId = continuationId;
        current.continuesOnPage = pages[index + 1].pageNumber;
        next.continuationId = continuationId;
        next.continuedFromPage = pages[index].pageNumber;
        continuations.push({
            id: continuationId,
            fromPage: pages[index].pageNumber,
            toPage: pages[index + 1].pageNumber,
            joinedText: `${currentText.replace(/-$/, "")}${
                currentText.endsWith("-") ? "" : " "
            }${nextText}`,
        });
    }

    return continuations;
}

function detectChapters(pages) {
    const chapters = [];

    pages.forEach((page) => {
        (page.regionAnalysis?.regions || [])
            .filter((region) => region.type === "heading")
            .forEach((region) => {
                const text = cleanText(region.text);
                const explicitChapter = /^(?:cap[ií]tulo|secci[oó]n|anexo)\s+([\divxlcdm.-]+)/i.exec(
                    text
                );
                const level = explicitChapter
                    ? 1
                    : region.bbox.width > page.dimensions.width * 0.55
                      ? 1
                      : 2;
                region.headingLevel = level;
                chapters.push({
                    id: `chapter-${chapters.length + 1}`,
                    pageNumber: page.pageNumber,
                    regionId: region.id,
                    title: text,
                    level,
                });
            });
    });

    return chapters;
}

function countRegionTypes(pages) {
    return pages.reduce((totals, page) => {
        Object.entries(page.regionAnalysis?.counts || {}).forEach(([type, count]) => {
            totals[type] = (totals[type] || 0) + count;
        });
        return totals;
    }, {});
}

function detectRepeatingHeadersAndFooters(pages = []) {
    if (!pages?.length) {
        return {
            hasRunningHeader: false,
            runningHeader: null,
            hasRunningFooter: false,
            runningFooter: null,
            hasPageNumbers: false,
            pageNumberZone: null,
            detectedPageNumbers: [],
        };
    }

    const headerFrequencies = new Map();
    const footerFrequencies = new Map();
    const pageNumberCandidates = [];

    const PAGE_NUM_PATTERN = /^(?:p[aá]g(?:ina)?\.?\s*)?(\d{1,4})(?:\s*(?:\/|de)\s*(\d{1,4}))?$/i;
    const ENCLOSED_PATTERN = /^[-–—]\s*(\d{1,4})\s*[-–—]$/;

    pages.forEach((page) => {
        const pageHeight = page.dimensions?.height || 842;
        const zones = page.analysis?.zones || [];
        const headerZone = zones.find((z) => z.type === "header");
        const footerZone = zones.find((z) => z.type === "footer");

        const headerLines = headerZone?.lines ||
            (page.regionAnalysis?.regions || [])
                .filter((r) => r.bbox && (r.bbox.y <= pageHeight * 0.15))
                .flatMap((r) => r.lines || []);

        if (headerLines.length) {
            const hText = headerLines.map((l) => cleanText(l.text)).filter(Boolean).join(" ");
            const hSig = normalizeText(hText);
            if (hSig) {
                headerFrequencies.set(hSig, {
                    count: (headerFrequencies.get(hSig)?.count || 0) + 1,
                    rawText: hText,
                });
            }
        }

        const footerLines = footerZone?.lines ||
            (page.regionAnalysis?.regions || [])
                .filter((r) => r.bbox && (r.bbox.y >= pageHeight * 0.85))
                .flatMap((r) => r.lines || []);

        if (footerLines.length) {
            const fText = footerLines.map((l) => cleanText(l.text)).filter(Boolean).join(" ");
            const fSig = normalizeText(fText);
            if (fSig) {
                footerFrequencies.set(fSig, {
                    count: (footerFrequencies.get(fSig)?.count || 0) + 1,
                    rawText: fText,
                });
            }

            footerLines.forEach((line) => {
                const text = cleanText(line.text);
                const match = PAGE_NUM_PATTERN.exec(text) || ENCLOSED_PATTERN.exec(text);
                if (match) {
                    pageNumberCandidates.push({
                        pageNumber: page.pageNumber,
                        parsedNumber: Number(match[1]),
                        zone: "footer",
                        rawText: text,
                    });
                }
            });
        }
    });

    const threshold = Math.max(2, Math.ceil(pages.length * 0.25));
    const dominantHeader = [...headerFrequencies.values()].find((item) => item.count >= threshold);
    const dominantFooter = [...footerFrequencies.values()].find((item) => item.count >= threshold);
    const hasMonotonicPageNumbers = pageNumberCandidates.length >= 2 &&
        pageNumberCandidates.every((c, i) => i === 0 || c.parsedNumber >= pageNumberCandidates[i - 1].parsedNumber);

    return {
        hasRunningHeader: Boolean(dominantHeader),
        runningHeader: dominantHeader?.rawText || null,
        hasRunningFooter: Boolean(dominantFooter),
        runningFooter: dominantFooter?.rawText || null,
        hasPageNumbers: Boolean(hasMonotonicPageNumbers || pageNumberCandidates.length >= 2),
        pageNumberZone: pageNumberCandidates.length ? "footer" : null,
        detectedPageNumbers: pageNumberCandidates,
    };
}

export { detectRepeatingHeadersAndFooters };

export function analyzeDocumentStructure(pages = []) {
    const chapters = detectChapters(pages);
    const paragraphContinuations = detectParagraphContinuations(pages);
    const tableContinuations = detectTableContinuations(pages);
    const regionTypes = countRegionTypes(pages);
    const repeatingHeadersAndFooters = detectRepeatingHeadersAndFooters(pages);

    return {
        pageCount: pages.length,
        chapters,
        paragraphContinuations,
        tableContinuations,
        repeatingHeadersAndFooters,
        regionTypes,
        lowConfidenceRegions: pages.reduce(
            (total, page) =>
                total + (page.regionAnalysis?.lowConfidenceRegions || 0),
            0
        ),
        hasMixedLayout: pages.some(
            (page) => (page.regionAnalysis?.columnCount || 1) > 1
        ),
    };
}

