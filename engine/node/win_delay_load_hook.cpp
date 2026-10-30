// The addon imports Node-API from "node.exe", as every Windows addon does. In
// Electron those functions live in the application's own executable, so the
// import is delay-loaded and this hook answers it with the running program,
// the same hook node-gyp adds to the addons it builds.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI loadExeHook(unsigned int event, DelayLoadInfo* info)
{
    if (event != dliNotePreLoadLibrary || _stricmp(info->szDll, "node.exe") != 0)
        return nullptr;
    return reinterpret_cast<FARPROC>(GetModuleHandle(nullptr));
}

extern "C" const PfnDliHook __pfnDliNotifyHook2 = loadExeHook;
