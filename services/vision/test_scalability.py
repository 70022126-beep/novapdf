import tempfile
import threading
import unittest
from pathlib import Path

from .document_store import DocumentNotFoundError, DocumentStore
from .job_pool import BoundedJobPool, JobTimeoutError, QueueFullError
from .resource_budget import resource_budget


class DocumentStoreTests(unittest.TestCase):
    def test_deduplicates_documents_and_persists_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DocumentStore(Path(directory), maximum_bytes=1024 * 1024)
            content = b"%PDF-1.7\nfixture"
            first = store.register(content, "one.pdf", 12)
            second = store.register(content, "renamed.pdf", 12)

            self.assertEqual(first["document_id"], second["document_id"])
            self.assertFalse(first["reused"])
            self.assertTrue(second["reused"])
            self.assertEqual(store.read(first["document_id"]), content)
            self.assertEqual(store.stats()["documents"], 1)

            reopened = DocumentStore(Path(directory), maximum_bytes=1024 * 1024)
            self.assertEqual(reopened.read(first["document_id"]), content)

    def test_prunes_old_documents_to_the_disk_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DocumentStore(Path(directory), maximum_bytes=22)
            first = store.register(b"%PDF-1.7\n111111", "first.pdf", 1)
            second = store.register(b"%PDF-1.7\n222222", "second.pdf", 1)
            self.assertLessEqual(store.stats()["bytes"], 22)
            with self.assertRaises(DocumentNotFoundError):
                store.read(first["document_id"])
            self.assertTrue(store.read(second["document_id"]).startswith(b"%PDF-"))


class BoundedJobPoolTests(unittest.TestCase):
    def test_applies_backpressure_when_all_workers_are_busy(self):
        pool = BoundedJobPool("test", workers=1, queue_size=0)
        started = threading.Event()
        release = threading.Event()

        def block():
            started.set()
            release.wait(2)
            return 7

        future = pool.submit(block)
        self.assertTrue(started.wait(1))
        with self.assertRaises(QueueFullError):
            pool.submit(lambda: 8)
        self.assertEqual(pool.stats()["rejected"], 1)
        release.set()
        self.assertEqual(future.result(timeout=2), 7)
        self.assertEqual(pool.stats()["completed"], 1)
        pool.shutdown()

    def test_processes_a_thousand_lightweight_jobs_with_fixed_workers(self):
        pool = BoundedJobPool("scale", workers=4, queue_size=1000)
        futures = [pool.submit(lambda value=index: value * 2) for index in range(1000)]
        self.assertEqual(sum(future.result(timeout=5) for future in futures), 999000)
        stats = pool.stats()
        self.assertEqual(stats["workers"], 4)
        self.assertEqual(stats["completed"], 1000)
        self.assertEqual(stats["queued"], 0)
        pool.shutdown()

    def test_a_timed_out_queued_job_releases_its_capacity(self):
        pool = BoundedJobPool("timeout", workers=1, queue_size=1)
        release = threading.Event()
        started = threading.Event()

        def block():
            started.set()
            return release.wait(2)

        first = pool.submit(block)
        self.assertTrue(started.wait(1))
        with self.assertRaises(JobTimeoutError):
            pool.run(lambda: 2, timeout_seconds=0.01)
        self.assertEqual(pool.stats()["queued"], 0)
        second = pool.submit(lambda: 3)
        release.set()
        first.result(timeout=2)
        self.assertEqual(second.result(timeout=2), 3)
        pool.shutdown()


class ResourceBudgetTests(unittest.TestCase):
    def test_exposes_ram_and_vram_admission_budgets(self):
        budget = resource_budget()
        self.assertGreater(budget["ram"]["budget_bytes"], 0)
        self.assertGreater(budget["vram"]["budget_bytes"], 0)
        self.assertIn("detected", budget["vram"])


if __name__ == "__main__":
    unittest.main()
