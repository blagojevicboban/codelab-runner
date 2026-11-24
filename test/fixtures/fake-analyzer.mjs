// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * A stand-in for the Roslyn analyzer in the tests: answers each JSON line with what it got, never answers code
 * 'silent', and ends the process for code 'crash'.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {createInterface} from 'node:readline';

createInterface({input: process.stdin}).on('line', (line) => {
    const request = JSON.parse(line);
    if (request.code === 'silent') {
        return;
    }
    if (request.code === 'crash') {
        process.exit(3);
    }
    process.stdout.write(JSON.stringify({id: request.id, op: request.op, length: request.code.length,
        line: request.line, column: request.column, files: request.files.length, pid: process.pid}) + '\n');
});
