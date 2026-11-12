// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Updating the runner from a GitHub webhook (POST /deploy): GitHub signs the push with the webhook's secret
 * (X-Hub-Signature-256: sha256=<hex HMAC of the body>). By default only a release tag (v1.2.3) is deployed, and only when
 * git verifies its signature (git verify-tag, e.g. with gpg.format ssh and gpg.ssh.allowedSignersFile): someone who gets
 * into the GitHub account cannot run code on the server with a push. CODELAB_DEPLOY_ON=branch keeps the old way (every
 * push to CODELAB_DEPLOY_BRANCH), CODELAB_DEPLOY_VERIFY=0 skips the signature check. The packages are installed without
 * their install scripts. Then the server waits until the open sessions end (at most CODELAB_DEPLOY_WAIT seconds) and
 * exits; systemd starts the new version. Without CODELAB_DEPLOY_SECRET the endpoint answers 404.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {exec} from 'node:child_process';
import {createHmac, timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';

/** Folder of the runner (where git pull runs). */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Whether GitHub signed the body with the secret.
 *
 * @param {string} secret
 * @param {string|undefined} header X-Hub-Signature-256
 * @param {string} body
 * @returns {boolean}
 */
export const githubSigned = (secret, header, body) => {
    const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
    const given = Buffer.from(String(header || ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
};

/** Release tags that are deployed: the name goes into a shell command, so nothing else is accepted. */
const RELEASE_TAG = /^refs\/tags\/(v\d+\.\d+\.\d+)$/;

/**
 * The shell command that updates the runner for a webhook event, or null when the event is not deployed.
 *
 * @param {string} event X-GitHub-Event
 * @param {Object} payload
 * @returns {?string}
 */
export const deployCommand = (event, payload) => {
    if (event !== 'push' || payload.deleted) {
        return null;
    }
    const install = 'npm ci --omit=dev --ignore-scripts';
    if (process.env.CODELAB_DEPLOY_ON === 'branch') {
        const branch = process.env.CODELAB_DEPLOY_BRANCH || 'main';
        if (payload.ref !== `refs/heads/${branch}`) {
            return null;
        }
        return process.env.CODELAB_DEPLOY_COMMAND || `git pull --ff-only && ${install}`;
    }
    const tag = RELEASE_TAG.exec(String(payload.ref || ''))?.[1];
    if (!tag) {
        return null;
    }
    const verify = process.env.CODELAB_DEPLOY_VERIFY === '0' ? '' : `git verify-tag ${tag} && `;
    return process.env.CODELAB_DEPLOY_COMMAND
        || `git fetch --tags --force origin && ${verify}git checkout --detach ${tag} && ${install}`;
};

/**
 * Handle a webhook request.
 *
 * @param {Object} request
 * @param {Object<string, string>} request.headers
 * @param {string} request.body
 * @param {Object} hooks
 * @param {function(): number} hooks.sessions number of open sessions
 * @param {function(): void} hooks.exit ends the process (systemd restarts it)
 * @returns {Promise<{code: number, text: string}>} the answer to GitHub
 */
export const handleDeploy = async({headers, body}, {sessions, exit}) => {
    const secret = process.env.CODELAB_DEPLOY_SECRET || '';
    if (secret === '') {
        return {code: 404, text: 'Not Found'};
    }
    if (!githubSigned(secret, headers['x-hub-signature-256'], body)) {
        return {code: 401, text: 'Bad signature'};
    }
    const event = headers['x-github-event'];
    if (event === 'ping') {
        return {code: 200, text: 'pong'};
    }
    let payload;
    try {
        payload = JSON.parse(body);
    } catch {
        return {code: 400, text: 'Bad payload'};
    }
    const command = deployCommand(event, payload);
    if (!command) {
        return {code: 202, text: `Ignored: ${process.env.CODELAB_DEPLOY_ON === 'branch' ? 'not a push to the branch'
            : 'not a release tag'}`};
    }
    const result = await new Promise((resolve) => {
        exec(command, {cwd: ROOT, timeout: 300000}, (error, stdout, stderr) => resolve({error, output: `${stdout}${stderr}`}));
    });
    if (result.error) {
        return {code: 500, text: `Update failed: ${result.output.slice(-2000)}`};
    }
    // Let the open sessions end, then restart with the new version.
    const wait = Number(process.env.CODELAB_DEPLOY_WAIT || 60) * 1000;
    const started = Date.now();
    const timer = setInterval(() => {
        if (sessions() === 0 || Date.now() - started > wait) {
            clearInterval(timer);
            exit();
        }
    }, 1000);
    return {code: 200, text: `Updated, restarting: ${result.output.slice(-500)}`};
};
