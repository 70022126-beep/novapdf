import { File } from "node:buffer";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { createWorker, OEM, PSM } from "tesseract.js";
import { authorizedLocalFetch } from "../src/engine/service/LocalServiceSession.js";

import {
    OCR_CORPUS_CATEGORIES,
    aggregateRegionMetrics,
    chooseRegionalFusion,
    evaluateRegion,
    hypothesisForRegion,
    normalizePaddleLines,
    parseTesseractTSV,
    validateOCRCorpus,
} from "./lib/ocr-corpus.mjs";

function parseArguments(values) {
    const readOption = (name) => values.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
    return {
        manifest: readOption("manifest"),
        endpoint: readOption("endpoint") || "http://127.0.0.1:8765/v1/layout",
        output: readOption("output"),
        maxPages: Math.max(0, Number(readOption("max-pages")) || 0),
        allowIncomplete: values.includes("--allow-incomplete"),
        keepHypotheses: values.includes("--keep-hypotheses"),
    };
}

function resolveFrom(base, value) {
    return path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
}

async function readJSON(filename) {
    return JSON.parse(await readFile(filename, "utf8"));
}

async function fileExists(filename) {
    try {
        await access(filename);
        return true;
    } catch {
        return false;
    }
}

async function loadAnnotations(manifest, base) {
    const annotations = new Map();
    const privatePrefix = path.basename(base).toLowerCase() === "private" ? "" : "private";
    for (const sample of manifest.samples || []) {
        const filename = resolveFrom(base, sample.annotation || path.join(privatePrefix, "annotations", `${sample.id}.json`));
        if (await fileExists(filename)) annotations.set(sample.id, await readJSON(filename));
    }
    return annotations;
}

async function runPaddle(imageBytes, imageName, dimensions, endpoint) {
    const startedAt = performance.now();
    const form = new FormData();
    form.append("image", new File([imageBytes], imageName, { type: "image/png" }));
    form.append("page_width", String(dimensions.width));
    form.append("page_height", String(dimensions.height));
    form.append("coordinate_space", "image-pixels");
    const response = await authorizedLocalFetch(endpoint, { method: "POST", body: form, signal: AbortSignal.timeout(300_000) });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`PaddleOCR HTTP ${response.status}: ${detail.slice(0, 160)}`);
    }
    const payload = await response.json();
    return {
        lines: normalizePaddleLines(payload),
        durationMs: Math.round(performance.now() - startedAt),
        provider: payload.provider || "PP-StructureV3",
        version: payload.version || null,
    };
}

async function createTesseractWorker(languages) {
    const worker = await createWorker(languages, OEM.LSTM_ONLY, { logger: () => {} });
    await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        preserve_interword_spaces: "1",
        debug_file: "/dev/null",
    });
    return worker;
}

async function runTesseract(worker, imageBytes, dpi) {
    const startedAt = performance.now();
    const result = await worker.recognize(imageBytes, { user_defined_dpi: String(dpi || 220) }, {
        text: true,
        tsv: true,
        blocks: true,
    });
    return {
        lines: parseTesseractTSV(result?.data?.tsv || ""),
        durationMs: Math.round(performance.now() - startedAt),
        provider: "tesseract.js",
        version: null,
    };
}

function evaluateSample(sample, annotation, paddle, tesseract) {
    const dimensions = annotation.image || {};
    const regions = (annotation.regions || [])
        .filter((region) => !region.ignore && String(region.text || "").trim())
        .sort((first, second) => Number(first.readingOrder) - Number(second.readingOrder));
    const evaluated = { paddle: [], tesseract: [], fusion: [] };
    const privateHypotheses = [];
    const fusionSources = { paddle: 0, tesseract: 0 };

    for (const region of regions) {
        const paddleHypothesis = hypothesisForRegion(paddle.lines, region, dimensions);
        const tesseractHypothesis = hypothesisForRegion(tesseract.lines, region, dimensions);
        const fused = chooseRegionalFusion(region, paddleHypothesis, tesseractHypothesis);
        fusionSources[fused.engine] += 1;
        evaluated.paddle.push(evaluateRegion(region.text, paddleHypothesis));
        evaluated.tesseract.push(evaluateRegion(region.text, tesseractHypothesis));
        evaluated.fusion.push(evaluateRegion(region.text, fused));
        privateHypotheses.push({
            regionId: region.id,
            reference: region.text,
            paddle: paddleHypothesis.text,
            tesseract: tesseractHypothesis.text,
            fusion: fused.text,
            fusionSource: fused.engine,
        });
    }

    return {
        publicResult: {
            id: sample.id,
            category: sample.category,
            tags: sample.tags || [],
            regionCount: regions.length,
            engines: {
                paddle: { ...aggregateRegionMetrics(evaluated.paddle), durationMs: paddle.durationMs },
                tesseract: { ...aggregateRegionMetrics(evaluated.tesseract), durationMs: tesseract.durationMs },
                fusion: { ...aggregateRegionMetrics(evaluated.fusion), durationMs: paddle.durationMs + tesseract.durationMs },
            },
            fusionSources,
        },
        privateHypotheses,
    };
}

function aggregateSamples(samples, engine) {
    const regions = samples.flatMap((sample) => {
        const metric = sample.engines[engine];
        return [{
            characterErrors: metric.characterErrors,
            referenceCharacters: metric.referenceCharacters,
            wordErrors: metric.wordErrors,
            referenceWords: metric.referenceWords,
            confidence: metric.meanConfidence,
        }];
    });
    const result = aggregateRegionMetrics(regions);
    return {
        ...result,
        regions: samples.reduce((sum, sample) => sum + sample.engines[engine].regions, 0),
        pages: samples.length,
        durationMs: samples.reduce((sum, sample) => sum + sample.engines[engine].durationMs, 0),
    };
}

function buildReport(manifest, readiness, samples, providers, startedAt) {
    const engines = Object.fromEntries(
        ["paddle", "tesseract", "fusion"].map((engine) => [engine, aggregateSamples(samples, engine)])
    );
    const categories = Object.fromEntries(OCR_CORPUS_CATEGORIES.map((category) => [
        category,
        Object.fromEntries(["paddle", "tesseract", "fusion"].map((engine) => [
            engine,
            aggregateSamples(samples.filter((sample) => sample.category === category), engine),
        ])),
    ]));
    const ranking = Object.entries(engines)
        .map(([engine, metrics]) => ({ engine, cer: metrics.cer, wer: metrics.wer }))
        .sort((first, second) => first.cer - second.cer || first.wer - second.wer);
    return {
        schemaVersion: 1,
        corpusId: manifest.corpusId || "novapdf-private-ocr",
        createdAt: new Date().toISOString(),
        status: readiness.valid ? "complete" : "partial",
        privacy: "No incluye rutas, imágenes, referencias ni hipótesis OCR.",
        readiness,
        processedPages: samples.length,
        providers,
        engines,
        categories,
        ranking,
        durationMs: Math.round(performance.now() - startedAt),
        samples,
    };
}

const options = parseArguments(process.argv.slice(2));
if (!options.manifest) {
    console.error("Uso: npm run benchmark:ocr-corpus -- --manifest=benchmarks/ocr-corpus/private/manifest.json");
    process.exitCode = 1;
} else {
    const startedAt = performance.now();
    const manifestPath = path.resolve(options.manifest);
    const base = path.dirname(manifestPath);
    const manifest = await readJSON(manifestPath);
    const annotations = await loadAnnotations(manifest, base);
    const readiness = validateOCRCorpus(manifest, annotations);
    if (!readiness.valid && !options.allowIncomplete) {
        console.error(JSON.stringify({
            status: "blocked",
            reason: "El benchmark requiere categorías y transcripciones humanas verificadas.",
            readiness: {
                ...readiness,
                errorCount: readiness.errors.length,
                errors: readiness.errors.slice(0, 12),
            },
        }, null, 2));
        process.exitCode = 2;
    } else {
        let samples = (manifest.samples || []).filter((sample) => {
            const annotation = annotations.get(sample.id);
            return sample.categoryReview === "human_verified"
                && annotation?.status === "human_verified"
                && (annotation.regions || []).some((region) => !region.ignore && String(region.text || "").trim());
        });
        if (options.maxPages) samples = samples.slice(0, options.maxPages);
        if (!samples.length) throw new Error("No hay páginas con transcripción humana verificada para medir.");

        const languages = manifest.languages || ["spa", "eng"];
        const tesseract = await createTesseractWorker(languages);
        const results = [];
        const providers = {};
        const privateRoot = path.basename(base).toLowerCase() === "private"
            ? base : path.resolve(base, "private");
        const privateRun = options.keepHypotheses
            ? path.resolve(privateRoot, "runs", new Date().toISOString().replace(/[:.]/g, "-"))
            : null;
        if (privateRun) await mkdir(privateRun, { recursive: true });
        try {
            for (const sample of samples) {
                const annotation = annotations.get(sample.id);
                const imagePath = resolveFrom(
                    base,
                    sample.image || path.join(path.basename(base).toLowerCase() === "private" ? "" : "private", "images", `${sample.id}.png`)
                );
                const imageBytes = await readFile(imagePath);
                const [paddleResult, tesseractResult] = await Promise.all([
                    runPaddle(imageBytes, `${sample.id}.png`, annotation.image, options.endpoint),
                    runTesseract(tesseract, imageBytes, annotation.image?.dpi),
                ]);
                providers.paddle = { name: paddleResult.provider, version: paddleResult.version };
                providers.tesseract = { name: tesseractResult.provider, version: tesseractResult.version };
                const evaluated = evaluateSample(sample, annotation, paddleResult, tesseractResult);
                results.push(evaluated.publicResult);
                if (privateRun) {
                    await writeFile(
                        path.join(privateRun, `${sample.id}.json`),
                        `${JSON.stringify(evaluated.privateHypotheses, null, 2)}\n`,
                        "utf8"
                    );
                }
                console.log(`${results.length}/${samples.length} ${sample.id}`);
            }
        } finally {
            await tesseract.terminate();
        }

        const report = buildReport(manifest, readiness, results, providers, startedAt);
        const historyDirectory = resolveFrom(base, manifest.historyDirectory || "../history");
        await mkdir(historyDirectory, { recursive: true });
        const defaultOutput = path.join(
            historyDirectory,
            `${report.corpusId}-${report.createdAt.replace(/[:.]/g, "-")}.json`
        );
        const output = options.output ? path.resolve(options.output) : defaultOutput;
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        await writeFile(path.join(historyDirectory, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
        console.log(JSON.stringify({
            status: report.status,
            output,
            processedPages: report.processedPages,
            ranking: report.ranking,
        }, null, 2));
    }
}
