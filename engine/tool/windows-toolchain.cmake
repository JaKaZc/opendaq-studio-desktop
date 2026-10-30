# Cross-compiling for Windows x64 on a Mac: clang-cl and lld-link from
# Homebrew's llvm and lld, against the Windows SDK and the MSVC C runtime that
# xwin downloads (XWIN_DIR). The result uses the MSVC ABI, as the openDAQ SDK's
# own Windows DLLs do.

set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_VERSION 10.0)
set(CMAKE_SYSTEM_PROCESSOR AMD64)

set(LLVM_BIN "/opt/homebrew/opt/llvm/bin" CACHE PATH "Homebrew llvm's bin folder")
set(LLD_BIN "/opt/homebrew/opt/lld/bin" CACHE PATH "Homebrew lld's bin folder")
if(NOT XWIN_DIR)
    set(XWIN_DIR "$ENV{XWIN_DIR}")
endif()
if(NOT XWIN_DIR)
    message(FATAL_ERROR "Set XWIN_DIR to the folder xwin splat wrote")
endif()
# The compiler checks read this file again in a project of their own.
set(ENV{XWIN_DIR} "${XWIN_DIR}")
list(APPEND CMAKE_TRY_COMPILE_PLATFORM_VARIABLES XWIN_DIR LLVM_BIN LLD_BIN)

set(CMAKE_C_COMPILER "${LLVM_BIN}/clang-cl")
set(CMAKE_CXX_COMPILER "${LLVM_BIN}/clang-cl")
set(CMAKE_C_COMPILER_TARGET x86_64-pc-windows-msvc)
set(CMAKE_CXX_COMPILER_TARGET x86_64-pc-windows-msvc)
set(CMAKE_LINKER "${LLD_BIN}/lld-link")
set(CMAKE_AR "${LLVM_BIN}/llvm-lib")
set(CMAKE_RC_COMPILER "${LLVM_BIN}/llvm-rc")
set(CMAKE_MT "${LLVM_BIN}/llvm-mt")

set(_includes "")
foreach(dir crt/include sdk/include/ucrt sdk/include/um sdk/include/shared sdk/include/winrt)
    string(APPEND _includes " /imsvc \"${XWIN_DIR}/${dir}\"")
endforeach()
set(CMAKE_C_FLAGS_INIT "${_includes}")
set(CMAKE_CXX_FLAGS_INIT "${_includes} /EHsc")

set(_libraries "")
foreach(dir crt/lib/x86_64 sdk/lib/um/x86_64 sdk/lib/ucrt/x86_64)
    string(APPEND _libraries " /libpath:\"${XWIN_DIR}/${dir}\"")
endforeach()
set(CMAKE_EXE_LINKER_FLAGS_INIT "${_libraries}")
set(CMAKE_SHARED_LINKER_FLAGS_INIT "${_libraries}")
set(CMAKE_MODULE_LINKER_FLAGS_INIT "${_libraries}")

# Find the openDAQ package this build describes, never the host's.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
