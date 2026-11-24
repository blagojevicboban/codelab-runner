// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the C and C++ language service with the real clangd (lib/clangd.js). Skipped without clangd.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanRequest} from '../lib/analysis.js';
import {ClangdService, clangdPath, completions, diagnosticsOf, flagsOf} from '../lib/clangd.js';

const skip = clangdPath() === '' ? 'no clangd' : false;
const service = new ClangdService({idleMs: 0, timeoutMs: 60000, slots: 2});
after(() => service.stop());

const ask = (request, lang) => service.ask(cleanRequest(request), lang);

const cpp = '#include <iostream>\n#include <vector>\nusing namespace std;\n\nint main() {\n    vector<int> v;\n' +
    '    v.push_back(5);\n    cout << v.size() << endl;\n    int x = "abc";\n    return 0;\n}\n';
const c = '#include <stdio.h>\n\nint main(void) {\n    int n = 5;\n    printf("%d\\n", n);\n    \n    return 0;\n}\n';

test('flags follow the compiler profile and the standard', () => {
    assert.deepEqual(flagsOf('c', {compiler: 'gcc', std: 'c11'}, '/w'), ['-xc', '-std=c11', '-D_GNU_SOURCE', '-I', '/w']);
    const msvc = flagsOf('cpp', {compiler: 'msvc', std: 'c++20'}, '/w');
    assert.equal(msvc[1], '-std=c++20');
    assert.ok(msvc.includes('-include') && msvc.some((f) => f.endsWith('codelab_msvc.h')));
});

test('completions: one item per name, overloads counted, names without the parameters', () => {
    const {items} = completions([
        {label: ' push_back(const int &x)', kind: 2, detail: 'void', textEdit: {newText: 'push_back'}, sortText: '1'},
        {label: ' push_back(int &&x)', kind: 2, detail: 'void', textEdit: {newText: 'push_back'}, sortText: '1'},
        {label: ' size()', kind: 2, detail: 'size_type', insertText: 'size', sortText: '2'},
    ]);
    assert.deepEqual(items.map((i) => [i.label, i.kind, i.detail]), [
        ['push_back', 'Method', 'void push_back(const int &x)  (+1 overload)'], ['size', 'Method', 'size_type size()']]);
});

test('errors and warnings only, 1-based', () => {
    const items = diagnosticsOf([
        {severity: 1, code: 'init_conversion_failed', message: 'no', range: {start: {line: 8, character: 8},
            end: {line: 8, character: 9}}},
        {severity: 3, message: 'note', range: {start: {line: 0, character: 0}, end: {line: 0, character: 1}}},
    ], 'prog.cpp');
    assert.deepEqual(items, [{file: 'prog.cpp', severity: 'error', code: 'init_conversion_failed', message: 'no',
        line: 9, column: 9, endLine: 9, endColumn: 10}]);
});

test('C++: members of a vector, hover, signatures and errors', {skip}, async() => {
    const members = (await ask({op: 'complete', code: cpp, line: 7, column: 7}, 'cpp')).items.map((i) => i.label);
    assert.ok(['push_back', 'size', 'begin'].every((n) => members.includes(n)), members.slice(0, 20).join());
    const hover = await ask({op: 'hover', code: cpp, line: 7, column: 8}, 'cpp');
    assert.match(hover.markdown[0], /push_back/);
    assert.equal(hover.line, 7);
    const help = await ask({op: 'signatures', code: cpp, line: 7, column: 17}, 'cpp');
    assert.ok(help.signatures.length >= 1 && /push_back/.test(help.signatures[0].label));
    const errors = await ask({op: 'diagnostics', code: cpp}, 'cpp');
    assert.equal(errors.main, 'prog.cpp');
    assert.deepEqual(errors.items.filter((e) => e.severity === 'error').map((e) => e.line), [9]);
    const describe = await ask({op: 'describe', code: cpp, line: 7, column: 7, item: 'size'}, 'cpp');
    assert.match(describe.text, /size\(\)/);
});

test('C: names in scope, printf signature, format warning, the standard, other files', {skip}, async() => {
    const names = (await ask({op: 'complete', code: c, line: 6, column: 5}, 'c')).items.map((i) => i.label);
    assert.ok(names.includes('n') && names.includes('printf'));
    const help = await ask({op: 'signatures', code: c, line: 5, column: 12}, 'c');
    assert.match(help.signatures[0].label, /printf/);
    assert.equal(help.parameter, 0);
    const wrong = c.replace('"%d\\n", n', '"%s\\n", n');
    const warnings = (await ask({op: 'diagnostics', code: wrong}, 'c')).items;
    assert.ok(warnings.some((w) => w.severity === 'warning' && w.line === 5), JSON.stringify(warnings));
    assert.deepEqual((await ask({op: 'diagnostics', code: c}, 'c')).items, []);
    // bool is a keyword only from C23 on.
    const c23 = '#include <stdio.h>\nint main(void) {\n    bool ok = true;\n    return ok ? 0 : 1;\n}\n';
    assert.ok((await ask({op: 'diagnostics', code: c23, std: 'c11'}, 'c')).items.length > 0);
    assert.deepEqual((await ask({op: 'diagnostics', code: c23, std: 'c23'}, 'c')).items, []);
    const helper = '#include "helper.h"\nint main(void) {\n    return twice(3);\n}\n';
    assert.ok((await ask({op: 'diagnostics', code: helper}, 'c')).items.length > 0);
    const files = [{name: 'helper.h', code: 'static inline int twice(int n) { return 2 * n; }\n'}];
    assert.deepEqual((await ask({op: 'diagnostics', code: helper, files}, 'c')).items, []);
    // An error in the other file is shown at its #include, without the folder of the server.
    // (Not in a function body: clangd skips the bodies of functions in headers.)
    const broken = [{name: 'helper.h', code: 'foo twice(int n);\n'}];
    const included = (await ask({op: 'diagnostics', code: helper, files: broken}, 'c')).items;
    assert.equal(included[0].line, 1);
    assert.ok(included.every((e) => !e.message.includes(service.root)), JSON.stringify(included));
    // The msvc profile knows the functions of Visual Studio.
    const scanf = '#include <stdio.h>\nint main(void) {\n    int a;\n    scanf_s("%d", &a);\n    return a;\n}\n';
    assert.deepEqual((await ask({op: 'diagnostics', code: scanf, compiler: 'msvc'}, 'c')).items
        .filter((e) => e.severity === 'error'), []);
});
