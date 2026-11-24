// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the C# language service connection (lib/analysis.js, /analysis), with a stand-in for the Roslyn analyzer
 * (test/fixtures/fake-analyzer.mjs), so they need neither .NET nor bwrap.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {WebSocket as WsClient} from 'ws';
import {Analyzer, CODE_MAX, cleanRequest} from '../lib/analysis.js';
import {startServer} from '../server.js';
import {sign} from '../lib/token.js';

const WebSocket = globalThis.WebSocket ?? WsClient;
const SECRET = 'test-secret-of-sixteen-or-more';
const FAKE = fileURLToPath(new URL('./fixtures/fake-analyzer.mjs', import.meta.url));

const fake = (options = {}) => new Analyzer({dll: FAKE, sandbox: false, idleMs: 0, timeoutMs: 2000,
    command: () => ({command: [process.execPath, FAKE], env: {}}), ...options});

let server;
let port;
let analyzer;

before(async() => {
    analyzer = fake();
    server = await startServer({port: 0, host: '127.0.0.1', secret: SECRET, analyzer,
        javaAnalyzer: fake({name: 'java'})});
    port = server.address().port;
});
after(() => {
    analyzer.stop();
    server.close();
});

const token = (extra = {}) => sign({u: 7, s: 'test', e: Math.floor(Date.now() / 1000) + 60, n: randomUUID(),
    p: 'analysis', l: 'csharp', ...extra}, SECRET);

/**
 * Open a connection and wait until it is open or refused.
 *
 * @param {string} path
 * @param {string} grant
 * @returns {Promise<?WebSocket>} null when refused
 */
const connect = (path, grant) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}?token=${grant}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => resolve(null);
});

/**
 * Send a request and wait for the answer with its id.
 *
 * @param {WebSocket} ws
 * @param {Object} message
 * @returns {Promise<Object>}
 */
const ask = (ws, message) => new Promise((resolve) => {
    const listener = (event) => {
        const answer = JSON.parse(event.data);
        if (answer.id === message.id) {
            ws.removeEventListener('message', listener);
            resolve(answer);
        }
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify(message));
});

test('cleanRequest keeps only known operations, sane numbers and .cs files', () => {
    assert.equal(cleanRequest({op: 'run', code: 'x'}), null);
    assert.equal(cleanRequest(null), null);
    const request = cleanRequest({op: 'hover', code: 'class A {}', line: 3, column: -1, culture: 'de-DE',
        files: [{name: 'B.cs', code: 'class B {}'}, {name: '../x.cs', code: ''}, {name: 'c.txt', code: ''}]});
    assert.deepEqual(request, {op: 'hover', code: 'class A {}', files: [{name: 'B.cs', code: 'class B {}'}],
        line: 3, column: 0, item: '', culture: 'de-DE'});
    assert.equal(cleanRequest({op: 'hover', code: 'x'.repeat(CODE_MAX + 1)}), null);
    assert.equal(cleanRequest({op: 'hover', code: '', culture: '../../etc'}).culture, '');
});

test('the analyzer answers each request by its id and is started again after it ends', async() => {
    const a = fake();
    const [one, two] = await Promise.all([a.ask(cleanRequest({op: 'complete', code: 'ab', line: 1, column: 2})),
        a.ask(cleanRequest({op: 'hover', code: 'abc', line: 2, column: 1}))]);
    assert.equal(one.op, 'complete');
    assert.equal(one.length, 2);
    assert.equal(two.op, 'hover');
    assert.equal(two.length, 3);
    assert.equal(await a.ask(cleanRequest({op: 'hover', code: 'crash'})), null);
    const again = await a.ask(cleanRequest({op: 'hover', code: 'x'}));
    assert.equal(again.op, 'hover');
    assert.notEqual(again.pid, one.pid);
    a.stop();
});

test('a request without an answer ends with null after the timeout; too many waiting are busy', async() => {
    const a = fake({timeoutMs: 300, maxPending: 1});
    const silent = a.ask(cleanRequest({op: 'hover', code: 'silent'}));
    assert.deepEqual(await a.ask(cleanRequest({op: 'hover', code: 'x'})), {busy: true});
    assert.equal(await silent, null);
    a.stop();
});

test('an analyzer that is not published is not available', async() => {
    const a = new Analyzer({dll: ''});
    assert.equal(a.available(), false);
    assert.equal(await a.ask(cleanRequest({op: 'hover', code: 'x'})), null);
});

test('/analysis answers with a token for the language service', async() => {
    const ws = await connect('/analysis', token());
    assert.ok(ws);
    const answer = await ask(ws, {id: 5, op: 'diagnostics', code: 'class A {}',
        files: [{name: 'B.cs', code: 'class B {}'}]});
    assert.equal(answer.id, 5);
    assert.equal(answer.op, 'diagnostics');
    assert.equal(answer.files, 1);
    assert.deepEqual(await ask(ws, {id: 6, op: 'run', code: ''}), {id: 6, error: 'request'});
    ws.close();
});

test('/analysis takes C# and Java, refuses a session token, another language and a used token; /session refuses an analysis token', async() => {
    assert.equal(await connect('/analysis', token({p: undefined})), null);
    assert.equal(await connect('/analysis', token({l: 'python'})), null);
    const java = await connect('/analysis', token({l: 'java'}));
    assert.ok(java);
    java.close();
    const once = token();
    const ws = await connect('/analysis', once);
    assert.ok(ws);
    assert.equal(await connect('/analysis', once), null);
    ws.close();
    assert.equal(await connect('/session', token()), null);
});

test('/analysis allows at most four connections of a user', async() => {
    const open = [];
    for (let i = 0; i < 4; i++) {
        open.push(await connect('/analysis', token()));
    }
    assert.ok(open.every(Boolean));
    assert.equal(await connect('/analysis', token()), null);
    const other = await connect('/analysis', token({u: 8}));
    assert.ok(other);
    [...open, other].forEach((ws) => ws.close());
});

test('a server without the analyzer refuses /analysis and keeps running', async() => {
    const before = process.env.CODELAB_ROSLYN;
    process.env.CODELAB_ROSLYN = 'off';
    const plain = await startServer({port: 0, host: '127.0.0.1', secret: SECRET, javaAnalyzer: new Analyzer({dll: ''})});
    process.env.CODELAB_ROSLYN = before ?? '';
    if (before === undefined) {
        delete process.env.CODELAB_ROSLYN;
    }
    const at = plain.address().port;
    const refused = await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${at}/analysis?token=${token()}`);
        ws.onopen = () => resolve(false);
        ws.onerror = () => resolve(true);
    });
    assert.equal(refused, true);
    const health = await (await fetch(`http://127.0.0.1:${at}/health`)).json();
    assert.deepEqual(health.analysis, []);
    plain.close();
});

test('/health says whether the language service is there', async() => {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.ok(Array.isArray(health.analysis));
});
