// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Compiling and running one program in a bubblewrap sandbox: no network, a read-only system, a private /tmp, the
 * program's own folder, and CPU, memory and file size limits (prlimit). The compilers and their arguments are the same
 * as on the Jobe server used for grading, so the output is the same.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

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
    csharp: {
        file: () => 'prog.cs',
        compile: (file) => ['mcs', '-out:prog.exe', file],
        run: () => ['mono', 'prog.exe'],
        memory: 4096,
        env: {MONO_GC_PARAMS: 'max-heap-size=256m'},
    },
};

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
 * @returns {string[]} command and arguments
 */
export const sandboxCommand = (dir, command, {cpu, memory, writable}, env = {}) => {
    const args = [
        '--unshare-all', '--die-with-parent', '--new-session',
        '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
        '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
        writable ? '--bind' : '--ro-bind', dir, '/box', '--chdir', '/box',
        '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8',
    ];
    for (const [name, value] of Object.entries(env)) {
        args.push('--setenv', name, value);
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
        this.lang = LANGUAGES[lang];
        this.code = code;
        this.file = this.lang.file(code);
        this.dir = null;
        this.child = null;
    }

    /**
     * Write the source and compile it.
     *
     * @returns {Promise<{ok: boolean, output: string}>}
     */
    async compile() {
        this.dir = await mkdtemp(join(process.env.CODELAB_TMP || tmpdir(), 'codelab-'));
        await writeFile(join(this.dir, this.file), this.code);
        const result = await collect(
            sandboxCommand(this.dir, this.lang.compile(this.file), {cpu: 30, memory: 4096, writable: true}),
            Number(process.env.CODELAB_COMPILE_SECONDS || 30)
        );
        const ok = result.code === 0 && !result.timedout;
        return {ok, output: result.timedout ? `${result.output}\nCompiling took too long.` : result.output};
    }

    /**
     * Start the compiled program; its stdin, stdout and stderr are pipes.
     *
     * @param {number} cpu CPU seconds
     * @returns {import('node:child_process').ChildProcess}
     */
    start(cpu) {
        const command = sandboxCommand(this.dir, this.lang.run(this.file),
            {cpu, memory: this.lang.memory, writable: false}, this.lang.env || {});
        this.child = spawn(command[0], command.slice(1), {stdio: ['pipe', 'pipe', 'pipe']});
        return this.child;
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
