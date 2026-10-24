'use strict';
// Timings, for finding what makes Dendrite slow in Obsidian: how long
// each of its steps takes, kept per step while recording is on, and
// taken every so often to be written out. Off, a step costs one check.

const stats = new Map();
const long = { n: 0, total: 0, max: 0 };
const frames = { n: 0, total: 0, max: 0, layout: 0, scripts: new Map() };
const watched = new WeakSet();
let on = false;

const now = () => (typeof performance !== 'undefined' ?
    performance.now() : Date.now());

function setOn(value) {
    on = !!value;
    if (!on) {
        stats.clear();
        clearLong();
    }
}

function clearLong() {
    Object.assign(long, { n: 0, total: 0, max: 0 });
    Object.assign(frames, { n: 0, total: 0, max: 0, layout: 0 });
    frames.scripts.clear();
}

function isOn() {
    return on;
}

/** One run of `step`, `ms` long. */
function record(step, ms) {
    if (!on) return;
    const s = stats.get(step) || { n: 0, total: 0, max: 0 };
    s.n++;
    s.total += ms;
    s.max = Math.max(s.max, ms);
    stats.set(step, s);
}

/**
 * The methods `names` of `proto` timed as `prefix.name`. One that
 * answers a promise is timed until it settles, so its time includes
 * what it waited for, such as reading a file.
 */
function wrap(proto, prefix, names) {
    for (const name of names) {
        const fn = proto[name];
        if (typeof fn !== 'function') {
            throw new Error(`timing: no method ${prefix}.${name}`);
        }
        const step = `${prefix}.${name}`;
        proto[name] = function (...args) {
            if (!on) return fn.apply(this, args);
            const t0 = now();
            let out;
            try {
                out = fn.apply(this, args);
            } catch (err) {
                record(step, now() - t0);
                throw err;
            }
            if (out && typeof out.then === 'function') {
                return out.finally(() => record(step, now() - t0));
            }
            record(step, now() - t0);
            return out;
        };
    }
}

/** One long animation frame `e`: its time, layout and scripts. */
function frame(e) {
    frames.n++;
    frames.total += e.duration;
    frames.max = Math.max(frames.max, e.duration);
    if (e.styleAndLayoutStart > 0) {
        frames.layout += e.startTime + e.duration - e.styleAndLayoutStart;
    }
    for (const s of e.scripts || []) {
        const url = String(s.sourceURL || '');
        const source = url.slice(url.lastIndexOf('/') + 1) || '(unknown)';
        frames.scripts.set(source,
                           (frames.scripts.get(source) || 0) + s.duration);
    }
}

/**
 * The window's stalls, whoever caused them, Obsidian or another plugin
 * included: long tasks, any taking 50 ms or more, and long animation
 * frames, which add the time spent on style, layout and painting, and
 * which scripts ran, by source file.
 */
function watch(win) {
    if (!win || watched.has(win) || !win.PerformanceObserver) return;
    watched.add(win);
    const observe = (type, each) => {
        try {
            new win.PerformanceObserver((list) => {
                if (on) list.getEntries().forEach(each);
            }).observe({ type, buffered: false });
        } catch (err) {
            // A window without this kind of timing.
        }
    };
    observe('longtask', (e) => {
        long.n++;
        long.total += e.duration;
        long.max = Math.max(long.max, e.duration);
    });
    observe('long-animation-frame', frame);
}

const round = (x) => Math.round(x * 10) / 10;

/**
 * What was recorded since last taken, the steps longest in all first,
 * and cleared: { steps: [{ step, n, total_ms, max_ms }], longtasks,
 * frames: { n, total_ms, max_ms, layout_ms, scripts: [{ source, ms }] } },
 * or null with nothing recorded.
 */
function take() {
    if (!stats.size && !long.n && !frames.n) return null;
    const steps = [...stats].map(([step, s]) => ({ step, n: s.n,
        total_ms: round(s.total), max_ms: round(s.max) }))
        .sort((a, b) => b.total_ms - a.total_ms);
    const longtasks = { n: long.n, total_ms: round(long.total),
                        max_ms: round(long.max) };
    const scripts = [...frames.scripts]
        .map(([source, ms]) => ({ source, ms: round(ms) }))
        .sort((a, b) => b.ms - a.ms).slice(0, 8);
    const longframes = { n: frames.n, total_ms: round(frames.total),
                         max_ms: round(frames.max),
                         layout_ms: round(frames.layout), scripts };
    stats.clear();
    clearLong();
    return { steps, longtasks, frames: longframes };
}

module.exports = { setOn, isOn, record, wrap, watch, take, frame };
