// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Session tokens issued by Moodle (tiny_codelab_interactive): base64url(JSON payload) "." base64url(HMAC-SHA256 of the
 * payload part with the site's secret). The payload has the user (u), the site (s), the expiry (e, Unix seconds), a
 * nonce (n) and, from tiny_codelab 1.12, the language (l) the session may run; each token opens one session only.
 *
 * Secrets: CODELAB_SECRET is the secret of every site; CODELAB_SECRETS (site:secret, comma separated, the site as Moodle
 * shows it on the settings page) gives a site a secret of its own, so that one site cannot sign tokens of another.
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

export class Secrets {
    /**
     * The secrets of the sites.
     *
     * @param {string} [secret] the secret of every site without one of its own
     * @param {string} [list] site:secret pairs, comma separated
     */
    constructor(secret, list = '') {
        /** @type {Map<string, string>} */
        this.sites = new Map();
        for (const pair of String(list || '').split(',').map((p) => p.trim()).filter(Boolean)) {
            const at = pair.indexOf(':');
            const site = pair.slice(0, at).trim();
            const value = pair.slice(at + 1).trim();
            if (at < 1 || value.length < 16) {
                throw new Error('CODELAB_SECRETS: each pair is site:secret, the secret with at least 16 characters');
            }
            this.sites.set(site, value);
        }
        this.fallback = secret || '';
        if (this.fallback && this.fallback.length < 16) {
            throw new Error('CODELAB_SECRET must have at least 16 characters');
        }
        if (!this.fallback && !this.sites.size) {
            throw new Error('CODELAB_SECRET or CODELAB_SECRETS must be set');
        }
    }

    /**
     * The secret of a site: its own, or the common one.
     *
     * @param {string} [site]
     * @returns {string} '' when the site has none
     */
    of(site) {
        return this.sites.get(String(site ?? '')) ?? this.fallback;
    }
}

/** Seconds a nonce of POST /run is remembered (its requests are valid for 60 seconds either way). */
const NONCE_SECONDS = 120;

export class NonceList {
    /**
     * Nonces seen, each until its expiry.
     */
    constructor() {
        /** @type {Map<string, number>} */
        this.used = new Map();
    }

    /**
     * Remember a nonce; false when it was seen before.
     *
     * @param {string} nonce
     * @param {number} expiry Unix seconds
     * @param {number} now Unix seconds
     * @returns {boolean}
     */
    add(nonce, expiry, now) {
        for (const [n, e] of this.used) {
            if (e < now) {
                this.used.delete(n);
            }
        }
        if (this.used.has(nonce)) {
            return false;
        }
        this.used.set(nonce, expiry);
        return true;
    }

    /**
     * Remember the nonce of a run request for a while.
     *
     * @param {string} nonce
     * @param {number} now
     * @returns {boolean}
     */
    addRequest(nonce, now) {
        return this.add(nonce, now + NONCE_SECONDS, now);
    }
}

export class TokenChecker {
    /**
     * Checker with the secrets of the sites.
     *
     * @param {Secrets|string} secrets a Secrets, or one secret for every site
     */
    constructor(secrets) {
        this.secrets = secrets instanceof Secrets ? secrets : new Secrets(secrets);
        this.nonces = new NonceList();
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
        // The site in the payload chooses the secret; the payload is trusted only after its signature is checked.
        let payload;
        try {
            payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        } catch {
            return null;
        }
        if (!payload || typeof payload !== 'object') {
            return null;
        }
        const secret = this.secrets.of(payload.s);
        if (!secret) {
            return null;
        }
        const expected = createHmac('sha256', secret).update(body).digest();
        const given = Buffer.from(mac, 'base64url');
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
            return null;
        }
        if (typeof payload.e !== 'number' || payload.e < now || typeof payload.n !== 'string' ||
                !this.nonces.add(payload.n, payload.e, now)) {
            return null;
        }
        return payload;
    }
}
