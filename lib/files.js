// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Input and output files of a run: validated names, size limits, writing input files into the run's working folder,
 * and reading the files the program created or changed after it ends.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {open, readdir, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** At most this many input files per run (matches tiny_codelab). */
export const MAX_FILES = 5;

/** At most this many characters per input or output file (matches tiny_codelab). */
export const MAX_FILE_SIZE = 65536;

/** At most this many created/changed files returned after a run. */
export const MAX_OUTPUT_FILES = 20;

/**
 * Whether an input file name is safe: letters, digits and _, with at most one dot, at most 40 characters, no folders.
 *
 * @param {string} name
 * @returns {boolean}
 */
export const validFileName = (name) => typeof name === 'string' && name.length <= 40 &&
    /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/.test(name);

/**
 * Validate and normalise the input files of a request.
 *
 * @param {unknown} files
 * @returns {{ok: true, files: Array<{name: string, text: string}>}|{ok: false, error: string}}
 */
export const normalizeFiles = (files) => {
    if (files === undefined || files === null) {
        return {ok: true, files: []};
    }
    if (!Array.isArray(files)) {
        return {ok: false, error: 'Invalid files list.'};
    }
    if (files.length > MAX_FILES) {
        return {ok: false, error: `At most ${MAX_FILES} input files are allowed.`};
    }
    const seen = new Set();
    const out = [];
    for (const file of files) {
        if (!file || typeof file !== 'object' || !validFileName(file.name) || typeof file.text !== 'string') {
            return {ok: false, error: 'Invalid file name or content.'};
        }
        if (seen.has(file.name)) {
            return {ok: false, error: `Duplicate file name: ${file.name}.`};
        }
        if (file.text.length > MAX_FILE_SIZE) {
            return {ok: false, error: `File ${file.name} is too large.`};
        }
        seen.add(file.name);
        out.push({name: file.name, text: file.text});
    }
    return {ok: true, files: out};
};

/**
 * Write validated input files into a working folder and return a map of their initial texts.
 *
 * @param {string} dir
 * @param {Array<{name: string, text: string}>} files
 * @returns {Promise<Map<string, string>>}
 */
export const writeInputFiles = async(dir, files) => {
    const given = new Map();
    for (const file of files) {
        await writeFile(join(dir, file.name), file.text, 'utf8');
        given.set(file.name, file.text);
    }
    return given;
};

/**
 * Read up to MAX_FILE_SIZE characters of a file without loading arbitrarily large files into memory.
 *
 * @param {string} path
 * @returns {Promise<{text: string, size: number}>}
 */
const readLimitedText = async(path) => {
    const info = await stat(path);
    // Up to 4 UTF-8 bytes per character, plus 1 byte to detect truncation.
    const limitBytes = MAX_FILE_SIZE * 4 + 1;
    const toRead = Math.min(info.size, limitBytes);
    if (toRead === 0) {
        return {text: '', size: 0};
    }
    const handle = await open(path, 'r');
    try {
        const buf = Buffer.alloc(toRead);
        const {bytesRead} = await handle.read(buf, 0, toRead, 0);
        const decoded = buf.subarray(0, bytesRead).toString('utf8');
        const text = decoded.slice(0, MAX_FILE_SIZE);
        const truncated = info.size > bytesRead || decoded.length > MAX_FILE_SIZE;
        const size = truncated ? Math.max(decoded.length, info.size) : text.length;
        return {text, size};
    } finally {
        await handle.close();
    }
};

/**
 * Return regular files in dir that were created or changed relative to given, sorted by name.
 *
 * @param {string} dir
 * @param {Map<string, string>} given
 * @returns {Promise<Array<{name: string, text: string, size: number}>>}
 */
export const readChangedFiles = async(dir, given) => {
    const entries = await readdir(dir, {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const out = [];
    for (const entry of entries) {
        if (!entry.isFile() || out.length >= MAX_OUTPUT_FILES) {
            continue;
        }
        try {
            const {text, size} = await readLimitedText(join(dir, entry.name));
            const initial = given.get(entry.name);
            if (initial === undefined || initial !== text || size > text.length) {
                out.push({name: entry.name, text, size});
            }
        } catch {
            // Skip unreadable entries.
        }
    }
    return out;
};
