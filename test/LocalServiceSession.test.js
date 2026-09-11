import test from "node:test";
import assert from "node:assert/strict";

import {
    authorizedLocalFetch,
    clearLocalServiceSessions,
    deriveLocalSessionEndpoint,
    primeLocalServiceSession,
} from "../src/engine/service/LocalServiceSession.js";

test.afterEach(() => clearLocalServiceSessions());

test("solo deriva sesiones para servicios loopback", () => {
    assert.equal(
        deriveLocalSessionEndpoint("http://127.0.0.1:8765/v1/layout"),
        "http://127.0.0.1:8765/v1/session"
    );
    assert.equal(deriveLocalSessionEndpoint("https://example.com/v1/layout"), null);
});

test("negocia una sesión y autentica la petición protegida", async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), options });
        if (String(url).endsWith("/v1/session")) {
            return Response.json({ token: "fresh-token", expires_at: Date.now() / 1000 + 1800 });
        }
        return Response.json({ ok: true });
    };
    try {
        const response = await authorizedLocalFetch("http://127.0.0.1:8765/v1/layout", {
            method: "POST",
        });
        assert.equal(response.ok, true);
        assert.equal(calls.length, 2);
        assert.equal(calls[1].options.headers.get("X-NovaPDF-Session"), "fresh-token");
    } finally {
        globalThis.fetch = previousFetch;
    }
});

test("renueva una sesión expirada después de un HTTP 401", async () => {
    const previousFetch = globalThis.fetch;
    let protectedCalls = 0;
    primeLocalServiceSession("http://localhost:8765", "stale-token", Date.now() + 60_000);
    globalThis.fetch = async (url, options) => {
        if (String(url).endsWith("/v1/session")) {
            return Response.json({ token: "renewed-token", expires_at: Date.now() / 1000 + 1800 });
        }
        protectedCalls += 1;
        if (protectedCalls === 1) return Response.json({}, { status: 401 });
        assert.equal(options.headers.get("X-NovaPDF-Session"), "renewed-token");
        return Response.json({ ok: true });
    };
    try {
        const response = await authorizedLocalFetch("http://localhost:8765/v1/layout");
        assert.equal(response.status, 200);
        assert.equal(protectedCalls, 2);
    } finally {
        globalThis.fetch = previousFetch;
    }
});

