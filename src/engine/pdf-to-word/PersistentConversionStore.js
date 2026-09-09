import { createFileSignature } from "./ConversionCache.js";

const DATABASE_NAME = "novapdf-conversions";
const DATABASE_VERSION = 1;
const SESSION_STORE = "sessions";
const PAGE_STORE = "pages";
const memorySessions = new Map();
const memoryPages = new Map();

function now() {
    return Date.now();
}

function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableOptions(options = {}) {
    return {
        mode: options.mode || "editable",
        ocrMode: options.ocrMode || "auto",
        pageRange: options.pageRange || "all",
        excludeImages: options.excludeImages === true,
        advancedVision: options.advancedVision !== false,
        cleanEditableBackground: options.cleanEditableBackground !== false,
        experimentalHandwriting: options.experimentalHandwriting === true,
        visionProvider: options.visionProvider || "auto",
        visionVersion: options.visionVersion || "default",
        maximumCanvasMegapixels: Number(options.maximumCanvasMegapixels) || 20,
        persistentStorageMB: Number(options.persistentStorageMB) || 1024,
        ocrDictionary: [...(options.ocrDictionary || [])],
    };
}

export function createConversionSessionId(file, options = {}) {
    const identity = `${createFileSignature(file)}|${JSON.stringify(stableOptions(options))}`;
    return `conversion-${hashString(identity)}`;
}

export function estimatePersistentBytes(value, seen = new Set()) {
    if (value === null || value === undefined) return 0;
    if (typeof value === "string") return value.length * 2;
    if (typeof value === "number" || typeof value === "boolean") return 8;
    if (value instanceof Blob) return value.size;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (typeof value !== "object" || seen.has(value)) return 0;
    seen.add(value);
    if (Array.isArray(value)) {
        return value.reduce((total, item) => total + estimatePersistentBytes(item, seen), 32);
    }
    return Object.entries(value).reduce(
        (total, [key, item]) => total + key.length * 2 + estimatePersistentBytes(item, seen),
        64
    );
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB falló."));
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("IndexedDB falló."));
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB canceló la operación."));
    });
}

let databasePromise = null;
function openDatabase() {
    if (!globalThis.indexedDB) return Promise.resolve(null);
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(SESSION_STORE)) {
                database.createObjectStore(SESSION_STORE, { keyPath: "id" });
            }
            if (!database.objectStoreNames.contains(PAGE_STORE)) {
                const pages = database.createObjectStore(PAGE_STORE, { keyPath: "key" });
                pages.createIndex("sessionId", "sessionId", { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("No se pudo abrir IndexedDB."));
    });
    return databasePromise;
}

async function getSession(id) {
    const database = await openDatabase();
    if (!database) return memorySessions.get(id) || null;
    const transaction = database.transaction(SESSION_STORE, "readonly");
    return (await requestResult(transaction.objectStore(SESSION_STORE).get(id))) || null;
}

async function putSession(session) {
    const database = await openDatabase();
    if (!database) {
        memorySessions.set(session.id, session);
        return;
    }
    const transaction = database.transaction(SESSION_STORE, "readwrite");
    transaction.objectStore(SESSION_STORE).put(session);
    await transactionDone(transaction);
}

async function allSessions() {
    const database = await openDatabase();
    if (!database) return [...memorySessions.values()];
    const transaction = database.transaction(SESSION_STORE, "readonly");
    return requestResult(transaction.objectStore(SESSION_STORE).getAll());
}

function pageKey(sessionId, pageNumber) {
    return `${sessionId}:${String(pageNumber).padStart(7, "0")}`;
}

async function getPageRecord(sessionId, pageNumber) {
    const key = pageKey(sessionId, pageNumber);
    const database = await openDatabase();
    if (!database) return memoryPages.get(key) || null;
    const transaction = database.transaction(PAGE_STORE, "readonly");
    return (await requestResult(transaction.objectStore(PAGE_STORE).get(key))) || null;
}

async function putPageRecord(record) {
    const database = await openDatabase();
    if (!database) {
        memoryPages.set(record.key, record);
        return;
    }
    const transaction = database.transaction(PAGE_STORE, "readwrite");
    transaction.objectStore(PAGE_STORE).put(record);
    await transactionDone(transaction);
}

export async function createOrResumeConversionSession(
    file,
    options,
    pageNumbers,
    { sessionId, maximumBytes = 1024 * 1024 * 1024 } = {}
) {
    const expectedId = createConversionSessionId(file, options);
    const id = sessionId || expectedId;
    const existing = await getSession(id);
    if (existing && existing.fileSignature === createFileSignature(file)) {
        const resumed = {
            ...existing,
            status: "processing",
            updatedAt: now(),
            resumeCount: (existing.resumeCount || 0) + 1,
            maximumBytes: Math.max(existing.persistedBytes || 0, maximumBytes),
        };
        await putSession(resumed);
        return { session: resumed, resumed: true };
    }

    const sourceBlob = file instanceof Blob
        ? file
        : new Blob([await file.arrayBuffer()], { type: "application/pdf" });
    const session = {
        id: expectedId,
        fileSignature: createFileSignature(file),
        filename: file.name || "document.pdf",
        sourceBlob,
        options: stableOptions(options),
        pageNumbers: [...pageNumbers],
        completedPages: [],
        persistedBytes: sourceBlob.size,
        maximumBytes,
        status: "processing",
        resumeCount: 0,
        createdAt: now(),
        updatedAt: now(),
    };
    if (session.persistedBytes > maximumBytes) {
        throw new Error("El PDF supera el presupuesto de almacenamiento persistente.");
    }
    await putSession(session);
    try {
        await globalThis.navigator?.storage?.persist?.();
    } catch {
        // El navegador puede denegar persistencia; IndexedDB continúa funcionando.
    }
    return { session, resumed: false };
}

export async function savePageCheckpoint(sessionId, pageNumber, page) {
    const session = await getSession(sessionId);
    if (!session) throw new Error("La sesión persistente ya no existe.");
    const previous = await getPageRecord(sessionId, pageNumber);
    const sizeBytes = estimatePersistentBytes(page);
    const nextBytes = session.persistedBytes - (previous?.sizeBytes || 0) + sizeBytes;
    if (nextBytes > session.maximumBytes) {
        const error = new Error("El checkpoint supera el presupuesto persistente configurado.");
        error.code = "PERSISTENT_BUDGET_EXCEEDED";
        throw error;
    }
    await putPageRecord({
        key: pageKey(sessionId, pageNumber),
        sessionId,
        pageNumber,
        page,
        sizeBytes,
        updatedAt: now(),
    });
    const completedPages = [...new Set([...(session.completedPages || []), pageNumber])]
        .sort((first, second) => first - second);
    const updated = {
        ...session,
        completedPages,
        persistedBytes: nextBytes,
        updatedAt: now(),
    };
    await putSession(updated);
    return { sizeBytes, persistedBytes: nextBytes, completedPages };
}

export async function loadPageCheckpoints(sessionId, pageNumbers) {
    const records = await Promise.all(
        pageNumbers.map((pageNumber) => getPageRecord(sessionId, pageNumber))
    );
    return new Map(records.filter(Boolean).map((record) => [record.pageNumber, record.page]));
}

export async function updateConversionSession(sessionId, changes = {}) {
    const session = await getSession(sessionId);
    if (!session) return null;
    const updated = { ...session, ...changes, updatedAt: now() };
    await putSession(updated);
    return updated;
}

export async function listResumableConversionSessions() {
    const sessions = await allSessions();
    return sessions
        .filter((session) => ["processing", "paused", "failed"].includes(session.status))
        .sort((first, second) => second.updatedAt - first.updatedAt)
        .map(({ sourceBlob, ...session }) => ({ ...session, sourceBytes: sourceBlob?.size || 0 }));
}

export async function loadConversionSource(sessionId) {
    const session = await getSession(sessionId);
    if (!session?.sourceBlob) return null;
    return new File([session.sourceBlob], session.filename || "document.pdf", {
        type: "application/pdf",
        lastModified: Number(session.fileSignature?.split(":").at(-1)) || now(),
    });
}

export async function deleteConversionSession(sessionId) {
    const database = await openDatabase();
    if (!database) {
        memorySessions.delete(sessionId);
        for (const [key, record] of memoryPages) {
            if (record.sessionId === sessionId) memoryPages.delete(key);
        }
        return;
    }
    const transaction = database.transaction([SESSION_STORE, PAGE_STORE], "readwrite");
    transaction.objectStore(SESSION_STORE).delete(sessionId);
    const index = transaction.objectStore(PAGE_STORE).index("sessionId");
    const request = index.openKeyCursor(IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        transaction.objectStore(PAGE_STORE).delete(cursor.primaryKey);
        cursor.continue();
    };
    await transactionDone(transaction);
}

export function resetPersistentStoreForTests() {
    memorySessions.clear();
    memoryPages.clear();
}
