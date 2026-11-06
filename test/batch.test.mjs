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
import {createHmac} from 'node:crypto';
import {startServer} from '../server.js';

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
 * @returns {Promise<{code: number, data: Object}>}
 */
const post = async(request, secret = SECRET) => {
    const body = JSON.stringify(request);
    const time = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret).update(`${time}\n${body}`).digest('base64url');
    const res = await fetch(url, {method: 'POST', body,
        headers: {'Content-Type': 'application/json', 'X-CodeLab-Time': time, 'X-CodeLab-Signature': signature}});
    return {code: res.status, data: await res.json()};
};

test('a C program with its input, as from Jobe', async() => {
    const code = '#include <stdio.h>\nint main(void) { int a, b; scanf("%d %d", &a, &b); printf("%d\\n", a + b); return 0; }\n';
    const r = await post({lang: 'c', code, stdin: '20 22'});
    assert.equal(r.code, 200);
    assert.deepEqual(r.data, {status: 'ok', stdout: '42\n', stderr: '', cmpinfo: ''});
    const bad = await post({lang: 'c', code: 'int main(void) { return x; }'});
    assert.equal(bad.data.status, 'compile');
});

test('SQL gives only the tables, in a database of its own', {skip: !process.env.CODELAB_MYSQL_PASSWORD}, async() => {
    const code = 'CREATE TABLE t (a INT, b VARCHAR(10));\nINSERT INTO t VALUES (1, \'jedan\'), (2, \'dva\');\n' +
        'SELECT * FROM t ORDER BY a;\n';
    const r = await post({lang: 'mysql', code});
    assert.equal(r.data.status, 'ok');
    assert.equal(r.data.stdout, '+------+-------+\n| a    | b     |\n+------+-------+\n|    1 | jedan |\n|    2 | dva   |\n' +
        '+------+-------+\n');
    const error = await post({lang: 'mysql', code: 'SELECT * FROM nema;'});
    assert.equal(error.data.status, 'runtime');
    assert.match(error.data.stderr, /ERROR 1146/);
});

test('a request without the right signature is refused', async() => {
    const r = await post({lang: 'c', code: 'int main(void) { return 0; }'}, 'another-secret-of-sixteen');
    assert.equal(r.code, 401);
});
