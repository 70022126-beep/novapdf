import { useEffect, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
} from "pdfjs-dist";

import pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs?url";

import "./PDFThumbnail.css";

GlobalWorkerOptions.workerSrc = pdfjsWorker;

function PDFThumbnail({ file }) {
  const [thumbnail, setThumbnail] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const generateThumbnail = async () => {
      try {
        const arrayBuffer = await file.arrayBuffer();

        const pdf = await getDocument({
          data: arrayBuffer,
        }).promise;

        const page = await pdf.getPage(1);

        const viewport = page.getViewport({
          scale: 0.5,
        });

        const canvas = document.createElement("canvas");

        const context = canvas.getContext("2d");

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        await page.render({
          canvasContext: context,
          viewport: viewport,
        }).promise;

        if (!cancelled) {
          setThumbnail(canvas.toDataURL("image/png"));
        }
      } catch (error) {
        console.error(
          "Error generando miniatura:",
          error
        );
      }
    };

    generateThumbnail();

    return () => {
      cancelled = true;
    };
  }, [file]);

  return (
    <div className="pdf-thumbnail">
      {thumbnail ? (
        <img
          src={thumbnail}
          alt={`Vista previa de ${file.name}`}
        />
      ) : (
        <div className="thumbnail-loading">
          📄
        </div>
      )}
    </div>
  );
}

export default PDFThumbnail;