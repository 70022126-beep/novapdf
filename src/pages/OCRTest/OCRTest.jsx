import { analyzePage } from "../../engine/layout/PageAnalyzer";
import { useRef, useState } from "react";

import * as pdfjsLib from "pdfjs-dist";

import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
    preprocessForOCR,
} from "../../engine/ocr/ImagePreprocessor";

import ocrEngine from "../../engine/ocr/OCREngine";
import {
    rankOCRResults,
} from "../../engine/ocr/OCRScoring";

import "./OCRTest.css";


pdfjsLib.GlobalWorkerOptions.workerSrc =
    pdfWorker;


function OCRTest() {

    const inputRef = useRef(null);

    const [file, setFile] = useState(null);
    const [pageNumber, setPageNumber] = useState(1);

    const [totalPages, setTotalPages] = useState(0);        

    const [status, setStatus] =
        useState("Esperando PDF...");

    const [progress, setProgress] =
        useState(0);

    const [result, setResult] =
        useState(null);
    
    const [testResults, setTestResults] =
         useState([]);
    const [bestResult, setBestResult] =
         useState(null);

    const [error, setError] =
        useState("");

    const [isRunning, setIsRunning] =
        useState(false);


    // ========================================
    // SELECCIONAR PDF
    // ========================================

    const seleccionarPDF = (
        event
    ) => {

        const selectedFile =
            event.target.files?.[0];


        if (!selectedFile) {
            return;
        }


        setFile(selectedFile);
        setPageNumber(1);
        setTotalPages(0);

        setResult(null);

        setError("");

        setProgress(0);
        setTestResults([]);
        setBestResult(null);

        setStatus(
            "PDF seleccionado."
        );
    };


    // ========================================
    // PROCESAR PRIMERA PÁGINA
    // ========================================

    const ejecutarOCR = async () => {

    if (!file) {

        setError(
            "Selecciona primero un PDF."
        );

        return;
    }


    if (isRunning) {
        return;
    }


    try {

        setIsRunning(true);

        setError("");

        setResult(null);

        setTestResults([]);

        setBestResult(null);

        setProgress(0);

        setStatus(
            `Preparando página ${pageNumber}...`
        );


        // =====================================
        // LEER PDF
        // =====================================

        const arrayBuffer =
            await file.arrayBuffer();


        const pdf =
            await pdfjsLib
                .getDocument({
                    data: arrayBuffer,
                })
                .promise;


        setTotalPages(
            pdf.numPages
        );


        // =====================================
        // OBTENER PÁGINA
        // =====================================

        const page =
            await pdf.getPage(
                pageNumber
            );


        // =====================================
        // RESOLUCIÓN
        // =====================================

        const scale = 3;


        const viewport =
            page.getViewport({
                scale,
            });


        const canvas =
            document.createElement(
                "canvas"
            );


        const context =
            canvas.getContext(
                "2d",
                {
                    willReadFrequently:
                        true,
                }
            );


        canvas.width =
            Math.ceil(
                viewport.width
            );


        canvas.height =
            Math.ceil(
                viewport.height
            );


        // =====================================
        // RENDER PDF
        // =====================================

        setStatus(
            "Renderizando página..."
        );


        await page.render({

            canvasContext:
                context,

            viewport,

        }).promise;


        // =====================================
        // CREAR VARIANTES
        // =====================================

        setStatus(
            "Preparando variantes OCR..."
        );


        const grayscaleCanvas =
            preprocessForOCR(
                canvas,
                {
                    grayscale: true,

                    contrast: 1.15,

                    brightness: 0,

                    threshold: null,
                }
            );


        const binaryCanvas =
    preprocessForOCR(
        canvas,
        {
            grayscale: true,
            contrast: 1.25,
            brightness: 0,
            threshold: 180,
        }
    );


        const adaptiveCanvas =
            preprocessForOCR(
                canvas,
                {
                    grayscale: true,
                    contrast: 1.20,
                    brightness: 0,
                    adaptive: true,
                    windowSize: 15,
                    offset: 10,
                }
            );


        const variants = [

    {
        name:
            "Original",

        canvas:
            canvas,
    },

    {
        name:
            "Grises + contraste",

        canvas:
            grayscaleCanvas,
    },

    {
        name:
            "Binarizado",

        canvas:
            binaryCanvas,
    },

    {
        name:
            "Adaptativo",

        canvas:
            adaptiveCanvas,
    },

];


        const results = [];


        // =====================================
        // PROCESAR VARIANTES
        // =====================================

        for (
            let i = 0;
            i < variants.length;
            i++
        ) {

            const variant =
                variants[i];


            setStatus(
    `OCR ${variant.name} (${i + 1}/4)...`
);


            setProgress(
                Math.round(
                    (
                        i /
                        variants.length
                    ) * 100
                )
            );


            const result =
                await ocrEngine.recognize(

                    variant.canvas,

                    (message) => {

                        if (
                            message?.progress
                        ) {

                            const localProgress =
                                message.progress *
                                100;


                            const globalProgress =
                                (
                                    (
                                        i +
                                        localProgress /
                                        100
                                    ) /
                                    variants.length
                                ) *
                                100;


                            setProgress(
                                Math.round(
                                    globalProgress
                                )
                            );

                        }

                    },

                    {
                        dpi:
                            scale * 72,
                    }

                );

                            const pageAnalysis =
                                analyzePage({
                                pageNumber:
                                     pageNumber,

                                    width:
                                        variant.canvas.width,

                                    height:
                                        variant.canvas.height,

                                    words:
                                        result.words,

                                    lines:
                                        result.lines,

                                    blocks:
                                        result.blocks,

                                    paragraphs:
                                        result.paragraphs,

                                });
                                        results.push({

                                            name:
                                                variant.name,

                                            ...result,
                                            analysis:
                                                 pageAnalysis,

                                        });

                                    }


        // =====================================
        // FINALIZAR
        // =====================================

        // =====================================
// SCORING ENGINE
// =====================================

const ranking =
    rankOCRResults(
        results
    );

// =====================================
// RESULTADOS ORDENADOS
// =====================================

const rankedResults =
    ranking?.ranked || [];


// =====================================
// MEJOR RESULTADO
// =====================================

// Primero intentamos utilizar el resultado
// oficial entregado por el Scoring Engine.
//
// Si por alguna razón `ranking.best` no existe,
// utilizamos el primer resultado del ranking,
// ya que el ranking está ordenado de mejor
// a peor puntuación.

const best =
    ranking?.best ||
    rankedResults[0] ||
    null;


// =====================================
// GUARDAR RESULTADOS
// =====================================

setTestResults(
    rankedResults
);


setBestResult(
    best
);
// =====================================
// RESULTADO PRINCIPAL
// =====================================

setResult(
    best
);


        setProgress(100);

        setStatus(
            "Comparación OCR completada."
        );


    } catch (ocrError) {

        console.error(
            "Error OCR:",
            ocrError
        );


        setStatus(
            "Error durante OCR."
        );


        setError(
            ocrError?.message ||
            "No fue posible procesar el PDF."
        );

    } finally {

        setIsRunning(false);

    }

};


    // ========================================
    // RENDER
    // ========================================

    return (

        <main className="ocr-test">

            <section className="ocr-card">

                <div className="ocr-header">

                    <span className="ocr-icon">
                        🔎
                    </span>

                    <div>

                        <h1>
                            NovaPDF OCR Engine
                        </h1>

                        <p>
                            Prueba de reconocimiento
                            de documentos escaneados
                        </p>

                    </div>

                </div>


                {/* ==========================
                    SELECTOR
                ========================== */}
{file && totalPages > 0 && (

    <div className="ocr-page-selector">

        <label>
            Página a analizar
        </label>

        <select
            value={pageNumber}
            disabled={isRunning}
            onChange={(event) =>
                setPageNumber(
                    Number(
                        event.target.value
                    )
                )
            }
        >

            {Array.from(
                {
                    length:
                        totalPages,
                },
                (_, index) => (

                    <option
                        key={index + 1}
                        value={index + 1}
                    >
                        Página {index + 1}
                    </option>

                )
            )}

        </select>

        <span>
            de {totalPages}
        </span>

    </div>

)}
                <div className="ocr-actions">

                    <input
                        ref={inputRef}
                        type="file"
                        accept="application/pdf"
                        disabled={isRunning}
                        onChange={
                            seleccionarPDF
                        }
                        hidden
                    />


                    <button
                        type="button"
                        disabled={isRunning}
                        onClick={() =>
                            inputRef.current?.click()
                        }
                    >
                        📁 Seleccionar PDF
                    </button>


                    <button
                        type="button"
                        className="ocr-run"
                        onClick={ejecutarOCR}
                        disabled={
                            !file ||
                            isRunning
                        }
                    >
                        🔍 Ejecutar OCR
                    </button>

                </div>


                {/* ==========================
                    ARCHIVO
                ========================== */}

                {file && (

                    <div className="ocr-file">

                        📄

                        <strong>
                            {file.name}
                        </strong>

                        <span>
                            {(
                                file.size /
                                1024 /
                                1024
                            ).toFixed(2)}
                            {" MB"}
                        </span>

                    </div>

                )}


                {/* ==========================
                    ESTADO
                ========================== */}

                <div className="ocr-status">

                    <span>
                        {status}
                    </span>

                    <strong>
                        {progress}%
                    </strong>

                </div>


                {/* ==========================
                    BARRA
                ========================== */}

                <div className="ocr-progress">

                    <div
                        className="ocr-progress-bar"
                        style={{
                            width:
                                `${progress}%`,
                        }}
                    />

                </div>


                {/* ==========================
                    ERROR
                ========================== */}

                {error && (

                    <div className="ocr-error">

                        ❌ {error}

                    </div>

                )}

{bestResult && (

    <section className="ocr-best-result">

        <div className="ocr-best-header">

            <span className="ocr-best-icon">
                🏆
            </span>

            <div>

                <h2>
                    Mejor variante detectada
                </h2>

                <p>
                    El motor seleccionó automáticamente
                    el resultado con mejor puntuación.
                </p>

            </div>

        </div>


        <div className="ocr-best-name">

            {bestResult.name}

        </div>


        <div className="ocr-best-score">

            <strong>
                {bestResult.scoring.score}
            </strong>

            <span>
                Score
            </span>

        </div>


        <div className="ocr-best-metrics">

            <div>

                <strong>
                    {bestResult.words.length}
                </strong>

                <span>
                    Palabras
                </span>

            </div>


            <div>

                <strong>
                    {bestResult.lines.length}
                </strong>

                <span>
                    Líneas
                </span>

            </div>


            <div>

                <strong>
                    {bestResult.blocks.length}
                </strong>

                <span>
                    Bloques
                </span>

            </div>


            <div>

                <strong>
                    {Math.round(
                        bestResult.confidence
                    )}
                    %
                </strong>

                <span>
                    Confianza
                </span>

            </div>

        </div>

    </section>

)}
                {/* ==========================
                    RESULTADO
                ========================== */}
{testResults.length > 0 && (

    <section className="ocr-comparison">

        <h2>
            Comparación de motores
        </h2>

        <div className="ocr-comparison-grid">

            {testResults.map(
                (test) => (

                    <div
                        className="ocr-comparison-card"
                        key={test.name}
                    >

                        <h3>
                            {test.name}
                        </h3>
<div className="ocr-variant-score">

    Score:

    <strong>
        {test.scoring.score}
    </strong>

</div>

                        <div className="ocr-mini-stats">

                            <div>
                                <strong>
                                    {test.words.length}
                                </strong>

                                <span>
                                    Palabras
                                </span>
                            </div>


                            <div>
                                <strong>
                                    {test.lines.length}
                                </strong>

                                <span>
                                    Líneas
                                </span>
                            </div>


                            <div>
                                <strong>
                                    {test.blocks.length}
                                </strong>

                                <span>
                                    Bloques
                                </span>
                            </div>


                            <div>
                                <strong>
                                    {Math.round(
                                        test.confidence
                                    )}
                                    %
                                </strong>

                                <span>
                                    Confianza
                                </span>
                            </div>

                        </div>


                        <pre>
                            {test.text}
                        </pre>

                    </div>

                )
            )}

        </div>

    </section>

)}
                {result && (

                    <section className="ocr-result">

                        <div className="ocr-result-grid">

                            <div>

                                <strong>
                                    {result.words.length}
                                </strong>

                                <span>
                                    Palabras
                                </span>

                            </div>


                            <div>

                                <strong>
                                    {result.lines.length}
                                </strong>

                                <span>
                                    Líneas
                                </span>

                            </div>


                            <div>

                                <strong>
                                    {result.blocks.length}
                                </strong>

                                <span>
                                    Bloques
                                </span>

                            </div>


                            <div>

                                <strong>
                                    {Math.round(
                                        result.confidence
                                    )}
                                    %
                                </strong>

                                <span>
                                    Confianza
                                </span>

                            </div>

                        </div>


                        <h2>
                            Texto reconocido
                        </h2>


                        <pre className="ocr-text">

                            {result.text ||
                                "No se detectó texto."}

                        </pre>

                    </section>

                )}

            </section>

        </main>
    );
}


export default OCRTest;
