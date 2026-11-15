// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the places for the runs for grading (lib/queue.js), and of the queue in the server with real runs.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac, randomBytes} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {BatchQueue} from '../lib/queue.js';
import {startServer} from '../server.js';

test('a run waits for a place instead of being refused, and is refused after the wait', async() => {
    const queue = new BatchQueue({max: 1, waitMs: 200});
    const first = await queue.acquire('a');
    assert.ok(first);
    const second = queue.acquire('a');
    assert.equal(queue.queued, 1);
    first();
    first();
    const got = await second;
    assert.ok(got);
    assert.equal(queue.running, 1);
    const third = await queue.acquire('a');
    assert.equal(third, null);
    assert.equal(queue.queued, 0);
    got();
    assert.equal(queue.running, 0);
});

test('the sites take turns, and one site has at most siteMax places', async() => {
    const queue = new BatchQueue({max: 2, siteMax: 2, waitMs: 5000});
    const order = [];
    /** @type {Array<function(): void>} releases of the runs going on, oldest first */
    const going = [];
    const ask = (site) => queue.acquire(site).then((release) => {
        order.push(site);
        going.push(release);
    });
    // A regrade on site a: six runs. Then one run of b and one of c arrive.
    const all = ['a', 'a', 'a', 'a', 'a', 'a', 'b', 'c'].map(ask);
    await wait(10);
    assert.deepEqual(order, ['a', 'a']);
    // Each time a run ends, the next place goes to the site with the fewest runs going on.
    while (going.length) {
        going.shift()();
        await wait(5);
    }
    await Promise.all(all);
    assert.deepEqual(order, ['a', 'a', 'b', 'c', 'a', 'a', 'a', 'a']);
    assert.equal(queue.running, 0);

    // siteMax: one site never takes all the places, the other site gets the rest at once.
    const limited = new BatchQueue({max: 3, siteMax: 2, waitMs: 5000});
    const a1 = await limited.acquire('a');
    const a2 = await limited.acquire('a');
    const a3 = limited.acquire('a');
    const b1 = await limited.acquire('b');
    assert.ok(b1);
    assert.equal(limited.queued, 1);
    a1();
    assert.ok(await a3);
    a2();
    b1();
});

test('a request that goes away stops waiting', async() => {
    const queue = new BatchQueue({max: 1, waitMs: 5000});
    const first = await queue.acquire('a');
    const gone = new AbortController();
    const second = queue.acquire('a', gone.signal);
    gone.abort();
    assert.equal(await second, null);
    assert.equal(queue.queued, 0);
    first();
    assert.equal(queue.running, 0);
});

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
