// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the server with real programs in the sandbox (needs Linux with bwrap, gcc, g++, javac and mcs).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startServer} from '../server.js';
import {sign} from '../lib/token.js';

const SECRET = 'test-secret-of-sixteen-or-more';
let server;
let base;

before(async() => {
    process.env.CODELAB_CPU_SECONDS = '2';
    server = await startServer({port: 0, host: '127.0.0.1', secret: SECRET});
    base = `ws://127.0.0.1:${server.address().port}/session`;
});
after(() => server.close());

const token = (extra = {}) => sign({u: 7, s: 'test', e: Math.floor(Date.now() / 1000) + 60, n: randomUUID(), ...extra}, SECRET);

/**
 * Open a session, run a program and answer its prompts.
 *
 * @param {string} lang
 * @param {string} code
 * @param {Object} [options]
 * @param {string[]} [options.lines] lines typed after the program starts, one after each output
 * @param {string} [options.stdin] input given at the start
 * @param {boolean} [options.eof] send the end of the input after the lines
 * @param {boolean} [options.stop] stop the program after the first output
 * @returns {Promise<{out: string, err: string, messages: Object[], exit: Object|undefined}>}
 */
const session = (lang, code, {lines = [], stdin = '', eof = false, stop = false} = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}?token=${token()}`);
    const result = {out: '', err: '', messages: [], exit: undefined};
    const pending = [...lines];
    ws.onopen = () => ws.send(JSON.stringify({type: 'start', lang, code, stdin}));
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        result.messages.push(message.type);
        if (message.type === 'out') {
            result.out += message.data;
            if (stop) {
                ws.send(JSON.stringify({type: 'stop'}));
            } else if (pending.length) {
                ws.send(JSON.stringify({type: 'stdin', data: `${pending.shift()}\n`}));
                if (!pending.length && eof) {
                    ws.send(JSON.stringify({type: 'eof'}));
                }
            }
        } else if (message.type === 'err') {
            result.err += message.data;
        } else if (['exit', 'compile', 'error'].includes(message.type)) {
            result.exit = message;
        }
    };
    ws.onclose = () => resolve(result);
    ws.onerror = (e) => reject(e);
});

test('C: the prompt arrives before the input, then the answer', async() => {
    const code = '#include <stdio.h>\nint main(void)\n{\n    int a, b;\n    printf("a = ");\n    scanf("%d", &a);\n' +
        '    printf("b = ");\n    scanf("%d", &b);\n    printf("a + b = %d\\n", a + b);\n    return 0;\n}\n';
    const r = await session('c', code, {lines: ['20', '22']});
    assert.equal(r.out, 'a = b = a + b = 42\n');
    assert.equal(r.exit.status, 'ok');
    assert.deepEqual(r.messages.slice(0, 2), ['compiling', 'running']);
});

test('C++ with cin and input given at the start', async() => {
    const code = '#include <iostream>\nusing namespace std;\nint main()\n{\n    string name;\n    cout << "Name? ";\n' +
        '    cin >> name;\n    cout << "Hello, " << name << "!" << endl;\n}\n';
    const r = await session('cpp', code, {stdin: 'Ana'});
    assert.equal(r.out, 'Name? Hello, Ana!\n');
    assert.equal(r.exit.status, 'ok');
});

test('Java: Scanner reads until the end of the input', async() => {
    const code = 'import java.util.Scanner;\npublic class Zbir {\n    public static void main(String[] args) {\n' +
        '        Scanner in = new Scanner(System.in);\n        int s = 0;\n        System.out.print("> ");\n' +
        '        while (in.hasNextInt()) { s += in.nextInt(); System.out.print("> "); }\n' +
        '        System.out.println("sum " + s);\n    }\n}\n';
    const r = await session('java', code, {lines: ['1', '2', '3'], eof: true});
    assert.equal(r.out, '> > > > sum 6\n');
    assert.equal(r.exit.status, 'ok');
});

test('C#: Console.ReadLine', async() => {
    const code = 'using System;\nclass P\n{\n    static void Main()\n    {\n        Console.Write("x: ");\n' +
        '        int x = int.Parse(Console.ReadLine());\n        Console.WriteLine(x * x);\n    }\n}\n';
    const r = await session('csharp', code, {lines: ['12']});
    assert.equal(r.out, 'x: 144\n');
    assert.equal(r.exit.status, 'ok');
});

test('a compilation error ends the session with the message', async() => {
    const r = await session('c', 'int main(void) { return x; }\n');
    assert.equal(r.exit.type, 'compile');
    assert.match(r.exit.output, /x/);
});

test('an endless loop ends at the CPU limit', async() => {
    const r = await session('c', 'int main(void) { for (;;) {} }\n');
    assert.equal(r.exit.status, 'time');
});

test('Stop ends a program that waits for input', async() => {
    const code = '#include <stdio.h>\nint main(void) { int a; printf("?"); scanf("%d", &a); return 0; }\n';
    const r = await session('c', code, {stop: true});
    assert.equal(r.exit.status, 'stopped');
});

test('the sandbox has no network', async() => {
    const code = '#include <stdio.h>\n#include <netdb.h>\nint main(void) { printf("%s\\n", gethostbyname("example.com") ? "net" : "none");' +
        ' return 0; }\n';
    const r = await session('c', code);
    assert.equal(r.out, 'none\n');
});

test('a token is used once, and a bad token is refused', async() => {
    const t = token();
    const first = new WebSocket(`${base}?token=${t}`);
    await new Promise((resolve) => (first.onopen = resolve));
    first.close();
    for (const bad of [t, 'x.y', token({e: 1})]) {
        const ws = new WebSocket(`${base}?token=${bad}`);
        const outcome = await new Promise((resolve) => {
            ws.onopen = () => resolve('open');
            ws.onerror = () => resolve('refused');
        });
        assert.equal(outcome, 'refused');
    }
});
