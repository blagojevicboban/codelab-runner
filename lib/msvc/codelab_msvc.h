/*
 * CodeLab runner: Visual Studio (MSVC) compatibility shim for C and C++ under gcc/g++.
 * Included automatically via -include when compiler profile is "msvc".
 */
#ifndef CODELAB_MSVC_H
#define CODELAB_MSVC_H

#ifndef _CRT_SECURE_NO_WARNINGS
#define _CRT_SECURE_NO_WARNINGS 1
#endif

#include <ctype.h>
#include <errno.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#ifndef __int64
#define __int64 long long
#endif

typedef int errno_t;

static inline int codelab_msvc_stricmp(const char *a, const char *b) {
    return strcasecmp(a, b);
}

static inline int codelab_msvc_strnicmp(const char *a, const char *b, size_t n) {
    return strncasecmp(a, b, n);
}

#ifndef _stricmp
#define _stricmp codelab_msvc_stricmp
#endif
#ifndef _strnicmp
#define _strnicmp codelab_msvc_strnicmp
#endif
#ifndef _strdup
#define _strdup strdup
#endif

static inline int codelab_msvc_system(const char *cmd) {
    if (cmd == NULL) {
        return 0;
    }
    while (isspace((unsigned char)*cmd)) {
        cmd++;
    }
    if (strncasecmp(cmd, "pause", 5) == 0 && (cmd[5] == '\0' || isspace((unsigned char)cmd[5]))) {
        return 0;
    }
    if (strncasecmp(cmd, "cls", 3) == 0 && (cmd[3] == '\0' || isspace((unsigned char)cmd[3]))) {
        return 0;
    }
    return -1;
}

#define system codelab_msvc_system

static inline errno_t fopen_s(FILE **pfile, const char *filename, const char *mode) {
    if (pfile == NULL) {
        return EINVAL;
    }
    *pfile = NULL;
    if (filename == NULL || mode == NULL) {
        return EINVAL;
    }
    *pfile = fopen(filename, mode);
    return *pfile ? 0 : (errno ? errno : EIO);
}

static inline errno_t strcpy_s(char *dst, size_t dstsz, const char *src) {
    if (dst == NULL || dstsz == 0) {
        return EINVAL;
    }
    if (src == NULL) {
        dst[0] = '\0';
        return EINVAL;
    }
    size_t len = strlen(src);
    if (len >= dstsz) {
        dst[0] = '\0';
        return ERANGE;
    }
    memcpy(dst, src, len + 1);
    return 0;
}

static inline errno_t strcat_s(char *dst, size_t dstsz, const char *src) {
    if (dst == NULL || dstsz == 0 || src == NULL) {
        return EINVAL;
    }
    size_t dlen = strlen(dst);
    size_t slen = strlen(src);
    if (dlen + slen >= dstsz) {
        dst[0] = '\0';
        return ERANGE;
    }
    memcpy(dst + dlen, src, slen + 1);
    return 0;
}

static inline errno_t strncpy_s(char *dst, size_t dstsz, const char *src, size_t count) {
    if (dst == NULL || dstsz == 0) {
        return EINVAL;
    }
    if (src == NULL) {
        dst[0] = '\0';
        return EINVAL;
    }
    size_t n = 0;
    while (n < count && src[n] != '\0') {
        n++;
    }
    if (n >= dstsz) {
        dst[0] = '\0';
        return ERANGE;
    }
    memcpy(dst, src, n);
    dst[n] = '\0';
    return 0;
}

static inline char *gets_s(char *buf, size_t sz) {
    if (buf == NULL || sz == 0) {
        return NULL;
    }
    if (fgets(buf, (int)sz, stdin) == NULL) {
        return NULL;
    }
    size_t len = strlen(buf);
    if (len > 0 && buf[len - 1] == '\n') {
        buf[len - 1] = '\0';
    }
    return buf;
}

static inline char *_itoa(int value, char *buf, int radix) {
    if (buf == NULL || radix < 2 || radix > 36) {
        return NULL;
    }
    if (radix == 10) {
        sprintf(buf, "%d", value);
        return buf;
    }
    unsigned int u = (unsigned int)value;
    char tmp[64];
    int n = 0;
    const char *digits = "0123456789abcdefghijklmnopqrstuvwxyz";
    do {
        tmp[n++] = digits[u % (unsigned int)radix];
        u /= (unsigned int)radix;
    } while (u > 0 && n < 63);
    int i = 0;
    while (n > 0) {
        buf[i++] = tmp[--n];
    }
    buf[i] = '\0';
    return buf;
}

/*
 * MSVC scanf_s / fscanf_s / sscanf_s:
 * Handles the extra buffer-size argument required by MSVC after %s, %c and %[...] specifiers,
 * while delegating all standard specifiers to vfscanf / vsscanf one conversion at a time.
 */
static inline int codelab_msvc_vscanf_stream(FILE *fp, const char *src, const char *fmt, va_list ap) {
    int assigned = 0;
    const char *p = fmt;
    size_t spos = 0;
    size_t slen = src ? strlen(src) : 0;

    while (*p != '\0') {
        if (isspace((unsigned char)*p)) {
            while (isspace((unsigned char)*p)) {
                p++;
            }
            if (fp) {
                int c;
                while ((c = fgetc(fp)) != EOF && isspace(c)) {
                }
                if (c != EOF) {
                    ungetc(c, fp);
                }
            } else {
                while (spos < slen && isspace((unsigned char)src[spos])) {
                    spos++;
                }
            }
            continue;
        }
        if (*p != '%') {
            int ch = fp ? fgetc(fp) : (spos < slen ? (unsigned char)src[spos++] : EOF);
            if (ch != (unsigned char)*p) {
                if (fp && ch != EOF) {
                    ungetc(ch, fp);
                }
                break;
            }
            p++;
            continue;
        }
        const char *spec_start = p++;
        if (*p == '%') {
            int ch = fp ? fgetc(fp) : (spos < slen ? (unsigned char)src[spos++] : EOF);
            if (ch != '%') {
                break;
            }
            p++;
            continue;
        }
        int suppress = 0;
        if (*p == '*') {
            suppress = 1;
            p++;
        }
        int width = 0;
        while (isdigit((unsigned char)*p)) {
            width = width * 10 + (*p - '0');
            p++;
        }
        while (*p == 'h' || *p == 'l' || *p == 'L' || *p == 'z' || *p == 'j' || *p == 't') {
            p++;
        }
        char conv = *p;
        if (conv == '\0') {
            break;
        }
        if (conv == '[') {
            p++;
            if (*p == '^') {
                p++;
            }
            if (*p == ']') {
                p++;
            }
            while (*p != '\0' && *p != ']') {
                p++;
            }
            if (*p == ']') {
                p++;
            }
        } else {
            p++;
        }
        char subfmt[128];
        size_t flen = (size_t)(p - spec_start);
        if (flen + 4 >= sizeof(subfmt)) {
            break;
        }
        if (suppress) {
            memcpy(subfmt, spec_start, flen);
            subfmt[flen] = '\0';
            int consumed = 0;
            if (fp) {
                if (fscanf(fp, subfmt) == EOF) {
                    return assigned ? assigned : EOF;
                }
            } else {
                strcat(subfmt, "%n");
                sscanf(src + spos, subfmt, &consumed);
                spos += (size_t)consumed;
            }
            continue;
        }
        void *ptr = va_arg(ap, void *);
        if (conv == 's' || conv == 'c' || conv == '[') {
            unsigned int bsz = va_arg(ap, unsigned int);
            if (bsz == 0 || ptr == NULL) {
                return assigned;
            }
            if (conv == 'c') {
                int count = width > 0 ? width : 1;
                if ((unsigned int)count > bsz) {
                    return assigned;
                }
                char *out = (char *)ptr;
                for (int i = 0; i < count; i++) {
                    int ch = fp ? fgetc(fp) : (spos < slen ? (unsigned char)src[spos++] : EOF);
                    if (ch == EOF) {
                        return assigned ? assigned : EOF;
                    }
                    out[i] = (char)ch;
                }
                assigned++;
                continue;
            }
            int limit = (int)bsz - 1;
            if (width > 0 && width < limit) {
                limit = width;
            }
            if (conv == 's') {
                snprintf(subfmt, sizeof(subfmt), "%%%ds", limit);
            } else {
                const char *br = strchr(spec_start, '[');
                snprintf(subfmt, sizeof(subfmt), "%%%d%.*s", limit, (int)(p - br), br);
            }
            int r;
            if (fp) {
                r = fscanf(fp, subfmt, (char *)ptr);
            } else {
                int consumed = 0;
                strcat(subfmt, "%n");
                r = sscanf(src + spos, subfmt, (char *)ptr, &consumed);
                if (r == 1) {
                    spos += (size_t)consumed;
                }
            }
            if (r == EOF) {
                return assigned ? assigned : EOF;
            }
            if (r != 1) {
                break;
            }
            assigned++;
        } else {
            memcpy(subfmt, spec_start, flen);
            subfmt[flen] = '\0';
            int r;
            if (fp) {
                r = fscanf(fp, subfmt, ptr);
            } else {
                int consumed = 0;
                strcat(subfmt, "%n");
                r = sscanf(src + spos, subfmt, ptr, &consumed);
                if (r == 1) {
                    spos += (size_t)consumed;
                }
            }
            if (r == EOF) {
                return assigned ? assigned : EOF;
            }
            if (r != 1) {
                break;
            }
            assigned++;
        }
    }
    return assigned;
}

static inline int scanf_s(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int r = codelab_msvc_vscanf_stream(stdin, NULL, fmt, ap);
    va_end(ap);
    return r;
}

static inline int fscanf_s(FILE *fp, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int r = codelab_msvc_vscanf_stream(fp, NULL, fmt, ap);
    va_end(ap);
    return r;
}

static inline int sscanf_s(const char *src, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int r = codelab_msvc_vscanf_stream(NULL, src, fmt, ap);
    va_end(ap);
    return r;
}

static inline int printf_s(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int r = vprintf(fmt, ap);
    va_end(ap);
    return r;
}

static inline int fprintf_s(FILE *fp, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int r = vfprintf(fp, fmt, ap);
    va_end(ap);
    return r;
}

static inline int sprintf_s(char *buf, size_t sz, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int r = vsnprintf(buf, sz, fmt, ap);
    va_end(ap);
    return r;
}

#endif
