'use strict';

const crypto = require('crypto');
const pokedex = require('./pokedex');

// Ambiguous glyphs (0/O, 1/I/L) are left out so codes survive being read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

const LIMITS = {
    numPlayers: { min: 2, max: 8, default: 4 },
    teamSize: { min: 1, max: 6, default: 6 },
    // 0 means the pool is exactly as large as the number of picks, so choices
    // narrow every round and the final pick is whatever nobody else wanted.
    extraPerPlayer: { min: 0, max: 6, default: 0 },
    pickSeconds: { min: 15, max: 300, default: 60 },
    nameMaxLength: 20,
};

const LOBBY_GRACE_MS = 45 * 1000;        // how long a refresh can take before the seat is freed
const ABANDONED_ROOM_TTL_MS = 10 * 60 * 1000;
const FINISHED_ROOM_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

class DraftError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'DraftError';
        this.code = code;
    }
}

/** @type {Map<string, object>} */
const rooms = new Map();
/** @type {Map<string, string>} playerId -> room code */
const playerRooms = new Map();

// Injected by the socket layer so this module never touches a WebSocket.
let publish = () => {};

function configure(handlers) {
    publish = handlers.publish;
}

// ---------------------------------------------------------------- helpers

function clampInt(value, spec) {
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed)) return spec.default;
    return Math.min(spec.max, Math.max(spec.min, parsed));
}

function cleanName(value, fallback) {
    const name = String(value == null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, LIMITS.nameMaxLength);
    return name || fallback;
}

function createCode() {
    for (let attempt = 0; attempt < 200; attempt++) {
        let code = '';
        for (let i = 0; i < CODE_LENGTH; i++) {
            code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
        }
        if (!rooms.has(code)) return code;
    }
    throw new DraftError('no_capacity', 'The server is out of room codes right now.');
}

function getRoom(code) {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) throw new DraftError('no_such_room', 'No draft with that code. Check the letters and try again.');
    return room;
}

function hostOf(room) {
    return room.players.find((player) => player.connected) || room.players[0] || null;
}

function emit(room, event) {
    room.events.push(event);
}

// ---------------------------------------------------------------- lifecycle

function createRoom(rawConfig) {
    const config = rawConfig || {};
    const room = {
        code: createCode(),
        createdAt: Date.now(),
        phase: 'lobby',
        config: {
            numPlayers: clampInt(config.numPlayers, LIMITS.numPlayers),
            teamSize: clampInt(config.teamSize, LIMITS.teamSize),
            extraPerPlayer: clampInt(config.extraPerPlayer, LIMITS.extraPerPlayer),
            pickSeconds: clampInt(config.pickSeconds, LIMITS.pickSeconds),
        },
        players: [],
        pool: [],
        order: [],
        pickIndex: 0,
        picks: [],
        turnEndsAt: null,
        turnTimer: null,
        finishedAt: null,
        events: [],
    };
    rooms.set(room.code, room);
    return room;
}

function addPlayer(room, name) {
    if (room.phase !== 'lobby') {
        throw new DraftError('already_started', 'That draft has already started.');
    }
    if (room.players.length >= room.config.numPlayers) {
        throw new DraftError('room_full', 'That room is already full.');
    }

    const player = {
        id: crypto.randomUUID(),
        slot: room.players.length,
        name: cleanName(name, `Trainer ${room.players.length + 1}`),
        connected: false,
        socket: null,
        lastSeen: Date.now(),
    };
    room.players.push(player);
    playerRooms.set(player.id, room.code);
    emit(room, { event: 'playerJoined', slot: player.slot, name: player.name });
    return player;
}

function findPlayer(playerId) {
    const code = playerRooms.get(playerId);
    if (!code) return null;
    const room = rooms.get(code);
    if (!room) {
        playerRooms.delete(playerId);
        return null;
    }
    const player = room.players.find((candidate) => candidate.id === playerId);
    return player ? { room, player } : null;
}

function attachSocket(player, room, socket) {
    if (player.socket && player.socket !== socket) {
        // A second tab took over this identity; retire the older socket.
        try {
            player.socket.close(4000, 'Session resumed in another tab');
        } catch {
            /* already gone */
        }
    }
    player.socket = socket;
    player.connected = true;
    player.lastSeen = Date.now();
    publish(room);
}

function detachSocket(player, room) {
    player.socket = null;
    player.connected = false;
    player.lastSeen = Date.now();
    emit(room, { event: 'playerDisconnected', slot: player.slot, name: player.name });
    publish(room);
}

function leaveRoom(player, room) {
    if (room.phase === 'lobby') {
        removeFromLobby(player, room);
    } else {
        player.connected = false;
        player.socket = null;
        player.lastSeen = Date.now();
    }
    publish(room);
}

function removeFromLobby(player, room) {
    const index = room.players.indexOf(player);
    if (index === -1) return;
    room.players.splice(index, 1);
    playerRooms.delete(player.id);
    room.players.forEach((remaining, slot) => {
        remaining.slot = slot;
    });
    emit(room, { event: 'playerLeft', slot: index, name: player.name });
}

function setName(player, room, name) {
    const previous = player.name;
    player.name = cleanName(name, previous);
    if (player.name !== previous) {
        emit(room, { event: 'renamed', slot: player.slot, name: player.name, previous });
    }
    publish(room);
}

// ---------------------------------------------------------------- the draft

/** Snake order, precomputed once: no per-pick direction arithmetic to get wrong. */
function buildSnakeOrder(numPlayers, teamSize) {
    const order = [];
    for (let round = 0; round < teamSize; round++) {
        const slots = Array.from({ length: numPlayers }, (_, slot) => slot);
        if (round % 2 === 1) slots.reverse();
        order.push(...slots);
    }
    return order;
}

function startDraft(player, room) {
    if (room.phase !== 'lobby') {
        throw new DraftError('already_started', 'The draft has already started.');
    }
    if (hostOf(room) !== player) {
        throw new DraftError('not_host', 'Only the host can start the draft.');
    }

    const seated = room.players.filter((candidate) => candidate.connected);
    if (seated.length < LIMITS.numPlayers.min) {
        throw new DraftError(
            'not_enough_players',
            `You need at least ${LIMITS.numPlayers.min} connected players to start.`,
        );
    }

    // Drop anyone who never came back, then close the gaps so slots stay dense.
    for (const dropped of room.players) {
        if (!seated.includes(dropped)) playerRooms.delete(dropped.id);
    }
    room.players = seated;
    room.players.forEach((seatedPlayer, slot) => {
        seatedPlayer.slot = slot;
    });

    const { teamSize, extraPerPlayer } = room.config;
    const numPlayers = room.players.length;
    room.config.numPlayers = numPlayers;

    const poolSize = Math.min(numPlayers * (teamSize + extraPerPlayer), pokedex.size());
    room.pool = pokedex.drawPool(poolSize);
    room.order = buildSnakeOrder(numPlayers, teamSize);
    room.pickIndex = 0;
    room.picks = [];
    room.phase = 'drafting';

    emit(room, { event: 'draftStarted', poolSize: room.pool.length, totalPicks: room.order.length });
    beginTurn(room);
    publish(room);
}

function clearTurnTimer(room) {
    if (room.turnTimer) {
        clearTimeout(room.turnTimer);
        room.turnTimer = null;
    }
}

function beginTurn(room) {
    clearTurnTimer(room);

    if (room.pickIndex >= room.order.length || room.pool.length === 0) {
        finishDraft(room);
        return;
    }

    const durationMs = room.config.pickSeconds * 1000;
    room.turnEndsAt = Date.now() + durationMs;
    room.turnTimer = setTimeout(() => autoPick(room), durationMs);
    if (typeof room.turnTimer.unref === 'function') room.turnTimer.unref();
}

/**
 * The clock is what keeps a disconnected player from deadlocking the room.
 * Highest remaining BST is picked so the choice is predictable and explainable.
 */
function autoPick(room) {
    room.turnTimer = null;
    if (room.phase !== 'drafting' || room.pool.length === 0) return;

    const best = room.pool.reduce((leader, candidate) => (candidate.bst > leader.bst ? candidate : leader));
    commitPick(room, room.order[room.pickIndex], best, true);
    publish(room);
}

function pick(player, room, pokemonId) {
    if (room.phase !== 'drafting') {
        throw new DraftError('not_drafting', 'The draft is not running right now.');
    }
    if (room.order[room.pickIndex] !== player.slot) {
        const onClock = room.players[room.order[room.pickIndex]];
        throw new DraftError('not_your_turn', `It's ${onClock ? onClock.name : 'someone else'}'s pick.`);
    }

    const chosen = room.pool.find((candidate) => candidate.id === pokemonId);
    if (!chosen) {
        throw new DraftError('unavailable', 'That Pokemon is no longer in the pool.');
    }

    commitPick(room, player.slot, chosen, false);
    publish(room);
}

function commitPick(room, slot, pokemon, auto) {
    room.pool = room.pool.filter((candidate) => candidate.id !== pokemon.id);

    const record = {
        slot,
        pokemon,
        auto,
        pickNumber: room.pickIndex + 1,
        round: Math.floor(room.pickIndex / room.config.numPlayers) + 1,
        at: Date.now(),
    };
    room.picks.push(record);
    room.pickIndex += 1;

    emit(room, {
        event: 'pick',
        slot,
        auto,
        pickNumber: record.pickNumber,
        round: record.round,
        pokemon: {
            id: pokemon.id,
            name: pokemon.name,
            types: pokemon.types,
            bst: pokemon.bst,
            sprite: pokemon.sprite,
        },
        playerName: room.players[slot] ? room.players[slot].name : `Player ${slot + 1}`,
    });

    beginTurn(room);
}

function finishDraft(room) {
    clearTurnTimer(room);
    room.phase = 'complete';
    room.turnEndsAt = null;
    room.finishedAt = Date.now();
    emit(room, { event: 'draftComplete' });
}

// ---------------------------------------------------------------- serialize

/**
 * The single authoritative snapshot. Teams are intentionally *not* sent:
 * they are derived from `picks` on the client, so there is exactly one
 * representation of who owns what.
 */
function stateFor(room, player) {
    const host = hostOf(room);
    const onClock = room.phase === 'drafting' ? room.order[room.pickIndex] : null;

    return {
        type: 'state',
        serverTime: Date.now(),
        you: player
            ? { slot: player.slot, name: player.name, isHost: host === player }
            : null,
        room: {
            code: room.code,
            phase: room.phase,
            config: room.config,
            players: room.players.map((entry) => ({
                slot: entry.slot,
                name: entry.name,
                connected: entry.connected,
                isHost: entry === host,
            })),
            pool: room.pool,
            picks: room.picks,
            turn:
                onClock === null
                    ? null
                    : {
                          slot: onClock,
                          round: Math.floor(room.pickIndex / room.config.numPlayers) + 1,
                          pickNumber: room.pickIndex + 1,
                          totalPicks: room.order.length,
                          endsAt: room.turnEndsAt,
                      },
            upcoming: room.order.slice(room.pickIndex + 1, room.pickIndex + 6),
        },
    };
}

// ---------------------------------------------------------------- sweeper

function sweep() {
    const now = Date.now();

    for (const room of rooms.values()) {
        let changed = false;

        // Free seats held by people who never reconnected, but only in the lobby:
        // once a draft is running a slot belongs to its team for good.
        if (room.phase === 'lobby') {
            for (const player of room.players.slice()) {
                if (!player.connected && now - player.lastSeen > LOBBY_GRACE_MS) {
                    removeFromLobby(player, room);
                    changed = true;
                }
            }
        }

        const anyoneHere = room.players.some((player) => player.connected);
        const idleSince = room.players.reduce((latest, player) => Math.max(latest, player.lastSeen), room.createdAt);

        const expired =
            (!anyoneHere && now - idleSince > ABANDONED_ROOM_TTL_MS) ||
            (room.phase === 'complete' && now - room.finishedAt > FINISHED_ROOM_TTL_MS) ||
            (room.phase === 'lobby' && room.players.length === 0 && now - room.createdAt > LOBBY_GRACE_MS);

        if (expired) {
            clearTurnTimer(room);
            for (const player of room.players) playerRooms.delete(player.id);
            rooms.delete(room.code);
            continue;
        }

        if (changed) publish(room);
    }
}

function startSweeper() {
    const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
}

function stats() {
    return {
        rooms: rooms.size,
        players: playerRooms.size,
        drafting: [...rooms.values()].filter((room) => room.phase === 'drafting').length,
    };
}

module.exports = {
    DraftError,
    LIMITS,
    configure,
    createRoom,
    addPlayer,
    findPlayer,
    getRoom,
    attachSocket,
    detachSocket,
    leaveRoom,
    setName,
    startDraft,
    pick,
    stateFor,
    startSweeper,
    stats,
};
