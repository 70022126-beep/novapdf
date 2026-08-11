import { useState } from "react";
import { PDFDocument } from "pdf-lib";
import "./MergePDF.css";


function MergePDF() {
  const [files, setFiles] = useState([]);
  const [merging, setMerging] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");

  const handleFiles = (event) => {
    const selectedFiles = Array.from(event.target.files);

    const validFiles = selectedFiles.filter(
      (file) => file.type === "application/pdf"
    );

    setFiles((prevFiles) => [...prevFiles, ...validFiles]);

    setMessage("");
    setError("");

    event.target.value = "";
  };

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

    const droppedFiles = Array.from(event.dataTransfer.files);

    const pdfFiles = droppedFiles.filter(
      (file) => file.type === "application/pdf"
    );

    if (pdfFiles.length > 0) {
      setFiles((prevFiles) => [...prevFiles, ...pdfFiles]);
      setMessage("");
      setError("");
    }
  };

  const moveUp = (index) => {
    if (index === 0) return;

    const newFiles = [...files];

    [newFiles[index - 1], newFiles[index]] = [
      newFiles[index],
      newFiles[index - 1],
    ];

    setFiles(newFiles);
    setDownloadUrl("");
    setMessage("");
  };

  const moveDown = (index) => {
    if (index === files.length - 1) return;

    const newFiles = [...files];

    [newFiles[index], newFiles[index + 1]] = [
      newFiles[index + 1],
      newFiles[index],
    ];

    setFiles(newFiles);
    setDownloadUrl("");
    setMessage("");
  };

  const removeFile = (index) => {
    const newFiles = files.filter((_, i) => i !== index);

    setFiles(newFiles);
    setDownloadUrl("");
    setMessage("");
  };

  const clearAll = () => {
    setFiles([]);
    setProgress(0);
    setMessage("");
    setError("");
    setDownloadUrl("");
  };

  const mergePDFs = async () => {
    if (files.length < 2) {
      setError("Selecciona al menos 2 archivos PDF para unirlos.");
      setMessage("");
      return;
    }

    try {
      setMerging(true);
      setProgress(0);
      setMessage("");
      setError("");
      setDownloadUrl("");

      const mergedPdf = await PDFDocument.create();

      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        const arrayBuffer = await file.arrayBuffer();

        const pdf = await PDFDocument.load(arrayBuffer);

        const pages = await mergedPdf.copyPages(
          pdf,
          pdf.getPageIndices()
        );

        pages.forEach((page) => {
          mergedPdf.addPage(page);
        });

        const currentProgress = Math.round(
          ((i + 1) / files.length) * 100
        );

        setProgress(currentProgress);
      }

      const mergedPdfBytes = await mergedPdf.save();

      const blob = new Blob([mergedPdfBytes], {
        type: "application/pdf",
      });

      const url = URL.createObjectURL(blob);

      setDownloadUrl(url);

      const link = document.createElement("a");

      link.href = url;
      link.download = "NovaPDF-documento-unido.pdf";

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setMessage("¡PDF unidos correctamente!");
    } catch (error) {
      console.error(error);

      setError(
        "No se pudieron unir los archivos. Verifica que sean PDF válidos."
      );
    } finally {
      setMerging(false);
    }
  };

  return (
    <section className="merge-page">

      <div className="merge-header">

        <div className="merge-badge">
          🚀 Herramienta NovaPDF
        </div>

        <h1>
          Unir archivos PDF
        </h1>

        <p>
          Combina varios documentos PDF en un solo archivo
          de forma rápida y sencilla.
        </p>

      </div>

      <div
        className={`upload-box ${isDragging ? "dragging" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >

        <div className="upload-icon">
          📁
        </div>

        <h2>
          Arrastra tus archivos PDF aquí
        </h2>

        {isDragging && (
          <div className="drag-message">
            📥 Suelta tus archivos aquí
          </div>
        )}

        <p>
          O selecciona los archivos desde tu computadora.
        </p>

        <label className="upload-button">

          📂 Seleccionar archivos

          <input
            type="file"
            accept=".pdf,application/pdf"
            multiple
            onChange={handleFiles}
          />

        </label>

        <small>
          Puedes seleccionar varios archivos PDF
        </small>

      </div>

      {files.length > 0 && (

        <div className="file-list">

          <div className="file-list-header">

            <div>
              <h2>
                Archivos seleccionados
              </h2>

              <p>
                {files.length} archivo
                {files.length !== 1 ? "s" : ""}
              </p>
            </div>

            <button
              className="clear-button"
              onClick={clearAll}
              disabled={merging}
            >
              🧹 Limpiar todo
            </button>

          </div>

          {files.map((file, index) => (

            <div
              className="file-item"
              key={`${file.name}-${index}`}
            >

              <div className="file-number">
                {index + 1}
              </div>

              <div className="file-icon">
                📄
              </div>

              <div className="file-info">

                <strong>
                  {file.name}
                </strong>

                <small>
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </small>

              </div>

              <div className="file-actions">

                <button
                  className="move-button"
                  disabled={index === 0 || merging}
                  onClick={() => moveUp(index)}
                  title="Mover arriba"
                >
                  ↑
                </button>

                <button
                  className="move-button"
                  disabled={
                    index === files.length - 1 || merging
                  }
                  onClick={() => moveDown(index)}
                  title="Mover abajo"
                >
                  ↓
                </button>

                <button
                  className="remove-button"
                  disabled={merging}
                  onClick={() => removeFile(index)}
                  title="Eliminar archivo"
                >
                  🗑️
                </button>

              </div>

            </div>

          ))}

          {merging && (

            <div className="progress-container">

              <div className="progress-header">

                <span>
                  Preparando documento...
                </span>

                <strong>
                  {progress}%
                </strong>

              </div>

              <div className="progress-bar">

                <div
                  className="progress-fill"
                  style={{
                    width: `${progress}%`,
                  }}
                />

              </div>

            </div>

          )}

          {message && (

            <div className="success-message">
              ✅ {message}
            </div>

          )}

          {error && (

            <div className="error-message">
              ⚠️ {error}
            </div>

          )}

          <button
            className="merge-button"
            onClick={mergePDFs}
            disabled={merging}
          >

            {merging
              ? "⏳ Uniendo PDF..."
              : "🔗 Unir PDF"}

          </button>

          {downloadUrl && !merging && (

            <a
              className="download-button"
              href={downloadUrl}
              download="NovaPDF-documento-unido.pdf"
            >
              ⬇️ Descargar nuevamente
            </a>

          )}

        </div>

      )}

    </section>
  );
}

export default MergePDF;