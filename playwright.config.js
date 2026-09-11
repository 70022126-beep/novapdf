import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { defineConfig } from "@playwright/test";

const root = process.cwd();
const browserExecutable = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean).find(existsSync);

export default defineConfig({
    testDir: "./e2e",
    outputDir: "./tmp/playwright-results",
    timeout: 180_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: [["list"], ["html", { outputFolder: "tmp/playwright-report", open: "never" }]],
    use: {
        baseURL: "http://127.0.0.1:4173",
        acceptDownloads: true,
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
        launchOptions: browserExecutable ? { executablePath: browserExecutable } : {},
    },
    webServer: [
        {
            command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173 --strictPort",
            cwd: root,
            url: "http://127.0.0.1:4173/pdf-to-word",
            reuseExistingServer: !process.env.CI,
            timeout: 60_000,
        },
        {
            command: ".venv\\Scripts\\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8876",
            cwd: path.join(root, "services", "vision"),
            url: "http://127.0.0.1:8876/health",
            reuseExistingServer: false,
            timeout: 60_000,
            env: {
                ...process.env,
                NOVAPDF_VISION_PRELOAD: "false",
                NOVAPDF_VISION_DEVICE: "cpu",
                NOVAPDF_SESSION_AUTH: "true",
                NOVAPDF_VISION_RUNTIME: path.join(root, "tmp", "e2e-vision-runtime"),
                NOVAPDF_PDF2DOCX_PYTHON: path.join(
                    root,
                    "services",
                    "vision",
                    ".venv-pdf2docx",
                    "Scripts",
                    "python.exe"
                ),
            },
        },
    ],
});
