export function chooseEditableLayout({ mode, pageType, nativeContent, nativePage }) {
    if (mode !== "editable" || pageType.type !== "digital") {
        return "flow";
    }

    const wordCount = nativeContent?.words?.length || 0;
    const vectorObjectCount = nativePage?.vectorObjects?.length || 0;
    const tableCount = nativePage?.tables?.length || 0;
    const sparseDesignedPage =
        wordCount <= 60 ||
        (wordCount <= 120 && vectorObjectCount >= 40 && tableCount === 0);

    // Las tablas nativas conservan coordenadas, celdas combinadas y alturas.
    // Refluirlas junto al texto acumula desplazamientos y páginas adicionales.
    // El contenido sigue siendo editable, anclado a la página original.
    return sparseDesignedPage || tableCount > 0 ? "positioned" : "flow";
}
