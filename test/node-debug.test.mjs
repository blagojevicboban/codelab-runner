// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of Step for JavaScript (Node.js) under node-debugger (needs Linux with bwrap; skipped without it).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket as WsClient} from 'ws';
import {randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {startServer} from '../server.js';
import {sign} from '../lib/token.js';
import {debuggerAvailable} from '../lib/sandbox.js';

const NODE_DBG = fileURLToPath(new URL('../node-debugger/NodeDebugger.mjs', import.meta.url));
const directSkip = (process.platform === 'linux' && typeof globalThis.WebSocket === 'function')
    ? false : 'requires Linux FIFOs and Node 22+ WebSocket';

test('NodeDebugger MI protocol: Step, frames, variables, Watch and exit', {skip: directSkip}, async() => {
    const dir = mkdtempSync(join(tmpdir(), 'codelab-nodedbg-'));
    try {
        const script = join(dir, 'prog.js');
        writeFileSync(script, 'function add(a, b) {\n    const s = a + b;\n    return s;\n}\nconst r = add(3, 4);\nconsole.log(r);\n');
        for (const f of ['in.fifo', 'out.fifo', 'err.fifo']) {
            spawnSync('mkfifo', ['-m', '600', join(dir, f)]);
        }
        const proc = spawn(process.execPath, [NODE_DBG, script, dir, '128'], {stdio: ['pipe', 'pipe', 'pipe']});
        // Open FIFO peers so NodeDebugger does not block opening FIFOs.
        const outReader = spawn('cat', [join(dir, 'out.fifo')]);
        const errReader = spawn('cat', [join(dir, 'err.fifo')]);
        const inWriter = spawn('sh', ['-c', `exec cat > "${join(dir, 'in.fifo')}"`], {stdio: ['pipe', 'ignore', 'ignore']});
        let stdoutText = '';
        outReader.stdout.on('data', (d) => { stdoutText += d.toString('utf8'); });

        const lines = [];
        const waiters = [];
        createInterface({input: proc.stdout}).on('line', (line) => {
            lines.push(line);
            for (let i = waiters.length - 1; i >= 0; i--) {
                if (waiters[i].pred(line)) {
                    const w = waiters.splice(i, 1)[0];
                    w.resolve(line);
                }
            }
        });
        const waitFor = (pred) => new Promise((resolve, reject) => {
            const hit = lines.find(pred);
            if (hit) {
                resolve(hit);
                return;
            }
            const timer = setTimeout(() => reject(new Error(`Timeout waiting for MI line. Got:\n${lines.join('\n')}`)), 8000);
            waiters.push({pred, resolve: (l) => { clearTimeout(timer); resolve(l); }});
        });

        proc.stdin.write('1-break-insert -t main\n');
        await waitFor((l) => l.startsWith('1^done'));
        proc.stdin.write(`2-break-insert ${script}:3\n`);
        await waitFor((l) => l.startsWith('2^done'));
        proc.stdin.write('3-exec-run\n');
        const firstStop = await waitFor((l) => l.startsWith('*stopped,reason="breakpoint-hit"'));
        assert.match(firstStop, /line="5"/);

        proc.stdin.write('4-exec-continue\n');
        const bpStop = await waitFor((l) => l.startsWith('*stopped') && l.includes('line="3"'));
        assert.match(bpStop, /func="add"/);

        proc.stdin.write('5-stack-list-frames 0 10\n');
        const frames = await waitFor((l) => l.startsWith('5^done'));
        assert.match(frames, /func="add".*func="main"/);

        proc.stdin.write('6-stack-list-variables --thread 1 --frame 0 --all-values\n');
        const vars = await waitFor((l) => l.startsWith('6^done'));
        assert.match(vars, /name="s",value="7"/);

        proc.stdin.write('7-data-evaluate-expression --thread 1 --frame 0 "a * b"\n');
        const evalRes = await waitFor((l) => l.startsWith('7^done'));
        assert.match(evalRes, /value="12"/);

        proc.stdin.write('8-exec-continue\n');
        await waitFor((l) => l.startsWith('*stopped,reason="exited"'));
        inWriter.stdin.end();
        await new Promise((r) => outReader.on('close', r));
        errReader.kill();
        assert.equal(stdoutText.trim(), '7');
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

const WebSocket = globalThis.WebSocket ?? WsClient;
const SECRET = 'test-secret-of-sixteen-or-more';
const hasBwrap = spawnSync('bwrap', ['--version'], {stdio: 'ignore'}).status === 0;
const skip = (hasBwrap && debuggerAvailable('javascript')) ? false : 'bwrap or node-debugger not available';
let server;
let base;

before(async() => {
    if (!skip) {
        server = await startServer({port: 0, host: '127.0.0.1', secret: SECRET});
        base = `ws://127.0.0.1:${server.address().port}/session`;
    }
});
after(() => server?.close());

const debug = (code, onPause, stdin = '', extra = {}) => new Promise((resolve, reject) => {
    const token = sign({u: 9, s: 'test', e: Math.floor(Date.now() / 1000) + 60, n: randomUUID()}, SECRET);
    const ws = new WebSocket(`${base}?token=${token}`);
    const result = {pauses: [], watches: [], out: '', err: '', exit: undefined};
    ws.onopen = () => ws.send(JSON.stringify({type: 'start', lang: 'javascript', code, stdin, debug: true, ...extra}));
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'paused') {
            result.pauses.push(message);
            for (const reply of onPause(message, result.pauses.length - 1)) {
                ws.send(JSON.stringify(reply));
            }
        } else if (message.type === 'watches') {
            result.watches.push(message.values);
            ws.send(JSON.stringify({type: 'continue'}));
        } else if (message.type === 'out') {
            result.out += message.data;
        } else if (message.type === 'err') {
            result.err += message.data;
        } else if (['exit', 'compile', 'error'].includes(message.type)) {
            result.exit = message;
        }
    };
    ws.onclose = () => resolve(result);
    ws.onerror = reject;
});

const FACT = `function fact(n) {
    if (n <= 1) return 1;
    return n * fact(n - 1);
}
const n = 3;
const f = fact(n);
console.log(n + '! = ' + f);
`;

test('JavaScript: Step through function calls, variables and call stack', {skip}, async() => {
    const r = await debug(FACT, () => [{type: 'step'}]);
    const deepest = r.pauses.find((p) => p.stack.length === 4);
    assert.ok(deepest, r.pauses.map((p) => `${p.func}:${p.line}`).join(' '));
    assert.deepEqual(deepest.stack.map((f) => f.func), ['fact', 'fact', 'fact', 'main']);
    assert.deepEqual(deepest.stack.slice(0, 3).map((f) => f.vars.find((v) => v.name === 'n')?.value), ['1', '2', '3']);
    assert.equal(r.out, '3! = 6\n');
    assert.equal(r.exit.status, 'ok');
});

test('JavaScript: breakpoints with condition and Watch expressions', {skip}, async() => {
    const r = await debug(FACT, (p) => {
        if (p.line === 2) {
            return [{type: 'watch', expressions: ['n * 10']}];
        }
        return [{type: 'continue'}];
    }, '', {step: false, breakpoints: [{line: 2, condition: 'n === 2'}]});
    assert.equal(r.pauses.length, 1);
    assert.equal(r.pauses[0].line, 2);
    assert.equal(r.pauses[0].vars.find((v) => v.name === 'n')?.value, '2');
    assert.equal(r.watches.length, 1);
    assert.equal(r.watches[0][0].value, '20');
    assert.equal(r.out, '3! = 6\n');
    assert.equal(r.exit.status, 'ok');
});
