[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "NovaPDF\Vision"),
    [int]$Port = 8765,
    [ValidateSet("auto", "gpu:0", "cpu")]
    [string]$Device = "auto",
    [switch]$SkipModels,
    [switch]$SkipStartup
)

$ErrorActionPreference = "Stop"
$sourceRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$targetRoot = [IO.Path]::GetFullPath($InstallRoot)
$localAppDataRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
if (-not $targetRoot.StartsWith($localAppDataRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Por seguridad, InstallRoot debe estar dentro de LOCALAPPDATA."
}

function Find-Python312 {
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        & $launcher.Source -3.12 -c "import sys; print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0) { return $launcher.Source }
    }
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($python) {
        $version = & $python.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
        if ($version -eq "3.12") { return $python.Source }
    }
    throw "NovaPDF requiere Python 3.12 de 64 bits."
}

function Invoke-PipInstall {
    param(
        [Parameter(Mandatory = $true)][string]$Python,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )
    & $Python -m pip @Arguments
    if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
}

if (-not $PSCmdlet.ShouldProcess($targetRoot, "Instalar NovaPDF Vision")) { return }
New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
$patterns = @("*.py", "*.txt", "*.ps1")
foreach ($pattern in $patterns) {
    Get-ChildItem -LiteralPath $sourceRoot -Filter $pattern -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $targetRoot $_.Name) -Force
    }
}

$pythonCommand = Find-Python312
$mainVenv = Join-Path $targetRoot ".venv"
$nativeVenv = Join-Path $targetRoot ".venv-pdf2docx"
if (-not (Test-Path -LiteralPath (Join-Path $mainVenv "Scripts\python.exe"))) {
    if ([IO.Path]::GetFileName($pythonCommand) -ieq "py.exe") {
        & $pythonCommand -3.12 -m venv $mainVenv
    } else {
        & $pythonCommand -m venv $mainVenv
    }
}
$mainPython = Join-Path $mainVenv "Scripts\python.exe"
Invoke-PipInstall -Python $mainPython -Arguments @("install", "--upgrade", "pip") `
    -FailureMessage "No se pudo actualizar pip en el runtime principal."
$gpuDetected = [bool](Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue)
$gpuRequirements = Join-Path $targetRoot "requirements-paddle-gpu.txt"
$cpuRequirements = Join-Path $targetRoot "requirements-paddle-cpu.txt"
if ($Device -ne "cpu" -and $gpuDetected) {
    & $mainPython -m pip install -r $gpuRequirements
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "El runtime GPU no se pudo instalar; NovaPDF usará CPU."
        Invoke-PipInstall -Python $mainPython -Arguments @("install", "-r", $cpuRequirements) `
            -FailureMessage "No se pudo instalar PaddlePaddle CPU."
        $Device = "cpu"
    }
} else {
    Invoke-PipInstall -Python $mainPython -Arguments @("install", "-r", $cpuRequirements) `
        -FailureMessage "No se pudo instalar PaddlePaddle CPU."
    if ($Device -ne "cpu") { $Device = "cpu" }
}
Invoke-PipInstall -Python $mainPython `
    -Arguments @("install", "-r", (Join-Path $targetRoot "requirements.txt")) `
    -FailureMessage "No se pudieron instalar las dependencias del servicio."

if (-not (Test-Path -LiteralPath (Join-Path $nativeVenv "Scripts\python.exe"))) {
    if ([IO.Path]::GetFileName($pythonCommand) -ieq "py.exe") {
        & $pythonCommand -3.12 -m venv $nativeVenv
    } else {
        & $pythonCommand -m venv $nativeVenv
    }
}
$nativePython = Join-Path $nativeVenv "Scripts\python.exe"
Invoke-PipInstall -Python $nativePython -Arguments @("install", "--upgrade", "pip") `
    -FailureMessage "No se pudo actualizar pip en el runtime pdf2docx."
Invoke-PipInstall -Python $nativePython `
    -Arguments @("install", "-r", (Join-Path $targetRoot "requirements-native-docx.txt")) `
    -FailureMessage "No se pudo instalar el runtime aislado pdf2docx."

if (-not $SkipModels) {
    & $mainPython (Join-Path $targetRoot "model_manager.py") download --device $Device
    if ($LASTEXITCODE -ne 0) { throw "Falló la descarga o verificación de modelos." }
}

$configuration = @{
    installRoot = $targetRoot
    port = $Port
    device = $Device
    installedAt = (Get-Date).ToUniversalTime().ToString("o")
    mainPython = $mainPython
    nativePython = $nativePython
} | ConvertTo-Json
Set-Content -LiteralPath (Join-Path $targetRoot "install.json") -Value $configuration -Encoding utf8

$supervisor = Join-Path $targetRoot "supervise.ps1"
$supervisorArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisor`" -InstallRoot `"$targetRoot`" -Port $Port -Device $Device"
if ($SkipModels) { $supervisorArguments += " -SkipModelRepair" }
if (-not $SkipStartup) {
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    New-Item -Path $runKey -Force | Out-Null
    Set-ItemProperty -Path $runKey -Name "NovaPDFVision" `
        -Value "powershell.exe $supervisorArguments"
}
Start-Process -FilePath "powershell.exe" -ArgumentList $supervisorArguments -WindowStyle Hidden

Write-Host "NovaPDF Vision instalado en $targetRoot"
Write-Host "Servicio: http://127.0.0.1:$Port/health"
