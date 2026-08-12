import { useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import "./SplitPDF.css";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

function SplitPDF() {
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [pages, setPages] = useState([]);
  const [showPages, setShowPages] = useState(false);
  const [selectedPages, setSelectedPages] = useState([]);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [splitMode, setSplitMode] = useState("selected");
  const [pageRange, setPageRange] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);

  // =========================
  // CARGAR ARCHIVO PDF
  // =========================

  const handleSelectedFile = async (selectedFile) => {
    if (!selectedFile) return;

    if (selectedFile.type !== "application/pdf") {
      setError("Solo puedes seleccionar archivos PDF.");
      setFile(null);
      setPageCount(0);
      return;
    }

    try {
      setError("");
      setIsProcessing(false);
      setProcessingProgress(0);

      const arrayBuffer = await selectedFile.arrayBuffer();

      const pdf = await pdfjsLib.getDocument({
        data: arrayBuffer,
      }).promise;

      setFile(selectedFile);
      setPageCount(pdf.numPages);
      setPages([]);
      setShowPages(false);
      setSelectedPages([]);
      setDownloadUrl("");
      setPageRange("");
    } catch (error) {
      console.error(error);

      setError(
        "No se pudo leer el archivo PDF. Verifica que sea un PDF válido."
      );

      setFile(null);
      setPageCount(0);
    }
  };

  // =========================
  // SELECCIONAR DESDE BOTÓN
  // =========================

  const handleFile = (event) => {
    const selectedFile = event.target.files[0];

    if (!selectedFile) return;

    handleSelectedFile(selectedFile);

    event.target.value = "";
  };

  // =========================
  // ARRASTRAR PDF
  // =========================

  const handleDragOver = (event) => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (event) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setIsDragging(false);

    const droppedFile = event.dataTransfer.files[0];

    if (!droppedFile) return;

    if (droppedFile.type !== "application/pdf") {
      setError("Solo puedes arrastrar archivos PDF.");
      return;
    }

    handleSelectedFile(droppedFile);
  };

  // =========================
  // SELECCIONAR / DESELECCIONAR PÁGINA
  // =========================

  const togglePageSelection = (pageNumber) => {
    setSelectedPages((prevSelected) => {
      if (prevSelected.includes(pageNumber)) {
        return prevSelected.filter(
          (page) => page !== pageNumber
        );
      }

      return [...prevSelected, pageNumber];
    });
  };

  // =========================
  // SELECCIONAR TODAS
  // =========================

  const selectAllPages = () => {
    setSelectedPages(
      pages.map((page) => page.number)
    );
  };

  // =========================
  // DESELECCIONAR TODAS
  // =========================

  const deselectAllPages = () => {
    setSelectedPages([]);
    setPageRange("");
  };

  // =========================
  // FORMATEAR SELECCIÓN
  // =========================

  const formatSelectedPages = () => {
    if (selectedPages.length === 0) {
      return "Ninguna";
    }

    const sortedPages = [...selectedPages].sort(
      (a, b) => a - b
    );

    const ranges = [];

    let start = sortedPages[0];
    let end = sortedPages[0];

    for (let i = 1; i < sortedPages.length; i++) {
      if (sortedPages[i] === end + 1) {
        end = sortedPages[i];
      } else {
        ranges.push(
          start === end
            ? `${start}`
            : `${start}–${end}`
        );

        start = sortedPages[i];
        end = sortedPages[i];
      }
    }

    ranges.push(
      start === end
        ? `${start}`
        : `${start}–${end}`
    );

    return ranges.join(", ");
  };

  // =========================
  // SELECCIONAR POR RANGO
  // =========================

  const applyPageRange = () => {
    if (!pageRange.trim()) {
      setError(
        "Escribe las páginas que deseas seleccionar."
      );
      return;
    }

    try {
      const selected = new Set();

      const parts = pageRange.split(",");

      for (const part of parts) {
        const value = part.trim();

        if (!value) continue;

        if (value.includes("-")) {
          const [startText, endText] =
            value.split("-");

          const start = Number(startText);
          const end = Number(endText);

          if (
            !Number.isInteger(start) ||
            !Number.isInteger(end) ||
            start < 1 ||
            end > pageCount ||
            start > end
          ) {
            throw new Error("Rango inválido");
          }

          for (let i = start; i <= end; i++) {
            selected.add(i);
          }
        } else {
          const page = Number(value);

          if (
            !Number.isInteger(page) ||
            page < 1 ||
            page > pageCount
          ) {
            throw new Error("Página inválida");
          }

          selected.add(page);
        }
      }

      setSelectedPages(
        Array.from(selected).sort(
          (a, b) => a - b
        )
      );

      setError("");
      setPageRange("");
    } catch (error) {
      setError(
        "Rango inválido. Usa un formato como: 1, 5, 10-15, 20"
      );
    }
  };

  // =========================
  // CARGAR MINIATURAS
  // =========================

  const loadPages = async () => {
    if (!file) return;

    try {
      setError("");

      const arrayBuffer =
        await file.arrayBuffer();

      const pdf =
        await pdfjsLib.getDocument({
          data: arrayBuffer,
        }).promise;

      const loadedPages = [];

      const pagesToLoad = Math.min(
        pdf.numPages,
        pages.length + 20
      );

      for (
        let i = pages.length + 1;
        i <= pagesToLoad;
        i++
      ) {
        const page = await pdf.getPage(i);

        const viewport =
          page.getViewport({
            scale: 0.5,
          });

        const canvas =
          document.createElement("canvas");

        const context =
          canvas.getContext("2d");

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({
          canvasContext: context,
          viewport: viewport,
        }).promise;

        loadedPages.push({
          number: i,
          thumbnail: canvas.toDataURL(
            "image/jpeg",
            0.8
          ),
        });
      }

      setPages((prevPages) => [
        ...prevPages,
        ...loadedPages,
      ]);

      setShowPages(true);
    } catch (error) {
      console.error(error);

      setError(
        "No se pudieron generar las miniaturas del PDF."
      );
    }
  };

  // =========================
  // DIVIDIR CADA PÁGINA
  // =========================

  const splitEachPage = async () => {
    if (!file) {
      setError(
        "Primero selecciona un archivo PDF."
      );
      return;
    }

    try {
      setError("");
      setIsProcessing(true);
      setProcessingProgress(0);
      setDownloadUrl("");

      const arrayBuffer =
        await file.arrayBuffer();

      const originalPdf =
        await PDFDocument.load(arrayBuffer);

      const totalPages =
        originalPdf.getPageCount();

      const zip = new JSZip();

      for (
        let i = 0;
        i < totalPages;
        i++
      ) {
        const newPdf =
          await PDFDocument.create();

        const [copiedPage] =
          await newPdf.copyPages(
            originalPdf,
            [i]
          );

        newPdf.addPage(copiedPage);

        const pdfBytes =
          await newPdf.save();

        zip.file(
          `NovaPDF-pagina-${i + 1}.pdf`,
          pdfBytes
        );

        const progress = Math.round(
          ((i + 1) / totalPages) * 100
        );

        setProcessingProgress(progress);

        // Permite que el navegador actualice
        // visualmente la barra de progreso
        await new Promise((resolve) =>
          setTimeout(resolve, 0)
        );
      }

      const zipBlob =
        await zip.generateAsync({
          type: "blob",
        });

      const url =
        URL.createObjectURL(zipBlob);

      setDownloadUrl(url);
      setError("");
    } catch (error) {
      console.error(error);

      setError(
        "No se pudo dividir el PDF en páginas individuales."
      );
    } finally {
      setIsProcessing(false);
    }
  };

  // =========================
  // EXTRAER PÁGINAS SELECCIONADAS
  // =========================

  const splitPDF = async () => {
    if (!file) {
      setError(
        "Primero selecciona un archivo PDF."
      );
      return;
    }

    if (selectedPages.length === 0) {
      setError(
        "Selecciona al menos una página para dividir el PDF."
      );
      return;
    }

    try {
      setError("");

      const arrayBuffer =
        await file.arrayBuffer();

      const originalPdf =
        await PDFDocument.load(arrayBuffer);

      const newPdf =
        await PDFDocument.create();

      const pageIndices = [...selectedPages]
        .sort((a, b) => a - b)
        .map(
          (pageNumber) =>
            pageNumber - 1
        );

      const copiedPages =
        await newPdf.copyPages(
          originalPdf,
          pageIndices
        );

      copiedPages.forEach((page) => {
        newPdf.addPage(page);
      });

      const pdfBytes =
        await newPdf.save();

      const blob = new Blob(
        [pdfBytes],
        {
          type: "application/pdf",
        }
      );

      const url =
        URL.createObjectURL(blob);

      setDownloadUrl(url);
      setError("");
    } catch (error) {
      console.error(error);

      setError(
        "No se pudo dividir el PDF. Verifica que el archivo sea válido."
      );
    }
  };

  // =========================
  // ELIMINAR ARCHIVO
  // =========================

  const removeFile = () => {
    setFile(null);
    setPageCount(0);
    setPages([]);
    setShowPages(false);
    setSelectedPages([]);
    setDownloadUrl("");
    setPageRange("");
    setError("");
    setIsProcessing(false);
    setProcessingProgress(0);
  };

  // =========================
  // INTERFAZ
  // =========================

  return (
    <section className="split-page">

      {/* ENCABEZADO */}
      <div className="split-header">

        <div className="split-badge">
          ✂️ Herramienta NovaPDF
        </div>

        <h1>
          Dividir archivos PDF
        </h1>

        <p>
          Divide un documento PDF en diferentes
          archivos de forma rápida y sencilla.
        </p>

      </div>


      {/* CARGAR PDF */}
      <div
        className={`split-upload-box ${
          isDragging ? "dragging" : ""
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >

        {!file ? (
          <>

            <div className="split-upload-icon">
              {isDragging ? "📥" : "📄"}
            </div>

            <h2>
              {isDragging
                ? "Suelta tu PDF aquí"
                : "Selecciona tu archivo PDF"}
            </h2>

            <p>
              {isDragging
                ? "Suelta el archivo para comenzar."
                : "Arrastra un PDF aquí o selecciónalo desde tu computadora."}
            </p>

            <label className="split-upload-button">

              📂 Seleccionar PDF

              <input
                type="file"
                accept=".pdf,application/pdf"
                onChange={handleFile}
              />

            </label>

            <small>
              Solo se permite un archivo PDF
            </small>

          </>
        ) : (

          <div className="split-file-selected">

            <div className="split-file-icon">
              📄
            </div>

            <div className="split-file-info">

              <strong>
                {file.name}
              </strong>

              <small>
                {(file.size / 1024 / 1024).toFixed(2)} MB
              </small>

              <small>
                {pageCount}{" "}
                {pageCount === 1
                  ? "página"
                  : "páginas"}
              </small>

            </div>

            <button
              className="split-remove-button"
              onClick={removeFile}
            >
              🗑️
            </button>

          </div>

        )}

      </div>


      {/* ERROR */}
      {error && (
        <div className="split-error">
          ⚠️ {error}
        </div>
      )}


      {/* CONTINUAR */}
      {file && (
        <div className="split-next-section">

          <h2>
            ¿Cómo quieres dividir tu PDF?
          </h2>

          <p>
            En el siguiente paso podrás seleccionar
            las páginas que deseas extraer.
          </p>

          <button
            className="split-continue-button"
            onClick={loadPages}
          >
            ✂️ Continuar
          </button>

        </div>
      )}


      {/* PÁGINAS */}
      {showPages && (
        <div className="split-pages-section">

          {/* MODO DE DIVISIÓN */}
          <div className="split-mode-section">

            <h3>
              ¿Cómo quieres dividir tu PDF?
            </h3>

            <div className="split-mode-options">

              <button
                className={`split-mode-button ${
                  splitMode === "selected"
                    ? "active"
                    : ""
                }`}
                onClick={() =>
                  setSplitMode("selected")
                }
              >
                📄 Extraer páginas seleccionadas
              </button>

              <button
                className={`split-mode-button ${
                  splitMode === "each"
                    ? "active"
                    : ""
                }`}
                onClick={() =>
                  setSplitMode("each")
                }
              >
                📑 Dividir cada página
              </button>

            </div>

          </div>


          {/* ENCABEZADO DE PÁGINAS */}
          <div className="split-pages-header">

            <div>

              <h2>
                Páginas del documento
              </h2>

              <p>
                Mostrando {pages.length} de{" "}
                {pageCount} páginas
              </p>

              <p className="selected-pages-count">
                {selectedPages.length}{" "}
                {selectedPages.length === 1
                  ? "página seleccionada"
                  : "páginas seleccionadas"}
              </p>

              <p className="selected-pages-detail">
                Páginas seleccionadas:{" "}
                <strong>
                  {formatSelectedPages()}
                </strong>
              </p>

            </div>


            {/* ACCIONES */}
            <div className="selection-actions">

              <button
                className="select-all-button"
                onClick={selectAllPages}
                disabled={pages.length === 0}
              >
                ☑ Seleccionar todas
              </button>

              <button
                className="deselect-all-button"
                onClick={deselectAllPages}
                disabled={
                  selectedPages.length === 0
                }
              >
                🧹 Limpiar selección
              </button>

            </div>

          </div>


          {/* RANGO */}
          <div className="page-range-selector">

            <label>
              Seleccionar páginas por número o rango
            </label>

            <div className="page-range-input">

              <input
                type="text"
                value={pageRange}
                onChange={(event) =>
                  setPageRange(
                    event.target.value
                  )
                }
                placeholder="Ej: 1, 5, 10-15, 20"
              />

              <button
                className="apply-range-button"
                onClick={applyPageRange}
              >
                Aplicar
              </button>

            </div>

            <small>
              Ejemplo: 1, 5, 10-15, 20
            </small>

          </div>


          {/* GRID DE PÁGINAS */}
          <div className="split-pages-grid">

            {pages.map((page) => (

              <div
                className={`split-page-card ${
                  selectedPages.includes(
                    page.number
                  )
                    ? "selected"
                    : ""
                }`}
                key={page.number}
                onClick={() =>
                  togglePageSelection(
                    page.number
                  )
                }
              >

                <div className="split-page-number">
                  Página {page.number}
                </div>

                <div className="page-selection-indicator">
                  {selectedPages.includes(
                    page.number
                  )
                    ? "✓"
                    : ""}
                </div>

                <img
                  src={page.thumbnail}
                  alt={`Página ${page.number}`}
                />

              </div>

            ))}

          </div>


          {/* CARGAR MÁS */}
          {pages.length < pageCount && (
            <button
              className="load-more-button"
              onClick={loadPages}
            >
              📄 Cargar más páginas
            </button>
          )}


          {/* BARRA DE PROGRESO */}
          {isProcessing &&
            splitMode === "each" && (
              <div className="processing-progress">

                <div className="processing-progress-header">

                  <span>
                    ⏳ Dividiendo PDF...
                  </span>

                  <strong>
                    {processingProgress}%
                  </strong>

                </div>

                <div className="processing-progress-bar">

                  <div
                    className="processing-progress-fill"
                    style={{
                      width: `${processingProgress}%`,
                    }}
                  />

                </div>

                <small>
                  Procesando página{" "}
                  {Math.max(
                    1,
                    Math.ceil(
                      (processingProgress / 100) *
                        pageCount
                    )
                  )}{" "}
                  de {pageCount}
                </small>

              </div>
            )}


          {/* BOTÓN PRINCIPAL */}
          <button
            className="split-pdf-button"
            onClick={
              splitMode === "selected"
                ? splitPDF
                : splitEachPage
            }
            disabled={
              isProcessing ||
              (splitMode === "selected" &&
                selectedPages.length === 0)
            }
          >

            {isProcessing
              ? "⏳ Procesando PDF..."
              : splitMode === "selected"
                ? "✂️ Extraer páginas seleccionadas"
                : "📑 Dividir cada página"}

          </button>


          {/* RESULTADO */}
          {downloadUrl && (
            <div className="split-success">

              <div className="split-success-icon">
                ✅
              </div>

              <h3>
                ¡Proceso completado correctamente!
              </h3>

              {splitMode === "selected" ? (
                <>

                  <p>
                    Se extrajeron{" "}
                    {selectedPages.length}{" "}
                    {selectedPages.length === 1
                      ? "página"
                      : "páginas"}{" "}
                    del documento.
                  </p>

                  <a
                    className="split-download-button"
                    href={downloadUrl}
                    download="NovaPDF-documento-dividido.pdf"
                  >
                    ⬇️ Descargar PDF
                  </a>

                </>
              ) : (
                <>

                  <p>
                    Se crearon {pageCount} archivos
                    PDF, uno por cada página.
                  </p>

                  <a
                    className="split-download-button"
                    href={downloadUrl}
                    download="NovaPDF-paginas-separadas.zip"
                  >
                    📦 Descargar archivos ZIP
                  </a>

                </>
              )}

            </div>
          )}

        </div>
      )}

    </section>
  );
}

export default SplitPDF;