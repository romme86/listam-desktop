<#
.SYNOPSIS
  Build the Windows installer payload for listam-desktop.

.DESCRIPTION
  Compiles the native Pear appling (installer/appling) into Listam.exe and zips
  it with splash.png. The .exe bootstraps the Pear runtime itself on first run,
  so end users do NOT need to install Pear beforehand — that is the whole point
  of shipping it rather than pointing people at pears.com.

  Unlike build-macos.sh this does NOT stage the app drive: the appling only
  embeds a drive key and fetches the app over the swarm, so staging stays a
  macOS-side step. Pass -Id to build against a channel other than production.

  Must run on Windows with MSVC — the appling links the static CRT and a
  Windows subsystem entry point, neither of which cross-compiles from macOS.
  The MSVC environment is entered automatically when cl.exe is not already on
  PATH, so this works from a plain PowerShell session and from CI unchanged.

.EXAMPLE
  installer\build-windows.ps1
  installer\build-windows.ps1 -Id <z32-key> -Version 0.19.14
#>
[CmdletBinding()]
param(
  # z32 drive key to boot. Defaults to whatever CMakeLists.txt pins (production).
  [string]$Id = '',
  # Defaults to the version in package.json so the two cannot drift.
  [string]$Version = '',
  [string]$Configuration = 'Release',
  # Relocate fetched dependencies to a short path (e.g. C:\listam-deps) when
  # the default build\_deps location overflows MAX_PATH. See the check below.
  [string]$FetchBase = '',
  # Skip cmake configure and reuse the existing build tree.
  [switch]$SkipConfigure,
  # Do not auto-enter the VS environment (already in a Developer PowerShell).
  [switch]$SkipDevShell,
  # Also pack the MSIX. Needs a code-signing cert in the store; an unsigned
  # MSIX cannot be installed, which is why the zip is the default deliverable.
  [switch]$Msix
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$installerDir = Split-Path -Parent $PSCommandPath
$appDir       = Split-Path -Parent $installerDir
$applingDir   = Join-Path $installerDir 'appling'
$buildDir     = Join-Path $applingDir 'build'
$distDir      = Join-Path $installerDir 'dist'

function Test-Tool([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (-not $Version) {
  $Version = (Get-Content (Join-Path $appDir 'package.json') -Raw | ConvertFrom-Json).version
}

# Load the MSVC toolchain in-process rather than requiring the caller to open a
# Developer PowerShell. Keeps CI and local invocations on the same code path.
if (-not (Test-Tool 'cl') -and -not $SkipDevShell) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) {
    throw 'Visual Studio not found. Install the "Desktop development with C++" workload, or run this from a Developer PowerShell with -SkipDevShell.'
  }

  $vsPath = & $vswhere -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath
  if (-not $vsPath) {
    throw 'No Visual Studio install with the MSVC C++ tools was found. Add the "Desktop development with C++" workload.'
  }

  Write-Host "== entering MSVC environment ($vsPath)"
  Import-Module (Join-Path $vsPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll')
  # -SkipAutomaticLocation keeps the current directory; the dev shell otherwise
  # jumps to the VS default and breaks every relative path below.
  Enter-VsDevShell -VsInstallPath $vsPath -SkipAutomaticLocation `
    -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
}

foreach ($tool in 'cmake', 'ninja') {
  if (-not (Test-Tool $tool)) {
    throw "$tool not found on PATH. Install both: winget install Kitware.CMake Ninja-build.Ninja"
  }
}

# bare enables ASM_NASM for win32-x64; without nasm the configure step dies deep
# inside a dependency with a misleading message.
if (-not (Test-Tool 'nasm')) {
  throw 'nasm not found on PATH. Install it (winget install NASM.NASM) and add it to PATH — bare requires it on win32-x64.'
}

if (-not (Test-Tool 'cl')) {
  throw 'cl.exe still not on PATH after entering the VS environment — the MSVC C++ workload is likely missing.'
}

# libappling ships test fixtures that nest a 64-character key directory inside
# a "Pear Runtime.app/Contents/MacOS" path. Under the default build\_deps
# location that overflows Windows' 260-character MAX_PATH and git aborts the
# checkout with "Filename too long" — several minutes into the configure, well
# after the first dependencies have fetched. Fail here instead.
if (-not $FetchBase -and (git config --get core.longpaths) -ne 'true') {
  throw @'
git core.longpaths is disabled, so fetching libappling will fail on MAX_PATH.

Enable it once per machine:
    git config --global core.longpaths true

Or keep git as-is and shorten the dependency path instead:
    installer\build-windows.ps1 -FetchBase C:\listam-deps
'@
}

Write-Host "== listam-desktop $Version — Windows appling (win32-x64)" -ForegroundColor Cyan

Push-Location $applingDir
try {
  # --ignore-scripts matches the macOS path: these packages only carry cmake
  # modules, and their install scripts are not needed to consume them.
  Write-Host '== fetching cmake modules'
  npm install --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

  if (-not $SkipConfigure) {
    Write-Host '== cmake configure'
    $cmakeArgs = @(
      '-B', 'build',
      '-G', 'Ninja',
      "-DCMAKE_BUILD_TYPE=$Configuration",
      "-DLISTAM_VERSION=$Version",

      # bare sets C_STANDARD 11 and includes <stdatomic.h>, but MSVC keeps C11
      # atomics behind /experimental:c11atomics — without it every bare
      # translation unit dies on "C atomic support is not enabled". The two
      # /D defines are MSVC's stock CMAKE_C_FLAGS, restated because assigning
      # this variable replaces the default rather than appending to it.
      '-DCMAKE_C_FLAGS=/DWIN32 /D_WINDOWS /experimental:c11atomics',

      # cmake-pear compiles the appling itself with /MT while dependencies
      # default to /MD, which shows up as a wall of D9025 overrides and then
      # as duplicate-symbol grief at link time. bare's own link options assume
      # the static CRT, so put every target on it.
      '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded$<$<CONFIG:Debug>:Debug>'
    )
    if ($Id) { $cmakeArgs += "-DLISTAM_ID=$Id" }
    # cmake-fetch declares dependencies without an explicit SOURCE_DIR, so the
    # stock FetchContent base-dir variable relocates all of them.
    if ($FetchBase) { $cmakeArgs += "-DFETCHCONTENT_BASE_DIR=$($FetchBase -replace '\\', '/')" }

    # Configure pulls bare's prebuilt V8 for win32-x64 over the Hyperswarm DHT
    # (mirror_drive), so it needs working outbound UDP, not just HTTPS. A hang
    # here rather than an error is the DHT being unreachable.
    cmake @cmakeArgs
    if ($LASTEXITCODE -ne 0) { throw 'cmake configure failed' }
  }

  # Target the executable explicitly. cmake-pear registers its signtool and
  # MakeAppx steps as ALL targets, so a bare `cmake --build build` fails on any
  # machine without a code-signing certificate in its store.
  Write-Host '== cmake build (listam_appling)'
  cmake --build build --target listam_appling
  if ($LASTEXITCODE -ne 0) { throw 'cmake build failed' }

  if ($Msix) {
    Write-Host '== packing MSIX'
    cmake --build build --target listam_appling_package
    if ($LASTEXITCODE -ne 0) { throw 'MSIX packaging failed' }
  }
}
finally {
  Pop-Location
}

$exe = Join-Path $buildDir 'Listam.exe'
if (-not (Test-Path $exe)) { throw "build finished but $exe is missing" }

# libpear loads the boot splash from <exe>\..\splash.png with an assert on
# failure, so an .exe shipped on its own aborts on the very first run — exactly
# the bootstrap path a new user hits. The two files must travel together.
$splash = Join-Path $applingDir 'assets\splash.png'
if (-not (Test-Path $splash)) { throw "missing $splash — required next to the exe at runtime" }

# Verify the embedded key so a stale build tree cannot ship an .exe pointing at
# a different channel than the caller asked for. Mirrors build-macos.sh --native.
if ($Id) {
  $ascii = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($exe))
  if ($ascii -notmatch [regex]::Escape($Id)) {
    throw "built exe does not embed the requested key ($Id) — delete installer\appling\build and reconfigure"
  }
  Write-Host "   verified embedded key: $Id"
}

$stageDir = Join-Path $distDir 'stage-win32-x64'
Remove-Item -Recurse -Force $stageDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

Copy-Item $exe    (Join-Path $stageDir 'Listam.exe')
Copy-Item $splash (Join-Path $stageDir 'splash.png')

$zip = Join-Path $distDir "Listam-$Version-win32-x64.zip"
Remove-Item -Force $zip -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zip

$size = '{0:N1} MB' -f ((Get-Item $zip).Length / 1MB)
Write-Host ''
Write-Host 'done.' -ForegroundColor Green
Write-Host "  package : $zip ($size)"
if ($Msix) { Write-Host "  msix    : $(Join-Path $buildDir 'Listam.msix')" }
Write-Host ''
Write-Host 'Ship the zip, not the bare exe: splash.png must sit beside Listam.exe.'
Write-Host 'Installs fetch the app over the swarm — keep a seeder running on the'
Write-Host 'staging machine: pear seed production <listam-desktop checkout>'
