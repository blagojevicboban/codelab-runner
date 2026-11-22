// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the runs for grading (POST /run), signed by Moodle's server.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac, randomBytes} from 'node:crypto';
import {startServer} from '../server.js';
import {languageAvailable} from '../lib/sandbox.js';

const SECRET = 'test-secret-of-sixteen-or-more';
let server;
let url;

before(async() => {
    server = await startServer({port: 0, host: '127.0.0.1', secret: SECRET});
    url = `http://127.0.0.1:${server.address().port}/run`;
});
after(() => server.close());

/**
 * Send a run, signed as Moodle does.
 *
 * @param {Object} request
 * @param {string} [secret]
 * @param {string} [nonce]
 * @returns {Promise<{code: number, data: Object}>}
 */
const post = async(request, secret = SECRET, nonce = randomBytes(12).toString('base64url')) => {
    const body = JSON.stringify(request);
    const time = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret).update(`${time}\n${nonce}\n${body}`).digest('base64url');
    const res = await fetch(url, {method: 'POST', body, headers: {'Content-Type': 'application/json', 'X-CodeLab-Time': time,
        'X-CodeLab-Nonce': nonce, 'X-CodeLab-Signature': signature}});
    return {code: res.status, data: await res.json()};
};

/**
 * The answer without its time, which differs from run to run.
 *
 * @param {Object} data
 * @returns {Object}
 */
const timeless = ({time, ...rest}) => rest;

test('a C program with its input, as from Jobe', async() => {
    const code = '#include <stdio.h>\nint main(void) { int a, b; scanf("%d %d", &a, &b); printf("%d\\n", a + b); return 0; }\n';
    const r = await post({lang: 'c', code, stdin: '20 22'});
    assert.equal(r.code, 200);
    assert.deepEqual(timeless(r.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    const bad = await post({lang: 'c', code: 'int main(void) { return x; }'});
    assert.equal(bad.data.status, 'compile');
});

test('the time of a run: seconds with 3 decimals, without the compilation, none when nothing ran', async() => {
    const quick = await post({lang: 'c', code: 'int main(void) { return 0; }'});
    assert.equal(typeof quick.data.time, 'number');
    assert.ok(quick.data.time >= 0 && quick.data.time < 2, `time ${quick.data.time}`);
    assert.equal(quick.data.time, Math.round(quick.data.time * 1000) / 1000);
    const slow = await post({lang: 'python', code: 'import time\ntime.sleep(0.5)\n'});
    assert.equal(slow.data.status, 'ok');
    assert.ok(slow.data.time >= 0.5 && slow.data.time < 5, `time ${slow.data.time}`);
    // A failed or endless program has its time too; a compilation error and a refused request have none.
    const failed = await post({lang: 'python', code: 'raise SystemExit(3)'});
    assert.equal(failed.data.status, 'runtime');
    assert.equal(typeof failed.data.time, 'number');
    const bad = await post({lang: 'c', code: 'int main(void) { return x; }'});
    assert.equal(bad.data.time, undefined);
    const unknown = await post({lang: 'cobol', code: 'x'});
    assert.equal(unknown.data.time, undefined);
});

test('SQL gives only the tables, in a database of its own', {skip: !process.env.CODELAB_MYSQL_PASSWORD}, async() => {
    const code = 'CREATE TABLE t (a INT, b VARCHAR(10));\nINSERT INTO t VALUES (1, \'jedan\'), (2, \'dva\');\n' +
        'SELECT * FROM t ORDER BY a;\n';
    const r = await post({lang: 'mysql', code});
    assert.equal(r.data.status, 'ok');
    assert.equal(r.data.stdout, '+------+-------+\n| a    | b     |\n+------+-------+\n|    1 | jedan |\n|    2 | dva   |\n' +
        '+------+-------+\n');
    assert.equal(r.data.time, undefined);
    const error = await post({lang: 'mysql', code: 'SELECT * FROM nema;'});
    assert.equal(error.data.status, 'runtime');
    assert.match(error.data.stderr, /ERROR 1146/);
});

test('a request without the right signature is refused', async() => {
    const r = await post({lang: 'c', code: 'int main(void) { return 0; }'}, 'another-secret-of-sixteen');
    assert.equal(r.code, 401);
});

test('a request sent again is refused', async() => {
    const request = {lang: 'c', code: 'int main(void) { return 0; }'};
    const first = await post(request, SECRET, 'the-same-nonce-0001');
    assert.equal(first.code, 200);
    const again = await post(request, SECRET, 'the-same-nonce-0001');
    assert.equal(again.code, 401);
});

test('Python and PHP programs run in batch mode', async() => {
    const py = await post({lang: 'python', code: 'print(int(input()) * 2)', stdin: '21\n'});
    assert.deepEqual(timeless(py.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    const php = await post({lang: 'php', code: '<?php echo trim(fgets(STDIN)) . "!"; ?>', stdin: 'hi\n'});
    // Only the status and the output: a PHP with extensions such as snmp writes notes to stderr when it starts.
    assert.deepEqual([php.data.status, php.data.stdout], ['ok', 'hi!']);
});

test('JavaScript and Pascal programs run in batch mode when installed', async(t) => {
    if (languageAvailable('javascript')) {
        const js = await post({lang: 'javascript', code: 'console.log(require("fs").readFileSync(0,"utf8").trim());', stdin: 'ok'});
        assert.deepEqual(timeless(js.data), {status: 'ok', stdout: 'ok\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('node not in /usr/bin, skipping javascript');
    }
    if (languageAvailable('pascal')) {
        const pas = await post({lang: 'pascal', code: 'var x: integer; begin readln(x); writeln(x + 1); end.', stdin: '41\n'});
        assert.deepEqual(timeless(pas.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('fpc not in /usr/bin, skipping pascal');
    }
});

test('a JavaScript program cannot take more memory than its heap limit', {skip: !languageAvailable('javascript')}, async() => {
    const r = await post({lang: 'javascript', code: 'const a = []; for (;;) { a.push(new Array(1e6).fill(1)); }'});
    // V8 reports "heap out of memory": the status memory since 0.8.0.
    assert.equal(r.data.status, 'memory');
});

test('a program sees only /usr and /etc of the server', async() => {
    const code = 'import os\nprint(sorted(os.listdir("/")))\n' +
        'print([d for d in ("/var/lib", "/home", "/opt", "/root") if os.path.exists(d)])\n';
    const r = await post({lang: 'python', code});
    assert.equal(r.data.status, 'ok');
    const [root, others] = r.data.stdout.trim().split('\n');
    assert.equal(root, "['bin', 'box', 'dev', 'etc', 'lib', 'lib64', 'proc', 'tmp', 'usr', 'work']");
    assert.equal(others, '[]');
});

test('hooks: authorize refuses a run, onRun counts the others, onRequest adds a route', async() => {
    const runs = [];
    const hooked = await startServer({port: 0, host: '127.0.0.1', secret: SECRET,
        authorize: ({type, site}) => (site === 'blocked' ? {ok: false, code: 403, reason: 'suspended'} : {ok: type === 'batch'}),
        onRun: (run) => runs.push(run),
        onRequest: (req, res) => {
            if (req.url !== '/extra') {
                return false;
            }
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.end('extra');
            return true;
        }});
    const base = `http://127.0.0.1:${hooked.address().port}`;
    const send = async(site) => {
        const body = JSON.stringify({lang: 'python', code: 'print(1)'});
        const time = String(Math.floor(Date.now() / 1000));
        const nonce = randomBytes(12).toString('base64url');
        const signature = createHmac('sha256', SECRET).update(`${time}\n${nonce}\n${body}`).digest('base64url');
        const res = await fetch(`${base}/run`, {method: 'POST', body, headers: {'X-CodeLab-Site': site,
            'X-CodeLab-Time': time, 'X-CodeLab-Nonce': nonce, 'X-CodeLab-Signature': signature}});
        return {code: res.status, data: await res.json()};
    };
    try {
        const refused = await send('blocked');
        assert.equal(refused.code, 403);
        assert.equal(refused.data.status, 'suspended');
        assert.deepEqual(runs, []);
        const ok = await send('school');
        assert.equal(ok.data.stdout, '1\n');
        assert.deepEqual(runs, [{type: 'batch', site: 'school'}]);
        assert.equal(await (await fetch(`${base}/extra`)).text(), 'extra');
        assert.equal((await fetch(`${base}/other`)).status, 404);
    } finally {
        hooked.close();
    }
});

test('per-request cputime limits an endless loop', async() => {
    const r = await post({lang: 'c', code: 'int main(void) { for (;;) {} }', cputime: 1});
    assert.equal(r.data.status, 'time');
});

test('a program out of memory gets the status memory', async() => {
    const py = await post({lang: 'python', code: 'a = []\nwhile True:\n    a.append(bytearray(10 ** 7))\n', memory: 64});
    assert.equal(py.data.status, 'memory');
    const cpp = await post({lang: 'cpp', code: '#include <vector>\nint main() { std::vector<std::vector<char>> v; ' +
        'for (;;) v.emplace_back(10000000, 1); }', memory: 64});
    assert.equal(cpp.data.status, 'memory');
});

test('a signed /health has the versions of the languages', async() => {
    const time = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(12).toString('base64url');
    const signature = createHmac('sha256', SECRET).update(`${time}\n${nonce}\n`).digest('base64url');
    const res = await fetch(url.replace('/run', '/health'), {headers: {'X-CodeLab-Time': time, 'X-CodeLab-Nonce': nonce,
        'X-CodeLab-Signature': signature}});
    const data = await res.json();
    assert.match(data.versions.c, /^\d+\.\d+/);
    assert.match(data.versions.python, /^3\.\d+/);
    assert.deepEqual(Object.keys(data.versions), data.languages);
    assert.equal(data.queued, 0);
    const open = await (await fetch(url.replace('/run', '/health'))).json();
    assert.equal(open.versions, undefined);
});

test('tests of contest problems: megabytes of input, hundreds of kilobytes of output, letters split between chunks', async() => {
    const numbers = Array.from({length: 300000}, (_, i) => String(i % 1000)).join(' ');
    const sum = Array.from({length: 300000}, (_, i) => i % 1000).reduce((a, b) => a + b, 0);
    const code = 'import sys\nprint(sum(map(int, sys.stdin.read().split())))\nprint("čćžšđ" * 40000)\n';
    const r = await post({lang: 'python', code, stdin: numbers});
    assert.equal(r.code, 200);
    assert.equal(r.data.status, 'ok');
    const [first, second] = r.data.stdout.split('\n');
    assert.equal(first, String(sum));
    assert.equal(second, 'čćžšđ'.repeat(40000));
    // Input with letters of two bytes all through: the signature and the text survive the chunks of the request.
    const letters = await post({lang: 'python', code: 'import sys\nprint(len(sys.stdin.read()))', stdin: 'ћ'.repeat(500000)});
    assert.equal(letters.data.stdout, '500000\n');
});

test('a run for grading larger than CODELAB_RUN_BODY_MB is refused with a message', async() => {
    const r = await post({lang: 'python', code: 'print(1)', stdin: 'x'.repeat(9 * 1024 * 1024)});
    assert.equal(r.code, 413);
    assert.match(r.data.stderr, /larger than/);
});

test('input and output files in the working folder (C)', async() => {
    const code = '#include <stdio.h>\nint main(void) {\n' +
        '    FILE *in = fopen("ulaz.txt", "r");\n' +
        '    int a = 0, b = 0;\n' +
        '    if (in) { fscanf(in, "%d %d", &a, &b); fclose(in); }\n' +
        '    printf("%d\\n", a + b);\n' +
        '    FILE *out = fopen("izlaz.txt", "w");\n' +
        '    if (out) { fprintf(out, "%d\\n", a * b); fclose(out); }\n' +
        '    return 0;\n}\n';
    const r = await post({lang: 'c', code, files: [{name: 'ulaz.txt', text: '6 7\n'}]});
    assert.equal(r.code, 200);
    assert.equal(r.data.status, 'ok');
    assert.equal(r.data.stdout, '13\n');
    assert.deepEqual(r.data.files, [{name: 'izlaz.txt', text: '42\n', size: 3}]);
    // Invalid file name is refused.
    const bad = await post({lang: 'c', code, files: [{name: '../etc', text: 'x'}]});
    assert.equal(bad.data.status, 'error');
});

test('MSVC mode: conio.h, windows.h, scanf_s with size, fopen_s, strcpy_s, __int64, system pause/cls', async() => {
    const code = [
        '#pragma warning(disable: 4996)',
        '#include <stdio.h>',
        '#include <conio.h>',
        '#include <windows.h>',
        'int main(void) {',
        '    SetConsoleOutputCP(CP_UTF8);',
        '    system("cls");',
        '    char name[16];',
        '    __int64 n = 0;',
        '    scanf_s("%s %lld", name, (unsigned)sizeof(name), &n);',
        '    char copy[32];',
        '    strcpy_s(copy, sizeof(copy), name);',
        '    strcat_s(copy, sizeof(copy), "!");',
        '    FILE *f = NULL;',
        '    if (fopen_s(&f, "out.txt", "w") == 0 && f) {',
        '        fprintf_s(f, "%s %lld\\n", copy, n * 2);',
        '        fclose(f);',
        '    }',
        '    printf_s("%s %lld\\n", copy, n);',
        '    system("pause");',
        '    return 0;',
        '}',
    ].join('\n') + '\n';
    const r = await post({lang: 'c', code, stdin: 'Pirot 21\n', compiler: 'msvc', std: 'c17'});
    assert.equal(r.code, 200);
    assert.equal(r.data.status, 'ok', r.data.cmpinfo || r.data.stderr);
    assert.equal(r.data.stdout, 'Pirot! 21\n');
    assert.deepEqual(r.data.files, [{name: 'out.txt', text: 'Pirot! 42\n', size: 10}]);

    // Unknown compiler or standard is refused.
    const bad = await post({lang: 'c', code: 'int main(){}', compiler: 'evil'});
    assert.equal(bad.data.status, 'error');
});

test('safe mode (ASan/UBSan): catches out-of-bounds array access with line number', async() => {
    const code = [
        '#include <stdio.h>',
        'int main(void) {',
        '    int a[3] = {1, 2, 3};',
        '    volatile int i = 5;',
        '    printf("%d\\n", a[i]);',
        '    return 0;',
        '}',
    ].join('\n') + '\n';
    const r = await post({lang: 'c', code, sanitize: true});
    assert.equal(r.code, 200);
    assert.equal(r.data.status, 'runtime', r.data.cmpinfo || r.data.stderr);
    assert.match(r.data.stderr, /out of bounds|stack-buffer-overflow/i);
    assert.match(r.data.stderr, /prog\.c:5/);
});
