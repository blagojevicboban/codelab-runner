// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the places for the runs for grading (lib/queue.js), without the sandbox. The queue in the server with real
 * runs is tested in queue-server.test.mjs.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as wait} from 'node:timers/promises';
import {BatchQueue} from '../lib/queue.js';

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
