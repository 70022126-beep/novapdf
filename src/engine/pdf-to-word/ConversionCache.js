const entries = new Map();
let totalBytes = 0;

function estimatePageBytes(page) {
    const imageBytes = (page.images || []).reduce(
        (total, image) => total + (image.data?.byteLength || 0),
        0
    );
    const renderedBytes = page.renderedPage?.data?.byteLength || 0;
    const wordBytes = (page.content?.words?.length || 0) * 240;
    return imageBytes + renderedBytes + wordBytes + 16_384;
}

export function createFileSignature(file) {
    return [file?.name, file?.size, file?.lastModified].join(":");
}

export function createPageCacheKey(file, pageNumber, options = {}) {
    return [
        createFileSignature(file),
        pageNumber,
        options.mode || "editable",
        options.ocrMode || "auto",
        JSON.stringify(options.ocrDictionary || []),
        options.experimentalHandwriting === true ? "handwriting" : "printed",
        options.maximumCanvasMegapixels || 20,
        options.ocrLanguage || "auto",
        options.extractImages !== false ? "images" : "no-images",
        options.advancedVision !== false ? "advanced-vision" : "basic-vision",
        options.cleanEditableBackground !== false ? "clean-background" : "plain-background",
        options.visionProvider || "auto",
        options.visionEndpoint || "local-default",
        options.visionVersion || "vision-v1",
    ].join("|");
}

export function getCachedPage(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    entries.set(key, { ...entry, lastAccess: Date.now() });
    return entry.page;
}

export function setCachedPage(key, page, maximumBytes = 96 * 1024 * 1024) {
    const size = estimatePageBytes(page);
    if (size > maximumBytes * 0.45) return;

    if (entries.has(key)) {
        totalBytes -= entries.get(key).size;
        entries.delete(key);
    }

    entries.set(key, { page, size, lastAccess: Date.now() });
    totalBytes += size;

    while (totalBytes > maximumBytes && entries.size) {
        const oldestKey = entries.keys().next().value;
        totalBytes -= entries.get(oldestKey).size;
        entries.delete(oldestKey);
    }
}

export function clearConversionCache(file) {
    const signature = file ? createFileSignature(file) : null;
    for (const [key, entry] of entries) {
        if (!signature || key.startsWith(signature)) {
            totalBytes -= entry.size;
            entries.delete(key);
        }
    }
}

export function getConversionCacheStats() {
    return {
        entries: entries.size,
        megabytes: Number((totalBytes / 1024 / 1024).toFixed(2)),
    };
}
