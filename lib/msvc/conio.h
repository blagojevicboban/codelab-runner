/*
 * CodeLab runner: minimal <conio.h> shim for MSVC mode.
 */
#ifndef CODELAB_MSVC_CONIO_H
#define CODELAB_MSVC_CONIO_H

#include <stdio.h>
#include <termios.h>
#include <unistd.h>
#include <sys/select.h>

static inline int _getch(void) {
    if (!isatty(STDIN_FILENO)) {
        int c = getchar();
        return c == EOF ? 0 : c;
    }
    struct termios oldt, newt;
    tcgetattr(STDIN_FILENO, &oldt);
    newt = oldt;
    newt.c_lflag &= (tcflag_t)~(ICANON | ECHO);
    tcsetattr(STDIN_FILENO, TCSANOW, &newt);
    int c = getchar();
    tcsetattr(STDIN_FILENO, TCSANOW, &oldt);
    return c == EOF ? 0 : c;
}

static inline int getch(void) {
    return _getch();
}

static inline int _getche(void) {
    int c = _getch();
    if (c > 0) {
        putchar(c);
        fflush(stdout);
    }
    return c;
}

static inline int getche(void) {
    return _getche();
}

static inline int _kbhit(void) {
    struct timeval tv = {0, 0};
    fd_set fds;
    FD_ZERO(&fds);
    FD_SET(STDIN_FILENO, &fds);
    return select(STDIN_FILENO + 1, &fds, NULL, NULL, &tv) > 0 ? 1 : 0;
}

static inline int kbhit(void) {
    return _kbhit();
}

#endif
