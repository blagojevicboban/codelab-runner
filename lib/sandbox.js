// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Compiling and running one program in a bubblewrap sandbox: no network, no capabilities, a read-only system with the
 * runner's own settings hidden, a small private /tmp, the program's own folder, and CPU, memory and file size limits
 * (prlimit). The compilers and their arguments are the same as on the Jobe server used for grading, so the output is
 * the same. Needs bubblewrap 0.9 or newer (--size).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {execFile, spawn, spawnSync} from 'node:child_process';
import {existsSync, realpathSync, writeFileSync} from 'node:fs';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cacheKey, restore, store} from './cache.js';
import {MESSAGES, clientError, compileFailure, logError} from './errors.js';
import {readChangedFiles, writeInputFiles} from './files.js';
import {csharpDebug, dotnetEnv, runtimeConfig} from './dotnet.js';
import {JAVA_DEBUG_OPTIONS, buildJavaDebugger, javaDebugAvailable} from './javadebug.js';

/** Folder containing the Visual Studio (MSVC) compatibility headers. */
const MSVC_DIR = fileURLToPath(new URL('./msvc', import.meta.url));
const NODE_DEBUGGER_DIR = fileURLToPath(new URL('../node-debugger', import.meta.url));
let nodeDebugSupported = null;
const nodeDebugAvailable = () => {
    if (process.env.CODELAB_NODE_DEBUG === 'off' || !existsSync(join(NODE_DEBUGGER_DIR, 'NodeDebugger.mjs'))) {
        return false;
    }
    if (nodeDebugSupported === null) {
        if (!binInUsr('node')) {
            nodeDebugSupported = false;
        } else {
            const res = spawnSync('/usr/bin/node', ['-e', 'process.exit(typeof WebSocket === "function" ? 0 : 1)'],
                {timeout: 5000});
            nodeDebugSupported = res.status === 0;
        }
    }
    return nodeDebugSupported;
};

/**
 * Languages that can run step by step: C and C++ under gdb, C# under netcoredbg, Java under java-debugger and
 * JavaScript / TypeScript under node-debugger (when the server has them).
 */
export const DEBUG_LANGUAGES = ['c', 'cpp', 'csharp', 'java', 'javascript', 'typescript'];

/**
 * Whether a language runs step by step on this server.
 *
 * @param {string} lang
 * @returns {boolean}
 */
export const debuggerAvailable = (lang) => DEBUG_LANGUAGES.includes(lang)
    && (lang !== 'csharp' || csharpDebug() !== null)
    && (lang !== 'java' || javaDebugAvailable())
    && (lang !== 'javascript' || nodeDebugAvailable())
    && (lang !== 'typescript' || (nodeDebugAvailable() && typescriptAvailable()));

/** Heap of a C# program under the debugger, in MB. */
const CSHARP_DEBUG_HEAP = 256;

/** Extra files written into /box before compiling, by language. */
const COMPILE_EXT = {
    c: /\.(?:c|h)$/i,
    cpp: /\.(?:cpp|cc|cxx|c|h|hpp|hh)$/i,
    java: /\.java$/i,
    csharp: /\.cs$/i,
    go: /\.go$/i,
    rust: /\.rs$/i,
    kotlin: /\.kt$/i,
    scala: /\.scala$/i,
    swift: /\.swift$/i,
    haskell: /\.hs$/i,
};

/** Subset of extra files passed as additional source inputs to the compiler. */
const LINK_EXT = {
    c: /\.c$/i,
    cpp: /\.(?:cpp|cc|cxx|c)$/i,
    java: /\.java$/i,
    csharp: /\.cs$/i,
    go: /\.go$/i,
    kotlin: /\.kt$/i,
    scala: /\.scala$/i,
    swift: /\.swift$/i,
    haskell: /\.hs$/i,
};

/**
 * Linked with a program that runs under gdb: its output goes to a FIFO, where the C library would buffer it, so the
 * standard output is made unbuffered before main.
 */
const UNBUFFERED = 'codelab_unbuffered.c';
const UNBUFFERED_CODE = '#include <stdio.h>\n' +
    '__attribute__((constructor)) static void codelab_unbuffered(void) { setvbuf(stdout, NULL, _IONBF, 0); }\n';

/**
 * Linked with a C/C++ program in debug (Step) mode using -Wl,--wrap=malloc/calloc/realloc/free to detect heap blocks
 * that were never freed before the program exits normally.
 */
const LEAKS = 'codelab_leaks.c';
const LEAKS_CODE = [
    '#include <stdio.h>',
    '#include <stddef.h>',
    '#include <stdint.h>',
    '#ifdef __cplusplus',
    'extern "C" {',
    '#endif',
    'extern void *__real_malloc(size_t);',
    'extern void *__real_calloc(size_t, size_t);',
    'extern void *__real_realloc(void *, size_t);',
    'extern void __real_free(void *);',
    'static struct { void *p; size_t n; } _cl_a[256];',
    'static int _cl_in = 0;',
    'static void _cl_add(void *p, size_t n) {',
    '    if (!p) return;',
    '    for (int i = 0; i < 256; i++) { if (!_cl_a[i].p) { _cl_a[i].p = p; _cl_a[i].n = n; return; } }',
    '}',
    'static void _cl_del(void *p) {',
    '    if (!p) return;',
    '    for (int i = 0; i < 256; i++) { if (_cl_a[i].p == p) { _cl_a[i].p = NULL; _cl_a[i].n = 0; return; } }',
    '}',
    'void *__wrap_malloc(size_t n) {',
    '    void *p = __real_malloc(n);',
    '    if (!_cl_in) { _cl_in = 1; _cl_add(p, n); _cl_in = 0; }',
    '    return p;',
    '}',
    'void *__wrap_calloc(size_t c, size_t s) {',
    '    void *p = __real_calloc(c, s);',
    '    if (!_cl_in) { _cl_in = 1; _cl_add(p, c * s); _cl_in = 0; }',
    '    return p;',
    '}',
    'void *__wrap_realloc(void *old, size_t n) {',
    '    if (!_cl_in) { _cl_in = 1; _cl_del(old); _cl_in = 0; }',
    '    void *p = __real_realloc(old, n);',
    '    if (!_cl_in && n > 0) { _cl_in = 1; _cl_add(p, n); _cl_in = 0; }',
    '    return p;',
    '}',
    'void __wrap_free(void *p) {',
    '    if (!_cl_in) { _cl_in = 1; _cl_del(p); _cl_in = 0; }',
    '    __real_free(p);',
    '}',
    '__attribute__((destructor)) static void _cl_dump_leaks(void) {',
    '    _cl_in = 1;',
    '    FILE *f = fopen("/tmp/.codelab-leaks", "w");',
    '    if (!f) return;',
    '    for (int i = 0; i < 256; i++) {',
    '        if (_cl_a[i].p) fprintf(f, "0x%lx %zu\\n", (unsigned long)(uintptr_t)_cl_a[i].p, _cl_a[i].n);',
    '    }',
    '    fclose(f);',
    '}',
    '#ifdef __cplusplus',
    '}',
    '#endif',
].join('\n') + '\n';
const LEAK_WRAP_FLAGS = ['-Wl,--wrap=malloc', '-Wl,--wrap=calloc', '-Wl,--wrap=realloc', '-Wl,--wrap=free'];

/**
 * The class a Java program is run as, which names its file: the public class, or without one the class with a main
 * method (class Zadatak { ... main ... } compiles in Main.java, but there is no class Main to run), or Main. The same
 * rule as tiny_codelab's jobe::source_file_name, so the program runs on Jobe and here.
 *
 * @param {string} code
 * @returns {string}
 */
export const javaClass = (code) => {
    const pub = /public\s+(?:final\s+|abstract\s+)*class\s+([A-Za-z_]\w*)/.exec(code);
    if (pub) {
        return pub[1];
    }
    const classes = [...code.matchAll(/\bclass\s+([A-Za-z_]\w*)/g)];
    for (let i = 0; i < classes.length; i++) {
        const part = code.slice(classes[i].index, i + 1 < classes.length ? classes[i + 1].index : code.length);
        if (/\bstatic\s+(?:(?:public|final)\s+)*void\s+main\s*\(/.test(part)) {
            return classes[i][1];
        }
    }
    return 'Main';
};

/** Visual Studio's safe functions, mapped as in tiny_codelab (jobe::PARAMETERS). */
const SAFE = ['-Dscanf_s=scanf', '-Dfscanf_s=fscanf', '-Dsscanf_s=sscanf', '-Dprintf_s=printf', '-Dfprintf_s=fprintf'];

/**
 * The languages: source file, compile command and run command (inside the program's folder /box). C and C++ run under
 * stdbuf so that a prompt without a new line reaches the student before the program waits for input. The JVM and Mono
 * reserve much more virtual memory than they use, so they get a large address space limit and a heap limit instead.
 */
export const LANGUAGES = {
    c: {
        file: () => 'prog.c',
        compile: (file, opts = null) => {
            const compiler = opts?.compiler || 'gcc';
            const std = opts?.std || 'c11';
            const san = opts?.sanitize ? ['-g', '-O0', '-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : [];
            if (compiler === 'msvc') {
                return ['gcc', `-std=${std}`, '-D_GNU_SOURCE', '-w', ...san, '-I', '/box/msvc',
                    '-include', '/box/msvc/codelab_msvc.h', '-o', 'prog', file, '-lm'];
            }
            const bin = compiler === 'clang' ? 'clang' : 'gcc';
            return [bin, `-std=${std}`, '-D_GNU_SOURCE', '-w', ...san, ...SAFE, '-o', 'prog', file, '-lm'];
        },
        run: () => ['stdbuf', '-o0', '-e0', '/box/prog'],
        memory: 256,
        jobeMemory: 400,
        // Like Jobe: any message of the compiler (also a warning of the linker, which -w does not turn off) is an error.
        strictCompile: true,
    },
    cpp: {
        file: () => 'prog.cpp',
        compile: (file, opts = null) => {
            const compiler = opts?.compiler || 'gcc';
            const std = opts?.std || 'c++17';
            const san = opts?.sanitize ? ['-g', '-O0', '-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : [];
            if (compiler === 'msvc') {
                return ['g++', `-std=${std}`, '-w', ...san, '-I', '/box/msvc',
                    '-include', '/box/msvc/codelab_msvc.h', '-o', 'prog', file, '-lm'];
            }
            const bin = compiler === 'clang' ? 'clang++' : 'g++';
            return [bin, `-std=${std}`, '-w', ...san, ...SAFE, '-o', 'prog', file, '-lm'];
        },
        run: () => ['stdbuf', '-o0', '-e0', '/box/prog'],
        memory: 256,
        jobeMemory: 400,
        // Like Jobe: any message of the compiler (also a warning of the linker, which -w does not turn off) is an error.
        strictCompile: true,
    },
    java: {
        // The public class decides the file name, as on Jobe; without one, the class with main (javaClass).
        file: (code) => `${javaClass(code)}.java`,
        compile: (file) => ['javac', '-encoding', 'UTF-8', '-J-Xmx512m', file],
        run: (file, {heap = 256, jobe = false} = {}) => ['java', `-Xmx${heap}m`, '-Xss8m', ...(jobe ? ['-Xrs'] : []),
            '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-Dfile.encoding=UTF-8', '-cp', '/box', file.replace(/\.java$/, '')],
        memory: 4096,
        // Jobe runs Java with -Xmx200m (and no address space limit); javac's notes are compilation errors there.
        heap: 256,
        jobeHeap: 200,
        strictCompile: true,
    },
    // SQL on MariaDB (MySQL): no compiling; the mariadb client runs the script in the session's own database, as a
    // user that sees only it (see lib/mysql.js). The server's socket is the only way out of the sandbox.
    mysql: {
        file: () => 'script.sql',
        compile: null,
        run: () => ['mariadb', '--table', '-vv', '--unbuffered', '--show-warnings', '--local-infile=0',
            '--default-character-set=utf8mb4',
            `--socket=${process.env.CODELAB_MYSQL_SOCKET || '/run/mysqld/mysqld.sock'}`],
        // For grading (POST /run): only the result tables, without the statements and the Query OK lines.
        batchRun: () => ['mariadb', '--table', '--show-warnings', '--local-infile=0', '--default-character-set=utf8mb4',
            `--socket=${process.env.CODELAB_MYSQL_SOCKET || '/run/mysqld/mysqld.sock'}`],
        memory: 256,
        binds: () => [(process.env.CODELAB_MYSQL_SOCKET || '/run/mysqld/mysqld.sock').replace(/\/[^/]*$/, '')],
    },
    csharp: {
        file: () => 'prog.cs',
        compile: (file) => ['mcs', '-out:prog.exe', file],
        run: () => ['mono', '/box/prog.exe'],
        memory: 4096,
        heap: 256,
        heapEnv: (heap) => ({MONO_GC_PARAMS: `max-heap-size=${heap}m`}),
    },
    python: {
        file: () => 'prog.py',
        compile: null,
        run: (file, {jobe = false} = {}) => ['python3', ...(jobe ? ['-BE'] : []), '/box/prog.py'],
        memory: 256,
        // Jobe gives Python 1500 MB (NumPy) and checks the syntax first, so a syntax error is a compilation error.
        jobeMemory: 1500,
        check: (file) => ['python3', '-m', 'py_compile', file],
    },
    javascript: {
        file: () => 'prog.js',
        compile: null,
        // V8 reserves a large address space, so the heap is limited instead (as the JVM and Mono are).
        run: (file, {heap = 256} = {}) => ['node', `--max-old-space-size=${heap}`, '/box/prog.js'],
        memory: 4096,
        heap: 256,
        jobeHeap: 512,
    },
    pascal: {
        file: () => 'prog.pas',
        compile: (file) => ['fpc', '-oprog', file],
        run: () => ['/box/prog'],
        memory: 256,
        jobeMemory: 400,
    },
    php: {
        file: () => 'prog.php',
        compile: null,
        // Jobe runs PHP without php.ini: warnings and notices go to the standard output, as there.
        run: (file, {jobe = false} = {}) => ['php', ...(jobe ? ['--no-php-ini'] : []), '/box/prog.php'],
        memory: 256,
        jobeMemory: 400,
        check: (file) => ['php', '--no-php-ini', '-l', file],
    },
    typescript: {
        file: () => 'prog.ts',
        compile: null,
        // Node.js 22.6+ strips TypeScript types natively without needing tsc or tsx.
        // Type stripping runs in WebAssembly, whose trap handler reserves more address space than the --as limit
        // allows ("Cannot allocate Wasm memory"), so it is switched off.
        run: (file, {heap = 256} = {}) => ['node', '--experimental-strip-types', '--no-warnings',
            '--disable-wasm-trap-handler', `--max-old-space-size=${heap}`, '/box/prog.ts'],
        memory: 4096,
        heap: 256,
        jobeHeap: 512,
    },
    bash: {
        file: () => 'prog.sh',
        compile: null,
        run: () => ['bash', '/box/prog.sh'],
        memory: 256,
        jobeMemory: 400,
        check: (file) => ['bash', '-n', file],
    },
    go: {
        file: () => 'prog.go',
        compile: (file) => ['go', 'build', '-o', 'prog', file],
        compileEnv: {GOCACHE: '/tmp/go-build', GOPATH: '/tmp/gopath', CGO_ENABLED: '0'},
        run: () => ['/box/prog'],
        memory: 4096,
        heap: 256,
        heapEnv: (heap) => ({GOMEMLIMIT: `${heap}MiB`}),
    },
    rust: {
        file: () => 'prog.rs',
        compile: (file) => ['rustc', '-o', 'prog', file],
        run: () => ['stdbuf', '-o0', '-e0', '/box/prog'],
        memory: 512,
        jobeMemory: 512,
    },
    r: {
        file: () => 'prog.R',
        compile: null,
        run: () => ['Rscript', '--vanilla', '/box/prog.R'],
        memory: 512,
        jobeMemory: 1024,
    },
    ruby: {
        file: () => 'prog.rb',
        compile: null,
        run: () => ['ruby', '/box/prog.rb'],
        memory: 256,
        jobeMemory: 400,
        check: (file) => ['ruby', '-c', file],
    },
    lua: {
        file: () => 'prog.lua',
        compile: null,
        run: () => ['lua', '/box/prog.lua'],
        memory: 256,
        jobeMemory: 400,
    },
    kotlin: {
        file: () => 'Main.kt',
        compile: (file) => ['kotlinc', file, '-include-runtime', '-d', 'prog.jar'],
        run: (_file, {heap = 256, jobe = false} = {}) => ['java', `-Xmx${heap}m`, '-Xss8m', ...(jobe ? ['-Xrs'] : []),
            '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-Dfile.encoding=UTF-8', '-jar', '/box/prog.jar'],
        memory: 4096,
        heap: 256,
        jobeHeap: 200,
    },
    perl: {
        file: () => 'prog.pl',
        compile: null,
        run: () => ['perl', '/box/prog.pl'],
        memory: 256,
        jobeMemory: 400,
        check: (file) => ['perl', '-c', file],
    },
    octave: {
        file: () => 'prog.m',
        compile: null,
        run: () => ['octave', '--no-gui', '--quiet', '--no-history', '/box/prog.m'],
        memory: 1024,
        jobeMemory: 1024,
    },
    julia: {
        file: () => 'prog.jl',
        compile: null,
        run: () => ['julia', '--startup-file=no', '--compile=min', '-O0', '--threads=1', '/box/prog.jl'],
        memory: 4096,
        jobeMemory: 4096,
    },
    scheme: {
        file: () => 'prog.scm',
        compile: null,
        run: () => ['guile', '--no-auto-compile', '/box/prog.scm'],
        memory: 512,
        jobeMemory: 512,
    },
    dart: {
        file: () => 'prog.dart',
        compile: null,
        run: () => ['dart', 'run', '/box/prog.dart'],
        memory: 4096,
        heap: 256,
        jobeHeap: 512,
    },
    scala: {
        file: () => 'Main.scala',
        compile: (file) => ['scalac', '-d', '/box', file],
        run: (_file, {heap = 256, jobe = false} = {}) => ['scala', `-J-Xmx${heap}m`, ...(jobe ? ['-J-Xrs'] : []),
            '-cp', '/box', 'Main'],
        memory: 4096,
        heap: 256,
        jobeHeap: 200,
    },
    elixir: {
        file: () => 'prog.exs',
        compile: null,
        run: () => ['elixir', '/box/prog.exs'],
        memory: 4096,
        jobeMemory: 4096,
    },
    swift: {
        file: () => 'prog.swift',
        compile: (file) => ['swiftc', '-o', 'prog', file],
        run: () => ['stdbuf', '-o0', '-e0', '/box/prog'],
        memory: 512,
        jobeMemory: 512,
    },
    haskell: {
        file: () => 'Main.hs',
        compile: (file) => ['ghc', '-O0', '-outputdir', '/tmp/ghc', '-o', 'prog', file],
        // Debian's /usr/lib/ghc/lib/package.conf.d is a link into /var/lib/ghc, which the sandbox does not mount.
        binds: () => ['/var/lib/ghc'].filter((folder) => existsSync(folder)),
        run: () => ['stdbuf', '-o0', '-e0', '/box/prog'],
        memory: 1024,
        jobeMemory: 1024,
    },
};

/**
 * Whether a program ended because it had no more memory: the messages of the runtimes and libraries when an
 * allocation fails under the address space limit (C programs usually end with a crash instead).
 *
 * @param {string} stderr
 * @returns {boolean}
 */
export const outOfMemory = (stderr) =>
    /OutOfMemoryError|OutOfMemoryException|std::bad_alloc|^MemoryError|heap out of memory|Allowed memory size of/m.test(stderr);

/** The command that prints the version of each language, and how to pick it out of the output. */
const VERSION_COMMANDS = {
    c: [['gcc', '--version'], /\) (\S+)/],
    cpp: [['g++', '--version'], /\) (\S+)/],
    clang: [['clang', '--version'], /version (\S+)/],
    java: [['javac', '-version'], /javac (\S+)/],
    csharp: [['mono', '--version'], /version (\S+)/],
    python: [['python3', '--version'], /Python (\S+)/],
    javascript: [['node', '--version'], /v(\S+)/],
    pascal: [['fpc', '-iV'], /^(\S+)/],
    php: [['php', '--version'], /PHP (\S+)/],
    mysql: [['mariadb', '--version'], /(\d+\.\d+\.\d+)-MariaDB/],
    typescript: [['node', '--experimental-strip-types', '--no-warnings', '-e',
        'const v: string = process.versions.node; console.log(v);'], /^(\S+)/],
    bash: [['bash', '--version'], /version (\d+\.\d+\.\d+)/],
    go: [['go', 'version'], /go(\d+\.\d+(?:\.\d+)?)/],
    rust: [['rustc', '--version'], /rustc (\S+)/],
    r: [['Rscript', '--version'], /version (\d+\.\d+\.\d+)/],
    ruby: [['ruby', '--version'], /ruby (\S+)/],
    lua: [['lua', '-v'], /Lua (\S+)/],
    kotlin: [['kotlinc', '-version'], /kotlinc-jvm (\S+)/],
    perl: [['perl', '-v'], /v(\d+\.\d+\.\d+)/],
    octave: [['octave', '--version'], /version (\d+\.\d+\.\d+)/],
    julia: [['julia', '--version'], /julia version (\S+)/],
    scheme: [['guile', '--version'], /\(GNU Guile\) (\S+)/],
    dart: [['dart', '--version'], /version: (\S+)/],
    scala: [['scalac', '-version'], /version (\S+)/],
    elixir: [['elixir', '--version'], /Elixir (\S+)/],
    swift: [['swiftc', '--version'], /Swift version (\S+)/],
    haskell: [['ghc', '--numeric-version'], /^(\S+)/],
};

let versions = null;
let tsSupported = null;

/**
 * Whether /usr/bin/<cmd> exists and resolves inside /usr (so it is reachable inside the bubblewrap sandbox, which only
 * mounts /usr and /etc — symlinks into /opt or /home would dangle inside the sandbox).
 *
 * @param {string} cmd
 * @returns {boolean}
 */
const binInUsr = (cmd) => {
    const p = `/usr/bin/${cmd}`;
    if (!existsSync(p)) {
        return false;
    }
    try {
        const real = realpathSync(p);
        return real.startsWith('/usr/') || real.startsWith('/bin/') || real.startsWith('/lib/');
    } catch {
        return false;
    }
};

/**
 * Whether /usr/bin/node supports native TypeScript type stripping (--experimental-strip-types, Node 22.6+).
 *
 * @returns {boolean}
 */
const typescriptAvailable = () => {
    if (tsSupported === null) {
        if (!binInUsr('node')) {
            tsSupported = false;
        } else {
            const res = spawnSync('/usr/bin/node', ['--experimental-strip-types', '--no-warnings', '-e',
                'const x: number = 1;'], {timeout: 5000});
            tsSupported = res.status === 0;
        }
    }
    return tsSupported;
};

/**
 * The versions of the installed languages, read once (as Jobe shows them): {c: '13.3.0', python: '3.12.3', ...}.
 *
 * @returns {Promise<Object<string, string>>}
 */
export const languageVersions = () => {
    versions ??= Promise.all(Object.entries(VERSION_COMMANDS).map(([lang, [command, pattern]]) =>
        new Promise((resolve) => {
            execFile(command[0], command.slice(1), {timeout: 10000}, (error, stdout, stderr) => {
                const match = pattern.exec(`${stdout}\n${stderr}`.trim());
                resolve([lang, !error && match ? match[1] : '']);
            });
        }))).then((pairs) => Object.fromEntries(pairs.filter(([, version]) => version)));
    return versions;
};

/**
 * Check whether the compiler/runtime binary for a language is installed under /usr/bin.
 *
 * @param {string} lang
 * @returns {boolean}
 */
export const languageAvailable = (lang) => {
    if (lang === 'typescript') {
        return typescriptAvailable();
    }
    const spec = LANGUAGES[lang];
    if (!spec) {
        return false;
    }
    const cmd = spec.compile ? spec.compile('x')[0] : spec.run('x')[0];
    return binInUsr(cmd);
};

/**
 * Files of the system a program must not read, although the runner's user may: they are covered with an empty file.
 * The settings of the runner (secrets) by default; CODELAB_HIDE gives the list (comma separated).
 *
 * @returns {string[]} the files that exist
 */
export const hiddenFiles = () => (process.env.CODELAB_HIDE ?? '/etc/codelab-runner.env').split(',')
    .map((f) => f.trim()).filter((f) => f.startsWith('/') && existsSync(f));

/**
 * The bubblewrap command around a command run in the folder dir (mounted at /box).
 *
 * @param {string} dir
 * @param {string[]} command
 * @param {Object} limits
 * @param {number} limits.cpu CPU seconds
 * @param {number} limits.memory address space in MB
 * @param {boolean} limits.writable whether /box is writable (compiling) or read-only (running)
 * @param {Object<string, string>} [env]
 * @param {string[]} [binds] more folders mounted read-only at the same place (the socket of MariaDB)
 * @returns {string[]} command and arguments
 */
export const sandboxCommand = (dir, command,
    {cpu, memory, writable, workDir = null, sanitize = false, memFile = null, leaksFile = null, addressLimit = true},
    env = {}, binds = []) => {
    const args = [
        '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
        '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
        '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
        '--proc', '/proc', '--dev', '/dev',
        // A tmpfs uses memory that the address space limit does not count.
        '--size', String(Number(process.env.CODELAB_TMP_MB || 64) * 1024 * 1024), '--tmpfs', '/tmp',
        writable ? '--bind' : '--ro-bind', dir, '/box',
        ...(workDir ? ['--bind', workDir, '/work', '--chdir', '/work'] : ['--chdir', '/box']),
        ...(memFile ? ['--bind', memFile, '/tmp/.codelab-mem'] : []),
        ...(leaksFile ? ['--bind', leaksFile, '/tmp/.codelab-leaks'] : []),
        '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8',
    ];
    const extraEnv = sanitize ? {
        ASAN_OPTIONS: 'detect_leaks=0:symbolize=1:abort_on_error=0:color=never:max_allocation_size_mb=256',
        UBSAN_OPTIONS: 'print_stacktrace=1:halt_on_error=1:color=never',
        ...env,
    } : env;
    for (const [name, value] of Object.entries(extraEnv)) {
        args.push('--setenv', name, value);
    }
    for (const folder of binds) {
        args.push('--ro-bind', folder, folder);
    }
    for (const file of hiddenFiles()) {
        args.push('--ro-bind', '/dev/null', file);
    }
    // ASan maps ~16 TB of virtual shadow memory on x86_64, so --as cannot be set when sanitize is on;
    // max_allocation_size_mb=256 in ASAN_OPTIONS caps allocations instead.
    // .NET (Step of C#) limits its heap by DOTNET_GCHeapHardLimit: an address space limit breaks its runtime.
    const limits = [`--cpu=${cpu}`, ...(sanitize || !addressLimit ? [] : [`--as=${memory * 1024 * 1024}`]),
        `--fsize=${16 * 1024 * 1024}`, '--core=0'];
    const nproc = Number(process.env.CODELAB_NPROC || 0);
    if (nproc > 0) {
        // Counts every process of the user the server runs as: use it with a user of its own.
        limits.push(`--nproc=${nproc}`);
    }
    const inner = memFile ? [TIME_BIN, '-f', '%M', '-o', '/tmp/.codelab-mem', '--', ...command] : command;
    return ['bwrap', ...args, 'prlimit', ...limits, '--', ...inner];
};

/**
 * Run a command to its end and collect its output (used for compiling).
 *
 * @param {string[]} command
 * @param {number} seconds wall time limit
 * @returns {Promise<{code: number|null, signal: string|null, output: string, timedout: boolean}>}
 */
const collect = (command, seconds) => new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    let timedout = false;
    const add = (chunk) => {
        if (output.length < 65536) {
            output += chunk.toString('utf8');
        }
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
        timedout = true;
        child.kill('SIGKILL');
    }, seconds * 1000);
    child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({code, signal, output, timedout});
    });
    child.on('error', (e) => {
        clearTimeout(timer);
        logError('compile', e);
        resolve({code: -1, signal: null, output: clientError(e, MESSAGES.compiler), timedout});
    });
});

/** Path to GNU time for measuring peak RSS memory (KB) in batch runs. */
const TIME_BIN = '/usr/bin/time';

/**
 * Whether clang is installed in /usr/bin.
 *
 * @returns {boolean}
 */
export const clangAvailable = () => existsSync('/usr/bin/clang');

/**
 * Whether GNU time is installed in /usr/bin.
 *
 * @returns {boolean}
 */
export const timeAvailable = () => existsSync(TIME_BIN);

export class Program {
    /**
     * A program of a language.
     *
     * @param {string} lang c, cpp, java or csharp
     * @param {string} code
     * @param {Array<{name: string, text: string}>} [files] input files placed in the working folder /work
     * @param {?{compiler: string, std: string, key: string}} [compileOptions] C/C++ compiler profile and standard
     */
    constructor(lang, code, files = [], compileOptions = null) {
        this.langName = lang;
        this.lang = LANGUAGES[lang];
        this.code = code;
        this.files = files;
        this.compileOptions = compileOptions;
        this.file = this.lang.file(code);
        this.dir = null;
        this.workDir = null;
        this.givenFiles = new Map();
        this.memFile = null;
        this.leaksFile = null;
        this.child = null;
    }

    /**
     * Create the writable working folder /work and place the input files in it (skipped for SQL).
     */
    async prepareWorkDir() {
        if (this.langName === 'mysql' || this.workDir) {
            return;
        }
        this.workDir = await mkdtemp(join(process.env.CODELAB_TMP || tmpdir(), 'codelab-work-'));
        this.givenFiles = await writeInputFiles(this.workDir, this.files);
    }

    /**
     * Files created or changed by the program in /work.
     *
     * @returns {Promise<Array<{name: string, text: string, size: number}>>}
     */
    async changedFiles() {
        return this.workDir ? readChangedFiles(this.workDir, this.givenFiles) : [];
    }

    /**
     * Write the source and compile it.
     *
     * @param {boolean} [debug] for gdb: debugging information, no optimisation, unbuffered output and the FIFOs of the
     *     program's input and output
     * @returns {Promise<{ok: boolean, output: string}>}
     */
    async compile(debug = false) {
        this.dir = await mkdtemp(join(process.env.CODELAB_TMP || tmpdir(), 'codelab-'));
        await writeFile(join(this.dir, this.file), this.code);
        const fifos = debug ? ['in.fifo', 'out.fifo', 'err.fifo'] : [];
        for (const fifo of fifos) {
            spawnSync('mkfifo', ['-m', '600', join(this.dir, fifo)]);
        }
        if (!this.lang.compile) {
            return {ok: true, output: ''};
        }
        // Step of C#: compiled for .NET by its Roslyn compiler, with portable debugging information for netcoredbg.
        const dotnet = debug && this.langName === 'csharp' ? csharpDebug() : null;
        let command = dotnet
            ? ['dotnet', dotnet.csc, '-nologo', '-debug:portable', '-optimize-', '-out:prog.dll',
                ...dotnet.refs.map((ref) => `-r:${ref}`), this.file]
            : this.lang.compile(this.file, this.compileOptions);
        if (debug && this.langName === 'java') {
            // Step of Java: the local variables need javac -g; the debugger is built (once) now.
            command = [command[0], '-g', ...command.slice(1)];
            this.javaDebugger = await buildJavaDebugger();
        }
        if (dotnet) {
            command[0] = join(dotnet.root, 'dotnet');
            await writeFile(join(this.dir, 'prog.runtimeconfig.json'), runtimeConfig(dotnet.framework));
        }
        const compileRe = COMPILE_EXT[this.langName];
        const extraFiles = compileRe ? this.files.filter((f) => compileRe.test(f.name) && f.name !== this.file) : [];
        const extraKey = extraFiles.length
            ? extraFiles.map((f) => `${f.name}\0${f.text}`).sort().join('\0')
            : '';
        const baseProfile = this.compileOptions?.key || '';
        const profile = extraKey ? `${baseProfile}\0${extraKey}` : baseProfile;
        const key = cacheKey(this.langName, debug, this.file, this.code, profile);
        if (await restore(key, this.dir)) {
            this.cached = true;
            return {ok: true, output: ''};
        }
        for (const f of extraFiles) {
            await writeFile(join(this.dir, f.name), f.text);
        }
        const linkRe = LINK_EXT[this.langName];
        const linkFiles = linkRe ? extraFiles.filter((f) => linkRe.test(f.name)).map((f) => f.name) : [];
        if (extraFiles.length && (this.langName === 'c' || this.langName === 'cpp')) {
            command = [command[0], '-I', '/box', ...command.slice(1)];
        }
        if (linkFiles.length) {
            const atFile = command.indexOf(this.file);
            if (atFile >= 0) {
                command = [...command.slice(0, atFile + 1), ...linkFiles, ...command.slice(atFile + 1)];
            }
        }
        const msvc = this.compileOptions?.compiler === 'msvc';
        if (msvc) {
            await cp(MSVC_DIR, join(this.dir, 'msvc'), {recursive: true});
        }
        const sanitize = Boolean(this.compileOptions?.sanitize);
        const native = this.langName === 'c' || this.langName === 'cpp';
        const trackLeaks = debug && native;
        if ((debug && native) || sanitize) {
            await writeFile(join(this.dir, UNBUFFERED), UNBUFFERED_CODE);
            if (trackLeaks) {
                await writeFile(join(this.dir, LEAKS), LEAKS_CODE);
            }
            const at = command.indexOf(this.file);
            const extra = debug ? ['-g', '-O0'] : [];
            const helpers = trackLeaks ? [UNBUFFERED, LEAKS] : [UNBUFFERED];
            const linkFlags = trackLeaks ? LEAK_WRAP_FLAGS : [];
            command = [command[0], ...extra, ...command.slice(1, at + 1), ...helpers, ...command.slice(at + 1), ...linkFlags];
        }
        const result = await collect(
            dotnet
                ? sandboxCommand(this.dir, command, {cpu: 30, memory: 4096, writable: true, addressLimit: false},
                    dotnetEnv(dotnet.root, 1024), dotnet.folders)
                : sandboxCommand(this.dir, command, {cpu: 30, memory: 4096, writable: true}, this.lang.compileEnv || {},
                    this.lang.binds ? this.lang.binds() : []),
            Number(process.env.CODELAB_COMPILE_SECONDS || 30)
        );
        const ok = result.code === 0 && !result.timedout;
        // A compilation with messages (warnings) is not cached: in the Jobe mode of grading the messages are an error,
        // and a program restored from the cache would have none.
        if (ok && !(this.lang.strictCompile && result.output.trim() !== '')) {
            await store(key, this.dir, [this.file, UNBUFFERED, ...(trackLeaks ? [LEAKS] : []),
                ...extraFiles.map((f) => f.name), ...(msvc ? ['msvc'] : []), ...fifos]);
        }
        if (ok) {
            return {ok, output: result.output};
        }
        return {ok, output: result.timedout ? `${result.output}\nCompiling took too long.` : compileFailure(result)};
    }

    /**
     * Check the syntax of a program of an interpreted language, as Jobe does before running it (Python py_compile,
     * PHP -l), so that a syntax error is a compilation error. Languages without a check pass.
     *
     * @returns {Promise<{ok: boolean, output: string}>}
     */
    async check() {
        if (!this.lang.check) {
            return {ok: true, output: ''};
        }
        const result = await collect(
            sandboxCommand(this.dir, this.lang.check(this.file), {cpu: 10, memory: 1024, writable: true}),
            Number(process.env.CODELAB_COMPILE_SECONDS || 30)
        );
        // The sandbox did not start (code -1): the run that follows reports it, as for languages without a check.
        const ok = result.code === -1 || (result.code === 0 && !result.timedout);
        return {ok, output: ok ? '' : compileFailure(result)};
    }

    /**
     * Start the compiled program; its stdin, stdout and stderr are pipes.
     *
     * @param {number} cpu CPU seconds
     * @param {Object} [extra]
     * @param {string[]} [extra.args] more arguments of the run command (the user and database of SQL)
     * @param {Object<string, string>} [extra.env] more environment variables (the password of SQL)
     * @param {boolean} [extra.batch] the command for grading, when the language has one
     * @param {number} [extra.memory] address space limit in MB (overrides language default when given)
     * @param {boolean} [extra.measureMemory] wrap with /usr/bin/time to record peak RSS in KB
     * @param {number} [extra.heap] heap limit in MB of Java, C# and JavaScript (default: the language's)
     * @param {boolean} [extra.jobe] the interpreters' arguments of Jobe (Python -BE, PHP without php.ini, Java -Xrs)
     * @returns {import('node:child_process').ChildProcess}
     */
    start(cpu, {args = [], env = {}, batch = false, memory, measureMemory = false, heap, jobe = false} = {}) {
        const run = batch && this.lang.batchRun ? this.lang.batchRun : this.lang.run;
        const sanitize = Boolean(this.compileOptions?.sanitize);
        // Under ASan, stdbuf's LD_PRELOAD conflicts with libasan; unbuffered stdout is linked via codelab_unbuffered.c.
        const theHeap = heap || this.lang.heap;
        const runCmd = sanitize ? ['/box/prog'] : run(this.file, {heap: theHeap, jobe});
        this.memFile = null;
        if (measureMemory && timeAvailable()) {
            this.memFile = join(this.dir, '.codelab-mem');
            writeFileSync(this.memFile, '');
        }
        const command = sandboxCommand(this.dir, [...runCmd, ...args],
            {cpu, memory: memory || this.lang.memory, writable: false, workDir: this.workDir, sanitize, memFile: this.memFile},
            {...(this.lang.env || {}), ...(this.lang.heapEnv ? this.lang.heapEnv(theHeap) : {}), ...env},
            this.lang.binds ? this.lang.binds() : []);
        this.child = spawn(command[0], command.slice(1), {stdio: ['pipe', 'pipe', 'pipe']});
        return this.child;
    }

    /**
     * Peak resident set size (KB) recorded by GNU time during start(..., {measureMemory: true}), or null.
     *
     * @returns {Promise<?number>}
     */
    async peakMemoryKb() {
        if (!this.memFile) {
            return null;
        }
        try {
            const text = await readFile(this.memFile, 'utf8');
            const lines = text.trim().split(/\r?\n/).filter(Boolean);
            const kb = Number.parseInt(lines[lines.length - 1] || '', 10);
            return Number.isFinite(kb) && kb > 0 ? kb : null;
        } catch {
            return null;
        }
    }

    /**
     * Start gdb with the compiled program (machine interface on its stdin and stdout); the program itself reads
     * in.fifo and writes out.fifo and err.fifo of its folder.
     *
     * @param {number} cpu CPU seconds of gdb and the program
     * @returns {import('node:child_process').ChildProcess}
     */
    startDebugger(cpu) {
        const dotnet = this.langName === 'csharp' ? csharpDebug() : null;
        if (dotnet) {
            // netcoredbg starts the program through a shell that gives it the FIFOs (exec keeps the process it waits for).
            const run = `exec ${join(dotnet.root, 'dotnet')} /box/prog.dll </box/in.fifo >/box/out.fifo 2>/box/err.fifo`;
            const command = sandboxCommand(this.dir, [dotnet.debugger, '--interpreter=mi', '--', '/bin/sh', '-c', run],
                {cpu, memory: 0, writable: false, workDir: this.workDir, addressLimit: false},
                dotnetEnv(dotnet.root, CSHARP_DEBUG_HEAP), dotnet.folders);
            this.child = spawn(command[0], command.slice(1), {stdio: ['pipe', 'pipe', 'pipe']});
            return this.child;
        }
        if (this.langName === 'java') {
            // The debugger runs the program's JVM itself (suspended, with the FIFOs of /box) and talks MI to the session.
            const command = sandboxCommand(this.dir, ['java', '-Xmx128m', '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1',
                '-cp', this.javaDebugger || '/nonexistent', 'JavaDebugger', this.file.replace(/\.java$/, ''), '/box',
                JAVA_DEBUG_OPTIONS],
            {cpu, memory: this.lang.memory, writable: false, workDir: this.workDir},
            {}, this.javaDebugger ? [this.javaDebugger] : []);
            this.child = spawn(command[0], command.slice(1), {stdio: ['pipe', 'pipe', 'pipe']});
            return this.child;
        }
        if (this.langName === 'javascript' || this.langName === 'typescript') {
            // NodeDebugger launches node --inspect-brk=127.0.0.1:0 on /box/prog.js|ts and bridges CDP to gdb/MI.
            const command = sandboxCommand(this.dir, ['node', '--max-old-space-size=128',
                join(NODE_DEBUGGER_DIR, 'NodeDebugger.mjs'), `/box/${this.file}`, '/box', String(this.lang.heap || 256)],
            {cpu, memory: this.lang.memory, writable: false, workDir: this.workDir},
            {}, [NODE_DEBUGGER_DIR]);
            this.child = spawn(command[0], command.slice(1), {stdio: ['pipe', 'pipe', 'pipe']});
            return this.child;
        }
        this.leaksFile = join(this.dir, '.codelab-leaks');
        writeFileSync(this.leaksFile, '');
        const command = sandboxCommand(this.dir, ['gdb', '-q', '-nx', '--interpreter=mi3', '/box/prog'],
            {cpu, memory: this.lang.memory + 512, writable: false, workDir: this.workDir, leaksFile: this.leaksFile});
        this.child = spawn(command[0], command.slice(1), {stdio: ['pipe', 'pipe', 'pipe']});
        return this.child;
    }

    /**
     * Unfreed heap allocations recorded at normal exit in debug mode, or [].
     *
     * @returns {Promise<Array<{addr: string, size: number}>>}
     */
    async readLeaks() {
        if (!this.leaksFile) {
            return [];
        }
        try {
            const text = await readFile(this.leaksFile, 'utf8');
            const leaks = [];
            for (const line of text.trim().split(/\r?\n/)) {
                const m = /^(0x[0-9a-f]+)\s+(\d+)$/i.exec(line.trim());
                if (m) {
                    leaks.push({addr: m[1].toLowerCase(), size: Number(m[2])});
                }
            }
            return leaks;
        } catch {
            return [];
        }
    }

    /**
     * Path of a file in the program's folder.
     *
     * @param {string} name
     * @returns {string}
     */
    path(name) {
        return join(this.dir, name);
    }

    /**
     * Stop the program and remove its folder.
     */
    async dispose() {
        if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
            this.child.kill('SIGKILL');
        }
        if (this.dir) {
            await rm(this.dir, {recursive: true, force: true});
            this.dir = null;
        }
        if (this.workDir) {
            await rm(this.workDir, {recursive: true, force: true});
            this.workDir = null;
        }
    }
}
