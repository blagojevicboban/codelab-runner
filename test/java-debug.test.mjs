// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of Step for Java under java-debugger (needs Linux with bwrap and a JDK with javac; skipped without them).
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

const WebSocket = globalThis.WebSocket ?? WsClient;
const SECRET = 'test-secret-of-sixteen-or-more';
const skip = debuggerAvailable('java') ? false : 'no JDK on this machine';
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
 * Run a Java program step by step: at each pause the callback decides what to send.
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
    ws.onopen = () => ws.send(JSON.stringify({type: 'start', lang: 'java', code, stdin, debug: true, ...extra}));
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

const FACT = `import java.util.*;

public class Main {
    static int fact(int n) {
        if (n <= 1) return 1;
        return n * fact(n - 1);
    }

    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt();
        int f = fact(n);
        System.out.println(n + "! = " + f);
    }
}
`;

test('Java: every line of main and of the method, with the variables and the call stack', {skip}, async() => {
    const r = await debug(FACT, () => [{type: 'step'}], '3');
    const trail = r.pauses.map((p) => `${p.func}:${p.line}`);
    assert.deepEqual(trail.slice(0, 6), ['main:10', 'main:11', 'main:12', 'fact:5', 'fact:6', 'fact:5'], trail.join(' '));
    const deepest = r.pauses.find((p) => p.stack.length === 4);
    assert.ok(deepest, trail.join(' '));
    assert.deepEqual(deepest.stack.map((f) => f.func), ['fact', 'fact', 'fact', 'main']);
    assert.deepEqual(deepest.stack.slice(0, 3).map((f) => f.vars.find((v) => v.name === 'n').value), ['1', '2', '3']);
    assert.equal(r.out, '3! = 6\n');
    assert.equal(r.exit.status, 'ok');
});

test('Java: input typed while paused, Step over and out', {skip}, async() => {
    const over = await debug(FACT, (p) => [p.line === 11 ? {type: 'stdin', data: '4\n'} : null, {type: 'next'}]
        .filter(Boolean));
    assert.deepEqual(over.pauses.map((p) => `${p.func}:${p.line}`).slice(0, 4), ['main:10', 'main:11', 'main:12', 'main:13']);
    assert.equal(over.out, '4! = 24\n');
    assert.equal(over.exit.status, 'ok');
    const out = await debug(FACT, (p) => [{type: p.func === 'fact' ? 'out' : 'step'}], '2');
    const trail = out.pauses.map((p) => `${p.func}:${p.line}`);
    assert.ok(trail.includes('fact:5'), trail.join(' '));
    assert.equal(trail[trail.indexOf('fact:5') + 1], 'main:12', trail.join(' '));
    assert.equal(out.exit.status, 'ok');
});

test('Java: breakpoints and conditions, Run stops only there', {skip}, async() => {
    const r = await debug(FACT, () => [{type: 'continue'}], '4', {step: false, breakpoints: [{line: 5, condition: 'n == 2'}]});
    assert.equal(r.pauses.length, 1);
    assert.equal(r.pauses[0].line, 5);
    assert.equal(r.pauses[0].vars.find((v) => v.name === 'n').value, '2');
    assert.equal(r.out, '4! = 24\n');
    const none = await debug(FACT, () => [{type: 'continue'}], '3', {step: false});
    assert.equal(none.pauses.length, 0);
    assert.equal(none.out, '3! = 6\n');
    assert.equal(none.exit.status, 'ok');
});

test('Java: arrays, lists, maps, sets and objects shown with their contents; watches', {skip}, async() => {
    const code = `import java.util.*;

public class Main {
    static class Node {
        int value;
        Node next;
        Node(int value, Node next) { this.value = value; this.next = next; }
    }

    public static void main(String[] args) {
        int[] a = {5, 6, 7};
        int[][] grid = {{1, 2}, {3, 4}};
        List<Integer> list = new ArrayList<>(List.of(3, 1, 2));
        Map<String, Integer> ages = new LinkedHashMap<>();
        ages.put("Ana", 16);
        ages.put("Marko", 17);
        Set<Integer> set = new HashSet<>(List.of(8));
        Node head = new Node(1, new Node(2, null));
        String s = "hi";
        System.out.println(a.length + list.size());
    }
}
`;
    const r = await debug(code, () => [{type: 'continue'}], '', {step: false, breakpoints: [20],
        watches: ['list.size() * 10', 'head.next.value', 'missing', 'a[1] + grid[1][0]']});
    assert.equal(r.pauses.length, 1);
    const value = (name) => r.pauses[0].vars.find((v) => v.name === name)?.value;
    assert.equal(value('a'), '{5, 6, 7}');
    assert.equal(value('grid'), '{{1, 2}, {3, 4}}');
    assert.equal(value('list'), '{3, 1, 2}');
    assert.equal(value('ages'), '{["Ana"] = 16, ["Marko"] = 17}');
    assert.equal(value('set'), '{8}');
    assert.equal(value('head'), '{value = 1, next = {Node}}');
    assert.equal(value('s'), '"hi"');
    assert.deepEqual(r.pauses[0].watches, [{expr: 'list.size() * 10', value: '30'}, {expr: 'head.next.value', value: '2'},
        {expr: 'missing', value: null}, {expr: 'a[1] + grid[1][0]', value: '9'}]);
    assert.equal(r.out, '6\n');
    assert.equal(r.exit.status, 'ok');
});

test('Java: an uncaught exception ends the run with the runtime status and its message', {skip}, async() => {
    const code = 'public class Main {\n    public static void main(String[] args) {\n        int z = 0;\n' +
        '        System.out.println(1 / z);\n    }\n}\n';
    const r = await debug(code, () => [{type: 'continue'}]);
    assert.equal(r.exit.status, 'runtime');
    assert.match(r.err, /ArithmeticException/);
});

test('Java: a compile error is reported as for Run', {skip}, async() => {
    const r = await debug('public class Main { public static void main(String[] a) { int x = "a"; } }', () => []);
    assert.equal(r.exit.type, 'compile');
    assert.match(r.exit.output, /incompatible types/);
});
