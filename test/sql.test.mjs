// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of SQL on MariaDB. They run only when the runner's MariaDB user is set (CODELAB_MYSQL_PASSWORD, see
 * deploy/mariadb-admin.sh).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket as WsClient} from 'ws';
import {randomUUID} from 'node:crypto';
import {startServer} from '../server.js';
import {sign} from '../lib/token.js';

// Node 20 has no WebSocket client of its own.
const WebSocket = globalThis.WebSocket ?? WsClient;
const SECRET = 'test-secret-of-sixteen-or-more';
const skip = !process.env.CODELAB_MYSQL_PASSWORD && 'CODELAB_MYSQL_PASSWORD is not set';
let server;
let base;

before(async() => {
    server = await startServer({port: 0, host: '127.0.0.1', secret: SECRET});
    base = `ws://127.0.0.1:${server.address().port}/session`;
});
after(() => server.close());

/**
 * Run SQL.
 *
 * @param {string} code
 * @param {string} [setup]
 * @returns {Promise<{out: string, err: string, exit: Object}>}
 */
const sql = (code, setup = '') => new Promise((resolve, reject) => {
    const token = sign({u: 11, s: 'test', e: Math.floor(Date.now() / 1000) + 60, n: randomUUID()}, SECRET);
    const ws = new WebSocket(`${base}?token=${token}`);
    const result = {out: '', err: '', exit: undefined};
    ws.onopen = () => ws.send(JSON.stringify({type: 'start', lang: 'mysql', code, setup}));
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === 'out') {
            result.out += message.data;
        } else if (message.type === 'err') {
            result.err += message.data;
        } else if (['exit', 'error'].includes(message.type)) {
            result.exit = message;
        }
    };
    ws.onclose = () => resolve(result);
    ws.onerror = reject;
});

const SETUP = 'CREATE TABLE knjiga (id INT AUTO_INCREMENT PRIMARY KEY, naslov VARCHAR(50), godina INT);\n' +
    "INSERT INTO knjiga (naslov, godina) VALUES ('Na Drini ćuprija', 1945), ('Prokleta avlija', 1954);\n";

test('a query on the tables of the setup, shown as by the mariadb client', {skip}, async() => {
    const r = await sql('SELECT naslov, godina FROM knjiga ORDER BY godina DESC;', SETUP);
    assert.equal(r.exit.status, 'ok');
    assert.match(r.out, /\| naslov\s+\| godina \|/);
    assert.match(r.out, /\| Prokleta avlija\s+\|\s+1954 \|[\s\S]*Na Drini ćuprija/);
    assert.match(r.out, /2 rows in set/);
    assert.doesNotMatch(r.out, /Bye/);
});

test('changes and their messages, then an error with its line', {skip}, async() => {
    const r = await sql("INSERT INTO knjiga (naslov, godina) VALUES ('Seobe', 1929);\nSELECT COUNT(*) AS broj FROM knjiga;\n" +
        'SELECT nema FROM knjiga;\n', SETUP);
    assert.match(r.out, /Query OK, 1 row affected/);
    assert.match(r.out, /\|\s+3 \|/);
    assert.match(r.err, /ERROR 1054 \(42S22\) at line 3: Unknown column 'nema'/);
    assert.equal(r.exit.status, 'runtime');
});

test('each session has its own database', {skip}, async() => {
    const first = await sql("INSERT INTO knjiga (naslov, godina) VALUES ('Seobe', 1929);", SETUP);
    assert.equal(first.exit.status, 'ok');
    const second = await sql('SELECT COUNT(*) AS broj FROM knjiga;', SETUP);
    assert.match(second.out, /\|\s+2 \|/);
});

test('no other databases, no files, and a time limit per statement', {skip}, async() => {
    const dbs = await sql('SHOW DATABASES;');
    assert.doesNotMatch(dbs.out, /moodle|mysql\b/);
    const file = await sql("SELECT LOAD_FILE('/etc/passwd') AS f;");
    assert.match(file.out, /NULL/);
    const slow = await sql('SELECT SLEEP(20);');
    assert.match(slow.err, /max_statement_time exceeded/);
});

test('an error in the setup is reported as such', {skip}, async() => {
    const r = await sql('SELECT 1;', 'CREATE TABLE x (;');
    assert.match(r.err, /^Setup: ERROR 1064/);
    assert.equal(r.exit.status, 'runtime');
});
