import { useEffect, useRef, useState } from "react";

import {
    buildQualityOptimizationReport,
    evaluateQualityRetryPages,
    mergeQualityRetryPages,
    selectPagesForQualityRetry,
    shouldApplyQualityRetry,
} from "../../engine/evaluation/QualityAutoOptimizer";
import {
    checkLocalDocumentService,
    validateRenderedWordDocument,
} from "../../engine/evaluation/VisualQualityProvider";
import { processPDFForWord } from "../../engine/pdf-to-word/HybridPDFProcessor";
import {
    convertWithNativeDocxCandidate,
    isNativeDocxCandidateEligible,
    shouldApplyNativeDocxCandidate,
} from "../../engine/pdf-to-word/NativeDocxCandidate";
import { renderWordDocument } from "../../engine/pdf-to-word/WordDocumentRenderer";
import PDFReviewWorkspace from "./PDFReviewWorkspace";
import "./PDFToWord.css";

const MODE_OPTIONS = [
    {
        id: "editable",
        title: "Máxima edición",
        description:
            "Texto, tablas, columnas, encabezados y estilos reconstruidos para poder modificarlos.",
        badge: "Recomendado",
        bestFor: "Contratos, informes y documentos digitales",
        features: ["Edición fluida", "Tablas Word", "Orden de lectura"],
    },
    {
        id: "fidelity",
        title: "Máxima fidelidad editable",
        description:
            "Reconstruye texto, tablas e imágenes como capas Word posicionadas sobre la página.",
        badge: "Diseño + edición",
        bestFor: "Escaneos, formularios y diseños complejos",
        features: ["Posición precisa", "Capas editables", "Elementos protegidos"],
    },
    {
        id: "visual",
        title: "Copia visual exacta",
        description:
            "Preserva cada página como imagen cuando el aspecto importa más que la edición.",
        badge: "Solo visual",
        bestFor: "Archivo, impresión y copia de seguridad",
        features: ["Aspecto exacto", "Sin reconstrucción", "Texto no editable"],
    },
];

const PAGE_TYPE_LABELS = {
    digital: "Digital",
    scanned: "Escaneada",
    hybrid: "Híbrida",
};

const METHOD_LABELS = {
    native: "Texto nativo",
    "adaptive-ocr": "OCR adaptativo",
    "vision-region-ocr": "Vision regional + OCR",
    "native+region-ocr": "Nativo + OCR regional",
    "native+neural-layout": "Nativo + estructura neuronal",
    "neural-layout": "Estructura neuronal + OCR",
    "visual-snapshot": "Captura visual",
};

const QUALITY_ISSUE_LABELS = {
    page_geometry_changed: "Geometría de página alterada",
    content_shift: "Contenido desplazado",
    low_content_overlap: "Bajo solapamiento del contenido",
    layout_mismatch: "Estructura visual diferente",
    missing_output_page: "Página ausente en Word",
    unexpected_output_page: "Página adicional en Word",
};

const DEFAULT_OPTIONS = {
    ocrMode: "",
    pageRange: "all",
    excludeImages: false,
    reviewBeforeDownload: true,
    validateVisualQuality: true,
    autoQualityRetry: true,
    qualityRetryThreshold: 70,
    maximumQualityRetryPages: 32,
    maximumCanvasMegapixels: 20,
    cacheMemoryMB: 96,
    ocrDictionary: "",
    experimentalHandwriting: false,
    advancedVision: true,
    cleanEditableBackground: true,
    visionProvider: "auto",
    visionEndpoint: "http://127.0.0.1:8765/v1/layout",
};

function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "0 KB";
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDuration(milliseconds) {
    const seconds = milliseconds / 1000;
    return seconds < 60
        ? `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
        : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

function parseOCRDictionary(value) {
    return String(value || "")
        .split(",")
        .map((word) => word.trim())
        .filter(Boolean);
}

function qualityLevel(score) {
    if (score >= 85) return { label: "Alta", tone: "excellent" };
    if (score >= 70) return { label: "Buena", tone: "good" };
    if (score >= 55) return { label: "Mejorable", tone: "warning" };
    return { label: "Requiere revisión", tone: "danger" };
}

function qualityIssueLabel(issue) {
    return QUALITY_ISSUE_LABELS[issue] || issue?.replaceAll("_", " ") || "Sin alertas";
}

function pageQualityRecommendation(page) {
    const issues = new Set(page?.issues || []);
    if (issues.has("page_geometry_changed")) {
        return "Revisa el tamaño, la orientación y los márgenes de esta página.";
    }
    if (issues.has("low_content_overlap")) {
        return "Comprueba tablas, imágenes, firmas y bloques que pudieron moverse.";
    }
    if (issues.has("content_shift")) {
        return "Ajusta anclajes o usa fidelidad editable para esta página.";
    }
    if (issues.has("layout_mismatch")) {
        return "Revisa columnas, cuadros de texto y el orden de lectura.";
    }
    return "Compara el texto y la posición en la revisión lado a lado.";
}

function PDFToWord() {
    const [file, setFile] = useState(null);
    const [mode, setMode] = useState("editable");
    const [converting, setConverting] = useState(false);
    const [canCancel, setCanCancel] = useState(false);
    const [paused, setPaused] = useState(false);
    const [progress, setProgress] = useState({
        percent: 0,
        detail: "Preparando el motor…",
    });
    const [error, setError] = useState("");
    const [downloadUrl, setDownloadUrl] = useState("");
    const [result, setResult] = useState(null);
    const [pendingModel, setPendingModel] = useState(null);
    const [options, setOptions] = useState(DEFAULT_OPTIONS);
    const [serviceHealth, setServiceHealth] = useState({ status: "checking" });
    const downloadUrlRef = useRef("");
    const runIdRef = useRef(0);
    const abortControllerRef = useRef(null);
    const pausedRef = useRef(false);
    const pauseWaitersRef = useRef([]);

    useEffect(
        () => () => {
            if (downloadUrlRef.current) {
                URL.revokeObjectURL(downloadUrlRef.current);
            }
        },
        []
    );

    useEffect(() => {
        let active = true;
        const refreshServiceHealth = () => {
            checkLocalDocumentService(options.visionEndpoint).then((health) => {
                if (active) setServiceHealth(health);
            });
        };
        refreshServiceHealth();
        const refreshTimer = setInterval(refreshServiceHealth, 15_000);
        return () => {
            active = false;
            clearInterval(refreshTimer);
        };
    }, [options.visionEndpoint]);

    const revokeDownload = () => {
        if (downloadUrlRef.current) {
            URL.revokeObjectURL(downloadUrlRef.current);
            downloadUrlRef.current = "";
        }
        setDownloadUrl("");
    };

    const resumeProcessing = () => {
        pausedRef.current = false;
        setPaused(false);
        pauseWaitersRef.current.splice(0).forEach((resolve) => resolve());
    };

    const waitIfPaused = () => {
        if (!pausedRef.current) return Promise.resolve();
        return new Promise((resolve) => pauseWaitersRef.current.push(resolve));
    };

    const togglePause = () => {
        if (pausedRef.current) {
            resumeProcessing();
            setProgress((current) => ({
                ...current,
                detail: "Reanudando desde el último límite seguro…",
            }));
            return;
        }
        pausedRef.current = true;
        setPaused(true);
        setProgress((current) => ({
            ...current,
            detail: "Pausa solicitada; se detendrá al terminar la región actual…",
        }));
    };

    const cancelProcessing = () => {
        resumeProcessing();
        abortControllerRef.current?.abort();
    };

    const handleFile = (selectedFile) => {
        if (!selectedFile) {
            return;
        }

        const isPDF =
            selectedFile.type === "application/pdf" ||
            selectedFile.name.toLowerCase().endsWith(".pdf");

        if (!isPDF) {
            setError("Selecciona un archivo PDF válido.");
            return;
        }

        revokeDownload();
        setFile(selectedFile);
        setOptions((current) => ({ ...current, ocrMode: "" }));
        setResult(null);
        setPendingModel(null);
        setError("");
        setProgress({ percent: 0, detail: "Listo para convertir." });
    };

    const handleInputChange = (event) => {
        handleFile(event.target.files?.[0]);
        event.target.value = "";
    };

    const handleDrop = (event) => {
        event.preventDefault();
        if (!converting) {
            handleFile(event.dataTransfer.files?.[0]);
        }
    };

    const clearFile = () => {
        cancelProcessing();
        runIdRef.current += 1;
        revokeDownload();
        setFile(null);
        setResult(null);
        setPendingModel(null);
        setError("");
        setProgress({ percent: 0, detail: "Preparando el motor…" });
    };

    const progressForRun = (runId) => (nextProgress) => {
        if (runIdRef.current !== runId) return;
        setProgress((current) => ({
            ...nextProgress,
            percent: Math.max(current.percent, nextProgress.percent || 0),
        }));
    };

    const finishWordDocument = async (model, runId) => {
        const initialRendered = await renderWordDocument(model, progressForRun(runId));
        if (runIdRef.current !== runId) return;

        let initialQuality = null;
        if (options.validateVisualQuality) {
            setProgress({
                percent: 98,
                stage: "visual-validation",
                detail: "Verificando el Word renderizado contra el PDF original…",
            });
            initialQuality = await validateRenderedWordDocument(file, initialRendered.blob, {
                pageNumbers: model.pages.map((page) => page.pageNumber),
                endpoint: options.visionEndpoint,
                signal: abortControllerRef.current?.signal,
            });
            if (runIdRef.current !== runId) return;
        }

        let selectedModel = model;
        let selectedRendered = initialRendered;
        let selectedQuality = initialQuality;
        let extraGenerationMs = 0;
        let extraValidationMs = 0;
        const retryEnabled =
            options.autoQualityRetry &&
            options.validateVisualQuality &&
            model.mode === "editable";
        let qualityOptimization = buildQualityOptimizationReport({
            enabled: retryEnabled,
            initialQuality,
            reason: !retryEnabled
                ? "disabled"
                : initialQuality?.status !== "completed"
                ? "validation-unavailable"
                : initialQuality.passed
                ? "target-achieved"
                : "no-risk-pages",
        });

        if (retryEnabled && initialQuality?.status === "completed" && !initialQuality.passed) {
            const retryPages = selectPagesForQualityRetry(model, initialQuality, {
                threshold: Number(options.qualityRetryThreshold),
                maximumPages: Number(options.maximumQualityRetryPages),
            });
            if (retryPages.length) {
                const retryStartedAt = performance.now();
                try {
                    setProgress({
                        percent: 98,
                        stage: "quality-optimization",
                        detail: `Reprocesando ${retryPages.length} página(s) débil(es) con fidelidad editable…`,
                    });
                    const retryModel = await processPDFForWord(file, {
                        mode: "fidelity",
                        ocrMode: model.options?.ocrMode || "auto",
                        pageRange: retryPages.join(","),
                        excludeImages: options.excludeImages,
                        maximumCanvasMegapixels: Number(options.maximumCanvasMegapixels),
                        cacheMemoryMB: Number(options.cacheMemoryMB),
                        ocrDictionary: parseOCRDictionary(options.ocrDictionary),
                        experimentalHandwriting: options.experimentalHandwriting,
                        advancedVision: options.advancedVision,
                        cleanEditableBackground: true,
                        visionProvider: options.visionProvider,
                        visionEndpoint: options.visionEndpoint,
                        signal: abortControllerRef.current?.signal,
                        waitIfPaused,
                        onProgress: (nextProgress) => {
                            if (runIdRef.current !== runId) return;
                            setProgress({
                                ...nextProgress,
                                percent: 98,
                                detail: `Segunda pasada · ${nextProgress.detail}`,
                            });
                        },
                        isCancelled: () => runIdRef.current !== runId,
                    });
                    if (runIdRef.current !== runId) return;

                    const candidateModel = mergeQualityRetryPages(
                        model,
                        retryModel,
                        retryPages
                    );
                    setProgress({
                        percent: 98,
                        stage: "quality-optimization",
                        detail: "Generando y comparando la versión corregida…",
                    });
                    const candidateRendered = await renderWordDocument(
                        candidateModel,
                        (nextProgress) => {
                            if (runIdRef.current !== runId) return;
                            setProgress({
                                ...nextProgress,
                                percent: 98,
                                detail: "Generando la versión corregida…",
                            });
                        }
                    );
                    extraGenerationMs = candidateRendered.generationMs;
                    const candidateQuality = await validateRenderedWordDocument(
                        file,
                        candidateRendered.blob,
                        {
                            pageNumbers: candidateModel.pages.map(
                                (page) => page.pageNumber
                            ),
                            endpoint: options.visionEndpoint,
                            signal: abortControllerRef.current?.signal,
                        }
                    );
                    extraValidationMs += candidateQuality.durationMs || 0;
                    const pageDecisions = evaluateQualityRetryPages(
                        initialQuality,
                        candidateQuality,
                        retryPages
                    );
                    const acceptedPages = pageDecisions
                        .filter((decision) => decision.accepted)
                        .map((decision) => decision.pageNumber);

                    let proposedModel = candidateModel;
                    let proposedRendered = candidateRendered;
                    let proposedQuality = candidateQuality;
                    if (
                        acceptedPages.length > 0 &&
                        acceptedPages.length < retryPages.length
                    ) {
                        setProgress({
                            percent: 98,
                            stage: "quality-optimization",
                            detail: `Conservando solo ${acceptedPages.length} página(s) que demostraron mejora…`,
                        });
                        proposedModel = mergeQualityRetryPages(
                            model,
                            retryModel,
                            acceptedPages
                        );
                        proposedRendered = await renderWordDocument(
                            proposedModel,
                            (nextProgress) => {
                                if (runIdRef.current !== runId) return;
                                setProgress({
                                    ...nextProgress,
                                    percent: 98,
                                    detail: "Generando la combinación óptima por página…",
                                });
                            }
                        );
                        extraGenerationMs += proposedRendered.generationMs;
                        proposedQuality = await validateRenderedWordDocument(
                            file,
                            proposedRendered.blob,
                            {
                                pageNumbers: proposedModel.pages.map(
                                    (page) => page.pageNumber
                                ),
                                endpoint: options.visionEndpoint,
                                signal: abortControllerRef.current?.signal,
                            }
                        );
                        extraValidationMs += proposedQuality.durationMs || 0;
                    }

                    const applied =
                        acceptedPages.length > 0 &&
                        shouldApplyQualityRetry(initialQuality, proposedQuality, 0);
                    if (applied) {
                        selectedModel = proposedModel;
                        selectedRendered = proposedRendered;
                        selectedQuality = proposedQuality;
                    }
                    const reportedDecisions = applied
                        ? pageDecisions
                        : pageDecisions.map((decision) =>
                            decision.accepted
                                ? {
                                    ...decision,
                                    accepted: false,
                                    reason: "final-document-regressed",
                                }
                                : decision
                        );
                    qualityOptimization = buildQualityOptimizationReport({
                        enabled: true,
                        attempted: true,
                        applied,
                        pages: retryPages,
                        pageDecisions: reportedDecisions,
                        initialQuality,
                        candidateQuality: proposedQuality,
                        durationMs: performance.now() - retryStartedAt,
                        reason: applied
                            ? acceptedPages.length === retryPages.length
                                ? "quality-improved-per-page"
                                : "partial-quality-improvement"
                            : acceptedPages.length
                                ? "candidate-rejected"
                                : "no-page-improvement",
                    });
                } catch (retryError) {
                    if (retryError?.name === "AbortError") throw retryError;
                    console.warn("Optimización visual omitida:", retryError);
                    qualityOptimization = buildQualityOptimizationReport({
                        enabled: true,
                        attempted: true,
                        pages: retryPages,
                        initialQuality,
                        durationMs: performance.now() - retryStartedAt,
                        reason: "retry-failed",
                    });
                }
            }
        }

        const nativeCandidateEnabled =
            retryEnabled &&
            serviceHealth.nativeDocxAvailable &&
            isNativeDocxCandidateEligible(model);
        let nativeOptimization = {
            enabled: nativeCandidateEnabled,
            attempted: false,
            applied: false,
            provider: serviceHealth.nativeDocxConverter || "pdf2docx",
            providerVersion: serviceHealth.nativeDocxVersion || null,
            scoreBefore: selectedQuality?.visualScore ?? null,
            candidateScore: null,
            durationMs: 0,
            reason: !nativeCandidateEnabled
                ? "not-eligible"
                : selectedQuality?.status !== "completed"
                  ? "validation-unavailable"
                  : selectedQuality.passed
                    ? "target-achieved"
                    : "not-attempted",
        };

        if (
            nativeCandidateEnabled &&
            selectedQuality?.status === "completed" &&
            !selectedQuality.passed
        ) {
            const nativeStartedAt = performance.now();
            const qualityBeforeNative = selectedQuality;
            try {
                setProgress({
                    percent: 99,
                    stage: "native-docx-candidate",
                    detail: "Comparando un segundo motor nativo para texto digital…",
                });
                const nativeRendered = await convertWithNativeDocxCandidate(file, {
                    pageNumbers: model.pages.map((page) => page.pageNumber),
                    endpoint: options.visionEndpoint,
                    signal: abortControllerRef.current?.signal,
                });
                if (runIdRef.current !== runId) return;
                extraGenerationMs += nativeRendered.generationMs || 0;
                const nativeQuality = await validateRenderedWordDocument(
                    file,
                    nativeRendered.blob,
                    {
                        pageNumbers: model.pages.map((page) => page.pageNumber),
                        endpoint: options.visionEndpoint,
                        signal: abortControllerRef.current?.signal,
                    }
                );
                extraValidationMs += nativeQuality.durationMs || 0;
                const applied = shouldApplyNativeDocxCandidate(
                    qualityBeforeNative,
                    nativeQuality
                );
                if (applied) {
                    selectedRendered = nativeRendered;
                    selectedQuality = nativeQuality;
                }
                nativeOptimization = {
                    enabled: true,
                    attempted: true,
                    applied,
                    provider: nativeRendered.provider,
                    providerVersion: nativeRendered.providerVersion,
                    scoreBefore: qualityBeforeNative.visualScore,
                    candidateScore: nativeQuality.status === "completed"
                        ? nativeQuality.visualScore
                        : null,
                    durationMs: performance.now() - nativeStartedAt,
                    reason: applied ? "native-candidate-improved" : "native-candidate-rejected",
                };
            } catch (nativeError) {
                if (nativeError?.name === "AbortError") throw nativeError;
                console.warn("Candidato DOCX nativo omitido:", nativeError);
                nativeOptimization = {
                    ...nativeOptimization,
                    attempted: true,
                    durationMs: performance.now() - nativeStartedAt,
                    reason: "native-candidate-failed",
                };
            }
        }

        const totalDurationMs =
            model.report.durationMs +
            initialRendered.generationMs +
            (initialQuality?.durationMs || 0) +
            qualityOptimization.durationMs +
            nativeOptimization.durationMs;
        const url = URL.createObjectURL(selectedRendered.blob);
        downloadUrlRef.current = url;
        setDownloadUrl(url);
        setPendingModel(null);
        setResult({
            report: {
                ...selectedModel.report,
                documentStructure: selectedModel.documentStructure,
                generationMs: initialRendered.generationMs + extraGenerationMs,
                visualValidationMs:
                    (initialQuality?.durationMs || 0) + extraValidationMs,
                visualQuality: selectedQuality,
                qualityOptimization,
                nativeOptimization,
                conversionEngine: nativeOptimization.applied
                    ? nativeOptimization.provider
                    : "novapdf-hybrid",
                totalDurationMs,
                pagesPerMinute: Number(
                    ((selectedModel.pages.length * 60_000) / totalDurationMs).toFixed(1)
                ),
                outputBytes: selectedRendered.blob.size,
            },
            pages: selectedModel.pages.map((page) => ({
                pageNumber: page.pageNumber,
                pageType: page.pageType,
                extractionMethod: page.extractionMethod,
                ocr: page.ocr,
                metrics: page.metrics,
            })),
        });
        setProgress({
            percent: 100,
            detail: nativeOptimization.applied
                ? "Documento Word terminado con el mejor motor nativo validado."
                : qualityOptimization.applied
                ? "Documento Word terminado con corrección automática de fidelidad."
                : "Documento Word terminado.",
        });
    };

    const handleConversionError = (conversionError, runId) => {
        if (runIdRef.current !== runId) return;
        if (conversionError?.name === "AbortError") {
            setProgress({ percent: 0, detail: "Conversión cancelada; el avance queda en caché." });
            return;
        }
        console.error("Error PDF a Word:", conversionError);
        setError(
            conversionError?.message ||
                "No se pudo convertir el PDF. Comprueba que el archivo no esté dañado."
        );
        setProgress({ percent: 0, detail: "La conversión no pudo completarse." });
    };

    const convertToWord = async () => {
        if (!file || converting) return;
        if (mode !== "visual" && !options.ocrMode) {
            setError("Antes de convertir, elige si quieres usar OCR.");
            return;
        }

        const runId = runIdRef.current + 1;
        const controller = new AbortController();
        runIdRef.current = runId;
        abortControllerRef.current = controller;
        resumeProcessing();
        revokeDownload();
        setPendingModel(null);
        setConverting(true);
        setCanCancel(true);
        setResult(null);
        setError("");
        setProgress({ percent: 1, detail: "Inicializando la conversión regional…" });

        try {
            const model = await processPDFForWord(file, {
                mode,
                ocrMode: mode === "visual" ? "never" : options.ocrMode,
                pageRange: options.pageRange,
                excludeImages: options.excludeImages,
                maximumCanvasMegapixels: Number(options.maximumCanvasMegapixels),
                cacheMemoryMB: Number(options.cacheMemoryMB),
                ocrDictionary: parseOCRDictionary(options.ocrDictionary),
                experimentalHandwriting: options.experimentalHandwriting,
                advancedVision: options.advancedVision,
                cleanEditableBackground: options.cleanEditableBackground,
                visionProvider: options.visionProvider,
                visionEndpoint: options.visionEndpoint,
                signal: controller.signal,
                waitIfPaused,
                onProgress: progressForRun(runId),
                isCancelled: () => runIdRef.current !== runId,
            });

            if (options.reviewBeforeDownload) {
                setPendingModel(model);
                setProgress({
                    percent: 92,
                    detail: "Análisis terminado. Revisa el documento antes de generarlo.",
                });
            } else {
                await finishWordDocument(model, runId);
            }
        } catch (conversionError) {
            handleConversionError(conversionError, runId);
        } finally {
            resumeProcessing();
            if (runIdRef.current === runId) setConverting(false);
            if (runIdRef.current === runId) setCanCancel(false);
            if (abortControllerRef.current === controller) {
                abortControllerRef.current = null;
            }
        }
    };

    const generateReviewedWord = async (model) => {
        if (converting) return;
        const runId = runIdRef.current + 1;
        runIdRef.current = runId;
        setConverting(true);
        setError("");
        try {
            await finishWordDocument(model, runId);
        } catch (generationError) {
            handleConversionError(generationError, runId);
        } finally {
            if (runIdRef.current === runId) setConverting(false);
        }
    };

    const downloadName = file
        ? `${file.name.replace(/\.pdf$/i, "")}-${mode}.docx`
        : "NovaPDF-documento.docx";
    const serviceStatus =
        serviceHealth.status === "ready"
            ? "Motor neuronal listo"
            : serviceHealth.status === "loading"
            ? "Cargando modelos neuronales"
            : serviceHealth.status === "idle"
            ? "Servicio listo para iniciar"
            : serviceHealth.status === "checking"
            ? "Comprobando motores locales"
            : "Servicio avanzado no disponible";
    const measuredQuality = result?.report.visualQuality;
    const resultQualityScore =
        measuredQuality?.status === "completed"
            ? measuredQuality.visualScore
            : result?.report.mode === "visual"
            ? 100
            : result?.report.estimatedQuality || 0;
    const resultQualityLevel = qualityLevel(resultQualityScore);
    const weakestPages =
        measuredQuality?.status === "completed"
            ? [...measuredQuality.pages]
                  .sort((first, second) => first.visualScore - second.visualScore)
                  .slice(0, 5)
            : [];

    return (
        <section className="pdf-word-page">
            <div className="pdf-word-header">
                <div className="pdf-word-badge">Motor híbrido NovaPDF</div>
                <div className="pdf-word-title-icon" aria-hidden="true">
                    <span>PDF</span>
                    <b>→</b>
                    <span>W</span>
                </div>
                <h1>PDF a Word avanzado</h1>
                <p>
                    Detecta automáticamente páginas digitales, escaneadas e híbridas y
                    elige la mejor estrategia para cada una.
                </p>
                <div className="pdf-word-capabilities" aria-label="Funciones del motor">
                    <span>Motor regional</span>
                    <span>Vision documental</span>
                    <span>OCR adaptativo</span>
                    <span>Tablas profesionales</span>
                    <span>Revisión y métricas</span>
                </div>
                <div className="pdf-word-pipeline" aria-label="Flujo de máxima calidad">
                    <span><b>1</b> Analiza regiones</span>
                    <i aria-hidden="true">→</i>
                    <span><b>2</b> Reconstruye Word</span>
                    <i aria-hidden="true">→</i>
                    <span><b>3</b> Verifica el resultado</span>
                    <i aria-hidden="true">→</i>
                    <span><b>4</b> Corrige páginas débiles</span>
                </div>
            </div>

            <div className="pdf-word-workspace">
                <div
                    className={`pdf-word-service-status is-${serviceHealth.status}`}
                    aria-live="polite"
                >
                    <div>
                        <span className="pdf-word-service-dot" aria-hidden="true" />
                        <div>
                            <strong>{serviceStatus}</strong>
                            <small>
                                Procesamiento privado en este equipo · NovaPDF Service {serviceHealth.version || "local"}
                            </small>
                        </div>
                    </div>
                    <div className="pdf-word-service-capabilities">
                        <span className={serviceHealth.modelLoaded ? "is-ready" : ""}>
                            PaddleOCR {serviceHealth.modelLoaded
                                ? "listo"
                                : serviceHealth.modelLoading
                                ? "cargando"
                                : serviceHealth.status === "unavailable"
                                ? "no conectado"
                                : "bajo demanda"}
                        </span>
                        <span className={serviceHealth.nativeExtractor ? "is-ready" : ""}>
                            {serviceHealth.nativeExtractor || "Extractor nativo"}
                        </span>
                        <span className={serviceHealth.nativeDocxAvailable ? "is-ready" : ""}>
                            DOCX nativo {serviceHealth.nativeDocxAvailable
                                ? `${serviceHealth.nativeDocxConverter || "listo"} ${serviceHealth.nativeDocxVersion || ""}`
                                : "no instalado"}
                        </span>
                        <span className={serviceHealth.rendererAvailable ? "is-ready" : ""}>
                            LibreOffice {serviceHealth.rendererAvailable ? "listo" : "no detectado"}
                        </span>
                    </div>
                </div>

                <div className="pdf-word-mode-section">
                    <div className="pdf-word-section-heading">
                        <span>1</span>
                        <div>
                            <h2>Elige el tipo de documento</h2>
                            <p>Puedes priorizar la edición o conservar el diseño exacto.</p>
                        </div>
                    </div>

                    <div className="pdf-word-modes">
                        {MODE_OPTIONS.map((option) => (
                            <button
                                key={option.id}
                                type="button"
                                className={`pdf-word-mode ${
                                    mode === option.id ? "pdf-word-mode-active" : ""
                                }`}
                                onClick={() => {
                                    if (!converting) {
                                        setMode(option.id);
                                        revokeDownload();
                                        setResult(null);
                                        setPendingModel(null);
                                        setProgress({
                                            percent: 0,
                                            detail: "Listo para convertir.",
                                        });
                                    }
                                }}
                                aria-pressed={mode === option.id}
                                disabled={converting}
                            >
                                <span className="pdf-word-mode-check" aria-hidden="true">
                                    {mode === option.id ? "✓" : ""}
                                </span>
                                <strong>{option.title}</strong>
                                <p>{option.description}</p>
                                <em>Ideal para: {option.bestFor}</em>
                                <ul>
                                    {option.features.map((feature) => (
                                        <li key={feature}>{feature}</li>
                                    ))}
                                </ul>
                                <small>{option.badge}</small>
                            </button>
                        ))}
                    </div>
                </div>

                <div className="pdf-word-upload-section">
                    <div className="pdf-word-section-heading">
                        <span>2</span>
                        <div>
                            <h2>Selecciona el PDF</h2>
                            <p>El archivo se procesa en este dispositivo.</p>
                        </div>
                    </div>

                    <div
                        className={`pdf-word-upload ${converting ? "pdf-word-upload-disabled" : ""}`}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={handleDrop}
                    >
                        <div className="pdf-word-upload-icon" aria-hidden="true">PDF</div>
                        <h3>Arrastra tu archivo aquí</h3>
                        <p>o selecciónalo desde tu computadora</p>
                        <label className="pdf-word-upload-button">
                            Seleccionar PDF
                            <input
                                type="file"
                                accept=".pdf,application/pdf"
                                onChange={handleInputChange}
                                disabled={converting}
                            />
                        </label>
                        <small>Documentos digitales, escaneados o mixtos</small>
                    </div>
                </div>

                {file && (
                    <div className="pdf-word-file">
                        <div className="pdf-word-file-icon">PDF</div>
                        <div className="pdf-word-file-info">
                            <strong>{file.name}</strong>
                            <small>
                                {formatFileSize(file.size)} · {MODE_OPTIONS.find((item) => item.id === mode)?.title}
                            </small>
                        </div>
                        <button
                            type="button"
                            className="pdf-word-clear"
                            onClick={clearFile}
                            disabled={converting}
                            aria-label="Quitar archivo"
                        >
                            ×
                        </button>
                    </div>
                )}

                {file && !pendingModel && !result && (
                    <section className="pdf-word-options" aria-labelledby="pdf-word-options-title">
                        <div className="pdf-word-section-heading">
                            <span>3</span>
                            <div>
                                <h2 id="pdf-word-options-title">Configura el procesamiento</h2>
                                <p>Controla rango, memoria, contenido y revisión.</p>
                            </div>
                        </div>
                        <div className="pdf-word-options-grid">
                            <label>
                                ¿Quieres usar OCR para reconocer el texto?
                                <select
                                    value={options.ocrMode}
                                    required={mode !== "visual"}
                                    disabled={converting || mode === "visual"}
                                    onChange={(event) => {
                                        setOptions((current) => ({ ...current, ocrMode: event.target.value }));
                                        setError("");
                                    }}
                                    aria-describedby="pdf-word-ocr-help"
                                >
                                    <option value="" disabled>Selecciona cómo extraer el texto</option>
                                    <option value="auto">Automático · recomendado</option>
                                    <option value="never">Sin OCR · extraer texto digital</option>
                                    <option value="always">Con OCR · reconocer todas las páginas</option>
                                </select>
                                <small id="pdf-word-ocr-help">
                                    {mode === "visual"
                                        ? "El modo visual conserva imágenes de las páginas: no usa OCR ni genera texto editable."
                                        : options.ocrMode === "always"
                                          ? "Reconoce el texto desde la imagen, incluso si ya existe texto digital. Puede tardar más, cambiar fuentes o introducir errores."
                                          : options.ocrMode === "never"
                                            ? "Conserva el texto digital. El texto dentro de imágenes no será editable; si una página no tiene texto extraíble, se detendrá con un aviso."
                                            : "Usa texto nativo en páginas digitales y OCR en escaneadas o mixtas. Activar OCR no mejora automáticamente todos los PDF."}
                                </small>
                            </label>
                            <label>
                                Rango de páginas
                                <input
                                    value={options.pageRange}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            pageRange: event.target.value,
                                        }))
                                    }
                                    placeholder="all o 1-5,8,12"
                                    disabled={converting}
                                />
                                <small>Usa “all” o, por ejemplo, 1-5,8,12.</small>
                            </label>
                            <label>
                                Límite de render
                                <select
                                    value={options.maximumCanvasMegapixels}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            maximumCanvasMegapixels: event.target.value,
                                        }))
                                    }
                                    disabled={converting}
                                >
                                    <option value="12">12 MP · memoria baja</option>
                                    <option value="20">20 MP · equilibrado</option>
                                    <option value="32">32 MP · máxima precisión</option>
                                </select>
                            </label>
                            <label>
                                Motor de visión documental
                                <select
                                    value={options.visionProvider}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            visionProvider: event.target.value,
                                        }))
                                    }
                                    disabled={converting || !options.advancedVision}
                                >
                                    <option value="auto">Neuronal local + respaldo automático</option>
                                    <option value="local">Visión integrada sin servidor</option>
                                    <option value="neural-local">Priorizar proveedor neuronal local</option>
                                </select>
                            </label>
                            <label>
                                Servicio neuronal local
                                <input
                                    value={options.visionEndpoint}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            visionEndpoint: event.target.value,
                                        }))
                                    }
                                    disabled={
                                        converting ||
                                        !options.advancedVision ||
                                        options.visionProvider === "local"
                                    }
                                    placeholder="http://127.0.0.1:8765/v1/layout"
                                />
                                <small>Por privacidad solo se aceptan servicios de este equipo.</small>
                            </label>
                            <label>
                                Caché de reanudación
                                <select
                                    value={options.cacheMemoryMB}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            cacheMemoryMB: event.target.value,
                                        }))
                                    }
                                    disabled={converting}
                                >
                                    <option value="48">48 MB</option>
                                    <option value="96">96 MB</option>
                                    <option value="192">192 MB</option>
                                </select>
                            </label>
                            <label>
                                Diccionario OCR especializado
                                <input
                                    value={options.ocrDictionary}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            ocrDictionary: event.target.value,
                                        }))
                                    }
                                    placeholder="NovaPDF, expediente, RUC…"
                                    disabled={converting}
                                />
                                <small>Palabras separadas por comas.</small>
                            </label>
                            <label>
                                Umbral de segunda pasada
                                <select
                                    value={options.qualityRetryThreshold}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            qualityRetryThreshold: event.target.value,
                                        }))
                                    }
                                    disabled={
                                        converting ||
                                        mode !== "editable" ||
                                        !options.validateVisualQuality ||
                                        !options.autoQualityRetry
                                    }
                                >
                                    <option value="55">55% · Solo casos críticos</option>
                                    <option value="62">62% · Equilibrado</option>
                                    <option value="70">70% · Calidad exigente</option>
                                </select>
                                <small>Reprocesa solo páginas por debajo de esta fidelidad.</small>
                            </label>
                            <label>
                                Máximo de páginas a corregir
                                <select
                                    value={options.maximumQualityRetryPages}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            maximumQualityRetryPages: event.target.value,
                                        }))
                                    }
                                    disabled={
                                        converting ||
                                        mode !== "editable" ||
                                        !options.validateVisualQuality ||
                                        !options.autoQualityRetry
                                    }
                                >
                                    <option value="4">4 páginas · rápido</option>
                                    <option value="8">8 páginas · documento corto</option>
                                    <option value="12">12 páginas · equilibrado</option>
                                    <option value="32">32 páginas · documento extenso</option>
                                    <option value="64">64 páginas · revisión completa</option>
                                </select>
                                <small>Corrige por página sin degradar las que ya superaron la validación.</small>
                            </label>
                        </div>
                        <div className="pdf-word-option-checks">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.reviewBeforeDownload}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            reviewBeforeDownload: event.target.checked,
                                        }))
                                    }
                                    disabled={converting}
                                />
                                Revisar lado a lado antes de generar
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.validateVisualQuality}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            validateVisualQuality: event.target.checked,
                                        }))
                                    }
                                    disabled={converting}
                                />
                                Verificar el DOCX con LibreOffice
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.autoQualityRetry}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            autoQualityRetry: event.target.checked,
                                        }))
                                    }
                                    disabled={
                                        converting ||
                                        mode !== "editable" ||
                                        !options.validateVisualQuality
                                    }
                                />
                                Corregir automáticamente las páginas débiles
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.excludeImages}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            excludeImages: event.target.checked,
                                        }))
                                    }
                                    disabled={converting}
                                />
                                Excluir todas las imágenes
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.advancedVision}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            advancedVision: event.target.checked,
                                        }))
                                    }
                                    disabled={converting}
                                />
                                Análisis visual previo al OCR
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.cleanEditableBackground}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            cleanEditableBackground: event.target.checked,
                                        }))
                                    }
                                    disabled={converting || mode !== "fidelity"}
                                />
                                Fondo limpio sin letras duplicadas
                            </label>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={options.experimentalHandwriting}
                                    onChange={(event) =>
                                        setOptions((current) => ({
                                            ...current,
                                            experimentalHandwriting: event.target.checked,
                                        }))
                                    }
                                    disabled={converting}
                                />
                                Probar escritura manual (experimental)
                            </label>
                        </div>
                    </section>
                )}

                {(converting || progress.percent > 0) && file && (
                    <div className="pdf-word-progress" aria-live="polite">
                        <div className="pdf-word-progress-header">
                            <div>
                                <strong>{progress.detail}</strong>
                                {progress.pageNumber && (
                                    <small>
                                        Página {progress.pageNumber} de {progress.pageCount}
                                        {progress.etaMs > 0 &&
                                            ` · faltan aprox. ${formatDuration(progress.etaMs)}`}
                                    </small>
                                )}
                            </div>
                            <strong>{progress.percent}%</strong>
                        </div>
                        <div
                            className="pdf-word-progress-bar"
                            role="progressbar"
                            aria-valuemin="0"
                            aria-valuemax="100"
                            aria-valuenow={progress.percent}
                        >
                            <div
                                className="pdf-word-progress-fill"
                                style={{ width: `${progress.percent}%` }}
                            />
                        </div>
                    </div>
                )}

                {error && <div className="pdf-word-error">{error}</div>}

                {converting && canCancel && (
                    <div className="pdf-word-process-controls">
                        <button
                            type="button"
                            className="pdf-word-pause-button"
                            onClick={togglePause}
                        >
                            {paused ? "Reanudar procesamiento" : "Pausar después de esta región"}
                        </button>
                        <button
                            type="button"
                            className="pdf-word-cancel-button"
                            onClick={cancelProcessing}
                        >
                            Cancelar y conservar avance
                        </button>
                    </div>
                )}

                {file && !downloadUrl && !pendingModel && (
                    <button
                        type="button"
                        className="pdf-word-convert-button"
                        onClick={convertToWord}
                        disabled={converting}
                    >
                        {converting ? "Convirtiendo con el motor híbrido…" : "Convertir a Word"}
                    </button>
                )}

                {pendingModel && (
                    <PDFReviewWorkspace
                        file={file}
                        model={pendingModel}
                        onChange={setPendingModel}
                        onGenerate={generateReviewedWord}
                        generating={converting}
                    />
                )}

                {result && (
                    <section className="pdf-word-report" aria-labelledby="pdf-word-report-title">
                        <div className="pdf-word-report-heading">
                            <div>
                                <span className="pdf-word-success-mark">✓</span>
                                <div>
                                    <h2 id="pdf-word-report-title">Conversión completada</h2>
                                    <p>NovaPDF analizó y reconstruyó {result.report.pageCount} página(s).</p>
                                </div>
                            </div>
                            <span className={`pdf-word-quality is-${resultQualityLevel.tone}`}>
                                {result.report.visualQuality?.status === "completed"
                                    ? `${result.report.visualQuality.visualScore}% fidelidad verificada`
                                    : result.report.mode === "visual"
                                    ? "100% fidelidad visual"
                                    : `${result.report.estimatedQuality}% calidad estimada`}
                            </span>
                        </div>

                        <div className="pdf-word-quality-dashboard">
                            <div
                                className={`pdf-word-score-ring is-${resultQualityLevel.tone}`}
                                style={{
                                    background: `conic-gradient(#2563eb ${resultQualityScore}%, #e2e8f0 0)`,
                                }}
                                aria-label={`${resultQualityScore}% de fidelidad`}
                            >
                                <div>
                                    <strong>{resultQualityScore}%</strong>
                                    <span>fidelidad</span>
                                </div>
                            </div>
                            <div className="pdf-word-quality-summary">
                                <span>Resultado medido</span>
                                <h3>{resultQualityLevel.label}</h3>
                                <p>
                                    {measuredQuality?.status === "completed"
                                        ? `Objetivo: ${measuredQuality.targetScore}%. Se compararon ${measuredQuality.comparedPageCount} página(s) renderizadas.`
                                        : "Activa la verificación con LibreOffice para medir la fidelidad real del Word."}
                                </p>
                                <div className="pdf-word-quality-track">
                                    <span style={{ width: `${resultQualityScore}%` }} />
                                    <i style={{ left: `${measuredQuality?.targetScore || 85}%` }} />
                                </div>
                            </div>
                            {result.report.qualityOptimization?.attempted && (
                                <div
                                    className={`pdf-word-optimization-result ${
                                        result.report.qualityOptimization.applied
                                            ? "is-applied"
                                            : "is-kept"
                                    }`}
                                >
                                    <strong>
                                        {result.report.qualityOptimization.applied
                                            ? "Corrección automática aplicada"
                                            : "Se conservó la mejor versión"}
                                    </strong>
                                    <span>
                                        {result.report.qualityOptimization.pages.length} página(s) evaluada(s)
                                        {result.report.qualityOptimization.applied
                                            ? ` · ${result.report.qualityOptimization.acceptedPages.length} mejorada(s)`
                                            : ""} · {result.report.qualityOptimization.scoreBefore}% → {result.report.qualityOptimization.candidateScore === null
                                            ? "sin medición"
                                            : `${result.report.qualityOptimization.candidateScore}%`}
                                    </span>
                                </div>
                            )}
                            {result.report.nativeOptimization?.attempted && (
                                <div
                                    className={`pdf-word-optimization-result ${
                                        result.report.nativeOptimization.applied
                                            ? "is-applied"
                                            : "is-kept"
                                    }`}
                                >
                                    <strong>
                                        {result.report.nativeOptimization.applied
                                            ? "Segundo motor nativo seleccionado"
                                            : "Segundo motor nativo evaluado"}
                                    </strong>
                                    <span>
                                        {result.report.nativeOptimization.provider}
                                        {result.report.nativeOptimization.providerVersion
                                            ? ` ${result.report.nativeOptimization.providerVersion}`
                                            : ""} · {result.report.nativeOptimization.scoreBefore ?? "—"}% → {result.report.nativeOptimization.candidateScore === null
                                            ? "sin medición"
                                            : `${result.report.nativeOptimization.candidateScore}%`}
                                    </span>
                                </div>
                            )}
                        </div>

                        <div className="pdf-word-quick-metrics">
                            <article><strong>{result.report.pageCount}</strong><span>Páginas</span></article>
                            <article><strong>{result.report.tableCount}</strong><span>Tablas</span></article>
                            <article><strong>{formatDuration(result.report.totalDurationMs)}</strong><span>Tiempo total</span></article>
                            <article><strong>{formatFileSize(result.report.outputBytes)}</strong><span>DOCX final</span></article>
                        </div>

                        {weakestPages.length > 0 && resultQualityScore < 85 && (
                            <section className="pdf-word-weak-pages" aria-labelledby="weak-pages-title">
                                <div>
                                    <span>Control de calidad</span>
                                    <h3 id="weak-pages-title">Páginas que conviene revisar</h3>
                                </div>
                                <div className="pdf-word-weak-page-grid">
                                    {weakestPages.map((page) => (
                                        <article key={`weak-${page.sourcePageNumber}`}>
                                            <div>
                                                <strong>Página {page.sourcePageNumber}</strong>
                                                <b>{page.visualScore}%</b>
                                            </div>
                                            <span>
                                                {page.issues.map(qualityIssueLabel).join(" · ") || "Fidelidad por debajo del objetivo"}
                                            </span>
                                            <p>{pageQualityRecommendation(page)}</p>
                                        </article>
                                    ))}
                                </div>
                            </section>
                        )}

                        <details className="pdf-word-technical-details">
                            <summary>Ver métricas técnicas del procesamiento</summary>
                            <div className="pdf-word-metrics">
                            <article>
                                <strong>{result.report.pageTypes.digital}</strong>
                                <span>Digitales</span>
                            </article>
                            <article>
                                <strong>{result.report.pageTypes.scanned}</strong>
                                <span>Escaneadas</span>
                            </article>
                            <article>
                                <strong>{result.report.pageTypes.hybrid}</strong>
                                <span>Híbridas</span>
                            </article>
                            <article>
                                <strong>{result.report.tableCount}</strong>
                                <span>Tablas</span>
                            </article>
                            <article>
                                <strong>{result.report.secondaryNativePages || 0}</strong>
                                <span>Páginas verificadas por doble motor</span>
                            </article>
                            <article>
                                <strong>{result.report.secondaryNativeTables || 0}</strong>
                                <span>Tablas del segundo extractor</span>
                            </article>
                            <article>
                                <strong>{result.report.regionCount}</strong>
                                <span>Regiones</span>
                            </article>
                            <article>
                                <strong>{result.report.visualRegionCount || 0}</strong>
                                <span>Regiones visuales</span>
                            </article>
                            <article>
                                <strong>{result.report.protectedVisualRegions || 0}</strong>
                                <span>Firmas y elementos protegidos</span>
                            </article>
                            <article>
                                <strong>{result.report.cleanedBackgroundWords || 0}</strong>
                                <span>Letras retiradas del fondo</span>
                            </article>
                            <article>
                                <strong>{result.report.neuralVisionPages || 0}</strong>
                                <span>Páginas con visión neuronal</span>
                            </article>
                            <article>
                                <strong>{result.report.neuralFallbackPages || 0}</strong>
                                <span>Respaldos automáticos</span>
                            </article>
                            <article>
                                <strong>{result.report.neuralTableRegions || 0}</strong>
                                <span>Tablas neuronales</span>
                            </article>
                            <article>
                                <strong>{result.report.neuralFormulaRegions || 0}</strong>
                                <span>Fórmulas editables</span>
                            </article>
                            <article>
                                <strong>{result.report.handwritingRegions || 0}</strong>
                                <span>Regiones manuscritas</span>
                            </article>
                            <article>
                                <strong>{result.report.formFieldCount}</strong>
                                <span>Campos de formulario</span>
                            </article>
                            <article>
                                <strong>{result.report.lowConfidenceRegions}</strong>
                                <span>Regiones a revisar</span>
                            </article>
                            <article>
                                <strong>{result.report.cacheHits}</strong>
                                <span>Páginas reanudadas</span>
                            </article>
                            <article>
                                <strong>{result.report.embeddedImageCount}</strong>
                                <span>Imágenes recuperadas</span>
                            </article>
                            <article>
                                <strong>{formatDuration(result.report.totalDurationMs)}</strong>
                                <span>Tiempo</span>
                            </article>
                            <article>
                                <strong>{result.report.pagesPerMinute}</strong>
                                <span>Páginas/min</span>
                            </article>
                            <article>
                                <strong>{result.report.peakCanvasMegapixels} MP</strong>
                                <span>Pico de render</span>
                            </article>
                            <article>
                                <strong>{formatFileSize(result.report.outputBytes)}</strong>
                                <span>Word generado</span>
                            </article>
                            {result.report.visualQuality?.status === "completed" && (
                                <>
                                    <article>
                                        <strong>{result.report.visualQuality.visualScore}%</strong>
                                        <span>Fidelidad visual real</span>
                                    </article>
                                    <article>
                                        <strong>
                                            {result.report.visualQuality.outputPageCount}/
                                            {result.report.visualQuality.sourcePageCount}
                                        </strong>
                                        <span>Páginas Word/original</span>
                                    </article>
                                    <article>
                                        <strong>{result.report.visualQuality.issues.length}</strong>
                                        <span>Alertas geométricas</span>
                                    </article>
                                </>
                            )}
                            </div>
                        </details>

                        {result.report.visualQuality?.status === "completed" && (
                            <details className="pdf-word-page-details">
                                <summary>Ver validación visual de LibreOffice</summary>
                                <div className="pdf-word-page-table-wrap">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>Página PDF</th>
                                                <th>Página Word</th>
                                                <th>Fidelidad</th>
                                                <th>Tinta</th>
                                                <th>Bordes</th>
                                                <th>Desplazamiento X/Y</th>
                                                <th>Alertas</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {result.report.visualQuality.pages.map((page) => (
                                                <tr key={`${page.sourcePageNumber}-${page.outputPageNumber}`}>
                                                    <td>{page.sourcePageNumber}</td>
                                                    <td>{page.outputPageNumber}</td>
                                                    <td>{page.visualScore}%</td>
                                                    <td>{page.inkOverlap}%</td>
                                                    <td>{page.edgeSimilarity}%</td>
                                                    <td>
                                                        {page.horizontalShiftPoints} / {page.verticalShiftPoints} pt
                                                    </td>
                                                    <td>{page.issues.map(qualityIssueLabel).join(", ") || "—"}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </details>
                        )}

                        {result.report.visualQuality?.status === "unavailable" && (
                            <p className="pdf-word-quality-warning">
                                El Word se generó correctamente, pero no pudo verificarse con
                                LibreOffice: {result.report.visualQuality.error}
                            </p>
                        )}

                        <details className="pdf-word-page-details">
                            <summary>Ver diagnóstico por página</summary>
                            <div className="pdf-word-page-table-wrap">
                                <table>
                                    <thead>
                                        <tr>
                                            <th>Página</th>
                                            <th>Tipo</th>
                                            <th>Método</th>
                                            <th>Palabras</th>
                                            <th>Columnas</th>
                                            <th>Tablas</th>
                                            <th>Imágenes</th>
                                            <th>Regiones</th>
                                            <th>Idioma OCR</th>
                                            <th>Calidad</th>
                                            <th>Tiempo</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {result.pages.map((page) => (
                                            <tr key={page.pageNumber}>
                                                <td>{page.pageNumber}</td>
                                                <td>
                                                    <span className={`pdf-word-page-type pdf-word-page-type-${page.pageType.type}`}>
                                                        {PAGE_TYPE_LABELS[page.pageType.type]}
                                                    </span>
                                                </td>
                                                <td>{METHOD_LABELS[page.extractionMethod]}</td>
                                                <td>{page.metrics.wordCount}</td>
                                                <td>{page.metrics.columnCount}</td>
                                                <td>{page.metrics.tableCount}</td>
                                                <td>{page.metrics.embeddedImageCount}</td>
                                                <td>{page.metrics.regionCount}</td>
                                                <td>{page.ocr?.language || "—"}</td>
                                                <td>{page.metrics.qualityScore}%</td>
                                                <td>{formatDuration(page.metrics.durationMs)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </details>

                        <p className="pdf-word-quality-note">
                            {result.report.mode === "visual"
                                ? "La copia visual prioriza la apariencia y no la edición del contenido."
                                : "Los modos editables generan texto, tablas, imágenes y capas Word; CER y WER pueden medirse en la revisión con una transcripción de referencia."}
                        </p>

                        <a
                            className="pdf-word-download"
                            href={downloadUrl}
                            download={downloadName}
                        >
                            Descargar documento Word
                        </a>
                    </section>
                )}
            </div>
        </section>
    );
}

export default PDFToWord;
