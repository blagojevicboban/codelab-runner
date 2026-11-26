// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Values of C# variables while a program runs step by step under netcoredbg. The debugger shows an object only by its
 * type ({System.Collections.Generic.List<int>}); here the contents are read through its variable objects (-var-create,
 * -var-list-children), in the notation gdb uses for C and C++, so the plugin shows them the same way:
 * arrays and lists {3, 1, 2}, two-dimensional arrays {{1, 2}, {3, 4}}, dictionaries {["Ana"] = 16},
 * sets {7, 8} and objects {Value = 1, Next = {Node}}.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Most elements shown of a collection. */
const MAX_ITEMS = 30;

/** Most fields shown of an object. */
const MAX_FIELDS = 12;

/** Value of netcoredbg for an object that is not shown by itself: {Type}. */
const OBJECT = /^\{.*\}$/;

/** An array type: int[], int[,], string[][]. */
const ARRAY = /\[[ ,]*\]$/;

/** Collections whose ToArray() gives their elements in order. */
const TO_ARRAY = /^System\.Collections\.Generic\.(?:List|Queue|Stack|LinkedList|SortedSet)<|^System\.Collections\.Generic\.LinkedList</;

/**
 * The name of a method of netcoredbg's frame: Program.Fact() gives Fact, Node..ctor() gives Node.
 *
 * @param {string} func
 * @returns {string}
 */
export const methodName = (func) => {
    const name = String(func || '').replace(/\(.*\)$/, '');
    const ctor = /(?:^|\.)([^.]+)\.\.c?ctor$/.exec(name);
    if (ctor) {
        return ctor[1];
    }
    const parts = name.split('.');
    return parts[parts.length - 1] || name;
};

/**
 * Join the shown elements of a collection, with ... when there are more.
 *
 * @param {string[]} items
 * @param {number} total
 * @returns {string}
 */
const braces = (items, total) => `{${items.join(', ')}${total > items.length ? ', ...' : ''}}`;

export class CsValues {
    /**
     * Reader of values in one stop of the program.
     *
     * @param {function(string): Promise<Object>} command sends an MI command and gives its result record
     * @param {string} thread thread id of the stop
     * @param {number} [budget] most MI commands for all values of this stop
     */
    constructor(command, thread, budget = 150) {
        this.command = command;
        this.thread = thread;
        this.budget = budget;
    }

    /**
     * A variable object of an expression in a frame, or null.
     *
     * @param {string} expression
     * @param {number} level
     * @returns {Promise<?{name: string, value: string, type: string, numchild: number}>}
     */
    async create(expression, level) {
        if (this.budget <= 0) {
            return null;
        }
        this.budget--;
        const escaped = expression.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const result = await this.command(`-var-create - * "${escaped}" --thread ${this.thread} --frame ${level}`);
        if (result.class !== 'done' || typeof result.data?.name !== 'string') {
            return null;
        }
        return {name: result.data.name, value: String(result.data.value ?? ''), type: String(result.data.type ?? ''),
            numchild: Number(result.data.numchild) || 0};
    }

    /**
     * The children of a variable object.
     *
     * @param {string} name
     * @returns {Promise<Array<{exp: string, value: string, type: string, name: string}>>}
     */
    async children(name) {
        if (this.budget <= 0) {
            return [];
        }
        this.budget--;
        const result = await this.command(`-var-list-children --all-values ${name}`);
        const list = result.class === 'done' && Array.isArray(result.data?.children) ? result.data.children : [];
        return list.map((c) => ({exp: String(c.exp ?? ''), value: String(c.value ?? ''), type: String(c.type ?? ''),
            name: String(c.name ?? '')}));
    }

    /**
     * Remove a variable object (and its children) from netcoredbg.
     *
     * @param {string} name
     */
    async remove(name) {
        await this.command(`-var-delete ${name}`);
    }

    /**
     * The value of an expression in a frame, shown with its contents; null when netcoredbg cannot evaluate it.
     *
     * @param {string} expression
     * @param {number} level
     * @returns {Promise<?string>}
     */
    async evaluate(expression, level) {
        const root = await this.create(expression, level);
        if (!root) {
            return null;
        }
        try {
            return await this.show(root, expression, level, 0);
        } finally {
            await this.remove(root.name);
        }
    }

    /**
     * The shown value of a variable whose plain value is known (from -stack-list-variables).
     *
     * @param {string} name
     * @param {string} value
     * @param {number} level
     * @returns {Promise<string>}
     */
    async variable(name, value, level) {
        if (!OBJECT.test(value) || this.budget <= 0) {
            return value;
        }
        return (await this.evaluate(name, level)) ?? value;
    }

    /**
     * The shown value of a variable object.
     *
     * @param {{name: string, value: string, type: string, numchild: number}} object
     * @param {string} expression
     * @param {number} level
     * @param {number} depth how deep inside another value
     * @returns {Promise<string>}
     */
    async show(object, expression, level, depth) {
        const {value, type} = object;
        if (!OBJECT.test(value) || depth > 1) {
            return value;
        }
        if (ARRAY.test(type)) {
            return this.array(object, level, depth);
        }
        if (TO_ARRAY.test(type)) {
            const copy = await this.create(`${expression}.ToArray()`, level);
            if (copy) {
                try {
                    return await this.array(copy, level, depth);
                } finally {
                    await this.remove(copy.name);
                }
            }
            return value;
        }
        if (/^System\.Collections\.Generic\.(?:Dictionary|HashSet)</.test(type)) {
            return this.hashed(object, expression, level, type.includes('Dictionary<'));
        }
        if (type.startsWith('System.')) {
            return value;
        }
        return this.fields(object, level, depth);
    }

    /**
     * An array: one or more dimensions ([0, 1] children of a two-dimensional array are grouped by row).
     *
     * @param {{name: string, numchild: number}} object
     * @param {number} level
     * @param {number} depth
     * @returns {Promise<string>}
     */
    async array(object, level, depth) {
        const items = await this.children(object.name);
        const shown = [];
        const rows = new Map();
        for (const item of items) {
            const value = await this.inner(item, level, depth);
            const two = /^\[(\d+), (\d+)\]$/.exec(item.exp);
            if (two) {
                if (!rows.has(two[1])) {
                    rows.set(two[1], []);
                }
                rows.get(two[1]).push(value);
            } else if (shown.length < MAX_ITEMS) {
                shown.push(value);
            }
        }
        if (rows.size) {
            return braces([...rows.values()].slice(0, MAX_ITEMS).map((row) => braces(row, row.length)), rows.size);
        }
        return braces(shown, Math.max(items.length, object.numchild));
    }

    /**
     * A Dictionary or a HashSet, from its entries: the used ones are the first _count with next >= -1. The fields of an
     * entry are read one by one (netcoredbg does not list the children of a Dictionary entry).
     *
     * @param {{name: string, value: string}} object
     * @param {string} expression
     * @param {number} level
     * @param {boolean} dictionary
     * @returns {Promise<string>}
     */
    async hashed(object, expression, level, dictionary) {
        const fields = await this.children(object.name);
        const count = Number(fields.find((f) => f.exp === '_count')?.value);
        const entries = fields.find((f) => f.exp === '_entries');
        if (!entries || !Number.isFinite(count)) {
            return object.value;
        }
        if (count === 0 || entries.value === 'null') {
            return '{}';
        }
        const [keyName, valueName, nextName] = dictionary ? ['key', 'value', 'next'] : [null, 'Value', 'Next'];
        const field = async(i, name) => {
            const part = await this.create(`${expression}._entries[${i}].${name}`, level);
            if (!part) {
                return null;
            }
            await this.remove(part.name);
            return part.value;
        };
        const shown = [];
        let used = 0;
        for (let i = 0; i < count; i++) {
            if (shown.length >= MAX_ITEMS || this.budget <= 0) {
                // The rest is counted as more without reading it.
                used += count - i;
                break;
            }
            if (Number(await field(i, nextName)) < -1) {
                continue;
            }
            used++;
            const value = await field(i, valueName);
            if (value === null) {
                continue;
            }
            shown.push(keyName ? `[${await field(i, keyName)}] = ${value}` : value);
        }
        return braces(shown, used);
    }

    /**
     * An object of the program's own class: its fields and properties.
     *
     * @param {{name: string, value: string}} object
     * @param {number} level
     * @param {number} depth
     * @returns {Promise<string>}
     */
    async fields(object, level, depth) {
        const own = (await this.children(object.name))
            .filter((f) => f.exp !== 'Static members' && /^[A-Za-z_]\w*$/.test(f.exp));
        if (!own.length) {
            return object.value;
        }
        const shown = [];
        for (const field of own.slice(0, MAX_FIELDS)) {
            shown.push(`${field.exp} = ${await this.inner(field, level, depth)}`);
        }
        return `{${shown.join(', ')}${own.length > MAX_FIELDS ? ', ...' : ''}}`;
    }

    /**
     * The value of an element or a field: its contents one level deep (a list of arrays), an object by its type.
     *
     * @param {{name: string, value: string, type: string}} child
     * @param {number} level
     * @param {number} depth
     * @returns {Promise<string>}
     */
    async inner(child, level, depth) {
        if (!OBJECT.test(child.value) || depth >= 1 || !(ARRAY.test(child.type) || TO_ARRAY.test(child.type))) {
            return child.value;
        }
        if (ARRAY.test(child.type)) {
            return this.array({name: child.name, numchild: 0}, level, depth + 1);
        }
        return child.value;
    }
}
