import { useState } from "react";
import { PDFDocument } from "pdf-lib";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import "./MergePDF.css";
import PDFThumbnail from "../../components/PDFThumbnail/PDFThumbnail";


// ======================================================
// TARJETA DE ARCHIVO ARRASTRABLE
// ======================================================

function SortableFileItem({
  file,
  index,
  files,
  merging,
  moveUp,
  moveDown,
  removeFile,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `${file.name}-${index}`,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : "auto",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`file-item ${isDragging ? "dragging-file" : ""}`}
    >

      {/* ASA PARA ARRASTRAR */}
      <div
        className="drag-handle"
        {...attributes}
        {...listeners}
        title="Arrastrar para cambiar el orden"
      >
        ⋮⋮
      </div>


      {/* NÚMERO */}
      <div className="file-number">
        {index + 1}
      </div>


      {/* MINIATURA */}
      <PDFThumbnail file={file} />


      {/* INFORMACIÓN */}
      <div className="file-info">

        <strong>
          {file.name}
        </strong>

        <small>
          {(file.size / 1024 / 1024).toFixed(2)} MB
        </small>

      </div>


      {/* BOTONES */}
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
  );
}


// ======================================================
// COMPONENTE PRINCIPAL
// ======================================================

function MergePDF() {

  const [files, setFiles] = useState([]);
  const [merging, setMerging] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [sortOrder, setSortOrder] = useState("asc");

  // Sensores de @dnd-kit
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    })
  );


  // ======================================================
  // SELECCIONAR ARCHIVOS
  // ======================================================

  const handleFiles = (event) => {

    const selectedFiles = Array.from(
      event.target.files
    );

    const validFiles = selectedFiles.filter(
      (file) => file.type === "application/pdf"
    );

    setFiles((prevFiles) => [
      ...prevFiles,
      ...validFiles,
    ]);

    setMessage("");
    setError("");

    event.target.value = "";
  };


  // ======================================================
  // ARRASTRAR ARCHIVOS DESDE LA COMPUTADORA
  // ======================================================

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

    const droppedFiles = Array.from(
      event.dataTransfer.files
    );

    const pdfFiles = droppedFiles.filter(
      (file) => file.type === "application/pdf"
    );

    if (pdfFiles.length > 0) {

      setFiles((prevFiles) => [
        ...prevFiles,
        ...pdfFiles,
      ]);

      setMessage("");
      setError("");
    }
  };


  // ======================================================
  // MOVER ARRIBA
  // ======================================================

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


  // ======================================================
  // MOVER ABAJO
  // ======================================================

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


  // ======================================================
  // ELIMINAR
  // ======================================================

  const removeFile = (index) => {

    const newFiles = files.filter(
      (_, i) => i !== index
    );

    setFiles(newFiles);

    setDownloadUrl("");
    setMessage("");
  };


  // ======================================================
  // ARRASTRE CON DND-KIT
  // ======================================================

  const handleDragEnd = (event) => {

    const { active, over } = event;

    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = files.findIndex(
      (file, index) =>
        `${file.name}-${index}` === active.id
    );

    const newIndex = files.findIndex(
      (file, index) =>
        `${file.name}-${index}` === over.id
    );

    if (
      oldIndex === -1 ||
      newIndex === -1
    ) {
      return;
    }

    const newFiles = arrayMove(
      files,
      oldIndex,
      newIndex
    );

    setFiles(newFiles);

    setDownloadUrl("");
    setMessage("");
  };


  // ======================================================
  // LIMPIAR TODO
  // ======================================================

const sortAlphabetically = () => {
  const newOrder = sortOrder === "asc" ? "desc" : "asc";

  const sortedFiles = [...files].sort((a, b) => {
    const comparison = a.name.localeCompare(
      b.name,
      undefined,
      {
        numeric: true,
        sensitivity: "base",
      }
    );

    return newOrder === "asc"
      ? comparison
      : -comparison;
  });

  setFiles(sortedFiles);
  setSortOrder(newOrder);
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


  // ======================================================
  // UNIR PDF
  // ======================================================

  const mergePDFs = async () => {

    if (files.length < 2) {

      setError(
        "Selecciona al menos 2 archivos PDF para unirlos."
      );

      setMessage("");

      return;
    }


    try {

      setMerging(true);
      setProgress(0);
      setMessage("");
      setError("");
      setDownloadUrl("");


      const mergedPdf =
        await PDFDocument.create();


      for (
        let i = 0;
        i < files.length;
        i++
      ) {

        const file = files[i];

        const arrayBuffer =
          await file.arrayBuffer();

        const pdf =
          await PDFDocument.load(arrayBuffer);

        const pages =
          await mergedPdf.copyPages(
            pdf,
            pdf.getPageIndices()
          );

        pages.forEach((page) => {
          mergedPdf.addPage(page);
        });


        const currentProgress =
          Math.round(
            ((i + 1) / files.length) * 100
          );

        setProgress(currentProgress);
      }


      const mergedPdfBytes =
        await mergedPdf.save();


      const blob = new Blob(
        [mergedPdfBytes],
        {
          type: "application/pdf",
        }
      );


      const url =
        URL.createObjectURL(blob);


      setDownloadUrl(url);


      const link =
        document.createElement("a");

      link.href = url;

      link.download =
        "NovaPDF-documento-unido.pdf";


      document.body.appendChild(link);

      link.click();

      document.body.removeChild(link);


      setMessage(
        "¡PDF unidos correctamente!"
      );

    } catch (error) {

      console.error(error);

      setError(
        "No se pudieron unir los archivos. Verifica que sean PDF válidos."
      );

    } finally {

      setMerging(false);

    }
  };


  // ======================================================
  // INTERFAZ
  // ======================================================

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


      {/* ZONA DE CARGA */}

      <div
        className={`upload-box ${
          isDragging ? "dragging" : ""
        }`}
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


      {/* LISTA DE ARCHIVOS */}

      {files.length > 0 && (

        <div className="file-list">


          <div className="file-list-header">

            <div>

              <h2>
                Archivos seleccionados
              </h2>

              <p>
                {files.length} archivo
                {files.length !== 1
                  ? "s"
                  : ""}
              </p>

            </div>


            <div className="file-header-actions">

  <button
  className="sort-button"
  onClick={sortAlphabetically}
  disabled={merging || files.length < 2}
>
  {sortOrder === "asc"
    ? "🔤 Ordenar A-Z"
    : "🔤 Ordenar Z-A"}
</button>

  <button
    className="clear-button"
    onClick={clearAll}
    disabled={merging}
  >
    🧹 Limpiar todo
  </button>

</div>

          </div>


          {/* DND-KIT */}

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >

            <SortableContext
              items={files.map(
                (file, index) =>
                  `${file.name}-${index}`
              )}
              strategy={
                verticalListSortingStrategy
              }
            >

              {files.map(
                (file, index) => (

                  <SortableFileItem
                    key={`${file.name}-${index}`}
                    file={file}
                    index={index}
                    files={files}
                    merging={merging}
                    moveUp={moveUp}
                    moveDown={moveDown}
                    removeFile={removeFile}
                  />

                )
              )}

            </SortableContext>

          </DndContext>


          {/* PROGRESO */}

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


          {/* MENSAJE ÉXITO */}

          {message && (

            <div className="success-message">
              ✅ {message}
            </div>

          )}


          {/* ERROR */}

          {error && (

            <div className="error-message">
              ⚠️ {error}
            </div>

          )}


          {/* BOTÓN UNIR */}

          <button
            className="merge-button"
            onClick={mergePDFs}
            disabled={merging}
          >

            {merging
              ? "⏳ Uniendo PDF..."
              : "🔗 Unir PDF"}

          </button>


          {/* DESCARGAR NUEVAMENTE */}

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