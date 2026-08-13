import { useState, useEffect } from "react";
import * as pdfjsLib from "pdfjs-dist";
import JSZip from "jszip";
import "./ConvertPDF.css";


// ============================================
// CONFIGURACIÓN DEL WORKER DE PDF.JS
// ============================================

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
).toString();


// ============================================
// COMPONENTE MINIATURA PDF
// ============================================

function PDFThumbnail({
    pdf,
    pageNumber,
    selected,
    onSelect,
}) {

    const [image, setImage] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {

        let active = true;

        const renderPage = async () => {

            try {

                setLoading(true);

                const page = await pdf.getPage(pageNumber);

                const viewport = page.getViewport({
                    scale: 0.5,
                });

                const canvas = document.createElement("canvas");

                const context = canvas.getContext("2d");

                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);

                await page.render({
                    canvasContext: context,
                    viewport: viewport,
                }).promise;

                if (active) {

                    const imageData =
                        canvas.toDataURL(
                            "image/jpeg",
                            0.80
                        );

                    setImage(imageData);
                }

            } catch (error) {

                console.error(
                    `Error al renderizar página ${pageNumber}:`,
                    error
                );

                if (active) {
                    setImage(null);
                }

            } finally {

                if (active) {
                    setLoading(false);
                }

            }
        };

        renderPage();

        return () => {
            active = false;
        };

    }, [pdf, pageNumber]);


    return (

        <div
    className={`pdf-thumbnail ${
        selected
            ? "selected"
            : ""
    }`}
    onClick={() =>
        onSelect(pageNumber)
    }
>

            <div className="thumbnail-title">
                Página {pageNumber}
            </div>
<div className="selection-indicator">
    {selected ? "✓" : ""}
</div>

            <div className="thumbnail-preview">

                {loading ? (

                    <div className="thumbnail-loading">
                        ⏳
                    </div>

                ) : image ? (

                    <img
                        src={image}
                        alt={`Página ${pageNumber}`}
                    />

                ) : (

                    <div className="thumbnail-error">
                        ⚠️
                    </div>

                )}

            </div>

        </div>

    );
}


// ============================================
// COMPONENTE PRINCIPAL
// ============================================

function ConvertPDF() {

    const [mode, setMode] = useState(null);

    const [file, setFile] = useState(null);

    const [pdf, setPdf] = useState(null);

    const [pdfInfo, setPdfInfo] = useState(null);

    const [visiblePages, setVisiblePages] = useState(8);
    const [selectedPages, setSelectedPages] = useState([]);
    const [pageInput, setPageInput] = useState("");
    const [imageFormat, setImageFormat] = useState("jpg");

const [imageQuality, setImageQuality] = useState(90);

const [imageDpi, setImageDpi] = useState(150);

const [isConverting, setIsConverting] = useState(false);

const [conversionResult, setConversionResult] = useState(null);
const [conversionDownloadUrl, setConversionDownloadUrl] = useState("");

const [conversionDownloadName, setConversionDownloadName] = useState("");
    const [error, setError] = useState("");

    const [dragActive, setDragActive] = useState(false);


    // ========================================
    // CAMBIAR MODO
    // ========================================

    const selectMode = (selectedMode) => {

        setMode(selectedMode);

        setFile(null);

        setPdf(null);

        setPdfInfo(null);

        setVisiblePages(8);

        setSelectedPages([]);

        setPageInput("");

        setError("");

    };


    // ========================================
    // PROCESAR PDF
    // ========================================

    const processPDF = async (selectedFile) => {

        setError("");

        if (!selectedFile) {
            return;
        }


        const isPDF =
            selectedFile.type === "application/pdf" ||
            selectedFile.name
                .toLowerCase()
                .endsWith(".pdf");


        if (!isPDF) {

            setError(
                "El archivo seleccionado no es un PDF válido."
            );

            return;
        }


        try {

            const arrayBuffer =
                await selectedFile.arrayBuffer();


            const loadedPdf =
                await pdfjsLib
                    .getDocument({
                        data: arrayBuffer,
                    })
                    .promise;


            setFile(selectedFile);

            setPdf(loadedPdf);

            setSelectedPages([]);


            setPdfInfo({

                pages: loadedPdf.numPages,

                size: formatFileSize(
                    selectedFile.size
                ),

            });


            setVisiblePages(
                Math.min(
                    8,
                    loadedPdf.numPages
                )
            );


        } catch (error) {

            console.error(error);


            setError(
                "No se pudo leer el archivo PDF. Verifica que sea un PDF válido."
            );


            setFile(null);

            setPdf(null);

            setPdfInfo(null);

        }

    };


    // ========================================
    // SELECCIONAR ARCHIVO
    // ========================================

    const handleFileChange = (event) => {

        const selectedFile =
            event.target.files[0];

        if (selectedFile) {
            processPDF(selectedFile);
        }

    };


    // ========================================
    // DRAG & DROP
    // ========================================

    const handleDrop = (event) => {

        event.preventDefault();

        setDragActive(false);


        const droppedFile =
            event.dataTransfer.files[0];


        if (droppedFile) {
            processPDF(droppedFile);
        }

    };


    const handleDragOver = (event) => {

        event.preventDefault();

        setDragActive(true);

    };


    const handleDragLeave = () => {

        setDragActive(false);

    };


    // ========================================
    // ELIMINAR PDF
    // ========================================

    const removeFile = () => {

    setFile(null);

    setPdf(null);

    setPdfInfo(null);

    setVisiblePages(8);

    setSelectedPages([]);

    setError("");
};


    // ========================================
    // CARGAR MÁS PÁGINAS
    // ========================================
// ========================================
// SELECCIONAR / DESELECCIONAR PÁGINA
// ========================================

const togglePageSelection = (pageNumber) => {

    setSelectedPages((current) => {

        if (current.includes(pageNumber)) {

            return current.filter(
                (page) => page !== pageNumber
            );

        }

        return [...current, pageNumber].sort(
            (a, b) => a - b
        );

    });

};


// ========================================
// SELECCIONAR TODAS
// ========================================

const selectAllPages = () => {

    if (!pdfInfo) {
        return;
    }

    const allPages = Array.from(
        {
            length: pdfInfo.pages,
        },
        (_, index) => index + 1
    );

    setSelectedPages(allPages);

};


// ========================================
// LIMPIAR SELECCIÓN
// ========================================

const clearSelection = () => {

    setSelectedPages([]);

};


// ========================================
// PARSEAR NÚMEROS Y RANGOS
// ========================================

const parsePageSelection = (value) => {

    if (!pdfInfo) {
        return [];
    }

    if (!value.trim()) {
        return [];
    }


    const pages = new Set();

    const parts = value.split(",");


    for (const part of parts) {

        const item = part.trim();

        if (!item) {
            continue;
        }


        // RANGO: 1-5

        if (item.includes("-")) {

            const range = item.split("-");


            if (range.length !== 2) {
                continue;
            }


            const start = Number(
                range[0].trim()
            );

            const end = Number(
                range[1].trim()
            );


            if (
                !Number.isInteger(start) ||
                !Number.isInteger(end)
            ) {
                continue;
            }


            const first = Math.min(
                start,
                end
            );

            const last = Math.max(
                start,
                end
            );


            for (
                let page = first;
                page <= last;
                page++
            ) {

                if (
                    page >= 1 &&
                    page <= pdfInfo.pages
                ) {

                    pages.add(page);

                }

            }

        } else {

            // PÁGINA INDIVIDUAL

            const page = Number(item);


            if (
                Number.isInteger(page) &&
                page >= 1 &&
                page <= pdfInfo.pages
            ) {

                pages.add(page);

            }

        }

    }


    return Array.from(pages).sort(
        (a, b) => a - b
    );

};


// ========================================
// APLICAR SELECCIÓN POR NÚMERO/RANGO
// ========================================

const applyPageSelection = () => {

    const pages =
        parsePageSelection(
            pageInput
        );

    setSelectedPages(pages);

};


// ========================================
// TEXTO DEL RESUMEN
// ========================================

const getSelectionText = () => {

    if (selectedPages.length === 0) {

        return "Ninguna página seleccionada";

    }


    return selectedPages.join(", ");

};
    const loadMorePages = () => {

        if (!pdfInfo) {
            return;
        }


        setVisiblePages((current) => {

            return Math.min(
                current + 8,
                pdfInfo.pages
            );

        });

    };


    // ========================================
    // FORMATEAR TAMAÑO
    // ========================================

    const formatFileSize = (bytes) => {

        if (bytes < 1024) {

            return `${bytes} B`;

        }


        if (bytes < 1024 * 1024) {

            return `${(
                bytes / 1024
            ).toFixed(2)} KB`;

        }


        return `${(
            bytes /
            (1024 * 1024)
        ).toFixed(2)} MB`;

    };

// ========================================
// CONFIGURACIÓN PDF → IMAGEN
// ========================================

const handleFormatChange = (format) => {
    setImageFormat(format);
};


const handleQualityChange = (event) => {
    setImageQuality(
        Number(event.target.value)
    );
};


const handleDpiChange = (event) => {
    setImageDpi(
        Number(event.target.value)
    );
};


const handleConvertToImage = async () => {

    if (!pdf) {

        setError(
            "Primero selecciona un PDF."
        );

        return;
    }


    if (selectedPages.length === 0) {

        setError(
            "Selecciona al menos una página para convertir."
        );

        return;
    }


    setError("");

    setIsConverting(true);

    setConversionResult(null);


    // PRUEBA TEMPORAL
    // La conversión real la conectaremos
    // en el siguiente paso.

    const handleConvertToImage = async () => {

    if (!pdf) {

        setError(
            "Primero selecciona un PDF."
        );

        return;
    }


    if (selectedPages.length === 0) {

        setError(
            "Selecciona al menos una página para convertir."
        );

        return;
    }


    try {

        setError("");

        setIsConverting(true);

        setConversionResult(null);

        setConversionDownloadUrl("");

        setConversionDownloadName("");


        const mimeTypes = {
            jpg: "image/jpeg",
            png: "image/png",
            webp: "image/webp",
        };


        const mimeType =
            mimeTypes[imageFormat];


        const quality =
            imageQuality / 100;


        const zip = new JSZip();


        for (
            let index = 0;
            index < selectedPages.length;
            index++
        ) {

            const pageNumber =
                selectedPages[index];


            const page =
                await pdf.getPage(pageNumber);


            /*
             * PDF utiliza 72 puntos por pulgada.
             * Por eso calculamos el factor
             * según el DPI seleccionado.
             */

            const scale =
                imageDpi / 72;


            const viewport =
                page.getViewport({
                    scale,
                });


            const canvas =
                document.createElement(
                    "canvas"
                );


            const context =
                canvas.getContext("2d");


            canvas.width =
                Math.ceil(
                    viewport.width
                );


            canvas.height =
                Math.ceil(
                    viewport.height
                );


            await page.render({
                canvasContext: context,
                viewport,
            }).promise;


            const blob =
                await new Promise(
                    (resolve, reject) => {

                        canvas.toBlob(
                            (result) => {

                                if (result) {
                                    resolve(result);
                                } else {
                                    reject(
                                        new Error(
                                            "No se pudo generar la imagen."
                                        )
                                    );
                                }

                            },
                            mimeType,
                            quality
                        );

                    }
                );


            const extension =
                imageFormat === "jpg"
                    ? "jpg"
                    : imageFormat;


            const fileName =
                `NovaPDF-pagina-${pageNumber}.${extension}`;


            /*
             * Si solo hay una página,
             * guardamos directamente la imagen.
             */

            if (
                selectedPages.length === 1
            ) {

                const url =
                    URL.createObjectURL(
                        blob
                    );


                setConversionDownloadUrl(
                    url
                );


                setConversionDownloadName(
                    fileName
                );

            } else {

                /*
                 * Si hay varias páginas,
                 * las agregamos al ZIP.
                 */

                zip.file(
                    fileName,
                    blob
                );

            }


            /*
             * Actualizamos el resultado
             * mientras procesamos.
             */

            setConversionResult({
                pages: index + 1,
                totalPages:
                    selectedPages.length,
                format: imageFormat,
                dpi: imageDpi,
            });

        }


        /*
         * Si hay varias páginas,
         * generamos el ZIP.
         */

        if (
            selectedPages.length > 1
        ) {

            const zipBlob =
                await zip.generateAsync({
                    type: "blob",
                });


            const zipUrl =
                URL.createObjectURL(
                    zipBlob
                );


            setConversionDownloadUrl(
                zipUrl
            );


            setConversionDownloadName(
                "NovaPDF-imagenes.zip"
            );

        }


        /*
         * Resultado final.
         */

        setConversionResult({

            pages:
                selectedPages.length,

            totalPages:
                selectedPages.length,

            format:
                imageFormat,

            dpi:
                imageDpi,

        });


    } catch (error) {

        console.error(
            "Error al convertir PDF:",
            error
        );


        setError(
            "Ocurrió un error al convertir las páginas del PDF."
        );


        setConversionResult(null);

    } finally {

        setIsConverting(false);

    }

};

};
    // ========================================
    // RENDER
    // ========================================

    return (

        <div className="convert-page">


            {/* ==================================
                ENCABEZADO
            ================================== */}

            <div className="convert-header">

                <span className="convert-badge">
                    🔄 Herramienta NovaPDF
                </span>


                <h1>
                    Convertir PDF
                </h1>


                <p>
                    Convierte tus archivos PDF
                    de forma rápida y sencilla.
                </p>

            </div>


            {/* ==================================
                SELECCIÓN DEL MODO
            ================================== */}

            {!mode && (

                <div className="convert-container">

                    <h2>
                        ¿Qué quieres convertir?
                    </h2>


                    <div className="convert-options">


                        {/* PDF → IMAGEN */}

                        <button
                            type="button"
                            className="convert-option"
                            onClick={() =>
                                selectMode(
                                    "pdf-to-image"
                                )
                            }
                        >

                            <span className="convert-icon">
                                📄
                            </span>


                            <strong>
                                PDF → Imagen
                            </strong>


                            <small>
                                Convierte las páginas
                                de tu PDF a JPG,
                                PNG o WebP.
                            </small>

                        </button>


                        {/* IMAGEN → PDF */}

                        <button
                            type="button"
                            className="convert-option"
                            onClick={() =>
                                selectMode(
                                    "image-to-pdf"
                                )
                            }
                        >

                            <span className="convert-icon">
                                🖼️
                            </span>


                            <strong>
                                Imagen → PDF
                            </strong>


                            <small>
                                Convierte una o varias
                                imágenes en un archivo PDF.
                            </small>

                        </button>


                    </div>

                </div>

            )}


            {/* ==================================
                PDF → IMAGEN
            ================================== */}

            {mode === "pdf-to-image" && (

                <div className="convert-container">


                    {/* ENCABEZADO */}

                    <div className="convert-section-header">

                        <button
                            type="button"
                            className="back-button"
                            onClick={() =>
                                selectMode(null)
                            }
                        >
                            ← Volver
                        </button>


                        <h2>
                            📄 PDF → Imagen
                        </h2>


                        <p>
                            Selecciona el PDF
                            que quieres convertir.
                        </p>

                    </div>


                    {/* ==================================
                        ZONA DE CARGA
                    ================================== */}

                    {!file && (

                        <div
                            className={`pdf-upload ${
                                dragActive
                                    ? "drag-active"
                                    : ""
                            }`}
                            onDragOver={
                                handleDragOver
                            }
                            onDragLeave={
                                handleDragLeave
                            }
                            onDrop={
                                handleDrop
                            }
                        >

                            <div className="upload-icon">
                                📄
                            </div>


                            <h3>
                                Arrastra tu PDF aquí
                            </h3>


                            <p>
                                o selecciona un archivo
                                desde tu computadora
                            </p>


                            <label className="upload-button">

                                📂 Seleccionar PDF


                                <input
                                    type="file"
                                    accept=".pdf,application/pdf"
                                    onChange={
                                        handleFileChange
                                    }
                                    hidden
                                />

                            </label>


                            <span className="upload-help">
                                Solo archivos PDF
                            </span>

                        </div>

                    )}


                    {/* ==================================
                        ERROR
                    ================================== */}

                    {error && (

                        <div className="convert-error">

                            ⚠️ {error}

                        </div>

                    )}


                    {/* ==================================
                        INFORMACIÓN DEL ARCHIVO
                    ================================== */}

                    {file && pdfInfo && (

                        <div className="pdf-file-card">


                            <div className="pdf-file-icon">
                                📄
                            </div>


                            <div className="pdf-file-info">

                                <strong>
                                    {file.name}
                                </strong>


                                <span>
                                    {pdfInfo.size}
                                </span>


                                <span>
                                    {pdfInfo.pages}{" "}

                                    {pdfInfo.pages === 1
                                        ? "página"
                                        : "páginas"}
                                </span>

                            </div>


                            <button
                                type="button"
                                className="remove-file-button"
                                onClick={
                                    removeFile
                                }
                            >
                                🗑️
                            </button>


                        </div>

                    )}


                    {/* ==================================
                        PDF LISTO
                    ================================== */}

                    {file && pdfInfo && (

                        <div className="pdf-ready">


                            <div className="ready-icon">
                                ✓
                            </div>


                            <div>

                                <strong>
                                    PDF cargado correctamente
                                </strong>


                                <p>
                                    El documento tiene{" "}
                                    {pdfInfo.pages}{" "}

                                    {pdfInfo.pages === 1
                                        ? "página"
                                        : "páginas"}.
                                </p>

                            </div>


                        </div>

                    )}


                    {/* ==================================
                        PÁGINAS DEL PDF
                    ================================== */}

                    {pdf && pdfInfo && (

                        <div className="pages-section">


                            <div className="pages-header">

                                <div>

                                    <h3>
                                        Páginas del documento
                                    </h3>


                                    <span>

                                        Mostrando{" "}

                                        {Math.min(
                                            visiblePages,
                                            pdfInfo.pages
                                        )}{" "}

                                        de{" "}

                                        {pdfInfo.pages}{" "}

                                        páginas

                                    </span>

                                </div>

                            </div>

<div className="selection-controls">

        <button
            type="button"
            className="select-all-button"
            onClick={selectAllPages}
        >
            ☑️ Seleccionar todas
        </button>


        <button
            type="button"
            className="clear-selection-button"
            onClick={clearSelection}
        >
            🧹 Limpiar selección
        </button>

    </div>


    <div className="page-range-selector">

        <label>
            Seleccionar páginas por número o rango
        </label>


        <div className="page-range-row">

            <input
                type="text"
                value={pageInput}
                onChange={(event) =>
                    setPageInput(
                        event.target.value
                    )
                }
                placeholder="Ej: 1, 3, 5-8, 10"
            />


            <button
                type="button"
                onClick={
                    applyPageSelection
                }
            >
                Aplicar
            </button>

        </div>


        <small>
            Ejemplo: 1, 3, 5-8, 10
        </small>

    </div>


    <div className="selection-summary">

        <div className="selection-summary-icon">
            📋
        </div>


        <div>

            <strong>
                Resumen de selección
            </strong>


            <p>
                {selectedPages.length}{" "}
                {selectedPages.length === 1
                    ? "página seleccionada"
                    : "páginas seleccionadas"}
            </p>


            {selectedPages.length > 0 && (

                <span>
                    Páginas:{" "}
                    {getSelectionText()}
                </span>

            )}

        </div>

    </div>


                            {/* GRID */}

                            <div className="pdf-pages-grid">

                                {Array.from(
                                    {
                                        length:
                                            Math.min(
                                                visiblePages,
                                                pdfInfo.pages
                                            ),
                                    },
                                    (_, index) => (

                                        <PDFThumbnail
    key={index + 1}
    pdf={pdf}
    pageNumber={index + 1}
    selected={
        selectedPages.includes(
            index + 1
        )
    }
    onSelect={
        togglePageSelection
    }
/>

                                    )
                                )}

                            </div>


                            {/* ==================================
                                CARGAR MÁS
                            ================================== */}

                            {visiblePages < pdfInfo.pages && (

                            <button
                                type="button"
                                className="load-more-button"
                                onClick={loadMorePages}
                            >
                                📄 Cargar más páginas
                            </button>

                        )}


                        {/* ========================================
    CONFIGURACIÓN DE CONVERSIÓN
======================================== */}

<div className="conversion-settings">

    <div className="conversion-settings-header">

        <h3>
            ⚙️ Configuración de conversión
        </h3>

        <p>
            Configura cómo quieres convertir
            las páginas seleccionadas.
        </p>

    </div>


    {/* FORMATO */}

    <div className="conversion-setting">

        <label>
            Formato de imagen
        </label>


        <div className="format-options">

            <button
                type="button"
                className={
                    imageFormat === "jpg"
                        ? "format-option active"
                        : "format-option"
                }
                onClick={() =>
                    handleFormatChange("jpg")
                }
            >
                🖼️ JPG
            </button>


            <button
                type="button"
                className={
                    imageFormat === "png"
                        ? "format-option active"
                        : "format-option"
                }
                onClick={() =>
                    handleFormatChange("png")
                }
            >
                🖼️ PNG
            </button>


            <button
                type="button"
                className={
                    imageFormat === "webp"
                        ? "format-option active"
                        : "format-option"
                }
                onClick={() =>
                    handleFormatChange("webp")
                }
            >
                🌐 WebP
            </button>

        </div>

    </div>


    {/* CALIDAD */}

    <div className="conversion-setting">

        <div className="setting-label-row">

            <label>
                Calidad
            </label>

            <strong>
                {imageQuality}%
            </strong>

        </div>


        <input
            type="range"
            min="10"
            max="100"
            step="5"
            value={imageQuality}
            onChange={handleQualityChange}
        />

    </div>


    {/* RESOLUCIÓN */}

    <div className="conversion-setting">

        <label>
            Resolución
        </label>


        <select
            value={imageDpi}
            onChange={handleDpiChange}
        >

            <option value="72">
                72 DPI — Rápida
            </option>

            <option value="150">
                150 DPI — Recomendada
            </option>

            <option value="200">
                200 DPI — Alta
            </option>

            <option value="300">
                300 DPI — Muy alta
            </option>

        </select>

    </div>


    {/* BOTÓN */}

    <button
        type="button"
        className="convert-images-button"
        onClick={handleConvertToImage}
        disabled={isConverting}
    >

        {isConverting
            ? "⏳ Preparando conversión..."
            : "🖼️ Convertir páginas"
        }

    </button>


    {/* RESULTADO */}

    {conversionResult && (

        <div className="conversion-ready">

            <strong>
                ✅ Configuración lista
            </strong>


            <p>
                {conversionResult.pages}{" "}
                {conversionResult.pages === 1
                    ? "página seleccionada"
                    : "páginas seleccionadas"}
            </p>


            <span>
              {conversionDownloadUrl && (

    <a
        href={conversionDownloadUrl}
        download={conversionDownloadName}
        className="conversion-download-button"
    >
        📥 Descargar{" "}
        {selectedPages.length > 1
            ? "ZIP"
            : "imagen"}
    </a>

)}
                Formato:{" "}
                {conversionResult.format.toUpperCase()}
                {" · "}
                {conversionResult.dpi} DPI
            </span>

        </div>

    )}

</div>


                        </div>

                    )}

                </div>

            )}


            {/* ==================================
                IMAGEN → PDF
            ================================== */}

            {mode === "image-to-pdf" && (

                <div className="convert-container">


                    <div className="convert-section-header">

                        <button
                            type="button"
                            className="back-button"
                            onClick={() =>
                                selectMode(null)
                            }
                        >
                            ← Volver
                        </button>


                        <h2>
                            🖼️ Imagen → PDF
                        </h2>


                        <p>
                            Próximamente podrás
                            convertir tus imágenes
                            en PDF.
                        </p>

                    </div>


                    <div className="coming-soon">

                        <div>
                            🖼️
                        </div>


                        <h3>
                            Imagen → PDF
                        </h3>


                        <p>
                            Esta función la construiremos
                            en la siguiente etapa.
                        </p>

                    </div>


                </div>

            )}

        </div>

    );

}


export default ConvertPDF;