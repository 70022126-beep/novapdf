import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function option(name) {
    return process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const classificationPath = option("classification");
const outputPath = path.resolve(option("output") || "benchmarks/ocr-corpus/private/manifest.json");
const sourcePaths = process.argv.slice(2)
    .filter((value) => !value.startsWith("--"))
    .map((value) => path.resolve(value));

if (!classificationPath || !sourcePaths.length) {
    console.error(
        "Uso: node scripts/create-ocr-corpus-manifest.mjs --classification=tmp/candidates.json PDF1 PDF2 ..."
    );
    process.exitCode = 1;
} else {
    const classification = JSON.parse(await readFile(path.resolve(classificationPath), "utf8"));
    const sourceByName = new Map(sourcePaths.map((source) => [path.basename(source), source]));
    const pages = classification.results.flatMap((document) => {
        const sourcePdf = sourceByName.get(document.file);
        if (!sourcePdf) return [];
        return (document.pages || []).map((page) => ({ ...page, sourcePdf, sourceName: document.file }));
    });
    if (!pages.length) throw new Error("Ningún PDF coincide con el informe de clasificación.");

    const used = new Set();
    const keyFor = (page) => `${page.sourcePdf}#${page.pageNumber}`;
    const take = (candidates, count) => {
        const selected = [];
        for (const page of candidates) {
            const key = keyFor(page);
            if (used.has(key)) continue;
            selected.push(page);
            used.add(key);
            if (selected.length === count) break;
        }
        return selected;
    };
    const scanned = pages.filter((page) => page.type === "scanned");
    const clean = take(scanned, 30);
    const noisy = take(scanned.slice().reverse(), 30);
    const tableFirst = pages.slice().sort((first, second) => (
        Number(second.tables) - Number(first.tables)
        || Number(second.columns) - Number(first.columns)
        || Number(second.nativeCharacters) - Number(first.nativeCharacters)
    ));
    const forms = take(tableFirst, 20);
    const hybridFirst = pages.slice().sort((first, second) => (
        Number(second.type === "hybrid") - Number(first.type === "hybrid")
        || Number(first.textDensity) - Number(second.textDensity)
    ));
    const hybrids = take(hybridFirst, 20);
    const groups = [
        ["clean_scan", clean],
        ["noisy_scan", noisy],
        ["form_table", forms],
        ["hybrid", hybrids],
    ];
    for (const [category, samples] of groups) {
        const expected = category === "clean_scan" || category === "noisy_scan" ? 30 : 20;
        if (samples.length !== expected) {
            throw new Error(`${category}: solo se encontraron ${samples.length}/${expected} páginas únicas.`);
        }
    }

    const samples = groups.flatMap(([category, selected]) => selected.map((page, index) => {
        const id = `${category.replace("_scan", "")}-${String(index + 1).padStart(3, "0")}`;
        const rotation = category === "noisy_scan" && index < 2 ? 90 : 0;
        const tags = ["candidate", page.type];
        if (rotation) tags.push("rotated", "rotation-augmentation");
        if (category === "hybrid" && index < 3) tags.push("photo-candidate");
        return {
            id,
            category,
            categoryReview: "pending",
            sourcePdf: page.sourcePdf,
            page: page.pageNumber,
            rotation,
            tags,
            candidateEvidence: {
                automaticPageType: page.type,
                nativeCharacters: page.nativeCharacters,
                textDensity: page.textDensity,
                detectedTables: page.tables,
                columns: page.columns,
            },
            image: `images/${id}.png`,
            annotation: `annotations/${id}.json`,
        };
    }));

    const manifest = {
        schemaVersion: 1,
        corpusId: "novapdf-ocr-private-v1",
        createdAt: new Date().toISOString(),
        status: "candidate_selection_requires_human_review",
        renderDpi: 220,
        languages: ["spa", "eng"],
        historyDirectory: "../history",
        quotas: { clean_scan: 30, noisy_scan: 30, form_table: 20, hybrid: 20 },
        samples,
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
        output: path.relative(process.cwd(), outputPath),
        samples: samples.length,
        counts: Object.fromEntries(groups.map(([category, selected]) => [category, selected.length])),
        categoryReview: "pending",
        warning: "Las categorías candidatas deben revisarse visualmente antes de anotar.",
    }, null, 2));
}
