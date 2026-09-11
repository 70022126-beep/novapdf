import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const assetsRoot = path.resolve("dist/assets");
const files = await readdir(assetsRoot, { withFileTypes: true });
const javascript = [];
for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const pathname = path.join(assetsRoot, entry.name);
    javascript.push({ name: entry.name, bytes: (await readFile(pathname)).length });
}

const route = javascript.find((file) => file.name.startsWith("PDFToWord-"));
const limits = {
    routeBytes: Number(process.env.NOVAPDF_PDF_WORD_CHUNK_BYTES || 300_000),
    vendorBytes: Number(process.env.NOVAPDF_VENDOR_CHUNK_BYTES || 550_000),
};
const failures = [];
if (!route) failures.push("No se encontró el chunk PDFToWord.");
else if (route.bytes > limits.routeBytes) {
    failures.push(`PDFToWord ocupa ${route.bytes} bytes; límite ${limits.routeBytes}.`);
}
for (const file of javascript.filter((item) => item.name.startsWith("vendor-"))) {
    if (file.bytes > limits.vendorBytes) {
        failures.push(`${file.name} ocupa ${file.bytes} bytes; límite ${limits.vendorBytes}.`);
    }
}
const report = {
    passed: failures.length === 0,
    limits,
    route,
    vendors: javascript.filter((file) => file.name.startsWith("vendor-")),
    failures,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
