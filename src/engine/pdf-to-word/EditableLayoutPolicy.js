export function chooseEditableLayout({ mode, pageType, nativeContent, nativePage }) {
    if (
        mode !== "editable" ||
        !["digital", "hybrid"].includes(pageType?.type)
    ) {
        return "flow";
    }

    const wordCount = nativeContent?.words?.length || 0;
    const vectorObjectCount = nativePage?.vectorObjects?.length || 0;
    const tableCount = nativePage?.tables?.length || 0;
    const sparseDesignedPage =
        wordCount <= 60 ||
        (wordCount <= 120 && vectorObjectCount >= 40 && tableCount === 0);
    const fixedDocumentPage =
        tableCount > 0 ||
        vectorObjectCount > 0 ||
        wordCount >= 260;

    // El modo "positioned" se reserva para páginas con diseño gráfico disperso:
    // cubiertas, formularios vacíos o páginas con muy pocos elementos de texto.
    // Una cubierta con logotipos suele clasificarse como híbrida aunque todo su
    // texto sea nativo; forzarla a flujo estrecha sus cuadros y divide palabras.
    // Las páginas densas, con tablas o arte vectorial ya tienen una composición
    // deliberada. Refluirlas cambia la paginación; se mantienen editables con
    // cuadros y tablas Word anclados a sus coordenadas PDF.
    return sparseDesignedPage || fixedDocumentPage ? "positioned" : "flow";
}
