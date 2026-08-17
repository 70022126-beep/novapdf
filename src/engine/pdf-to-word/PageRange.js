export function normalizePageRange(pageRange, totalPages) {
    if (!pageRange || pageRange === "all") {
        return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    if (Array.isArray(pageRange)) {
        return [...new Set(pageRange.map(Number))]
            .filter((pageNumber) => pageNumber >= 1 && pageNumber <= totalPages)
            .sort((a, b) => a - b);
    }

    const pages = new Set();
    String(pageRange)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach((part) => {
            const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
            if (range) {
                const start = Math.min(Number(range[1]), Number(range[2]));
                const end = Math.max(Number(range[1]), Number(range[2]));
                for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
                    if (pageNumber >= 1 && pageNumber <= totalPages) pages.add(pageNumber);
                }
                return;
            }
            const pageNumber = Number(part);
            if (pageNumber >= 1 && pageNumber <= totalPages) pages.add(pageNumber);
        });

    return [...pages].sort((a, b) => a - b);
}
