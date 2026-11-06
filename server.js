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
 * CODELAB_NPROC (0: off), CODELAB_TMP.
 *
 * GET /health answers {ok, sessions, languages}; WebSocket /session?token=... opens a session (see lib/session.js).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {LANGUAGES} from './lib/sandbox.js';
import {Session} from './lib/session.js';
import {TokenChecker} from './lib/token.js';

/**
 * Start the server.
 *
 * @param {Object} [options]
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {string} [options.secret]
 * @returns {Promise<import('node:http').Server>}
 */
export const startServer = ({port, host, secret} = {}) => {
    const checker = new TokenChecker(secret ?? process.env.CODELAB_SECRET);
    const origins = (process.env.CODELAB_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
    const maxSessions = Number(process.env.CODELAB_MAX_SESSIONS || 30);
    const userSessions = Number(process.env.CODELAB_USER_SESSIONS || 2);
    /** @type {Map<string, number>} open sessions by site and user */
    const open = new Map();
    let total = 0;

    const server = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
            res.end(JSON.stringify({ok: true, sessions: total, languages: Object.keys(LANGUAGES)}));
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
            ws.on('message', (data) => {
                let message;
                try {
                    message = JSON.parse(data.toString('utf8'));
                } catch {
                    message = null;
                }
                session.handle(message).catch((e) => session.fail(e.message));
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
