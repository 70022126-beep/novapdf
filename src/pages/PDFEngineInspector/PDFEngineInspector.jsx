import { useState } from "react";

import {
    analyzePDF,
} from "../../engine/pdf-to-word/PDFAnalyzer";

import {
    analyzeTextItems,
    sortTextItems,
} from "../../engine/pdf-to-word/TextAnalyzer";

import {
    detectLines,
} from "../../engine/pdf-to-word/LineDetector";

import {
    detectBlocks,
} from "../../engine/pdf-to-word/BlockDetector";

import {
    createDocument,
    createPage,
} from "../../engine/pdf-to-word/NovaDOC";

import "./PDFEngineInspector.css";


// ============================================
// TIPO DE PÁGINA
// ============================================

function getPageTypeLabel(type) {

    switch (type) {

        case "digital":
            return "PDF digital";

        case "scanned":
            return "Escaneada";

        case "hybrid":
            return "Híbrida";

        case "empty":
            return "Vacía";

        default:
            return "Desconocida";
    }
}


// ============================================
// ICONO DEL TIPO DE PÁGINA
// ============================================

function getPageTypeIcon(type) {

    switch (type) {

        case "digital":
            return "📝";

        case "scanned":
            return "📷";

        case "hybrid":
            return "🔀";

        case "empty":
            return "⬜";

        default:
            return "❔";
    }
}


// ============================================
// INSPECTOR DEL MOTOR NOVAPDF
// ============================================

function PDFEngineInspector() {

    const [file, setFile] =
        useState(null);

    const [analysis, setAnalysis] =
        useState(null);

    const [loading, setLoading] =
        useState(false);

    const [error, setError] =
        useState("");

    const [selectedPage, setSelectedPage] =
        useState(0);


    // ========================================
    // SELECCIONAR PDF
    // ========================================

    const handleFile = (
        selectedFile
    ) => {

        if (!selectedFile) {
            return;
        }


        if (
            selectedFile.type !==
                "application/pdf" &&
            !selectedFile.name
                .toLowerCase()
                .endsWith(".pdf")
        ) {

            setError(
                "Selecciona un archivo PDF válido."
            );

            return;
        }


        setFile(
            selectedFile
        );

        setAnalysis(
            null
        );

        setError("");

        setSelectedPage(0);
    };


    // ========================================
    // ANALIZAR PDF
    // ========================================

    const analyzeFile = async () => {

        if (!file) {

            setError(
                "Selecciona un PDF primero."
            );

            return;
        }


        try {

            setLoading(true);

            setError("");

            setAnalysis(null);


            // ====================================
            // ANALIZAR PDF ORIGINAL
            // ====================================

            const rawPDF =
                await analyzePDF(
                    file
                );


            // ====================================
            // CREAR NOVADOC
            // ====================================

            const novaDocument =
                createDocument();


            novaDocument.metadata.title =
                file.name.replace(
                    /\.pdf$/i,
                    ""
                );


            // ====================================
            // ANALIZAR PÁGINAS
            // ====================================

            const pages =
                rawPDF.pages.map(
                    (rawPage) => {

                        // ----------------------------
                        // TEXTO
                        // ----------------------------

                        const textItems =
                            analyzeTextItems(
                                rawPage.textItems
                            );


                        // ----------------------------
                        // ORDENAR TEXTO
                        // ----------------------------

                        const sortedItems =
                            sortTextItems(
                                textItems
                            );


                        // ----------------------------
                        // DETECTAR LÍNEAS
                        // ----------------------------

                        const lines =
                            detectLines(
                                sortedItems
                            );


                        // ----------------------------
                        // DETECTAR BLOQUES
                        // ----------------------------

                        const blocks =
                            detectBlocks(
                                lines
                            );


                        // ----------------------------
                        // CREAR NOVAPAGE
                        // ----------------------------

                        const novaPage =
                            createPage({

                                pageNumber:
                                    rawPage.pageNumber,

                                width:
                                    rawPage.width,

                                height:
                                    rawPage.height,

                            });


                        novaPage.blocks =
                            blocks;


                        // ----------------------------
                        // DEVOLVER PÁGINA
                        // ----------------------------

                        return {

                            ...rawPage,

                            textItems,

                            sortedItems,

                            lines,

                            blocks,

                            novaPage,

                        };
                    }
                );


            // ====================================
            // AGREGAR PÁGINAS AL DOCUMENTO
            // ====================================

            novaDocument.pages =
                pages.map(
                    (page) =>
                        page.novaPage
                );


            // ====================================
            // GUARDAR ANÁLISIS
            // ====================================

            setAnalysis({

                ...rawPDF,

                pages,

                novaDocument,

            });

        } catch (analysisError) {

            console.error(
                "Error analizando PDF:",
                analysisError
            );

            setError(
                analysisError.message ||
                "No se pudo analizar el PDF."
            );

        } finally {

            setLoading(false);
        }
    };


    // ========================================
    // PÁGINA ACTUAL
    // ========================================

    const currentPage =
        analysis?.pages[
            selectedPage
        ] || null;


    // ========================================
    // RENDER
    // ========================================

    return (

        <section className="engine-inspector">


            {/* ==================================
                CABECERA
            ================================== */}

            <div className="engine-inspector-header">

                <div className="engine-badge">
                    🧠 NovaPDF Engine 1
                </div>

                <h1>
                    Inspector del motor PDF
                </h1>

                <p>
                    Analizamos la estructura espacial
                    del documento antes de convertirlo.
                </p>

            </div>


            {/* ==================================
                CARGA
            ================================== */}

            <div className="engine-upload">

                <label className="engine-file-button">

                    📂 Seleccionar PDF

                    <input
                        type="file"
                        accept=".pdf,application/pdf"
                        onChange={(event) =>
                            handleFile(
                                event.target.files[0]
                            )
                        }
                    />

                </label>


                {file && (

                    <div className="engine-selected-file">

                        📄

                        <strong>
                            {file.name}
                        </strong>

                        <span>
                            {(
                                file.size /
                                1024 /
                                1024
                            ).toFixed(2)} MB
                        </span>

                    </div>

                )}


                <button
                    type="button"
                    className="engine-analyze-button"
                    onClick={
                        analyzeFile
                    }
                    disabled={
                        !file ||
                        loading
                    }
                >

                    {loading
                        ? "⏳ Analizando..."
                        : "🔍 Analizar PDF"
                    }

                </button>

            </div>


            {/* ==================================
                ERROR
            ================================== */}

            {error && (

                <div className="engine-error">

                    ⚠️ {error}

                </div>

            )}


            {/* ==================================
                RESULTADOS
            ================================== */}

            {analysis && (

                <>

                    {/* ==================================
                        RESUMEN
                    ================================== */}

                    <div className="engine-summary">

                        <div className="engine-stat">

                            <strong>
                                {analysis.numPages}
                            </strong>

                            <span>
                                Páginas
                            </span>

                        </div>


                        <div className="engine-stat">

                            <strong>
                                {analysis.pages.reduce(
                                    (
                                        total,
                                        page
                                    ) =>
                                        total +
                                        page.textItems.length,
                                    0
                                )}
                            </strong>

                            <span>
                                Elementos de texto
                            </span>

                        </div>


                        <div className="engine-stat">

                            <strong>
                                {analysis.pages.reduce(
                                    (
                                        total,
                                        page
                                    ) =>
                                        total +
                                        page.lines.length,
                                    0
                                )}
                            </strong>

                            <span>
                                Líneas
                            </span>

                        </div>


                        <div className="engine-stat">

                            <strong>
                                {analysis.pages.reduce(
                                    (
                                        total,
                                        page
                                    ) =>
                                        total +
                                        page.blocks.length,
                                    0
                                )}
                            </strong>

                            <span>
                                Bloques
                            </span>

                        </div>

                    </div>


                    {/* ==================================
                        SELECTOR DE PÁGINAS
                    ================================== */}

                    <div className="engine-pages">

                        <div className="engine-pages-title">

                            <h2>
                                Páginas analizadas
                            </h2>

                            <span>
                                Selecciona una página
                            </span>

                        </div>


                        <div className="engine-page-buttons">

                            {analysis.pages.map(
                                (
                                    page,
                                    index
                                ) => (

                                    <button
                                        key={
                                            page.pageNumber
                                        }
                                        type="button"
                                        className={
                                            selectedPage ===
                                            index
                                                ? "active"
                                                : ""
                                        }
                                        onClick={() =>
                                            setSelectedPage(
                                                index
                                            )
                                        }
                                    >

                                        Página{" "}
                                        {
                                            page.pageNumber
                                        }

                                    </button>

                                )
                            )}

                        </div>

                    </div>


                    {/* ==================================
                        ANÁLISIS DE PÁGINA
                    ================================== */}

                    {currentPage && (

                        <div className="engine-page-analysis">


                            {/* ==================================
                                CABECERA DE PÁGINA
                            ================================== */}

                            <div className="engine-page-header">

                                <div>

                                    <h2>
                                        Página{" "}
                                        {
                                            currentPage.pageNumber
                                        }
                                    </h2>

                                    <p>
                                        {Math.round(
                                            currentPage.width
                                        )} ×{" "}
                                        {Math.round(
                                            currentPage.height
                                        )} pt
                                    </p>

                                </div>


                                <div className="engine-page-counts">

                                    <span>
                                        📝{" "}
                                        {
                                            currentPage
                                                .textItems
                                                .length
                                        } elementos
                                    </span>


                                    <span>
                                        📏{" "}
                                        {
                                            currentPage
                                                .lines
                                                .length
                                        } líneas
                                    </span>


                                    <span>
                                        🧱{" "}
                                        {
                                            currentPage
                                                .blocks
                                                .length
                                        } bloques
                                    </span>


                                    {/* ==================================
                                        BADGE TIPO DE PÁGINA
                                    ================================== */}

                                    <span
                                        className={
                                            `page-type-badge ${
                                                currentPage
                                                    .pageType
                                                    ?.type || ""
                                            }`
                                        }
                                    >

                                        {getPageTypeIcon(
                                            currentPage
                                                .pageType
                                                ?.type
                                        )}

                                        {" "}

                                        {getPageTypeLabel(
                                            currentPage
                                                .pageType
                                                ?.type
                                        )}

                                    </span>

                                </div>

                            </div>


                            {/* ==================================
                                INFORMACIÓN DEL DETECTOR
                            ================================== */}

                            <div className="engine-detection-info">

                                <div>

                                    <strong>
                                        Tipo detectado:
                                    </strong>

                                    {" "}

                                    {getPageTypeLabel(
                                        currentPage
                                            .pageType
                                            ?.type
                                    )}

                                </div>


                                <div>

                                    <strong>
                                        Confianza:
                                    </strong>

                                    {" "}

                                    {Math.round(
                                        (
                                            currentPage
                                                .pageType
                                                ?.confidence || 0
                                        ) * 100
                                    )}

                                    %

                                </div>


                                <div>

                                    <strong>
                                        Caracteres:
                                    </strong>

                                    {" "}

                                    {
                                        currentPage
                                            .pageType
                                            ?.characterCount || 0
                                    }

                                </div>


                                <div className="engine-detection-reason">

                                    {
                                        currentPage
                                            .pageType
                                            ?.reason
                                    }

                                </div>

                            </div>


                            {/* ==================================
                                LÍNEAS
                            ================================== */}

                            <div className="engine-section">

                                <h3>
                                    📏 Líneas detectadas
                                </h3>


                                <div className="engine-lines">

                                    {currentPage.lines.map(
                                        (
                                            line,
                                            index
                                        ) => (

                                            <div
                                                className="engine-line"
                                                key={
                                                    index
                                                }
                                            >

                                                <div className="engine-line-number">

                                                    {index + 1}

                                                </div>


                                                <div className="engine-line-text">

                                                    {line.text}

                                                </div>


                                                <div className="engine-line-position">

                                                    X:{" "}
                                                    {Math.round(
                                                        line.x
                                                    )}

                                                    {" • "}

                                                    Y:{" "}
                                                    {Math.round(
                                                        line.y
                                                    )}

                                                    {" • "}

                                                    W:{" "}
                                                    {Math.round(
                                                        line.width
                                                    )}

                                                    {" • "}

                                                    H:{" "}
                                                    {Math.round(
                                                        line.height
                                                    )}

                                                </div>

                                            </div>

                                        )
                                    )}

                                </div>

                            </div>


                            {/* ==================================
                                BLOQUES
                            ================================== */}

                            <div className="engine-section">

                                <h3>
                                    🧱 Bloques detectados
                                </h3>


                                <div className="engine-blocks">

                                    {currentPage.blocks.map(
                                        (
                                            block,
                                            index
                                        ) => (

                                            <div
                                                className="engine-block"
                                                key={
                                                    index
                                                }
                                            >

                                                <div className="engine-block-header">

                                                    <strong>
                                                        Bloque{" "}
                                                        {index + 1}
                                                    </strong>

                                                    <span>
                                                        {
                                                            block
                                                                .lines
                                                                .length
                                                        } líneas
                                                    </span>

                                                </div>


                                                <div className="engine-block-text">

                                                    {
                                                        block.lines
                                                            .map(
                                                                (
                                                                    line
                                                                ) =>
                                                                    line.text
                                                            )
                                                            .join(
                                                                " "
                                                            )
                                                    }

                                                </div>


                                                <div className="engine-block-position">

                                                    X:{" "}
                                                    {Math.round(
                                                        block.x
                                                    )}

                                                    {" • "}

                                                    Y:{" "}
                                                    {Math.round(
                                                        block.y
                                                    )}

                                                    {" • "}

                                                    W:{" "}
                                                    {Math.round(
                                                        block.width
                                                    )}

                                                    {" • "}

                                                    H:{" "}
                                                    {Math.round(
                                                        block.height
                                                    )}

                                                </div>

                                            </div>

                                        )
                                    )}

                                </div>

                            </div>


                            {/* ==================================
                                ELEMENTOS CRUDOS
                            ================================== */}

                            <div className="engine-section">

                                <details>

                                    <summary>
                                        🔬 Ver elementos originales de PDF.js
                                    </summary>


                                    <div className="engine-raw-list">

                                        {currentPage.textItems.map(
                                            (
                                                item,
                                                index
                                            ) => (

                                                <div
                                                    className="engine-raw-item"
                                                    key={
                                                        index
                                                    }
                                                >

                                                    <strong>
                                                        {
                                                            item.text
                                                        }
                                                    </strong>


                                                    <span>

                                                        X:{" "}
                                                        {Math.round(
                                                            item.x
                                                        )}

                                                        {" • "}

                                                        Y:{" "}
                                                        {Math.round(
                                                            item.y
                                                        )}

                                                        {" • "}

                                                        W:{" "}
                                                        {Math.round(
                                                            item.width
                                                        )}

                                                        {" • "}

                                                        H:{" "}
                                                        {Math.round(
                                                            item.height
                                                        )}

                                                    </span>

                                                </div>

                                            )
                                        )}

                                    </div>

                                </details>

                            </div>


                        </div>

                    )}

                </>

            )}

        </section>
    );
}


export default PDFEngineInspector;