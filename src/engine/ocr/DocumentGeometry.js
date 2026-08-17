function createCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
}

function getInkPoints(sourceCanvas, maximumWidth = 720) {
    const scale = Math.min(1, maximumWidth / Math.max(1, sourceCanvas.width));
    const canvas = createCanvas(sourceCanvas.width * scale, sourceCanvas.height * scale);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const points = [];
    const step = Math.max(1, Math.floor(Math.sqrt((canvas.width * canvas.height) / 180_000)));

    for (let y = 0; y < canvas.height; y += step) {
        for (let x = 0; x < canvas.width; x += step) {
            const index = (y * canvas.width + x) * 4;
            const luminance =
                pixels[index] * 0.299 +
                pixels[index + 1] * 0.587 +
                pixels[index + 2] * 0.114;
            if (luminance < 165) points.push({ x, y });
        }
    }

    canvas.width = 1;
    canvas.height = 1;
    canvas.remove();
    return points;
}

export function estimateSkewAngle(sourceCanvas, maximumAngle = 4.5, step = 0.5) {
    const points = getInkPoints(sourceCanvas);
    if (points.length < 80) return 0;
    let bestAngle = 0;
    let bestScore = -Infinity;

    for (let angle = -maximumAngle; angle <= maximumAngle; angle += step) {
        const tangent = Math.tan((angle * Math.PI) / 180);
        const rows = new Map();
        points.forEach((point) => {
            const row = Math.round(point.y - point.x * tangent);
            rows.set(row, (rows.get(row) || 0) + 1);
        });
        const score = [...rows.values()].reduce((total, count) => total + count * count, 0);
        if (score > bestScore) {
            bestScore = score;
            bestAngle = angle;
        }
    }

    return Math.abs(bestAngle) >= 0.45 ? Number(bestAngle.toFixed(2)) : 0;
}

export function deskewCanvas(sourceCanvas, angle = estimateSkewAngle(sourceCanvas)) {
    if (!angle) return { canvas: sourceCanvas, angle: 0, owned: false };
    const canvas = createCanvas(sourceCanvas.width, sourceCanvas.height);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate((-angle * Math.PI) / 180);
    context.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);
    return { canvas, angle, owned: true };
}

export function rotateCanvasClockwise(sourceCanvas) {
    const canvas = createCanvas(sourceCanvas.height, sourceCanvas.width);
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.translate(canvas.width, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(sourceCanvas, 0, 0);
    return canvas;
}

export function mapClockwiseWordsToSource(words = [], sourceHeight) {
    return words.map((word) => ({
        ...word,
        x: Number(word.y) || 0,
        y: Math.max(
            0,
            sourceHeight - (Number(word.x) || 0) - (Number(word.width) || 0)
        ),
        width: Number(word.height) || 0,
        height: Number(word.width) || 0,
        orientationCorrected: 90,
    }));
}
