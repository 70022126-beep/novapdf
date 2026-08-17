import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";

import { PDFDocument } from "pdf-lib";

const [imagePath, outputPath] = process.argv.slice(2);
if (!imagePath || !outputPath) {
    throw new Error(
        "Uso: node scripts/create-scanned-pdf-fixture.mjs <imagen.png|jpg> <salida.pdf>"
    );
}

const document = await PDFDocument.create();
const bytes = await readFile(imagePath);
const extension = extname(imagePath).toLowerCase();
const image = [".jpg", ".jpeg"].includes(extension)
    ? await document.embedJpg(bytes)
    : await document.embedPng(bytes);
const maximumWidth = 612;
const scale = maximumWidth / image.width;
const width = image.width * scale;
const height = image.height * scale;
const page = document.addPage([width, height]);
page.drawImage(image, { x: 0, y: 0, width, height });

await writeFile(outputPath, await document.save());
console.log(outputPath);
