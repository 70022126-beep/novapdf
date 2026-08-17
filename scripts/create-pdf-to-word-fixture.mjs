import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const outputPath = process.argv[2] || join(tmpdir(), "novapdf-ui-fixture.pdf");
const document = await PDFDocument.create();
const page = document.addPage([612, 792]);
const regular = await document.embedFont(StandardFonts.Helvetica);
const bold = await document.embedFont(StandardFonts.HelveticaBold);

page.drawText("NovaPDF · Documento de validación", {
    x: 44,
    y: 754,
    size: 9,
    font: regular,
    color: rgb(0.35, 0.4, 0.48),
});
page.drawText("CAPÍTULO 1 · Motor regional", {
    x: 44,
    y: 700,
    size: 22,
    font: bold,
    color: rgb(0.08, 0.18, 0.42),
});
page.drawText("Esta página combina texto digital, una tabla, una fórmula y campos de formulario.", {
    x: 44,
    y: 668,
    size: 11,
    font: regular,
});
page.drawText("1. Detectar regiones", { x: 58, y: 634, size: 12, font: bold });
page.drawText("2. Reconstruir el orden de lectura", { x: 58, y: 614, size: 12, font: regular });
page.drawText("Precisión = palabras correctas / palabras totales", {
    x: 58,
    y: 580,
    size: 12,
    font: regular,
});

const tableX = 58;
const tableTop = 525;
const rowHeight = 28;
const widths = [220, 120, 120];
const rows = [
    ["Región", "Confianza", "Estrategia"],
    ["Texto digital", "100%", "Nativa"],
    ["Tabla escaneada", "84%", "OCR por celda"],
];
let cursorX = tableX;
widths.forEach((width) => {
    page.drawLine({
        start: { x: cursorX, y: tableTop },
        end: { x: cursorX, y: tableTop - rowHeight * rows.length },
        thickness: 1,
        color: rgb(0.6, 0.7, 0.85),
    });
    cursorX += width;
});
page.drawLine({
    start: { x: cursorX, y: tableTop },
    end: { x: cursorX, y: tableTop - rowHeight * rows.length },
    thickness: 1,
    color: rgb(0.6, 0.7, 0.85),
});
rows.forEach((row, rowIndex) => {
    const y = tableTop - rowIndex * rowHeight;
    page.drawLine({
        start: { x: tableX, y },
        end: { x: cursorX, y },
        thickness: 1,
        color: rgb(0.6, 0.7, 0.85),
    });
    let x = tableX;
    row.forEach((cell, columnIndex) => {
        page.drawText(cell, {
            x: x + 7,
            y: y - 18,
            size: rowIndex === 0 ? 10 : 9,
            font: rowIndex === 0 ? bold : regular,
        });
        x += widths[columnIndex];
    });
});
page.drawLine({
    start: { x: tableX, y: tableTop - rowHeight * rows.length },
    end: { x: cursorX, y: tableTop - rowHeight * rows.length },
    thickness: 1,
    color: rgb(0.6, 0.7, 0.85),
});

page.drawText("Nombre: __________________________", {
    x: 58,
    y: 380,
    size: 11,
    font: regular,
});
page.drawText("Fecha: ____ / ____ / ______", {
    x: 58,
    y: 352,
    size: 11,
    font: regular,
});
page.drawText("Firma: ___________________________", {
    x: 58,
    y: 324,
    size: 11,
    font: regular,
});
page.drawText("Página 1 de 1", {
    x: 272,
    y: 28,
    size: 9,
    font: regular,
    color: rgb(0.35, 0.4, 0.48),
});

await writeFile(outputPath, await document.save());
console.log(outputPath);
