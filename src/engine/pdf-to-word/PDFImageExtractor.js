function multiplyMatrices(first, second) {
    return [
        first[0] * second[0] + first[2] * second[1],
        first[1] * second[0] + first[3] * second[1],
        first[0] * second[2] + first[2] * second[3],
        first[1] * second[2] + first[3] * second[3],
        first[0] * second[4] + first[2] * second[5] + first[4],
        first[1] * second[4] + first[3] * second[5] + first[5],
    ];
}

function transformPoint(matrix, x, y) {
    return {
        x: matrix[0] * x + matrix[2] * y + matrix[4],
        y: matrix[1] * x + matrix[3] * y + matrix[5],
    };
}

function matrixBox(matrix) {
    const points = [
        transformPoint(matrix, 0, 0),
        transformPoint(matrix, 1, 0),
        transformPoint(matrix, 0, 1),
        transformPoint(matrix, 1, 1),
    ];
    const x = Math.min(...points.map((point) => point.x));
    const y = Math.min(...points.map((point) => point.y));
    const right = Math.max(...points.map((point) => point.x));
    const bottom = Math.max(...points.map((point) => point.y));

    return { x, y, width: right - x, height: bottom - y };
}

function clampBox(box, pageWidth, pageHeight) {
    const x = Math.max(0, Math.min(pageWidth, box.x));
    const y = Math.max(0, Math.min(pageHeight, box.y));
    const right = Math.max(x, Math.min(pageWidth, box.x + box.width));
    const bottom = Math.max(y, Math.min(pageHeight, box.y + box.height));
    return { x, y, width: right - x, height: bottom - y };
}

function overlapRatio(first, second) {
    const left = Math.max(first.x, second.x);
    const top = Math.max(first.y, second.y);
    const right = Math.min(first.x + first.width, second.x + second.width);
    const bottom = Math.min(first.y + first.height, second.y + second.height);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const minimumArea = Math.max(
        1,
        Math.min(first.width * first.height, second.width * second.height)
    );
    return intersection / minimumArea;
}

export async function inspectPageImages(page, pdfjsLib, viewport) {
    try {
        const operatorList = await page.getOperatorList();
        const imageOperators = new Set(
            [
                pdfjsLib.OPS.paintImageXObject,
                pdfjsLib.OPS.paintInlineImageXObject,
                pdfjsLib.OPS.paintJpegXObject,
                pdfjsLib.OPS.paintImageMaskXObject,
            ].filter(Number.isFinite)
        );
        const saveOperator = pdfjsLib.OPS.save;
        const restoreOperator = pdfjsLib.OPS.restore;
        const transformOperator = pdfjsLib.OPS.transform;
        const stack = [];
        let matrix = [...viewport.transform];
        let count = 0;
        const regions = [];

        operatorList.fnArray.forEach((operator, index) => {
            if (operator === saveOperator) {
                stack.push([...matrix]);
                return;
            }

            if (operator === restoreOperator) {
                matrix = stack.pop() || [...viewport.transform];
                return;
            }

            if (operator === transformOperator) {
                const transform = operatorList.argsArray[index];
                if (Array.isArray(transform) && transform.length >= 6) {
                    matrix = multiplyMatrices(matrix, transform);
                }
                return;
            }

            if (!imageOperators.has(operator)) {
                return;
            }

            count += 1;
            const box = clampBox(matrixBox(matrix), viewport.width, viewport.height);
            const pageArea = viewport.width * viewport.height;
            const boxArea = box.width * box.height;

            if (
                box.width < 12 ||
                box.height < 12 ||
                boxArea < 300 ||
                boxArea > pageArea * 0.68
            ) {
                return;
            }

            if (!regions.some((candidate) => overlapRatio(candidate, box) > 0.88)) {
                regions.push(box);
            }
        });

        return {
            count,
            regions: regions
                .sort((a, b) => b.width * b.height - a.width * a.height)
                .slice(0, 12)
                .sort((a, b) => a.y - b.y),
        };
    } catch {
        return { count: 0, regions: [] };
    }
}

function canvasToPng(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(async (blob) => {
            if (!blob) {
                reject(new Error("No se pudo codificar una imagen del PDF."));
                return;
            }

            resolve(new Uint8Array(await blob.arrayBuffer()));
        }, "image/png");
    });
}

function calculateVisualMetrics(context, width, height) {
    const data = context.getImageData(0, 0, width, height).data;
    const pixelCount = width * height;
    const step = Math.max(1, Math.floor(Math.sqrt(pixelCount / 45_000)));
    let samples = 0;
    let luminanceTotal = 0;
    let luminanceSquaredTotal = 0;
    let colorfulnessTotal = 0;
    let inkPixels = 0;
    let edgePixels = 0;
    let previousLuminance;

    for (let y = 0; y < height; y += step) {
        previousLuminance = null;
        for (let x = 0; x < width; x += step) {
            const index = (y * width + x) * 4;
            const red = data[index];
            const green = data[index + 1];
            const blue = data[index + 2];
            const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
            const colorRange = Math.max(red, green, blue) - Math.min(red, green, blue);
            samples += 1;
            luminanceTotal += luminance;
            luminanceSquaredTotal += luminance * luminance;
            colorfulnessTotal += colorRange;
            if (luminance < 205) inkPixels += 1;
            if (previousLuminance !== null && Math.abs(luminance - previousLuminance) > 35) {
                edgePixels += 1;
            }
            previousLuminance = luminance;
        }
    }

    const mean = samples ? luminanceTotal / samples : 0;
    return {
        colorfulness: Number((samples ? colorfulnessTotal / samples : 0).toFixed(2)),
        tonalVariance: Number(
            (samples ? luminanceSquaredTotal / samples - mean * mean : 0).toFixed(2)
        ),
        inkDensity: Number((samples ? inkPixels / samples : 0).toFixed(4)),
        edgeDensity: Number((samples ? edgePixels / samples : 0).toFixed(4)),
    };
}

export async function cropPageImageRegions(sourceCanvas, regions, renderedScale) {
    const images = [];

    for (const region of regions) {
        const sourceX = Math.max(0, Math.floor(region.x * renderedScale));
        const sourceY = Math.max(0, Math.floor(region.y * renderedScale));
        const sourceWidth = Math.min(
            sourceCanvas.width - sourceX,
            Math.max(1, Math.ceil(region.width * renderedScale))
        );
        const sourceHeight = Math.min(
            sourceCanvas.height - sourceY,
            Math.max(1, Math.ceil(region.height * renderedScale))
        );

        if (sourceWidth <= 0 || sourceHeight <= 0) {
            continue;
        }

        const canvas = document.createElement("canvas");
        canvas.width = sourceWidth;
        canvas.height = sourceHeight;
        const context = canvas.getContext("2d", { alpha: false });

        if (!context) {
            canvas.remove();
            continue;
        }

        context.drawImage(
            sourceCanvas,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,
            0,
            0,
            sourceWidth,
            sourceHeight
        );

        try {
            images.push({
                ...region,
                type: "png",
                data: await canvasToPng(canvas),
                pixelWidth: sourceWidth,
                pixelHeight: sourceHeight,
                visualMetrics: calculateVisualMetrics(
                    context,
                    sourceWidth,
                    sourceHeight
                ),
            });
        } finally {
            canvas.width = 1;
            canvas.height = 1;
            canvas.remove();
        }
    }

    return images;
}
