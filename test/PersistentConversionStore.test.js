import test from "node:test";
import assert from "node:assert/strict";
import { File } from "node:buffer";

import {
    createConversionSessionId,
    createOrResumeConversionSession,
    estimatePersistentBytes,
    listResumableConversionSessions,
    loadPageCheckpoints,
    resetPersistentStoreForTests,
    savePageCheckpoint,
    updateConversionSession,
} from "../src/engine/pdf-to-word/PersistentConversionStore.js";

test.beforeEach(() => resetPersistentStoreForTests());

test("persiste y recupera páginas terminadas con una identidad estable", async () => {
    const file = new File(["%PDF-test"], "large.pdf", {
        type: "application/pdf",
        lastModified: 1234,
    });
    const options = { mode: "editable", ocrMode: "auto", pageRange: "all" };
    const id = createConversionSessionId(file, options);
    const created = await createOrResumeConversionSession(file, options, [1, 2, 3]);
    assert.equal(created.session.id, id);
    assert.equal(created.resumed, false);

    const page = { pageNumber: 1, content: { words: [{ text: "NovaPDF" }] },
        renderedPage: { data: Uint8Array.from([1, 2, 3]) } };
    await savePageCheckpoint(id, 1, page);
    const resumed = await createOrResumeConversionSession(file, options, [1, 2, 3], {
        sessionId: id,
    });
    const checkpoints = await loadPageCheckpoints(id, [1, 2, 3]);

    assert.equal(resumed.resumed, true);
    assert.deepEqual(resumed.session.completedPages, [1]);
    assert.equal(checkpoints.get(1).content.words[0].text, "NovaPDF");
    assert.equal(checkpoints.has(2), false);
});

test("impide exceder el presupuesto persistente", async () => {
    const file = new File(["%PDF"], "budget.pdf", { lastModified: 5 });
    const options = { mode: "fidelity", ocrMode: "always" };
    const { session } = await createOrResumeConversionSession(file, options, [1], {
        maximumBytes: 100,
    });
    await assert.rejects(
        savePageCheckpoint(session.id, 1, { renderedPage: { data: new Uint8Array(200) } }),
        (error) => error.code === "PERSISTENT_BUDGET_EXCEEDED"
    );
});

test("enumera sesiones listas o interrumpidas pero no completadas", async () => {
    const file = new File(["%PDF"], "resume.pdf", { lastModified: 7 });
    const { session } = await createOrResumeConversionSession(file, {}, [1]);
    assert.equal((await listResumableConversionSessions()).length, 1);
    await updateConversionSession(session.id, { status: "completed" });
    assert.equal((await listResumableConversionSessions()).length, 0);
    assert.ok(estimatePersistentBytes({ data: new Uint8Array(12), text: "ab" }) >= 16);
});

