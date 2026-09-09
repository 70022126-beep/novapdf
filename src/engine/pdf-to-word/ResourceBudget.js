function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveClientResourceBudget({
    requestedCanvasMegapixels = 20,
    requestedCacheMB = 96,
    requestedPersistentMB = 1024,
    deviceMemoryGB = globalThis.navigator?.deviceMemory,
    heapLimitBytes = globalThis.performance?.memory?.jsHeapSizeLimit,
} = {}) {
    const memoryGB = positiveNumber(deviceMemoryGB, 4);
    const estimatedRamBytes = memoryGB * 1024 * 1024 * 1024;
    const browserHeapBytes = positiveNumber(heapLimitBytes, estimatedRamBytes * 0.5);
    const safeWorkingBytes = Math.min(estimatedRamBytes * 0.28, browserHeapBytes * 0.55);
    const canvasCeiling = memoryGB <= 4 ? 12 : memoryGB <= 8 ? 20 : 32;
    const cacheCeilingMB = Math.max(32, Math.floor(safeWorkingBytes / 1024 / 1024 * 0.35));

    return {
        detectedDeviceMemoryGB: memoryGB,
        browserHeapLimitBytes: browserHeapBytes,
        workingSetBudgetBytes: Math.floor(safeWorkingBytes),
        maximumCanvasMegapixels: Math.min(
            positiveNumber(requestedCanvasMegapixels, 20),
            canvasCeiling
        ),
        cacheMemoryMB: Math.min(positiveNumber(requestedCacheMB, 96), cacheCeilingMB),
        persistentStorageMB: Math.max(128, positiveNumber(requestedPersistentMB, 1024)),
        estimatedRgbaPageMB: Number(
            (Math.min(positiveNumber(requestedCanvasMegapixels, 20), canvasCeiling) * 4).toFixed(1)
        ),
    };
}

export function createResourceTracker(budget) {
    let currentBytes = 0;
    let peakBytes = 0;
    return {
        reserve(bytes) {
            currentBytes += Math.max(0, Number(bytes) || 0);
            peakBytes = Math.max(peakBytes, currentBytes);
            return currentBytes <= budget.workingSetBudgetBytes;
        },
        release(bytes) {
            currentBytes = Math.max(0, currentBytes - Math.max(0, Number(bytes) || 0));
        },
        stats() {
            return { currentBytes, peakBytes, budgetBytes: budget.workingSetBudgetBytes };
        },
    };
}
