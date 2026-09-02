import { useEffect, useState } from "react";

import "./PDFThumbnail.css";


function PDFThumbnail({ file }) {

  const [thumbnail, setThumbnail] = useState(null);


  useEffect(() => {

    let cancelled = false;


    const generateThumbnail = async () => {

      try {

        // ============================================
        // CARGAR PDF.JS SOLO CUANDO SE NECESITA
        // ============================================

        const pdfjsLib = await import("pdfjs-dist");


        // ============================================
        // CARGAR WORKER SOLO CUANDO SE NECESITA
        // ============================================

        const pdfjsWorker = await import(
          "pdfjs-dist/build/pdf.worker.min.mjs?url"
        );


        pdfjsLib.GlobalWorkerOptions.workerSrc =
          pdfjsWorker.default;


        // ============================================
        // LEER ARCHIVO
        // ============================================

        const arrayBuffer =
          await file.arrayBuffer();


        // ============================================
        // CARGAR PDF
        // ============================================

        const pdf =
          await pdfjsLib
            .getDocument({
              data: arrayBuffer,
            })
            .promise;


        // ============================================
        // OBTENER PRIMERA PÁGINA
        // ============================================

        const page =
          await pdf.getPage(1);


        const viewport =
          page.getViewport({
            scale: 0.5,
          });


        // ============================================
        // CREAR CANVAS
        // ============================================

        const canvas =
          document.createElement("canvas");


        const context =
          canvas.getContext("2d");


        canvas.width =
          viewport.width;

        canvas.height =
          viewport.height;


        // ============================================
        // RENDERIZAR
        // ============================================

        await page.render({
          canvasContext: context,
          viewport: viewport,
        }).promise;


        // ============================================
        // GUARDAR MINIATURA
        // ============================================

        if (!cancelled) {

          setThumbnail(
            canvas.toDataURL("image/png")
          );

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