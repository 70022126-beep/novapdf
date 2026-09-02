export const OCR_MODES = ["auto", "never", "always"];

export function resolveOCRPolicy({ ocrMode = "auto", mode = "editable", pageType, nativeWordCount = 0, pageNumber, isBlank = false }) {
    if (!OCR_MODES.includes(ocrMode)) {
        throw new Error("Selecciona una opción OCR válida.");
    }
    if (mode === "visual" || isBlank) return { useOCR: false, forceOCR: false };
    if (ocrMode === "never" && nativeWordCount === 0 && pageType !== "digital") {
        throw new Error(`La página ${pageNumber} no tiene texto digital extraíble. Activa OCR o excluye esta página del rango para obtener texto editable.`);
    }
    return {
        useOCR: ocrMode === "always" || (ocrMode === "auto" && pageType !== "digital"),
        forceOCR: ocrMode === "always",
    };
}
