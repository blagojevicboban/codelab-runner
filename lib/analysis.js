// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Language services for C# and Java (C and C++: lib/clangd.js): one analyzer process per language for all readers of the server, the Roslyn
 * analyzer (roslyn/, a .NET 8 program) and the Java analyzer (java-analyzer/, the compiler of the JDK as a library,
 * built with javac when it is first needed). Each request carries the whole program and a position, and gets
 * completions, the signatures of a call, a tooltip or the errors of the compiler back. Programs are only analyzed, never
 * run. A process starts with the first request, talks JSON lines over stdin and stdout, is started again when it ends,
 * and is stopped after a while without requests.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, renameSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {hiddenFiles} from './sandbox.js';

/** The operations of the analyzer. */
export const OPERATIONS = ['complete', 'describe', 'signatures', 'hover', 'diagnostics'];

/** Largest program (with its other files) that is analyzed, in characters. */
export const CODE_MAX = 200000;

/** The published analyzer in this checkout (dotnet publish -c Release -o roslyn/publish). */
const DEFAULT_DLL = join(dirname(dirname(fileURLToPath(import.meta.url))), 'roslyn', 'publish', 'CodeLab.Roslyn.dll');

/**
 * Where the analyzer is: CODELAB_ROSLYN (path of CodeLab.Roslyn.dll, or 'off'), else the published copy in roslyn/publish.
 *
 * @returns {string} '' when there is none
 */
export const analyzerPath = () => {
    const setting = process.env.CODELAB_ROSLYN ?? '';
    if (setting === 'off') {
        return '';
    }
    const path = setting || DEFAULT_DLL;
    return existsSync(path) ? path : '';
};

/**
 * The dotnet program that runs the analyzer: CODELAB_DOTNET, else the one in DOTNET_ROOT, else dotnet on the PATH.
 *
 * @returns {string}
 */
const dotnet = () => process.env.CODELAB_DOTNET ||
    (process.env.DOTNET_ROOT ? join(process.env.DOTNET_ROOT, 'dotnet') : 'dotnet');

/**
 * Whether bubblewrap is there (not in development on some machines).
 *
 * @returns {boolean}
 */
const bwrapAvailable = () => spawnSync('bwrap', ['--version'], {stdio: 'ignore'}).status === 0;

/**
 * The command that starts the analyzer: in a sandbox without network, files of the server or a writable folder,
 * except /tmp. The heap of .NET is limited by its own setting (a limit of the address space breaks the .NET runtime).
 *
 * @param {string} dll
 * @param {boolean} sandbox
 * @returns {{command: string[], env: Object<string, string>}}
 */
export const analyzerCommand = (dll, sandbox) => {
    const heapMb = Number(process.env.CODELAB_ROSLYN_HEAP_MB || 768);
    const env = {
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
        DOTNET_gcServer: '0',
        DOTNET_GCHeapHardLimit: `0x${(heapMb * 1024 * 1024).toString(16)}`,
        DOTNET_TieredPGO: '0',
        HOME: '/tmp',
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
    };
    const home = process.env.DOTNET_ROOT || '';
    if (home) {
        env.DOTNET_ROOT = home;
    }
    // A dotnet outside /usr (installed by dotnet-install.sh into a home folder) is mounted where it is.
    return sandboxed([dotnet(), dll], [dirname(dll), ...(home && !home.startsWith('/usr/') ? [home] : [])], env, sandbox);
};

/**
 * A command of an analyzer, in a sandbox without network, files of the server or a writable folder except /tmp, or
 * as it is (development without bubblewrap).
 *
 * @param {string[]} run the command
 * @param {string[]} folders mounted read-only where they are
 * @param {Object<string, string>} env its whole environment
 * @param {boolean} sandbox
 * @returns {{command: string[], env: Object<string, string>}}
 */
export const sandboxed = (run, folders, env, sandbox) => {
    if (!sandbox) {
        return {command: run, env};
    }
    const args = [
        '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
        '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
        '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
        '--clearenv',
    ];
    for (const folder of folders) {
        args.push('--ro-bind', folder, folder);
    }
    for (const [name, value] of Object.entries(env)) {
        args.push('--setenv', name, value);
    }
    for (const file of hiddenFiles()) {
        args.push('--ro-bind', '/dev/null', file);
    }
    return {command: ['bwrap', ...args, '--', ...run], env: {}};
};

/** The source of the Java analyzer in this checkout. */
const JAVA_SOURCE = join(dirname(dirname(fileURLToPath(import.meta.url))), 'java-analyzer', 'JavaAnalyzer.java');

let javacFound = null;

/**
 * Where the source of the Java analyzer is, when the JDK can build it ('' when not, or CODELAB_JAVA_ANALYZER=off).
 *
 * @returns {string}
 */
export const javaSourcePath = () => {
    if (process.env.CODELAB_JAVA_ANALYZER === 'off' || !existsSync(JAVA_SOURCE)) {
        return '';
    }
    javacFound ??= spawnSync('javac', ['-version'], {stdio: 'ignore'}).status === 0;
    return javacFound ? JAVA_SOURCE : '';
};

/**
 * The folder of the built Java analyzer: one per version of its source, in the temporary folder of the server.
 *
 * @param {string} source
 * @returns {string}
 */
export const javaClassesDir = (source) => {
    const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
    return join(process.env.CODELAB_TMP || tmpdir(), `codelab-java-analyzer-${hash}`);
};

/**
 * Build the Java analyzer with javac when its folder is not there yet.
 *
 * @param {string} source
 * @returns {Promise<boolean>}
 */
export const buildJava = (source) => {
    const dir = javaClassesDir(source);
    if (existsSync(join(dir, 'JavaAnalyzer.class'))) {
        return Promise.resolve(true);
    }
    const work = `${dir}.build-${process.pid}`;
    return new Promise((resolve) => {
        const child = spawn('javac', ['-proc:none', '-d', work, source], {stdio: ['ignore', 'ignore', 'pipe']});
        let errors = '';
        child.stderr.on('data', (chunk) => {
            errors += chunk.toString('utf8');
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
        child.on('error', () => resolve(false));
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                process.stderr.write(`[java analyzer] javac failed: ${errors.slice(0, 2000)}\n`);
                rmSync(work, {recursive: true, force: true});
                resolve(false);
                return;
            }
            try {
                renameSync(work, dir);
            } catch {
                // Another server built it at the same time.
                rmSync(work, {recursive: true, force: true});
            }
            resolve(existsSync(join(dir, 'JavaAnalyzer.class')));
        });
    });
};

/**
 * The command that starts the Java analyzer (the JDK is under /usr, the Javadoc in its src.zip).
 *
 * @param {string} source
 * @param {boolean} sandbox
 * @returns {{command: string[], env: Object<string, string>}}
 */
export const javaCommand = (source, sandbox) => {
    const dir = javaClassesDir(source);
    const heapMb = Number(process.env.CODELAB_JAVA_ANALYZER_HEAP_MB || 384);
    const run = [process.env.CODELAB_JAVA || 'java', `-Xmx${heapMb}m`, '-XX:+UseSerialGC', '-XX:-UsePerfData',
        '-Xshare:auto', '-cp', dir, 'JavaAnalyzer'];
    return sandboxed(run, [dir], {HOME: '/tmp', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}, sandbox);
};

/**
 * Check a request of a reader before it goes to the analyzer.
 *
 * @param {*} message
 * @returns {?Object} the request, or null when it is not one
 */
export const cleanRequest = (message) => {
    if (!message || typeof message !== 'object' || !OPERATIONS.includes(message.op)) {
        return null;
    }
    const code = typeof message.code === 'string' ? message.code : '';
    const files = Array.isArray(message.files) ? message.files.slice(0, 8)
        .filter((f) => f && typeof f.name === 'string' && typeof f.code === 'string' && /^[\w.-]{1,64}\.(cs|java|c|h|cpp|cc|cxx|hpp|hh)$/i.test(f.name))
        .map((f) => ({name: f.name, code: f.code})) : [];
    const size = code.length + files.reduce((sum, f) => sum + f.code.length, 0);
    if (size > CODE_MAX) {
        return null;
    }
    const whole = (value) => (Number.isInteger(value) && value >= 0 && value < 1000000 ? value : 0);
    return {
        op: message.op,
        code,
        files,
        line: whole(message.line),
        column: whole(message.column),
        item: typeof message.item === 'string' ? message.item.slice(0, 200) : '',
        culture: typeof message.culture === 'string' && /^[a-zA-Z-]{2,12}$/.test(message.culture) ? message.culture : '',
        // C and C++ (lib/clangd.js): the standard and the compiler profile, checked there against the allowed ones.
        ...(typeof message.std === 'string' && /^c(\+\+)?\d\d$/.test(message.std) ? {std: message.std} : {}),
        ...(typeof message.compiler === 'string' && /^[a-z]{3,6}$/.test(message.compiler) ? {compiler: message.compiler} : {}),
    };
};

/**
 * The analyzer process, shared by all connections of the server.
 */
export class Analyzer {
    /**
     * @param {Object} [options]
     * @param {string} [options.dll] path of CodeLab.Roslyn.dll (default analyzerPath())
     * @param {boolean} [options.sandbox] start it in bubblewrap (default: when bwrap is there and CODELAB_ROSLYN_SANDBOX is not 0)
     * @param {number} [options.timeoutMs] longest wait for an answer
     * @param {number} [options.idleMs] stop the process after this long without requests (0: never)
     * @param {number} [options.maxPending] requests that may wait at once; more are answered busy
     * @param {function(): {command: string[], env: Object}} [options.command] command of the process (tests)
     * @param {function(): Promise<boolean>} [options.prepare] what has to be done once before the first start (a build)
     * @param {string} [options.name] name in the server's log
     */
    constructor({dll, sandbox, timeoutMs, idleMs, maxPending, command, prepare, name = 'roslyn'} = {}) {
        this.dll = dll ?? analyzerPath();
        this.name = name;
        this.prepare = prepare ?? null;
        /** @type {?Promise<boolean>} */
        this.prepared = null;
        this.sandbox = sandbox ?? (process.env.CODELAB_ROSLYN_SANDBOX !== '0' && bwrapAvailable());
        this.timeoutMs = timeoutMs ?? Number(process.env.CODELAB_ROSLYN_TIMEOUT || 8) * 1000;
        this.idleMs = idleMs ?? Number(process.env.CODELAB_ROSLYN_IDLE_MIN ?? 30) * 60000;
        this.maxPending = maxPending ?? Number(process.env.CODELAB_ROSLYN_PENDING || 64);
        this.makeCommand = command ?? (() => analyzerCommand(this.dll, this.sandbox));
        /** @type {?import('node:child_process').ChildProcess} */
        this.child = null;
        /** @type {Map<number, function(?Object): void>} */
        this.pending = new Map();
        this.next = 0;
        this.idleTimer = null;
        this.failures = 0;
    }

    /**
     * Whether the analyzer can be used on this server.
     *
     * @returns {boolean}
     */
    available() {
        return this.dll !== '' && this.failures < 5;
    }

    /**
     * Start the process when it is not running.
     */
    start() {
        if (this.child) {
            return;
        }
        const {command, env} = this.makeCommand();
        const child = spawn(command[0], command.slice(1), {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: Object.keys(env).length ? env : process.env,
        });
        this.child = child;
        const lines = createInterface({input: child.stdout});
        lines.on('line', (line) => {
            let answer;
            try {
                answer = JSON.parse(line);
            } catch {
                return;
            }
            const resolve = this.pending.get(answer?.id);
            if (resolve) {
                this.pending.delete(answer.id);
                resolve(answer);
            }
        });
        child.stderr.on('data', (chunk) => {
            process.stderr.write(`[${this.name}] ${chunk.toString('utf8').slice(0, 2000)}`);
        });
        const ended = () => {
            if (this.child === child) {
                this.child = null;
                this.pending.forEach((resolve) => resolve(null));
                this.pending.clear();
            }
        };
        child.on('error', () => {
            this.failures++;
            ended();
        });
        child.on('exit', (code) => {
            if (code !== 0) {
                this.failures++;
            }
            ended();
        });
        child.stdin.on('error', () => null);
    }

    /**
     * Stop the process (it starts again with the next request).
     */
    stop() {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
        if (this.child) {
            const child = this.child;
            this.child = null;
            this.pending.forEach((resolve) => resolve(null));
            this.pending.clear();
            child.kill('SIGKILL');
        }
    }

    /**
     * Ask the analyzer.
     *
     * @param {Object} request from cleanRequest()
     * @returns {Promise<?Object>} the answer without its id, {busy: true} when too many wait, null on an error or timeout
     */
    async ask(request) {
        if (!this.available()) {
            return null;
        }
        if (this.pending.size >= this.maxPending) {
            return {busy: true};
        }
        if (this.prepare) {
            this.prepared ??= this.prepare().catch(() => false);
            if (!await this.prepared) {
                this.failures = 5;
                return null;
            }
        }
        this.start();
        clearTimeout(this.idleTimer);
        if (this.idleMs > 0) {
            this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
            this.idleTimer.unref?.();
        }
        const id = ++this.next;
        const child = this.child;
        if (!child) {
            return null;
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                resolve(null);
            }, this.timeoutMs);
            this.pending.set(id, (answer) => {
                clearTimeout(timer);
                if (!answer) {
                    resolve(null);
                    return;
                }
                const {id: _id, ...rest} = answer;
                resolve(rest);
            });
            try {
                child.stdin.write(JSON.stringify({id, ...request}) + '\n');
            } catch {
                this.pending.delete(id);
                clearTimeout(timer);
                resolve(null);
            }
        });
    }
}

/**
 * The Java analyzer of this server (built from java-analyzer/ by javac with its first request).
 *
 * @param {Object} [options] as for Analyzer
 * @returns {Analyzer}
 */
export const javaAnalyzer = (options = {}) => {
    const source = options.dll ?? javaSourcePath();
    const analyzer = new Analyzer({name: 'java analyzer', dll: source,
        timeoutMs: Number(process.env.CODELAB_JAVA_ANALYZER_TIMEOUT || 10) * 1000,
        prepare: () => buildJava(source), ...options});
    if (!options.command) {
        analyzer.makeCommand = () => javaCommand(source, analyzer.sandbox);
    }
    return analyzer;
};
