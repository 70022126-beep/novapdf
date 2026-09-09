import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

function decodeXml(value) {
    return String(value || "")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&");
}

function fontKeyBytes(value) {
    const pairs = String(value || "").replace(/[{}-]/g, "").match(/../g) || [];
    return pairs.map((pair) => Number.parseInt(pair, 16)).reverse();
}

function deobfuscateFont(bytes, key) {
    const output = new Uint8Array(bytes);
    for (let index = 0; index < Math.min(32, output.length); index += 1) {
        output[index] ^= key[index % 16];
    }
    return output;
}

async function audit(filename) {
    const archive = await JSZip.loadAsync(await readFile(filename));
    const fontTable = await archive.file("word/fontTable.xml")?.async("string") || "";
    const relationshipsXml = await archive.file("word/_rels/fontTable.xml.rels")?.async("string") || "";
    const relationships = new Map(
        [...relationshipsXml.matchAll(/<Relationship\b([^>]+)\/?\s*>/g)].map((match) => {
            const id = match[1].match(/\bId="([^"]+)"/)?.[1];
            const target = match[1].match(/\bTarget="([^"]+)"/)?.[1];
            return [id, target];
        }).filter(([id, target]) => id && target)
    );
    const faces = [];
    for (const familyMatch of fontTable.matchAll(/<w:font\s+w:name="([^"]+)">([\s\S]*?)<\/w:font>/g)) {
        const family = decodeXml(familyMatch[1]);
        for (const faceMatch of familyMatch[2].matchAll(
            /<w:embed(Regular|Bold|Italic|BoldItalic)\b([^>]*)\/?\s*>/g
        )) {
            const relationshipId = faceMatch[2].match(/r:id="([^"]+)"/)?.[1];
            const key = faceMatch[2].match(/w:fontKey="([^"]+)"/)?.[1];
            const target = relationships.get(relationshipId);
            const archivePath = target
                ? path.posix.normalize(path.posix.join("word", target))
                : null;
            const encoded = archivePath
                ? await archive.file(archivePath)?.async("uint8array")
                : null;
            const decoded = encoded && key
                ? deobfuscateFont(encoded, fontKeyBytes(key))
                : null;
            faces.push({
                family,
                style: faceMatch[1][0].toLocaleLowerCase("en") + faceMatch[1].slice(1),
                relationshipId,
                target: archivePath,
                bytes: decoded?.length || 0,
                sha256: decoded
                    ? createHash("sha256").update(decoded).digest("hex")
                    : null,
                tailSha256: decoded
                    ? createHash("sha256").update(decoded.slice(32)).digest("hex")
                    : null,
            });
        }
    }
    return { file: path.resolve(filename), embeddedFaceCount: faces.length, faces };
}

const files = process.argv.slice(2);
if (!files.length) {
    throw new Error("Uso: npm run audit:docx-fonts -- archivo.docx [otro.docx]");
}

const reports = [];
for (const filename of files) reports.push(await audit(filename));
process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
