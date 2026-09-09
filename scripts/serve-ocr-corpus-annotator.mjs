import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { OCR_CORPUS_CATEGORIES, cleanOCRText } from "./lib/ocr-corpus.mjs";

const values = process.argv.slice(2);
const readOption = (name) => values.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const manifestPath = path.resolve(readOption("manifest") || "benchmarks/ocr-corpus/private/manifest.json");
const port = Math.max(1024, Number(readOption("port")) || 4312);
const base = path.dirname(manifestPath);
const privateRoot = path.basename(base).toLowerCase() === "private" ? base : path.resolve(base, "private");
const uiPath = path.resolve("benchmarks/ocr-corpus/annotator/index.html");

function resolvePrivate(value) {
    const target = path.resolve(base, value);
    const relative = path.relative(privateRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Ruta fuera del corpus privado.");
    }
    return target;
}

async function readJSON(filename) {
    return JSON.parse(await readFile(filename, "utf8"));
}

async function atomicJSON(filename, value) {
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, filename);
}

async function bodyJSON(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error("Solicitud demasiado grande.");
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, payload, contentType = "application/json; charset=utf-8") {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    response.writeHead(status, {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(data),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(data);
}

function validateRegion(region, index) {
    const box = region.bbox || {};
    for (const field of ["x", "y", "width", "height"]) {
        if (!Number.isFinite(Number(box[field]))) throw new Error(`Región ${index + 1}: bbox.${field} inválido.`);
    }
    if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0
        || box.x + box.width > 1.001 || box.y + box.height > 1.001) {
        throw new Error(`Región ${index + 1}: caja normalizada fuera de la página.`);
    }
    return {
        id: String(region.id || `region-${String(index + 1).padStart(3, "0")}`),
        type: String(region.type || "text"),
        coordinateSpace: "normalized",
        bbox: {
            x: Number(box.x), y: Number(box.y),
            width: Number(box.width), height: Number(box.height),
        },
        language: String(region.language || "spa"),
        readingOrder: Number(region.readingOrder) || index + 1,
        text: String(region.text || ""),
        ignore: Boolean(region.ignore),
        cells: Array.isArray(region.cells) ? region.cells : [],
    };
}

async function loadState() {
    const manifest = await readJSON(manifestPath);
    const samples = [];
    for (const sample of manifest.samples || []) {
        const annotationPath = resolvePrivate(sample.annotation || `annotations/${sample.id}.json`);
        const annotation = await readJSON(annotationPath);
        samples.push({
            id: sample.id,
            category: sample.category,
            categoryReview: sample.categoryReview || "pending",
            tags: sample.tags || [],
            rotation: sample.rotation || 0,
            imageUrl: `/image/${encodeURIComponent(sample.id)}`,
            annotation,
        });
    }
    return { corpusId: manifest.corpusId, quotas: manifest.quotas, samples };
}

async function saveSample(sampleId, payload) {
    const manifest = await readJSON(manifestPath);
    const sample = (manifest.samples || []).find((candidate) => candidate.id === sampleId);
    if (!sample) throw new Error("Muestra desconocida.");
    const category = String(payload.category || sample.category);
    if (!OCR_CORPUS_CATEGORIES.includes(category)) throw new Error("Categoría inválida.");
    const categoryReview = payload.categoryReview === "human_verified" ? "human_verified" : "pending";
    const annotation = payload.annotation || {};
    const status = annotation.status === "human_verified" ? "human_verified" : "draft";
    const annotator = cleanOCRText(annotation.annotator);
    const reviewer = cleanOCRText(annotation.reviewer);
    const regions = (annotation.regions || []).map(validateRegion);
    if (!regions.length) throw new Error("Debe existir al menos una región.");
    if (status === "human_verified") {
        if (!annotator || !reviewer) throw new Error("La verificación exige anotador y revisor.");
        if (annotator.toLocaleLowerCase("es") === reviewer.toLocaleLowerCase("es")) {
            throw new Error("Anotador y revisor deben ser personas diferentes.");
        }
        if (!regions.some((region) => !region.ignore && cleanOCRText(region.text))) {
            throw new Error("La verificación exige texto humano en una región evaluable.");
        }
    }
    sample.category = category;
    sample.categoryReview = categoryReview;
    sample.tags = [...new Set((payload.tags || sample.tags || []).map(String).map((tag) => tag.trim()).filter(Boolean))];
    const annotationPath = resolvePrivate(sample.annotation || `annotations/${sample.id}.json`);
    await atomicJSON(annotationPath, {
        ...annotation,
        schemaVersion: 1,
        sampleId,
        status,
        annotator,
        reviewer,
        reviewedAt: status === "human_verified" ? new Date().toISOString() : null,
        regions,
    });
    manifest.status = "human_annotation_in_progress";
    await atomicJSON(manifestPath, manifest);
    return { saved: true, sampleId, status, categoryReview };
}

const server = createServer(async (request, response) => {
    try {
        const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
        if (request.method === "GET" && url.pathname === "/") {
            return send(response, 200, await readFile(uiPath, "utf8"), "text/html; charset=utf-8");
        }
        if (request.method === "GET" && url.pathname === "/api/state") {
            return send(response, 200, await loadState());
        }
        if (request.method === "GET" && url.pathname.startsWith("/image/")) {
            const id = decodeURIComponent(url.pathname.slice("/image/".length));
            const manifest = await readJSON(manifestPath);
            const sample = (manifest.samples || []).find((candidate) => candidate.id === id);
            if (!sample) return send(response, 404, { error: "Muestra desconocida." });
            const bytes = await readFile(resolvePrivate(sample.image || `images/${id}.png`));
            response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
            return response.end(bytes);
        }
        if (request.method === "POST" && url.pathname.startsWith("/api/save/")) {
            const id = decodeURIComponent(url.pathname.slice("/api/save/".length));
            return send(response, 200, await saveSample(id, await bodyJSON(request)));
        }
        return send(response, 404, { error: "Ruta desconocida." });
    } catch (error) {
        return send(response, 400, { error: error.message || "Error desconocido." });
    }
});

server.listen(port, "127.0.0.1", () => {
    console.log(`Anotador OCR privado: http://127.0.0.1:${port}`);
    console.log(`Manifiesto: ${path.relative(process.cwd(), manifestPath)}`);
});
