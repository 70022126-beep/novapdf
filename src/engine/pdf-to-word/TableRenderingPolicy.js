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
    // Las alturas EXACT y los anchos medidos permiten conservar como cuadrícula
    // Word formularios de 39 x 4 y cronogramas de 10 x 19. Solo una tabla que
    // supera límites prácticos de Word cae a placa visual con texto editable.
    return columnCount > 31 || rowCount >= 64 || rowCount * columnCount >= 900;
}

export function isComplexFlowTable(table = {}) {
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

    // En flujo se aplican los mismos límites: las tablas documentales grandes
    // siguen siendo editables y no se degradan por un simple número de celdas.
    return columnCount > 31 || rowCount >= 64 || rowCount * columnCount >= 900;
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
    if (editableLayout === "flow") {
        return tables.some(isComplexFlowTable);
    }
    if (editableLayout !== "positioned") return false;
    // Embedded bytes alone lose PDF transparency, clipping and stencil masks.
    // The clean plate resolves those operations while native text stays editable.
    if (artworkRequiresCompositing) return true;
    if (tables.some(isComplexPositionedTable)) return true;
    if (
        tables.length > 1 &&
        tables.reduce((total, table) => total + estimatedTableCellCount(table), 0) >= 900
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
