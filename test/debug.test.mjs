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
const debug = (lang, code, onPause, stdin = '', extra = {}) => new Promise((resolve, reject) => {
    const token = sign({u: 9, s: 'test', e: Math.floor(Date.now() / 1000) + 60, n: randomUUID()}, SECRET);
    const ws = new WebSocket(`${base}?token=${token}`);
    const result = {pauses: [], out: '', exit: undefined};
    ws.onopen = () => ws.send(JSON.stringify({type: 'start', lang, code, stdin, debug: true, ...extra}));
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
        data: {reason: 'end-stepping-range', frame: {func: 'main', args: [], line: '5'}, x: ['a', 'b"c']}, token: null});
    assert.equal(parseRecord('12^done,stack=[frame={level="0",func="f"}]').token, 12);
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

const REC = '#include <stdio.h>\n' +
    'int fact(int n)\n' +
    '{\n' +
    '    if (n <= 1) {\n' +
    '        return 1;\n' +
    '    }\n' +
    '    return n * fact(n - 1);\n' +
    '}\n' +
    'int main(void)\n' +
    '{\n' +
    '    int r = fact(3);\n' +
    '    printf("%d\\n", r);\n' +
    '    return 0;\n' +
    '}\n';

test('Step over a call, and Step out of a function', async() => {
    const over = await debug('c', C, (p) => [p.line === 10 ? {type: 'stdin', data: '4\n'} : null, {type: 'next'}].filter(Boolean));
    assert.deepEqual(over.pauses.map((p) => `${p.func}:${p.line}`), ['main:7', 'main:9', 'main:10', 'main:11', 'main:12',
        'main:13', 'main:14']);
    assert.equal(over.out, 'a = b = 8\n');
    // Into twice(), then out of it at once: back in main.
    const out = await debug('c', C, (p) => [p.line === 10 ? {type: 'stdin', data: '4\n'} : null,
        {type: p.func === 'twice' ? 'out' : 'step'}].filter(Boolean));
    const trail = out.pauses.map((p) => `${p.func}:${p.line}`);
    assert.deepEqual(trail.slice(trail.indexOf('twice:4')), ['twice:4', 'main:11', 'main:12', 'main:13', 'main:14']);
});

test('breakpoints: Run stops only there, with the call stack of a recursion', async() => {
    const r = await debug('c', REC, () => [{type: 'continue'}], '', {step: false, breakpoints: [5]});
    // fact(3) -> fact(2) -> fact(1): the breakpoint on "return 1" is reached once.
    assert.equal(r.pauses.length, 1);
    const p = r.pauses[0];
    assert.equal(p.line, 5);
    assert.deepEqual(p.stack.map((f) => `${f.func}:${f.line}`), ['fact:5', 'fact:7', 'fact:7', 'main:11']);
    assert.deepEqual(p.stack.map((f) => f.vars.find((v) => v.name === 'n')?.value), ['1', '2', '3', undefined]);
    assert.equal(r.out, '6\n');
    assert.equal(r.exit.status, 'ok');
});

test('breakpoints changed while paused', async() => {
    const r = await debug('c', REC, (p, n) => (n === 0 ? [{type: 'breakpoints', lines: [12]}, {type: 'continue'}]
        : [{type: 'continue'}]), '', {step: false, breakpoints: [11]});
    assert.deepEqual(r.pauses.map((p) => p.line), [11, 12]);
    assert.equal(r.exit.status, 'ok');
});

test('pointer fields of a structure value, at its own level', async() => {
    const {pointerFields} = await import('../lib/session.js');
    assert.deepEqual(pointerFields('{data = 1, next = 0x5555, name = "a, b = 0x1", in = {p = 0x9}}'), [['next', '0x5555']]);
    assert.deepEqual(pointerFields('{x = 1}'), []);
    assert.deepEqual(pointerFields('0x10'), []);
});

test('the memory view: addresses of the variables and what the pointers point to', async() => {
    const code = '#include <stdio.h>\n#include <stdlib.h>\n' +
        'struct node { int data; struct node *next; };\n' +
        'int main(void)\n' +
        '{\n' +
        '    int a[4] = {5, 6, 7, 8};\n' +
        '    int x = 3;\n' +
        '    int *p = &a[2];\n' +
        '    int *q = &x;\n' +
        '    struct node *head = NULL;\n' +
        '    for (int i = 1; i <= 3; i++) {\n' +
        '        struct node *n = malloc(sizeof *n);\n' +
        '        n->data = i;\n' +
        '        n->next = head;\n' +
        '        head = n;\n' +
        '    }\n' +
        '    printf("%d %d %d\\n", *p, *q, head->data);\n' +
        '    return 0;\n' +
        '}\n';
    const r = await debug('c', code, (pause) => [{type: pause.line === 17 ? 'continue' : 'next'}],
        '', {breakpoints: [17], step: false});
    assert.equal(r.out, '7 3 3\n', JSON.stringify({exit: r.exit, pauses: r.pauses.map((p) => [p.line, p.targets])}));
    const stop = r.pauses.find((p) => p.line === 17);
    assert.ok(stop, JSON.stringify(r.pauses.map((p) => p.line)));
    const main = stop.stack[0];
    const value = (name) => main.vars.find((v) => v.name === name).value;
    const [aAddr, aSize, aElem] = main.addrs.a;
    assert.equal(aSize, 16);
    assert.equal(aElem, 4);
    // p points to a[2], q to x: inside the variables, so not among the targets.
    assert.equal(Number.parseInt(value('p'), 16), aAddr + 2 * aElem);
    assert.equal(Number.parseInt(value('q'), 16), main.addrs.x[0]);
    // head -> 3 -> 2 -> 1 -> NULL on the heap.
    const first = stop.targets[value('head')];
    assert.match(first, /^\{data = 3, next = 0x[0-9a-f]+\}$/);
    const second = stop.targets[/next = (0x[0-9a-f]+)/.exec(first)[1]];
    assert.match(second, /^\{data = 2, /);
    const third = stop.targets[/next = (0x[0-9a-f]+)/.exec(second)[1]];
    assert.equal(third, '{data = 1, next = 0x0}');
});

test('no memory data without pointers', async() => {
    const r = await debug('c', C, (pause) => [{type: 'next'}], '4\n');
    assert.ok(r.pauses.length > 0);
    assert.ok(r.pauses.every((p) => p.targets === undefined && p.stack.every((f) => f.addrs === undefined)));
});
