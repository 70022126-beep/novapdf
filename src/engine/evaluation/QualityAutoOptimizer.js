const DEFAULT_RETRY_THRESHOLD = 70;
const DEFAULT_MAXIMUM_RETRY_PAGES = 32;
const DEFAULT_MINIMUM_PAGE_GAIN = 0.75;
const DEFAULT_MAXIMUM_PAGE_REGRESSION = 0.25;

const RETRYABLE_ISSUES = new Set([
    "page_geometry_changed",
    "content_shift",
    "low_content_overlap",
    "layout_mismatch",
]);

const ISSUE_WEIGHTS = {
    page_geometry_changed: 5,
    content_shift: 6,
    low_content_overlap: 9,
    layout_mismatch: 8,
};

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function pageType(page = {}) {
    return page.pageType?.type || page.pageType || "digital";
}

function qualityPagesBySource(report = {}) {
    return new Map(
        (report.pages || []).map((page) => [number(page.sourcePageNumber), page])
    );
}

function issuePenalty(page = {}) {
    return (page.issues || []).reduce(
        (total, issue) => total + (ISSUE_WEIGHTS[issue] || 1),
        0
    );
}

function retryPriority(page, qualityPage, threshold) {
    const issues = new Set(qualityPage.issues || []);
    const typeBonus = pageType(page) === "scanned" ? 20 : pageType(page) === "hybrid" ? 12 : 0;
    return (
        Math.max(0, threshold - number(qualityPage.visualScore)) +
        typeBonus +
        (issues.has("low_content_overlap") ? 12 : 0) +
        (issues.has("layout_mismatch") ? 8 : 0) +
        (issues.has("content_shift") ? 5 : 0) +
        (issues.has("page_geometry_changed") ? 4 : 0)
    );
}

export function selectPagesForQualityRetry(
    model,
    visualQuality,
    {
        threshold = DEFAULT_RETRY_THRESHOLD,
        maximumPages = DEFAULT_MAXIMUM_RETRY_PAGES,
    } = {}
) {
    if (
        !model?.pages?.length ||
        model.mode !== "editable" ||
        visualQuality?.status !== "completed" ||
        visualQuality.passed
    ) {
        return [];
    }

    const pages = new Map(model.pages.map((page) => [number(page.pageNumber), page]));
    return (visualQuality.pages || [])
        .map((qualityPage) => {
            const pageNumber = number(qualityPage.sourcePageNumber);
            const page = pages.get(pageNumber);
            if (
                !page ||
                page.review?.strategy === "visual"
            ) {
                return null;
            }
            const needsRetry =
                number(qualityPage.visualScore) < threshold ||
                (qualityPage.issues || []).some((issue) => RETRYABLE_ISSUES.has(issue));
            if (!needsRetry) return null;
            return {
                pageNumber,
                priority: retryPriority(page, qualityPage, threshold),
            };
        })
        .filter(Boolean)
        .sort((first, second) => second.priority - first.priority || first.pageNumber - second.pageNumber)
        .slice(0, Math.max(0, number(maximumPages, DEFAULT_MAXIMUM_RETRY_PAGES)))
        .map((item) => item.pageNumber);
}

/**
 * Decide página por página si la segunda pasada merece sustituir al resultado
 * editable original. Esto evita que una mejora fuerte oculte regresiones en
 * otras páginas del mismo documento.
 */
export function evaluateQualityRetryPages(
    initialQuality,
    candidateQuality,
    pageNumbers = [],
    {
        minimumGain = DEFAULT_MINIMUM_PAGE_GAIN,
        maximumRegression = DEFAULT_MAXIMUM_PAGE_REGRESSION,
    } = {}
) {
    const initialPages = qualityPagesBySource(initialQuality);
    const candidatePages = qualityPagesBySource(candidateQuality);
    const candidateAvailable = candidateQuality?.status === "completed";

    return [...new Set(pageNumbers.map(Number).filter(Number.isFinite))].map(
        (pageNumber) => {
            const beforePage = initialPages.get(pageNumber);
            const afterPage = candidatePages.get(pageNumber);
            const scoreBefore = beforePage ? number(beforePage.visualScore) : null;
            const scoreAfter = afterPage ? number(afterPage.visualScore) : null;
            const gain = scoreBefore === null || scoreAfter === null
                ? null
                : Number((scoreAfter - scoreBefore).toFixed(2));
            const issuesBefore = beforePage?.issues || [];
            const issuesAfter = afterPage?.issues || [];
            const penaltyBefore = issuePenalty(beforePage);
            const penaltyAfter = issuePenalty(afterPage);

            let accepted = false;
            let reason = "quality-page-unavailable";
            if (candidateAvailable && afterPage && !beforePage) {
                accepted = true;
                reason = "page-recovered";
            } else if (candidateAvailable && beforePage && afterPage) {
                if (gain >= Math.max(0, number(minimumGain, DEFAULT_MINIMUM_PAGE_GAIN))) {
                    accepted = true;
                    reason = "score-improved";
                } else if (
                    penaltyAfter < penaltyBefore &&
                    gain >= -Math.max(
                        0,
                        number(maximumRegression, DEFAULT_MAXIMUM_PAGE_REGRESSION)
                    )
                ) {
                    accepted = true;
                    reason = "issues-resolved";
                } else {
                    reason = gain < 0 ? "page-regressed" : "gain-insufficient";
                }
            }

            return {
                pageNumber,
                accepted,
                reason,
                scoreBefore,
                scoreAfter,
                gain,
                issuesBefore,
                issuesAfter,
            };
        }
    );
}

export function mergeQualityRetryPages(model, retryModel, pageNumbers = []) {
    const selected = new Set(pageNumbers.map(Number));
    const retryPages = new Map(
        (retryModel?.pages || []).map((page) => [number(page.pageNumber), page])
    );
    return {
        ...model,
        pages: model.pages.map((originalPage) => {
            const pageNumber = number(originalPage.pageNumber);
            const retryPage = retryPages.get(pageNumber);
            if (!selected.has(pageNumber) || !retryPage) return originalPage;
            return {
                ...retryPage,
                review: {
                    ...(retryPage.review || {}),
                    ...(originalPage.review || {}),
                    strategy: "fidelity",
                    qualityRetry: true,
                },
                metrics: {
                    ...(retryPage.metrics || {}),
                    qualityRetry: true,
                },
            };
        }),
    };
}

export function shouldApplyQualityRetry(initialQuality, candidateQuality, minimumGain = 1) {
    if (candidateQuality?.status !== "completed") return false;
    if (initialQuality?.status !== "completed") return true;
    if (!initialQuality.pageCountMatch && candidateQuality.pageCountMatch) return true;
    if (initialQuality.pageCountMatch && !candidateQuality.pageCountMatch) return false;
    return (
        number(candidateQuality.visualScore) >=
        number(initialQuality.visualScore) + Math.max(0, number(minimumGain, 1))
    );
}

export function buildQualityOptimizationReport({
    enabled,
    attempted = false,
    applied = false,
    pages = [],
    pageDecisions = [],
    initialQuality,
    candidateQuality,
    durationMs = 0,
    reason = null,
} = {}) {
    const normalizedPages = pages.map(Number).filter(Number.isFinite);
    const acceptedPages = pageDecisions
        .filter((decision) => decision.accepted)
        .map((decision) => number(decision.pageNumber));
    const rejectedPages = pageDecisions
        .filter((decision) => !decision.accepted)
        .map((decision) => number(decision.pageNumber));
    return {
        enabled: Boolean(enabled),
        attempted: Boolean(attempted),
        applied: Boolean(applied),
        pages: normalizedPages,
        acceptedPages,
        rejectedPages,
        pageDecisions,
        scoreBefore: number(initialQuality?.visualScore),
        scoreAfter: number(
            applied ? candidateQuality?.visualScore : initialQuality?.visualScore
        ),
        candidateScore: candidateQuality?.status === "completed"
            ? number(candidateQuality.visualScore)
            : null,
        durationMs: number(durationMs),
        reason,
    };
}
