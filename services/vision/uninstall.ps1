[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "High")]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "NovaPDF\Vision"),
    [switch]$KeepModels
)

$ErrorActionPreference = "Stop"
$targetRoot = [IO.Path]::GetFullPath($InstallRoot)
$localAppDataRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
if (-not $targetRoot.StartsWith($localAppDataRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Por seguridad, InstallRoot debe estar dentro de LOCALAPPDATA."
}
if (-not $PSCmdlet.ShouldProcess($targetRoot, "Desinstalar NovaPDF Vision")) { return }

Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
    -Name "NovaPDFVision" -ErrorAction SilentlyContinue
$runtimeRoot = Join-Path $targetRoot ".runtime"
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
Set-Content -LiteralPath (Join-Path $runtimeRoot "stop.request") -Value "stop" -Encoding ascii
$pidPath = Join-Path $runtimeRoot "service.pid"
if (Test-Path -LiteralPath $pidPath) {
    $servicePid = [int](Get-Content -LiteralPath $pidPath -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $servicePid" -ErrorAction SilentlyContinue
    if ($process -and $process.ExecutablePath.StartsWith($targetRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $servicePid -Force -ErrorAction SilentlyContinue
    }
}

if ($KeepModels) {
    Get-ChildItem -LiteralPath $targetRoot -Force | Where-Object Name -NotIn @(".models", ".runtime") | Remove-Item -Recurse -Force
} else {
    Remove-Item -LiteralPath $targetRoot -Recurse -Force
}
Write-Host "NovaPDF Vision desinstalado."

