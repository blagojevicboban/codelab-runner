// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * A run without a browser, for grading: Moodle sends the program and its input (POST /run) and gets the whole output,
 * as from Jobe. SQL is shown only as the tables of the mariadb client (--table, without the statements), so that the
 * output of a query can be compared with the expected one.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {createHmac, timingSafeEqual} from 'node:crypto';
import {LANGUAGES, Program} from './sandbox.js';
import {SessionDatabase, mysqlConfigured} from './mysql.js';
import {LIMITS} from './session.js';

/** Seconds a signed request stays valid. */
const REQUEST_SECONDS = 60;

/**
 * Whether a request is signed with the secret of its site (header X-CodeLab-Site, or the common secret): header
 * X-CodeLab-Signature is base64url(HMAC-SHA256(secret, X-CodeLab-Time + "
" + X-CodeLab-Nonce + "
" + body)), the time
 * is recent and the nonce was not used before, so a request cannot be sent again. Without X-CodeLab-Nonce (tiny_codelab
 * older than 1.12) the signature is of time + "
" + body; CODELAB_REQUIRE_NONCE=1 refuses such requests.
 *
 * @param {import('./token.js').Secrets|string} secrets
 * @param {Object<string, string>} headers
 * @param {string} body
 * @param {import('./token.js').NonceList} [nonces]
 * @param {number} [now] Unix seconds
 * @returns {boolean}
 */
export const signedRequest = (secrets, headers, body, nonces = null, now = Math.floor(Date.now() / 1000)) => {
    const time = Number(headers['x-codelab-time']);
    if (!Number.isFinite(time) || Math.abs(now - time) > REQUEST_SECONDS) {
        return false;
    }
    const secret = typeof secrets === 'string' ? secrets : secrets.of(headers['x-codelab-site']);
    if (!secret) {
        return false;
    }
    const nonce = headers['x-codelab-nonce'];
    if (nonce === undefined && process.env.CODELAB_REQUIRE_NONCE === '1') {
        return false;
    }
    if (nonce !== undefined && !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
        return false;
    }
    const signed = nonce === undefined ? `${time}
${body}` : `${time}
${nonce}
${body}`;
    const expected = createHmac('sha256', secret).update(signed).digest();
    const given = Buffer.from(String(headers['x-codelab-signature'] || ''), 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return false;
    }
    return nonce === undefined || !nonces || nonces.addRequest(`${headers['x-codelab-site'] || ''}/${nonce}`, now);
};

/**
 * Run a program to its end.
 *
 * @param {Object} request
 * @param {string} request.lang
 * @param {string} request.code
 * @param {string} [request.stdin]
 * @returns {Promise<{status: string, stdout: string, stderr: string, cmpinfo: string}>} status as from Jobe: ok, compile,
 *     runtime, time, toolong, error
 */
export const runBatch = async({lang, code, stdin = ''}) => {
    const result = {status: 'error', stdout: '', stderr: '', cmpinfo: ''};
    if (!Object.hasOwn(LANGUAGES, lang) || typeof code !== 'string' || code === '' || code.length > LIMITS.code) {
        result.stderr = 'Unknown language, or the program is empty or too large.';
        return result;
    }
    if (lang === 'mysql' && !mysqlConfigured()) {
        result.stderr = 'SQL is not set up on this server.';
        return result;
    }
    const program = new Program(lang, code);
    let database = null;
    try {
        const compiled = await program.compile();
        if (!compiled.ok) {
            return {...result, status: 'compile', cmpinfo: compiled.output};
        }
        let extra = {};
        if (lang === 'mysql') {
            database = new SessionDatabase();
            await database.create();
            extra = {...database.client(), batch: true};
        }
        const child = program.start(LIMITS.cpu, extra);
        let stdout = '';
        let stderr = '';
        let toolong = false;
        const add = (stream) => (chunk) => {
            if (stdout.length + stderr.length > LIMITS.output) {
                toolong = true;
                child.kill('SIGKILL');
                return;
            }
            if (stream === 'out') {
                stdout += chunk.toString('utf8');
            } else {
                stderr += chunk.toString('utf8');
            }
        };
        child.stdout.on('data', add('out'));
        child.stderr.on('data', add('err'));
        child.stdin.on('error', () => undefined);
        child.stdin.end(lang === 'mysql' ? code : stdin);
        const [exitcode] = await new Promise((resolve) => {
            const timer = setTimeout(() => child.kill('SIGKILL'), LIMITS.cpu * 3000);
            child.on('close', (...args) => {
                clearTimeout(timer);
                resolve(args);
            });
        });
        let status = 'runtime';
        if (toolong) {
            status = 'toolong';
        } else if (exitcode === 152 || exitcode === 137) {
            status = 'time';
        } else if (exitcode === 0) {
            status = 'ok';
        }
        return {status, stdout, stderr, cmpinfo: ''};
    } catch (e) {
        return {...result, stderr: e.message};
    } finally {
        await database?.drop();
        await program.dispose();
    }
};
