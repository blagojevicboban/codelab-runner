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
import {spawn, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cacheKey, restore, store} from './cache.js';

/** Languages that can run step by step under gdb. */
export const DEBUG_LANGUAGES = ['c', 'cpp'];

/**
 * Linked with a program that runs under gdb: its output goes to a FIFO, where the C library would buffer it, so the
 * standard output is made unbuffered before main.
 */
const UNBUFFERED = 'codelab_unbuffered.c';
const UNBUFFERED_CODE = '#include <stdio.h>\n' +
    '__attribute__((constructor)) static void codelab_unbuffered(void) { setvbuf(stdout, NULL, _IONBF, 0); }\n';

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
        compile: (file) => ['gcc', '-std=c11', '-D_GNU_SOURCE', '-w', ...SAFE, '-o', 'prog', file, '-lm'],
        run: () => ['stdbuf', '-o0', '-e0', './prog'],
        memory: 256,
    },
    cpp: {
        file: () => 'prog.cpp',
        compile: (file) => ['g++', '-std=c++17', '-w', ...SAFE, '-o', 'prog', file, '-lm'],
        run: () => ['stdbuf', '-o0', '-e0', './prog'],
        memory: 256,
    },
    java: {
        // The public class decides the file name, as on Jobe.
        file: (code) => `${(/public\s+(?:final\s+|abstract\s+)*class\s+([A-Za-z_]\w*)/.exec(code) || [null, 'Main'])[1]}.java`,
        compile: (file) => ['javac', '-encoding', 'UTF-8', '-J-Xmx512m', file],
        run: (file) => ['java', '-Xmx256m', '-Xss8m', '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-Dfile.encoding=UTF-8',
            file.replace(/\.java$/, '')],
        memory: 4096,
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
        run: () => ['mono', 'prog.exe'],
        memory: 4096,
        env: {MONO_GC_PARAMS: 'max-heap-size=256m'},
    },
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
export const sandboxCommand = (dir, command, {cpu, memory, writable}, env = {}, binds = []) => {
    const args = [
        '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
        '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
        '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
        '--proc', '/proc', '--dev', '/dev',
        // A tmpfs uses memory that the address space limit does not count.
        '--size', String(Number(process.env.CODELAB_TMP_MB || 64) * 1024 * 1024), '--tmpfs', '/tmp',
        writable ? '--bind' : '--ro-bind', dir, '/box', '--chdir', '/box',
        '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8',
    ];
    for (const [name, value] of Object.entries(env)) {
        args.push('--setenv', name, value);
    }
    for (const folder of binds) {
        args.push('--ro-bind', folder, folder);
    }
    for (const file of hiddenFiles()) {
        args.push('--ro-bind', '/dev/null', file);
    }
    const limits = [`--cpu=${cpu}`, `--as=${memory * 1024 * 1024}`, `--fsize=${16 * 1024 * 1024}`, '--core=0'];
    const nproc = Number(process.env.CODELAB_NPROC || 0);
    if (nproc > 0) {
        // Counts every process of the user the server runs as: use it with a user of its own.
        limits.push(`--nproc=${nproc}`);
    }
    return ['bwrap', ...args, 'prlimit', ...limits, '--', ...command];
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
        resolve({code: -1, signal: null, output: e.message, timedout});
    });
});

export class Program {
    /**
     * A program of a language.
     *
     * @param {string} lang c, cpp, java or csharp
     * @param {string} code
     */
    constructor(lang, code) {
        this.langName = lang;
        this.lang = LANGUAGES[lang];
        this.code = code;
        this.file = this.lang.file(code);
        this.dir = null;
        this.child = null;
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
        if (!this.lang.compile) {
            return {ok: true, output: ''};
        }
        let command = this.lang.compile(this.file);
        const fifos = debug ? ['in.fifo', 'out.fifo', 'err.fifo'] : [];
        for (const fifo of fifos) {
            spawnSync('mkfifo', ['-m', '600', join(this.dir, fifo)]);
        }
        const key = cacheKey(this.langName, debug, this.file, this.code);
        if (await restore(key, this.dir)) {
            this.cached = true;
            return {ok: true, output: ''};
        }
        if (debug) {
            await writeFile(join(this.dir, UNBUFFERED), UNBUFFERED_CODE);
            const at = command.indexOf(this.file);
            command = [command[0], '-g', '-O0', ...command.slice(1, at + 1), UNBUFFERED, ...command.slice(at + 1)];
        }
        const result = await collect(
            sandboxCommand(this.dir, command, {cpu: 30, memory: 4096, writable: true}),
            Number(process.env.CODELAB_COMPILE_SECONDS || 30)
        );
        const ok = result.code === 0 && !result.timedout;
        if (ok) {
            await store(key, this.dir, [this.file, UNBUFFERED, ...fifos]);
        }
        return {ok, output: result.timedout ? `${result.output}\nCompiling took too long.` : result.output};
    }

    /**
     * Start the compiled program; its stdin, stdout and stderr are pipes.
     *
     * @param {number} cpu CPU seconds
     * @param {Object} [extra]
     * @param {string[]} [extra.args] more arguments of the run command (the user and database of SQL)
     * @param {Object<string, string>} [extra.env] more environment variables (the password of SQL)
     * @param {boolean} [extra.batch] the command for grading, when the language has one
     * @returns {import('node:child_process').ChildProcess}
     */
    start(cpu, {args = [], env = {}, batch = false} = {}) {
        const run = batch && this.lang.batchRun ? this.lang.batchRun : this.lang.run;
        const command = sandboxCommand(this.dir, [...run(this.file), ...args],
            {cpu, memory: this.lang.memory, writable: false}, {...(this.lang.env || {}), ...env},
            this.lang.binds ? this.lang.binds() : []);
        this.child = spawn(command[0], command.slice(1), {stdio: ['pipe', 'pipe', 'pipe']});
        return this.child;
    }

    /**
     * Start gdb with the compiled program (machine interface on its stdin and stdout); the program itself reads
     * in.fifo and writes out.fifo and err.fifo of its folder.
     *
     * @param {number} cpu CPU seconds of gdb and the program
     * @returns {import('node:child_process').ChildProcess}
     */
    startDebugger(cpu) {
        const command = sandboxCommand(this.dir, ['gdb', '-q', '-nx', '--interpreter=mi3', './prog'],
            {cpu, memory: this.lang.memory + 512, writable: false});
        this.child = spawn(command[0], command.slice(1), {stdio: ['pipe', 'pipe', 'pipe']});
        return this.child;
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
    }
}
