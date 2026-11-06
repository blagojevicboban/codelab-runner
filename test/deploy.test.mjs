// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the GitHub webhook (POST /deploy), with a harmless update command instead of git pull.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {startServer} from '../server.js';

const HOOK_SECRET = 'webhook-secret-for-tests';
let server;
let url;
let exited;
let exitCalled;

before(async() => {
    process.env.CODELAB_DEPLOY_SECRET = HOOK_SECRET;
    process.env.CODELAB_DEPLOY_COMMAND = 'echo pulled';
    exited = new Promise((resolve) => (exitCalled = resolve));
    server = await startServer({port: 0, host: '127.0.0.1', secret: 'test-secret-of-sixteen-or-more', exit: () => exitCalled()});
    url = `http://127.0.0.1:${server.address().port}/deploy`;
});
after(() => {
    delete process.env.CODELAB_DEPLOY_SECRET;
    server.close();
});

/**
 * Send a webhook as GitHub does.
 *
 * @param {string} event
 * @param {Object} payload
 * @param {string} [secret]
 * @returns {Promise<{code: number, text: string}>}
 */
const hook = async(event, payload, secret = HOOK_SECRET) => {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const res = await fetch(url, {method: 'POST', body,
        headers: {'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-Hub-Signature-256': signature}});
    return {code: res.status, text: await res.text()};
};

test('a wrong signature is refused', async() => {
    assert.equal((await hook('push', {ref: 'refs/heads/main'}, 'another-secret')).code, 401);
});

test('ping, and pushes to other branches, change nothing', async() => {
    assert.deepEqual(await hook('ping', {zen: 'x'}), {code: 200, text: 'pong'});
    const other = await hook('push', {ref: 'refs/heads/feature'});
    assert.equal(other.code, 202);
});

test('a push to main updates and restarts when no session is open', async() => {
    const r = await hook('push', {ref: 'refs/heads/main'});
    assert.equal(r.code, 200);
    assert.match(r.text, /Updated, restarting: pulled/);
    await exited;
});
