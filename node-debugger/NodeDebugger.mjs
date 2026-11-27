// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Step for JavaScript (Node.js) in the CodeLab runner: launches the student's script with --inspect-brk=127.0.0.1:0,
 * connects over Chrome DevTools Protocol (CDP), and speaks the gdb/MI subset that lib/session.js uses.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {spawn} from 'node:child_process';
import {createReadStream, createWriteStream} from 'node:fs';
import {basename, join} from 'node:path';
import {createInterface} from 'node:readline';

const scriptPath = process.argv[2];
const boxDir = process.argv[3] || '/box';
const heapMb = Number(process.argv[4] || 256);

if (!scriptPath) {
    process.stderr.write('usage: NodeDebugger.mjs /box/prog.js [/box] [heapMb]\n');
    process.exit(2);
}

const INSPECTOR_NOISE = /^(?:Debugger listening on |For help, see: https:\/\/nodejs\.org\/|Debugger attached\.|Waiting for the debugger to disconnect\.\.\.)/;

const miQuote = (s) => '"' + String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + '"';

const emit = (line) => process.stdout.write(`${line}\n`);

let ws = null;
let cdpId = 1;
const pending = new Map();
const scripts = new Map();
const breakpoints = new Map();
let nextBp = 1;
let stopAtMain = false;
let runRequested = false;
let initialPause = null;
let callFrames = [];
let ended = false;

const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) {
        reject(new Error('inspector closed'));
        return;
    }
    const id = cdpId++;
    pending.set(id, {resolve, reject});
    ws.send(JSON.stringify({id, method, params}));
});

const fileUrlToPath = (url) => {
    if (!url) {
        return '';
    }
    if (url.startsWith('file://')) {
        return decodeURIComponent(url.slice(7));
    }
    return url;
};

const isUserPath = (p) => p.startsWith(`${boxDir}/`) && p.endsWith('.js');

const userFrames = () => callFrames
    .map((f) => {
        const url = scripts.get(f.location.scriptId) || f.url || '';
        const fullname = fileUrlToPath(url);
        return {
            raw: f,
            func: f.functionName || 'main',
            fullname,
            file: basename(fullname || scriptPath),
            line: (f.location.lineNumber || 0) + 1,
        };
    })
    .filter((f) => isUserPath(f.fullname));

const formatFrameMi = (f, level) =>
    `frame={level=${miQuote(String(level))},func=${miQuote(f.func)},file=${miQuote(f.file)},` +
    `fullname=${miQuote(f.fullname)},line=${miQuote(String(f.line))}}`;

const formatRemote = async(obj, depth = 0) => {
    if (!obj) {
        return 'undefined';
    }
    if (obj.type === 'undefined') {
        return 'undefined';
    }
    if (obj.type === 'string') {
        return miQuote(obj.value ?? '');
    }
    if (obj.type === 'number' || obj.type === 'boolean') {
        return String(obj.unserializableValue ?? obj.value);
    }
    if (obj.type === 'bigint') {
        return String(obj.unserializableValue || obj.description || '0n');
    }
    if (obj.type === 'symbol') {
        return String(obj.description || 'Symbol()');
    }
    if (obj.type === 'function') {
        return '[Function]';
    }
    if (obj.subtype === 'null') {
        return 'null';
    }
    if (!obj.objectId || depth >= 1) {
        return String(obj.description || obj.className || 'Object');
    }
    try {
        const {result} = await cdp('Runtime.getProperties', {objectId: obj.objectId, ownProperties: true});
        const props = (result || []).filter((p) => p.enumerable && p.value);
        if (obj.subtype === 'array') {
            const items = props.filter((p) => /^\d+$/.test(p.name)).slice(0, 30);
            const parts = [];
            for (const p of items) {
                parts.push(await formatRemote(p.value, depth + 1));
            }
            return `{${parts.join(', ')}}`;
        }
        const fields = props.slice(0, 12);
        if (!fields.length) {
            return String(obj.description || '{}');
        }
        const parts = [];
        for (const p of fields) {
            parts.push(`${p.name} = ${await formatRemote(p.value, depth + 1)}`);
        }
        return `{${parts.join(', ')}}`;
    } catch {
        return String(obj.description || 'Object');
    }
};

const emitStopped = (reason, frame) => {
    emit(`*stopped,reason=${miQuote(reason)},thread-id="1",${formatFrameMi(frame, 0)}`);
};

const handlePaused = async(params) => {
    callFrames = params.callFrames || [];
    const frames = userFrames();
    if (!frames.length) {
        // Paused in Node internal wrapper: step/resume into user code.
        cdp('Debugger.resume').catch(() => undefined);
        return;
    }
    if (!runRequested) {
        initialPause = frames[0];
        return;
    }
    const reason = (params.hitBreakpoints && params.hitBreakpoints.length) ? 'breakpoint-hit' : 'end-stepping-range';
    emitStopped(reason, frames[0]);
};

const connectInspector = (wsUrl) => new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.addEventListener('open', async() => {
        try {
            await cdp('Runtime.enable');
            await cdp('Debugger.enable');
            await cdp('Debugger.setBlackboxPatterns', {patterns: ['^node:', '^internal/']});
            await cdp('Runtime.runIfWaitingForDebugger');
            resolve();
        } catch (e) {
            reject(e);
        }
    });
    ws.addEventListener('message', (ev) => {
        let msg;
        try {
            msg = JSON.parse(String(ev.data));
        } catch {
            return;
        }
        if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) {
                p.reject(new Error(msg.error.message || 'cdp error'));
            } else {
                p.resolve(msg.result);
            }
            return;
        }
        if (msg.method === 'Debugger.scriptParsed' && msg.params?.scriptId) {
            scripts.set(msg.params.scriptId, msg.params.url || '');
        } else if (msg.method === 'Debugger.paused') {
            handlePaused(msg.params).catch(() => undefined);
        } else if (msg.method === 'Debugger.resumed') {
            callFrames = [];
        }
    });
    ws.addEventListener('error', (e) => reject(e));
});

const parseMi = (line) => {
    const m = /^(\d*)(-\S+)(?:\s+(.*))?$/.exec(line.trim());
    if (!m) {
        return null;
    }
    return {token: m[1], cmd: m[2], rest: (m[3] || '').trim()};
};

const unescapeQuoted = (raw) => raw.replace(/\\(["\\nrt])/g, (_, c) => ({n: '\n', r: '\r', t: '\t'}[c] || c));

const handleCommand = async(line) => {
    const parsed = parseMi(line);
    if (!parsed) {
        return;
    }
    const {token, cmd, rest} = parsed;
    const ok = (payload = '') => emit(`${token}^done${payload ? ',' + payload : ''}`);
    const err = (msg) => emit(`${token}^error,msg=${miQuote(msg)}`);

    try {
        if (cmd === '-break-insert') {
            if (/\bmain\b/.test(rest)) {
                stopAtMain = true;
                const id = nextBp++;
                ok(`bkpt={number=${miQuote(String(id))}}`);
                return;
            }
            let condition = '';
            let target = rest;
            const cm = /-c\s+"((?:[^"\\]|\\.)*)"\s+(.*)$/.exec(rest);
            if (cm) {
                condition = unescapeQuoted(cm[1]);
                target = cm[2].trim();
            }
            const lm = /^(?:(.+):)?(\d+)$/.exec(target);
            if (!lm) {
                err('bad breakpoint');
                return;
            }
            const file = lm[1] ? (lm[1].startsWith('/') ? lm[1] : join(boxDir, lm[1])) : scriptPath;
            const lineNum = Math.max(1, Number(lm[2]));
            const id = nextBp++;
            const res = await cdp('Debugger.setBreakpointByUrl', {
                lineNumber: lineNum - 1,
                url: `file://${file}`,
                ...(condition ? {condition} : {}),
            });
            breakpoints.set(id, res.breakpointId);
            ok(`bkpt={number=${miQuote(String(id))}}`);
            return;
        }
        if (cmd === '-break-delete') {
            for (const part of rest.split(/\s+/).filter(Boolean)) {
                const id = Number(part);
                const cdpBp = breakpoints.get(id);
                if (cdpBp) {
                    await cdp('Debugger.removeBreakpoint', {breakpointId: cdpBp}).catch(() => undefined);
                    breakpoints.delete(id);
                }
            }
            ok();
            return;
        }
        if (cmd === '-exec-run') {
            runRequested = true;
            emit(`${token}^running`);
            const waitStart = Date.now();
            while (!initialPause && !ended && Date.now() - waitStart < 5000) {
                await new Promise((r) => setTimeout(r, 15));
            }
            if (ended) {
                return;
            }
            if (stopAtMain && initialPause) {
                const f = initialPause;
                initialPause = null;
                emitStopped('breakpoint-hit', f);
            } else {
                initialPause = null;
                await cdp('Debugger.resume');
            }
            return;
        }
        if (cmd === '-exec-step') {
            emit(`${token}^running`);
            await cdp('Debugger.stepInto');
            return;
        }
        if (cmd === '-exec-next') {
            emit(`${token}^running`);
            await cdp('Debugger.stepOver');
            return;
        }
        if (cmd === '-exec-finish') {
            emit(`${token}^running`);
            await cdp('Debugger.stepOut');
            return;
        }
        if (cmd === '-exec-continue') {
            emit(`${token}^running`);
            await cdp('Debugger.resume');
            return;
        }
        if (cmd === '-stack-list-frames') {
            const list = userFrames().map((f, i) => formatFrameMi(f, i));
            ok(`stack=[${list.join(',')}]`);
            return;
        }
        if (cmd === '-stack-list-variables') {
            const fm = /--frame\s+(\d+)/.exec(rest);
            const idx = fm ? Number(fm[1]) : 0;
            const frame = userFrames()[idx];
            if (!frame) {
                ok('variables=[]');
                return;
            }
            const seen = new Set();
            const vars = [];
            for (const scope of frame.raw.scopeChain || []) {
                if (!['local', 'block', 'script'].includes(scope.type) || !scope.object?.objectId) {
                    continue;
                }
                const {result} = await cdp('Runtime.getProperties', {objectId: scope.object.objectId, ownProperties: true});
                for (const p of result || []) {
                    if (!p.value || p.value.type === 'function' || seen.has(p.name) ||
                            ['arguments', 'exports', 'require', 'module', '__filename', '__dirname'].includes(p.name)) {
                        continue;
                    }
                    seen.add(p.name);
                    const val = await formatRemote(p.value, 0);
                    vars.push(`{name=${miQuote(p.name)},value=${miQuote(val)}}`);
                }
            }
            ok(`variables=[${vars.join(',')}]`);
            return;
        }
        if (cmd === '-data-evaluate-expression') {
            const fm = /--frame\s+(\d+)/.exec(rest);
            const idx = fm ? Number(fm[1]) : 0;
            const em = /"((?:[^"\\]|\\.)*)"\s*$/.exec(rest);
            const frame = userFrames()[idx];
            if (!frame || !em) {
                err('no frame');
                return;
            }
            const expr = unescapeQuoted(em[1]);
            const res = await cdp('Debugger.evaluateOnCallFrame', {
                callFrameId: frame.raw.callFrameId,
                expression: expr,
                throwOnSideEffect: false,
            });
            if (res.exceptionDetails) {
                err(res.exceptionDetails.text || 'evaluation failed');
                return;
            }
            const val = await formatRemote(res.result, 0);
            ok(`value=${miQuote(val)}`);
            return;
        }
        if (cmd === '-gdb-exit') {
            ok();
            process.exit(0);
        }
        ok();
    } catch (e) {
        err(e?.message || String(e));
    }
};

// Launch the student's script under Node's built-in inspector.
const child = spawn(process.execPath, [
    `--max-old-space-size=${heapMb}`,
    '--inspect-brk=127.0.0.1:0',
    scriptPath,
], {stdio: ['pipe', 'pipe', 'pipe']});

const inStream = createReadStream(join(boxDir, 'in.fifo'));
const outStream = createWriteStream(join(boxDir, 'out.fifo'));
const errStream = createWriteStream(join(boxDir, 'err.fifo'));
inStream.on('error', () => undefined);
outStream.on('error', () => undefined);
errStream.on('error', () => undefined);
child.stdin.on('error', () => undefined);
inStream.pipe(child.stdin);
child.stdout.pipe(outStream);

let readyResolve;
const ready = new Promise((r) => {
    readyResolve = r;
});
let connected = false;

createInterface({input: child.stderr}).on('line', (line) => {
    const m = /^Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/.exec(line);
    if (m && !connected) {
        connected = true;
        connectInspector(m[1]).then(() => readyResolve()).catch(() => readyResolve());
        return;
    }
    if (line.startsWith('Waiting for the debugger to disconnect')) {
        ws?.close();
        return;
    }
    if (INSPECTOR_NOISE.test(line)) {
        return;
    }
    errStream.write(`${line}\n`);
});

child.on('exit', (code) => {
    ended = true;
    outStream.end();
    errStream.end();
    emit(`*stopped,reason="exited",exit-code=${miQuote(String(code ?? 0))}`);
    process.exit(0);
});

let queue = Promise.resolve();
createInterface({input: process.stdin}).on('line', (line) => {
    queue = queue.then(() => ready).then(() => handleCommand(line));
});
