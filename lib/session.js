// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * One interactive session: the client sends the program, the server compiles it, runs it and streams its output while
 * the client sends the input line by line.
 *
 * Client to server (JSON):  {type: 'start', lang, code, stdin}, {type: 'stdin', data}, {type: 'eof'}, {type: 'stop'}
 * Server to client (JSON):  {type: 'compiling'}, {type: 'compile', ok: false, output}, {type: 'running'},
 *                           {type: 'out', data}, {type: 'err', data},
 *                           {type: 'exit', status: ok|runtime|time|memory|toolong|stopped, code, signal}, {type: 'error', message}
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {LANGUAGES, Program} from './sandbox.js';

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
     */
    constructor(send, close) {
        this.send = send;
        this.close = close;
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
                if (this.child && typeof message.data === 'string' && !this.child.stdin.destroyed) {
                    this.child.stdin.write(message.data);
                }
                return undefined;
            case 'eof':
                this.child?.stdin.end();
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
     */
    async start({lang, code, stdin}) {
        if (this.state !== 'new') {
            return this.fail('The session has a program already.');
        }
        if (!Object.hasOwn(LANGUAGES, lang)) {
            return this.fail('Unknown language.');
        }
        if (typeof code !== 'string' || code.length === 0 || code.length > LIMITS.code) {
            return this.fail('The program is empty or too large.');
        }
        this.state = 'compiling';
        this.program = new Program(lang, code);
        this.send({type: 'compiling'});
        const compiled = await this.program.compile();
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
        this.state = 'running';
        this.send({type: 'running'});
        const child = this.child = this.program.start(LIMITS.cpu);
        child.stdin.on('error', () => undefined);
        const forward = (type) => (chunk) => {
            this.written += chunk.length;
            if (this.written > LIMITS.output) {
                this.stop('toolong');
                return;
            }
            const data = chunk.toString('utf8');
            if (type === 'err' && this.errors.length < 4096) {
                this.errors += data;
            }
            this.send({type, data});
        };
        child.stdout.on('data', forward('out'));
        child.stderr.on('data', forward('err'));
        child.on('close', (exitcode, signal) => this.finished(exitcode, signal));
        this.timer = setTimeout(() => this.stop('time'), LIMITS.wall * 1000);
        if (typeof stdin === 'string' && stdin !== '') {
            child.stdin.write(stdin.endsWith('\n') ? stdin : `${stdin}\n`);
        }
        return undefined;
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
        if (!status) {
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
