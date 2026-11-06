// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * A database of its own for each SQL session on MariaDB: created with a user that may use only it, with a time limit per
 * statement and few connections, and dropped at the end. The runner's MariaDB user (CODELAB_MYSQL_USER, see
 * deploy/mariadb-admin.sh) may manage only databases and users named cl_...
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';

/** Seconds a statement may run. */
const STATEMENT_SECONDS = Number(process.env.CODELAB_MYSQL_STATEMENT_SECONDS || 5);

/**
 * Run SQL as the runner's MariaDB user.
 *
 * @param {string} sql
 * @returns {Promise<{code: number, output: string}>}
 */
const admin = (sql) => new Promise((resolve) => {
    const child = spawn('mariadb', ['--batch', `--socket=${process.env.CODELAB_MYSQL_SOCKET || '/run/mysqld/mysqld.sock'}`,
        '-u', process.env.CODELAB_MYSQL_USER || 'codelab_admin'],
    {env: {PATH: process.env.PATH, MYSQL_PWD: process.env.CODELAB_MYSQL_PASSWORD || ''}, stdio: ['pipe', 'pipe', 'pipe']});
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    child.on('close', (code) => resolve({code, output}));
    child.on('error', (e) => resolve({code: -1, output: e.message}));
    child.stdin.end(sql);
});

/**
 * Whether the runner can manage SQL databases (its MariaDB user is set).
 *
 * @returns {boolean}
 */
export const mysqlConfigured = () => Boolean(process.env.CODELAB_MYSQL_PASSWORD);

export class SessionDatabase {
    /**
     * A database and its user, not created yet.
     */
    constructor() {
        this.name = `cl_${randomBytes(8).toString('hex')}`;
        this.password = randomBytes(18).toString('base64url');
        this.created = false;
    }

    /**
     * Create the database and its user.
     *
     * @returns {Promise<void>}
     */
    async create() {
        const result = await admin(
            `CREATE DATABASE \`${this.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n` +
            `CREATE USER '${this.name}'@'localhost' IDENTIFIED BY '${this.password}' ` +
            `WITH MAX_USER_CONNECTIONS 2 MAX_STATEMENT_TIME ${STATEMENT_SECONDS};\n` +
            `GRANT ALL PRIVILEGES ON \`${this.name}\`.* TO '${this.name}'@'localhost';\n`
        );
        if (result.code !== 0) {
            throw new Error(`The database could not be created. ${result.output.trim()}`);
        }
        this.created = true;
    }

    /**
     * Arguments and environment of the mariadb client for this database.
     *
     * @returns {{args: string[], env: Object<string, string>}}
     */
    client() {
        return {args: ['-u', this.name, this.name], env: {MYSQL_PWD: this.password}};
    }

    /**
     * Drop the user and the database.
     *
     * @returns {Promise<void>}
     */
    async drop() {
        if (!this.created) {
            return;
        }
        this.created = false;
        await admin(`DROP USER IF EXISTS '${this.name}'@'localhost';\nDROP DATABASE IF EXISTS \`${this.name}\`;\n`);
    }
}
