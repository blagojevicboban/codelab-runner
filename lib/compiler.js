// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Compiler profiles and language standards for C and C++: whitelisted values only (never arbitrary client flags).
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Allowed compiler profiles for C and C++. */
export const COMPILERS = ['gcc', 'msvc', 'clang'];

/** Allowed C standards. */
export const C_STANDARDS = ['c99', 'c11', 'c17', 'c23'];

/** Allowed C++ standards. */
export const CPP_STANDARDS = ['c++11', 'c++14', 'c++17', 'c++20', 'c++23'];

/** Default standard per language (matches existing runner behaviour). */
export const DEFAULT_STD = {
    c: 'c11',
    cpp: 'c++17',
};

/**
 * Normalise a compiler name (accepts 'gcc', 'msvc', 'clang' or prefixed 'c-msvc', 'cpp-clang').
 *
 * @param {string} lang
 * @param {unknown} value
 * @returns {?string}
 */
const parseCompiler = (lang, value) => {
    if (value === undefined || value === null || value === '') {
        return 'gcc';
    }
    if (typeof value !== 'string') {
        return null;
    }
    const clean = value.startsWith(`${lang}-`) ? value.slice(lang.length + 1) : value;
    return COMPILERS.includes(clean) ? clean : null;
};

/**
 * Normalise a C or C++ standard (accepts 'c11' or '11' for C, 'c++17' or '17' for C++).
 *
 * @param {string} lang
 * @param {unknown} value
 * @returns {?string}
 */
const parseStd = (lang, value) => {
    if (value === undefined || value === null || value === '') {
        return DEFAULT_STD[lang];
    }
    if (typeof value !== 'string') {
        return null;
    }
    if (lang === 'c') {
        const clean = /^\d+$/.test(value) ? `c${value}` : value;
        return C_STANDARDS.includes(clean) ? clean : null;
    }
    const clean = /^\d+$/.test(value) ? `c++${value}` : value;
    return CPP_STANDARDS.includes(clean) ? clean : null;
};

/**
 * Validate and normalise compiler, standard and sanitizer options for a language.
 *
 * @param {string} lang
 * @param {Object} [raw]
 * @param {unknown} [raw.compiler]
 * @param {unknown} [raw.std]
 * @param {unknown} [raw.sanitize] enable AddressSanitizer + UndefinedBehaviorSanitizer
 * @returns {{ok: true, options: ?{compiler: string, std: string, sanitize: boolean, key: string}}|{ok: false, error: string}}
 */
export const normalizeCompileOptions = (lang, {compiler, std, sanitize = false} = {}) => {
    if (lang !== 'c' && lang !== 'cpp') {
        return {ok: true, options: null};
    }
    const cc = parseCompiler(lang, compiler);
    if (!cc) {
        return {ok: false, error: 'Unknown compiler profile.'};
    }
    const s = parseStd(lang, std);
    if (!s) {
        return {ok: false, error: 'Unknown language standard.'};
    }
    const san = Boolean(sanitize);
    return {ok: true, options: {compiler: cc, std: s, sanitize: san, key: `${cc}:${s}${san ? ':san' : ''}`}};
};
