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
  # SHA-1 thumbprint of an Authenticode certificate in the local store. Signing
  # is what stops SmartScreen and Defender treating the exe as an unknown
  # binary; without it users must click through "Windows protected your PC".
  [string]$SignThumbprint = '',
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
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
# Declared up front: StrictMode makes a later read of an unset variable fatal,
# and the clang-cl search below reads it whether or not this branch runs.
$vsPath = ''
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

# The actual compiler is clang-cl (see the configure block for why). It ships
# either with the VS "C++ Clang tools for Windows" component or as a standalone
# LLVM install; look in both before giving up.
$clangCmd = Get-Command 'clang-cl' -ErrorAction SilentlyContinue
$clangCl = if ($clangCmd) { $clangCmd.Source } else { '' }
if (-not $clangCl) {
  $candidates = @()
  if ($vsPath) {
    $candidates += Join-Path $vsPath 'VC\Tools\Llvm\x64\bin\clang-cl.exe'
    $candidates += Join-Path $vsPath 'VC\Tools\Llvm\bin\clang-cl.exe'
  }
  $candidates += Join-Path $env:ProgramFiles 'LLVM\bin\clang-cl.exe'
  $clangCl = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $clangCl) {
  throw @'
clang-cl not found, and MSVC cl.exe cannot build this dependency graph:
sodium-native compiles libsodium with HAVE_TI_MODE and HAVE_GCC_MEMORY_FENCES
on every platform, which require __int128 and the GCC atomic builtins.

Install either:
  - the "C++ Clang tools for Windows" component in the Visual Studio Installer
  - or standalone LLVM: winget install LLVM.LLVM
'@
}
# CMake derives the resource compiler from the C compiler, and clang-cl is not
# one: it rejects rc.exe's /fo output flag with "no such file or directory".
# llvm-rc ships beside clang-cl and does understand the MSVC rc flags, so point
# CMake at it explicitly for the icon resource.
# Swap the trailing filename rather than using Split-Path or GetDirectoryName:
# the former resolves through the PowerShell drive provider and errors on a
# drive it cannot see, and the latter's separator handling is host-dependent.
# This is plain string work, so it behaves the same everywhere.
$llvmRc = $clangCl -replace '[^\\/]+$', 'llvm-rc.exe'
if (-not (Test-Path $llvmRc)) {
  $rcCmd = Get-Command 'rc' -ErrorAction SilentlyContinue
  if (-not $rcCmd) {
    throw "neither llvm-rc (next to clang-cl) nor the Windows SDK rc.exe was found — cannot compile the icon resource"
  }
  $llvmRc = $rcCmd.Source
}

# CMake wants forward slashes in compiler paths.
$clangCl = $clangCl -replace '\\', '/'
$llvmRc = $llvmRc -replace '\\', '/'
Write-Host "   compiler: $clangCl"
Write-Host "   rc      : $llvmRc"

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

      # clang-cl, NOT cl.exe. sodium-native compiles libsodium with
      # HAVE_TI_MODE=1 and HAVE_GCC_MEMORY_FENCES=1 set unconditionally for
      # every platform, which need __int128 and the GCC atomic builtins —
      # MSVC has neither, so cl.exe cannot build this dependency graph at all.
      # clang-cl provides both while keeping the MSVC ABI and /-style flags.
      "-DCMAKE_C_COMPILER=$clangCl",
      "-DCMAKE_CXX_COMPILER=$clangCl",
      "-DCMAKE_RC_COMPILER=$llvmRc",

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

  # -- pin bare-headers ------------------------------------------------------
  # cmake-bare installs bare-headers@latest for every bare addon, ignoring the
  # lockfile that pins bare-module@6.0.1 (October 2025). bare-headers 1.29.0
  # dropped js_on_dynamic_import_transitional, which that bare-module still
  # calls, so the addon stopped compiling: "call to undeclared function".
  #
  # 1.27.0 is the version the known-good macOS build resolved, so it is a
  # verified match for this libjs pin rather than a guess — and matching the
  # linked libjs matters beyond this one symbol, since a five-month-newer
  # header set could disagree about struct layouts too.
  #
  # Replacing the contents after configure sticks: install_node_module only
  # reinstalls when the package is absent, so a later reconfigure keeps this.
  $pinnedHeaders = '1.27.0'
  $headerDirs = @(Get-ChildItem -Path $buildDir -Recurse -Directory -Filter 'bare-headers' `
    -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '_bare' })

  if ($headerDirs.Count -eq 0) {
    Write-Warning 'no bare-headers directories found — cmake-bare layout may have changed; skipping the pin'
  } else {
    Write-Host "== pinning bare-headers to $pinnedHeaders in $($headerDirs.Count) addon tree(s)"
    $pinDir = Join-Path ([IO.Path]::GetTempPath()) "listam-bare-headers-$pinnedHeaders"
    if (-not (Test-Path (Join-Path $pinDir 'package'))) {
      Remove-Item -Recurse -Force $pinDir -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Force -Path $pinDir | Out-Null
      Push-Location $pinDir
      try {
        npm pack "bare-headers@$pinnedHeaders" --silent | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "could not fetch bare-headers@$pinnedHeaders" }
        tar -xzf "bare-headers-$pinnedHeaders.tgz"
        if ($LASTEXITCODE -ne 0) { throw 'could not unpack bare-headers' }
      } finally { Pop-Location }
    }

    $pinnedSrc = Join-Path $pinDir 'package'
    foreach ($dir in $headerDirs) {
      Get-ChildItem -Path $dir.FullName -Force | Remove-Item -Recurse -Force
      Copy-Item -Path (Join-Path $pinnedSrc '*') -Destination $dir.FullName -Recurse -Force
    }

    # Prove the swap landed rather than trusting the copy.
    $probe = Join-Path $headerDirs[0].FullName 'include\js.h'
    if (-not (Select-String -Path $probe -Pattern 'js_on_dynamic_import_transitional' -Quiet)) {
      throw "bare-headers pin did not take effect — $probe still lacks the expected declaration"
    }
    Write-Host '   verified: js.h declares js_on_dynamic_import_transitional'
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

# -- code signing --------------------------------------------------------------
# Sign here rather than via cmake-pear's code_sign_windows, which registers
# itself as an ALL target and so would break every build on a machine with no
# certificate. Timestamping matters: without it every signature stops verifying
# the day the certificate expires.
if ($SignThumbprint) {
  $signTool = Get-Command 'signtool' -ErrorAction SilentlyContinue
  if (-not $signTool) {
    $sdk = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName 'x64\signtool.exe') } |
      Sort-Object Name -Descending | Select-Object -First 1
    if (-not $sdk) { throw 'signtool.exe not found — install the Windows SDK signing tools' }
    $signToolPath = Join-Path $sdk.FullName 'x64\signtool.exe'
  } else {
    $signToolPath = $signTool.Source
  }

  Write-Host '== signing Listam.exe'
  & $signToolPath sign /sha1 $SignThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $exe
  if ($LASTEXITCODE -ne 0) { throw 'signtool failed' }

  & $signToolPath verify /pa $exe
  if ($LASTEXITCODE -ne 0) { throw 'signature did not verify' }
} else {
  Write-Warning 'building UNSIGNED — Windows will warn users, and Defender may quarantine it outright. Pass -SignThumbprint to sign.'
}

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
