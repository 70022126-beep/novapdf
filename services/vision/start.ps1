param(
    [ValidateSet("gpu:0", "cpu")]
    [string]$Device = "gpu:0",
    [int]$Port = 8765
)

$ErrorActionPreference = "Stop"
$serviceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonPath = Join-Path $serviceRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw "Falta services/vision/.venv. Ejecuta primero la instalacion documentada."
}

$env:NOVAPDF_VISION_DEVICE = $Device
$env:NOVAPDF_VISION_LANGUAGE = "es"
$env:NOVAPDF_VISION_MODEL_CACHE = Join-Path $serviceRoot ".models"
$env:PADDLE_PDX_CACHE_HOME = Join-Path $env:NOVAPDF_VISION_MODEL_CACHE "paddlex"
$env:PADDLE_PDX_MODEL_SOURCE = "bos"
$env:PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK = "True"
& $pythonPath -m uvicorn app:app --host 127.0.0.1 --port $Port --app-dir $serviceRoot
