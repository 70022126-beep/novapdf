const endpoint = process.argv[2] || "http://127.0.0.1:8765/health";
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 3_000);

try {
    const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const status = await response.json();
    console.log(JSON.stringify(status, null, 2));
} catch (error) {
    console.error(
        `Proveedor neuronal no disponible en ${endpoint}: ${error?.message || error}`
    );
    process.exitCode = 1;
} finally {
    clearTimeout(timeout);
}
