// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the queue in the server with real runs for grading (needs the sandbox: Linux with bubblewrap).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac, randomBytes} from 'node:crypto';
import {startServer} from '../server.js';

test('the server: a regrade of 12 runs with 2 places, all graded; no wait means busy', async() => {
    const SECRET = 'test-secret-of-sixteen-or-more';
    const post = async(base, site) => {
        const body = JSON.stringify({lang: 'python', code: 'import time\ntime.sleep(0.2)\nprint(input())', stdin: site});
        const time = String(Math.floor(Date.now() / 1000));
        const nonce = randomBytes(12).toString('base64url');
        const signature = createHmac('sha256', SECRET).update(`${time}\n${nonce}\n${body}`).digest('base64url');
        const res = await fetch(`${base}/run`, {method: 'POST', body, headers: {'X-CodeLab-Site': site,
            'X-CodeLab-Time': time, 'X-CodeLab-Nonce': nonce, 'X-CodeLab-Signature': signature}});
        return (await res.json());
    };
    const env = {...process.env};
    process.env.CODELAB_BATCH_MAX = '2';
    process.env.CODELAB_BATCH_WAIT = '60';
    const server = await startServer({port: 0, host: '127.0.0.1', secret: SECRET});
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const results = await Promise.all([...Array(12).keys()].map((i) => post(base, i < 10 ? 'big' : 'small')));
        assert.deepEqual(results.map((r) => r.status), Array(12).fill('ok'));
        assert.deepEqual(results.map((r) => r.stdout), [...Array(12).keys()].map((i) => (i < 10 ? 'big\n' : 'small\n')));
    } finally {
        server.close();
    }
    process.env.CODELAB_BATCH_MAX = '1';
    process.env.CODELAB_BATCH_WAIT = '0';
    const strict = await startServer({port: 0, host: '127.0.0.1', secret: SECRET});
    const strictBase = `http://127.0.0.1:${strict.address().port}`;
    try {
        const statuses = (await Promise.all([post(strictBase, 'x'), post(strictBase, 'x')])).map((r) => r.status).sort();
        assert.deepEqual(statuses, ['busy', 'ok']);
    } finally {
        strict.close();
        for (const name of ['CODELAB_BATCH_MAX', 'CODELAB_BATCH_WAIT']) {
            if (env[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = env[name];
            }
        }
    }
});
