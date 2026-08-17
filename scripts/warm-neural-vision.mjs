const endpoint = process.argv[2] || "http://127.0.0.1:8765/health?load=true";
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 300_000);

try {
    const response = await fetch(endpoint, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    console.log(JSON.stringify(health, null, 2));
    if (!health.model_loaded) process.exitCode = 1;
} catch (error) {
    console.error(`No se pudo precargar el motor neuronal: ${error.message}`);
    process.exitCode = 1;
} finally {
    clearTimeout(timeout);
}

