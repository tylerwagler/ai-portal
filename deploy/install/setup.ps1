# Installs claude-elytron on Windows.
#   irm https://api.elytrondefense.com/install/setup.ps1 | iex
# Another server: $env:CLAUDE_ELYTRON_URL = "https://..." before running.

$ErrorActionPreference = "Stop"
$Url = if ($env:CLAUDE_ELYTRON_URL) { $env:CLAUDE_ELYTRON_URL.TrimEnd("/") } else { "https://api.elytrondefense.com" }
$Bin = Join-Path $env:USERPROFILE ".local\bin"

Write-Host "== claude-elytron installer ==" -ForegroundColor Cyan
Write-Host "server:  $Url"
Write-Host "install: $Bin\claude-elytron.ps1"

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host "Claude Code is not installed; installing it first..." -ForegroundColor Yellow
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
}

New-Item -ItemType Directory -Path $Bin -Force | Out-Null
$tmp = [IO.Path]::GetTempFileName()
Invoke-WebRequest -Uri "$Url/install/claude-elytron.ps1" -OutFile $tmp -UseBasicParsing
$errors = $null
[void][System.Management.Automation.PSParser]::Tokenize((Get-Content $tmp -Raw), [ref]$errors)
if ($errors.Count) { Remove-Item $tmp; throw "The downloaded script is broken; nothing was installed." }
Move-Item -Force $tmp (Join-Path $Bin "claude-elytron.ps1")

# A .cmd shim so `claude-elytron` works from cmd and PowerShell regardless of execution policy.
Set-Content -Path (Join-Path $Bin "claude-elytron.cmd") -Encoding ASCII `
    -Value '@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude-elytron.ps1" %*'

if ($Url -ne "https://api.elytrondefense.com") {
    $configDir = Join-Path $env:USERPROFILE ".config\claude-elytron"
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    $configFile = Join-Path $configDir "config.json"
    if (-not (Test-Path $configFile)) { @{ url = $Url } | ConvertTo-Json | Set-Content $configFile -Encoding UTF8 }
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $Bin) {
    [Environment]::SetEnvironmentVariable("Path", "$Bin;$userPath", "User")
    $env:Path = "$Bin;$env:Path"
    Write-Host "Added $Bin to your PATH (new terminals pick it up)."
}

Write-Host ""
Write-Host "Installed claude-elytron. Next:"
Write-Host "  claude-elytron --login   # sign in with your browser"
Write-Host "  claude-elytron           # start Claude Code"
