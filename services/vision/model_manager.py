"""Descarga oficial y verificación criptográfica de modelos PaddleOCR."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from .device_selector import select_device
except ImportError:
    from device_selector import select_device


SERVICE_ROOT = Path(__file__).resolve().parent
MODEL_ROOT = Path(os.getenv("NOVAPDF_VISION_MODEL_CACHE", SERVICE_ROOT / ".models")).resolve()
PADDLE_CACHE = MODEL_ROOT / "paddlex"
OFFICIAL_MODELS = PADDLE_CACHE / "official_models"
DEFAULT_MANIFEST = MODEL_ROOT / "model-manifest.json"
REQUIRED_MODELS = {
    "PP-LCNet_x1_0_doc_ori",
    "UVDoc",
    "PP-DocBlockLayout",
    "PP-DocLayout_plus-L",
    "PP-LCNet_x1_0_textline_ori",
    "PP-OCRv5_server_det",
    "latin_PP-OCRv5_mobile_rec",
    "PP-OCRv4_server_seal_det",
    "PP-OCRv5_server_rec",
    "PP-LCNet_x1_0_table_cls",
    "SLANeXt_wired",
    "SLANet_plus",
    "RT-DETR-L_wired_table_cell_det",
    "RT-DETR-L_wireless_table_cell_det",
    "PP-FormulaNet_plus-L",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inventory() -> dict[str, Any]:
    files = []
    if OFFICIAL_MODELS.is_dir():
        for path in sorted(OFFICIAL_MODELS.rglob("*")):
            if not path.is_file() or path.name.endswith((".tmp", ".lock")):
                continue
            files.append(
                {
                    "path": path.relative_to(MODEL_ROOT).as_posix(),
                    "size_bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                }
            )
    present_models = sorted(
        directory.name for directory in OFFICIAL_MODELS.iterdir()
        if directory.is_dir()
    ) if OFFICIAL_MODELS.is_dir() else []
    missing = sorted(REQUIRED_MODELS - set(present_models))
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "model_root": str(MODEL_ROOT),
        "required_models": sorted(REQUIRED_MODELS),
        "present_models": present_models,
        "missing_models": missing,
        "files": files,
        "total_bytes": sum(file["size_bytes"] for file in files),
    }


def write_manifest(path: Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    result = inventory()
    if result["missing_models"]:
        raise RuntimeError(f"Faltan modelos: {', '.join(result['missing_models'])}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    return result


def verify_manifest(path: Path = DEFAULT_MANIFEST) -> dict[str, Any]:
    if not path.is_file():
        return {"valid": False, "error": "manifest-missing", "manifest": str(path)}
    expected = json.loads(path.read_text(encoding="utf-8"))
    failures = []
    for item in expected.get("files", []):
        candidate = (MODEL_ROOT / item["path"]).resolve()
        if MODEL_ROOT not in candidate.parents or not candidate.is_file():
            failures.append({"path": item["path"], "reason": "missing"})
            continue
        if candidate.stat().st_size != int(item["size_bytes"]):
            failures.append({"path": item["path"], "reason": "size"})
            continue
        if sha256_file(candidate) != item["sha256"]:
            failures.append({"path": item["path"], "reason": "sha256"})
    return {
        "valid": not failures,
        "manifest": str(path),
        "checked_files": len(expected.get("files", [])),
        "failures": failures,
        "total_bytes": expected.get("total_bytes", 0),
    }


def download_models(device: str) -> dict[str, Any]:
    decision = select_device(device)
    os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(PADDLE_CACHE))
    os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "bos")
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    from paddleocr import PPStructureV3

    try:
        PPStructureV3(
            lang="es",
            device=decision.selected,
            use_doc_orientation_classify=True,
            use_doc_unwarping=True,
            use_textline_orientation=True,
            use_seal_recognition=True,
            use_table_recognition=True,
            use_formula_recognition=True,
            use_region_detection=True,
        )
    except Exception:
        if decision.selected == "cpu":
            raise
        PPStructureV3(
            lang="es",
            device="cpu",
            use_doc_orientation_classify=True,
            use_doc_unwarping=True,
            use_textline_orientation=True,
            use_seal_recognition=True,
            use_table_recognition=True,
            use_formula_recognition=True,
            use_region_detection=True,
        )
        decision = select_device("cpu")
    manifest = write_manifest()
    return {"downloaded": True, "device": decision.as_dict(), "manifest": manifest}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["download", "verify", "inventory"])
    parser.add_argument("--device", default="auto")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    arguments = parser.parse_args()
    if arguments.action == "download":
        result = download_models(arguments.device)
    elif arguments.action == "verify":
        result = verify_manifest(arguments.manifest)
    else:
        result = inventory()
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if arguments.action == "verify" and not result["valid"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
