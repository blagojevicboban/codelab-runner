// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Texts of the errors sent to clients: never empty, and never a path, a stack trace or anything else of the server. The
 * details go to the log of the server (stderr) instead.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Error codes of a server that has no free processes, files or memory at the moment. */
const BUSY = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'ENOSPC']);

/** The texts clients get. */
export const MESSAGES = {
    busy: 'The server is busy. Try again in a moment.',
    compiler: 'The compiler could not be started on the server.',
    internal: 'The server could not run the program.',
    sql: 'The database for SQL could not be created.',
    start: 'The program could not be started on the server.',
};

/**
 * The text a client gets for an error of the server.
 *
 * @param {*} error what was thrown or emitted
 * @param {string} [fallback] the text when the server is not just busy
 * @returns {string}
 */
export const clientError = (error, fallback = MESSAGES.internal) => (BUSY.has(error?.code) ? MESSAGES.busy : fallback);

/**
 * A text for a client: the given one, or a general one when it is empty.
 *
 * @param {*} message
 * @returns {string}
 */
export const nonEmpty = (message) => (typeof message === 'string' && message.trim() !== '' ? message : MESSAGES.internal);

/**
 * Write an error to the log of the server.
 *
 * @param {string} where what failed
 * @param {*} error
 */
export const logError = (where, error) => {
    const detail = error instanceof Error ? `${error.code ? `${error.code} ` : ''}${error.message}` : String(error);
    process.stderr.write(`codelab-runner: ${where}: ${detail}\n`);
};

/**
 * The output of a compilation that failed: the compiler's messages, or a short reason when it printed none (stopped by
 * a signal or a limit).
 *
 * @param {{code: ?number, signal: ?string, output: string}} result
 * @returns {string}
 */
export const compileFailure = ({code, signal, output}) => {
    if (output.trim() !== '') {
        return output;
    }
    return signal ? `The compiler was stopped (${signal}).` : `The compiler ended with code ${code} and no message.`;
};
