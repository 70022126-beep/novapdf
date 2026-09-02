export async function extractNativeDocumentInBatches(
    file,
    pages,
    extractBatch,
    { batchSize = 100, signal, onBatch } = {}
) {
    const uniquePages = [...new Set((pages || []).map(Number).filter(Number.isFinite))];
    const merged = {
        provider: null,
        version: null,
        pageCount: 0,
        pages: new Map(),
        embeddedFonts: [],
        errors: [],
    };
    const fontIds = new Set();
    const size = Math.max(1, Math.floor(Number(batchSize) || 100));

    for (let offset = 0; offset < uniquePages.length; offset += size) {
        if (signal?.aborted) throw new DOMException("Conversion cancelada.", "AbortError");
        const batch = uniquePages.slice(offset, offset + size);
        onBatch?.({ completed: offset, total: uniquePages.length, batch });
        const result = await extractBatch(file, batch, {
            includeFonts: offset === 0,
            batchIndex: Math.floor(offset / size),
        });
        if (result) {
            merged.provider ||= result.provider;
            merged.version ||= result.version;
            merged.pageCount = Math.max(merged.pageCount, Number(result.pageCount) || 0);
            for (const [pageNumber, page] of result.pages || []) {
                merged.pages.set(Number(pageNumber), page);
            }
            for (const font of result.embeddedFonts || []) {
                const id = font.id || `${font.name}:${font.data?.length || 0}`;
                if (fontIds.has(id)) continue;
                fontIds.add(id);
                merged.embeddedFonts.push(font);
            }
            if (result.error) merged.errors.push(result.error);
        }
    }
    onBatch?.({ completed: uniquePages.length, total: uniquePages.length, batch: [] });
    if (merged.errors.length) merged.error = merged.errors.join(" | ");
    return merged;
}
