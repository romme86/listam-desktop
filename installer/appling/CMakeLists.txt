# Native Pear appling shell for Listam (template: holepunchto/pear-appling).
# Built by installer/build-macos.sh --native; ID/VERSION are overridable from
# the command line so the script can inject the staged link and app version.
cmake_minimum_required(VERSION 4.0)

find_package(cmake-pear REQUIRED PATHS node_modules/cmake-pear)

project(listam_appling C CXX ASM)

set(LISTAM_ID "h1jwexik1m9c75rqng8hico4oxqgmm8xskws684skmjepksq5r3o"
    CACHE STRING "z32 drive key the appling boots (production channel)")
set(LISTAM_VERSION "0.19.13" CACHE STRING "App version (kept in sync with package.json)")

add_pear_appling(
  listam_appling
  ID "${LISTAM_ID}"
  NAME "Listam"
  VERSION ${LISTAM_VERSION}
  AUTHOR "SayNode"
  DESCRIPTION "Local-first shared lists on the Pear runtime"

  MACOS_IDENTIFIER ch.saynode.listam.desktop
  MACOS_CATEGORY public.app-category.productivity
  MACOS_SIGNING_IDENTITY "-"

  LINUX_CATEGORY Utility
)

# cmake-pear only feeds WINDOWS_ICON to the MSIX package, so a plain Listam.exe
# would ship with the blank default executable icon. Compile the icon in as a
# resource too — Explorer, the taskbar and alt-tab all read it from the binary.
# Regenerate icon.ico from icon.png with installer/make-ico.py.
if(WIN32)
  enable_language(RC)

  # rc.exe accepts forward slashes inside a quoted path, so the CMake-style
  # path can go in verbatim.
  file(GENERATE
    OUTPUT "listam_appling.rc"
    CONTENT "1 ICON \"${CMAKE_CURRENT_SOURCE_DIR}/assets/win32/icon.ico\"\n"
  )

  target_sources(
    listam_appling
    PRIVATE
      "${CMAKE_CURRENT_BINARY_DIR}/listam_appling.rc"
  )
endif()
