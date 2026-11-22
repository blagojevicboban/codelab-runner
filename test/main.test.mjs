// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the start check of server.js (isMain): the server starts when Node runs it, also from a path with spaces,
 * and not when it is imported (no sandbox needed).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isMain} from '../server.js';

test('a script in a folder with a space is its own main module, another module is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'code lab '));
    try {
        const script = join(dir, 'start check.mjs');
        // The script asks isMain about itself and about server.js, as server.js asks about itself.
        writeFileSync(script, `import {isMain} from ${JSON.stringify(new URL('../server.js', import.meta.url).href)};
process.stdout.write(JSON.stringify([isMain(import.meta.url, process.argv[1]),
    isMain(${JSON.stringify(new URL('../server.js', import.meta.url).href)}, process.argv[1])]));
`);
        const out = execFileSync(process.execPath, [script], {encoding: 'utf8', timeout: 20000});
        assert.deepEqual(JSON.parse(out), [true, false]);
        // The check this replaces did not see it: the URL has %20 where the path has a space.
        assert.notEqual(pathToFileURL(script).href, `file://${script}`);
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});

test('without a script path nothing is the main module', () => {
    const url = new URL('../server.js', import.meta.url).href;
    assert.equal(isMain(url, undefined), false);
    assert.equal(isMain(url, ''), false);
    assert.equal(isMain(url, fileURLToPath(url)), true);
});

test('importing server.js does not start a server', () => {
    // A server that started would keep the process running until the timeout.
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
        `await import(${JSON.stringify(new URL('../server.js', import.meta.url).href)}); process.stdout.write('imported');`],
    {encoding: 'utf8', timeout: 20000});
    assert.equal(out, 'imported');
});
