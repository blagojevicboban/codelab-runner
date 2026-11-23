// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the Jobe mode of runs for grading: the status and the memory limits (no sandbox needed).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {limitsOf, statusOf} from '../lib/batch.js';
import {javaClass} from '../lib/sandbox.js';

const run = (fields) => statusOf({exitcode: 0, signal: null, stderr: '', toolong: false, wallStop: false, jobe: true,
    ...fields});

test('status in the Jobe mode', () => {
    assert.equal(run({}), 'ok');
    assert.equal(run({exitcode: 1}), 'ok');
    assert.equal(run({stderr: 'dbg\n'}), 'runtime');
    assert.equal(run({exitcode: 139}), 'runtime');
    assert.equal(run({exitcode: null, signal: 'SIGSEGV'}), 'runtime');
    assert.equal(run({exitcode: 152}), 'time');
    assert.equal(run({exitcode: 137}), 'time');
    assert.equal(run({exitcode: null, signal: 'SIGKILL', wallStop: true}), 'time');
    assert.equal(run({exitcode: 1, stderr: 'Traceback\nMemoryError\n'}), 'memory');
    assert.equal(run({toolong: true, stderr: 'x'}), 'toolong');
});

test('status in the runner mode', () => {
    assert.equal(run({jobe: false, stderr: 'dbg\n'}), 'ok');
    assert.equal(run({jobe: false, exitcode: 1}), 'runtime');
    assert.equal(run({jobe: false, exitcode: null, signal: 'SIGKILL', wallStop: true}), 'time');
});

test('memory limits', () => {
    assert.deepEqual(limitsOf('c', undefined, true), {mem: 400, heap: null});
    assert.deepEqual(limitsOf('c', undefined, false), {mem: 256, heap: null});
    assert.deepEqual(limitsOf('c', 5000, true), {mem: 2048, heap: null});
    assert.deepEqual(limitsOf('python', undefined, true), {mem: 1500, heap: null});
    assert.deepEqual(limitsOf('python', 100, true), {mem: 100, heap: null});
    assert.deepEqual(limitsOf('java', undefined, true), {mem: 4096, heap: 200});
    assert.deepEqual(limitsOf('java', undefined, false), {mem: 4096, heap: 256});
    assert.deepEqual(limitsOf('java', 2000, true), {mem: 6048, heap: 2000});
    assert.deepEqual(limitsOf('javascript', undefined, true), {mem: 4096, heap: 512});
    assert.deepEqual(limitsOf('csharp', 1000, true), {mem: 4096, heap: 1000});
    assert.deepEqual(limitsOf('mysql', undefined, true), {mem: 256, heap: null});
});

test('the class a Java program runs as: the public class, else the class with main', () => {
    assert.equal(javaClass('import java.util.*;\npublic class Zbir {\n}'), 'Zbir');
    assert.equal(javaClass('class Helper {}'), 'Main');
    assert.equal(javaClass('class Zadatak {\n    public static void main(String[] args) {}\n}\n'), 'Zadatak');
    assert.equal(javaClass('class Tacka { int x; }\nclass App { static public void main(String[] a) {} }\n'), 'App');
    assert.equal(javaClass('class Pomocna { void f() {} }\nfinal class Glavna {\n  public static void main(String... a) {}\n}\n'),
        'Glavna');
});
