// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the errors clients get: never empty and without anything of the server, also when the sandbox cannot start
 * (no sandbox needed: the tests take bubblewrap away).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MESSAGES, clientError, compileFailure, nonEmpty} from '../lib/errors.js';
import {Session} from '../lib/session.js';
import {runBatch} from '../lib/batch.js';

/**
 * Run a function while no program can be found, so the sandbox cannot start.
 *
 * @param {function(): Promise<*>} fn
 * @returns {Promise<*>}
 */
const withoutSandbox = async(fn) => {
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent-codelab-path';
    try {
        return await fn();
    } finally {
        process.env.PATH = path;
    }
};

/**
 * Start a session and collect its messages until it closes.
 *
 * @param {Object} start the start message
 * @returns {Promise<Object[]>}
 */
const session = (start) => new Promise((resolve) => {
    const messages = [];
    const s = new Session((m) => messages.push(m), () => resolve(messages));
    s.handle({type: 'start', ...start});
});

test('a busy server is named, other errors get the given text, never an empty one', () => {
    assert.equal(clientError(Object.assign(new Error('fork failed'), {code: 'EAGAIN'})), MESSAGES.busy);
    assert.equal(clientError(Object.assign(new Error(''), {code: 'EMFILE'}), MESSAGES.start), MESSAGES.busy);
    assert.equal(clientError(new Error("ENOENT: open '/tmp/codelab-x/in.fifo'"), MESSAGES.start), MESSAGES.start);
    assert.equal(clientError(undefined), MESSAGES.internal);
    assert.equal(nonEmpty(''), MESSAGES.internal);
    assert.equal(nonEmpty('  \n'), MESSAGES.internal);
    assert.equal(nonEmpty(undefined), MESSAGES.internal);
    assert.equal(nonEmpty('Unknown language.'), 'Unknown language.');
    for (const text of Object.values(MESSAGES)) {
        assert.ok(text.trim() !== '' && !text.includes('/'), text);
    }
});

test('a compiler that printed nothing gets a reason', () => {
    assert.equal(compileFailure({code: 1, signal: null, output: 'x.c:1: error'}), 'x.c:1: error');
    assert.equal(compileFailure({code: null, signal: 'SIGKILL', output: ''}), 'The compiler was stopped (SIGKILL).');
    assert.equal(compileFailure({code: 1, signal: null, output: ' \n'}), 'The compiler ended with code 1 and no message.');
});

test('a session whose program cannot start ends with a short error', async() => {
    const messages = await withoutSandbox(() => session({lang: 'python', code: 'print(1)'}));
    const errors = messages.filter((m) => m.type === 'error');
    assert.equal(errors.length, 1, JSON.stringify(messages));
    assert.ok([MESSAGES.start, MESSAGES.busy].includes(errors[0].message), errors[0].message);
    // No exit after the error.
    assert.equal(messages.filter((m) => m.type === 'exit').length, 0);
});

test('a compiler that cannot start gives a compile message, not an empty one', async() => {
    const messages = await withoutSandbox(() => session({lang: 'c', code: 'int main(void) { return 0; }'}));
    const compile = messages.find((m) => m.type === 'compile');
    assert.ok(compile, JSON.stringify(messages));
    assert.equal(compile.ok, false);
    assert.ok([MESSAGES.compiler, MESSAGES.busy].includes(compile.output), compile.output);
});

test('a run for grading whose program cannot start says so', async() => {
    const result = await withoutSandbox(() => runBatch({lang: 'python', code: 'print(1)', stdin: ''}));
    assert.equal(result.status, 'error');
    assert.ok([MESSAGES.start, MESSAGES.busy].includes(result.stderr), result.stderr);
});

test('an error with an empty message still reaches the client as text', async() => {
    const messages = [];
    await new Session((m) => messages.push(m), () => undefined).fail('');
    assert.deepEqual(messages, [{type: 'error', message: MESSAGES.internal}]);
});
