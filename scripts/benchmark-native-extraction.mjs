import { readFile } from "node:fs/promises";
import path from "node:path";
import { authorizedLocalFetch } from "../src/engine/service/LocalServiceSession.js";

const argumentsList = process.argv.slice(2);
const pagesArgument = argumentsList.find((value) => value.startsWith("--pages="));
const endpointArgument = argumentsList.find((value) => value.startsWith("--endpoint="));
const files = argumentsList.filter((value) => !value.startsWith("--"));
const pages = pagesArgument?.slice("--pages=".length) || "all";
const layoutEndpoint = endpointArgument?.slice("--endpoint=".length) ||
    "http://127.0.0.1:8765/v1/layout";
const endpoint = new URL("/v1/native-document", layoutEndpoint).toString();

if (!files.length) {
    console.error(
        "Uso: npm run benchmark:native -- --pages=3,29,40 C:\\ruta\\documento.pdf"
    );
    process.exitCode = 1;
} else {
    const report = [];
    for (const filename of files) {
        const startedAt = performance.now();
        const bytes = await readFile(filename);
        const form = new FormData();
        form.append("pdf", new Blob([bytes], { type: "application/pdf" }), path.basename(filename));
        form.append("pages", pages);
        form.append("include_tables", "true");
        const response = await authorizedLocalFetch(endpoint, {
            method: "POST",
            headers: { Accept: "application/json" },
            body: form,
        });
        if (!response.ok) {
            throw new Error(`${path.basename(filename)}: HTTP ${response.status}`);
        }
        const payload = await response.json();
        const durationMs = Math.round(performance.now() - startedAt);
        report.push({
            file: path.basename(filename),
            provider: payload.provider,
            version: payload.version,
            durationMs,
            pages: (payload.pages || []).map((page) => ({
                pageNumber: page.page_number,
                ...page.statistics,
                tableShapes: (page.tables || []).map((table) => ({
                    rows: table.rows?.length || 0,
                    columns: Math.max(...(table.rows || []).map((row) => row.length), 0),
                    source: table.source,
                })),
            })),
        });
    }
    console.log(JSON.stringify(report, null, 2));
}
