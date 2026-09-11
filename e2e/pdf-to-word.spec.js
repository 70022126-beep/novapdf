import { writeFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

async function createDigitalFixture(outputPath) {
    const document = await PDFDocument.create();
    const page = document.addPage([612, 792]);
    const regular = await document.embedFont(StandardFonts.Helvetica);
    const bold = await document.embedFont(StandardFonts.HelveticaBold);
    page.drawText("NovaPDF E2E", { x: 48, y: 730, size: 24, font: bold, color: rgb(0.08, 0.2, 0.5) });
    page.drawText("Texto digital editable con posición verificable.", {
        x: 48,
        y: 690,
        size: 12,
        font: regular,
    });
    page.drawText("Página 1 de 1", { x: 270, y: 30, size: 9, font: regular });
    await writeFile(outputPath, await document.save());
}

async function setCheckbox(page, testId, checked) {
    const input = page.getByTestId(testId);
    if ((await input.isChecked()) !== checked) await input.click();
}

test("protege los endpoints locales con una sesión efímera", async ({ request }) => {
    const endpoint = "http://127.0.0.1:8876";
    const anonymous = await request.post(`${endpoint}/v1/documents`);
    expect(anonymous.status()).toBe(401);

    const session = await request.post(`${endpoint}/v1/session`, {
        headers: { Origin: "http://127.0.0.1:4173" },
    });
    expect(session.ok()).toBeTruthy();
    const credentials = await session.json();
    expect(credentials.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const authenticated = await request.post(`${endpoint}/v1/documents`, {
        headers: { "X-NovaPDF-Session": credentials.token },
    });
    expect(authenticated.status()).toBe(422);

    const foreignOrigin = await request.post(`${endpoint}/v1/session`, {
        headers: { Origin: "https://malicious.example" },
    });
    expect(foreignOrigin.status()).toBe(403);
});

test("exige elegir la estrategia OCR antes de convertir", async ({ page }, testInfo) => {
    const fixture = testInfo.outputPath("ocr-choice.pdf");
    await createDigitalFixture(fixture);
    await page.goto("/pdf-to-word?e2e=1");
    await page.getByTestId("pdf-word-input").setInputFiles(fixture);

    await expect(page.getByTestId("pdf-word-ocr-mode")).toHaveValue("");
    await page.getByTestId("pdf-word-convert").click();
    await expect(page.getByTestId("pdf-word-error")).toContainText("elige si quieres usar OCR");
    await expect(page.getByTestId("pdf-word-ocr-mode").locator("option")).toHaveCount(4);
});

test("convierte un PDF digital a un DOCX descargable", async ({ page }, testInfo) => {
    const fixture = testInfo.outputPath("digital.pdf");
    await createDigitalFixture(fixture);
    await page.goto("/pdf-to-word?e2e=1");
    await page.getByTestId("pdf-word-mode-editable").click();
    await page.getByTestId("pdf-word-input").setInputFiles(fixture);
    await page.getByTestId("pdf-word-ocr-mode").selectOption("never");
    await setCheckbox(page, "pdf-word-review-before-download", false);
    await setCheckbox(page, "pdf-word-validate-quality", false);
    await setCheckbox(page, "pdf-word-advanced-vision", false);
    await page.getByTestId("pdf-word-convert").click();

    await expect(page.getByRole("heading", { name: "Conversión completada" })).toBeVisible({ timeout: 120_000 });
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("pdf-word-download").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.docx$/i);
    const outputPath = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(outputPath);
    expect((await import("node:fs")).statSync(outputPath).size).toBeGreaterThan(2_000);
});

test("recupera una conversión persistida después de recargar", async ({ page }) => {
    await page.goto("/pdf-to-word?e2e=1");
    await page.evaluate(async () => {
        const store = await import("/src/engine/pdf-to-word/PersistentConversionStore.js");
        const source = new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])], "recuperable.pdf", {
            type: "application/pdf",
            lastModified: 1_700_000_000_000,
        });
        const options = {
            mode: "editable",
            ocrMode: "auto",
            pageRange: "all",
            advancedVision: false,
            ocrDictionary: [],
        };
        const { session } = await store.createOrResumeConversionSession(source, options, [1, 2], {
            maximumBytes: 10 * 1024 * 1024,
        });
        await store.savePageCheckpoint(session.id, 1, {
            number: 1,
            width: 612,
            height: 792,
            blocks: [],
        });
        await store.updateConversionSession(session.id, { status: "paused" });
    });
    await page.reload();

    await expect(page.getByText("Conversiones recuperables")).toBeVisible();
    const resume = page.getByRole("button", { name: /recuperable\.pdf/ });
    await expect(resume).toContainText("1/2 páginas");
    await resume.click();
    await expect(page.getByText("recuperable.pdf", { exact: true })).toBeVisible();
    await expect(page.getByTestId("pdf-word-ocr-mode")).toHaveValue("auto");
    await expect(page.getByTestId("pdf-word-convert")).toBeEnabled();
});
