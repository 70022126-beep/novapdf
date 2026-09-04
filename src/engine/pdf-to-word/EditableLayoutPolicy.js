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

    // El modo "positioned" se reserva para páginas con diseño gráfico disperso:
    // cubiertas, formularios vacíos o páginas con muy pocos elementos de texto.
    // Las tablas son manejadas de forma nativa en createEditablePageChildren
    // mediante createWordTable({ floating: false }), por lo que ya no necesitan
    // el modo posicionado — el flujo de lectura preserva orden y estructura.
    return sparseDesignedPage ? "positioned" : "flow";
}

