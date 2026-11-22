// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Unit tests for compiler profiles, standards and cache keys (runs without bubblewrap).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCompileOptions} from '../lib/compiler.js';
import {cacheKey} from '../lib/cache.js';

test('normalizeCompileOptions accepts whitelisted compilers and standards and rejects arbitrary flags', () => {
    assert.deepEqual(normalizeCompileOptions('c'), {ok: true, options: {compiler: 'gcc', std: 'c11', key: 'gcc:c11'}});
    assert.deepEqual(normalizeCompileOptions('c', {compiler: 'c-msvc', std: 'c17'}),
        {ok: true, options: {compiler: 'msvc', std: 'c17', key: 'msvc:c17'}});
    assert.deepEqual(normalizeCompileOptions('cpp', {compiler: 'clang', std: '20'}),
        {ok: true, options: {compiler: 'clang', std: 'c++20', key: 'clang:c++20'}});
    assert.deepEqual(normalizeCompileOptions('python', {compiler: 'msvc'}), {ok: true, options: null});

    assert.equal(normalizeCompileOptions('c', {compiler: 'gcc -O3'}).ok, false);
    assert.equal(normalizeCompileOptions('c', {std: 'c++17'}).ok, false);
    assert.equal(normalizeCompileOptions('cpp', {std: 'c99'}).ok, false);
});

test('cacheKey separates different compiler profiles and standards', () => {
    const a = cacheKey('c', false, 'prog.c', 'int main(){}', 'gcc:c11');
    const b = cacheKey('c', false, 'prog.c', 'int main(){}', 'msvc:c11');
    const c = cacheKey('c', false, 'prog.c', 'int main(){}', 'gcc:c17');
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.notEqual(b, c);
});
