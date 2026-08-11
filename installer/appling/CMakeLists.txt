# Native Pear appling shell for Listam (template: holepunchto/pear-appling).
# Built by installer/build-macos.sh --native; ID/VERSION are overridable from
# the command line so the script can inject the staged link and app version.
cmake_minimum_required(VERSION 4.0)

find_package(cmake-pear REQUIRED PATHS node_modules/cmake-pear)

project(listam_appling C CXX ASM)

set(LISTAM_ID "h1jwexik1m9c75rqng8hico4oxqgmm8xskws684skmjepksq5r3o"
    CACHE STRING "z32 drive key the appling boots (production channel)")
set(LISTAM_VERSION "0.19.13" CACHE STRING "App version (kept in sync with package.json)")

# MSIX package Publisher identity. For a Microsoft Store submission this must be
# the exact `CN=...` string from Partner Center -> Product identity, or the
# Store rejects the upload. The placeholder only lets the package build locally.
# cmake-pear feeds this to the AppxManifest as-is; build-windows.ps1 patches the
# remaining identity fields, which cmake-pear derives from the app name.
set(LISTAM_PUBLISHER "CN=UNCONFIGURED" CACHE STRING "MSIX Publisher identity (Partner Center)")

add_pear_appling(
  listam_appling
  ID "${LISTAM_ID}"
  NAME "Listam"
  VERSION ${LISTAM_VERSION}
  AUTHOR "(É) UN CASINO"
  DESCRIPTION "Local-first shared lists on the Pear runtime"

  MACOS_IDENTIFIER ch.saynode.listam.desktop
  MACOS_CATEGORY public.app-category.productivity
  MACOS_SIGNING_IDENTITY "-"

  WINDOWS_SIGNING_SUBJECT "${LISTAM_PUBLISHER}"

  LINUX_CATEGORY Utility
)

# cmake-pear feeds WINDOWS_ICON to the MSIX package only and adds no
# VERSIONINFO at all, so a plain Listam.exe ships with the blank default icon
# and no publisher, product or version under Properties -> Details. Compile
# both in as resources. Regenerate icon.ico with installer/make-ico.py.
if(WIN32)
  enable_language(RC)

  # VERSIONINFO needs a four-part comma-separated version; pad whatever
  # LISTAM_VERSION carries (0.19.13 -> 0,19,13,0) so the resource is always
  # well-formed rather than silently dropped by the resource compiler.
  string(REPLACE "." ";" listam_version_parts "${LISTAM_VERSION}")
  list(LENGTH listam_version_parts listam_version_count)
  while(listam_version_count LESS 4)
    list(APPEND listam_version_parts 0)
    math(EXPR listam_version_count "${listam_version_count} + 1")
  endwhile()
  list(SUBLIST listam_version_parts 0 4 listam_version_parts)
  list(JOIN listam_version_parts "," LISTAM_VERSION_COMMAS)

  # rc accepts forward slashes inside a quoted path, so the CMake-style path
  # goes in verbatim.
  set(LISTAM_ICON "${CMAKE_CURRENT_SOURCE_DIR}/assets/win32/icon.ico")

  configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/listam_appling.rc.in"
    "${CMAKE_CURRENT_BINARY_DIR}/listam_appling.rc"
    @ONLY
  )

  target_sources(
    listam_appling
    PRIVATE
      "${CMAKE_CURRENT_BINARY_DIR}/listam_appling.rc"
  )
endif()
