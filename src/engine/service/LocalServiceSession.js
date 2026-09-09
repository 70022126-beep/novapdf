const tokens = new Map();
const pendingSessions = new Map();

function localServiceOrigin(value) {
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol)) return null;
        if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return null;
        return url.origin;
    } catch {
        return null;
    }
}

export function deriveLocalSessionEndpoint(endpoint) {
    const origin = localServiceOrigin(endpoint);
    return origin ? new URL("/v1/session", origin).toString() : null;
}

function cachedSession(origin) {
    const cached = tokens.get(origin);
    if (!cached || cached.expiresAt <= Date.now() + 5_000) {
        tokens.delete(origin);
        return null;
    }
    return cached.token;
}

export async function getLocalServiceSession(endpoint, { signal, force = false } = {}) {
    const origin = localServiceOrigin(endpoint);
    if (!origin) throw new Error("El servicio documental debe ejecutarse en este equipo.");
    if (force) tokens.delete(origin);
    const cached = cachedSession(origin);
    if (cached) return cached;
    if (pendingSessions.has(origin)) return pendingSessions.get(origin);

    const request = (async () => {
        const response = await fetch(new URL("/v1/session", origin), {
            method: "POST",
            headers: { Accept: "application/json" },
            signal,
        });
        if (!response.ok) throw new Error(`No se pudo iniciar la sesión local (${response.status}).`);
        const payload = await response.json();
        if (!payload.token) throw new Error("El servicio local no devolvió un token de sesión.");
        tokens.set(origin, {
            token: payload.token,
            expiresAt: Number(payload.expires_at) * 1000 || Date.now() + 20 * 60_000,
        });
        return payload.token;
    })();
    pendingSessions.set(origin, request);
    try {
        return await request;
    } finally {
        pendingSessions.delete(origin);
    }
}

export async function authorizedLocalFetch(endpoint, options = {}) {
    const origin = localServiceOrigin(endpoint);
    if (!origin) throw new Error("Se rechazó un endpoint documental que no es local.");
    const perform = async (force) => {
        const token = await getLocalServiceSession(endpoint, {
            signal: options.signal,
            force,
        });
        const headers = new Headers(options.headers || {});
        headers.set("X-NovaPDF-Session", token);
        return fetch(endpoint, { ...options, headers });
    };
    let response = await perform(false);
    if (response.status === 401) response = await perform(true);
    return response;
}

export function clearLocalServiceSessions() {
    tokens.clear();
    pendingSessions.clear();
}

export function primeLocalServiceSession(endpoint, token, expiresAt = Date.now() + 60_000) {
    const origin = localServiceOrigin(endpoint);
    if (!origin || !token) throw new Error("No se puede preparar una sesión local inválida.");
    tokens.set(origin, { token, expiresAt });
}
