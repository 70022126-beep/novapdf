"""Selección reproducible de GPU/CPU para el servicio instalable."""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import asdict, dataclass
from typing import Callable


@dataclass(frozen=True)
class DeviceDecision:
    requested: str
    selected: str
    gpu_available: bool
    reason: str

    def as_dict(self) -> dict[str, str | bool]:
        return asdict(self)


def nvidia_gpu_available() -> bool:
    executable = shutil.which("nvidia-smi")
    if not executable:
        return False
    try:
        creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        result = subprocess.run(
            [executable, "--query-gpu=index", "--format=csv,noheader,nounits"],
            check=True,
            capture_output=True,
            text=True,
            timeout=3,
            creationflags=creation_flags,
        )
        return bool(result.stdout.strip())
    except (OSError, subprocess.SubprocessError):
        return False


def select_device(
    requested: str | None,
    gpu_probe: Callable[[], bool] = nvidia_gpu_available,
) -> DeviceDecision:
    normalized = str(requested or "auto").strip().lower()
    if normalized == "cpu":
        return DeviceDecision(normalized, "cpu", gpu_probe(), "cpu-requested")
    available = gpu_probe()
    if normalized.startswith("gpu:"):
        return DeviceDecision(
            normalized,
            normalized if available else "cpu",
            available,
            "gpu-requested" if available else "gpu-unavailable-fallback",
        )
    if normalized != "auto":
        normalized = "auto"
    return DeviceDecision(
        normalized,
        "gpu:0" if available else "cpu",
        available,
        "gpu-auto-detected" if available else "cpu-auto-fallback",
    )

