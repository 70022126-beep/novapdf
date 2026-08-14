import { useState } from "react";
import { PDFDocument } from "pdf-lib";
import "./CompressPDF.css";


// ============================================
// CARGA DIFERIDA DE PDF.JS
// ============================================

let pdfjsLibPromise = null;

const getPdfjsLib = async () => {

  if (!pdfjsLibPromise) {

    pdfjsLibPromise = import("pdfjs-dist")
      .then((pdfjsLib) => {

        pdfjsLib.GlobalWorkerOptions.workerSrc =
          new URL(
            "pdfjs-dist/build/pdf.worker.min.mjs",
            import.meta.url
          ).toString();

        return pdfjsLib;

      });

  }

  return pdfjsLibPromise;
};

function CompressPDF() {
  const [file, setFile] = useState(null);

  const [error, setError] = useState("");

  const [pageCount, setPageCount] = useState(0);

  const [compressionLevel, setCompressionLevel] =
    useState("medium");

  const [isDragging, setIsDragging] = useState(false);

  const [isProcessing, setIsProcessing] =
    useState(false);

  const [processingProgress, setProcessingProgress] =
    useState(0);

  const [downloadUrl, setDownloadUrl] =
    useState("");

  const [originalSize, setOriginalSize] =
    useState(0);

  const [compressedSize, setCompressedSize] =
    useState(0);

  const [reductionPercentage, setReductionPercentage] =
    useState(0);

  // =========================================================
  // CONFIGURACIÓN DE COMPRESIÓN
  // =========================================================

  const compressionSettings = {
    low: {
      label: "Baja",
      description: "Mejor calidad",
      scale: 1.4,
      quality: 0.82,
    },

    medium: {
      label: "Media",
      description: "Recomendada",
      scale: 1.0,
      quality: 0.68,
    },

    high: {
      label: "Alta",
      description: "Menor tamaño",
      scale: 0.75,
      quality: 0.48,
    },
  };

  // =========================================================
  // FORMATEAR TAMAÑO
  // =========================================================

  const formatFileSize = (bytes) => {
    if (!bytes || bytes <= 0) {
      return "0 KB";
    }

    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  };

  // =========================================================
  // CARGAR ARCHIVO
  // =========================================================

  const handleSelectedFile = async (selectedFile) => {
    if (!selectedFile) return;

    const isPDF =
      selectedFile.type === "application/pdf" ||
      selectedFile.name
        .toLowerCase()
        .endsWith(".pdf");

    if (!isPDF) {
      setError(
        "Solo puedes seleccionar archivos PDF."
      );

      setFile(null);
      setPageCount(0);

      return;
    }

    try {
      setError("");

      setDownloadUrl("");

      setCompressedSize(0);

      setReductionPercentage(0);

      setProcessingProgress(0);

      const arrayBuffer =
        await selectedFile.arrayBuffer();

      const pdfjsLib = await getPdfjsLib();

      const pdf =
        await pdfjsLib.getDocument({
          data: arrayBuffer,
        }).promise;

      setFile(selectedFile);

      setPageCount(pdf.numPages);

      setOriginalSize(selectedFile.size);

    } catch (error) {
      console.error(error);

      setError(
        "No se pudo leer el archivo PDF. Verifica que sea un PDF válido."
      );

      setFile(null);

      setPageCount(0);

      setOriginalSize(0);
    }
  };

  // =========================================================
  // SELECCIONAR ARCHIVO
  // =========================================================

  const handleFile = (event) => {
    const selectedFile =
      event.target.files[0];

    if (!selectedFile) return;

    handleSelectedFile(selectedFile);

    event.target.value = "";
  };

  // =========================================================
  // ARRASTRAR
  // =========================================================

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

    const droppedFile =
      event.dataTransfer.files[0];

    if (!droppedFile) return;

    handleSelectedFile(droppedFile);
  };

  // =========================================================
  // CAMBIAR NIVEL DE COMPRESIÓN
  // =========================================================

  const changeCompressionLevel = (level) => {
    if (isProcessing) return;

    setCompressionLevel(level);

    setDownloadUrl("");

    setCompressedSize(0);

    setReductionPercentage(0);

    setError("");
  };

  // =========================================================
  // COMPRIMIR PDF
  // =========================================================

  const compressPDF = async () => {
    if (!file) {
      setError(
        "Primero selecciona un archivo PDF."
      );

      return;
    }

    try {
      setError("");

      setDownloadUrl("");

      setCompressedSize(0);

      setReductionPercentage(0);

      setIsProcessing(true);

      setProcessingProgress(0);

      const settings =
        compressionSettings[
          compressionLevel
        ];

      const arrayBuffer =
        await file.arrayBuffer();

      const pdfjsLib = await getPdfjsLib();

      const originalPdf =
        await pdfjsLib.getDocument({
          data: arrayBuffer,
        }).promise;

      const newPdf =
        await PDFDocument.create();

      const totalPages =
        originalPdf.numPages;

      for (
        let pageNumber = 1;
        pageNumber <= totalPages;
        pageNumber++
      ) {
        const page =
          await originalPdf.getPage(
            pageNumber
          );

        // Tamaño real de la página en puntos PDF
        const originalViewport =
          page.getViewport({
            scale: 1,
          });

        // Tamaño utilizado para renderizar
        const renderViewport =
          page.getViewport({
            scale: settings.scale,
          });

        const canvas =
          document.createElement(
            "canvas"
          );

        const context =
          canvas.getContext("2d", {
            alpha: false,
          });

        canvas.width =
          Math.ceil(
            renderViewport.width
          );

        canvas.height =
          Math.ceil(
            renderViewport.height
          );

        // Fondo blanco
        context.fillStyle = "#ffffff";

        context.fillRect(
          0,
          0,
          canvas.width,
          canvas.height
        );

        await page.render({
          canvasContext: context,
          viewport: renderViewport,
        }).promise;

        // Convertimos la página a JPEG
        const jpegDataUrl =
          canvas.toDataURL(
            "image/jpeg",
            settings.quality
          );

        const base64 =
          jpegDataUrl.split(",")[1];

        const binary =
          atob(base64);

        const imageBytes =
          new Uint8Array(
            binary.length
          );

        for (
          let i = 0;
          i < binary.length;
          i++
        ) {
          imageBytes[i] =
            binary.charCodeAt(i);
        }

        const image =
          await newPdf.embedJpg(
            imageBytes
          );

        // Crear una página conservando
        // las dimensiones originales
        const newPage =
          newPdf.addPage([
            originalViewport.width,
            originalViewport.height,
          ]);

        newPage.drawImage(image, {
          x: 0,
          y: 0,

          width:
            originalViewport.width,

          height:
            originalViewport.height,
        });

        const progress =
          Math.round(
            (pageNumber / totalPages) *
              100
          );

        setProcessingProgress(
          progress
        );

        // Permite actualizar la interfaz
        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              0
            )
        );
      }

      // Generar PDF final
      const pdfBytes =
        await newPdf.save({
          useObjectStreams: true,
        });

      const blob =
        new Blob(
          [pdfBytes],
          {
            type: "application/pdf",
          }
        );

      const url =
        URL.createObjectURL(blob);

      setDownloadUrl(url);

      const finalSize =
        blob.size;

      setCompressedSize(
        finalSize
      );

      const reduction =
        originalSize > 0
          ? Math.max(
              0,
              (
                (originalSize -
                  finalSize) /
                originalSize
              ) *
                100
            )
          : 0;

      setReductionPercentage(
        reduction
      );

      setProcessingProgress(
        100
      );

    } catch (error) {
      console.error(error);

      setError(
        "No se pudo comprimir el PDF. Verifica que el archivo sea válido."
      );

      setDownloadUrl("");

    } finally {
      setIsProcessing(false);
    }
  };

  // =========================================================
  // ELIMINAR ARCHIVO
  // =========================================================

  const removeFile = () => {
    if (isProcessing) return;

    if (downloadUrl) {
      URL.revokeObjectURL(
        downloadUrl
      );
    }

    setFile(null);

    setPageCount(0);

    setError("");

    setDownloadUrl("");

    setOriginalSize(0);

    setCompressedSize(0);

    setReductionPercentage(0);

    setProcessingProgress(0);

    setIsProcessing(false);

    setCompressionLevel("medium");
  };

  // =========================================================
  // RENDER
  // =========================================================

  return (
    <section className="compress-page">

      {/* ================================================= */}
      {/* ENCABEZADO */}
      {/* ================================================= */}

      <div className="compress-header">

        <div className="compress-badge">
          🗜️ Herramienta NovaPDF
        </div>

        <h1>
          Comprimir archivos PDF
        </h1>

        <p>
          Reduce el tamaño de tu PDF manteniendo
          una buena calidad.
        </p>

      </div>

      {/* ================================================= */}
      {/* CARGAR PDF */}
      {/* ================================================= */}

      <div
        className={`compress-upload-box ${
          isDragging
            ? "dragging"
            : ""
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >

        {!file ? (
          <>

            <div className="compress-upload-icon">
              {isDragging
                ? "📥"
                : "📄"}
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

            <label className="compress-upload-button">

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

          <div className="compress-file-selected">

            <div className="compress-file-icon">
              📄
            </div>

            <div className="compress-file-info">

              <strong
                title={file.name}
              >
                {file.name}
              </strong>

              <small>
                {formatFileSize(
                  file.size
                )}
              </small>

              <small>
                {pageCount}{" "}
                {pageCount === 1
                  ? "página"
                  : "páginas"}
              </small>

            </div>

            <button
              className="compress-remove-button"
              onClick={removeFile}
              disabled={isProcessing}
            >
              🗑️
            </button>

          </div>

        )}

      </div>

      {/* ================================================= */}
      {/* ERROR */}
      {/* ================================================= */}

      {error && (
        <div className="compress-error">
          ⚠️ {error}
        </div>
      )}

      {/* ================================================= */}
      {/* CONFIGURACIÓN */}
      {/* ================================================= */}

      {file && (
        <div className="compress-options">

          <h2>
            Elige el nivel de compresión
          </h2>

          <p className="compress-options-description">
            Selecciona cuánto quieres reducir el
            tamaño del archivo.
          </p>

          <div className="compression-levels">

            {/* BAJA */}

            <button
              className={`compression-level-card ${
                compressionLevel === "low"
                  ? "active"
                  : ""
              }`}
              onClick={() =>
                changeCompressionLevel(
                  "low"
                )
              }
              disabled={isProcessing}
            >

              <div className="compression-level-icon">
                🟢
              </div>

              <div className="compression-level-content">

                <strong>
                  Baja
                </strong>

                <span>
                  Mejor calidad
                </span>

              </div>

              {compressionLevel ===
                "low" && (
                <div className="compression-check">
                  ✓
                </div>
              )}

            </button>

            {/* MEDIA */}

            <button
              className={`compression-level-card ${
                compressionLevel === "medium"
                  ? "active"
                  : ""
              }`}
              onClick={() =>
                changeCompressionLevel(
                  "medium"
                )
              }
              disabled={isProcessing}
            >

              <div className="compression-level-icon">
                🔵
              </div>

              <div className="compression-level-content">

                <strong>
                  Media
                </strong>

                <span>
                  Recomendada
                </span>

              </div>

              {compressionLevel ===
                "medium" && (
                <div className="compression-check">
                  ✓
                </div>
              )}

            </button>

            {/* ALTA */}

            <button
              className={`compression-level-card ${
                compressionLevel === "high"
                  ? "active"
                  : ""
              }`}
              onClick={() =>
                changeCompressionLevel(
                  "high"
                )
              }
              disabled={isProcessing}
            >

              <div className="compression-level-icon">
                🔴
              </div>

              <div className="compression-level-content">

                <strong>
                  Alta
                </strong>

                <span>
                  Menor tamaño
                </span>

              </div>

              {compressionLevel ===
                "high" && (
                <div className="compression-check">
                  ✓
                </div>
              )}

            </button>

          </div>

          {/* ================================================= */}
          {/* INFORMACIÓN */}
          {/* ================================================= */}

          <div className="compress-info-box">

            <div>
              <span>
                📄 Tamaño original
              </span>

              <strong>
                {formatFileSize(
                  originalSize
                )}
              </strong>
            </div>

            <div>
              <span>
                📑 Páginas
              </span>

              <strong>
                {pageCount}
              </strong>
            </div>

            <div>
              <span>
                ⚙️ Nivel
              </span>

              <strong>
                {
                  compressionSettings[
                    compressionLevel
                  ].label
                }
              </strong>
            </div>

          </div>

          {/* ================================================= */}
          {/* PROGRESO */}
          {/* ================================================= */}

          {isProcessing && (
            <div className="compress-progress">

              <div className="compress-progress-header">

                <span>
                  ⏳ Comprimiendo PDF...
                </span>

                <strong>
                  {processingProgress}%
                </strong>

              </div>

              <div className="compress-progress-bar">

                <div
                  className="compress-progress-fill"
                  style={{
                    width: `${processingProgress}%`,
                  }}
                />

              </div>

              <small>
                Procesando{" "}
                {pageCount}{" "}
                {pageCount === 1
                  ? "página"
                  : "páginas"}
              </small>

            </div>
          )}

          {/* ================================================= */}
          {/* BOTÓN COMPRIMIR */}
          {/* ================================================= */}

          <button
            className="compress-button"
            onClick={compressPDF}
            disabled={isProcessing}
          >
            {isProcessing
              ? "⏳ Comprimiendo PDF..."
              : "🗜️ Comprimir PDF"}
          </button>

        </div>
      )}

      {/* ================================================= */}
      {/* RESULTADO */}
      {/* ================================================= */}

      {downloadUrl &&
        !isProcessing && (
          <div className="compress-result">

            <div className="compress-result-icon">
              ✅
            </div>

            <h2>
              ¡PDF comprimido correctamente!
            </h2>

            <p>
              Tu archivo ya está listo para
              descargar.
            </p>

            <div className="compress-result-stats">

              <div>
                <span>
                  Original
                </span>

                <strong>
                  {formatFileSize(
                    originalSize
                  )}
                </strong>
              </div>

              <div>
                <span>
                  Comprimido
                </span>

                <strong>
                  {formatFileSize(
                    compressedSize
                  )}
                </strong>
              </div>

              <div>
                <span>
                  Reducción
                </span>

                <strong>
                  {reductionPercentage.toFixed(
                    1
                  )}
                  %
                </strong>
              </div>

            </div>

            {compressedSize >=
              originalSize && (
              <div className="compress-warning">
                ⚠️ Este PDF ya estaba bastante
                optimizado. La nueva versión no
                resultó más pequeña.
              </div>
            )}

            <a
              className="compress-download-button"
              href={downloadUrl}
              download="NovaPDF-documento-comprimido.pdf"
            >
              ⬇️ Descargar PDF
            </a>

          </div>
        )}

    </section>
  );
}

export default CompressPDF;