// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * A run without a browser, for grading: Moodle sends the program and its input (POST /run) and gets the whole output,
 * as from Jobe. SQL is shown only as the tables of the mariadb client (--table, without the statements), so that the
 * output of a query can be compared with the expected one.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {createHmac, timingSafeEqual} from 'node:crypto';
import {LANGUAGES, Program, clangAvailable, outOfMemory} from './sandbox.js';
import {SessionDatabase, mysqlConfigured} from './mysql.js';
import {LIMITS} from './session.js';
import {MESSAGES, clientError, logError} from './errors.js';
import {normalizeFiles} from './files.js';
import {normalizeCompileOptions} from './compiler.js';

/** Largest output of a run for grading in bytes, CODELAB_BATCH_OUTPUT_MB (sessions keep CODELAB_MAX_OUTPUT). */
const BATCH_OUTPUT = Number(process.env.CODELAB_BATCH_OUTPUT_MB || 4) * 1024 * 1024;

/** Seconds a signed request stays valid. */
const REQUEST_SECONDS = 60;

/**
 * Whether a request is signed with the secret of its site (header X-CodeLab-Site, or the common secret): header
 * X-CodeLab-Signature is base64url(HMAC-SHA256(secret, X-CodeLab-Time + "
" + X-CodeLab-Nonce + "
" + body)), the time
 * is recent and the nonce was not used before, so a request cannot be sent again. Without X-CodeLab-Nonce (tiny_codelab
 * older than 1.12) the signature is of time + "
" + body; CODELAB_REQUIRE_NONCE=1 refuses such requests.
 *
 * @param {import('./token.js').Secrets|string} secrets
 * @param {Object<string, string>} headers
 * @param {string} body
 * @param {import('./token.js').NonceList} [nonces]
 * @param {number} [now] Unix seconds
 * @returns {boolean}
 */
export const signedRequest = (secrets, headers, body, nonces = null, now = Math.floor(Date.now() / 1000)) => {
    const time = Number(headers['x-codelab-time']);
    if (!Number.isFinite(time) || Math.abs(now - time) > REQUEST_SECONDS) {
        return false;
    }
    const secret = typeof secrets === 'string' ? secrets : secrets.of(headers['x-codelab-site']);
    if (!secret) {
        return false;
    }
    const nonce = headers['x-codelab-nonce'];
    if (nonce === undefined && process.env.CODELAB_REQUIRE_NONCE === '1') {
        return false;
    }
    if (nonce !== undefined && !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
        return false;
    }
    const signed = nonce === undefined ? `${time}
${body}` : `${time}
${nonce}
${body}`;
    const expected = createHmac('sha256', secret).update(signed).digest();
    const given = Buffer.from(String(headers['x-codelab-signature'] || ''), 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return false;
    }
    return nonce === undefined || !nonces || nonces.addRequest(`${headers['x-codelab-site'] || ''}/${nonce}`, now);
};

/**
 * Run a program to its end.
 *
 * @param {Object} request
 * @param {string} request.lang
 * @param {string} request.code
 * @param {string} [request.stdin]
 * @param {number} [request.cputime] CPU seconds, clamped to LIMITS.cpu
 * @param {number} [request.memory] memory limit in MB: the address space, or the heap of Java, C# and JavaScript
 * @param {string} [request.compat] 'jobe' (default): the status, the limits and the interpreters as on Jobe, so that a
 *     program gets the same mark on both servers (see statusOf); 'runner': as before 0.15.0
 * @returns {Promise<{status: string, stdout: string, stderr: string, cmpinfo: string, time?: number}>} status as from Jobe:
 *     ok, compile, runtime, time, memory, toolong, error; time is the wall time of the run in seconds (3 decimals,
 *     without the compilation), only when the program ran and was not SQL
 */
/** Modes of a run for grading. */
export const COMPAT = ['jobe', 'runner'];

/**
 * The status of a program that ran. In the Jobe mode, as Jobe decides: a program that wrote to its standard error
 * failed (runtime), whatever its exit code; one that wrote nothing there succeeded, also with exit(1). A crash (a
 * signal, exit code 128 + signal from bubblewrap) is runtime in both modes, since Jobe's shell then prints the
 * signal's name. In the runner mode the exit code decides, as in sessions.
 *
 * @param {Object} run
 * @param {?number} run.exitcode
 * @param {?string} run.signal signal of the sandbox itself (killed by the server)
 * @param {string} run.stderr
 * @param {boolean} run.toolong
 * @param {boolean} run.wallStop stopped by the server after its time on the clock
 * @param {boolean} run.jobe
 * @returns {string} ok, runtime, time, memory or toolong
 */
export const statusOf = ({exitcode, signal = null, stderr, toolong, wallStop, jobe}) => {
    if (toolong) {
        return 'toolong';
    }
    if (wallStop || exitcode === 152 || exitcode === 137) {
        return 'time';
    }
    const failed = jobe ? stderr !== '' || signal !== null || exitcode === null || exitcode >= 128 : exitcode !== 0;
    if (!failed) {
        return 'ok';
    }
    return outOfMemory(stderr) ? 'memory' : 'runtime';
};

/**
 * The memory limits of a run: the address space in MB, and for Java, C# and JavaScript the heap in MB (their runtimes
 * reserve much more address space than they use). The request's memory, 16 to 2048 MB, is the address space or the
 * heap; without it the language's default, in the Jobe mode Jobe's (400 MB, Python 1500 MB, Java a heap of 200 MB).
 *
 * @param {string} lang
 * @param {number} [memory]
 * @param {boolean} jobe
 * @returns {{mem: number, heap: ?number}}
 */
export const limitsOf = (lang, memory, jobe) => {
    const spec = LANGUAGES[lang];
    const given = Number.isFinite(memory) && memory > 0 ? Math.min(Math.max(16, Math.floor(memory)), 2048) : 0;
    if (spec.heap) {
        const heap = given || (jobe && spec.jobeHeap) || spec.heap;
        // The runtime needs address space beside its heap (code, threads, metaspace).
        return {mem: Math.max(spec.memory, heap * 2 + 2048), heap};
    }
    return {mem: given || (jobe && spec.jobeMemory) || spec.memory, heap: null};
};

export const runBatch = async({lang, code, stdin = '', cputime, memory, files, compiler, std, sanitize, compat}) => {
    const result = {status: 'error', stdout: '', stderr: '', cmpinfo: ''};
    if (compat !== undefined && !COMPAT.includes(compat)) {
        result.stderr = 'Unknown compat mode.';
        return result;
    }
    const jobe = compat !== 'runner';
    if (!Object.hasOwn(LANGUAGES, lang) || typeof code !== 'string' || code === '' || code.length > LIMITS.code) {
        result.stderr = 'Unknown language, or the program is empty or too large.';
        return result;
    }
    if (lang === 'mysql' && !mysqlConfigured()) {
        result.stderr = 'SQL is not set up on this server.';
        return result;
    }
    const checkedFiles = normalizeFiles(files);
    if (!checkedFiles.ok) {
        result.stderr = checkedFiles.error;
        return result;
    }
    const checkedCompile = normalizeCompileOptions(lang, {compiler, std, sanitize});
    if (!checkedCompile.ok) {
        result.stderr = checkedCompile.error;
        return result;
    }
    if (checkedCompile.options?.compiler === 'clang' && !clangAvailable()) {
        result.stderr = 'clang is not installed on this server.';
        return result;
    }
    const program = new Program(lang, code, checkedFiles.files, checkedCompile.options);
    let database = null;
    try {
        const compiled = await program.compile();
        if (!compiled.ok) {
            return {...result, status: 'compile', cmpinfo: compiled.output};
        }
        if (jobe) {
            // Jobe takes any message of the compiler as an error, and checks the syntax of Python and PHP first.
            if (LANGUAGES[lang].strictCompile && compiled.output.trim() !== '') {
                return {...result, status: 'compile', cmpinfo: compiled.output};
            }
            const checked = await program.check();
            if (!checked.ok) {
                return {...result, status: 'compile', cmpinfo: checked.output};
            }
        }
        let extra = {};
        if (lang === 'mysql') {
            database = new SessionDatabase();
            await database.create();
            extra = {...database.client(), batch: true};
        } else {
            await program.prepareWorkDir();
        }
        const cpu = Number.isFinite(cputime) && cputime > 0 ? Math.min(Math.max(1, Math.floor(cputime)), LIMITS.cpu) : LIMITS.cpu;
        const {mem, heap} = limitsOf(lang, memory, jobe);
        const started = process.hrtime.bigint();
        const child = program.start(cpu, {...extra, memory: mem, heap, jobe, measureMemory: lang !== 'mysql'});
        // Output collected as bytes (a letter may be split between chunks), up to the limit of grading: tests of contest
        // problems print hundreds of kilobytes, as Jobe allows.
        const out = [];
        const err = [];
        let size = 0;
        let toolong = false;
        const add = (stream) => (chunk) => {
            size += chunk.length;
            if (size > BATCH_OUTPUT) {
                toolong = true;
                child.kill('SIGKILL');
                return;
            }
            (stream === 'out' ? out : err).push(chunk);
        };
        child.stdout.on('data', add('out'));
        child.stderr.on('data', add('err'));
        child.stdin.on('error', () => undefined);
        child.stdin.end(lang === 'mysql' ? code : stdin);
        // Jobe stops a program after twice its CPU time on the clock (one that sleeps or waits); such a stop is 'time'.
        let wallStop = false;
        const [exitcode, signal, spawnError, ended] = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                wallStop = true;
                child.kill('SIGKILL');
            }, cpu * (jobe ? 2000 : 3000));
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                resolve([code, signal, null, process.hrtime.bigint()]);
            });
            // The sandbox could not start (or the server has no free processes): no close may follow.
            child.on('error', (e) => {
                clearTimeout(timer);
                resolve([null, null, e]);
            });
        });
        if (spawnError) {
            logError('run', spawnError);
            return {...result, stderr: clientError(spawnError, MESSAGES.start)};
        }
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        const status = statusOf({exitcode, signal, stderr, toolong, wallStop, jobe});
        // Wall time of the run itself, the start of the runtime included (JVM, .NET, Python), compilation not. A new
        // optional field: clients that do not know it read the answer as before. SQL has no time (the client, not the
        // program, runs there).
        if (lang === 'mysql') {
            return {status, stdout, stderr, cmpinfo: ''};
        }
        const time = Math.round(Number(ended - started) / 1e6) / 1000;
        const peakMem = await program.peakMemoryKb();
        const outFiles = await program.changedFiles();
        return {
            status, stdout, stderr, cmpinfo: '', time,
            ...(peakMem ? {memory: peakMem} : {}),
            ...(outFiles.length ? {files: outFiles} : {}),
        };
    } catch (e) {
        logError('run', e);
        return {...result, stderr: clientError(e, lang === 'mysql' ? MESSAGES.sql : MESSAGES.internal)};
    } finally {
        await database?.drop();
        await program.dispose();
    }
};
