# claude-elytron — run Claude Code on the Elytron AI stack (Windows).
#
#   claude-elytron [claude args...]   Start Claude Code (signs you in first if needed)
#   claude-elytron --login            Sign in with your browser and save a new API key
#   claude-elytron --set-key <key>    Use an existing API key
#   claude-elytron --set-url <url>    Use a different API server
#   claude-elytron --config           Show the saved configuration
#   claude-elytron --env              Show the environment handed to Claude Code
#   claude-elytron --update           Update this script
#   claude-elytron --reset-config     Delete the saved configuration
#   claude-elytron --version | --help
#
# Config: %USERPROFILE%\.config\claude-elytron\config.json. Optional model overrides there:
#   model (deepseek-v4-flash), small_model (gemma4-26b-a4b), ctx_tokens (1000000)

$ErrorActionPreference = "Stop"
$ScriptVersion = "2.0.0"
$DefaultUrl = "https://api.elytrondefense.com"
$ConfigDir = Join-Path $env:USERPROFILE ".config\claude-elytron"
$ConfigFile = Join-Path $ConfigDir "config.json"
$OldConfigFile = Join-Path $ConfigDir "config.ps1"

function Say($msg) { [Console]::Error.WriteLine("claude-elytron: $msg") }
function Die($msg) { Say $msg; exit 1 }

function Load-Config {
    $c = @{ url = ""; api_key = ""; model = ""; small_model = ""; ctx_tokens = "" }
    if (Test-Path $ConfigFile) {
        $saved = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        foreach ($p in $saved.PSObject.Properties) { $c[$p.Name] = [string]$p.Value }
    } elseif (Test-Path $OldConfigFile) {
        # Older releases kept a PowerShell file; read its values without running it.
        $old = Get-Content $OldConfigFile -Raw
        if ($old -match 'CLAUDE_ELYTRON_URL\s*=\s*"([^"]+)"') { $c.url = $Matches[1] }
    }
    return $c
}

function Save-Config($c) {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    ($c | ConvertTo-Json) | Set-Content -Path $ConfigFile -Encoding UTF8
    # Readable by the current user only.
    icacls $ConfigFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
    if (Test-Path $OldConfigFile) { Remove-Item $OldConfigFile -Force }
}

function Mask($k) { if ($k.Length -gt 10) { "$($k.Substring(0,6))…$($k.Substring($k.Length-4))" } else { "(not set)" } }

$Config = Load-Config
# Earlier releases pointed at the old portal hosts; everything now lives on the API host.
if (-not $Config.url -or $Config.url -match '^https://(ellie|ai)\.elytrondefense\.com') {
    if ($Config.url) { Say "moving from $($Config.url) to $DefaultUrl" }
    $Config.url = $DefaultUrl
    if ((Test-Path $ConfigFile) -or (Test-Path $OldConfigFile)) { Save-Config $Config }
}
$Url = $Config.url.TrimEnd("/")

function Invoke-Login {
    $device = "claude-elytron ($env:COMPUTERNAME)"
    try {
        $start = Invoke-RestMethod -Method Post -Uri "$Url/portal/cli/start" -ContentType "application/json" `
            -Body (@{ device_name = $device } | ConvertTo-Json) -TimeoutSec 15
    } catch { Die "could not reach $Url to sign in" }

    Write-Host ""
    Write-Host "  To sign in, open:  $($start.verify_url)"
    Write-Host "  and confirm code:  $($start.user_code)"
    Write-Host ""
    try { Start-Process $start.verify_url | Out-Null } catch { }

    $deadline = (Get-Date).AddSeconds([int]$start.expires_in)
    $interval = [int]$start.interval
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds $interval
        try {
            $r = Invoke-WebRequest -Method Post -Uri "$Url/portal/cli/poll" -ContentType "application/json" `
                -Body (@{ device_code = $start.device_code } | ConvertTo-Json) -UseBasicParsing -TimeoutSec 15
        } catch {
            $code = [int]$_.Exception.Response.StatusCode
            if ($code -eq 410) { Die "sign-in code expired; run claude-elytron --login again" }
            continue  # transient error: keep waiting
        }
        if ($r.StatusCode -eq 200) {
            $script:Config.api_key = ($r.Content | ConvertFrom-Json).api_key
            if (-not $script:Config.api_key) { Die "sign-in returned no key" }
            Save-Config $script:Config
            Say "signed in; key saved to $ConfigFile"
            return
        }
    }
    Die "timed out waiting for approval"
}

function Get-KeyStatus {
    try {
        $r = Invoke-WebRequest -Uri "$Url/v1/models" -Headers @{ Authorization = "Bearer $($Config.api_key)" } `
            -UseBasicParsing -TimeoutSec 10
        return [int]$r.StatusCode
    } catch {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}

switch ($args[0]) {
    "--login" { Invoke-Login; exit 0 }
    "--set-key" {
        if (-not $args[1]) { Die "usage: claude-elytron --set-key <key>" }
        $Config.api_key = $args[1]; Save-Config $Config; Say "key saved"; exit 0
    }
    "--set-url" {
        if (-not $args[1]) { Die "usage: claude-elytron --set-url <url>" }
        $Config.url = $args[1].TrimEnd("/"); Save-Config $Config; Say "server set to $($Config.url)"; exit 0
    }
    "--config" {
        Write-Host "config file: $ConfigFile"
        Write-Host "server:      $Url"
        Write-Host "api key:     $(Mask $Config.api_key)"
        exit 0
    }
    "--update" {
        $target = $PSCommandPath
        $tmp = [IO.Path]::GetTempFileName()
        try { Invoke-WebRequest -Uri "$Url/install/claude-elytron.ps1" -OutFile $tmp -UseBasicParsing } catch { Die "download failed" }
        $errors = $null
        [void][System.Management.Automation.PSParser]::Tokenize((Get-Content $tmp -Raw), [ref]$errors)
        if ($errors.Count) { Remove-Item $tmp; Die "downloaded script is broken; not installed" }
        Move-Item -Force $tmp $target
        Say "updated"
        exit 0
    }
    "--reset-config" { Remove-Item $ConfigFile, $OldConfigFile -ErrorAction SilentlyContinue; Say "configuration deleted"; exit 0 }
    "--version" { Write-Host "claude-elytron $ScriptVersion"; exit 0 }
    { $_ -in "--help", "-h" } {
        Get-Content $PSCommandPath | Select-Object -Skip 1 -First 14 | ForEach-Object { $_ -replace '^# ?', '' }
        exit 0
    }
}

# --- normal start ---------------------------------------------------------------------
if (-not $Config.api_key) {
    Say "not signed in yet"
    Invoke-Login
}

$status = Get-KeyStatus
if ($status -eq 401 -or $status -eq 403) {
    Say "your API key was rejected ($status); signing in again"
    Invoke-Login
} elseif ($status -ne 200) {
    Say "warning: could not check your key at $Url ($status); starting anyway"
}

try {
    $remote = (Invoke-WebRequest -Uri "$Url/install/version" -UseBasicParsing -TimeoutSec 3).Content.Trim()
    if ($remote -and $remote -ne $ScriptVersion) { Say "update available: $ScriptVersion -> $remote (run: claude-elytron --update)" }
} catch { }

$Model = if ($Config.model) { $Config.model } else { "deepseek-v4-flash" }
$SmallModel = if ($Config.small_model) { $Config.small_model } else { "gemma4-26b-a4b" }
$CtxTokens = if ($Config.ctx_tokens) { $Config.ctx_tokens } else { "1000000" }

Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
$env:ANTHROPIC_BASE_URL = $Url
# Sent as "Authorization: Bearer"; avoids Claude Code's API-key confirmation prompt.
$env:ANTHROPIC_AUTH_TOKEN = $Config.api_key
# The model sessions start on; unlike ANTHROPIC_MODEL, a /model choice still sticks.
$env:ANTHROPIC_DEFAULT_MODEL = $Model
# Fill the /model picker from the gateway's /v1/models.
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1"
# Background calls use the haiku and sonnet aliases; send them to the small model.
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $SmallModel
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $SmallModel
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $Model
$env:ANTHROPIC_DEFAULT_FABLE_MODEL = $Model
$env:CLAUDE_CODE_SUBAGENT_MODEL = $Model
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = $CtxTokens
# The token-budget reminder changes every session and defeats the server's prefix cache.
$env:CLAUDE_CODE_TOTAL_TOKENS_REMINDER = "off"

if ($args[0] -eq "--env") {
    foreach ($v in "ANTHROPIC_BASE_URL", "ANTHROPIC_DEFAULT_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
                   "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
                   "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_TOTAL_TOKENS_REMINDER",
                   "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY") {
        Write-Host "$v=$([Environment]::GetEnvironmentVariable($v))"
    }
    Write-Host "ANTHROPIC_AUTH_TOKEN=$(Mask $Config.api_key)"
    exit 0
}

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Die "'claude' is not on PATH; install Claude Code: irm https://claude.ai/install.ps1 | iex"
}
& claude @args
exit $LASTEXITCODE
