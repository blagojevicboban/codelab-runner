// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * CodeLab runner: keeps a student's C, C++, Java or C# program running while the student types its input in the
 * browser. Grading stays on Jobe; this server only runs programs interactively.
 *
 *   CODELAB_SECRET=<the secret of the tiny_codelab settings> node server.js
 *
 * Environment: CODELAB_PORT (8090), CODELAB_HOST (127.0.0.1, put a TLS proxy in front), CODELAB_SECRET,
 * CODELAB_ORIGINS (allowed Origin headers, comma separated; empty allows any), CODELAB_MAX_SESSIONS (30),
 * CODELAB_USER_SESSIONS (2), CODELAB_CPU_SECONDS (10), CODELAB_WALL_SECONDS (300), CODELAB_MAX_OUTPUT (100000),
 * CODELAB_NPROC (0: off), CODELAB_TMP, CODELAB_DEPLOY_SECRET (GitHub webhook, POST /deploy), CODELAB_DEPLOY_BRANCH (main).
 *
 * GET /health answers {ok, sessions, languages}; WebSocket /session?token=... opens a session (see lib/session.js).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {LANGUAGES} from './lib/sandbox.js';
import {mysqlConfigured} from './lib/mysql.js';
import {Session} from './lib/session.js';
import {TokenChecker} from './lib/token.js';
import {runBatch, signedRequest} from './lib/batch.js';
import {handleDeploy} from './lib/deploy.js';

/**
 * Start the server.
 *
 * @param {Object} [options]
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {string} [options.secret]
 * @param {function(): void} [options.exit] how a webhook update ends the process (default: exit, systemd restarts)
 * @returns {Promise<import('node:http').Server>}
 */
export const startServer = ({port, host, secret, exit = () => process.exit(75)} = {}) => {
    const theSecret = secret ?? process.env.CODELAB_SECRET;
    const checker = new TokenChecker(theSecret);
    const origins = (process.env.CODELAB_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
    const maxSessions = Number(process.env.CODELAB_MAX_SESSIONS || 30);
    const userSessions = Number(process.env.CODELAB_USER_SESSIONS || 2);
    /** @type {Map<string, number>} open sessions by site and user */
    const open = new Map();
    let total = 0;

    const server = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
            const languages = Object.keys(LANGUAGES).filter((lang) => lang !== 'mysql' || mysqlConfigured());
            res.end(JSON.stringify({ok: true, sessions: total, languages}));
            return;
        }
        if (req.method === 'POST' && req.url === '/deploy') {
            // GitHub webhook: pull the new version and restart (lib/deploy.js).
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
                if (body.length > 1000000) {
                    req.destroy();
                }
            });
            req.on('end', async() => {
                const {code, text} = await handleDeploy({headers: req.headers, body}, {sessions: () => total, exit});
                res.writeHead(code, {'Content-Type': 'text/plain'});
                res.end(text);
            });
            return;
        }
        if (req.method === 'POST' && req.url === '/run') {
            // A run for grading, from Moodle's server (signed with the secret), not from a browser.
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
                if (body.length > 300000) {
                    req.destroy();
                }
            });
            req.on('end', async() => {
                const reply = (code, data) => {
                    res.writeHead(code, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify(data));
                };
                if (!signedRequest(theSecret, req.headers, body)) {
                    return reply(401, {status: 'error', stderr: 'Unauthorized'});
                }
                if (total >= maxSessions) {
                    return reply(200, {status: 'busy', stdout: '', stderr: '', cmpinfo: ''});
                }
                let request;
                try {
                    request = JSON.parse(body);
                } catch {
                    return reply(400, {status: 'error', stderr: 'Bad request'});
                }
                total++;
                try {
                    return reply(200, await runBatch(request));
                } finally {
                    total--;
                }
            });
            return;
        }
        res.writeHead(404);
        res.end();
    });
    const wss = new WebSocketServer({noServer: true, maxPayload: 256 * 1024});

    server.on('upgrade', (req, socket, head) => {
        const refuse = (code, text) => {
            socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
        };
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/session') {
            return refuse(404, 'Not Found');
        }
        if (origins.length && !origins.includes(req.headers.origin)) {
            return refuse(403, 'Forbidden');
        }
        const payload = checker.check(url.searchParams.get('token'));
        if (!payload) {
            return refuse(401, 'Unauthorized');
        }
        const who = `${payload.s || ''}/${payload.u}`;
        if (total >= maxSessions || (open.get(who) || 0) >= userSessions) {
            return refuse(429, 'Too Many Requests');
        }
        total++;
        open.set(who, (open.get(who) || 0) + 1);
        return wss.handleUpgrade(req, socket, head, (ws) => {
            let ended = false;
            const end = () => {
                if (!ended) {
                    ended = true;
                    total--;
                    open.set(who, open.get(who) - 1);
                    if (!open.get(who)) {
                        open.delete(who);
                    }
                }
            };
            const session = new Session(
                (message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message)),
                () => ws.close()
            );
            // The messages of a session are handled in their order (new breakpoints before the Continue that follows);
            // Stop at once.
            let queue = Promise.resolve();
            ws.on('message', (data) => {
                let message;
                try {
                    message = JSON.parse(data.toString('utf8'));
                } catch {
                    message = null;
                }
                const handle = () => session.handle(message).catch((e) => session.fail(e.message));
                if (message?.type === 'stop') {
                    handle();
                } else {
                    queue = queue.then(handle);
                }
            });
            ws.on('close', () => {
                end();
                session.stop('stopped');
                session.dispose();
            });
        });
    });

    return new Promise((resolve) => {
        server.listen(port ?? Number(process.env.CODELAB_PORT || 8090), host ?? (process.env.CODELAB_HOST || '127.0.0.1'),
            () => resolve(server));
    });
};

if (import.meta.url === `file://${process.argv[1]}`) {
    const server = await startServer();
    const {address, port} = server.address();
    process.stdout.write(`CodeLab runner on ${address}:${port}\n`);
}
