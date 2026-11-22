// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Unit tests for input and output file handling (runs without bubblewrap).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MAX_FILES, MAX_FILE_SIZE, normalizeFiles, readChangedFiles, validFileName, writeInputFiles} from '../lib/files.js';

test('validFileName accepts simple names and rejects paths and special characters', () => {
    assert.equal(validFileName('input.txt'), true);
    assert.equal(validFileName('my_data_2.csv'), true);
    assert.equal(validFileName('data'), true);
    assert.equal(validFileName(''), false);
    assert.equal(validFileName('../secret'), false);
    assert.equal(validFileName('a/b.txt'), false);
    assert.equal(validFileName('.hidden'), false);
    assert.equal(validFileName('a.b.c'), false);
    assert.equal(validFileName('a-b.txt'), false);
    assert.equal(validFileName('a'.repeat(41)), false);
});

test('normalizeFiles validates count, names, duplicates and size', () => {
    assert.deepEqual(normalizeFiles(undefined), {ok: true, files: []});
    assert.deepEqual(normalizeFiles([{name: 'in.txt', text: '1 2\n'}]), {ok: true, files: [{name: 'in.txt', text: '1 2\n'}]});
    assert.equal(normalizeFiles('not-array').ok, false);
    const tooMany = Array.from({length: MAX_FILES + 1}, (_, i) => ({name: `f${i}.txt`, text: ''}));
    assert.equal(normalizeFiles(tooMany).ok, false);
    assert.equal(normalizeFiles([{name: 'a.txt', text: '1'}, {name: 'a.txt', text: '2'}]).ok, false);
    assert.equal(normalizeFiles([{name: '../a', text: '1'}]).ok, false);
    assert.equal(normalizeFiles([{name: 'big.txt', text: 'x'.repeat(MAX_FILE_SIZE + 1)}]).ok, false);
});

test('writeInputFiles and readChangedFiles return only created or modified regular files', async() => {
    const dir = await mkdtemp(join(tmpdir(), 'codelab-files-test-'));
    try {
        const given = await writeInputFiles(dir, [
            {name: 'unchanged.txt', text: 'hello\n'},
            {name: 'edited.txt', text: 'before\n'},
        ]);
        await writeFile(join(dir, 'edited.txt'), 'after\n', 'utf8');
        await writeFile(join(dir, 'created.txt'), 'new file\n', 'utf8');
        await mkdir(join(dir, 'subdir'));
        const changed = await readChangedFiles(dir, given);
        assert.deepEqual(changed, [
            {name: 'created.txt', text: 'new file\n', size: 9},
            {name: 'edited.txt', text: 'after\n', size: 6},
        ]);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});

test('readChangedFiles truncates files larger than MAX_FILE_SIZE and reports full size', async() => {
    const dir = await mkdtemp(join(tmpdir(), 'codelab-files-big-'));
    try {
        const big = 'a'.repeat(MAX_FILE_SIZE + 100);
        await writeFile(join(dir, 'out.txt'), big, 'utf8');
        const changed = await readChangedFiles(dir, new Map());
        assert.equal(changed.length, 1);
        assert.equal(changed[0].name, 'out.txt');
        assert.equal(changed[0].text.length, MAX_FILE_SIZE);
        assert.equal(changed[0].size, MAX_FILE_SIZE + 100);
    } finally {
        await rm(dir, {recursive: true, force: true});
    }
});
