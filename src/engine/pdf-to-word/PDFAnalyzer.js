// ============================================
// NOVAPDF PDF ANALYZER
// ============================================
//
// Analiza la estructura básica de un PDF
// y determina automáticamente el tipo de cada
// página:
//
// digital  → texto PDF real
// scanned  → probablemente escaneada
// hybrid   → contenido intermedio
//
// ============================================

import {
    detectPageType,
} from "./PageTypeDetector";


let pdfjsLibPromise = null;


// ============================================
// CARGA DIFERIDA DE PDF.JS
// ============================================

async function getPdfjsLib() {

    if (!pdfjsLibPromise) {

        pdfjsLibPromise =
            import("pdfjs-dist")
                .then((pdfjsLib) => {

                    pdfjsLib
                        .GlobalWorkerOptions
                        .workerSrc =
                        new URL(
                            "pdfjs-dist/build/pdf.worker.min.mjs",
                            import.meta.url
                        ).toString();

                    return pdfjsLib;

                });
    }

    return pdfjsLibPromise;
}


// ============================================
// ABRIR Y ANALIZAR PDF
// ============================================

export async function analyzePDF(
    file,
    onProgress
) {

    // ========================================
    // VALIDAR ARCHIVO
    // ========================================

    if (!file) {

        throw new Error(
            "No se proporcionó ningún archivo PDF."
        );
    }


    // ========================================
    // CARGAR PDF.JS
    // ========================================

    const pdfjsLib =
        await getPdfjsLib();


    // ========================================
    // LEER ARCHIVO
    // ========================================

    const arrayBuffer =
        await file.arrayBuffer();


    // ========================================
    // ABRIR DOCUMENTO PDF
    // ========================================

    const pdf =
        await pdfjsLib
            .getDocument({
                data: arrayBuffer,
            })
            .promise;


    const pages = [];


    // ========================================
    // ANALIZAR CADA PÁGINA
    // ========================================

    for (
        let pageNumber = 1;
        pageNumber <= pdf.numPages;
        pageNumber++
    ) {

        // ------------------------------------
        // OBTENER PÁGINA
        // ------------------------------------

        const page =
            await pdf.getPage(
                pageNumber
            );


        // ------------------------------------
        // VIEWPORT
        // ------------------------------------

        const viewport =
            page.getViewport({
                scale: 1,
            });


        // ------------------------------------
        // EXTRAER TEXTO
        // ------------------------------------

        const textContent =
            await page.getTextContent();


        const textItems =
            textContent.items;


        // ====================================
        // DETECTAR TIPO DE PÁGINA
        // ====================================

        const pageType =
            detectPageType({

                textItems,

                width:
                    viewport.width,

                height:
                    viewport.height,

            });


        // ====================================
        // CREAR DATOS DE PÁGINA
        // ====================================

        const pageData = {

            pageNumber,

            width:
                viewport.width,

            height:
                viewport.height,

            textItems,

            pageType,

        };


        // ====================================
        // GUARDAR PÁGINA
        // ====================================

        pages.push(
            pageData
        );


        // ====================================
        // PROGRESO
        // ====================================

        if (onProgress) {

            onProgress({

                current:
                    pageNumber,

                total:
                    pdf.numPages,

                percent:
                    Math.round(
                        (
                            pageNumber /
                            pdf.numPages
                        ) * 100
                    ),

            });
        }
    }


    // ========================================
    // RESULTADO FINAL
    // ========================================

    return {

        numPages:
            pdf.numPages,

        pages,

    };
}