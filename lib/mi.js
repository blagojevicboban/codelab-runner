// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * The parts of gdb's machine interface (MI) that the runner needs: a record such as
 * *stopped,reason="end-stepping-range",frame={func="main",line="5"} becomes
 * {kind: '*', class: 'stopped', data: {reason: 'end-stepping-range', frame: {func: 'main', line: '5'}}}.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/**
 * Parse a C string starting at a quote.
 *
 * @param {string} text
 * @param {number} at position of the opening quote
 * @returns {[string, number]} the string and the position after the closing quote
 */
const cstring = (text, at) => {
    let out = '';
    let i = at + 1;
    const escapes = {n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\'};
    while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
            const c = text[i + 1];
            if (/[0-7]/.test(c)) {
                const oct = /^[0-7]{1,3}/.exec(text.slice(i + 1))[0];
                out += String.fromCharCode(parseInt(oct, 8));
                i += 1 + oct.length;
                continue;
            }
            out += escapes[c] ?? c;
            i += 2;
        } else {
            out += text[i++];
        }
    }
    return [out, i + 1];
};

/**
 * Parse a value: a C string, a tuple {...} or a list [...].
 *
 * @param {string} text
 * @param {number} at
 * @returns {[*, number]}
 */
const value = (text, at) => {
    if (text[at] === '"') {
        return cstring(text, at);
    }
    const close = text[at] === '{' ? '}' : ']';
    const tuple = text[at] === '{';
    const items = tuple ? {} : [];
    let i = at + 1;
    while (i < text.length && text[i] !== close) {
        let name = null;
        if (text[i] !== '"' && text[i] !== '{' && text[i] !== '[') {
            const eq = text.indexOf('=', i);
            name = text.slice(i, eq);
            i = eq + 1;
        }
        const [item, next] = value(text, i);
        if (tuple) {
            items[name] = item;
        } else {
            items.push(item);
        }
        i = text[next] === ',' ? next + 1 : next;
    }
    return [items, i + 1];
};

/**
 * Parse one line of gdb's output.
 *
 * @param {string} line
 * @returns {{kind: string, class: string, data: Object}|{kind: string, text: string}|null}
 */
export const parseRecord = (line) => {
    const record = /^(\d*)([*+=^])([a-z-]+)(?:,(.*))?$/.exec(line);
    if (record) {
        const [items] = value(`{${record[4] || ''}}`, 0);
        return {kind: record[2], class: record[3], data: items};
    }
    const stream = /^([~@&])(".*")$/.exec(line);
    if (stream) {
        return {kind: stream[1], text: cstring(stream[2], 0)[0]};
    }
    return null;
};
