"""Presupuesto observable de RAM y VRAM sin dependencias obligatorias."""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import Any


def _physical_memory_bytes() -> int | None:
    try:
        if os.name == "nt":
            import ctypes

            class MemoryStatus(ctypes.Structure):
                _fields_ = [
                    ("length", ctypes.c_ulong),
                    ("memory_load", ctypes.c_ulong),
                    ("total_physical", ctypes.c_ulonglong),
                    ("available_physical", ctypes.c_ulonglong),
                    ("total_page_file", ctypes.c_ulonglong),
                    ("available_page_file", ctypes.c_ulonglong),
                    ("total_virtual", ctypes.c_ulonglong),
                    ("available_virtual", ctypes.c_ulonglong),
                    ("available_extended_virtual", ctypes.c_ulonglong),
                ]

            status = MemoryStatus()
            status.length = ctypes.sizeof(MemoryStatus)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return int(status.total_physical)
        page_size = os.sysconf("SC_PAGE_SIZE")
        page_count = os.sysconf("SC_PHYS_PAGES")
        return int(page_size * page_count)
    except (AttributeError, OSError, ValueError):
        return None


def _cuda_memory() -> dict[str, Any] | None:
    try:
        import paddle

        if not paddle.device.is_compiled_with_cuda():
            return None
        available, total = paddle.device.cuda.mem_get_info()
        return {
            "available_bytes": int(available),
            "total_bytes": int(total),
            "provider": "paddle",
        }
    except Exception:
        pass

    executable = shutil.which("nvidia-smi")
    if not executable:
        return None
    try:
        creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        result = subprocess.run(
            [
                executable,
                "--query-gpu=memory.total,memory.free",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=3,
            creationflags=creation_flags,
        )
        first_line = result.stdout.strip().splitlines()[0]
        total_mb, available_mb = [int(value.strip()) for value in first_line.split(",")[:2]]
        return {
            "available_bytes": available_mb * 1024 * 1024,
            "total_bytes": total_mb * 1024 * 1024,
            "provider": "nvidia-smi",
        }
    except (IndexError, OSError, ValueError, subprocess.SubprocessError):
        return None


def resource_budget() -> dict[str, Any]:
    physical = _physical_memory_bytes()
    configured_ram_mb = int(os.getenv("NOVAPDF_RAM_BUDGET_MB", "4096"))
    configured_vram_mb = int(os.getenv("NOVAPDF_VRAM_BUDGET_MB", "4096"))
    safe_ram_bytes = configured_ram_mb * 1024 * 1024
    if physical:
        safe_ram_bytes = min(safe_ram_bytes, int(physical * 0.55))
    cuda = _cuda_memory()
    safe_vram_bytes = configured_vram_mb * 1024 * 1024
    if cuda:
        safe_vram_bytes = min(safe_vram_bytes, int(cuda["total_bytes"] * 0.7))
    return {
        "ram": {
            "physical_bytes": physical,
            "budget_bytes": safe_ram_bytes,
            "configured_mb": configured_ram_mb,
        },
        "vram": {
            "detected": cuda,
            "budget_bytes": safe_vram_bytes,
            "configured_mb": configured_vram_mb,
        },
    }
