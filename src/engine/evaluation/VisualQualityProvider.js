const DEFAULT_LAYOUT_ENDPOINT = "http://127.0.0.1:8765/v1/layout";

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isLoopbackEndpoint(endpoint) {
    try {
        const url = new URL(endpoint);
        return (
            ["http:", "https:"].includes(url.protocol) &&
            ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
        );
    } catch {
        return false;
    }
}

export function deriveVisualQualityEndpoint(endpoint = DEFAULT_LAYOUT_ENDPOINT) {
    if (!isLoopbackEndpoint(endpoint)) return null;
    return new URL("/v1/quality/docx", endpoint).toString();
}

export function normalizeVisualQualityReport(payload = {}) {
    const status = payload.status === "completed" ? "completed" : "unavailable";
    return {
        status,
        provider: payload.renderer || "libreoffice",
        providerVersion: cleanText(payload.renderer_version) || null,
        serviceVersion: cleanText(payload.version) || null,
        visualScore: Math.min(100, Math.max(0, number(payload.visual_score))),
        targetScore: Math.min(100, Math.max(0, number(payload.target_score, 85))),
        passed: Boolean(payload.passed),
        pageCountMatch: Boolean(payload.page_count_match),
        sourcePageCount: number(payload.source_page_count),
        outputPageCount: number(payload.output_page_count),
        comparedPageCount: number(payload.compared_page_count),
        dpi: number(payload.dpi),
        durationMs: number(payload.duration_ms),
        issues: (payload.issues || []).map(cleanText).filter(Boolean),
        pages: (payload.pages || []).map((page) => ({
            sourcePageNumber: number(page.source_page_number),
            outputPageNumber: number(page.output_page_number),
            visualScore: number(page.visual_score),
            pixelSimilarity: number(page.pixel_similarity),
            inkOverlap: number(page.ink_overlap),
            edgeSimilarity: number(page.edge_similarity),
            horizontalShiftPoints: number(page.horizontal_shift_points),
            verticalShiftPoints: number(page.vertical_shift_points),
            aspectRatioDelta: number(page.aspect_ratio_delta),
            issues: (page.issues || []).map(cleanText).filter(Boolean),
        })),
        error: cleanText(payload.error) || null,
    };
}

export async function validateRenderedWordDocument(
    sourcePDF,
    docxBlob,
    {
        pageNumbers = [],
        endpoint = DEFAULT_LAYOUT_ENDPOINT,
        signal,
        dpi = 120,
        timeoutMs = 210_000,
    } = {}
) {
    const qualityEndpoint = deriveVisualQualityEndpoint(endpoint);
    if (!sourcePDF || !docxBlob || !qualityEndpoint) {
        return normalizeVisualQualityReport({
            error: "La validacion visual local no esta configurada.",
        });
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    try {
        const form = new FormData();
        form.append("pdf", sourcePDF, sourcePDF.name || "source.pdf");
        form.append("docx", docxBlob, "novapdf-output.docx");
        form.append("pages", pageNumbers.length ? pageNumbers.join(",") : "all");
        form.append("dpi", String(dpi));
        const response = await fetch(qualityEndpoint, {
            method: "POST",
            body: form,
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            return normalizeVisualQualityReport({
                error:
                    cleanText(payload.detail) ||
                    `El validador visual respondio ${response.status}.`,
            });
        }
        return normalizeVisualQualityReport(await response.json());
    } catch (error) {
        if (signal?.aborted) {
            throw new DOMException("Conversion cancelada.", "AbortError");
        }
        return normalizeVisualQualityReport({
            error:
                error?.name === "AbortError"
                    ? "La validacion visual excedio el tiempo permitido."
                    : error?.message || "El validador visual local no esta disponible.",
        });
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}
