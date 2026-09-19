'use strict';

/**
 * Rebuilds champions.json from pokebase.app's Pokemon Champions roster.
 *
 *   node scripts/fetch-champions.js            # data only, sprites stay remote
 *   node scripts/fetch-champions.js --sprites  # also mirror artwork locally
 *
 * The roster is server-rendered into a table. ?page=N paging is unreliable —
 * pages overlap and drop rows, so four "full" pages only yield ~317 of 342 —
 * but ?pageSize=N renders the whole roster in one request, which is what this
 * uses. Columns: Pokemon | Usage | HP | ATK | DEF | SpA | SpD | SPD, holding
 * the Champions stat values rather than the mainline base stats.
 */

const fs = require('fs');
const path = require('path');

const LIST_URL = 'https://pokebase.app/pokemon-champions/pokemon';
const OUT_PATH = path.join(__dirname, '..', 'champions.json');
const SPRITE_DIR = path.join(__dirname, '..', 'public', 'sprites');
const PAGE_SIZE = 2000; // comfortably above the roster size; the site caps at the real total
const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

const ENTITIES = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ', '&eacute;': 'é',
};

function decode(text) {
    return text
        .replace(/&#x?[0-9a-f]+;|&[a-z]+;/gi, (match) => {
            if (ENTITIES[match]) return ENTITIES[match];
            const hex = /^&#x([0-9a-f]+);$/i.exec(match);
            if (hex) return String.fromCodePoint(parseInt(hex[1], 16));
            const dec = /^&#(\d+);$/.exec(match);
            if (dec) return String.fromCodePoint(Number(dec[1]));
            return match;
        })
        .trim();
}

async function fetchRoster() {
    const url = `${LIST_URL}?pageSize=${PAGE_SIZE}`;
    const response = await fetch(url, {
        headers: { 'user-agent': 'pokemon-draft/2.0 (personal project roster sync)' },
    });
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    return response.text();
}

/**
 * The footer prints "<n> results" — the only trustworthy total, since page
 * lengths vary between requests. The count and the word sit in separate
 * elements, so scan back from "results" for the nearest bare number.
 */
function parseTotal(html) {
    const index = html.indexOf('results');
    if (index === -1) return null;

    const window = html.slice(Math.max(0, index - 400), index);
    const numbers = [...window.matchAll(/>\s*([\d,]+)\s*</g)];
    if (numbers.length === 0) return null;

    return Number(numbers[numbers.length - 1][1].replace(/,/g, ''));
}

function parseRows(html) {
    // Rows are siblings; splitting on the row class is sturdier than trying to
    // balance nested <div>s with a regex.
    const chunks = html.split('<div class="table-row odd:bg-zinc-50').slice(1);

    return chunks.map((chunk) => {
        const slug = /href="\/pokemon-champions\/pokemon\/([^"]+)"/.exec(chunk);
        const name = /<div class="truncate">([^<]+)<\/div>/.exec(chunk);
        const art = /src="(https:\/\/img\.pokebase\.app\/pokemon-champions\/[^"]+)"/.exec(chunk);
        if (!slug || !name) return null;

        // Type icons are SVGs served from /main/; their alt text is the type name.
        const types = [...chunk.matchAll(/<img alt="([^"]+)"[^>]*src="https:\/\/img\.pokebase\.app\/main\/[^"]+\.svg"/g)]
            .map((match) => decode(match[1]));

        // Unplayed Pokemon render an empty usage cell, so the row carries six
        // numbers instead of seven. Anchoring on the last six keeps those rows.
        const numbers = [...chunk.matchAll(/tabular-nums[^>]*>([\d.]+)</g)].map((match) => Number(match[1]));
        if (numbers.length < STAT_KEYS.length) return null;

        const stats = numbers.slice(-STAT_KEYS.length);
        const usage = numbers.length > STAT_KEYS.length ? numbers[0] : null;

        const baseStats = {};
        STAT_KEYS.forEach((key, index) => {
            baseStats[key] = stats[index];
        });

        return {
            id: slug[1],
            name: decode(name[1]),
            types,
            baseStats,
            bst: STAT_KEYS.reduce((sum, key) => sum + baseStats[key], 0),
            usage,
            art: art ? art[1] : null,
        };
    }).filter(Boolean);
}

async function downloadSprites(entries) {
    fs.mkdirSync(SPRITE_DIR, { recursive: true });
    let saved = 0;
    let skipped = 0;

    for (const entry of entries) {
        if (!entry.art) continue;
        const file = path.join(SPRITE_DIR, `${entry.id}.png`);
        entry.sprite = `sprites/${entry.id}.png`;

        if (fs.existsSync(file)) {
            skipped++;
            continue;
        }
        const response = await fetch(entry.art);
        if (!response.ok) {
            console.warn(`  ! ${entry.name}: HTTP ${response.status}`);
            entry.sprite = null;
            continue;
        }
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
        saved++;
    }
    console.log(`Sprites: ${saved} downloaded, ${skipped} already present.`);
}

(async () => {
    const wantSprites = process.argv.includes('--sprites');

    const html = await fetchRoster();
    const total = parseTotal(html);
    const rows = parseRows(html);

    const byId = new Map(rows.map((row) => [row.id, row]));
    const entries = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));

    if (entries.length === 0) throw new Error('Parsed zero Pokemon — the page markup probably changed.');
    console.log(`Roster reports ${total ?? 'an unknown number of'}; parsed ${rows.length} rows, ${entries.length} unique.`);
    if (total && entries.length !== total) {
        console.warn(`Warning: expected ${total} Pokemon but kept ${entries.length}.`);
    }

    if (wantSprites) await downloadSprites(entries);

    fs.writeFileSync(OUT_PATH, `${JSON.stringify(entries, null, 2)}\n`);
    console.log(`\nWrote ${entries.length} Pokemon to ${path.relative(process.cwd(), OUT_PATH)}`);

    const untyped = entries.filter((entry) => entry.types.length === 0);
    if (untyped.length) console.warn(`Warning: ${untyped.length} entries have no types.`);
})().catch((error) => {
    console.error('Roster sync failed:', error.message);
    process.exit(1);
});
