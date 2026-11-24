// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the real Java analyzer (java-analyzer/, built by javac with the first request). Skipped without a JDK. The
 * texts of the tooltips come from the JDK's src.zip (package openjdk-21-source); without it they have no documentation.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanRequest, javaAnalyzer, javaSourcePath} from '../lib/analysis.js';

const skip = javaSourcePath() === '' ? 'no JDK (javac)' : false;
const analyzer = javaAnalyzer({idleMs: 0, timeoutMs: 120000});
after(() => analyzer.stop());

const code = 'import java.util.*;\n\npublic class Zadatak {\n    public static void main(String[] args) {\n' +
    '        List<Integer> lista = new ArrayList<>();\n        lista.add(5);\n        System.out.println(lista.size());\n' +
    '        int x = "abc";\n        Scanner sc = new Scanner(System.in);\n    }\n}\n';
const ask = (request) => analyzer.ask(cleanRequest(request));

test('completion: members of a List, static members of Math, names in scope', {skip}, async() => {
    const list = (await ask({op: 'complete', code, line: 6, column: 15})).items.map((i) => i.label);
    assert.ok(['add', 'size', 'get', 'stream'].every((n) => list.includes(n)), list.join());
    const math = code.replace('int x = "abc";', 'double d = Math.');
    const statics = (await ask({op: 'complete', code: math, line: 8, column: 25})).items.map((i) => i.label);
    assert.ok(statics.includes('sqrt') && statics.includes('PI') && !statics.includes('add'));
    const items = (await ask({op: 'complete', code, line: 9, column: 11})).items;
    const names = items.map((i) => i.label);
    assert.ok(['lista', 'args', 'Scanner', 'String', 'for'].every((n) => names.includes(n)));
    // this is offered once, as a keyword, not as a field of the class.
    assert.deepEqual(items.filter((i) => i.label === 'this').map((i) => i.kind), ['Keyword']);
});

test('tooltips: declaration, and the Javadoc when src.zip is there', {skip}, async() => {
    const add = await ask({op: 'hover', code, line: 6, column: 16});
    assert.match(add.markdown[0], /boolean List\.add\(E e\)/);
    const scanner = await ask({op: 'hover', code, line: 9, column: 10});
    assert.match(scanner.markdown[0], /class java\.util\.Scanner/);
    const local = await ask({op: 'hover', code, line: 7, column: 30});
    assert.match(local.markdown[0], /List<Integer> lista \(local variable\)/);
});

test('signatures choose the overload of the argument', {skip}, async() => {
    const println = await ask({op: 'signatures', code, line: 7, column: 28});
    assert.equal(println.signatures[println.active].label, 'void println(int x)');
    const scanner = await ask({op: 'signatures', code, line: 9, column: 34});
    assert.equal(scanner.signatures[scanner.active].label, 'Scanner(InputStream source)');
});

test('errors in the culture asked for, with the main file named after its public class and the other files', {skip},
    async() => {
        const errors = await ask({op: 'diagnostics', code});
        assert.equal(errors.main, 'Zadatak.java');
        assert.deepEqual(errors.items.map((e) => [e.code, e.line]), [['compiler.err.prob.found.req', 8]]);
        const german = await ask({op: 'diagnostics', code, culture: 'de'});
        assert.match(german.items[0].message, /konvertiert/);
        const helper = code.replace('int x = "abc";', 'int y = Helper.twice(3);');
        assert.equal((await ask({op: 'diagnostics', code: helper})).items[0].code, 'compiler.err.cant.resolve.location');
        const files = [{name: 'Helper.java', code: 'class Helper {\n    static int twice(int n) { return 2 * n; }\n}\n'}];
        assert.deepEqual((await ask({op: 'diagnostics', code: helper, files})).items, []);
    });
