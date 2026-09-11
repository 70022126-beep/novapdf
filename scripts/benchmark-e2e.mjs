import { File } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright-core";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import { validateRenderedWordDocument } from "../src/engine/evaluation/VisualQualityProvider.js";
import {
    compareText,
    evaluateQualityGate,
    inspectDocx,
    publicDocxMetrics,
} from "./lib/e2e-quality-gate.mjs";

const ROOT = process.cwd();
const argumentsList = process.argv.slice(2);
const manifestArgument = argumentsList.find((value) => value.startsWith("--manifest="));
const updateHistory = !argumentsList.includes("--no-history");
const keepServices = argumentsList.includes("--keep-services");

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

function cleanIdentifier(value) {
    return String(value || "document")
        .normalize("NFKD")
        .replace(/[^a-z0-9_-]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
}

async function exists(filename) {
    try {
        await access(filename, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

function resolveConfiguredPath(value, baseDirectory = ROOT) {
    if (!value) return null;
    return path.isAbsolute(value) ? value : path.resolve(baseDirectory, value);
}

function sha256(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}

function compactOptimizationDecision(report = {}) {
    return {
        enabled: Boolean(report.enabled),
        attempted: Boolean(report.attempted),
        applied: Boolean(report.applied),
        reason: report.reason || null,
        provider: report.provider || null,
        providerVersion: report.providerVersion || null,
        pages: Array.isArray(report.pages) ? report.pages : [],
        acceptedPages: Array.isArray(report.acceptedPages) ? report.acceptedPages : [],
        scoreBefore: report.scoreBefore ?? report.initialQuality?.visualScore ?? null,
        candidateScore: report.candidateScore ?? report.candidateQuality?.visualScore ?? null,
        durationMs: report.durationMs ?? null,
    };
}

function visualScoreGap(current, baseline) {
    return current?.status === "completed" && baseline?.status === "completed"
        ? Number((current.visualScore - baseline.visualScore).toFixed(4))
        : null;
}

function compactRunSummary(report, reportPath) {
    const documents = report.documents.map((document) => ({
        id: document.id,
        passed: document.passed,
        pages: `${document.current.visual?.outputPageCount ?? "n/d"}/${document.source.pageCount ?? "n/d"}`,
        visualScore: document.current.visual?.visualScore ?? null,
        textCoverage: document.gate.textComparison?.characterCoverage?.coverage ?? null,
        cerPercent: document.gate.textComparison?.cerPercent ?? null,
        werPercent: document.gate.textComparison?.werPercent ?? null,
        peakBrowserHeapMB: document.current.performance.peakBrowserHeapMB,
        wallDurationMs: document.current.performance.wallDurationMs,
        engine: document.current.engine.conversionEngine,
        failures: document.gate.failures.map((failure) => failure.code),
    }));
    return JSON.stringify({
        runId: report.runId,
        passed: report.passed,
        documents,
        report: reportPath,
    }, null, 2);
}

function gitCommit() {
    const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: ROOT,
        encoding: "utf8",
        windowsHide: true,
    });
    return result.status === 0 ? result.stdout.trim() : null;
}

function findBrowserExecutable(configured) {
    const candidates = [
        configured,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ].filter(Boolean);
    return candidates;
}

async function firstExisting(candidates) {
    for (const candidate of candidates) {
        if (await exists(candidate)) return candidate;
    }
    return null;
}

async function waitForHttp(url, timeoutMs, predicate = (response) => response.ok) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
            if (predicate(response)) return response;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`No respondió ${url}: ${lastError?.message || "tiempo agotado"}`);
}

function captureChild(command, args, options = {}) {
    const child = spawn(command, args, {
        cwd: options.cwd || ROOT,
        env: { ...process.env, ...(options.env || {}) },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    const remember = (chunk) => {
        output.push(String(chunk));
        if (output.length > 60) output.shift();
    };
    child.stdout.on("data", remember);
    child.stderr.on("data", remember);
    child.recentOutput = () => output.join("").trim();
    return child;
}

function stopChild(child) {
    if (!child || child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
}

async function ensureFrontend(manifest, ownedProcesses) {
    const frontendUrl = new URL(manifest.frontendUrl);
    try {
        await waitForHttp(frontendUrl.origin, 2_000);
        return;
    } catch {
        if (manifest.startFrontend === false) throw new Error("La interfaz NovaPDF no está disponible.");
    }
    const viteEntry = path.resolve(ROOT, "node_modules/vite/bin/vite.js");
    const child = captureChild(process.execPath, [
        viteEntry,
        "--host", frontendUrl.hostname,
        "--port", frontendUrl.port || "4173",
        "--strictPort",
    ]);
    ownedProcesses.push(child);
    child.once("exit", (code) => {
        if (code && code !== 0) process.stderr.write(`${child.recentOutput()}\n`);
    });
    await waitForHttp(frontendUrl.origin, 30_000);
}

async function ensureVision(manifest, ownedProcesses) {
    const healthUrl = new URL("/health", manifest.visionEndpoint).toString();
    try {
        return await (await waitForHttp(healthUrl, 2_000)).json();
    } catch {
        if (manifest.startVision === false) throw new Error("El servicio documental local no está disponible.");
    }
    const serviceRoot = path.resolve(ROOT, "services/vision");
    const python = path.join(serviceRoot, ".venv", "Scripts", "python.exe");
    if (!(await exists(python))) throw new Error("Falta services/vision/.venv.");
    const endpoint = new URL(manifest.visionEndpoint);
    const child = captureChild(python, [
        "-m", "uvicorn", "app:app",
        "--host", endpoint.hostname,
        "--port", endpoint.port || "8765",
        "--app-dir", serviceRoot,
    ], {
        env: {
            NOVAPDF_VISION_DEVICE: manifest.visionDevice || "gpu:0",
            NOVAPDF_VISION_LANGUAGE: manifest.visionLanguage || "es",
            NOVAPDF_VISION_MODEL_CACHE: path.join(serviceRoot, ".models"),
            PADDLE_PDX_CACHE_HOME: path.join(serviceRoot, ".models", "paddlex"),
            PADDLE_PDX_MODEL_SOURCE: "bos",
            PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
        },
    });
    ownedProcesses.push(child);
    child.once("exit", (code) => {
        if (code && code !== 0) process.stderr.write(`${child.recentOutput()}\n`);
    });
    const response = await waitForHttp(healthUrl, 120_000);
    return response.json();
}

function pageNumbersFromRange(value) {
    const raw = String(value || "all").trim().toLowerCase();
    if (!raw || raw === "all") return [];
    const pages = new Set();
    for (const part of raw.split(",")) {
        const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
        if (!match) continue;
        const start = Number(match[1]);
        const end = Number(match[2] || match[1]);
        for (let page = Math.min(start, end); page <= Math.max(start, end); page += 1) pages.add(page);
    }
    return [...pages].sort((first, second) => first - second);
}

async function extractPdfReference(pdfPath, pageRange) {
    const bytes = await readFile(pdfPath);
    const loadingTask = getDocument({
        data: new Uint8Array(bytes),
        disableWorker: true,
        useSystemFonts: true,
    });
    const document = await loadingTask.promise;
    const selected = pageNumbersFromRange(pageRange);
    const pageNumbers = selected.length
        ? selected.filter((page) => page <= document.numPages)
        : Array.from({ length: document.numPages }, (_, index) => index + 1);
    const text = [];
    try {
        for (const pageNumber of pageNumbers) {
            const page = await document.getPage(pageNumber);
            const content = await page.getTextContent();
            text.push(content.items.map((item) => item.str || "").join(" "));
            page.cleanup();
        }
    } finally {
        await loadingTask.destroy();
    }
    return text.join("\n").replace(/\s+/g, " ").trim();
}

async function loadDocxMetrics(filename) {
    if (!filename) return null;
    return inspectDocx(await readFile(filename));
}

async function visualQuality(pdfPath, docxPath, endpoint, pageRange, timeoutMs) {
    if (!docxPath) return null;
    const pdfBytes = await readFile(pdfPath);
    const docxBytes = await readFile(docxPath);
    return validateRenderedWordDocument(
        new File([pdfBytes], "source.pdf", { type: "application/pdf", lastModified: 0 }),
        new File([docxBytes], "candidate.docx", {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            lastModified: 0,
        }),
        {
            pageNumbers: pageNumbersFromRange(pageRange),
            endpoint,
            dpi: 120,
            timeoutMs,
        }
    );
}

async function setCheckbox(page, testId, expected) {
    if (expected === undefined) return;
    const locator = page.getByTestId(testId);
    if (await locator.isDisabled()) return;
    if (await locator.isChecked() !== Boolean(expected)) await locator.click();
}

async function startHeapSampler(context, page) {
    const session = await context.newCDPSession(page);
    await session.send("Performance.enable");
    let stopped = false;
    let peakHeapBytes = 0;
    const sample = async () => {
        if (stopped) return;
        try {
            const payload = await session.send("Performance.getMetrics");
            const heap = payload.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value || 0;
            peakHeapBytes = Math.max(peakHeapBytes, heap);
        } catch {
            stopped = true;
        }
    };
    const timer = setInterval(sample, 500);
    await sample();
    return async () => {
        stopped = true;
        clearInterval(timer);
        await sample();
        await session.detach().catch(() => {});
        return Number((peakHeapBytes / 1024 / 1024).toFixed(2));
    };
}

async function runBrowserConversion(browser, manifest, document, artifactDirectory) {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(Number(document.timeoutMs || manifest.timeoutMs || 1_800_000));
    const consoleErrors = [];
    let progressTimer = null;
    let lastProgressText = "";
    page.on("console", (message) => {
        if (message.type() === "error") {
            consoleErrors.push(message.text());
            process.stdout.write(`E2E ${document.id}: consola: ${message.text()}\n`);
        }
    });
    page.on("requestfailed", (request) => {
        process.stdout.write(
            `E2E ${document.id}: red: ${request.method()} ${request.url()} · ` +
            `${request.failure()?.errorText || "falló"}\n`
        );
    });
    page.on("crash", () => {
        process.stdout.write(`E2E ${document.id}: la página de Chrome se bloqueó.\n`);
    });
    const stopHeapSampler = await startHeapSampler(context, page);
    const startedAt = performance.now();
    const traceStep = (detail) => process.stdout.write(`E2E ${document.id}: ${detail}\n`);
    try {
        traceStep("abriendo la interfaz…");
        await page.goto(manifest.frontendUrl, { waitUntil: "networkidle" });
        traceStep("interfaz lista; configurando modo…");
        await page.getByTestId(`pdf-word-mode-${document.mode || "editable"}`).click();
        traceStep("cargando el PDF…");
        await page.getByTestId("pdf-word-input").setInputFiles(document.pdf);
        traceStep("PDF cargado; configurando OCR y rango…");
        if ((document.mode || "editable") !== "visual") {
            await page.getByTestId("pdf-word-ocr-mode").selectOption(document.ocrMode || "auto");
        }
        await page.getByTestId("pdf-word-page-range").fill(document.pageRange || "all");
        traceStep("configurando validación y visión…");
        await setCheckbox(page, "pdf-word-review-before-download", false);
        await setCheckbox(page, "pdf-word-auto-quality-retry", document.autoQualityRetry !== false);
        await setCheckbox(page, "pdf-word-validate-quality", document.validateVisualQuality !== false);
        await setCheckbox(page, "pdf-word-advanced-vision", document.advancedVision !== false);
        if (document.advancedVision !== false) {
            await page.getByTestId("pdf-word-vision-provider").selectOption(document.visionProvider || "auto");
            if ((document.visionProvider || "auto") !== "local") {
                await page.getByTestId("pdf-word-vision-endpoint").fill(manifest.visionEndpoint);
            }
        }
        if (document.maximumCanvasMegapixels) {
            const renderLimit = page.getByTestId("pdf-word-render-limit");
            const requestedLimit = String(document.maximumCanvasMegapixels);
            if (!await renderLimit.locator(`option[value="${requestedLimit}"]`).count()) {
                throw new Error(`Límite de render no disponible: ${requestedLimit} MP.`);
            }
            await renderLimit.selectOption(requestedLimit);
        }

        traceStep("iniciando la conversión…");
        await page.getByTestId("pdf-word-convert").click();
        traceStep("conversión iniciada; esperando el DOCX…");
        progressTimer = setInterval(async () => {
            try {
                const status = await page.evaluate(() => ({
                    progress: document.querySelector(".pdf-word-progress")?.innerText || "",
                    error: document.querySelector('[data-testid="pdf-word-error"]')?.textContent || "",
                    action: document.querySelector('[data-testid="pdf-word-convert"]')?.textContent || "",
                    actionDisabled: Boolean(
                        document.querySelector('[data-testid="pdf-word-convert"]')?.disabled
                    ),
                    completed: document.querySelector(".pdf-word-report")?.innerText
                        ?.split("\n")
                        .slice(0, 3)
                        .join(" ") || "",
                    resultReady: Boolean(window.__NOVAPDF_E2E_RESULT__?.report?.outputBytes),
                }));
                const current = [
                    status.progress,
                    status.error,
                    status.action
                        ? `${status.action}${status.actionDisabled ? " (deshabilitado)" : ""}`
                        : "",
                    status.completed,
                    status.resultReady ? "resultado E2E listo" : "",
                ]
                    .filter(Boolean)
                    .join(" · ")
                    .replace(/\s+/g, " ")
                    .trim();
                if (current && current !== lastProgressText) {
                    lastProgressText = current;
                    process.stdout.write(`E2E ${document.id}: ${current}\n`);
                }
            } catch {
                // El evento crash/requestfailed aporta el diagnóstico si el
                // contexto deja de estar disponible entre dos muestras.
            }
        }, 15_000);
        await page.waitForFunction(
            () => window.__NOVAPDF_E2E_RESULT__?.report?.outputBytes > 0,
            null,
            { timeout: Number(document.timeoutMs || manifest.timeoutMs || 1_800_000) }
        );
        const appResult = await page.evaluate(() => window.__NOVAPDF_E2E_RESULT__);
        const downloadPromise = page.waitForEvent("download");
        await page.getByTestId("pdf-word-download").click();
        const download = await downloadPromise;
        const outputPath = path.join(artifactDirectory, `${cleanIdentifier(document.id)}.docx`);
        await download.saveAs(outputPath);
        const peakBrowserHeapMB = await stopHeapSampler();
        return {
            outputPath,
            appResult,
            durationMs: Math.round(performance.now() - startedAt),
            peakBrowserHeapMB,
            consoleErrors,
        };
    } catch (error) {
        const screenshot = path.join(artifactDirectory, `${cleanIdentifier(document.id)}-failure.png`);
        await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
        const visibleError = await page.getByTestId("pdf-word-error").textContent().catch(() => "");
        throw new Error(`${document.id}: ${visibleError || error.message}`);
    } finally {
        if (progressTimer) clearInterval(progressTimer);
        await context.close();
    }
}

async function findLatestHistory(historyDirectory) {
    const latest = path.join(historyDirectory, "latest.json");
    if (!(await exists(latest))) return null;
    try {
        return JSON.parse(await readFile(latest, "utf8"));
    } catch {
        return null;
    }
}

function historicDocument(history, id) {
    return history?.documents?.find((document) => document.id === id) || null;
}

async function main() {
    if (!manifestArgument) {
        throw new Error("Uso: npm run benchmark:e2e -- --manifest=benchmarks/e2e/manifest.json");
    }
    const manifestPath = path.resolve(manifestArgument.slice("--manifest=".length));
    const manifestDirectory = path.dirname(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!Array.isArray(manifest.documents) || !manifest.documents.length) {
        throw new Error("El manifiesto E2E no contiene documentos.");
    }
    manifest.frontendUrl ||= "http://127.0.0.1:4173/pdf-to-word?e2e=1";
    manifest.visionEndpoint ||= "http://127.0.0.1:8765/v1/layout";
    const artifactsRoot = resolveConfiguredPath(manifest.artifactsDirectory || "tmp/e2e", ROOT);
    const historyDirectory = resolveConfiguredPath(manifest.historyDirectory || "benchmarks/e2e/history", ROOT);
    const runId = `${cleanIdentifier(manifest.version || "development")}-${timestamp()}`;
    const artifactDirectory = path.join(artifactsRoot, runId);
    await mkdir(artifactDirectory, { recursive: true });
    await mkdir(historyDirectory, { recursive: true });
    const previousHistory = await findLatestHistory(historyDirectory);
    const ownedProcesses = [];
    let browser = null;
    try {
        await ensureFrontend(manifest, ownedProcesses);
        const serviceHealth = await ensureVision(manifest, ownedProcesses);
        const browserExecutable = await firstExisting(findBrowserExecutable(manifest.browserExecutable));
        if (!browserExecutable) throw new Error("No se encontró Chrome o Edge para el benchmark E2E.");
        browser = await chromium.launch({
            executablePath: browserExecutable,
            headless: manifest.headless !== false,
        });

        const report = {
            schemaVersion: 2,
            runId,
            createdAt: new Date().toISOString(),
            version: manifest.version || serviceHealth.version || "development",
            gitCommit: gitCommit(),
            service: {
                version: serviceHealth.version || null,
                status: serviceHealth.status || null,
                device: serviceHealth.device || null,
                modelLoaded: Boolean(serviceHealth.model_loaded),
                nativeDocxConverter: serviceHealth.native_docx_converter || null,
                documentRenderer: serviceHealth.document_renderer || null,
            },
            thresholds: manifest.thresholds || {},
            documents: [],
            passed: true,
        };

        for (const configured of manifest.documents) {
            const document = {
                ...configured,
                id: cleanIdentifier(configured.id),
                pdf: resolveConfiguredPath(configured.pdf, manifestDirectory),
                previousDocx: resolveConfiguredPath(configured.previousDocx, manifestDirectory),
                professionalDocx: resolveConfiguredPath(configured.professionalDocx, manifestDirectory),
                referenceDocx: resolveConfiguredPath(configured.referenceDocx, manifestDirectory),
            };
            if (!document.id || !(await exists(document.pdf))) {
                throw new Error(`Documento o PDF no válido: ${configured.id || configured.pdf}`);
            }
            process.stdout.write(`E2E ${document.id}: convirtiendo ${document.pageRange || "all"}...\n`);
            const conversion = await runBrowserConversion(browser, manifest, document, artifactDirectory);
            const outputBytes = await readFile(conversion.outputPath);
            const sourceBytes = await readFile(document.pdf);
            const currentDocx = await inspectDocx(outputBytes);
            const explicitPreviousDocx = await loadDocxMetrics(document.previousDocx);
            const professionalDocx = await loadDocxMetrics(document.professionalDocx);
            const referenceDocx = await loadDocxMetrics(document.referenceDocx);
            const pdfText = !referenceDocx && !professionalDocx && !explicitPreviousDocx
                ? await extractPdfReference(document.pdf, document.pageRange)
                : "";
            const sourceReference = pdfText
                ? { text: pdfText, textProfile: null, cells: 0 }
                : null;
            const historic = historicDocument(previousHistory, document.id);
            const previousMetrics = explicitPreviousDocx || historic?.current?.docx || null;
            const gateReference = referenceDocx || explicitPreviousDocx || previousMetrics ||
                professionalDocx || sourceReference;
            const currentVisual = conversion.appResult?.report?.visualQuality?.status === "completed"
                ? conversion.appResult.report.visualQuality
                : await visualQuality(
                    document.pdf,
                    conversion.outputPath,
                    manifest.visionEndpoint,
                    document.pageRange,
                    Number(document.timeoutMs || manifest.timeoutMs || 1_800_000)
                );
            const previousVisual = document.previousDocx
                ? await visualQuality(document.pdf, document.previousDocx, manifest.visionEndpoint, document.pageRange, manifest.timeoutMs)
                : historic?.current?.visual || null;
            const professionalVisual = document.professionalDocx
                ? await visualQuality(document.pdf, document.professionalDocx, manifest.visionEndpoint, document.pageRange, manifest.timeoutMs)
                : null;
            const gate = evaluateQualityGate({
                currentVisual,
                previousVisual,
                currentDocx,
                previousDocx: gateReference,
                performance: {
                    peakBrowserHeapMB: conversion.peakBrowserHeapMB,
                },
                thresholds: { ...manifest.thresholds, ...document.thresholds },
            });
            const currentHash = sha256(outputBytes);
            const entry = {
                id: document.id,
                source: {
                    sha256: sha256(sourceBytes),
                    bytes: sourceBytes.length,
                    pageCount: currentVisual?.sourcePageCount ??
                        conversion.appResult?.report?.pageCount ?? null,
                    pageRange: document.pageRange || "all",
                    mode: document.mode || "editable",
                    ocrMode: document.ocrMode || "auto",
                },
                current: {
                    sha256: currentHash,
                    docx: publicDocxMetrics(currentDocx),
                    visual: currentVisual,
                    performance: {
                        wallDurationMs: conversion.durationMs,
                        peakBrowserHeapMB: conversion.peakBrowserHeapMB,
                        engineDurationMs: conversion.appResult?.report?.totalDurationMs || null,
                        pagesPerMinute: conversion.appResult?.report?.pagesPerMinute || null,
                        peakCanvasMegapixels: conversion.appResult?.report?.peakCanvasMegapixels || null,
                        outputBytes: outputBytes.length,
                    },
                    engine: {
                        conversionEngine: conversion.appResult?.report?.conversionEngine || null,
                        qualityOptimization: compactOptimizationDecision(
                            conversion.appResult?.report?.qualityOptimization
                        ),
                        nativeOptimization: compactOptimizationDecision(
                            conversion.appResult?.report?.nativeOptimization
                        ),
                    },
                    typography: conversion.appResult?.report?.typography || null,
                    extraction: conversion.appResult?.pages || [],
                    consoleErrors: conversion.consoleErrors,
                },
                comparisons: {
                    previous: previousMetrics ? {
                        text: compareText(previousMetrics, currentDocx),
                        docx: publicDocxMetrics(previousMetrics),
                        visual: previousVisual,
                        visualScoreGap: visualScoreGap(currentVisual, previousVisual),
                    } : null,
                    professional: professionalDocx ? {
                        text: compareText(professionalDocx, currentDocx),
                        docx: publicDocxMetrics(professionalDocx),
                        visual: professionalVisual,
                        visualScoreGap: visualScoreGap(currentVisual, professionalVisual),
                    } : null,
                    reference: referenceDocx ? compareText(referenceDocx, currentDocx) : sourceReference ? compareText(sourceReference, currentDocx) : null,
                },
                gate,
                passed: gate.passed,
            };
            report.documents.push(entry);
            report.passed &&= entry.passed;
            process.stdout.write(
                `E2E ${document.id}: ${entry.passed ? "APROBADO" : "RECHAZADO"} · visual ${currentVisual?.visualScore ?? "n/d"} · ${outputBytes.length} bytes\n`
            );
        }

        const reportPath = path.join(historyDirectory, `${runId}.json`);
        const artifactReportPath = path.join(artifactDirectory, "report.json");
        const serialized = `${JSON.stringify(report, null, 2)}\n`;
        await writeFile(artifactReportPath, serialized, "utf8");
        if (updateHistory) {
            await writeFile(reportPath, serialized, "utf8");
            await writeFile(path.join(historyDirectory, "latest.json"), serialized, "utf8");
        }
        process.stdout.write(`${compactRunSummary(
            report,
            updateHistory ? reportPath : artifactReportPath
        )}\n`);
        if (!report.passed) process.exitCode = 1;
    } finally {
        await browser?.close().catch(() => {});
        if (!keepServices) ownedProcesses.reverse().forEach(stopChild);
    }
}

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
