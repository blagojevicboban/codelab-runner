// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * One interactive session: the client sends the program, the server compiles it, runs it and streams its output while
 * the client sends the input line by line.
 *
 * Client to server (JSON):  {type: 'start', lang, code, stdin, debug, setup}, {type: 'stdin', data}, {type: 'eof'},
 *                           {type: 'stop'}; with debug (C and C++ under gdb, C# under netcoredbg): {type: 'breakpoints',
 *                           lines} at any time,
 *                           and while paused {type: 'step'} (into calls), {type: 'next'} (over calls), {type: 'out'} (out
 *                           of the function), {type: 'continue'} (to the next breakpoint or the end)
 * Server to client (JSON):  {type: 'compiling'}, {type: 'compile', ok: false, output}, {type: 'running'},
 *                           {type: 'out', data}, {type: 'err', data},
 *                           {type: 'paused', line, func, vars: [{name, value}], stack: [{func, line, vars}]}
 *                           (before the line runs; stack: the student's frames, innermost first),
 *                           {type: 'exit', status: ok|runtime|time|memory|toolong|stopped, code, signal}, {type: 'error', message}
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {constants, openSync} from 'node:fs';
import {Socket} from 'node:net';
import {createInterface} from 'node:readline';
import {LANGUAGES, Program, clangAvailable, debuggerAvailable, outOfMemory} from './sandbox.js';
import {parseRecord} from './mi.js';
import {CsValues, methodName} from './csvalues.js';
import {SessionDatabase, mysqlConfigured} from './mysql.js';
import {MESSAGES, clientError, logError, nonEmpty} from './errors.js';
import {normalizeFiles} from './files.js';
import {normalizeCompileOptions} from './compiler.js';

/** Defaults, changed by environment variables. */
export const LIMITS = {
    code: 65536,
    output: Number(process.env.CODELAB_MAX_OUTPUT || 100000),
    cpu: Number(process.env.CODELAB_CPU_SECONDS || 10),
    wall: Number(process.env.CODELAB_WALL_SECONDS || 300),
};

/** Most gdb commands for the memory view at one stop, and most objects reached through pointers. */
const MEMORY_COMMANDS = 150;
const MEMORY_TARGETS = 40;

/** A name gdb can evaluate as it is, and a pointer value of gdb (not a string, not a function). */
const IDENTIFIER = /^[A-Za-z_]\w*$/;
const POINTER = /^0x[0-9a-f]+$/;

/**
 * The pointer fields of a structure value of gdb, at its own level: {data = 1, next = 0x5555...} gives [['next', '0x...']].
 *
 * @param {string} value
 * @returns {Array<[string, string]>}
 */
export const pointerFields = (value) => {
    const text = String(value || '');
    if (!text.startsWith('{')) {
        return [];
    }
    const fields = [];
    let depth = 0;
    let quote = '';
    let start = 1;
    const take = (part) => {
        const match = /^([A-Za-z_]\w*) = (0x[0-9a-f]+)$/.exec(part.trim());
        if (match) {
            fields.push([match[1], match[2]]);
        }
    };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') {
                i++;
            } else if (c === quote) {
                quote = '';
            }
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === '{') {
            depth++;
        } else if (c === '}') {
            depth--;
            if (depth === 0) {
                take(text.slice(start, i));
            }
        } else if (c === ',' && depth === 1) {
            take(text.slice(start, i));
            start = i + 1;
        }
    }
    return fields;
};

/**
 * Whether a value of gdb is a pointer or a structure with a pointer field.
 *
 * @param {string} value
 * @returns {boolean}
 */
const hasPointer = (value) => POINTER.test(value) || pointerFields(value).length > 0;

export class Session {
    /**
     * A session.
     *
     * @param {function(Object): void} send sends a message to the client
     * @param {function(): void} close ends the connection
     * @param {Object} [grant] what the token allows
     * @param {?string} [grant.lang] the only language the session may run (null: any, tokens of older plugins)
     */
    constructor(send, close, {lang = null} = {}) {
        this.send = send;
        this.close = close;
        this.allowedLang = lang;
        this.program = null;
        this.child = null;
        this.state = 'new';
        this.written = 0;
        this.errors = '';
        this.stopped = null;
        this.timer = null;
    }

    /**
     * Handle a message of the client.
     *
     * @param {Object} message
     */
    async handle(message) {
        switch (message?.type) {
            case 'start':
                return this.start(message);
            case 'stdin':
                if (typeof message.data === 'string' && this.input && !this.input.destroyed) {
                    this.input.write(message.data);
                }
                return undefined;
            case 'eof':
                if (this.debug) {
                    // The program sees the end of in.fifo when its last writer, this socket, is closed.
                    this.input?.destroy();
                } else {
                    this.input?.end();
                }
                return undefined;
            case 'step':
            case 'next':
            case 'out':
            case 'continue':
                if (this.debug && this.paused) {
                    this.paused = false;
                    // Out of main there is no caller to go back to: run on.
                    const out = this.depth > 1 ? '-exec-finish' : '-exec-continue';
                    this.gdb({step: '-exec-step', next: '-exec-next', out, continue: '-exec-continue'}[message.type]);
                }
                return undefined;
            case 'breakpoints':
                if (this.debug && Array.isArray(message.lines)) {
                    this.breakpoints = message.lines;
                    if (this.paused) {
                        await this.setBreakpoints();
                    }
                }
                return undefined;
            case 'watches':
                if (this.debug && Array.isArray(message.expressions)) {
                    this.watches = normalizeWatches(message.expressions);
                    if (this.paused) {
                        const values = await this.evaluateWatches(0);
                        this.send({type: 'watches', values});
                    }
                }
                return undefined;
            case 'stop':
                return this.stop('stopped');
            default:
                return this.fail('Unknown message.');
        }
    }

    /**
     * Compile and run a program.
     *
     * @param {Object} message
     * @param {string} message.lang
     * @param {string} message.code
     * @param {string} [message.stdin] input given before the start
     * @param {boolean} [message.debug] step by step under gdb (C and C++)
     * @param {string} [message.setup] SQL run before the code without showing its output (tables and data)
     * @param {boolean} [message.step] with debug: stop before the first line of main (otherwise only at breakpoints)
     * @param {number[]} [message.breakpoints] with debug: lines to stop at
     */
    async start({lang, code, stdin, debug, setup, step = true, breakpoints = [], watches = [], files, compiler, std, sanitize}) {
        this.stepAtStart = step !== false;
        this.breakpoints = Array.isArray(breakpoints) ? breakpoints : [];
        this.watches = normalizeWatches(watches);
        if (this.state !== 'new') {
            return this.fail('The session has a program already.');
        }
        if (!Object.hasOwn(LANGUAGES, lang)) {
            return this.fail('Unknown language.');
        }
        if (this.allowedLang !== null && lang !== this.allowedLang) {
            return this.fail('The token is for another language.');
        }
        if (typeof code !== 'string' || code.length === 0 || code.length > LIMITS.code) {
            return this.fail('The program is empty or too large.');
        }
        if (lang === 'mysql' && !mysqlConfigured()) {
            return this.fail('SQL is not set up on this server.');
        }
        const checkedFiles = normalizeFiles(files);
        if (!checkedFiles.ok) {
            return this.fail(checkedFiles.error);
        }
        const checkedCompile = normalizeCompileOptions(lang, {compiler, std, sanitize});
        if (!checkedCompile.ok) {
            return this.fail(checkedCompile.error);
        }
        if (checkedCompile.options?.compiler === 'clang' && !clangAvailable()) {
            return this.fail('clang is not installed on this server.');
        }
        this.state = 'compiling';
        this.debug = Boolean(debug) && debuggerAvailable(lang);
        // C# under netcoredbg, Java under java-debugger, and JavaScript under node-debugger: the same MI protocol.
        this.dotnet = this.debug && lang === 'csharp';
        this.jdi = this.debug && (lang === 'java' || lang === 'javascript');
        this.program = new Program(lang, code, checkedFiles.files, checkedCompile.options);
        this.send({type: 'compiling'});
        const compiled = await this.program.compile(this.debug);
        if (this.state !== 'compiling') {
            // Stopped or disconnected while compiling.
            return this.dispose();
        }
        if (!compiled.ok) {
            this.send({type: 'compile', ok: false, output: compiled.output});
            await this.dispose();
            this.close();
            return undefined;
        }
        if (lang === 'mysql') {
            return this.startSql(setup);
        }
        await this.program.prepareWorkDir();
        if (this.state !== 'compiling') {
            return this.dispose();
        }
        this.state = 'running';
        this.send({type: 'running'});
        if (this.debug) {
            return this.startDebugger(stdin);
        }
        const child = this.child = this.program.start(LIMITS.cpu);
        child.on('error', (e) => this.spawnFailed(e));
        child.stdin.on('error', () => undefined);
        this.input = child.stdin;
        child.stdout.on('data', this.forwarder('out'));
        child.stderr.on('data', this.forwarder('err'));
        child.on('close', (exitcode, signal) => this.finished(exitcode, signal));
        this.timer = setTimeout(() => this.stop('time'), LIMITS.wall * 1000);
        if (typeof stdin === 'string' && stdin !== '') {
            child.stdin.write(stdin.endsWith('\n') ? stdin : `${stdin}\n`);
        }
        return undefined;
    }

    /**
     * Run SQL in a database of the session: the teacher's setup first (only its errors are shown), then the reader's
     * code, as the mariadb client shows it (tables, Query OK, errors with their line).
     *
     * @param {string} [setup]
     */
    async startSql(setup) {
        this.sql = true;
        this.database = new SessionDatabase();
        try {
            await this.database.create();
        } catch (e) {
            logError('sql', e);
            return this.fail(clientError(e, MESSAGES.sql));
        }
        if (this.state !== 'compiling') {
            return this.dispose();
        }
        this.state = 'running';
        this.send({type: 'running'});
        if (typeof setup === 'string' && setup.trim() !== '') {
            const setupChild = this.child = this.program.start(LIMITS.cpu, this.database.client());
            let errors = '';
            setupChild.stdout.resume();
            setupChild.stderr.on('data', (chunk) => (errors += chunk));
            const code = await new Promise((resolve) => {
                setupChild.on('error', (e) => {
                    this.spawnFailed(e);
                    resolve(null);
                });
                setupChild.on('close', resolve);
                setupChild.stdin.on('error', () => undefined);
                setupChild.stdin.end(setup);
            });
            if (this.state !== 'running') {
                return this.dispose();
            }
            if (code !== 0) {
                this.send({type: 'err', data: `Setup: ${errors}`});
                return this.finished(code, null);
            }
        }
        const child = this.child = this.program.start(LIMITS.cpu, this.database.client());
        child.on('error', (e) => this.spawnFailed(e));
        child.stdout.on('data', this.forwarder('out'));
        child.stderr.on('data', this.forwarder('err'));
        child.on('close', (exitcode, signal) => this.finished(exitcode, signal));
        this.timer = setTimeout(() => this.stop('time'), LIMITS.wall * 1000);
        child.stdin.on('error', () => undefined);
        child.stdin.end(this.program.code);
        return undefined;
    }

    /**
     * A handler that sends the program's output to the client, and stops a program that writes too much.
     *
     * @param {string} type out or err
     * @returns {function(Buffer): void}
     */
    forwarder(type) {
        return (chunk) => {
            this.written += chunk.length;
            if (this.written > LIMITS.output) {
                this.stop('toolong');
                return;
            }
            let data = chunk.toString('utf8');
            if (this.sql && type === 'out') {
                // The mariadb client says goodbye at the end.
                data = data.replace(/(^|\n)Bye\n$/, '$1');
            }
            if (type === 'err' && this.errors.length < 4096) {
                this.errors += data;
            }
            this.send({type, data});
        };
    }

    /**
     * Run the program under gdb: stop at main, then wait for step or continue. The program's input and output go
     * through FIFOs, opened here without blocking so that a program that never starts holds no thread.
     *
     * @param {string} [stdin]
     */
    startDebugger(stdin) {
        // Opened for reading and writing so that opening never blocks; only one direction is used, or this side would
        // read the program's input itself.
        const fifo = (name, input) => new Socket({
            fd: openSync(this.program.path(name), constants.O_RDWR | constants.O_NONBLOCK),
            readable: !input,
            writable: input,
        });
        this.input = fifo('in.fifo', true);
        this.input.on('error', () => undefined);
        this.fifos = [this.input, fifo('out.fifo', false), fifo('err.fifo', false)];
        this.fifos[1].on('data', this.forwarder('out'));
        this.fifos[2].on('data', this.forwarder('err'));
        const child = this.child = this.program.startDebugger(LIMITS.cpu);
        child.on('error', (e) => this.spawnFailed(e));
        child.stdin.on('error', () => undefined);
        child.stderr.resume();
        createInterface({input: child.stdout}).on('line', (line) => this.mi(line));
        child.on('close', (exitcode, signal) => this.finished(exitcode, signal));
        this.timer = setTimeout(() => this.stop('time'), LIMITS.wall * 1000);
        if (this.dotnet || this.jdi) {
            // netcoredbg stops at the entry point by itself (entry-point-hit), java-debugger at main when asked; the
            // breakpoints wait for the classes of the program.
            if (this.jdi && this.stepAtStart) {
                this.gdb('-break-insert -t main');
            }
            this.setBreakpoints().then(() => this.gdb('-exec-run'));
            if (typeof stdin === 'string' && stdin !== '') {
                this.input.write(stdin.endsWith('\n') ? stdin : `${stdin}\n`);
            }
            return;
        }
        this.gdb('-gdb-set disable-randomization off');
        this.gdb('-gdb-set print elements 30');
        this.gdb('-gdb-set print repeats 10');
        if (this.stepAtStart) {
            this.gdb('-break-insert -t main');
        }
        this.setBreakpoints().then(() =>
            this.gdb('-interpreter-exec console "run < /box/in.fifo > /box/out.fifo 2> /box/err.fifo"'));
        if (typeof stdin === 'string' && stdin !== '') {
            this.input.write(stdin.endsWith('\n') ? stdin : `${stdin}\n`);
        }
    }

    /**
     * Send a command to gdb.
     *
     * @param {string} command
     */
    gdb(command) {
        if (this.child && !this.child.stdin.destroyed) {
            this.child.stdin.write(`${command}\n`);
        }
    }

    /**
     * Send a command to gdb and wait for its result record (matched by a token).
     *
     * @param {string} command
     * @returns {Promise<Object>} the record (class done or error)
     */
    command(command) {
        return new Promise((resolve) => {
            this.token = (this.token || 0) + 1;
            this.pending = this.pending || new Map();
            this.pending.set(this.token, resolve);
            this.gdb(`${this.token}${command}`);
        });
    }

    /**
     * Replace gdb's breakpoints with the entries of this.breakpoints (in the student's file).
     * Each entry is either a positive line number or {line, condition}.
     */
    async setBreakpoints() {
        if (this.breakpointIds?.length) {
            await this.command(`-break-delete ${this.breakpointIds.join(' ')}`);
        }
        this.breakpointIds = [];
        const normalized = [];
        for (const item of this.breakpoints.slice(0, 100)) {
            if (Number.isInteger(item) && item > 0) {
                normalized.push({line: item, condition: '', file: ''});
            } else if (item && typeof item === 'object' && Number.isInteger(item.line) && item.line > 0) {
                const raw = typeof item.condition === 'string' ? item.condition.trim().slice(0, 200) : '';
                const condition = /[\r\n\0]/.test(raw) ? '' : raw;
                const rawFile = typeof item.file === 'string' ? item.file.trim() : '';
                const file = /^[A-Za-z0-9_.-]+$/.test(rawFile) && !rawFile.includes('..') ? rawFile : '';
                normalized.push({line: item.line, condition, file});
            }
        }
        for (const bp of normalized) {
            const gdb = !this.dotnet && !this.jdi;
            const target = bp.file && gdb ? `/box/${bp.file}:${bp.line}` : `${bp.file || this.program.file}:${bp.line}`;
            const cmd = bp.condition
                ? `-break-insert -c "${bp.condition.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" ${target}`
                : `-break-insert ${target}`;
            const result = await this.command(cmd);
            if (result.class === 'done' && result.data.bkpt) {
                this.breakpointIds.push(result.data.bkpt.number);
            }
        }
    }

    /**
     * The student's frames, innermost first, each with its variables.
     *
     * @returns {Promise<Array<{func: string, line: number, vars: Array<{name: string, value: string}>}>>}
     */
    async stack() {
        const frames = await this.command('-stack-list-frames 0 30');
        const own = (Array.isArray(frames.data?.stack) ? frames.data.stack : [])
            .filter((f) => isOwnSource(f.fullname || ''));
        const stack = [];
        const values = this.dotnet ? new CsValues((c) => this.command(c), this.thread) : null;
        for (const frame of own) {
            const vars = await this.command(`-stack-list-variables --thread ${this.thread || 1} --frame ${frame.level} --all-values`);
            const file = sourceFileName(frame.fullname || '', this.program?.file);
            const list = (Array.isArray(vars.data?.variables) ? vars.data.variables : [])
                .map((v) => ({name: v.name, value: String(v.value ?? '')}));
            if (values) {
                // C#: the contents of arrays, collections and objects instead of their type.
                for (const v of list) {
                    v.value = await values.variable(v.name, v.value, Number(frame.level));
                }
            }
            stack.push({
                func: this.dotnet ? methodName(frame.func) : frame.func,
                line: Number(frame.line),
                level: Number(frame.level),
                ...(file ? {file} : {}),
                vars: list.map((v) => ({name: v.name, value: v.value.slice(0, 300)})),
            });
        }
        return stack;
    }

    /**
     * Evaluate the active watch expressions in the given frame.
     *
     * @param {number} [level]
     * @returns {Promise<Array<{expr: string, value: ?string}>>}
     */
    async evaluateWatches(level = 0) {
        const out = [];
        const values = this.dotnet ? new CsValues((c) => this.command(c), this.thread, 60) : null;
        for (const expr of this.watches) {
            const escaped = expr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const val = values ? await values.evaluate(expr, level) : await this.evaluate(level, escaped);
            out.push({expr, value: val === null ? null : val.slice(0, 200)});
        }
        return out;
    }

    /**
     * The value of an expression in a frame, or null when gdb cannot evaluate it.
     *
     * @param {number} level
     * @param {string} expression
     * @returns {Promise<?string>}
     */
    async evaluate(level, expression) {
        const result = await this.command(`-data-evaluate-expression --thread ${this.thread || 1} --frame ${level} "${expression}"`);
        return result.class === 'done' && typeof result.data?.value === 'string' ? result.data.value : null;
    }

    /**
     * For the memory view, when the program has pointers: the address and size of each variable (frame.addrs, name:
     * [address, size, element size of an array or 0]) and what the pointers that point outside the variables point to
     * (targets, address in hex: the value of gdb), followed through the pointers of structures (a linked list).
     *
     * @param {Array<{level: number, vars: Array<{name: string, value: string}>}>} stack
     * @returns {Promise<?Object<string, string>>} targets, or null when no variable is a pointer
     */
    async memory(stack) {
        // C# and Java have references, not addresses: no memory view.
        if (this.dotnet || this.jdi || !stack.some((frame) => frame.vars.some((v) => hasPointer(v.value)))) {
            return null;
        }
        let budget = MEMORY_COMMANDS;
        const ranges = [];
        for (const frame of stack) {
            frame.addrs = {};
            for (const {name, value} of frame.vars) {
                if (budget <= 0 || !IDENTIFIER.test(name)) {
                    continue;
                }
                budget -= 2;
                const addr = Number(await this.evaluate(frame.level, `(unsigned long)&${name}`));
                const size = Number(await this.evaluate(frame.level, `sizeof(${name})`));
                if (!Number.isFinite(addr) || !Number.isFinite(size) || addr <= 0) {
                    continue;
                }
                let elem = 0;
                if (/^\{(?![A-Za-z_]\w* = )/.test(value)) {
                    budget--;
                    elem = Number(await this.evaluate(frame.level, `sizeof(${name}[0])`)) || 0;
                }
                frame.addrs[name] = [addr, size, elem];
                ranges.push([addr, addr + size]);
            }
        }
        const inside = (hex) => {
            const addr = Number.parseInt(hex, 16);
            return ranges.some(([from, to]) => addr >= from && addr < to);
        };
        // Pointers to follow: the variables, and the pointer fields of structure variables.
        const queue = [];
        for (const frame of stack) {
            for (const {name, value} of frame.vars) {
                if (!IDENTIFIER.test(name)) {
                    continue;
                }
                if (POINTER.test(value)) {
                    queue.push({level: frame.level, expr: name, hex: value});
                } else {
                    for (const [field, hex] of pointerFields(value)) {
                        queue.push({level: frame.level, expr: `${name}.${field}`, hex});
                    }
                }
            }
        }
        const targets = {};
        while (queue.length && budget > 0 && Object.keys(targets).length < MEMORY_TARGETS) {
            const {level, expr, hex} = queue.shift();
            if (hex === '0x0' || hex in targets || inside(hex)) {
                continue;
            }
            budget--;
            const value = await this.evaluate(level, `*(${expr})`);
            if (value === null) {
                continue;
            }
            targets[hex] = value.slice(0, 300);
            for (const [field, next] of pointerFields(value)) {
                queue.push({level, expr: `(${expr})->${field}`, hex: next});
            }
        }
        return targets;
    }

    /**
     * The stops of netcoredbg and java-debugger that gdb does not have: the entry point of netcoredbg (on to the first
     * statement, or to the first breakpoint for Run), an exception (on, so the runtime prints it and the program ends)
     * and the end with a decimal exit code.
     *
     * @param {Object} data of the *stopped record
     * @returns {boolean} whether the stop was handled here
     */
    otherStop(data) {
        const {reason, frame} = data;
        if (reason === 'entry-point-hit' && this.dotnet) {
            const text = String(this.program?.code || '').split('\n')[Number(frame?.line) - 1] || '';
            if (!this.stepAtStart) {
                this.gdb('-exec-continue');
            } else if (/^\s*\{?\s*$/.test(text)) {
                // The opening brace of Main: the first statement is next.
                this.gdb('-exec-next');
            } else {
                return false;
            }
            return true;
        }
        if (reason === 'exception-received') {
            this.gdb('-exec-continue');
            return true;
        }
        if (reason === 'exited') {
            const code = Number.parseInt(data['exit-code'], 10);
            this.result = {status: code === 0 ? 'ok' : 'runtime', code: Number.isFinite(code) ? code : null, signal: null};
            this.gdb('-gdb-exit');
            return true;
        }
        return false;
    }

    /**
     * Handle a line of gdb: where the program stopped, its variables, its end.
     *
     * @param {string} line
     */
    mi(line) {
        if (process.env.CODELAB_DEBUG_MI) {
            process.stderr.write(`gdb> ${line}\n`);
        }
        const record = parseRecord(line);
        if (!record) {
            return;
        }
        if (record.kind === '^' && record.token !== null && this.pending?.has(record.token)) {
            const resolve = this.pending.get(record.token);
            this.pending.delete(record.token);
            resolve(record);
            return;
        }
        if (record.kind === '*' && record.class === 'stopped') {
            const {reason, frame} = record.data;
            if (record.data['thread-id']) {
                this.thread = record.data['thread-id'];
            }
            if ((this.dotnet || this.jdi) && this.otherStop(record.data)) {
                return;
            }
            if (reason === 'exited-normally' || reason === 'exited' || reason === 'signal-received' ||
                    reason === 'exited-signalled') {
                const signal = record.data['signal-name'] || null;
                this.result = {
                    status: reason === 'exited-normally' ? 'ok' : (signal === 'SIGXCPU' ? 'time' : 'runtime'),
                    code: reason === 'exited' ? parseInt(record.data['exit-code'], 8) : (reason === 'exited-normally' ? 0 : null),
                    signal,
                };
                this.gdb('-gdb-exit');
                return;
            }
            if (!frame || !isOwnSource(frame.fullname || '')) {
                // Step went into a library (printf, scanf...) or past main: back to the caller, then on to the
                // student's next line.
                this.finishing = true;
                this.gdb('-exec-finish');
                return;
            }
            const curFile = sourceFileName(frame.fullname || '', this.program?.file);
            if (this.finishing) {
                this.finishing = false;
                if (Number(frame.line) === this.lastLine && frame.func === this.lastFunc && curFile === this.lastFile) {
                    // Back in the middle of the student's line that called the library: finish that line.
                    this.gdb('-exec-next');
                    return;
                }
            }
            this.lastLine = Number(frame.line);
            this.lastFunc = frame.func;
            this.lastFile = curFile;
            const func = this.dotnet ? methodName(frame.func) : frame.func;
            this.stack().then(async(stack) => {
                this.depth = stack.length;
                const targets = await this.memory(stack);
                const watches = this.watches.length ? await this.evaluateWatches(0) : null;
                const top = stack[0] || {func, line: Number(frame.line), vars: [], ...(curFile ? {file: curFile} : {})};
                this.send({type: 'paused', line: top.line, func: top.func, vars: top.vars, stack,
                    ...(top.file ? {file: top.file} : {}),
                    ...(targets ? {targets} : {}), ...(watches ? {watches} : {})});
                this.paused = true;
            });
        }
    }

    /**
     * The program ended.
     *
     * @param {number|null} code
     * @param {string|null} signal
     */
    async finished(code, signal) {
        if (this.state === 'done') {
            // The session already ended with an error (a program that could not start).
            return;
        }
        clearTimeout(this.timer);
        let status = this.stopped;
        if (!status && this.result) {
            ({status, code, signal} = this.result);
        } else if (!status) {
            // bubblewrap passes on the end of the program by a signal as 128 + the signal: SIGXCPU (24) or the SIGKILL
            // (9) of the hard CPU limit.
            if (code === 152 || code === 137) {
                status = 'time';
            } else if (outOfMemory(this.errors)) {
                status = 'memory';
            } else if (code === 0) {
                status = 'ok';
            } else {
                status = 'runtime';
            }
        }
        this.state = 'done';
        const files = this.program ? await this.program.changedFiles() : [];
        if (files.length) {
            this.send({type: 'files', files});
        }
        const leaks = status === 'ok' && this.debug && this.program ? await this.program.readLeaks() : [];
        this.send({type: 'exit', status, code, signal, ...(leaks.length ? {leaks} : {})});
        await this.dispose();
        this.close();
    }

    /**
     * Stop the program.
     *
     * @param {string} reason stopped, time or toolong
     */
    async stop(reason) {
        if (this.state === 'running' && this.child) {
            this.stopped = this.stopped || reason;
            this.child.kill('SIGKILL');
        } else if (this.state === 'compiling') {
            this.state = 'done';
            this.send({type: 'exit', status: reason, code: null, signal: null});
            this.close();
        }
    }

    /**
     * A program (or gdb, or the SQL client) could not be started: the sandbox could not start, or the server has no free
     * processes. The client gets a short text, the log the details.
     *
     * @param {Error} error
     */
    async spawnFailed(error) {
        logError('start', error);
        if (this.state !== 'done') {
            await this.fail(clientError(error, MESSAGES.start));
        }
    }

    /**
     * Tell the client about an error and end the session. The message is never empty.
     *
     * @param {string} message
     */
    async fail(message) {
        this.state = 'done';
        this.send({type: 'error', message: nonEmpty(message)});
        await this.dispose();
        this.close();
    }

    /**
     * Remove the program; called also when the client goes away.
     */
    async dispose() {
        clearTimeout(this.timer);
        if (this.database) {
            const database = this.database;
            this.database = null;
            await database.drop();
        }
        for (const socket of this.fifos || []) {
            socket.destroy();
        }
        this.fifos = null;
        if (this.state === 'compiling') {
            this.state = 'done';
        }
        if (this.program) {
            const program = this.program;
            this.program = null;
            await program.dispose();
        }
    }
}

const MAX_WATCHES = 20;

const INTERNAL_SOURCES = new Set(['codelab_leaks.c', 'codelab_unbuffered.c']);

/**
 * Whether a gdb frame's fullname belongs to the student's main file or a companion C/C++ source/header file.
 *
 * @param {string} fullname
 * @returns {boolean}
 */
const isOwnSource = (fullname) => {
    const m = /^\/box\/([A-Za-z0-9_.-]+\.(?:c|cpp|cc|cxx|h|hpp|hh|cs|java|js))$/.exec(fullname || '');
    return !!m && !INTERNAL_SOURCES.has(m[1]);
};

/**
 * Companion file name for a gdb fullname, or null for the main file (prog.c, prog.cpp, prog.cs, Main.java).
 *
 * @param {string} fullname
 * @param {string} [main] the main file of the program
 * @returns {?string}
 */
const sourceFileName = (fullname, main = '') => {
    const m = /^\/box\/([A-Za-z0-9_.-]+)$/.exec(fullname || '');
    if (!m || m[1] === main || /^prog\.(?:c|cpp|cs)$/.test(m[1])) {
        return null;
    }
    return m[1];
};

/**
 * Sanitize a list of watch expressions (strings, max 200 chars, no control chars).
 *
 * @param {unknown} list
 * @returns {string[]}
 */
const normalizeWatches = (list) => (Array.isArray(list) ? list : [])
    .filter((e) => typeof e === 'string')
    .map((e) => e.trim().slice(0, 200))
    .filter((e) => e.length > 0 && !/[\r\n\0]/.test(e))
    .slice(0, MAX_WATCHES);
