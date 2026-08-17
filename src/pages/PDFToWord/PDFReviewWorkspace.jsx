import { useEffect, useMemo, useState } from "react";

import { evaluateText } from "../../engine/evaluation/EvaluationMetrics";

function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

const REGION_LABELS = {
    text: "Texto",
    heading: "Titulo",
    table: "Tabla",
    photo: "Foto",
    graphic: "Grafico",
    signature: "Firma",
    stamp: "Sello",
    scribble: "Rallon",
    stain: "Mancha",
    formula: "Formula",
    "form-field": "Formulario",
    "list-item": "Lista",
    handwriting: "Manuscrito",
    "page-header": "Encabezado",
    "page-footer": "Pie",
};

function originalPageText(page) {
    return (page.analysis?.paragraphs || [])
        .map((paragraph) => cleanText(paragraph.text))
        .filter(Boolean)
        .join("\n\n");
}

function PDFReviewWorkspace({ file, model, onChange, onGenerate, generating }) {
    const [pageIndex, setPageIndex] = useState(0);
    const [previewUrl] = useState(() => URL.createObjectURL(file));
    const [referenceText, setReferenceText] = useState("");
    const page = model.pages[pageIndex];
    const editableText = page?.review?.correctedText || originalPageText(page);

    useEffect(() => {
        return () => URL.revokeObjectURL(previewUrl);
    }, [previewUrl]);

    const uncertainWords = useMemo(
        () =>
            (page?.content?.words || []).filter(
                (word) =>
                    String(word.source || "").includes("ocr") &&
                    Number(word.confidence) < 70
            ),
        [page]
    );
    const evaluation = useMemo(
        () => (cleanText(referenceText) ? evaluateText(referenceText, editableText) : null),
        [editableText, referenceText]
    );

    if (!page) return null;

    const updatePageReview = (patch) => {
        const pages = model.pages.map((candidate, index) =>
            index === pageIndex
                ? {
                    ...candidate,
                    review: { ...candidate.review, ...patch },
                }
                : candidate
        );
        onChange({ ...model, pages });
    };

    return (
        <section className="pdf-review" aria-labelledby="pdf-review-title">
            <div className="pdf-review-heading">
                <div>
                    <span>Control de calidad</span>
                    <h2 id="pdf-review-title">Revisión lado a lado</h2>
                    <p>
                        Corrige palabras dudosas y cambia la reconstrucción antes de crear
                        el Word.
                    </p>
                </div>
                <div className="pdf-review-pagination">
                    <button
                        type="button"
                        onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
                        disabled={pageIndex === 0}
                    >
                        ←
                    </button>
                    <strong>
                        Página {page.pageNumber} · {pageIndex + 1}/{model.pages.length}
                    </strong>
                    <button
                        type="button"
                        onClick={() =>
                            setPageIndex((index) =>
                                Math.min(model.pages.length - 1, index + 1)
                            )
                        }
                        disabled={pageIndex === model.pages.length - 1}
                    >
                        →
                    </button>
                </div>
            </div>

            <div className="pdf-review-toolbar">
                <label>
                    Estrategia de esta página
                    <select
                        value={page.review?.strategy || "automatic"}
                        onChange={(event) =>
                            updatePageReview({ strategy: event.target.value })
                        }
                    >
                        <option value="automatic">Automática</option>
                        <option value="editable">Flujo muy editable</option>
                        <option value="fidelity">Capas posicionadas</option>
                        {page.renderedPage && (
                            <option value="visual">Captura visual</option>
                        )}
                    </select>
                </label>
                <label className="pdf-review-check">
                    <input
                        type="checkbox"
                        checked={Boolean(page.review?.excludeHeader)}
                        onChange={(event) =>
                            updatePageReview({ excludeHeader: event.target.checked })
                        }
                    />
                    Excluir encabezado
                </label>
                <label className="pdf-review-check">
                    <input
                        type="checkbox"
                        checked={Boolean(page.review?.excludeFooter)}
                        onChange={(event) =>
                            updatePageReview({ excludeFooter: event.target.checked })
                        }
                    />
                    Excluir pie
                </label>
                <label className="pdf-review-check">
                    <input
                        type="checkbox"
                        checked={Boolean(page.review?.excludeImages)}
                        onChange={(event) =>
                            updatePageReview({ excludeImages: event.target.checked })
                        }
                    />
                    Excluir imágenes
                </label>
            </div>

            <div
                className={`pdf-review-vision-status ${
                    page.vision?.neural?.status === "connected"
                        ? "is-connected"
                        : page.vision?.neural?.status === "fallback"
                          ? "is-fallback"
                          : "is-local"
                }`}
            >
                <strong>
                    {page.vision?.neural?.status === "connected"
                        ? `Visión neuronal: ${page.vision.provider}`
                        : page.vision?.neural?.status === "fallback"
                          ? "Respaldo visual automático activo"
                          : "Visión integrada de NovaPDF"}
                </strong>
                <span>
                    {page.vision?.neural?.status === "fallback"
                        ? page.vision.neural.reason
                        : `${page.vision?.regions?.length || 0} regiones detectadas`}
                </span>
            </div>

            <div className="pdf-review-grid">
                <article className="pdf-review-pane">
                    <header>
                        <strong>PDF original</strong>
                        <span>{page.pageType.type}</span>
                    </header>
                    {previewUrl && (
                        <iframe
                            title={`PDF original, página ${page.pageNumber}`}
                            src={`${previewUrl}#page=${page.pageNumber}&view=FitH`}
                        />
                    )}
                </article>

                <article className="pdf-review-pane pdf-review-reconstruction">
                    <header>
                        <strong>Reconstrucción editable</strong>
                        <span className={uncertainWords.length ? "is-warning" : "is-clean"}>
                            {uncertainWords.length} palabra(s) dudosa(s)
                        </span>
                    </header>
                    <div
                        className="pdf-review-region-map"
                        style={{
                            aspectRatio: `${page.dimensions.width} / ${page.dimensions.height}`,
                        }}
                        aria-label="Mapa de regiones detectadas"
                    >
                        {(page.regionAnalysis?.regions || []).map((region) => {
                            const bbox = region.bbox || {};
                            return (
                                <span
                                    key={region.id}
                                    className={`pdf-review-region pdf-review-region-${region.type}`}
                                    style={{
                                        left: `${(Number(bbox.x || 0) / page.dimensions.width) * 100}%`,
                                        top: `${(Number(bbox.y || 0) / page.dimensions.height) * 100}%`,
                                        width: `${(Number(bbox.width || 0) / page.dimensions.width) * 100}%`,
                                        height: `${(Number(bbox.height || 0) / page.dimensions.height) * 100}%`,
                                    }}
                                    title={`${REGION_LABELS[region.type] || region.type} · ${Math.round(Number(region.confidence || 0))}%`}
                                >
                                    <small>{REGION_LABELS[region.type] || region.type}</small>
                                </span>
                            );
                        })}
                        {!page.regionAnalysis?.regions?.length && (
                            <p>No se detectaron regiones posicionables.</p>
                        )}
                    </div>
                    <div className="pdf-review-region-legend">
                        <span>Azul: texto editable</span>
                        <span>Naranja: firma, sello o elemento protegido</span>
                        <span>Morado: tabla o formula</span>
                    </div>
                    <textarea
                        value={editableText}
                        onChange={(event) =>
                            updatePageReview({ correctedText: event.target.value })
                        }
                        spellCheck="true"
                        aria-label="Texto reconstruido editable"
                    />
                    {uncertainWords.length > 0 && (
                        <div className="pdf-review-uncertain">
                            <strong>Revisar:</strong>
                            {uncertainWords.slice(0, 24).map((word, index) => (
                                <span key={`${word.text}-${index}`}>
                                    {word.text} · {Math.round(Number(word.confidence))}%
                                </span>
                            ))}
                        </div>
                    )}
                </article>
            </div>

            <details className="pdf-review-evaluation">
                <summary>Evaluación científica con transcripción de referencia</summary>
                <p>
                    Pega el texto correcto de esta página para calcular CER y WER en
                    tiempo real.
                </p>
                <textarea
                    value={referenceText}
                    onChange={(event) => setReferenceText(event.target.value)}
                    placeholder="Transcripción de referencia…"
                />
                {evaluation && (
                    <div className="pdf-review-evaluation-metrics">
                        <span>
                            <strong>{(evaluation.cer.cer * 100).toFixed(2)}%</strong> CER
                        </span>
                        <span>
                            <strong>{(evaluation.wer.wer * 100).toFixed(2)}%</strong> WER
                        </span>
                        <span>
                            <strong>{evaluation.cer.referenceCharacters}</strong> caracteres
                        </span>
                        <span>
                            <strong>{evaluation.wer.referenceWords}</strong> palabras
                        </span>
                    </div>
                )}
            </details>

            <button
                type="button"
                className="pdf-word-convert-button pdf-review-generate"
                onClick={() => onGenerate(model)}
                disabled={generating}
            >
                {generating ? "Construyendo el Word…" : "Aprobar revisión y generar Word"}
            </button>
        </section>
    );
}

export default PDFReviewWorkspace;
