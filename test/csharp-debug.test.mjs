// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of Step for C# under netcoredbg (needs Linux with bwrap, the .NET SDK and netcoredbg: bash deploy/netcoredbg.sh;
 * skipped without them).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket as WsClient} from 'ws';
import {randomUUID} from 'node:crypto';
import {startServer} from '../server.js';
import {sign} from '../lib/token.js';
import {debuggerAvailable} from '../lib/sandbox.js';
import {methodName} from '../lib/csvalues.js';

const WebSocket = globalThis.WebSocket ?? WsClient;
const SECRET = 'test-secret-of-sixteen-or-more';
const skip = debuggerAvailable('csharp') ? false : 'no .NET SDK or netcoredbg on this machine';
let server;
let base;

before(async() => {
    if (!skip) {
        server = await startServer({port: 0, host: '127.0.0.1', secret: SECRET});
        base = `ws://127.0.0.1:${server.address().port}/session`;
    }
});
after(() => server?.close());

/**
 * Run a C# program step by step: at each pause the callback decides what to send.
 *
 * @param {string} code
 * @param {function(Object, number): Object[]} onPause
 * @param {string} [stdin]
 * @param {Object} [extra] more fields of the start message
 * @returns {Promise<{pauses: Object[], watches: Array, out: string, err: string, exit: Object}>}
 */
const debug = (code, onPause, stdin = '', extra = {}) => new Promise((resolve, reject) => {
    const token = sign({u: 9, s: 'test', e: Math.floor(Date.now() / 1000) + 60, n: randomUUID()}, SECRET);
    const ws = new WebSocket(`${base}?token=${token}`);
    const result = {pauses: [], watches: [], out: '', err: '', exit: undefined};
    ws.onopen = () => ws.send(JSON.stringify({type: 'start', lang: 'csharp', code, stdin, debug: true, ...extra}));
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

const FACT = `using System;

class Program
{
    static int Fact(int n)
    {
        if (n <= 1) return 1;
        return n * Fact(n - 1);
    }

    static void Main()
    {
        int n = int.Parse(Console.ReadLine());
        int f = Fact(n);
        Console.WriteLine(n + "! = " + f);
    }
}
`;

test('method names of netcoredbg', () => {
    assert.equal(methodName('Program.Main()'), 'Main');
    assert.equal(methodName('Program.Fact()'), 'Fact');
    assert.equal(methodName('Node..ctor()'), 'Node');
    assert.equal(methodName('Shapes.Circle.Area()'), 'Area');
});

test('C#: every line of Main and of the method, with the variables and the call stack', {skip}, async() => {
    const r = await debug(FACT, () => [{type: 'step'}], '3');
    const trail = r.pauses.map((p) => `${p.func}:${p.line}`);
    assert.deepEqual(trail.slice(0, 5), ['Main:13', 'Main:14', 'Fact:6', 'Fact:7', 'Fact:8'], trail.join(' '));
    const deepest = r.pauses.find((p) => p.stack.length === 4);
    assert.ok(deepest, trail.join(' '));
    assert.deepEqual(deepest.stack.map((f) => f.func), ['Fact', 'Fact', 'Fact', 'Main']);
    assert.deepEqual(deepest.stack.slice(0, 3).map((f) => f.vars.find((v) => v.name === 'n').value), ['1', '2', '3']);
    assert.equal(r.out, '3! = 6\n');
    assert.equal(r.exit.status, 'ok');
});

test('C#: input typed while paused, Step over and out', {skip}, async() => {
    const over = await debug(FACT, (p) => [p.line === 13 ? {type: 'stdin', data: '4\n'} : null, {type: 'next'}]
        .filter(Boolean));
    assert.deepEqual(over.pauses.map((p) => `${p.func}:${p.line}`), ['Main:13', 'Main:14', 'Main:15', 'Main:16']);
    assert.equal(over.out, '4! = 24\n');
    const out = await debug(FACT, (p) => [{type: p.func === 'Fact' ? 'out' : 'step'}], '2');
    const trail = out.pauses.map((p) => `${p.func}:${p.line}`);
    assert.deepEqual(trail.slice(trail.indexOf('Fact:6')), ['Fact:6', 'Main:14', 'Main:15', 'Main:16'], trail.join(' '));
    assert.equal(out.exit.status, 'ok');
});

test('C#: breakpoints and conditions, Run stops only there', {skip}, async() => {
    const r = await debug(FACT, () => [{type: 'continue'}], '4', {step: false, breakpoints: [{line: 7, condition: 'n == 2'}]});
    assert.equal(r.pauses.length, 1);
    assert.equal(r.pauses[0].line, 7);
    assert.equal(r.pauses[0].vars.find((v) => v.name === 'n').value, '2');
    assert.equal(r.out, '4! = 24\n');
    const none = await debug(FACT, () => [{type: 'continue'}], '3', {step: false});
    assert.equal(none.pauses.length, 0);
    assert.equal(none.exit.status, 'ok');
});

test('C#: arrays, lists, dictionaries, sets and objects shown with their contents; watches', {skip}, async() => {
    const code = `using System;
using System.Collections.Generic;

class Node
{
    public int Value;
    public Node Next;
    public Node(int value, Node next) { Value = value; Next = next; }
}

class Program
{
    static void Main()
    {
        int[] a = { 5, 6, 7 };
        int[,] grid = { { 1, 2 }, { 3, 4 } };
        var list = new List<int> { 3, 1, 2 };
        var ages = new Dictionary<string, int> { ["Ana"] = 16, ["Marko"] = 17 };
        var set = new HashSet<int> { 8 };
        var head = new Node(1, new Node(2, null));
        string s = "hi";
        Console.WriteLine(a.Length + list.Count);
    }
}
`;
    const r = await debug(code, (p) => [{type: 'continue'}], '', {step: false, breakpoints: [22],
        watches: ['list.Count * 10', 'head.Next.Value', 'missing']});
    assert.equal(r.pauses.length, 1);
    const value = (name) => r.pauses[0].vars.find((v) => v.name === name)?.value;
    assert.equal(value('a'), '{5, 6, 7}');
    assert.equal(value('grid'), '{{1, 2}, {3, 4}}');
    assert.equal(value('list'), '{3, 1, 2}');
    assert.equal(value('ages'), '{["Ana"] = 16, ["Marko"] = 17}');
    assert.equal(value('set'), '{8}');
    assert.equal(value('head'), '{Value = 1, Next = {Node}}');
    assert.equal(value('s'), '"hi"');
    assert.deepEqual(r.pauses[0].watches, [{expr: 'list.Count * 10', value: '30'}, {expr: 'head.Next.Value', value: '2'},
        {expr: 'missing', value: null}]);
    assert.equal(r.out, '6\n');
});

test('C#: an unhandled exception ends the run with the runtime status and its message', {skip}, async() => {
    const code = 'using System;\nclass Program\n{\n    static void Main()\n    {\n        int z = 0;\n' +
        '        Console.WriteLine(1 / z);\n    }\n}\n';
    const r = await debug(code, () => [{type: 'continue'}]);
    assert.equal(r.exit.status, 'runtime');
    assert.match(r.err, /DivideByZeroException/);
});

test('C#: a compile error is reported as for Run', {skip}, async() => {
    const r = await debug('class Program { static void Main() { int x = "a"; } }', () => []);
    assert.equal(r.exit.type, 'compile');
    assert.match(r.exit.output, /CS0029/);
});
