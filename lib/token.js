// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Session tokens issued by Moodle (tiny_codelab_interactive): base64url(JSON payload) "." base64url(HMAC-SHA256 of the
 * payload part with the shared secret). The payload has the user (u), the site (s), the expiry (e, Unix seconds) and a
 * nonce (n); each token opens one session only.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {createHmac, timingSafeEqual} from 'node:crypto';

/**
 * Sign a payload (used by the tests; Moodle signs in PHP the same way).
 *
 * @param {Object} payload
 * @param {string} secret
 * @returns {string}
 */
export const sign = (payload, secret) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
};

export class TokenChecker {
    /**
     * Checker with the shared secret.
     *
     * @param {string} secret
     */
    constructor(secret) {
        if (!secret || secret.length < 16) {
            throw new Error('CODELAB_SECRET must have at least 16 characters');
        }
        this.secret = secret;
        /** @type {Map<string, number>} nonces used, with their expiry */
        this.used = new Map();
    }

    /**
     * The payload of a valid token that was not used before, or null.
     *
     * @param {string} token
     * @param {number} [now] Unix seconds
     * @returns {Object|null}
     */
    check(token, now = Math.floor(Date.now() / 1000)) {
        const [body, mac] = String(token || '').split('.');
        if (!body || !mac) {
            return null;
        }
        const expected = createHmac('sha256', this.secret).update(body).digest();
        const given = Buffer.from(mac, 'base64url');
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            return null;
        }
        let payload;
        try {
            payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        } catch {
            return null;
        }
        if (typeof payload.e !== 'number' || payload.e < now || typeof payload.n !== 'string' || this.used.has(payload.n)) {
            return null;
        }
        for (const [nonce, expiry] of this.used) {
            if (expiry < now) {
                this.used.delete(nonce);
            }
        }
        this.used.set(payload.n, payload.e);
        return payload;
    }
}
