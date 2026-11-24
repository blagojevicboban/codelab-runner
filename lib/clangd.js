// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * The language service of C and C++: one clangd process for all readers of the server, spoken to over the Language
 * Server Protocol, answering with the same requests and answers as the C# and Java services (lib/analysis.js).
 *
 * clangd keeps the parsed headers of a file (its preamble) as long as the file is open, so the programs are not opened
 * anew with every request: a slot is a folder with an open file prog.c or prog.cpp and the flags of one language,
 * standard and compiler profile (compile_flags.txt). A request takes a free slot of its flags, or a new one, or the slot
 * used longest ago; the requests of a slot wait for each other. The other files of the example (headers) are written
 * into the folder of the slot. The folders are read-only in the sandbox of clangd, which has no network and no files of
 * the server.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {sandboxed} from './analysis.js';
import {normalizeCompileOptions} from './compiler.js';

/** The folder of the Visual Studio compatibility headers (as when compiling with the msvc profile). */
const MSVC_DIR = fileURLToPath(new URL('./msvc', import.meta.url));

/** The kinds of completion items of LSP, by number, as names of Monaco's CompletionItemKind. */
const KINDS = [null, 'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module',
    'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember',
    'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];

/** The configuration of clangd in the folder of the slots: no hints about includes, which only confuse beginners. */
const CONFIG = 'Diagnostics:\n  UnusedIncludes: None\n  MissingIncludes: None\n';

let found = null;

/**
 * The clangd program: CODELAB_CLANGD (a path, or 'off'), else clangd or clangd-18 on the PATH.
 *
 * @returns {string} '' when there is none
 */
export const clangdPath = () => {
    const setting = process.env.CODELAB_CLANGD ?? '';
    if (setting === 'off') {
        return '';
    }
    if (setting) {
        return setting;
    }
    found ??= ['clangd', 'clangd-18', 'clangd-19', 'clangd-17']
        .find((name) => spawnSync(name, ['--version'], {stdio: 'ignore'}).status === 0) ?? '';
    return found;
};

/**
 * Whether bubblewrap is there.
 *
 * @returns {boolean}
 */
const bwrapAvailable = () => spawnSync('bwrap', ['--version'], {stdio: 'ignore'}).status === 0;

/**
 * The flags of a slot: those of the compiler of the runner (lib/sandbox.js), without -w, so that clangd shows the
 * warnings clang gives by default (wrong printf formats, = in a condition).
 *
 * @param {string} lang c or cpp
 * @param {{compiler: string, std: string}} options
 * @param {string} dir the folder of the slot (for #include "...")
 * @returns {string[]}
 */
export const flagsOf = (lang, {compiler, std}, dir) => [
    lang === 'c' ? '-xc' : '-xc++',
    `-std=${std}`,
    ...(lang === 'c' ? ['-D_GNU_SOURCE'] : []),
    ...(compiler === 'msvc' ? ['-I', MSVC_DIR, '-include', join(MSVC_DIR, 'codelab_msvc.h')] : []),
    '-I', dir,
];

/**
 * A text of LSP (a string or MarkupContent) as a string.
 *
 * @param {*} value
 * @returns {string}
 */
const textOf = (value) => (typeof value === 'string' ? value : typeof value?.value === 'string' ? value.value : '');

/**
 * The name of a completion item (clangd puts a space or a dot for an include before it, and the parameters after it).
 *
 * @param {Object} item
 * @returns {string}
 */
const nameOf = (item) => (item.textEdit?.newText ?? item.insertText ?? item.filterText ?? item.label ?? '').trim();

/**
 * A slot: a folder with an open program and the flags of one language, standard and compiler.
 *
 * @typedef {Object} Slot
 * @property {string} key lang:compiler:std
 * @property {string} dir
 * @property {string} uri of the program
 * @property {string} name prog.c or prog.cpp
 * @property {boolean} open
 * @property {number} version
 * @property {string} text the program clangd has
 * @property {string} files hash of the other files
 * @property {string[]} written names of the other files in the folder
 * @property {Promise<*>} chain the requests of the slot, one after another
 * @property {number} waiting requests in the chain
 * @property {number} used time of the last request
 */

/**
 * The C and C++ language service: the same interface as Analyzer of lib/analysis.js (available, ask, stop).
 */
export class ClangdService {
    /**
     * @param {Object} [options]
     * @param {string} [options.clangd] the program (default clangdPath())
     * @param {boolean} [options.sandbox] start it in bubblewrap (default: when bwrap is there and CODELAB_CLANGD_SANDBOX is not 0)
     * @param {number} [options.timeoutMs] longest wait for an answer
     * @param {number} [options.idleMs] stop the process after this long without requests (0: never)
     * @param {number} [options.slots] most open programs (each keeps its parsed headers in memory)
     * @param {number} [options.maxPending] requests that may wait at once; more are answered busy
     * @param {string} [options.root] folder of the slots (default: a new one in the temporary folder)
     */
    constructor({clangd, sandbox, timeoutMs, idleMs, slots, maxPending, root} = {}) {
        this.clangd = clangd ?? clangdPath();
        this.name = 'clangd';
        this.sandbox = sandbox ?? (process.env.CODELAB_CLANGD_SANDBOX !== '0' && bwrapAvailable());
        this.timeoutMs = timeoutMs ?? Number(process.env.CODELAB_CLANGD_TIMEOUT || 10) * 1000;
        this.idleMs = idleMs ?? Number(process.env.CODELAB_CLANGD_IDLE_MIN ?? 30) * 60000;
        this.maxSlots = slots ?? Number(process.env.CODELAB_CLANGD_SLOTS || 6);
        this.maxPending = maxPending ?? Number(process.env.CODELAB_CLANGD_PENDING || 64);
        this.root = root ?? join(process.env.CODELAB_TMP || tmpdir(), `codelab-clangd-${process.pid}`);
        /** @type {?import('node:child_process').ChildProcess} */
        this.child = null;
        /** @type {?Promise<boolean>} */
        this.ready = null;
        /** @type {Slot[]} */
        this.slots = [];
        this.made = 0;
        this.next = 0;
        /** @type {Map<number, function(?Object): void>} answers of clangd by id */
        this.calls = new Map();
        /** @type {Map<string, {version: number, items: Object[]}>} the last errors by file */
        this.published = new Map();
        /** @type {Set<function(): void>} who waits for errors */
        this.watchers = new Set();
        this.pending = 0;
        this.failures = 0;
        this.idleTimer = null;
    }

    /**
     * Whether the service can be used on this server.
     *
     * @returns {boolean}
     */
    available() {
        return this.clangd !== '' && this.failures < 5;
    }

    /**
     * Start clangd and initialize it, when it is not running.
     *
     * @returns {Promise<boolean>}
     */
    start() {
        if (this.ready) {
            return this.ready;
        }
        mkdirSync(this.root, {recursive: true});
        writeFileSync(join(this.root, '.clangd'), CONFIG);
        if (!this.cleanup) {
            this.cleanup = () => rmSync(this.root, {recursive: true, force: true});
            process.once('exit', this.cleanup);
        }
        const args = ['--log=error', '--background-index=false', '--clang-tidy=false', '--header-insertion=never',
            '--completion-style=detailed', '--all-scopes-completion=false', '--pch-storage=memory',
            '--limit-results=500', '--function-arg-placeholders=false', '--completion-parse=always', '-j=2'];
        const {command, env} = sandboxed([this.clangd, ...args], [this.root, MSVC_DIR],
            {HOME: '/tmp', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}, this.sandbox);
        const child = spawn(command[0], command.slice(1), {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: Object.keys(env).length ? env : process.env,
        });
        this.child = child;
        let buffer = Buffer.alloc(0);
        child.stdout.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                const end = buffer.indexOf('\r\n\r\n');
                if (end < 0) {
                    return;
                }
                const length = Number(/Content-Length: *(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))?.[1]);
                if (!Number.isFinite(length) || buffer.length < end + 4 + length) {
                    return;
                }
                const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8');
                buffer = buffer.subarray(end + 4 + length);
                let message;
                try {
                    message = JSON.parse(body);
                } catch {
                    continue;
                }
                this.received(message);
            }
        });
        child.stderr.on('data', (chunk) => {
            process.stderr.write(`[clangd] ${chunk.toString('utf8').slice(0, 2000)}`);
        });
        const ended = () => {
            if (this.child === child) {
                this.child = null;
                this.ready = null;
                this.calls.forEach((resolve) => resolve(null));
                this.calls.clear();
                this.published.clear();
                this.slots.forEach((slot) => {
                    slot.open = false;
                });
                this.watchers.forEach((wake) => wake());
            }
        };
        child.on('error', () => {
            this.failures++;
            ended();
        });
        child.on('exit', (code, signal) => {
            if (code !== 0 && signal !== 'SIGKILL') {
                this.failures++;
            }
            ended();
        });
        child.stdin.on('error', () => null);
        this.ready = (async() => {
            const answer = await this.call('initialize', {
                processId: null,
                rootUri: pathToFileURL(this.root).href,
                capabilities: {
                    textDocument: {
                        completion: {completionItem: {snippetSupport: false, documentationFormat: ['plaintext']}},
                        hover: {contentFormat: ['markdown']},
                        signatureHelp: {signatureInformation: {documentationFormat: ['plaintext'],
                            parameterInformation: {labelOffsetSupport: false}}},
                        publishDiagnostics: {versionSupport: true},
                    },
                },
            }, 30000);
            if (!answer?.result) {
                return false;
            }
            this.notify('initialized', {});
            return true;
        })();
        return this.ready;
    }

    /**
     * A message of clangd: an answer, the errors of a file, or a request to the client (answered with null).
     *
     * @param {Object} message
     */
    received(message) {
        if (message.id !== undefined && message.method === undefined) {
            const resolve = this.calls.get(message.id);
            if (resolve) {
                this.calls.delete(message.id);
                resolve(message);
            }
            return;
        }
        if (message.method === 'textDocument/publishDiagnostics') {
            this.published.set(message.params.uri, {version: message.params.version ?? -1,
                items: message.params.diagnostics || []});
            this.watchers.forEach((wake) => wake());
            return;
        }
        if (message.id !== undefined) {
            this.send({jsonrpc: '2.0', id: message.id, result: null});
        }
    }

    /**
     * Send a message to clangd.
     *
     * @param {Object} message
     */
    send(message) {
        const body = Buffer.from(JSON.stringify(message), 'utf8');
        try {
            this.child?.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
        } catch {
            // The process has ended; its exit handler cleans up.
        }
    }

    /**
     * Send a notification.
     *
     * @param {string} method
     * @param {Object} params
     */
    notify(method, params) {
        this.send({jsonrpc: '2.0', method, params});
    }

    /**
     * Send a request and wait for its answer.
     *
     * @param {string} method
     * @param {Object} params
     * @param {number} [timeoutMs]
     * @returns {Promise<?Object>} the answer, null on a timeout or when clangd ended
     */
    call(method, params, timeoutMs = this.timeoutMs) {
        if (!this.child) {
            return Promise.resolve(null);
        }
        const id = ++this.next;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.calls.delete(id);
                this.notify('$/cancelRequest', {id});
                resolve(null);
            }, timeoutMs);
            this.calls.set(id, (answer) => {
                clearTimeout(timer);
                resolve(answer);
            });
            this.send({jsonrpc: '2.0', id, method, params});
        });
    }

    /**
     * Wait for the errors of a version of a file.
     *
     * @param {string} uri
     * @param {number} version
     * @returns {Promise<?Object[]>}
     */
    diagnosticsOf(uri, version) {
        return new Promise((resolve) => {
            const check = () => {
                const last = this.published.get(uri);
                if (last && last.version >= version) {
                    done(last.items);
                } else if (!this.child) {
                    done(null);
                }
            };
            const timer = setTimeout(() => done(null), this.timeoutMs);
            const done = (items) => {
                clearTimeout(timer);
                this.watchers.delete(check);
                resolve(items);
            };
            this.watchers.add(check);
            check();
        });
    }

    /**
     * Stop clangd (it starts again with the next request).
     */
    stop() {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
        const child = this.child;
        if (child) {
            child.kill('SIGKILL');
        }
        rmSync(this.root, {recursive: true, force: true});
        this.slots = [];
    }

    /**
     * A new folder for a slot.
     *
     * @param {Slot} slot
     * @param {string} key
     * @param {string} lang
     * @param {Object} options compiler and std
     */
    prepare(slot, key, lang, options) {
        if (slot.dir) {
            if (slot.open) {
                this.notify('textDocument/didClose', {textDocument: {uri: slot.uri}});
            }
            this.published.delete(slot.uri);
            rmSync(slot.dir, {recursive: true, force: true});
        }
        slot.key = key;
        slot.dir = join(this.root, `s${++this.made}`);
        slot.name = lang === 'c' ? 'prog.c' : 'prog.cpp';
        slot.uri = pathToFileURL(join(slot.dir, slot.name)).href;
        slot.open = false;
        slot.text = '';
        slot.files = '';
        slot.written = [];
        mkdirSync(slot.dir, {recursive: true});
        writeFileSync(join(slot.dir, 'compile_flags.txt'), flagsOf(lang, options, slot.dir).join('\n') + '\n');
    }

    /**
     * The slot for a request with these flags.
     *
     * @param {string} key
     * @returns {Slot}
     */
    pick(key) {
        const free = this.slots.filter((s) => s.waiting === 0);
        const same = free.find((s) => s.key === key);
        if (same) {
            return same;
        }
        if (this.slots.length < this.maxSlots) {
            const slot = {key: '', dir: '', uri: '', name: '', open: false, version: 0, text: '', files: '', written: [],
                chain: Promise.resolve(), waiting: 0, used: 0};
            this.slots.push(slot);
            return slot;
        }
        const byUse = (a, b) => a.waiting - b.waiting || a.used - b.used;
        return free.sort(byUse)[0] ?? this.slots.filter((s) => s.key === key).sort(byUse)[0] ?? [...this.slots].sort(byUse)[0];
    }

    /**
     * Bring the program and the other files of a request into its slot.
     *
     * @param {Slot} slot
     * @param {Object} request
     */
    load(slot, request) {
        const main = request.files.filter((f) => f.name !== slot.name && /\.(?:c|h|cpp|cc|cxx|hpp|hh)$/i.test(f.name));
        const files = createHash('sha256').update(JSON.stringify(main)).digest('hex');
        if (files !== slot.files) {
            for (const name of slot.written) {
                try {
                    unlinkSync(join(slot.dir, name));
                } catch {
                    // Already gone.
                }
            }
            main.forEach((f) => writeFileSync(join(slot.dir, f.name), f.code));
            slot.written = main.map((f) => f.name);
            slot.files = files;
            // clangd reads the headers again when the program is opened again.
            if (slot.open) {
                this.notify('textDocument/didClose', {textDocument: {uri: slot.uri}});
                slot.open = false;
            }
        }
        if (!slot.open) {
            slot.version++;
            slot.text = request.code;
            slot.open = true;
            this.notify('textDocument/didOpen', {textDocument: {uri: slot.uri, languageId: slot.name.endsWith('.c') ? 'c' : 'cpp',
                version: slot.version, text: request.code}});
        } else if (slot.text !== request.code) {
            slot.version++;
            slot.text = request.code;
            this.notify('textDocument/didChange', {textDocument: {uri: slot.uri, version: slot.version},
                contentChanges: [{text: request.code}]});
        }
    }

    /**
     * Ask the service.
     *
     * @param {Object} request from cleanRequest() of lib/analysis.js
     * @param {string} lang c or cpp
     * @returns {Promise<?Object>} the answer, {busy: true} when too many wait, null on an error or timeout
     */
    async ask(request, lang) {
        if (!this.available() || (lang !== 'c' && lang !== 'cpp')) {
            return null;
        }
        const normal = normalizeCompileOptions(lang, {compiler: request.compiler || undefined, std: request.std || undefined});
        if (!normal.ok) {
            return {error: 'request'};
        }
        if (this.pending >= this.maxPending) {
            return {busy: true};
        }
        clearTimeout(this.idleTimer);
        if (this.idleMs > 0) {
            this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
            this.idleTimer.unref?.();
        }
        const key = `${lang}:${normal.options.compiler}:${normal.options.std}`;
        const slot = this.pick(key);
        this.pending++;
        slot.waiting++;
        const work = slot.chain.then(async() => {
            if (!await this.start()) {
                return null;
            }
            if (slot.key !== key) {
                this.prepare(slot, key, lang, normal.options);
            }
            slot.used = Date.now();
            this.load(slot, request);
            return this.answer(slot, request);
        }).catch((e) => {
            process.stderr.write(`[clangd] ${e?.stack || e}\n`);
            return null;
        });
        slot.chain = work.finally(() => {
            slot.waiting--;
            this.pending--;
        });
        return work;
    }

    /**
     * The answer to a request whose program is in its slot.
     *
     * @param {Slot} slot
     * @param {Object} request
     * @returns {Promise<?Object>}
     */
    async answer(slot, request) {
        const position = {line: Math.max(request.line - 1, 0), character: Math.max(request.column - 1, 0)};
        const at = {textDocument: {uri: slot.uri}, position};
        switch (request.op) {
            case 'complete':
            case 'describe': {
                const answer = await this.call('textDocument/completion', at);
                if (!answer) {
                    return null;
                }
                const items = Array.isArray(answer.result) ? answer.result : answer.result?.items ?? [];
                return request.op === 'complete' ? completions(items) : description(items, request.item);
            }
            case 'signatures': {
                const answer = await this.call('textDocument/signatureHelp', at);
                return answer ? signatureHelp(answer.result) : null;
            }
            case 'hover': {
                const answer = await this.call('textDocument/hover', at);
                return answer ? hoverOf(answer.result) : null;
            }
            case 'diagnostics': {
                const items = await this.diagnosticsOf(slot.uri, slot.version);
                return items ? {items: diagnosticsOf(items, slot.name, slot.dir), main: slot.name} : null;
            }
            default:
                return {error: 'request'};
        }
    }
}

/**
 * The completions of clangd as those of the other services: one item per name (overloads together).
 *
 * @param {Object[]} items
 * @returns {{items: Object[]}}
 */
export const completions = (items) => {
    const byName = new Map();
    for (const item of items) {
        const name = nameOf(item);
        if (!name || byName.has(name)) {
            if (name) {
                byName.get(name).overloads++;
            }
            continue;
        }
        byName.set(name, {item, overloads: 0});
    }
    return {items: [...byName.entries()].slice(0, 3000).map(([name, {item, overloads}]) => ({
        label: name,
        insert: name,
        kind: KINDS[item.kind] || 'Text',
        filter: name,
        sort: item.sortText || name,
        detail: detailOf(item) + (overloads ? `  (+${overloads} overload${overloads > 1 ? 's' : ''})` : ''),
    }))};
};

/**
 * The declaration of a completion item: the type and the parameters of a function, the type of a variable.
 *
 * @param {Object} item
 * @returns {string}
 */
const detailOf = (item) => {
    const label = String(item.label || '').replace(/^[\s•]+/, '');
    const type = String(item.detail || '');
    return [2, 3, 4].includes(item.kind) ? `${type} ${label}`.trim() : type;
};

/**
 * The description of one completion, by its label.
 *
 * @param {Object[]} items
 * @param {string} label
 * @returns {{text: string, doc: string}}
 */
export const description = (items, label) => {
    const same = items.filter((i) => nameOf(i) === label);
    if (!same.length) {
        return {text: '', doc: ''};
    }
    const more = same.length - 1;
    return {text: detailOf(same[0]) + (more ? `  (+${more} overload${more > 1 ? 's' : ''})` : ''),
        doc: textOf(same[0].documentation)};
};

/**
 * The signatures of a call as those of the other services.
 *
 * @param {?Object} help
 * @returns {{signatures: Object[], active: number, parameter: number}}
 */
export const signatureHelp = (help) => {
    const signatures = (help?.signatures || []).map((s) => ({
        label: String(s.label || ''),
        doc: textOf(s.documentation),
        parameters: (s.parameters || []).map((p) => ({
            label: Array.isArray(p.label) ? String(s.label).slice(p.label[0], p.label[1]) : String(p.label || ''),
            doc: textOf(p.documentation),
        })),
    }));
    return {signatures, active: help?.activeSignature ?? 0, parameter: help?.activeParameter ?? 0};
};

/**
 * The tooltip of clangd (markdown) with its range, 1-based.
 *
 * @param {?Object} hover
 * @returns {Object}
 */
export const hoverOf = (hover) => {
    const text = textOf(hover?.contents).trim();
    if (!text || !hover.range) {
        return {markdown: []};
    }
    return {markdown: [text], line: hover.range.start.line + 1, column: hover.range.start.character + 1,
        endLine: hover.range.end.line + 1, endColumn: hover.range.end.character + 1};
};

/**
 * The errors and warnings of clangd as those of the other services.
 *
 * @param {Object[]} items
 * @param {string} file the name of the program
 * @param {string} [dir] the folder of the slot, removed from the messages (no paths of the server for the reader)
 * @returns {Object[]}
 */
export const diagnosticsOf = (items, file, dir = '') => items.filter((d) => d.severity === 1 || d.severity === 2).slice(0, 200)
    .map((d) => ({
        file,
        severity: d.severity === 1 ? 'error' : 'warning',
        code: d.code === undefined || d.code === null ? '' : String(d.code),
        message: dir ? String(d.message || '').split(`${dir}/`).join('') : String(d.message || ''),
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        endLine: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
    }));
