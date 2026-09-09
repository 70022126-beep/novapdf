import { authorizedLocalFetch } from "../service/LocalServiceSession.js";

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

export function deriveNativeBackgroundEndpoint(endpoint = DEFAULT_LAYOUT_ENDPOINT) {
    if (!isLoopbackEndpoint(endpoint)) return null;
    return new URL("/v1/native-background", endpoint).toString();
}

export function deriveDocumentRegistryEndpoint(endpoint = DEFAULT_LAYOUT_ENDPOINT) {
    if (!isLoopbackEndpoint(endpoint)) return null;
    return new URL("/v1/documents", endpoint).toString();
}

export async function registerNativeDocument(
    file,
    {
        endpoint = DEFAULT_LAYOUT_ENDPOINT,
        timeoutMs = 60_000,
        signal,
    } = {}
) {
    const registryEndpoint = deriveDocumentRegistryEndpoint(endpoint);
    if (!registryEndpoint) {
        throw new Error("El PDF solo puede registrarse en este equipo.");
    }
    if (!file) throw new Error("Falta el PDF que se debe registrar.");

    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    try {
        const body = new FormData();
        body.append("pdf", file, file.name || "document.pdf");
        const response = await authorizedLocalFetch(registryEndpoint, {
            method: "POST",
            body,
            signal: controller.signal,
        });
        if (!response.ok) {
            let detail = `El registro del PDF respondió ${response.status}.`;
            try {
                detail = (await response.json()).detail || detail;
            } catch {
                // El proxy local puede devolver un cuerpo sin JSON.
            }
            throw new Error(detail);
        }
        const payload = await response.json();
        if (!payload.document_id) throw new Error("El servicio no devolvió un id de documento.");
        return {
            documentId: payload.document_id,
            pageCount: number(payload.page_count),
            sizeBytes: number(payload.size_bytes),
            reused: payload.reused === true,
            expiresAt: number(payload.expires_at),
            version: payload.version || null,
        };
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}

export async function fetchNativeCleanBackground(
    file,
    {
        pageNumber,
        endpoint = DEFAULT_LAYOUT_ENDPOINT,
        dpi = 144,
        paddingPoints = 1.25,
        timeoutMs = 45_000,
        signal,
        documentId,
    } = {}
) {
    const registryEndpoint = deriveDocumentRegistryEndpoint(endpoint);
    const backgroundEndpoint = documentId && registryEndpoint
        ? `${registryEndpoint}/${encodeURIComponent(documentId)}/native-background`
        : deriveNativeBackgroundEndpoint(endpoint);
    if (!backgroundEndpoint) {
        throw new Error("El fondo nativo debe generarse en este equipo.");
    }
    if ((!file && !documentId) || !Number.isInteger(Number(pageNumber)) || Number(pageNumber) < 1) {
        throw new Error("Falta una página válida para generar el fondo.");
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    try {
        const body = new FormData();
        if (!documentId) body.append("pdf", file, file.name || "document.pdf");
        body.append("page", String(pageNumber));
        body.append("dpi", String(Math.round(number(dpi, 144))));
        body.append("padding_points", String(number(paddingPoints, 1.25)));
        const response = await authorizedLocalFetch(backgroundEndpoint, {
            method: "POST",
            body,
            signal: controller.signal,
        });
        if (!response.ok) {
            let detail = `El fondo nativo respondió ${response.status}.`;
            try {
                const payload = await response.json();
                detail = payload.detail || detail;
            } catch {
                // El cuerpo puede no ser JSON en errores del proxy local.
            }
            throw new Error(detail);
        }
        const data = new Uint8Array(await response.arrayBuffer());
        if (!data.length) throw new Error("El servicio devolvió un fondo vacío.");
        return {
            data,
            type: "png",
            width: number(response.headers.get("X-NovaPDF-Page-Width")),
            height: number(response.headers.get("X-NovaPDF-Page-Height")),
            pixelWidth: number(response.headers.get("X-NovaPDF-Pixel-Width")),
            pixelHeight: number(response.headers.get("X-NovaPDF-Pixel-Height")),
            removedWordCount: number(response.headers.get("X-NovaPDF-Removed-Words")),
            maskedPixelRatio: number(response.headers.get("X-NovaPDF-Masked-Ratio")),
            strategy:
                response.headers.get("X-NovaPDF-Background-Strategy") ||
                "pdf-object-redaction",
            role: "clean-editable-background",
            provider: "native-local-clean-plate",
        };
    } catch (error) {
        if (signal?.aborted) {
            throw new DOMException("Conversión cancelada.", "AbortError");
        }
        if (error?.name === "AbortError") {
            throw new Error("La generación del fondo excedió el tiempo permitido.", {
                cause: error,
            });
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}
