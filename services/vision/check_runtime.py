"""Valida el runtime neuronal aislado de NovaPDF sin cargar modelos."""

from __future__ import annotations

import os
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parent
MODEL_CACHE_ROOT = SERVICE_ROOT / ".models"
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(MODEL_CACHE_ROOT / "paddlex"))
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "bos")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

import paddle  # noqa: E402
import paddleocr  # noqa: E402
from paddleocr import PPStructureV3  # noqa: E402


def main() -> None:
    paddle.device.set_device("gpu:0")
    tensor = paddle.to_tensor([1.0, 2.0, 3.0])
    print(f"paddle={paddle.__version__}")
    print(f"paddleocr={paddleocr.__version__}")
    print(f"cuda={paddle.device.is_compiled_with_cuda()}")
    print(f"gpu_count={paddle.device.cuda.device_count()}")
    print(f"tensor_place={tensor.place}")
    print(f"tensor_sum={float(tensor.sum())}")
    print(f"pipeline={PPStructureV3.__name__}")


if __name__ == "__main__":
    main()
