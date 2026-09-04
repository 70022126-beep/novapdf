export function isComplexPositionedTable(table = {}) {
    const columnCount = Number(
        table.professional?.columnCount ||
        table.structure?.columnCount ||
        table.columnAnchors?.length ||
        0
    );
    const rowCount = Number(
        table.professional?.grid?.length ||
        table.rows?.length ||
        table.structure?.raw?.length ||
        0
    );
    // Word cannot reliably preserve dozens of very narrow columns as a native
    // table: its minimum cell/paragraph geometry expands the page. In that
    // case NovaPDF keeps the grid in the clean background and overlays the
    // original text as editable positioned lines.
    // Los formularios de muchas filas también sufren acumulación de márgenes
    // internos y redondeos de altura en Word, aunque tengan pocas columnas.
    // Conservar su cuadrícula como fondo y superponer texto por celda evita que
    // el error crezca de fila en fila.
    return columnCount > 12 || rowCount >= 24 || rowCount * columnCount >= 24;
}

function estimatedTableCellCount(table = {}) {
    const columnCount = Number(
        table.professional?.columnCount ||
        table.structure?.columnCount ||
        table.columnAnchors?.length ||
        0
    );
    const rowCount = Number(
        table.professional?.grid?.length ||
        table.rows?.length ||
        table.structure?.raw?.length ||
        0
    );
    return Math.max(0, rowCount) * Math.max(0, columnCount);
}

export function needsCleanPositionedBackground({
    editableLayout,
    tables = [],
    vectorObjectCount = 0,
    artworkRequiresCompositing = false,
} = {}) {
    if (editableLayout !== "positioned") return false;
    // Embedded bytes alone lose PDF transparency, clipping and stencil masks.
    // The clean plate resolves those operations while native text stays editable.
    if (artworkRequiresCompositing) return true;
    if (tables.some(isComplexPositionedTable)) return true;
    if (
        tables.length > 1 &&
        tables.reduce((total, table) => total + estimatedTableCellCount(table), 0) >= 18
    ) {
        return true;
    }
    // Even one vector object can be essential: a signature rule, an empty
    // form field or a separator. Counting >= 12 objects used to discard the
    // six form rules on FENCYT page 34. Plain text pages still need no plate.
    // Cuando hay una tabla Word normal, sus propios bordes no deben duplicarse
    // mediante una captura de fondo.
    return tables.length === 0 && Number.isFinite(Number(vectorObjectCount)) &&
        Number(vectorObjectCount) > 0;
}
