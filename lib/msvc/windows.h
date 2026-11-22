/*
 * CodeLab runner: minimal <windows.h> shim for MSVC mode.
 */
#ifndef CODELAB_MSVC_WINDOWS_H
#define CODELAB_MSVC_WINDOWS_H

#include <stdint.h>
#include <unistd.h>

typedef uint32_t DWORD;
typedef int BOOL;
typedef unsigned int UINT;
typedef void *HANDLE;

#ifndef TRUE
#define TRUE 1
#endif
#ifndef FALSE
#define FALSE 0
#endif
#ifndef STD_OUTPUT_HANDLE
#define STD_OUTPUT_HANDLE ((DWORD)-11)
#endif
#ifndef CP_UTF8
#define CP_UTF8 65001
#endif

static inline void Sleep(DWORD ms) {
    if (ms > 0 && ms <= 5000) {
        usleep((useconds_t)ms * 1000u);
    }
}

static inline BOOL SetConsoleOutputCP(UINT cp) {
    (void)cp;
    return TRUE;
}

static inline BOOL SetConsoleCP(UINT cp) {
    (void)cp;
    return TRUE;
}

static inline HANDLE GetStdHandle(DWORD n) {
    (void)n;
    return NULL;
}

static inline BOOL SetConsoleTextAttribute(HANDLE h, unsigned short attr) {
    (void)h;
    (void)attr;
    return TRUE;
}

#endif
