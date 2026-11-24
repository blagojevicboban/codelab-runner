// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * CodeLab runner: keeps a student's program running while the student types its input in the browser (WebSocket
 * /session), and runs programs to their end for grading (POST /run), so that a site needs no Jobe server.
 *
 *   CODELAB_SECRET=<the secret of the tiny_codelab settings> node server.js
 *
 * Environment: CODELAB_PORT (8090), CODELAB_HOST (127.0.0.1, put a TLS proxy in front), CODELAB_SECRET,
 * CODELAB_SECRETS (site:secret pairs, see lib/token.js), CODELAB_ORIGINS (allowed Origin headers, comma separated; empty
 * allows any), CODELAB_MAX_SESSIONS (30), CODELAB_USER_SESSIONS (2), CODELAB_BATCH_MAX (10 runs for grading at a time,
 * beside the sessions), CODELAB_CPU_SECONDS (10), CODELAB_WALL_SECONDS (300), CODELAB_MAX_OUTPUT (100000),
 * CODELAB_NPROC (0: off), CODELAB_TMP, CODELAB_REQUIRE_NONCE, CODELAB_DEPLOY_SECRET (GitHub webhook, POST /deploy),
 * CODELAB_BATCH_WAIT (30 s a run for grading waits for a place), CODELAB_BATCH_SITE_MAX (places of one site).
 *
 * GET /health answers {ok, languages}, and with a signed request (as POST /run, empty body) also the version and the
 * numbers of sessions and runs; WebSocket /session?token=... opens a session (see lib/session.js).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {WebSocketServer} from 'ws';
import {LANGUAGES, languageAvailable, languageVersions} from './lib/sandbox.js';
import {mysqlConfigured} from './lib/mysql.js';
import {Session} from './lib/session.js';
import {NonceList, Secrets, TokenChecker} from './lib/token.js';
import {BatchQueue} from './lib/queue.js';
import {COMPAT, runBatch, signedRequest} from './lib/batch.js';
import {handleDeploy} from './lib/deploy.js';
import {clientError, logError} from './lib/errors.js';
import {Analyzer, cleanRequest} from './lib/analysis.js';

/** Version of the runner (package.json). */
/** Largest body of a run for grading (program and input), CODELAB_RUN_BODY_MB. */
const RUN_BODY_MAX = Number(process.env.CODELAB_RUN_BODY_MB || 8) * 1024 * 1024;

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

/**
 * Whether a module is the one Node was started with (node server.js), so that importing it (tests, a service built on
 * startServer) does not start a server. The script path becomes a file URL as Node makes it, so paths with spaces or
 * other special characters match too.
 *
 * @param {string} moduleUrl import.meta.url of the module
 * @param {string|undefined} scriptPath process.argv[1], missing or empty when Node runs no script (REPL, -e)
 * @returns {boolean}
 */
export const isMain = (moduleUrl, scriptPath) => Boolean(scriptPath) && moduleUrl === pathToFileURL(scriptPath).href;

/**
 * Start the server.
 *
 * @param {Object} [options]
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {string} [options.secret] the secret of every site (default CODELAB_SECRET)
 * @param {string} [options.secrets] site:secret pairs (default CODELAB_SECRETS)
 * @param {function(): void} [options.exit] how a webhook update ends the process (default: exit, systemd restarts)
 * @param {{of: function(string): string}} [options.secretsResolver] custom site-to-secret resolver
 * @param {function(string, string): boolean} [options.allowOrigin] per-site Origin check
 * @param {function({type: string, site: string, activeSiteSessions: number}): {ok: boolean, code?: number, reason?: string}} [options.authorize] pre-run check
 * @param {function({type: string, site: string}): void} [options.onRun] called when a session or batch run starts
 * @param {function(import('node:http').IncomingMessage, import('node:http').ServerResponse, {secrets: Object}): boolean} [options.onRequest] extra HTTP routes
 * @param {Analyzer} [options.analyzer] the C# language service (default: the Roslyn analyzer of this server, if published)
 * @returns {Promise<import('node:http').Server>}
 */
export const startServer = ({port, host, secret, secrets, exit = () => process.exit(75),
    secretsResolver, allowOrigin, authorize, onRun, onRequest, analyzer} = {}) => {
    const theSecrets = secretsResolver ?? new Secrets(secret ?? process.env.CODELAB_SECRET, secrets ?? process.env.CODELAB_SECRETS);
    const checker = new TokenChecker(theSecrets);
    const runNonces = new NonceList();
    const origins = (process.env.CODELAB_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
    const originAllowed = allowOrigin ?? ((_site, origin) => !origins.length || origins.includes(origin));
    const maxSessions = Number(process.env.CODELAB_MAX_SESSIONS || 30);
    const userSessions = Number(process.env.CODELAB_USER_SESSIONS || 2);
    const batchMax = Number(process.env.CODELAB_BATCH_MAX || 10);
    const queue = new BatchQueue({max: batchMax, siteMax: Number(process.env.CODELAB_BATCH_SITE_MAX || batchMax),
        waitMs: Number(process.env.CODELAB_BATCH_WAIT ?? 30) * 1000});
    /** @type {Map<string, number>} open sessions by site and user */
    const open = new Map();
    /** @type {Map<string, number>} open sessions by site */
    const siteOpen = new Map();
    let total = 0;
    // The C# language service (lib/analysis.js): its connections are not sessions, run nothing and use no quota.
    const theAnalyzer = analyzer ?? new Analyzer();
    const maxAnalysis = Number(process.env.CODELAB_MAX_ANALYSIS || 200);
    const userAnalysis = Number(process.env.CODELAB_USER_ANALYSIS || 4);
    /** @type {Map<string, number>} open analysis connections by site and user */
    const analysisOpen = new Map();
    let analysisTotal = 0;

    /**
     * A connection of the C# language service: a token with p = analysis and l = csharp, at most userAnalysis per
     * user, requests of at most 20 a second, closed after 30 minutes without one.
     */
    const openAnalysis = (req, socket, head, payload, refuse) => {
        if (payload.p !== 'analysis' || payload.l !== 'csharp') {
            return refuse(401, 'Unauthorized');
        }
        const site = String(payload.s || '');
        const auth = authorize ? authorize({type: 'analysis', site, activeSiteSessions: siteOpen.get(site) || 0}) : {ok: true};
        if (!auth.ok) {
            return refuse(auth.code === 429 ? 429 : 403, auth.code === 429 ? 'Too Many Requests' : 'Forbidden');
        }
        const who = `${site}/${payload.u}`;
        if (analysisTotal >= maxAnalysis || (analysisOpen.get(who) || 0) >= userAnalysis) {
            return refuse(429, 'Too Many Requests');
        }
        analysisTotal++;
        analysisOpen.set(who, (analysisOpen.get(who) || 0) + 1);
        return wss.handleUpgrade(req, socket, head, (ws) => {
            let window = Date.now();
            let count = 0;
            let idle = null;
            const keepAlive = () => {
                clearTimeout(idle);
                idle = setTimeout(() => ws.close(4001, 'idle'), 30 * 60000);
                idle.unref?.();
            };
            keepAlive();
            ws.on('message', async(data) => {
                let message;
                try {
                    message = JSON.parse(data.toString('utf8'));
                } catch {
                    message = null;
                }
                const id = Number.isInteger(message?.id) ? message.id : 0;
                const send = (answer) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({id, ...answer}));
                const now = Date.now();
                if (now - window > 1000) {
                    window = now;
                    count = 0;
                }
                if (++count > 20) {
                    return send({busy: true});
                }
                keepAlive();
                const request = cleanRequest(message);
                if (!request) {
                    return send({error: 'request'});
                }
                const answer = await theAnalyzer.ask(request);
                return send(answer ?? {error: 'analyzer'});
            });
            ws.on('close', () => {
                clearTimeout(idle);
                analysisTotal--;
                analysisOpen.set(who, analysisOpen.get(who) - 1);
                if (!analysisOpen.get(who)) {
                    analysisOpen.delete(who);
                }
            });
        });
    };

    const server = createServer(async(req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            const languages = Object.keys(LANGUAGES).filter((lang) =>
                languageAvailable(lang) && (lang !== 'mysql' || mysqlConfigured()));
            // The load of the server and the versions only for Moodle (signed like a run), not for anyone who asks.
            const signed = signedRequest(theSecrets, req.headers, '');
            const all = signed ? await languageVersions() : {};
            const compilers = Object.fromEntries(
                [['gcc', all.c || ''], ['clang', all.clang || '']].filter(([, v]) => v)
            );
            res.writeHead(200, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
            const analysis = theAnalyzer.available() && languages.includes('csharp') ? ['csharp'] : [];
            res.end(JSON.stringify(signed ? {ok: true, languages, analysis, version: VERSION, sessions: total,
                runs: queue.running, queued: queue.queued,
                versions: Object.fromEntries(languages.map((lang) => [lang, all[lang] || ''])), compilers, compat: COMPAT,
                analysisConnections: analysisTotal}
                : {ok: true, languages, analysis}));
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
            // A run for grading, from Moodle's server (signed with the secret), not from a browser. Tests of contest
            // problems have inputs of megabytes, as on Jobe. The body is collected as bytes: a letter of several bytes
            // may be split between two chunks.
            const chunks = [];
            let size = 0;
            let tooLarge = false;
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > RUN_BODY_MAX) {
                    tooLarge = true;
                } else {
                    chunks.push(chunk);
                }
            });
            req.on('end', async() => {
                const reply = (code, data) => {
                    res.writeHead(code, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify(data));
                };
                if (tooLarge) {
                    return reply(413, {status: 'error', stdout: '', cmpinfo: '',
                        stderr: `The program and its input are larger than ${RUN_BODY_MAX} bytes.`});
                }
                const body = Buffer.concat(chunks).toString('utf8');
                if (!signedRequest(theSecrets, req.headers, body, runNonces)) {
                    return reply(401, {status: 'error', stderr: 'Unauthorized'});
                }
                const site = String(req.headers['x-codelab-site'] || '');
                if (authorize) {
                    const auth = authorize({type: 'batch', site, activeSiteSessions: siteOpen.get(site) || 0});
                    if (!auth.ok) {
                        return reply(auth.code || 200, {status: auth.reason || 'quota', stdout: '', stderr: '', cmpinfo: ''});
                    }
                }
                let request;
                try {
                    request = JSON.parse(body);
                } catch {
                    return reply(400, {status: 'error', stderr: 'Bad request'});
                }
                // Runs for grading have their own places: a regrade does not take the students' sessions. When all
                // are taken, the run waits its site's turn (lib/queue.js), and only then is refused as busy.
                const gone = new AbortController();
                res.on('close', () => gone.abort());
                const release = await queue.acquire(site, gone.signal);
                if (!release) {
                    return gone.signal.aborted ? undefined : reply(200, {status: 'busy', stdout: '', stderr: '', cmpinfo: ''});
                }
                onRun?.({type: 'batch', site});
                try {
                    return reply(200, await runBatch(request));
                } finally {
                    release();
                }
            });
            return;
        }
        if (onRequest?.(req, res, {secrets: theSecrets})) {
            return;
        }
        res.writeHead(404);
        res.end();
    });
    const wss = new WebSocketServer({noServer: true, maxPayload: 512 * 1024});

    server.on('upgrade', (req, socket, head) => {
        // A client that drops the connection while it is refused must not end the server with an unhandled error.
        socket.on('error', () => null);
        const refuse = (code, text) => {
            socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
        };
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname !== '/session' && !(url.pathname === '/analysis' && theAnalyzer.available())) {
            return refuse(404, 'Not Found');
        }
        const payload = checker.check(url.searchParams.get('token'));
        if (!payload) {
            return refuse(401, 'Unauthorized');
        }
        const site = String(payload.s || '');
        if (!originAllowed(site, req.headers.origin || '')) {
            return refuse(403, 'Forbidden');
        }
        if (url.pathname === '/analysis') {
            return openAnalysis(req, socket, head, payload, refuse);
        }
        if (payload.p === 'analysis') {
            // A token for the language service does not run programs.
            return refuse(401, 'Unauthorized');
        }
        const auth = authorize ? authorize({type: 'session', site, activeSiteSessions: siteOpen.get(site) || 0}) : {ok: true};
        if (!auth.ok && auth.code === 429) {
            return refuse(429, 'Too Many Requests');
        }
        const who = `${site}/${payload.u}`;
        if (total >= maxSessions || (open.get(who) || 0) >= userSessions) {
            return refuse(429, 'Too Many Requests');
        }
        if (!auth.ok) {
            return wss.handleUpgrade(req, socket, head, (ws) => {
                ws.send(JSON.stringify({type: 'error', reason: auth.reason || 'quota', message: auth.reason || 'quota'}));
                ws.close(4000, auth.reason || 'quota');
            });
        }
        onRun?.({type: 'session', site});
        total++;
        open.set(who, (open.get(who) || 0) + 1);
        siteOpen.set(site, (siteOpen.get(site) || 0) + 1);
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
                    siteOpen.set(site, siteOpen.get(site) - 1);
                    if (!siteOpen.get(site)) {
                        siteOpen.delete(site);
                    }
                }
            };
            const session = new Session(
                (message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message)),
                () => ws.close(),
                {lang: typeof payload.l === 'string' ? payload.l : null}
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
                const handle = () => session.handle(message).catch((e) => {
                    logError('session', e);
                    return session.fail(clientError(e));
                });
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

if (isMain(import.meta.url, process.argv[1])) {
    const server = await startServer();
    const {address, port} = server.address();
    process.stdout.write(`CodeLab runner on ${address}:${port}\n`);
}
