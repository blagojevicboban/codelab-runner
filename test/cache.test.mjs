// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the cache of compiled programs (the Java test needs Linux with bwrap and javac).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cacheKey, prune} from '../lib/cache.js';
import {Program} from '../lib/sandbox.js';

let root;

before(async() => {
    root = await mkdtemp(join(tmpdir(), 'codelab-cache-test-'));
    process.env.CODELAB_CACHE = root;
});
after(async() => {
    delete process.env.CODELAB_CACHE;
    delete process.env.CODELAB_CACHE_MB;
    await rm(root, {recursive: true, force: true});
});

test('the key depends on the language, the mode and the code', () => {
    const key = cacheKey('c', false, 'prog.c', 'int main(void) {}');
    assert.equal(key, cacheKey('c', false, 'prog.c', 'int main(void) {}'));
    assert.notEqual(key, cacheKey('cpp', false, 'prog.c', 'int main(void) {}'));
    assert.notEqual(key, cacheKey('c', true, 'prog.c', 'int main(void) {}'));
    assert.notEqual(key, cacheKey('c', false, 'prog.c', 'int main(void) { }'));
});

test('the oldest entries go when the cache is too large', async() => {
    const dir = await mkdtemp(join(tmpdir(), 'codelab-prune-'));
    try {
        for (const [name, age] of [['old', 300], ['mid', 200], ['new', 100]]) {
            await mkdir(join(dir, name));
            await writeFile(join(dir, name, 'prog'), Buffer.alloc(600 * 1024));
            const time = new Date(Date.now() - age * 1000);
            await utimes(join(dir, name), time, time);
        }
        process.env.CODELAB_CACHE_MB = '1';
        await prune(dir);
        assert.deepEqual((await readdir(dir)).sort(), ['new']);
    } finally {
        delete process.env.CODELAB_CACHE_MB;
        await rm(dir, {recursive: true, force: true});
    }
});

test('a Java program is compiled once, then taken from the cache', {skip: process.platform !== 'linux'}, async() => {
    const code = 'public class Hello {\n    public static void main(String[] a) {\n        System.out.println("hi");\n    }\n}\n';
    const run = async() => {
        const program = new Program('java', code);
        const started = Date.now();
        const compiled = await program.compile();
        const ms = Date.now() - started;
        assert.equal(compiled.ok, true, compiled.output);
        const child = program.start(10);
        let out = '';
        child.stdout.on('data', (c) => (out += c));
        child.stdin.end();
        await new Promise((resolve) => child.on('close', resolve));
        await program.dispose();
        return {cached: Boolean(program.cached), ms, out};
    };
    const first = await run();
    const second = await run();
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.out, 'hi\n');
    assert.ok(second.ms < first.ms, `${second.ms} ms from the cache, ${first.ms} ms compiling`);
    // A changed program is compiled again.
    const other = new Program('java', code.replace('hi', 'hello'));
    await other.compile();
    assert.equal(Boolean(other.cached), false);
    await other.dispose();
});
