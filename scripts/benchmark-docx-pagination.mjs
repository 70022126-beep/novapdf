import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { renderWordDocument } from "../src/engine/pdf-to-word/WordDocumentRenderer.js";

function page(pageNumber, landscape, withDenseTables) {
    const dimensions = landscape
        ? { width: 792, height: 612 }
        : { width: 612, height: 792 };
    const word = {
        text: `Pagina ${pageNumber}`,
        x: 48,
        y: 54,
        width: 90,
        height: 14,
        fontSize: 11,
    };
    const line = {
        text: word.text,
        words: [word],
        bbox: { x: 48, y: 54, width: 90, height: 14 },
    };
    const paragraph = { ...line, lines: [line] };
    const tables = landscape && withDenseTables
        ? [
            {
                bbox: { x: 20, y: 42, width: 752, height: 520 },
                headers: [],
                rows: Array.from({ length: 39 }, (_, rowIndex) =>
                    Array.from(
                        { length: 6 },
                        (_, columnIndex) => `${rowIndex + 1}.${columnIndex + 1}`
                    )
                ),
            },
        ]
        : [];
    return {
        pageNumber,
        dimensions,
        content: { words: [word], lines: [line] },
        analysis: {
            zones: [],
            paragraphs: [paragraph],
            lines: [line],
            tables,
            columns: { count: 1, columns: [] },
            statistics: { averageWordHeight: 14 },
            spatial: {
                textBox: {
                    x: 48,
                    y: 54,
                    width: dimensions.width - 96,
                    height: dimensions.height - 108,
                },
            },
        },
        images: [],
        review: {},
    };
}

const outputPath = resolve(process.argv[2] || ".novapdf-pagination-test.docx");
const withDenseTables = process.argv.includes("--dense-tables");
const pages = Array.from(
    { length: 62 },
    (_, index) => page(index + 1, index >= 39, withDenseTables)
);
const rendered = await renderWordDocument({
    title: "NovaPDF pagination benchmark",
    mode: "editable",
    pages,
});
await writeFile(outputPath, Buffer.from(await rendered.blob.arrayBuffer()));
console.log(JSON.stringify({
    outputPath,
    pageCount: pages.length,
    withDenseTables,
    bytes: rendered.blob.size,
}));
