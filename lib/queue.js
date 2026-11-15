// This file is part of CodeLab runner, the interactive server of the CodeLab plugins for Moodle.
//
// CodeLab runner is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
// License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
// version. It is distributed WITHOUT ANY WARRANTY; see <http://www.gnu.org/licenses/>.

/**
 * Places for the runs for grading (POST /run). A run that finds every place taken waits for one, at most a while,
 * instead of being refused at once: a regrade of a whole class sends many runs together. The waiting runs get the
 * places site by site in turn, so a regrade on one site does not keep the others waiting, and a site may have at
 * most siteMax places at once.
 *
 * @copyright  2026 Boban Blagojević
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
export class BatchQueue {
    /**
     * @param {Object} options
     * @param {number} options.max places on the server
     * @param {number} [options.siteMax] places of one site (default: all)
     * @param {number} [options.waitMs] longest wait for a place
     * @param {number} [options.queueMax] most waiting runs of one site; more are refused at once
     */
    constructor({max, siteMax = max, waitMs = 30000, queueMax = 500}) {
        this.max = Math.max(1, max);
        this.siteMax = Math.max(1, Math.min(siteMax, this.max));
        this.waitMs = Math.max(0, waitMs);
        this.queueMax = queueMax;
        this.running = 0;
        /** @type {Map<string, number>} running runs by site */
        this.bySite = new Map();
        /** @type {Map<string, Array<{grant: function(): void}>>} waiting runs by site */
        this.waiting = new Map();
        /** @type {Map<string, number>} when each site last got a place (a counter) */
        this.served = new Map();
        this.turn = 0;
    }

    /**
     * Runs waiting now.
     *
     * @returns {number}
     */
    get queued() {
        let count = 0;
        for (const list of this.waiting.values()) {
            count += list.length;
        }
        return count;
    }

    /**
     * Whether a site may take a place now.
     *
     * @param {string} site
     * @returns {boolean}
     */
    free(site) {
        return this.running < this.max && (this.bySite.get(site) || 0) < this.siteMax;
    }

    /**
     * Take a place.
     *
     * @param {string} site
     */
    take(site) {
        this.running++;
        this.bySite.set(site, (this.bySite.get(site) || 0) + 1);
        this.served.set(site, ++this.turn);
    }

    /**
     * Wait for a place.
     *
     * @param {string} site
     * @param {AbortSignal} [signal] the request went away: stop waiting
     * @returns {Promise<function(): void|null>} release (call it once when the run ends), or null: no place in time
     */
    acquire(site, signal) {
        const mine = this.waiting.get(site);
        if (!mine?.length && this.free(site)) {
            this.take(site);
            return Promise.resolve(this.releaser(site));
        }
        if (!this.waitMs || (mine?.length || 0) >= this.queueMax || signal?.aborted) {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => {
            const entry = {};
            const leave = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', leave);
                const list = this.waiting.get(site);
                const at = list ? list.indexOf(entry) : -1;
                if (at >= 0) {
                    list.splice(at, 1);
                    if (!list.length) {
                        this.waiting.delete(site);
                    }
                }
                resolve(null);
            };
            const timer = setTimeout(leave, this.waitMs);
            signal?.addEventListener('abort', leave, {once: true});
            entry.grant = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', leave);
                this.take(site);
                resolve(this.releaser(site));
            };
            if (!this.waiting.has(site)) {
                this.waiting.set(site, []);
            }
            this.waiting.get(site).push(entry);
        });
    }

    /**
     * The release of a place, which can be called only once.
     *
     * @param {string} site
     * @returns {function(): void}
     */
    releaser(site) {
        let done = false;
        return () => {
            if (done) {
                return;
            }
            done = true;
            this.running--;
            const left = (this.bySite.get(site) || 1) - 1;
            if (left) {
                this.bySite.set(site, left);
            } else {
                this.bySite.delete(site);
            }
            this.next();
        };
    }

    /**
     * Give free places to waiting runs. The place goes to the site with the fewest runs going on, and of those to
     * the one that got a place longest ago: a site with a regrade of hundreds of runs does not delay a site with one.
     */
    next() {
        while (this.running < this.max) {
            let best = null;
            for (const site of this.waiting.keys()) {
                if (!this.free(site)) {
                    continue;
                }
                const key = [this.bySite.get(site) || 0, this.served.get(site) || 0];
                if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) {
                    best = {site, key};
                }
            }
            if (!best) {
                return;
            }
            const list = this.waiting.get(best.site);
            const entry = list.shift();
            if (!list.length) {
                this.waiting.delete(best.site);
            }
            entry.grant();
        }
    }
}
