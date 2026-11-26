// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Step for C#: the program is compiled by the Roslyn compiler of the .NET SDK (csc.dll, against the reference
 * assemblies of .NET) with portable debugging information, and runs on .NET under netcoredbg, which speaks gdb's
 * machine interface. Run and grading stay on Mono. netcoredbg is in netcoredbg/ of the runner (deploy/netcoredbg.sh) or
 * in CODELAB_NETCOREDBG; .NET in DOTNET_ROOT or where the dotnet on the PATH leads.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
import {execFile} from 'node:child_process';
import {accessSync, constants, existsSync, readdirSync, realpathSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Folder of the runner. */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Compare two version strings numerically (8.0.134 > 8.0.21).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
const byVersion = (a, b) => {
    const x = a.split(/[.-]/).map(Number);
    const y = b.split(/[.-]/).map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) {
            return d;
        }
    }
    return 0;
};

/**
 * The highest version folder in a folder, or null.
 *
 * @param {string} folder
 * @returns {?string}
 */
const newest = (folder) => {
    try {
        const names = readdirSync(folder).filter((n) => /^\d+\.\d+\.\d+/.test(n)).sort(byVersion);
        return names.length ? names[names.length - 1] : null;
    } catch {
        return null;
    }
};

/**
 * The folder of .NET: DOTNET_ROOT, else the real folder of the dotnet on the PATH.
 *
 * @returns {?string}
 */
export const dotnetRoot = () => {
    if (process.env.DOTNET_ROOT && existsSync(join(process.env.DOTNET_ROOT, 'dotnet'))) {
        return process.env.DOTNET_ROOT;
    }
    for (const dir of String(process.env.PATH || '').split(':').concat('/usr/bin')) {
        const candidate = join(dir, 'dotnet');
        if (dir && existsSync(candidate)) {
            try {
                return dirname(realpathSync(candidate));
            } catch {
                // A broken link: try the next.
            }
        }
    }
    return null;
};

/**
 * The folder with the netcoredbg program, or null.
 *
 * @returns {?string}
 */
export const netcoredbgDir = () => [process.env.CODELAB_NETCOREDBG, join(ROOT, 'netcoredbg'), '/usr/local/lib/netcoredbg']
    .find((dir) => dir && existsSync(join(dir, 'netcoredbg'))) || null;

let found;

/**
 * What Step of C# needs, found once: .NET, its compiler and reference assemblies, and netcoredbg; null when something
 * is missing (C# then runs without Step).
 *
 * @returns {?{root: string, csc: string, refs: string[], framework: string, debugger: string, folders: string[]}}
 */
export const csharpDebug = () => {
    if (found !== undefined) {
        return found;
    }
    found = null;
    const root = dotnetRoot();
    const debuggerDir = netcoredbgDir();
    if (!root || !debuggerDir) {
        return found;
    }
    const sdk = newest(join(root, 'sdk'));
    const refPack = join(root, 'packs', 'Microsoft.NETCore.App.Ref');
    const refVersion = newest(refPack);
    const csc = sdk ? join(root, 'sdk', sdk, 'Roslyn', 'bincore', 'csc.dll') : '';
    if (!sdk || !refVersion || !existsSync(csc)) {
        return found;
    }
    const [major, minor] = refVersion.split('.');
    const refDir = join(refPack, refVersion, 'ref', `net${major}.${minor}`);
    let refs = [];
    try {
        refs = readdirSync(refDir).filter((n) => n.endsWith('.dll')).map((n) => join(refDir, n));
    } catch {
        return found;
    }
    if (!refs.length) {
        return found;
    }
    found = {
        root,
        csc,
        refs,
        framework: `${major}.${minor}.0`,
        debugger: join(debuggerDir, 'netcoredbg'),
        // Mounted read-only in the sandbox where they are, when they are not under /usr already.
        folders: [root, debuggerDir].filter((dir) => !dir.startsWith('/usr/')),
    };
    return found;
};

/**
 * Forget what was found (tests).
 */
export const resetCsharpDebug = () => {
    found = undefined;
};

/**
 * The runtime settings next to the compiled program, so that dotnet runs it on the shared framework.
 *
 * @param {string} framework e.g. 8.0.0
 * @returns {string}
 */
export const runtimeConfig = (framework) => JSON.stringify({
    runtimeOptions: {tfm: `net${framework.split('.').slice(0, 2).join('.')}`,
        framework: {name: 'Microsoft.NETCore.App', version: framework}},
});

/**
 * Environment of .NET in the sandbox: its heap is limited by its own setting, as a limit of the address space breaks
 * the runtime.
 *
 * @param {string} root
 * @param {number} heapMb
 * @returns {Object<string, string>}
 */
export const dotnetEnv = (root, heapMb) => ({
    DOTNET_ROOT: root,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_gcServer: '0',
    DOTNET_GCHeapHardLimit: `0x${(heapMb * 1024 * 1024).toString(16)}`,
    // W^X maps the code through a large file, which the file size limit of the sandbox stops (SIGXFSZ).
    DOTNET_EnableWriteXorExecute: '0',
});

/**
 * When the server has .NET but no netcoredbg yet, download it into netcoredbg/ of the runner in the background
 * (deploy/netcoredbg.sh: a fixed version checked by its SHA-256), so that an update by the deploy of an older version
 * also gets Step for C#. Only when the runner folder is writable; CODELAB_NETCOREDBG_AUTO=0 turns it off.
 *
 * @param {function(string): void} [log]
 * @returns {Promise<boolean>} whether netcoredbg is there afterwards
 */
export const ensureNetcoredbg = (log = () => undefined) => new Promise((resolve) => {
    if (netcoredbgDir() || !dotnetRoot() || process.env.CODELAB_NETCOREDBG_AUTO === '0') {
        resolve(Boolean(netcoredbgDir()));
        return;
    }
    try {
        accessSync(ROOT, constants.W_OK);
    } catch {
        resolve(false);
        return;
    }
    execFile('bash', [join(ROOT, 'deploy', 'netcoredbg.sh')], {cwd: ROOT, timeout: 180000}, (error, stdout) => {
        resetCsharpDebug();
        log(error ? `netcoredbg: ${error.message}` : String(stdout).trim());
        resolve(Boolean(netcoredbgDir()));
    });
});
