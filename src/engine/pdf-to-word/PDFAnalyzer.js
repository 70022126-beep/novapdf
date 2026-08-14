// ============================================
// NOVAPDF PDF ANALYZER
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
// ABRIR PDF
// ============================================

export async function analyzePDF(
    file,
    onProgress
) {

    if (!file) {

        throw new Error(
            "No se proporcionó ningún archivo PDF."
        );
    }


    const pdfjsLib =
        await getPdfjsLib();


    const arrayBuffer =
        await file.arrayBuffer();


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

        const page =
            await pdf.getPage(
                pageNumber
            );


        const viewport =
            page.getViewport({
                scale: 1,
            });


        const textContent =
            await page.getTextContent();


        pages.push({

            pageNumber,

            width:
                viewport.width,

            height:
                viewport.height,

            textItems:
                textContent.items,

        });


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


    return {

        numPages:
            pdf.numPages,

        pages,

    };
}