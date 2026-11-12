// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Cache of compiled programs: the same example is run by many students without changes, and javac or mcs take a second
 * or more. An entry is the folder of a program after a successful compile (without the source), keyed by sha256 of the
 * language, the debug mode, the file name and the code, so only the same program gets the same files. The cache is
 * outside the sandbox (a program sees only its own folder). The oldest entries are removed when the cache is larger
 * than CODELAB_CACHE_MB (200; 0 turns it off). CODELAB_CACHE is the folder (default: codelab-cache in CODELAB_TMP).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {createHash, randomBytes} from 'node:crypto';
import {cp, mkdir, readdir, rename, rm, stat, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** Largest entry kept (bytes): a program that writes big files while compiling is not cached. */
const ENTRY_MAX = 64 * 1024 * 1024;

/**
 * The folder of the cache, or null when it is off.
 *
 * @returns {?string}
 */
export const cacheDir = () => {
    if (cacheLimit() <= 0) {
        return null;
    }
    return process.env.CODELAB_CACHE || join(process.env.CODELAB_TMP || tmpdir(), 'codelab-cache');
};

/**
 * Size limit of the cache in bytes.
 *
 * @returns {number}
 */
const cacheLimit = () => Number(process.env.CODELAB_CACHE_MB ?? 200) * 1024 * 1024;

/**
 * The key of a program.
 *
 * @param {string} lang
 * @param {boolean} debug
 * @param {string} file
 * @param {string} code
 * @returns {string}
 */
export const cacheKey = (lang, debug, file, code) =>
    createHash('sha256').update(`${lang}\0${debug ? 'debug' : 'run'}\0${file}\0${code}`).digest('hex');

/**
 * Size of a folder in bytes (files only).
 *
 * @param {string} dir
 * @returns {Promise<number>}
 */
const size = async(dir) => {
    let total = 0;
    for (const entry of await readdir(dir, {withFileTypes: true})) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            total += await size(path);
        } else if (entry.isFile()) {
            total += (await stat(path)).size;
        }
    }
    return total;
};

/**
 * Copy a cached program into a new program folder.
 *
 * @param {string} key
 * @param {string} dir the program's folder
 * @returns {Promise<boolean>} whether the program was in the cache
 */
export const restore = async(key, dir) => {
    const root = cacheDir();
    if (!root) {
        return false;
    }
    const entry = join(root, key);
    try {
        await cp(entry, dir, {recursive: true, force: true});
        const now = new Date();
        await utimes(entry, now, now);
        return true;
    } catch {
        return false;
    }
};

/**
 * Keep the files of a compiled program, except some (the source, FIFOs).
 *
 * @param {string} key
 * @param {string} dir the program's folder after compiling
 * @param {string[]} skip names not kept
 * @returns {Promise<void>}
 */
export const store = async(key, dir, skip) => {
    const root = cacheDir();
    if (!root) {
        return;
    }
    const temp = join(root, `.new-${randomBytes(6).toString('hex')}`);
    try {
        await mkdir(root, {recursive: true, mode: 0o700});
        await cp(dir, temp, {recursive: true, filter: (src) => !skip.some((name) => src === join(dir, name))});
        if (await size(temp) > ENTRY_MAX) {
            throw new Error('too large');
        }
        // Another session may have stored the same program meanwhile: then this copy is not needed.
        await rename(temp, join(root, key));
    } catch {
        await rm(temp, {recursive: true, force: true});
        return;
    }
    await prune(root);
};

/**
 * Remove the oldest entries while the cache is larger than its limit.
 *
 * @param {string} root
 * @returns {Promise<void>}
 */
export const prune = async(root = cacheDir()) => {
    if (!root) {
        return;
    }
    const entries = [];
    let total = 0;
    for (const name of await readdir(root).catch(() => [])) {
        if (name.startsWith('.')) {
            continue;
        }
        const path = join(root, name);
        try {
            const bytes = await size(path);
            entries.push({path, bytes, time: (await stat(path)).mtimeMs});
            total += bytes;
        } catch {
            // Removed by another prune.
        }
    }
    entries.sort((a, b) => a.time - b.time);
    const limit = cacheLimit();
    for (const entry of entries) {
        if (total <= limit) {
            break;
        }
        await rm(entry.path, {recursive: true, force: true});
        total -= entry.bytes;
    }
};
