import { useState } from "react";
import {
    Document,
    Packer,
    Paragraph,
    TextRun,
} from "docx";

import "./PDFToWord.css";


// ============================================
// PDF → WORD
// ============================================

function PDFToWord() {

    const [file, setFile] = useState(null);

    const [extracting, setExtracting] = useState(false);

    const [progress, setProgress] = useState(0);

    const [message, setMessage] = useState("");

    const [error, setError] = useState("");

    const [downloadUrl, setDownloadUrl] = useState("");


    // ============================================
    // SELECCIONAR ARCHIVO
    // ============================================

    const handleFile = (selectedFile) => {

        if (!selectedFile) {
            return;
        }

        if (
            selectedFile.type !== "application/pdf" &&
            !selectedFile.name
                .toLowerCase()
                .endsWith(".pdf")
        ) {

            setError(
                "Selecciona un archivo PDF válido."
            );

            setFile(null);

            return;
        }

        if (downloadUrl) {

            URL.revokeObjectURL(
                downloadUrl
            );
        }

        setFile(selectedFile);

        setMessage("");

        setError("");

        setDownloadUrl("");

        setProgress(0);
    };


    // ============================================
    // INPUT
    // ============================================

    const handleInputChange = (event) => {

        const selectedFile =
            event.target.files[0];

        handleFile(selectedFile);

        event.target.value = "";
    };


    // ============================================
    // DRAG & DROP
    // ============================================

    const handleDragOver = (event) => {

        event.preventDefault();

        event.dataTransfer.dropEffect =
            "copy";
    };


    const handleDrop = (event) => {

        event.preventDefault();

        const droppedFile =
            event.dataTransfer.files[0];

        handleFile(droppedFile);
    };


    // ============================================
    // RECONSTRUIR LÍNEAS
    // ============================================

    const buildLinesFromTextItems = (
        textItems
    ) => {

        const items = textItems
            .filter(
                (item) =>
                    item.str &&
                    item.str.trim()
            )
            .map((item) => {

                const transform =
                    item.transform || [];

                const x =
                    Number(transform[4]) || 0;

                const y =
                    Number(transform[5]) || 0;

                const height =
                    Number(item.height) ||
                    Math.abs(
                        Number(transform[3])
                    ) ||
                    10;

                const width =
                    Number(item.width) || 0;

                return {
                    text: item.str,
                    x,
                    y,
                    width,
                    height,
                };

            })
            .sort((a, b) => {

                if (
                    Math.abs(a.y - b.y) >
                    3
                ) {

                    return b.y - a.y;
                }

                return a.x - b.x;
            });


        const lines = [];


        // ========================================
        // AGRUPAR ELEMENTOS POR ALTURA
        // ========================================

        for (const item of items) {

            let currentLine = null;

            const tolerance =
                Math.max(
                    3,
                    item.height * 0.45
                );


            for (
                let i = 0;
                i < lines.length;
                i++
            ) {

                const line =
                    lines[i];

                if (
                    Math.abs(
                        line.y - item.y
                    ) <= tolerance
                ) {

                    currentLine =
                        line;

                    break;
                }
            }


            if (!currentLine) {

                currentLine = {
                    y: item.y,
                    height: item.height,
                    items: [],
                };

                lines.push(
                    currentLine
                );
            }


            currentLine.items.push(
                item
            );
        }


        // ========================================
        // ORDENAR LÍNEAS
        // ========================================

        lines.sort(
            (a, b) =>
                b.y - a.y
        );


        // ========================================
        // CONSTRUIR TEXTO DE CADA LÍNEA
        // ========================================

        return lines
            .map((line) => {

                line.items.sort(
                    (a, b) =>
                        a.x - b.x
                );


                let result = "";

                let previous = null;


                for (
                    const item
                    of line.items
                ) {

                    if (previous) {

                        const previousEnd =
                            previous.x +
                            previous.width;

                        const gap =
                            item.x -
                            previousEnd;


                        /*
                         * Si existe una separación
                         * suficiente entre elementos,
                         * agregamos espacio.
                         */

                        if (
                            gap >
                            Math.max(
                                2,
                                previous.height *
                                    0.15
                            )
                        ) {

                            result += " ";
                        }
                    }


                    result += item.text;

                    previous = item;
                }


                return {
                    text:
                        result
                            .replace(
                                /\s+/g,
                                " "
                            )
                            .trim(),

                    height:
                        line.height,
                };

            })
            .filter(
                (line) =>
                    line.text.length > 0
            );
    };


    // ============================================
    // CREAR PÁGINA WORD
    // ============================================

    const createPageParagraphs = (
        lines,
        isFirstPage
    ) => {

        const paragraphs = [];


        lines.forEach(
            (line, index) => {

                const fontSize =
                    Math.min(
                        28,
                        Math.max(
                            9,
                            Math.round(
                                line.height
                            )
                        )
                    );


                paragraphs.push(
                    new Paragraph({

                        pageBreakBefore:
                            !isFirstPage &&
                            index === 0,

                        spacing: {
                            after: 80,
                        },

                        children: [

                            new TextRun({

                                text:
                                    line.text,

                                size:
                                    fontSize * 2,

                                font:
                                    "Arial",

                            }),

                        ],

                    })
                );

            }
        );


        return paragraphs;
    };


    // ============================================
    // CONVERTIR
    // ============================================

    const convertToWord = async () => {

        if (!file) {

            setError(
                "Selecciona un archivo PDF primero."
            );

            return;
        }


        try {

            setExtracting(true);

            setProgress(5);

            setMessage("");

            setError("");

            setDownloadUrl("");


            // ========================================
            // CARGAR PDF.JS
            // ========================================

            const pdfjsLib =
                await import(
                    "pdfjs-dist"
                );


            pdfjsLib.GlobalWorkerOptions.workerSrc =
                new URL(
                    "pdfjs-dist/build/pdf.worker.min.mjs",
                    import.meta.url
                ).toString();


            setProgress(10);


            // ========================================
            // LEER ARCHIVO
            // ========================================

            const arrayBuffer =
                await file.arrayBuffer();


            const pdf =
                await pdfjsLib
                    .getDocument({
                        data: arrayBuffer,
                    })
                    .promise;


            const allParagraphs = [];


            // ========================================
            // RECORRER PÁGINAS
            // ========================================

            for (
                let pageNumber = 1;
                pageNumber <= pdf.numPages;
                pageNumber++
            ) {

                const page =
                    await pdf.getPage(
                        pageNumber
                    );


                const textContent =
                    await page.getTextContent();


                const lines =
                    buildLinesFromTextItems(
                        textContent.items
                    );


                // ====================================
                // SOLO AGREGAR PÁGINAS CON TEXTO
                // ====================================

                if (lines.length > 0) {

                    const pageParagraphs =
                        createPageParagraphs(
                            lines,
                            pageNumber === 1
                        );


                    allParagraphs.push(
                        ...pageParagraphs
                    );
                }


                const progress =
                    10 +
                    Math.round(
                        (
                            pageNumber /
                            pdf.numPages
                        ) * 75
                    );


                setProgress(
                    Math.min(
                        progress,
                        85
                    )
                );
            }


            // ========================================
            // PDF SIN TEXTO
            // ========================================

            if (
                allParagraphs.length === 0
            ) {

                throw new Error(
                    "Este PDF no contiene texto extraíble. Puede tratarse de un PDF escaneado."
                );
            }


            setProgress(90);


            // ========================================
            // CREAR DOCUMENTO DOCX
            // ========================================

            const document =
                new Document({

                    creator:
                        "NovaPDF",

                    title:
                        file.name.replace(
                            /\.pdf$/i,
                            ""
                        ),

                    description:
                        "Documento convertido desde PDF mediante NovaPDF.",

                    sections: [

                        {

                            properties: {

                                page: {

                                    margin: {

                                        top: 900,

                                        right: 900,

                                        bottom: 900,

                                        left: 900,

                                    },

                                },

                            },

                            children:
                                allParagraphs,

                        },

                    ],

                });


            // ========================================
            // GENERAR DOCX
            // ========================================

            const blob =
                await Packer.toBlob(
                    document
                );


            const url =
                URL.createObjectURL(
                    blob
                );


            setDownloadUrl(url);

            setProgress(100);

            setMessage(
                `¡Conversión completada! Se procesaron ${pdf.numPages} página${
                    pdf.numPages === 1
                        ? ""
                        : "s"
                }.`
            );


        } catch (conversionError) {

            console.error(
                "Error PDF → Word:",
                conversionError
            );

            setError(
                conversionError.message ||
                "No se pudo convertir el PDF."
            );

            setProgress(0);

        } finally {

            setExtracting(false);
        }
    };


    // ============================================
    // LIMPIAR
    // ============================================

    const clearFile = () => {

        if (downloadUrl) {

            URL.revokeObjectURL(
                downloadUrl
            );
        }

        setFile(null);

        setProgress(0);

        setMessage("");

        setError("");

        setDownloadUrl("");
    };


    // ============================================
    // INTERFAZ
    // ============================================

    return (

        <section className="pdf-word-page">


            {/* ====================================
                CABECERA
            ==================================== */}

            <div className="pdf-word-header">

                <div className="pdf-word-badge">
                    📝 Herramienta NovaPDF
                </div>

                <h1>
                    PDF a Word
                </h1>

                <p>
                    Convierte el texto de tus
                    archivos PDF en un documento
                    Word editable.
                </p>

            </div>


            {/* ====================================
                CARGA
            ==================================== */}

            <div
                className="pdf-word-upload"
                onDragOver={
                    handleDragOver
                }
                onDrop={
                    handleDrop
                }
            >

                <div className="pdf-word-upload-icon">
                    📄
                </div>

                <h2>
                    Arrastra tu PDF aquí
                </h2>

                <p>
                    O selecciona un archivo
                    desde tu computadora.
                </p>


                <label className="pdf-word-upload-button">

                    📂 Seleccionar PDF

                    <input
                        type="file"
                        accept=".pdf,application/pdf"
                        onChange={
                            handleInputChange
                        }
                    />

                </label>


                <small>
                    Solo archivos PDF
                </small>

            </div>


            {/* ====================================
                ARCHIVO
            ==================================== */}

            {file && (

                <div className="pdf-word-file">

                    <div className="pdf-word-file-icon">
                        📄
                    </div>


                    <div className="pdf-word-file-info">

                        <strong>
                            {file.name}
                        </strong>

                        <small>
                            {(
                                file.size /
                                1024 /
                                1024
                            ).toFixed(2)}{" "}
                            MB
                        </small>

                    </div>


                    <button
                        type="button"
                        className="pdf-word-clear"
                        onClick={
                            clearFile
                        }
                        disabled={
                            extracting
                        }
                    >
                        🗑️
                    </button>

                </div>
            )}


            {/* ====================================
                PROGRESO
            ==================================== */}

            {extracting && (

                <div className="pdf-word-progress">

                    <div className="pdf-word-progress-header">

                        <span>
                            Analizando PDF...
                        </span>

                        <strong>
                            {progress}%
                        </strong>

                    </div>


                    <div className="pdf-word-progress-bar">

                        <div
                            className="pdf-word-progress-fill"
                            style={{
                                width:
                                    `${progress}%`,
                            }}
                        />

                    </div>

                </div>
            )}


            {/* ====================================
                MENSAJES
            ==================================== */}

            {message && (

                <div className="pdf-word-success">
                    ✅ {message}
                </div>
            )}


            {error && (

                <div className="pdf-word-error">
                    ⚠️ {error}
                </div>
            )}


            {/* ====================================
                CONVERTIR
            ==================================== */}

            {file && !downloadUrl && (

                <button
                    type="button"
                    className="pdf-word-convert-button"
                    onClick={
                        convertToWord
                    }
                    disabled={
                        extracting
                    }
                >

                    {extracting
                        ? "⏳ Convirtiendo..."
                        : "📝 Convertir a Word"}

                </button>
            )}


            {/* ====================================
                DESCARGAR
            ==================================== */}

            {downloadUrl && (

                <a
                    className="pdf-word-download"
                    href={downloadUrl}
                    download={`${file.name.replace(
                        /\.pdf$/i,
                        ""
                    )}.docx`}
                >
                    ⬇️ Descargar Word
                </a>
            )}

        </section>
    );
}


export default PDFToWord;