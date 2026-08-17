import {
    calculateGeometricFidelity,
    calculateReadingOrderScore,
    calculateTableAccuracy,
    evaluateText,
} from "./EvaluationMetrics.js";

function average(values = []) {
    const usable = values.map(Number).filter(Number.isFinite);
    return usable.length
        ? Number((usable.reduce((total, value) => total + value, 0) / usable.length).toFixed(2))
        : 0;
}

export function evaluateDocumentSample(sample = {}) {
    const reference = sample.reference || {};
    const hypothesis = sample.hypothesis || {};
    const text = evaluateText(reference.text || "", hypothesis.text || "");
    const tables = (reference.tables || []).map((table, index) =>
        calculateTableAccuracy(table, hypothesis.tables?.[index] || [])
    );
    const geometry = (reference.regions || []).map((region, index) =>
        calculateGeometricFidelity(
            region.bbox || region,
            hypothesis.regions?.[index]?.bbox || hypothesis.regions?.[index] || {}
        )
    );
    const readingOrder = calculateReadingOrderScore(
        reference.readingOrder || [],
        hypothesis.readingOrder || []
    );

    return {
        id: sample.id || "sample",
        cer: Number((text.cer.cer * 100).toFixed(2)),
        wer: Number((text.wer.wer * 100).toFixed(2)),
        textAccuracy: average([text.cer.accuracy, text.wer.accuracy]),
        tableAccuracy: tables.length
            ? average(tables.map((metric) => metric.accuracy))
            : 100,
        readingOrder: readingOrder.score,
        geometricFidelity: geometry.length
            ? average(geometry.map((metric) => metric.score))
            : 100,
        durationMs: Number(sample.performance?.durationMs) || 0,
        peakMemoryMB: Number(sample.performance?.peakMemoryMB) || 0,
        outputBytes: Number(sample.performance?.outputBytes) || 0,
        pageCount: Number(sample.performance?.pageCount) || 1,
    };
}

export function evaluateCorpus(samples = []) {
    const documents = samples.map(evaluateDocumentSample);
    const pages = documents.reduce((total, document) => total + document.pageCount, 0);
    const durationMs = documents.reduce((total, document) => total + document.durationMs, 0);

    return {
        documentCount: documents.length,
        pageCount: pages,
        cer: average(documents.map((document) => document.cer)),
        wer: average(documents.map((document) => document.wer)),
        textAccuracy: average(documents.map((document) => document.textAccuracy)),
        tableAccuracy: average(documents.map((document) => document.tableAccuracy)),
        readingOrder: average(documents.map((document) => document.readingOrder)),
        geometricFidelity: average(
            documents.map((document) => document.geometricFidelity)
        ),
        peakMemoryMB: Math.max(0, ...documents.map((document) => document.peakMemoryMB)),
        durationMs,
        millisecondsPerPage: pages ? Number((durationMs / pages).toFixed(2)) : 0,
        pagesPerMinute: durationMs
            ? Number(((pages * 60_000) / durationMs).toFixed(2))
            : 0,
        outputBytes: documents.reduce(
            (total, document) => total + document.outputBytes,
            0
        ),
        documents,
    };
}
