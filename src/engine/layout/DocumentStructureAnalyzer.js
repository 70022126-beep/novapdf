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

export function analyzeDocumentStructure(pages = []) {
    const chapters = detectChapters(pages);
    const paragraphContinuations = detectParagraphContinuations(pages);
    const tableContinuations = detectTableContinuations(pages);
    const regionTypes = countRegionTypes(pages);

    return {
        pageCount: pages.length,
        chapters,
        paragraphContinuations,
        tableContinuations,
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

