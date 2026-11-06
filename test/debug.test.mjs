// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of step by step runs under gdb (needs Linux with bwrap, gcc, g++ and gdb).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startServer} from '../server.js';
import {sign} from '../lib/token.js';
import {parseRecord} from '../lib/mi.js';

const SECRET = 'test-secret-of-sixteen-or-more';
let server;
let base;

before(async() => {
    server = await startServer({port: 0, host: '127.0.0.1', secret: SECRET});
    base = `ws://127.0.0.1:${server.address().port}/session`;
});
after(() => server.close());

/**
 * Run a program step by step: at each pause the callback decides what to send.
 *
 * @param {string} lang
 * @param {string} code
 * @param {function(Object, number): Object[]} onPause messages to send at the n-th pause (0-based)
 * @param {string} [stdin]
 * @returns {Promise<{pauses: Object[], out: string, exit: Object}>}
 */
const debug = (lang, code, onPause, stdin = '') => new Promise((resolve, reject) => {
    const token = sign({u: 9, s: 'test', e: Math.floor(Date.now() / 1000) + 60, n: randomUUID()}, SECRET);
    const ws = new WebSocket(`${base}?token=${token}`);
    const result = {pauses: [], out: '', exit: undefined};
    ws.onopen = () => ws.send(JSON.stringify({type: 'start', lang, code, stdin, debug: true}));
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'paused') {
            result.pauses.push(message);
            for (const reply of onPause(message, result.pauses.length - 1)) {
                ws.send(JSON.stringify(reply));
            }
        } else if (message.type === 'out') {
            result.out += message.data;
        } else if (['exit', 'compile', 'error'].includes(message.type)) {
            result.exit = message;
        }
    };
    ws.onclose = () => resolve(result);
    ws.onerror = reject;
});

const C = '#include <stdio.h>\n' +
    'int twice(int x)\n' +
    '{\n' +
    '    return 2 * x;\n' +
    '}\n' +
    'int main(void)\n' +
    '{\n' +
    '    int a;\n' +
    '    printf("a = ");\n' +
    '    scanf("%d", &a);\n' +
    '    int b = twice(a);\n' +
    '    printf("b = %d\\n", b);\n' +
    '    return 0;\n' +
    '}\n';

test('the MI parser reads records, tuples, lists and strings', () => {
    const r = parseRecord('*stopped,reason="end-stepping-range",frame={func="main",args=[],line="5"},x=["a","b\\"c"]');
    assert.deepEqual(r, {kind: '*', class: 'stopped',
        data: {reason: 'end-stepping-range', frame: {func: 'main', args: [], line: '5'}, x: ['a', 'b"c']}});
    assert.deepEqual(parseRecord('^done,variables=[{name="a",value="2"}]').data.variables, [{name: 'a', value: '2'}]);
    assert.deepEqual(parseRecord('~"4\\t    int a = 2;\\n"'), {kind: '~', text: '4\t    int a = 2;\n'});
});

test('C: every line of main and of the function, with the variables', async() => {
    const r = await debug('c', C, (p) => {
        const replies = [{type: 'step'}];
        if (p.line === 10) {
            // scanf waits for the input; the next pause comes after it.
            replies.unshift({type: 'stdin', data: '21\n'});
        }
        return replies;
    });
    assert.deepEqual(r.pauses.map((p) => `${p.func}:${p.line}`),
        ['main:7', 'main:9', 'main:10', 'main:11', 'twice:4', 'twice:5', 'main:12', 'main:13', 'main:14']);
    assert.deepEqual(r.pauses[4].vars, [{name: 'x', value: '21'}]);
    assert.ok(r.pauses[6].vars.some((v) => v.name === 'b' && v.value === '42'));
    assert.equal(r.out, 'a = b = 42\n');
    assert.equal(r.exit.status, 'ok');
});

test('continue runs to the end; the input given at the start is used', async() => {
    const r = await debug('c', C, () => [{type: 'continue'}], '5');
    assert.equal(r.pauses.length, 1);
    assert.equal(r.out, 'a = b = 10\n');
    assert.equal(r.exit.status, 'ok');
});

test('C++: arrays and strings in the variables', async() => {
    const code = '#include <iostream>\n#include <string>\nusing namespace std;\nint main()\n{\n' +
        '    int v[3] = {1, 2, 3};\n    string s = "abc";\n    cout << v[1] << s << endl;\n    return 0;\n}\n';
    const r = await debug('cpp', code, () => [{type: 'step'}]);
    const last = r.pauses.find((p) => p.line === 8);
    assert.ok(last, JSON.stringify(r.pauses));
    assert.equal(last.vars.find((v) => v.name === 'v').value, '{1, 2, 3}');
    assert.match(last.vars.find((v) => v.name === 's').value, /abc/);
    assert.equal(r.out, '2abc\n');
});

test('a crash ends the run with the runtime status', async() => {
    const code = '#include <stddef.h>\nint main(void)\n{\n    int *p = NULL;\n    *p = 1;\n    return 0;\n}\n';
    const r = await debug('c', code, () => [{type: 'continue'}]);
    assert.equal(r.exit.status, 'runtime');
    assert.equal(r.exit.signal, 'SIGSEGV');
});

test('Stop while paused', async() => {
    const r = await debug('c', C, () => [{type: 'stop'}]);
    assert.equal(r.exit.status, 'stopped');
});
