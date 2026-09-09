"""Colas acotadas para trabajos costosos del servicio documental."""

from __future__ import annotations

import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any, Callable


class QueueFullError(RuntimeError):
    """La cola no admite más trabajo sin superar su presupuesto."""


class JobTimeoutError(TimeoutError):
    """El trabajo no terminó dentro del límite configurado."""


class BoundedJobPool:
    """Thread pool con espera limitada, contadores y back-pressure real.

    ``ThreadPoolExecutor`` usa una cola ilimitada. El semáforo limita la suma de
    trabajos activos y pendientes para impedir que un PDF grande agote la RAM.
    """

    def __init__(self, name: str, workers: int, queue_size: int):
        self.name = name
        self.workers = max(1, int(workers))
        self.queue_size = max(0, int(queue_size))
        self.capacity = self.workers + self.queue_size
        self._slots = threading.BoundedSemaphore(self.capacity)
        self._executor = ThreadPoolExecutor(
            max_workers=self.workers,
            thread_name_prefix=f"novapdf-{name}",
        )
        self._lock = threading.Lock()
        self._active = 0
        self._queued = 0
        self._completed = 0
        self._failed = 0
        self._rejected = 0
        self._total_duration_ms = 0.0

    def submit(self, function: Callable[..., Any], *args: Any, **kwargs: Any) -> Future:
        if not self._slots.acquire(blocking=False):
            with self._lock:
                self._rejected += 1
            raise QueueFullError(f"La cola {self.name} está llena.")

        with self._lock:
            self._queued += 1

        def execute() -> Any:
            started_at = time.perf_counter()
            with self._lock:
                self._queued -= 1
                self._active += 1
            try:
                result = function(*args, **kwargs)
            except Exception:
                with self._lock:
                    self._failed += 1
                raise
            else:
                with self._lock:
                    self._completed += 1
                return result
            finally:
                duration_ms = (time.perf_counter() - started_at) * 1000
                with self._lock:
                    self._active -= 1
                    self._total_duration_ms += duration_ms
                self._slots.release()

        try:
            return self._executor.submit(execute)
        except Exception:
            with self._lock:
                self._queued -= 1
            self._slots.release()
            raise

    def run(
        self,
        function: Callable[..., Any],
        *args: Any,
        timeout_seconds: float | None = None,
        **kwargs: Any,
    ) -> Any:
        future = self.submit(function, *args, **kwargs)
        try:
            return future.result(timeout=timeout_seconds)
        except FutureTimeout as error:
            cancelled_before_start = future.cancel()
            if cancelled_before_start:
                with self._lock:
                    self._queued -= 1
                    self._failed += 1
                self._slots.release()
            raise JobTimeoutError(
                f"El trabajo {self.name} excedió el tiempo permitido."
            ) from error

    def stats(self) -> dict[str, Any]:
        with self._lock:
            finished = self._completed + self._failed
            average_ms = self._total_duration_ms / finished if finished else 0.0
            return {
                "name": self.name,
                "workers": self.workers,
                "queue_capacity": self.queue_size,
                "active": self._active,
                "queued": self._queued,
                "available_slots": self.capacity - self._active - self._queued,
                "completed": self._completed,
                "failed": self._failed,
                "rejected": self._rejected,
                "average_duration_ms": round(average_ms, 2),
            }

    def shutdown(self, wait: bool = True) -> None:
        self._executor.shutdown(wait=wait, cancel_futures=not wait)
