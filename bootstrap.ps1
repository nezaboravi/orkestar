[CmdletBinding()]
param(
    [string]$HomePath = $HOME,
    [string]$Project,
    [switch]$ProjectOnly,
    [ValidateSet("fail", "skip", "backup")]
    [string]$Conflict = "backup",
    [ValidateSet("auto", "cursor", "codex", "claude", "kimi", "opencode")]
    [string]$Harness = "auto",
    [switch]$UseHerdr,
    [switch]$Direct,
    [switch]$NoLaunch,
    [switch]$Launch,
    [switch]$StructuralOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$HerdrEnabled = -not $Direct

$NodeVersion = "v24.20.0"
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TargetHome = [System.IO.Path]::GetFullPath($HomePath)
if ($ProjectOnly -and [string]::IsNullOrWhiteSpace($Project)) {
    throw "-ProjectOnly requires -Project."
}
if (-not [string]::IsNullOrWhiteSpace($Project)) {
    $Project = [System.IO.Path]::GetFullPath($Project)
    if (-not (Test-Path -LiteralPath $Project -PathType Container)) {
        throw "Project directory does not exist: $Project"
    }
}

$RuntimeDir = Join-Path $TargetHome ".local\share\agent-orchestra"
$BinDir = Join-Path $RuntimeDir "bin"
$NpmPrefix = Join-Path $RuntimeDir "npm"
New-Item -ItemType Directory -Force -Path $BinDir, $NpmPrefix | Out-Null
$env:HOME = $TargetHome
$env:USERPROFILE = $TargetHome
$env:Path = "$BinDir;$NpmPrefix;$env:Path"

function Write-Step([string]$Message) {
    Write-Host "`n==> $Message"
}

function Test-UsableNode {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $node -or $null -eq $npm) { return $false }
    $major = [int]((& $node.Source -p 'Number(process.versions.node.split(".")[0])').Trim())
    return $major -ge 20
}

if (-not (Test-UsableNode)) {
    # Herdr and OpenCode publish Windows x86_64 binaries. Windows ARM64 runs
    # these through its documented x86_64 emulation layer.
    $Architecture = "x64"
    $Archive = "node-$NodeVersion-win-$Architecture.zip"
    $NodeDir = Join-Path $RuntimeDir "node-$NodeVersion-win-$Architecture"
    $NodeExe = Join-Path $NodeDir "node.exe"
    if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
        Write-Step "Installing isolated Node.js $NodeVersion"
        $Temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-orchestra-" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $Temporary | Out-Null
        try {
            $Base = "https://nodejs.org/dist/$NodeVersion"
            $Checksums = Join-Path $Temporary "SHASUMS256.txt"
            $ArchivePath = Join-Path $Temporary $Archive
            Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHASUMS256.txt" -OutFile $Checksums
            Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Archive" -OutFile $ArchivePath
            $ChecksumLine = Get-Content -LiteralPath $Checksums | Where-Object { $_ -match "\s+$([regex]::Escape($Archive))$" } | Select-Object -First 1
            if ([string]::IsNullOrWhiteSpace($ChecksumLine)) { throw "Node.js checksum is missing for $Archive" }
            $Expected = ($ChecksumLine -split '\s+')[0].ToLowerInvariant()
            $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant()
            if ($Actual -ne $Expected) { throw "Node.js checksum did not match." }
            $Extracted = Join-Path $Temporary "extracted"
            Expand-Archive -LiteralPath $ArchivePath -DestinationPath $Extracted
            $Source = Get-ChildItem -LiteralPath $Extracted -Directory | Select-Object -First 1
            New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
            Copy-Item -Path (Join-Path $Source.FullName "*") -Destination $NodeDir -Recurse -Force
        } finally {
            Remove-Item -LiteralPath $Temporary -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    $env:Path = "$NodeDir;$env:Path"
}

if ($HerdrEnabled -and $null -eq (Get-Command herdr.exe -ErrorAction SilentlyContinue)) {
    Write-Step "Installing Herdr into the isolated runtime"
    $Temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-orchestra-herdr-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $Temporary | Out-Null
    try {
        $Manifest = Invoke-RestMethod -UseBasicParsing -Uri "https://herdr.dev/latest.json"
        $AssetProperty = $Manifest.assets.PSObject.Properties["windows-x86_64"]
        if ($null -eq $AssetProperty) { throw "Herdr manifest has no Windows x86_64 package." }
        $Asset = $AssetProperty.Value
        $Url = if ($Asset -is [string]) { [string]$Asset } else { [string]$Asset.url }
        $ShaProperty = $Manifest.sha256.PSObject.Properties["windows-x86_64"]
        $Expected = if ($null -ne $ShaProperty) { [string]$ShaProperty.Value } elseif ($Asset -isnot [string]) { [string]$Asset.sha256 } else { "" }
        if ($Expected -notmatch '^[0-9a-fA-F]{64}$') { throw "Herdr manifest has no valid Windows SHA-256 checksum." }
        $ArchivePath = Join-Path $Temporary "herdr-windows-x86_64.zip"
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $ArchivePath
        $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash
        if ($Actual -ine $Expected) { throw "Herdr checksum did not match." }
        $Extracted = Join-Path $Temporary "extracted"
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $Extracted
        $HerdrExe = Get-ChildItem -LiteralPath $Extracted -Recurse -File -Filter "herdr.exe" | Select-Object -First 1
        if ($null -eq $HerdrExe) { throw "Herdr package did not contain herdr.exe." }
        Copy-Item -Path (Join-Path $HerdrExe.Directory.FullName "*") -Destination $BinDir -Recurse -Force
    } finally {
        Remove-Item -LiteralPath $Temporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$AnyHarness = $null -ne (Get-Command agent -ErrorAction SilentlyContinue) -or
    $null -ne (Get-Command codex -ErrorAction SilentlyContinue) -or
    $null -ne (Get-Command claude -ErrorAction SilentlyContinue) -or
    $null -ne (Get-Command kimi -ErrorAction SilentlyContinue) -or
    $null -ne (Get-Command opencode -ErrorAction SilentlyContinue)
if (($Harness -eq "opencode" -or ($Harness -eq "auto" -and -not $AnyHarness)) -and
    $null -eq (Get-Command opencode.exe -ErrorAction SilentlyContinue) -and
    $null -eq (Get-Command opencode.cmd -ErrorAction SilentlyContinue)) {
    Write-Step "Installing OpenCode into the isolated runtime"
    & npm.cmd install --global --prefix $NpmPrefix opencode-ai
    if ($LASTEXITCODE -ne 0) { throw "OpenCode installation failed." }
}

$Node = (Get-Command node.exe).Source
$HerdrExe = if ($HerdrEnabled) { (Get-Command herdr.exe).Source } else { $null }
$HarnessCommands = [ordered]@{
    cursor = "agent"
    codex = "codex"
    claude = "claude"
    kimi = "kimi"
    opencode = "opencode"
}
$SelectedHarness = ""
$SelectedCommand = $null
$Candidates = if ($Harness -eq "auto") { @($HarnessCommands.Keys) } else { @($Harness) }
foreach ($Candidate in $Candidates) {
    $Command = Get-Command $HarnessCommands[$Candidate] -ErrorAction SilentlyContinue
    if ($null -ne $Command) {
        $SelectedHarness = $Candidate
        $SelectedCommand = $Command
        break
    }
}
if ([string]::IsNullOrWhiteSpace($SelectedHarness)) {
    throw "No supported AI CLI is installed. Install Cursor, Codex, Claude Code, Kimi Code, or OpenCode."
}

if ($env:LENKA_CLI_ACTIVE -ne "1" -and (Test-Path -LiteralPath (Join-Path $RepoDir ".git") -PathType Container)) {
    Write-Step "Installing the Lenka command"
    $LocalPrefix = Join-Path $TargetHome ".local"
    $PackageCache = Join-Path $RuntimeDir "packages"
    New-Item -ItemType Directory -Force -Path $PackageCache | Out-Null
    $PackOutput = @(& npm.cmd pack --silent --pack-destination $PackageCache $RepoDir)
    if ($LASTEXITCODE -ne 0) { throw "Creating the Lenka package archive failed." }
    $PackageName = [string]($PackOutput | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Last 1)
    $PackagePath = Join-Path $PackageCache $PackageName.Trim()
    if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) { throw "npm did not create the Lenka package archive." }
    & npm.cmd install --global --prefix $LocalPrefix $PackagePath
    if ($LASTEXITCODE -ne 0) { throw "Lenka command installation failed." }
    $GlobalRoot = (& npm.cmd root --global --prefix $LocalPrefix).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Could not resolve the Lenka installation directory." }
    $InstalledRoot = Join-Path $GlobalRoot "agent-orchestra"
    if (-not (Test-Path -LiteralPath $InstalledRoot -PathType Container)) { throw "Lenka package was not installed." }
    $InstalledItem = Get-Item -LiteralPath $InstalledRoot
    if (($InstalledItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Lenka installation must be a standalone package, not a repository link."
    }
    $LenkaCommand = Join-Path $LocalPrefix "lenka.cmd"
    if (-not (Test-Path -LiteralPath $LenkaCommand -PathType Leaf)) { throw "Lenka command shim was not installed." }
    & $LenkaCommand --help | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Installed Lenka command is not executable." }
    Write-Host "Lenka command: $LenkaCommand"
}

Write-Step "Detected tools"
& $Node --version
if ($HerdrEnabled) { & $HerdrExe --version }
& $SelectedCommand.Source --version

$InstallArgs = @("install", "--home", $TargetHome, "--conflict", $Conflict, "--quiet", "--tool", $SelectedHarness)
$DoctorArgs = @("doctor", "--home", $TargetHome, "--installed")
if (-not [string]::IsNullOrWhiteSpace($Project)) {
    $InstallArgs += @("--project", $Project)
    $DoctorArgs += @("--project", $Project)
}
if ($ProjectOnly) {
    $InstallArgs += "--project-only"
    $DoctorArgs += "--project-only"
}
if ($StructuralOnly) { $InstallArgs += "--structural" }

Write-Step "Installing the agent team"
& $Node (Join-Path $RepoDir "orchestra.mjs") @InstallArgs
if ($LASTEXITCODE -ne 0) { throw "Agent team installation failed." }

if ($StructuralOnly) {
    Write-Step "Verifying files and runtime structurally"
    & $Node (Join-Path $RepoDir "orchestra.mjs") @DoctorArgs --structural
    if ($LASTEXITCODE -ne 0) { throw "Structural verification failed." }
} else {
    Write-Step "Checking source and permission invariants"
    & $Node (Join-Path $RepoDir "orchestra.mjs") doctor --home $TargetHome --structural --tool $SelectedHarness
    if ($LASTEXITCODE -ne 0) { throw "Source and permission verification failed." }
}

Write-Host "`nREADY: agent-orchestra is installed and verified."
if ($NoLaunch -or -not $Launch) { exit 0 }

$LaunchDir = if ([string]::IsNullOrWhiteSpace($Project)) { $RepoDir } else { $Project }
Set-Location -LiteralPath $LaunchDir
$PrimaryModel = ""
if (-not [string]::IsNullOrWhiteSpace($Project)) {
    $RuntimeManifest = Join-Path $Project ".agent-orchestra\runtime\$SelectedHarness.json"
} else {
    $RuntimeManifest = Join-Path $TargetHome ".agent-orchestra\runtime\$SelectedHarness.json"
}
if (-not (Test-Path -LiteralPath $RuntimeManifest -PathType Leaf)) {
    throw "$SelectedHarness runtime manifest is missing: $RuntimeManifest"
}
$RuntimeRouting = Get-Content -LiteralPath $RuntimeManifest -Raw | ConvertFrom-Json
$PrimaryModel = [string]$RuntimeRouting.primary.model
if ([string]::IsNullOrWhiteSpace($PrimaryModel)) {
    throw "No verified $SelectedHarness coordination model was recorded for Lenka."
}
$HarnessBinary = $SelectedCommand.Source
if ($SelectedHarness -eq "opencode") {
    $NativeOpenCode = Join-Path $NpmPrefix "node_modules\opencode-ai\bin\opencode.exe"
    if (Test-Path -LiteralPath $NativeOpenCode -PathType Leaf) {
        $HarnessBinary = $NativeOpenCode
    } elseif (-not $SelectedCommand.Source.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        $GlobalNpmRoot = (& npm.cmd root --global).Trim()
        $GlobalNpmOpenCode = Join-Path $GlobalNpmRoot "opencode-ai\bin\opencode.exe"
        if (Test-Path -LiteralPath $GlobalNpmOpenCode -PathType Leaf) {
            $HarnessBinary = $GlobalNpmOpenCode
        } else {
            throw "Could not resolve the native OpenCode executable required by Herdr."
        }
    }
}
$env:AGENT_ORCHESTRA_HARNESS = $SelectedHarness
$env:AGENT_ORCHESTRA_HARNESS_BINARY = $HarnessBinary
$env:AGENT_ORCHESTRA_PRIMARY_MODEL = $PrimaryModel
$ReasoningProperty = $RuntimeRouting.primary.PSObject.Properties["reasoningEffort"]
$env:AGENT_ORCHESTRA_REASONING_EFFORT = if ($null -ne $ReasoningProperty) { [string]$ReasoningProperty.Value } else { "" }
if ($HerdrEnabled) {
    if (-not $HarnessBinary.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$SelectedHarness is available only through a command shim. Use lenka up $SelectedHarness --direct on Windows."
    }
    $SessionName = & $Node (Join-Path $RepoDir "session-name.mjs") $LaunchDir
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($SessionName)) {
        throw "Could not derive the project Herdr session name."
    }
    Write-Host "Herdr session: $SessionName"
    Write-Step "Opening Lenka inside the project Herdr session"
    $StarterLog = Join-Path $RuntimeDir "herdr-$SessionName.log"
    $StarterArgs = @(
        (Join-Path $RepoDir "herdr-starter.mjs"),
        "--herdr", $HerdrExe,
        "--session", $SessionName,
        "--harness", $SelectedHarness,
        "--binary", $HarnessBinary,
        "--project", $LaunchDir,
        "--model", $PrimaryModel,
        "--reasoning", $env:AGENT_ORCHESTRA_REASONING_EFFORT,
        "--log", $StarterLog
    )
    $env:HERDR_SESSION = $SessionName
    Start-Process -FilePath $Node -ArgumentList $StarterArgs -WindowStyle Hidden
    & $HerdrExe --session $SessionName
} else {
    Write-Step "Opening Lenka directly in $SelectedHarness"
    & $Node (Join-Path $RepoDir "harness-launcher.mjs")
}
