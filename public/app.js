'use strict';

/* =========================================================================
   The client keeps exactly two kinds of state:

     `state`  — the last authoritative snapshot from the server. Never edited
                locally; every render reads from it.
     `ui`     — view-only preferences (search text, sort order) that the
                server has no reason to know about.

   Nothing else mutates the DOM. An incoming `state` message re-renders; an
   incoming `event` message only ever produces a toast.
   ========================================================================= */

const STORAGE_KEYS = { playerId: 'pdraft.playerId', name: 'pdraft.name' };
const RECONNECT_BASE_MS = 600;
const RECONNECT_MAX_MS = 10000;

/**
 * Seat identity lives in sessionStorage, not localStorage: it survives a
 * refresh (so reconnecting drops you back into your seat) but stays scoped to
 * one tab, so two tabs in the same browser are two different players. Sharing
 * it across tabs would make each new tab steal the previous tab's seat.
 * The display name is a convenience and can safely be shared browser-wide.
 */
const seat = {
    get id() {
        try { return sessionStorage.getItem(STORAGE_KEYS.playerId); } catch { return null; }
    },
    set id(value) {
        try {
            if (value) sessionStorage.setItem(STORAGE_KEYS.playerId, value);
            else sessionStorage.removeItem(STORAGE_KEYS.playerId);
        } catch { /* private mode: reconnect simply will not resume */ }
    },
};

function rememberName(name) {
    try { localStorage.setItem(STORAGE_KEYS.name, name); } catch { /* ignore */ }
}

function recallName() {
    try { return localStorage.getItem(STORAGE_KEYS.name) || ''; } catch { return ''; }
}

const TYPES = [
    'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison',
    'Ground', 'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy',
];

const $ = (id) => document.getElementById(id);

const el = {
    connection: $('connection'),
    connectionText: $('connectionText'),
    roomChip: $('roomChip'),
    roomChipCode: $('roomChipCode'),
    toasts: $('toasts'),

    screens: {
        home: $('screen-home'),
        lobby: $('screen-lobby'),
        draft: $('screen-draft'),
        results: $('screen-results'),
    },

    createForm: $('createForm'),
    createName: $('createName'),
    numPlayers: $('numPlayers'),
    teamSize: $('teamSize'),
    extraPerPlayer: $('extraPerPlayer'),
    pickSeconds: $('pickSeconds'),
    poolPreview: $('poolPreview'),

    joinForm: $('joinForm'),
    joinName: $('joinName'),
    joinCode: $('joinCode'),

    lobbyTitle: $('lobbyTitle'),
    lobbySummary: $('lobbySummary'),
    lobbyPlayers: $('lobbyPlayers'),
    startBtn: $('startBtn'),
    startHint: $('startHint'),
    leaveBtn: $('leaveBtn'),
    shareBtn: $('shareBtn'),

    turnBar: $('turnBar'),
    turnHeadline: $('turnHeadline'),
    turnMeta: $('turnMeta'),
    turnSeconds: $('turnSeconds'),
    turnFill: $('turnFill'),
    upNext: $('upNext'),

    poolGrid: $('poolGrid'),
    poolCount: $('poolCount'),
    poolEmpty: $('poolEmpty'),
    poolSearch: $('poolSearch'),
    poolType: $('poolType'),
    poolSort: $('poolSort'),

    teamsBoard: $('teamsBoard'),
    pickLog: $('pickLog'),

    resultsSummary: $('resultsSummary'),
    resultTeams: $('resultTeams'),
    newDraftBtn: $('newDraftBtn'),

    monTemplate: $('tpl-pokemon-card'),
};

let socket = null;
let connectionState = 'connecting';
let reconnectAttempts = 0;
let reconnectTimer = null;

/** Last authoritative snapshot. */
let state = null;
/** server clock - local clock, so the pick countdown is not skewed by a wrong system time. */
let clockOffset = 0;
let playerId = seat.id;

const ui = { search: '', type: '', sort: 'bst-desc' };
let lastPoolSignature = '';

// ------------------------------------------------------------------ utils

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
}

/**
 * Artwork paths are resolved server-side (local mirror, or a remote URL when
 * the legacy dex is in use), so the client only ever renders what it is given
 * and falls back to a monogram when an image fails.
 */
function paintSprite(container, mon) {
    container.dataset.initial = mon.name.charAt(0);
    const img = container.querySelector('img') || container.appendChild(document.createElement('img'));
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';

    if (!mon.sprite) {
        container.classList.add('no-sprite');
        return container;
    }
    img.src = mon.sprite;
    img.addEventListener('error', () => container.classList.add('no-sprite'), { once: true });
    return container;
}

function newSprite(mon) {
    const container = document.createElement('span');
    container.className = 'mon-sprite';
    return paintSprite(container, mon);
}

function plural(count, word, pluralForm) {
    return `${count} ${count === 1 ? word : pluralForm || `${word}s`}`;
}

/** "Pokémon" is its own plural. */
function mons(count) {
    return `${count} Pokémon`;
}

/** Teams are derived, never transmitted — `picks` is the only record of ownership. */
function teamsFrom(room) {
    const teams = Array.from({ length: room.players.length }, () => []);
    for (const pick of room.picks) {
        if (teams[pick.slot]) teams[pick.slot].push(pick.pokemon);
    }
    return teams;
}

function nameOfSlot(room, slot) {
    const player = room.players[slot];
    return player ? player.name : `Player ${slot + 1}`;
}

function totalBst(team) {
    return team.reduce((sum, mon) => sum + mon.bst, 0);
}

const STAT_LABELS = { hp: 'HP', atk: 'ATK', def: 'DEF', spa: 'SpA', spd: 'SpD', spe: 'SPE' };

/** Full spread on hover, so a card stays compact without hiding the numbers. */
function statLine(mon) {
    const spread = Object.entries(STAT_LABELS)
        .map(([key, label]) => `${label} ${mon.baseStats[key] ?? 0}`)
        .join(' · ');
    const usage = mon.usage == null ? '' : ` · used by ${mon.usage}% of teams`;
    const abilities = mon.abilities && mon.abilities.length
        ? ` · ${mon.abilities.map((a) => (a.hidden ? `${a.name} (hidden)` : a.name)).join(', ')}`
        : '';
    return `${mon.name} — ${spread} · BST ${mon.bst}${usage}${abilities}`;
}

// ----------------------------------------------------------------- toasts

const MAX_TOASTS = 3;

function dismissToast(toast) {
    if (toast.dataset.leaving) return;
    toast.dataset.leaving = '1';
    toast.classList.add('leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 400);
}

function showToast(message, kind, pokemon) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${kind || 'info'}`;

    if (pokemon) toast.appendChild(newSprite(pokemon));

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.innerHTML = message;
    toast.appendChild(text);

    el.toasts.appendChild(toast);

    // A fast round of picks can queue more toasts than fit on screen, and the
    // stack would cover the pick log it is narrating. Retire the oldest instead.
    const live = [...el.toasts.children].filter((node) => !node.dataset.leaving);
    for (const stale of live.slice(0, Math.max(0, live.length - MAX_TOASTS))) dismissToast(stale);

    setTimeout(() => dismissToast(toast), kind === 'error' ? 5000 : 3200);
}

// ------------------------------------------------------------- connection

function setConnection(next, text) {
    connectionState = next;
    el.connection.dataset.state = next;
    el.connectionText.textContent = text;
    for (const control of document.querySelectorAll('[data-needs-connection]')) {
        control.disabled = next !== 'open';
    }
    if (next === 'open') refreshStartButton();
}

function connect() {
    clearTimeout(reconnectTimer);
    setConnection(reconnectAttempts === 0 ? 'connecting' : 'closed',
        reconnectAttempts === 0 ? 'Connecting…' : 'Reconnecting…');

    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${scheme}//${location.host}`);

    socket.addEventListener('open', () => {
        reconnectAttempts = 0;
        setConnection('open', 'Connected');
        send('hello', { playerId });
    });

    socket.addEventListener('message', (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        handleMessage(message);
    });

    socket.addEventListener('close', () => {
        setConnection('closed', 'Reconnecting…');
        scheduleReconnect();
    });

    socket.addEventListener('error', () => socket.close());
}

function scheduleReconnect() {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts += 1;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
}

function send(type, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        showToast('Not connected to the server yet.', 'error');
        return false;
    }
    socket.send(JSON.stringify({ type, ...payload }));
    return true;
}

// -------------------------------------------------------- message routing

function handleMessage(message) {
    switch (message.type) {
        case 'welcome':
            if (message.playerId) {
                playerId = message.playerId;
                seat.id = playerId;
            } else {
                // The saved identity did not resolve (server restart, room swept).
                playerId = null;
                seat.id = null;
                showHome();
            }
            if (message.name) rememberName(message.name);
            break;

        case 'state':
            clockOffset = message.serverTime - Date.now();
            state = message;
            render();
            break;

        case 'event':
            handleEvent(message);
            break;

        case 'left':
            state = null;
            playerId = null;
            seat.id = null;
            history.replaceState(null, '', location.pathname);
            showHome();
            break;

        case 'error':
            handleServerError(message);
            break;

        default:
            console.warn('Unhandled message type:', message.type);
    }
}

function handleServerError(message) {
    // A stale saved identity is expected after a server restart: clear it and
    // drop the player back to the home screen instead of showing a dead end.
    if (message.code === 'no_session' || message.code === 'no_such_room') {
        playerId = null;
        seat.id = null;
        if (!state) showHome();
    }
    showToast(escapeHtml(message.message), 'error');
}

function handleEvent(message) {
    const mySlot = state && state.you ? state.you.slot : null;

    switch (message.event) {
        case 'pick': {
            const who = message.slot === mySlot ? 'You' : escapeHtml(message.playerName);
            const verb = message.auto ? 'auto-picked' : 'picked';
            showToast(
                `<b>${who}</b> ${verb} <b>${escapeHtml(message.pokemon.name)}</b>`,
                'pick',
                message.pokemon,
            );
            break;
        }
        case 'playerJoined':
            if (message.slot !== mySlot) showToast(`<b>${escapeHtml(message.name)}</b> joined`, 'good');
            break;
        case 'playerDisconnected':
            showToast(`<b>${escapeHtml(message.name)}</b> lost connection`, 'info');
            break;
        case 'playerLeft':
            showToast(`<b>${escapeHtml(message.name)}</b> left the room`, 'info');
            break;
        case 'renamed':
            showToast(`<b>${escapeHtml(message.previous)}</b> is now <b>${escapeHtml(message.name)}</b>`, 'info');
            break;
        case 'draftStarted':
            showToast(`Draft started — ${mons(message.poolSize)} in the pool`, 'good');
            break;
        case 'draftComplete':
            showToast('Draft complete!', 'good');
            break;
        default:
            break;
    }
}

// --------------------------------------------------------------- rendering

function showScreen(name) {
    for (const [key, node] of Object.entries(el.screens)) {
        node.hidden = key !== name;
    }
}

function showHome() {
    state = null;
    el.roomChip.hidden = true;
    showScreen('home');
    updatePoolPreview();
}

function render() {
    const room = state.room;

    el.roomChip.hidden = false;
    el.roomChipCode.textContent = room.code;

    if (location.hash.slice(1) !== room.code) {
        history.replaceState(null, '', `#${room.code}`);
    }

    if (room.phase === 'lobby') {
        showScreen('lobby');
        renderLobby(room);
    } else if (room.phase === 'drafting') {
        showScreen('draft');
        renderDraft(room);
    } else {
        showScreen('results');
        renderResults(room);
    }
}

// ------------------------------------------------------------------ lobby

function renderLobby(room) {
    el.lobbyTitle.innerHTML = `Room <code>${escapeHtml(room.code)}</code>`;

    const { teamSize, extraPerPlayer, pickSeconds, numPlayers } = room.config;
    el.lobbySummary.textContent =
        `${mons(teamSize)} each · ${pickSeconds}s per pick · ` +
        `${mons(numPlayers * (teamSize + extraPerPlayer))} in the pool · snake order`;

    el.lobbyPlayers.innerHTML = '';
    for (let slot = 0; slot < room.config.numPlayers; slot++) {
        el.lobbyPlayers.appendChild(lobbyRow(room, slot));
    }

    refreshStartButton();
}

function lobbyRow(room, slot) {
    const player = room.players[slot];
    const isYou = state.you && state.you.slot === slot;

    const row = document.createElement('li');
    row.className = 'player-row';
    if (!player) row.classList.add('is-empty');
    if (isYou) row.classList.add('is-you');

    const seat = document.createElement('span');
    seat.className = 'seat-no';
    seat.textContent = slot + 1;
    row.appendChild(seat);

    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = player ? player.name : 'Waiting…';
    row.appendChild(name);

    if (player && player.isHost) row.appendChild(tag('Host', 'tag-host'));
    if (isYou) row.appendChild(tag('You', 'tag-you'));
    if (player && !player.connected) row.appendChild(tag('Away', 'tag-away'));

    return row;
}

function tag(text, className) {
    const node = document.createElement('span');
    node.className = `tag ${className}`;
    node.textContent = text;
    return node;
}

function refreshStartButton() {
    if (!state || state.room.phase !== 'lobby') return;

    const room = state.room;
    const ready = room.players.filter((player) => player.connected).length;
    const isHost = Boolean(state.you && state.you.isHost);

    el.startBtn.hidden = !isHost;
    el.startBtn.disabled = connectionState !== 'open' || ready < 2;

    if (!isHost) {
        const host = room.players.find((player) => player.isHost);
        el.startHint.textContent = host
            ? `${host.name} will start the draft when everyone's in.`
            : 'Waiting for the host…';
    } else if (ready < 2) {
        el.startHint.textContent = 'You need at least one other player before you can start.';
    } else if (ready < room.config.numPlayers) {
        el.startHint.textContent =
            `${ready} of ${room.config.numPlayers} seats filled. ` +
            `Starting now drafts with ${ready} — the empty seats are dropped.`;
    } else {
        el.startHint.textContent = 'Everyone is here. Good to go.';
    }
}

// ------------------------------------------------------------------ draft

function renderDraft(room) {
    const turn = room.turn;
    const mySlot = state.you ? state.you.slot : null;
    const isMine = turn && turn.slot === mySlot;

    el.turnBar.classList.toggle('is-mine', Boolean(isMine));
    el.turnHeadline.textContent = isMine ? 'Your pick' : `${nameOfSlot(room, turn.slot)} is picking`;
    el.turnMeta.textContent =
        `Round ${turn.round} of ${room.config.teamSize} · ` +
        `Pick ${turn.pickNumber} of ${turn.totalPicks} · ` +
        (room.pool.length === 1 ? 'one option left' : `${room.pool.length} options left`);

    el.upNext.textContent = room.upcoming.length
        ? `Up next: ${room.upcoming.map((slot) => nameOfSlot(room, slot)).join(' → ')}`
        : 'Last pick of the draft.';

    tickClock();
    renderPool(room, Boolean(isMine));
    renderTeamsBoard(room);
    renderPickLog(room);
}

/**
 * The grid is rebuilt only when the underlying pool actually changes.
 * Filter and sort changes rebuild it too, but a bare countdown tick does not,
 * which is what keeps the card animations from restarting every 200ms.
 */
function renderPool(room, isMyTurn) {
    const signature = [room.pool.map((mon) => mon.id).join(','), ui.search, ui.type, ui.sort, isMyTurn].join('|');
    if (signature === lastPoolSignature) return;
    lastPoolSignature = signature;

    const search = ui.search.trim().toLowerCase();
    const visible = room.pool
        .filter((mon) => {
            if (ui.type && !mon.types.includes(ui.type)) return false;
            if (!search) return true;
            return (
                mon.name.toLowerCase().includes(search) ||
                mon.types.some((type) => type.toLowerCase().includes(search)) ||
                (mon.abilities || []).some((ability) => ability.name.toLowerCase().includes(search))
            );
        })
        .sort(comparators[ui.sort] || comparators['bst-desc']);

    el.poolCount.textContent = room.pool.length;
    // The pool is exact-fit by default, so it visibly tightens as the draft runs.
    el.poolCount.classList.toggle('is-scarce', room.pool.length <= room.players.length);
    el.poolEmpty.hidden = visible.length > 0;
    el.poolGrid.replaceChildren(
        ...visible.map((mon, index) => monCard(mon, isMyTurn, index)),
    );
}

const comparators = {
    'bst-desc': (a, b) => b.bst - a.bst || a.name.localeCompare(b.name),
    'bst-asc': (a, b) => a.bst - b.bst || a.name.localeCompare(b.name),
    'name-asc': (a, b) => a.name.localeCompare(b.name),
    'speed-desc': (a, b) => (b.baseStats.spe || 0) - (a.baseStats.spe || 0) || a.name.localeCompare(b.name),
    // Unplayed Pokemon have no usage figure; sort them last rather than first.
    'usage-desc': (a, b) => (b.usage ?? -1) - (a.usage ?? -1) || a.name.localeCompare(b.name),
};

function monCard(mon, enabled, index) {
    const card = el.monTemplate.content.firstElementChild.cloneNode(true);
    card.disabled = !enabled;
    card.classList.toggle('is-locked', !enabled);
    card.style.setProperty('--stagger', `${Math.min(index, 24) * 18}ms`);
    card.title = statLine(mon);

    paintSprite(card.querySelector('.mon-sprite'), mon);
    card.querySelector('.mon-name').textContent = mon.name;

    const types = card.querySelector('.mon-types');
    for (const type of mon.types) {
        const badge = document.createElement('span');
        badge.className = `type type-${type.toLowerCase()}`;
        badge.textContent = type;
        types.appendChild(badge);
    }

    card.querySelector('.mon-bst').textContent = `BST ${mon.bst}`;
    card.querySelector('.mon-spe').textContent = `SPE ${mon.baseStats.spe || 0}`;
    card.querySelector('.mon-usage').textContent = mon.usage == null ? '' : `${mon.usage}%`;

    if (enabled) {
        card.addEventListener('click', () => {
            card.disabled = true;
            send('pick', { pokemonId: mon.id });
        });
    }

    return card;
}

function renderTeamsBoard(room) {
    const teams = teamsFrom(room);
    const mySlot = state.you ? state.you.slot : null;
    const onClock = room.turn ? room.turn.slot : null;

    el.teamsBoard.replaceChildren(
        ...room.players.map((player) => {
            const card = document.createElement('div');
            card.className = 'team-card';
            card.classList.toggle('is-you', player.slot === mySlot);
            card.classList.toggle('is-turn', player.slot === onClock);

            const head = document.createElement('div');
            head.className = 'team-head';
            const label = document.createElement('span');
            label.textContent = player.slot === mySlot ? `${player.name} (you)` : player.name;
            head.appendChild(label);

            const count = document.createElement('span');
            count.className = 'count-pill';
            count.textContent = `${teams[player.slot].length}/${room.config.teamSize}`;
            head.appendChild(count);
            card.appendChild(head);

            const mons = document.createElement('div');
            mons.className = 'team-mons';
            for (let i = 0; i < room.config.teamSize; i++) {
                mons.appendChild(teamSlot(teams[player.slot][i]));
            }
            card.appendChild(mons);

            return card;
        }),
    );
}

function teamSlot(mon) {
    const slot = document.createElement('span');
    slot.className = 'team-slot';
    if (!mon) return slot;

    slot.classList.add('filled');
    slot.title = statLine(mon);
    paintSprite(slot, mon);
    return slot;
}

function renderPickLog(room) {
    if (room.picks.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'pick-empty';
        empty.textContent = 'No picks yet.';
        el.pickLog.replaceChildren(empty);
        return;
    }

    el.pickLog.replaceChildren(
        ...room.picks.slice().reverse().map((pick) => {
            const item = document.createElement('li');

            const no = document.createElement('span');
            no.className = 'pick-no';
            no.textContent = `#${pick.pickNumber}`;
            item.appendChild(no);

            const text = document.createElement('span');
            text.className = 'pick-text';
            text.innerHTML = `<b>${escapeHtml(nameOfSlot(room, pick.slot))}</b> → ${escapeHtml(pick.pokemon.name)}`;
            if (pick.auto) {
                const auto = document.createElement('span');
                auto.className = 'pick-auto';
                auto.textContent = ' (timed out)';
                text.appendChild(auto);
            }
            item.appendChild(text);

            return item;
        }),
    );
}

// ------------------------------------------------------------------ clock

function tickClock() {
    if (!state || state.room.phase !== 'drafting' || !state.room.turn) return;

    const { endsAt } = state.room.turn;
    const total = state.room.config.pickSeconds * 1000;
    const remaining = Math.max(0, endsAt - (Date.now() + clockOffset));
    const seconds = Math.ceil(remaining / 1000);

    el.turnSeconds.textContent = `${seconds}s`;
    el.turnFill.style.width = `${Math.max(0, Math.min(100, (remaining / total) * 100))}%`;
    el.turnBar.classList.toggle('is-urgent', seconds <= 10);
}

setInterval(tickClock, 250);

// ---------------------------------------------------------------- results

function renderResults(room) {
    const teams = teamsFrom(room);
    const mySlot = state.you ? state.you.slot : null;

    el.resultsSummary.textContent =
        `${plural(room.players.length, 'trainer')} · ${mons(room.config.teamSize)} each · room ${room.code}`;

    el.resultTeams.replaceChildren(
        ...room.players.map((player) => {
            const team = teams[player.slot];

            const card = document.createElement('div');
            card.className = 'result-card';
            card.classList.toggle('is-you', player.slot === mySlot);

            const head = document.createElement('div');
            head.className = 'result-head';
            const title = document.createElement('h2');
            title.textContent = player.name;
            head.appendChild(title);
            if (player.slot === mySlot) head.appendChild(tag('You', 'tag-you'));
            card.appendChild(head);

            const bst = document.createElement('p');
            bst.className = 'result-bst';
            bst.textContent = `Total BST ${totalBst(team)} · average ${Math.round(totalBst(team) / (team.length || 1))}`;
            card.appendChild(bst);

            const list = document.createElement('div');
            list.className = 'result-mons';
            for (const mon of team) list.appendChild(resultRow(mon));
            card.appendChild(list);

            const copy = document.createElement('button');
            copy.className = 'btn btn-ghost';
            copy.type = 'button';
            copy.textContent = 'Copy for Showdown';
            copy.addEventListener('click', () => copyTeam(team, copy));
            card.appendChild(copy);

            return card;
        }),
    );
}

function resultRow(mon) {
    const row = document.createElement('div');
    row.className = 'result-mon';

    row.appendChild(newSprite(mon));
    row.title = statLine(mon);

    const body = document.createElement('span');
    body.className = 'mon-body';

    const name = document.createElement('span');
    name.className = 'mon-name';
    name.textContent = mon.name;
    body.appendChild(name);

    const types = document.createElement('span');
    types.className = 'mon-types';
    for (const type of mon.types) {
        const badge = document.createElement('span');
        badge.className = `type type-${type.toLowerCase()}`;
        badge.textContent = type;
        types.appendChild(badge);
    }
    body.appendChild(types);

    const stats = document.createElement('span');
    stats.className = 'mon-stats';
    stats.textContent = mon.usage == null ? `BST ${mon.bst}` : `BST ${mon.bst} · ${mon.usage}% usage`;
    body.appendChild(stats);

    row.appendChild(body);
    return row;
}

async function copyTeam(team, button) {
    // Showdown's importer accepts a bare species name per block.
    const text = team.map((mon) => mon.name).join('\n\n');
    const original = button.textContent;
    try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
    } catch {
        showToast('Clipboard blocked by the browser.', 'error');
        return;
    }
    setTimeout(() => {
        button.textContent = original;
    }, 1600);
}

async function copyInvite() {
    if (!state) return;
    const url = `${location.origin}${location.pathname}#${state.room.code}`;
    try {
        await navigator.clipboard.writeText(url);
        showToast('Invite link copied', 'good');
    } catch {
        showToast(`Share this code: <b>${escapeHtml(state.room.code)}</b>`, 'info');
    }
}

// ------------------------------------------------------------------ inputs

function readConfig() {
    return {
        numPlayers: Number(el.numPlayers.value),
        teamSize: Number(el.teamSize.value),
        extraPerPlayer: Number(el.extraPerPlayer.value),
        pickSeconds: Number(el.pickSeconds.value),
    };
}

function updatePoolPreview() {
    const { numPlayers, teamSize, extraPerPlayer, pickSeconds } = readConfig();
    if ([numPlayers, teamSize, extraPerPlayer].some((value) => !Number.isFinite(value))) return;

    const totalPicks = numPlayers * teamSize;
    const poolSize = numPlayers * (teamSize + extraPerPlayer);
    const lastPickChoices = poolSize - totalPicks + 1;

    el.poolPreview.textContent =
        `${plural(totalPicks, 'pick')} across ${plural(teamSize, 'round')}, ` +
        `${poolSize} Pokémon in the pool, ${pickSeconds}s on the clock. ` +
        (lastPickChoices === 1
            ? 'The pool runs dry exactly as the draft ends — the last trainer takes whatever is left.'
            : `The final pick will still have ${plural(lastPickChoices, 'option')}.`);
}

el.createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = el.createName.value.trim();
    rememberName(name);
    send('createRoom', { name, config: readConfig() });
});

el.joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = el.joinCode.value.trim().toUpperCase();
    if (code.length !== 4) {
        showToast('Room codes are four letters.', 'error');
        return;
    }
    const name = el.joinName.value.trim();
    rememberName(name);
    send('joinRoom', { name, code });
});

for (const input of [el.numPlayers, el.teamSize, el.extraPerPlayer, el.pickSeconds]) {
    input.addEventListener('input', updatePoolPreview);
}

el.joinCode.addEventListener('input', () => {
    el.joinCode.value = el.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

el.startBtn.addEventListener('click', () => send('startDraft', {}));
el.leaveBtn.addEventListener('click', () => send('leaveRoom', {}));
el.shareBtn.addEventListener('click', copyInvite);
el.roomChip.addEventListener('click', copyInvite);

el.newDraftBtn.addEventListener('click', () => send('leaveRoom', {}));

el.poolSearch.addEventListener('input', () => {
    ui.search = el.poolSearch.value;
    if (state && state.room.phase === 'drafting') renderDraft(state.room);
});
el.poolType.addEventListener('change', () => {
    ui.type = el.poolType.value;
    if (state && state.room.phase === 'drafting') renderDraft(state.room);
});
el.poolSort.addEventListener('change', () => {
    ui.sort = el.poolSort.value;
    if (state && state.room.phase === 'drafting') renderDraft(state.room);
});

// ------------------------------------------------------------------- boot

function boot() {
    for (const type of TYPES) {
        const option = document.createElement('option');
        option.value = type;
        option.textContent = type;
        el.poolType.appendChild(option);
    }

    const savedName = recallName();
    el.createName.value = savedName;
    el.joinName.value = savedName;

    const hashCode = location.hash.slice(1).toUpperCase();
    if (/^[A-Z0-9]{4}$/.test(hashCode)) el.joinCode.value = hashCode;

    showHome();
    connect();
}

boot();
