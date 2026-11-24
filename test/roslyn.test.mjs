// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the real Roslyn analyzer (roslyn/publish, built with dotnet publish -c Release -o publish). Skipped when it
 * is not published.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import {Analyzer, analyzerPath, cleanRequest} from '../lib/analysis.js';

const dll = analyzerPath();
const skip = dll === '' ? 'roslyn/publish is not built' : false;
const analyzer = new Analyzer({dll, idleMs: 0, timeoutMs: 60000});
after(() => analyzer.stop());

const code = 'using System;\nusing System.Collections.Generic;\n\nclass Program\n{\n    static void Main()\n    {\n' +
    '        var list = new List<int>();\n        list.Add(5);\n        Console.WriteLine(list.Count);\n        int x = "abc";\n    }\n}\n';
const ask = (request) => analyzer.ask(cleanRequest(request));

test('completion lists the members of List<int>', {skip}, async() => {
    const answer = await ask({op: 'complete', code, line: 9, column: 14});
    const labels = answer.items.map((i) => i.label);
    assert.ok(labels.includes('Add') && labels.includes('AddRange') && labels.includes('Count'), labels.slice(0, 20).join());
    assert.equal(answer.items.find((i) => i.label === 'Add').kind, 'Method');
});

test('the tooltip has the declaration and the .NET documentation', {skip}, async() => {
    const answer = await ask({op: 'hover', code, line: 9, column: 15});
    assert.match(answer.markdown[0], /void List<int>\.Add\(int item\)/);
    assert.match(answer.markdown[1], /Adds an object to the end/);
});

test('signatures choose the overload of the argument', {skip}, async() => {
    const answer = await ask({op: 'signatures', code, line: 10, column: 27});
    assert.ok(answer.signatures.length > 10);
    assert.equal(answer.signatures[answer.active].label, 'void WriteLine(int value)');
});

test('errors as C# 7.3, in the culture asked for, with the other files', {skip}, async() => {
    const errors = (await ask({op: 'diagnostics', code})).items;
    assert.deepEqual(errors.map((e) => [e.code, e.line]), [['CS0029', 11]]);
    const german = (await ask({op: 'diagnostics', code, culture: 'de'})).items[0].message;
    assert.match(german, /konvertiert/);
    const newer = (await ask({op: 'diagnostics', code: code.replace('int x = "abc";', 'int? z = null; z ??= 3;')})).items;
    assert.deepEqual(newer.map((e) => e.code), ['CS8370']);
    const helper = code.replace('int x = "abc";', 'int y = Helper.Twice(3);');
    assert.deepEqual((await ask({op: 'diagnostics', code: helper})).items.map((e) => e.code), ['CS0103']);
    const files = [{name: 'Helper.cs', code: 'class Helper\n{\n    public static int Twice(int n) { return 2 * n; }\n}\n'}];
    assert.deepEqual((await ask({op: 'diagnostics', code: helper, files})).items, []);
});
