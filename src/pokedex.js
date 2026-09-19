'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHAMPIONS_PATH = path.join(ROOT, 'champions.json');
const LEGACY_PATH = path.join(ROOT, 'pokedex.json');
const SHOWDOWN_SPRITE = 'https://play.pokemonshowdown.com/sprites/gen5/';

/**
 * @typedef {object} Pokemon
 * @property {string} id
 * @property {string} name
 * @property {string[]} types
 * @property {Record<string, number>} baseStats
 * @property {number} bst
 * @property {number|null} usage        Ladder usage share, when the source has one.
 * @property {string} sprite            Resolved here so the client never builds URLs.
 * @property {{ name: string, hidden: boolean }[]} abilities
 */

/** @type {Pokemon[]} */
let dex = [];
let sourceName = '';

function sumStats(baseStats) {
    if (!baseStats || typeof baseStats !== 'object') return 0;
    return Object.values(baseStats).reduce((total, stat) => total + (Number(stat) || 0), 0);
}

function normalizeAbilities(raw) {
    if (!raw || typeof raw !== 'object') return [];
    return Object.entries(raw)
        .filter(([, name]) => typeof name === 'string' && name.length > 0)
        .map(([slot, name]) => ({ name, hidden: slot === 'H' }));
}

function usable(entry) {
    return Boolean(entry && typeof entry.name === 'string' && Array.isArray(entry.types));
}

/** Pokemon Champions roster produced by scripts/fetch-champions.js. */
function fromChampions(parsed) {
    return parsed.filter(usable).map((entry) => ({
        id: entry.id,
        name: entry.name,
        types: entry.types,
        baseStats: entry.baseStats || {},
        bst: entry.bst || sumStats(entry.baseStats),
        usage: typeof entry.usage === 'number' ? entry.usage : null,
        sprite: entry.sprite || entry.art || null,
        abilities: [],
    }));
}

/** The original slug-keyed pokedex.json, kept working as a fallback source. */
function fromLegacy(parsed) {
    const entries = Array.isArray(parsed)
        ? parsed.map((entry, index) => [entry && entry.id ? entry.id : String(index), entry])
        : Object.entries(parsed);

    return entries
        .filter(([, entry]) => usable(entry))
        .map(([id, entry]) => ({
            id,
            name: entry.name,
            types: entry.types,
            baseStats: entry.baseStats || {},
            bst: sumStats(entry.baseStats),
            usage: null,
            sprite: `${SHOWDOWN_SPRITE}${id}.png`,
            abilities: normalizeAbilities(entry.abilities),
        }));
}

/**
 * Prefers the Champions roster and falls back to the legacy dex, so a missing
 * champions.json degrades to the old behaviour instead of refusing to boot.
 */
function load() {
    if (fs.existsSync(CHAMPIONS_PATH)) {
        dex = fromChampions(JSON.parse(fs.readFileSync(CHAMPIONS_PATH, 'utf8')));
        sourceName = 'champions.json';
    } else if (fs.existsSync(LEGACY_PATH)) {
        dex = fromLegacy(JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8')));
        sourceName = 'pokedex.json';
    } else {
        throw new Error('No Pokemon data found. Run: node scripts/fetch-champions.js --sprites');
    }

    if (dex.length === 0) throw new Error(`No usable Pokemon entries in ${sourceName}`);
    return { count: dex.length, source: sourceName };
}

function size() {
    return dex.length;
}

function source() {
    return sourceName;
}

/**
 * Partial Fisher-Yates over a copy: unbiased, and it never mutates the shared
 * dex the way an in-place `.sort()` shuffle would.
 */
function drawPool(count) {
    const pool = dex.slice();
    const take = Math.max(0, Math.min(count, pool.length));
    const picked = [];

    for (let i = 0; i < take; i++) {
        const j = i + Math.floor(Math.random() * (pool.length - i));
        [pool[i], pool[j]] = [pool[j], pool[i]];
        picked.push(pool[i]);
    }
    return picked;
}

module.exports = { load, size, source, drawPool };
