# Native Pear appling shell for Listam (template: holepunchto/pear-appling).
# Built by installer/build-macos.sh --native; ID/VERSION are overridable from
# the command line so the script can inject the staged link and app version.
cmake_minimum_required(VERSION 4.0)

find_package(cmake-pear REQUIRED PATHS node_modules/cmake-pear)

project(listam_appling C CXX ASM)

set(LISTAM_ID "h1jwexik1m9c75rqng8hico4oxqgmm8xskws684skmjepksq5r3o"
    CACHE STRING "z32 drive key the appling boots (production channel)")
set(LISTAM_VERSION "0.12.0" CACHE STRING "App version (kept in sync with package.json)")

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
