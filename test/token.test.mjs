// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Tests of the tokens and signed requests (no sandbox needed).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {NonceList, Secrets, TokenChecker, sign} from '../lib/token.js';
import {signedRequest} from '../lib/batch.js';

const COMMON = 'common-secret-of-sixteen-chars';
const OWN = 'own-secret-of-site-a-sixteen';
const NOW = 1800000000;

const payload = (extra = {}) => ({u: 1, s: 'aaa', e: NOW + 60, n: `n${Math.random()}`, ...extra});

test('a site with a secret of its own does not accept the common secret', () => {
    const checker = new TokenChecker(new Secrets(COMMON, `aaa:${OWN}`));
    assert.equal(checker.check(sign(payload(), COMMON), NOW), null);
    assert.equal(checker.check(sign(payload(), OWN), NOW)?.u, 1);
    // Other sites keep the common secret.
    assert.equal(checker.check(sign(payload({s: 'bbb'}), COMMON), NOW)?.s, 'bbb');
    assert.equal(checker.check(sign(payload({s: 'bbb'}), OWN), NOW), null);
});

test('only site secrets: a site without one is refused', () => {
    const checker = new TokenChecker(new Secrets('', `aaa:${OWN}`));
    assert.equal(checker.check(sign(payload({s: 'bbb'}), OWN), NOW), null);
    assert.equal(checker.check(sign(payload(), OWN), NOW)?.s, 'aaa');
});

test('bad settings are refused', () => {
    assert.throws(() => new Secrets('short'));
    assert.throws(() => new Secrets('', 'aaa:short'));
    assert.throws(() => new Secrets('', 'no-colon-secret-of-sixteen'));
    assert.throws(() => new Secrets('', ''));
});

test('a token payload that is not an object is refused', () => {
    const checker = new TokenChecker(COMMON);
    const body = Buffer.from('null').toString('base64url');
    const mac = createHmac('sha256', COMMON).update(body).digest('base64url');
    assert.equal(checker.check(`${body}.${mac}`, NOW), null);
});

/**
 * Headers of a signed run request.
 *
 * @param {string} secret
 * @param {string} body
 * @param {Object} [options]
 * @returns {Object<string, string>}
 */
const headers = (secret, body, {site, nonce, time = NOW} = {}) => {
    const signed = nonce === undefined ? `${time}\n${body}` : `${time}\n${nonce}\n${body}`;
    const h = {'x-codelab-time': String(time), 'x-codelab-signature': createHmac('sha256', secret).update(signed)
        .digest('base64url')};
    if (site) {
        h['x-codelab-site'] = site;
    }
    if (nonce !== undefined) {
        h['x-codelab-nonce'] = nonce;
    }
    return h;
};

test('a signed run with a nonce is accepted once', () => {
    const secrets = new Secrets(COMMON, `aaa:${OWN}`);
    const nonces = new NonceList();
    const h = headers(OWN, '{}', {site: 'aaa', nonce: 'abcdefghijklmnop'});
    assert.equal(signedRequest(secrets, h, '{}', nonces, NOW), true);
    assert.equal(signedRequest(secrets, h, '{}', nonces, NOW + 1), false);
    // The same nonce of another site is another request.
    assert.equal(signedRequest(secrets, headers(COMMON, '{}', {site: 'bbb', nonce: 'abcdefghijklmnop'}), '{}', nonces, NOW),
        true);
    assert.equal(signedRequest(secrets, headers(COMMON, '{}', {site: 'aaa', nonce: 'qrstuvwxyzabcdef'}), '{}', nonces, NOW),
        false);
});

test('old requests without a nonce, unless CODELAB_REQUIRE_NONCE', () => {
    const secrets = new Secrets(COMMON);
    assert.equal(signedRequest(secrets, headers(COMMON, 'x'), 'x', null, NOW), true);
    assert.equal(signedRequest(secrets, headers(COMMON, 'x', {time: NOW - 61}), 'x', null, NOW), false);
    process.env.CODELAB_REQUIRE_NONCE = '1';
    try {
        assert.equal(signedRequest(secrets, headers(COMMON, 'x'), 'x', null, NOW), false);
    } finally {
        delete process.env.CODELAB_REQUIRE_NONCE;
    }
    assert.equal(signedRequest(secrets, headers(COMMON, 'x', {nonce: 'bad nonce!'}), 'x', null, NOW), false);
});
