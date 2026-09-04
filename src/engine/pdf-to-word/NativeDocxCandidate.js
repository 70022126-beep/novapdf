const DEFAULT_LAYOUT_ENDPOINT = "http://127.0.0.1:8765/v1/layout";

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
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

export function deriveNativeDocxEndpoint(endpoint = DEFAULT_LAYOUT_ENDPOINT) {
    if (!isLoopbackEndpoint(endpoint)) return null;
    return new URL("/v1/convert/native-docx", endpoint).toString();
}

export function isNativeDocxCandidateEligible(model = {}) {
    const pages = model.pages || [];
    if (model.options?.ocrMode === "always") return false;
    if (model.mode !== "editable" || !pages.length) return false;

    return pages.every((page) => {
        const pageType = page.pageType?.type || page.pageType || "digital";
        const tables = page.tables || page.analysis?.tables || [];
        const formulas = (page.regionAnalysis?.regions || []).filter(
            (region) => region.type === "formula"
        );
        const protectedRegions = (page.regionAnalysis?.regions || []).filter((region) =>
            ["signature", "stamp"].includes(region.type)
        );
        const nativeCoverage =
            (page.content?.words || []).filter((word) =>
                String(word.source || "").includes("native")
            ).length /
            Math.max(1, page.content?.words?.length || 0);

        // pdf2docx es excelente como candidato para documentos digitales de
        // texto, pero sus tablas combinadas pueden truncarse. Esas páginas se
        // mantienen en el reconstruidor regional de NovaPDF.
        return (
            pageType === "digital" &&
            number(page.pageType?.confidence, 100) >= 80 &&
            tables.length === 0 &&
            formulas.length === 0 &&
            protectedRegions.length === 0 &&
            nativeCoverage >= 0.72
        );
    });
}

export function shouldApplyNativeDocxCandidate(
    currentQuality,
    candidateQuality,
    { minimumGain = 1, maximumPageRegression = 2 } = {}
) {
    if (candidateQuality?.status !== "completed") return false;
    if (currentQuality?.status !== "completed") return true;
    if (!candidateQuality.pageCountMatch) return false;
    if (
        number(candidateQuality.visualScore) <
        number(currentQuality.visualScore) + Math.max(0, number(minimumGain, 1))
    ) {
        return false;
    }

    const currentPages = new Map(
        (currentQuality.pages || []).map((page) => [number(page.sourcePageNumber), page])
    );
    return (candidateQuality.pages || []).every((page) => {
        const current = currentPages.get(number(page.sourcePageNumber));
        if (!current) return true;
        const regression = number(current.visualScore) - number(page.visualScore);
        const introducedGeometryError =
            !(current.issues || []).includes("page_geometry_changed") &&
            (page.issues || []).includes("page_geometry_changed");
        return regression <= Math.max(0, number(maximumPageRegression, 2)) &&
            !introducedGeometryError;
    });
}

export async function convertWithNativeDocxCandidate(
    sourcePDF,
    {
        pageNumbers = [],
        endpoint = DEFAULT_LAYOUT_ENDPOINT,
        signal,
        timeoutMs = 210_000,
    } = {}
) {
    const candidateEndpoint = deriveNativeDocxEndpoint(endpoint);
    if (!sourcePDF || !candidateEndpoint) {
        throw new Error("El candidato DOCX nativo no esta configurado.");
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    try {
        const form = new FormData();
        form.append("pdf", sourcePDF, sourcePDF.name || "source.pdf");
        form.append("pages", pageNumbers.length ? pageNumbers.join(",") : "all");
        const response = await fetch(candidateEndpoint, {
            method: "POST",
            body: form,
            headers: { Accept: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
            signal: controller.signal,
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.detail || `El candidato DOCX respondio ${response.status}.`);
        }
        const blob = await response.blob();
        if (!blob.size) throw new Error("El candidato DOCX devolvio un archivo vacio.");
        const finishedAt = globalThis.performance?.now?.() ?? Date.now();
        return {
            blob,
            generationMs: Math.max(
                0,
                number(response.headers.get("X-NovaPDF-Duration-Ms"), finishedAt - startedAt)
            ),
            provider: response.headers.get("X-NovaPDF-Converter") || "pdf2docx",
            providerVersion: response.headers.get("X-NovaPDF-Converter-Version") || null,
        };
    } catch (error) {
        if (signal?.aborted) throw new DOMException("Conversion cancelada.", "AbortError");
        if (error?.name === "AbortError") {
            throw new Error("El candidato DOCX excedio el tiempo permitido.", {
                cause: error,
            });
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}
