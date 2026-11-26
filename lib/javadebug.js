// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Step for Java: java-debugger/JavaDebugger.java, a debugger on the Java Debug Interface of the JDK that speaks the part
 * of gdb's machine interface the runner uses. The runner builds it with javac when it is first needed, into a folder of
 * the temporary folder named by the hash of its source, and runs it in the sandbox with that folder mounted read-only.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, renameSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

/** The source of the debugger in this checkout. */
const SOURCE = join(dirname(dirname(fileURLToPath(import.meta.url))), 'java-debugger', 'JavaDebugger.java');

/** Options of the program's JVM under the debugger (as Run: lib/sandbox.js, language java). */
export const JAVA_DEBUG_OPTIONS = '-Xmx256m -Xss8m -XX:+UseSerialGC -XX:TieredStopAtLevel=1 -Dfile.encoding=UTF-8';

let javacFound = null;
let building = null;

/**
 * Whether this server can build the debugger (a JDK with javac; CODELAB_JAVA_DEBUG=off turns Step for Java off).
 *
 * @returns {boolean}
 */
export const javaDebugAvailable = () => {
    if (process.env.CODELAB_JAVA_DEBUG === 'off' || !existsSync(SOURCE)) {
        return false;
    }
    javacFound ??= spawnSync('javac', ['-version'], {stdio: 'ignore'}).status === 0;
    return javacFound;
};

/**
 * The folder of the built debugger: one per version of its source.
 *
 * @returns {string}
 */
export const javaDebuggerDir = () => {
    const hash = createHash('sha256').update(readFileSync(SOURCE)).digest('hex').slice(0, 16);
    return join(process.env.CODELAB_TMP || tmpdir(), `codelab-java-debugger-${hash}`);
};

/**
 * Build the debugger with javac when its folder is not there yet.
 *
 * @returns {Promise<?string>} its folder, or null when it cannot be built
 */
export const buildJavaDebugger = () => {
    if (!javaDebugAvailable()) {
        return Promise.resolve(null);
    }
    const dir = javaDebuggerDir();
    if (existsSync(join(dir, 'JavaDebugger.class'))) {
        return Promise.resolve(dir);
    }
    building ??= new Promise((resolve) => {
        const work = `${dir}.build-${process.pid}`;
        const child = spawn('javac', ['-proc:none', '-d', work, SOURCE], {stdio: ['ignore', 'ignore', 'pipe']});
        let errors = '';
        child.stderr.on('data', (chunk) => {
            errors += chunk.toString('utf8');
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
        child.on('error', () => resolve(null));
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                process.stderr.write(`[java debugger] javac failed: ${errors.slice(0, 2000)}\n`);
                rmSync(work, {recursive: true, force: true});
                resolve(null);
                return;
            }
            try {
                renameSync(work, dir);
            } catch {
                // Another server built it at the same time.
                rmSync(work, {recursive: true, force: true});
            }
            resolve(existsSync(join(dir, 'JavaDebugger.class')) ? dir : null);
        });
    }).finally(() => {
        building = null;
    });
    return building;
};
