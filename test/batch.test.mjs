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
const timeless = ({time, memory, ...rest}) => rest;

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
    const failed = await post({lang: 'python', code: 'raise ValueError(3)'});
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

test('Bash, TypeScript, Go, Rust and R programs run in batch mode when installed', async(t) => {
    if (languageAvailable('bash')) {
        const sh = await post({lang: 'bash', code: 'read x\necho $((x * 2))\n', stdin: '21\n'});
        assert.deepEqual(timeless(sh.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('bash not in /usr/bin, skipping bash');
    }
    if (languageAvailable('typescript')) {
        const ts = await post({lang: 'typescript',
            code: 'import {readFileSync} from "node:fs";\nconst n: number = Number(readFileSync(0, "utf8").trim());\nconsole.log(n * 2);\n',
            stdin: '21\n'});
        assert.deepEqual(timeless(ts.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('node >= 22.6 not in /usr/bin, skipping typescript');
    }
    if (languageAvailable('go')) {
        const go = await post({lang: 'go',
            code: 'package main\nimport "fmt"\nfunc main() { var x int; fmt.Scan(&x); fmt.Println(x * 2) }\n',
            stdin: '21\n'});
        assert.deepEqual(timeless(go.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('go not in /usr/bin, skipping go');
    }
    if (languageAvailable('rust')) {
        const rs = await post({lang: 'rust',
            code: 'use std::io;\nfn main() { let mut s = String::new(); io::stdin().read_line(&mut s).unwrap(); let x: i32 = s.trim().parse().unwrap(); println!("{}", x * 2); }\n',
            stdin: '21\n'});
        assert.deepEqual(timeless(rs.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('rustc not in /usr/bin, skipping rust');
    }
    if (languageAvailable('r')) {
        const r = await post({lang: 'r',
            code: 'x <- as.integer(readLines("stdin", n = 1))\ncat(x * 2, "\\n", sep = "")\n',
            stdin: '21\n'});
        assert.deepEqual(timeless(r.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('Rscript not in /usr/bin, skipping r');
    }
    if (languageAvailable('ruby')) {
        const rb = await post({lang: 'ruby', code: 'puts gets.to_i * 2\n', stdin: '21\n'});
        assert.deepEqual(timeless(rb.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('ruby not in /usr/bin, skipping ruby');
    }
    if (languageAvailable('lua')) {
        const lua = await post({lang: 'lua', code: 'print(tonumber(io.read()) * 2)\n', stdin: '21\n'});
        assert.deepEqual(timeless(lua.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('lua not in /usr/bin, skipping lua');
    }
    if (languageAvailable('kotlin')) {
        const kt = await post({lang: 'kotlin', code: 'fun main() { println(readln().toInt() * 2) }\n', stdin: '21\n'});
        assert.deepEqual(timeless(kt.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('kotlinc not in /usr/bin, skipping kotlin');
    }
    if (languageAvailable('perl')) {
        const pl = await post({lang: 'perl', code: 'my $x = <STDIN>; chomp $x; print $x * 2, "\\n";\n', stdin: '21\n'});
        assert.deepEqual(timeless(pl.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('perl not in /usr/bin, skipping perl');
    }
    if (languageAvailable('octave')) {
        const oct = await post({lang: 'octave', code: 'x = scanf("%d", 1); printf("%d\\n", 2 * x);\n', stdin: '21\n'});
        assert.deepEqual(timeless(oct.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('octave not in /usr/bin, skipping octave');
    }
    if (languageAvailable('julia')) {
        const jl = await post({lang: 'julia', code: 'x = parse(Int, strip(readline()))\nprintln(2 * x)\n', stdin: '21\n'});
        assert.deepEqual(timeless(jl.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('julia not in /usr/bin, skipping julia');
    }
    if (languageAvailable('scheme')) {
        const scm = await post({lang: 'scheme', code: '(display (* 2 (read))) (newline)\n', stdin: '21\n'});
        assert.deepEqual(timeless(scm.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('guile not in /usr/bin, skipping scheme');
    }
    if (languageAvailable('dart')) {
        const dart = await post({lang: 'dart',
            code: 'import "dart:io";\nvoid main() { print(int.parse(stdin.readLineSync()!.trim()) * 2); }\n', stdin: '21\n'});
        assert.deepEqual(timeless(dart.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('dart not in /usr/bin, skipping dart');
    }
    if (languageAvailable('scala')) {
        const sc = await post({lang: 'scala',
            code: 'object Main extends App { println(scala.io.StdIn.readInt() * 2) }\n', stdin: '21\n'});
        assert.deepEqual(timeless(sc.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('scalac not in /usr/bin, skipping scala');
    }
    if (languageAvailable('elixir')) {
        const ex = await post({lang: 'elixir',
            code: 'IO.gets("") |> String.trim() |> String.to_integer() |> Kernel.*(2) |> IO.puts()\n', stdin: '21\n'});
        assert.deepEqual(timeless(ex.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('elixir not in /usr/bin, skipping elixir');
    }
    if (languageAvailable('swift')) {
        const sw = await post({lang: 'swift',
            code: 'if let s = readLine(), let x = Int(s) { print(x * 2) }\n', stdin: '21\n'});
        assert.deepEqual(timeless(sw.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('swiftc not in /usr/bin, skipping swift');
    }
    if (languageAvailable('haskell')) {
        const hs = await post({lang: 'haskell',
            code: 'main = do\n    s <- getLine\n    print (2 * (read s :: Int))\n', stdin: '21\n'});
        assert.deepEqual(timeless(hs.data), {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    } else {
        t.diagnostic('ghc not in /usr/bin, skipping haskell');
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

test('batch run reports peak memory in KB when /usr/bin/time is available', async() => {
    const code = [
        '#include <stdio.h>',
        '#include <stdlib.h>',
        '#include <string.h>',
        'int main(void) {',
        '    size_t n = 16 * 1024 * 1024;',
        '    char *p = malloc(n);',
        '    memset(p, 1, n);',
        '    printf("%d\\n", p[n - 1]);',
        '    free(p);',
        '    return 0;',
        '}',
    ].join('\n') + '\n';
    const r = await post({lang: 'c', code});
    assert.equal(r.code, 200);
    assert.equal(r.data.status, 'ok');
    assert.equal(r.data.stdout, '1\n');
    assert.equal(typeof r.data.memory, 'number');
    assert.ok(r.data.memory >= 14000, `expected >= 14000 KB, got ${r.data.memory}`);
});

test('multi-file C compilation: header and extra .c file in /box, cache invalidated on change', async() => {
    const main = '#include <stdio.h>\n#include "pomoc.h"\nint main(void) { printf("%d\\n", kvadrat(7)); return 0; }\n';
    const header = 'int kvadrat(int x);\n';
    const impl1 = 'int kvadrat(int x) { return x * x; }\n';
    const r1 = await post({lang: 'c', code: main, files: [{name: 'pomoc.h', text: header}, {name: 'pomoc.c', text: impl1}]});
    assert.equal(r1.code, 200);
    assert.equal(r1.data.status, 'ok', r1.data.cmpinfo || r1.data.stderr);
    assert.equal(r1.data.stdout, '49\n');

    // Modifying pomoc.c must invalidate compile cache and reflect the new implementation.
    const impl2 = 'int kvadrat(int x) { return x * x + 1; }\n';
    const r2 = await post({lang: 'c', code: main, files: [{name: 'pomoc.h', text: header}, {name: 'pomoc.c', text: impl2}]});
    assert.equal(r2.data.status, 'ok', r2.data.cmpinfo || r2.data.stderr);
    assert.equal(r2.data.stdout, '50\n');
});

test('Jobe mode: standard error, not the exit code, decides runtime; the runner mode keeps the exit code', async() => {
    const stderr = '#include <stdio.h>\nint main(void) { fprintf(stderr, "dbg\\n"); printf("5\\n"); return 0; }\n';
    const exit1 = '#include <stdio.h>\nint main(void) { printf("5\\n"); return 1; }\n';
    assert.equal((await post({lang: 'c', code: stderr})).data.status, 'runtime');
    assert.equal((await post({lang: 'c', code: exit1})).data.status, 'ok');
    assert.equal((await post({lang: 'c', code: stderr, compat: 'runner'})).data.status, 'ok');
    assert.equal((await post({lang: 'c', code: exit1, compat: 'runner'})).data.status, 'runtime');
    const py = await post({lang: 'python', code: 'import sys\nprint(5)\nsys.exit(1)\n'});
    assert.deepEqual([py.data.status, py.data.stdout], ['ok', '5\n']);
    const pyerr = await post({lang: 'python', code: 'import warnings\nwarnings.warn("old")\nprint(5)\n'});
    assert.equal(pyerr.data.status, 'runtime');
    assert.equal((await post({lang: 'c', code: 'x', compat: 'judge'})).data.stderr, 'Unknown compat mode.');
});

test('Jobe mode: a crash is runtime, a program that sleeps past twice its CPU time is time', async() => {
    const crash = await post({lang: 'c', code: '#include <stdio.h>\nint main(void) { int *p = 0; *p = 1; return 0; }\n'});
    assert.equal(crash.data.status, 'runtime');
    const sleep = await post({lang: 'c', code: '#include <unistd.h>\nint main(void) { sleep(10); return 0; }\n', cputime: 1});
    assert.equal(sleep.data.status, 'time');
});

test('Jobe mode: a message of the compiler is a compilation error, and it is not cached', async() => {
    const gets = '#include <stdio.h>\nchar *gets(char *s);\nint main(void) { char s[9]; gets(s); puts(s); return 0; }\n';
    for (let i = 0; i < 2; i++) {
        const r = await post({lang: 'c', code: gets, stdin: 'abc\n'});
        assert.equal(r.data.status, 'compile');
        assert.match(r.data.cmpinfo, /gets/);
    }
    assert.equal((await post({lang: 'c', code: gets, stdin: 'abc\n', compat: 'runner'})).data.stdout, 'abc\n');
    const java = 'import java.util.*;\npublic class Main { public static void main(String[] a) { List l = new ArrayList(); ' +
        'l.add(5); System.out.println(l.get(0)); } }\n';
    const j = await post({lang: 'java', code: java});
    assert.equal(j.data.status, 'compile');
    assert.match(j.data.cmpinfo, /unchecked/);
});

test('Jobe mode: syntax errors of Python and PHP are compilation errors', async() => {
    const py = await post({lang: 'python', code: 'print(5\n'});
    assert.equal(py.data.status, 'compile');
    assert.match(py.data.cmpinfo, /SyntaxError/);
    assert.equal((await post({lang: 'python', code: 'print(5\n', compat: 'runner'})).data.status, 'runtime');
    const php = await post({lang: 'php', code: '<?php\necho 5\n'});
    assert.equal(php.data.status, 'compile');
    assert.match(php.data.cmpinfo, /syntax error/i);
});

test('Jobe mode: PHP without php.ini shows warnings in the output; Python has 1500 MB', async() => {
    const php = await post({lang: 'php', code: '<?php\necho $x;\necho "5\\n";\n'});
    assert.equal(php.data.status, 'ok');
    assert.match(php.data.stdout, /Warning: Undefined variable \$x/);
    const py = await post({lang: 'python', code: 'b = bytearray(400 * 1024 * 1024)\nprint(len(b))\n'});
    assert.deepEqual([py.data.status, py.data.stdout], ['ok', '419430400\n']);
    assert.equal((await post({lang: 'python', code: 'b = bytearray(400 * 1024 * 1024)\n', compat: 'runner'})).data.status,
        'memory');
});

test('the memory of a request is the heap of Java', async() => {
    const code = 'public class Main { public static void main(String[] a) { int[] x = new int[75000000]; ' +
        'System.out.println(x.length); } }\n';
    assert.equal((await post({lang: 'java', code})).data.status, 'memory');
    const big = await post({lang: 'java', code, memory: 1000});
    assert.deepEqual([big.data.status, big.data.stdout], ['ok', '75000000\n']);
});

test('a Java program without a public class runs as its class with main', async() => {
    const code = 'class Zadatak {\n    public static void main(String[] a) {\n        System.out.println(5);\n    }\n}\n';
    const r = await post({lang: 'java', code});
    assert.deepEqual([r.data.status, r.data.stdout], ['ok', '5\n'], r.data.stderr || r.data.cmpinfo);
});
