param(
    [string]$InstallRoot = $PSScriptRoot,
    [int]$Port = 8765,
    [ValidateSet("auto", "gpu:0", "cpu")]
    [string]$Device = "auto",
    [int]$MaximumRestartsPerHour = 12,
    [switch]$SkipModelRepair
)

$ErrorActionPreference = "Stop"
$serviceRoot = (Resolve-Path -LiteralPath $InstallRoot).Path
$pythonPath = Join-Path $serviceRoot ".venv\Scripts\python.exe"
$nativePython = Join-Path $serviceRoot ".venv-pdf2docx\Scripts\python.exe"
$runtimeRoot = Join-Path $serviceRoot ".runtime"
$logRoot = Join-Path $runtimeRoot "logs"
$pidPath = Join-Path $runtimeRoot "service.pid"
$stopPath = Join-Path $runtimeRoot "stop.request"

if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw "No existe el runtime principal: $pythonPath"
}

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue

$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $serviceRootHash = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($serviceRoot))
    $serviceRootHex = -join ($serviceRootHash | ForEach-Object { $_.ToString("x2") })
} finally {
    $sha256.Dispose()
}
$mutexName = "Local\NovaPDFVision-" + $serviceRootHex.Substring(0, 16)
$mutex = [Threading.Mutex]::new($false, $mutexName)
if (-not $mutex.WaitOne(0)) {
    exit 0
}

function Test-NovaPDFHealth {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 4
        return $health.version -and $health.status
    } catch {
        return $false
    }
}

function Repair-NovaPDFModels {
    $manager = Join-Path $serviceRoot "model_manager.py"
    if (-not (Test-Path -LiteralPath $manager -PathType Leaf)) { return }
    & $pythonPath $manager verify *> $null
    if ($LASTEXITCODE -ne 0) {
        & $pythonPath $manager download --device $Device
        if ($LASTEXITCODE -ne 0) {
            throw "No se pudieron descargar y verificar los modelos oficiales."
        }
    }
}

$restartTimes = [Collections.Generic.Queue[datetime]]::new()
try {
    if (-not $SkipModelRepair) { Repair-NovaPDFModels }
    while (-not (Test-Path -LiteralPath $stopPath)) {
        while ($restartTimes.Count -gt 0 -and
            $restartTimes.Peek() -lt (Get-Date).AddHours(-1)) {
            [void]$restartTimes.Dequeue()
        }
        if ($restartTimes.Count -ge $MaximumRestartsPerHour) {
            Start-Sleep -Seconds 60
            continue
        }

        if (Test-NovaPDFHealth) {
            Start-Sleep -Seconds 5
            continue
        }

        $env:NOVAPDF_VISION_DEVICE = $Device
        $env:NOVAPDF_VISION_LANGUAGE = "es"
        $env:NOVAPDF_VISION_MODEL_CACHE = Join-Path $serviceRoot ".models"
        $env:NOVAPDF_VISION_RUNTIME = $runtimeRoot
        $env:NOVAPDF_PDF2DOCX_PYTHON = $nativePython
        $env:NOVAPDF_SESSION_AUTH = "true"
        $env:NOVAPDF_VISION_PRELOAD = "true"
        $env:PADDLE_PDX_CACHE_HOME = Join-Path $env:NOVAPDF_VISION_MODEL_CACHE "paddlex"
        $env:PADDLE_PDX_MODEL_SOURCE = "bos"
        $env:PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK = "True"

        $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $stdoutPath = Join-Path $logRoot "service-$timestamp.out.log"
        $stderrPath = Join-Path $logRoot "service-$timestamp.err.log"
        $arguments = @(
            "-m", "uvicorn", "app:app",
            "--host", "127.0.0.1",
            "--port", "$Port",
            "--app-dir", $serviceRoot
        )
        $process = Start-Process -FilePath $pythonPath -ArgumentList $arguments `
            -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        Set-Content -LiteralPath $pidPath -Value $process.Id -Encoding ascii
        $restartTimes.Enqueue((Get-Date))

        $failedHealthChecks = 0
        while (-not $process.HasExited -and -not (Test-Path -LiteralPath $stopPath)) {
            Start-Sleep -Seconds 5
            if (Test-NovaPDFHealth) {
                $failedHealthChecks = 0
            } else {
                $failedHealthChecks += 1
                if ($failedHealthChecks -ge 3) {
                    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                    break
                }
            }
            $process.Refresh()
        }
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $stopPath)) { Start-Sleep -Seconds 3 }
    }
} finally {
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
