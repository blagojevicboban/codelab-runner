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
 *                           {type: 'stop'}; with debug (C and C++, under gdb): {type: 'breakpoints', lines} at any time,
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
import {DEBUG_LANGUAGES, LANGUAGES, Program} from './sandbox.js';
import {parseRecord} from './mi.js';
import {SessionDatabase, mysqlConfigured} from './mysql.js';

/** Defaults, changed by environment variables. */
export const LIMITS = {
    code: 65536,
    output: Number(process.env.CODELAB_MAX_OUTPUT || 100000),
    cpu: Number(process.env.CODELAB_CPU_SECONDS || 10),
    wall: Number(process.env.CODELAB_WALL_SECONDS || 300),
};

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
    async start({lang, code, stdin, debug, setup, step = true, breakpoints = []}) {
        this.stepAtStart = step !== false;
        this.breakpoints = Array.isArray(breakpoints) ? breakpoints : [];
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
        this.state = 'compiling';
        this.debug = Boolean(debug) && DEBUG_LANGUAGES.includes(lang);
        this.program = new Program(lang, code);
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
        this.state = 'running';
        this.send({type: 'running'});
        if (this.debug) {
            return this.startDebugger(stdin);
        }
        const child = this.child = this.program.start(LIMITS.cpu);
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
            return this.fail(e.message);
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
        child.stdin.on('error', () => undefined);
        child.stderr.resume();
        createInterface({input: child.stdout}).on('line', (line) => this.mi(line));
        child.on('close', (exitcode, signal) => this.finished(exitcode, signal));
        this.timer = setTimeout(() => this.stop('time'), LIMITS.wall * 1000);
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
     * Replace gdb's breakpoints with the lines of this.breakpoints (in the student's file).
     */
    async setBreakpoints() {
        if (this.breakpointIds?.length) {
            await this.command(`-break-delete ${this.breakpointIds.join(' ')}`);
        }
        this.breakpointIds = [];
        for (const line of this.breakpoints.filter((l) => Number.isInteger(l) && l > 0).slice(0, 100)) {
            const result = await this.command(`-break-insert ${this.program.file}:${line}`);
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
            .filter((f) => /^\/box\/prog\.(c|cpp)$/.test(f.fullname || ''));
        const stack = [];
        for (const frame of own) {
            const vars = await this.command(`-stack-list-variables --thread 1 --frame ${frame.level} --all-values`);
            stack.push({
                func: frame.func,
                line: Number(frame.line),
                vars: (Array.isArray(vars.data?.variables) ? vars.data.variables : [])
                    .map((v) => ({name: v.name, value: String(v.value ?? '').slice(0, 300)})),
            });
        }
        return stack;
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
            if (!frame || !/^\/box\/prog\.(c|cpp)$/.test(frame.fullname || '')) {
                // Step went into a library (printf, scanf...) or past main: back to the caller, then on to the
                // student's next line.
                this.finishing = true;
                this.gdb('-exec-finish');
                return;
            }
            if (this.finishing) {
                this.finishing = false;
                if (Number(frame.line) === this.lastLine && frame.func === this.lastFunc) {
                    // Back in the middle of the student's line that called the library: finish that line.
                    this.gdb('-exec-next');
                    return;
                }
            }
            this.lastLine = Number(frame.line);
            this.lastFunc = frame.func;
            this.stack().then((stack) => {
                this.depth = stack.length;
                const top = stack[0] || {func: frame.func, line: Number(frame.line), vars: []};
                this.send({type: 'paused', line: top.line, func: top.func, vars: top.vars, stack});
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
        clearTimeout(this.timer);
        let status = this.stopped;
        if (!status && this.result) {
            ({status, code, signal} = this.result);
        } else if (!status) {
            // bubblewrap passes on the end of the program by a signal as 128 + the signal: SIGXCPU (24) or the SIGKILL
            // (9) of the hard CPU limit.
            if (code === 152 || code === 137) {
                status = 'time';
            } else if (/OutOfMemoryError|OutOfMemoryException|std::bad_alloc/.test(this.errors)) {
                status = 'memory';
            } else if (code === 0) {
                status = 'ok';
            } else {
                status = 'runtime';
            }
        }
        this.state = 'done';
        this.send({type: 'exit', status, code, signal});
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
     * Tell the client about an error and end the session.
     *
     * @param {string} message
     */
    async fail(message) {
        this.send({type: 'error', message});
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
