'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const pokedex = require('./src/pokedex');
const rooms = require('./src/rooms');

const PORT = Number(process.env.PORT) || 3000;
const HEARTBEAT_MS = 30 * 1000;
const MAX_PAYLOAD_BYTES = 16 * 1024;

const loaded = pokedex.load();
console.log(`Loaded ${loaded.count} Pokemon from ${loaded.source}`);

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (_req, res) => res.json({ ok: true, ...rooms.stats() }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD_BYTES });

// --------------------------------------------------------------- transport

function send(socket, payload) {
    if (!socket || socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(payload));
}

function sendError(socket, code, message) {
    send(socket, { type: 'error', code, message });
}

function sendWelcome(socket, player, resumed) {
    send(socket, {
        type: 'welcome',
        playerId: player ? player.id : null,
        name: player ? player.name : null,
        resumed,
        limits: rooms.LIMITS,
        dexSize: pokedex.size(),
    });
}

/**
 * The one place a room's truth leaves the process: every connected player
 * gets the same authoritative snapshot, then any ephemeral events that
 * accumulated during the mutation. Events never carry state of their own,
 * so a client that ignores them entirely still renders correctly.
 */
function publish(room) {
    const events = room.events.splice(0);

    for (const player of room.players) {
        send(player.socket, rooms.stateFor(room, player));
    }
    for (const event of events) {
        const message = { type: 'event', ...event };
        for (const player of room.players) send(player.socket, message);
    }
}

rooms.configure({ publish });
rooms.startSweeper();

// ---------------------------------------------------------------- handlers

/** Every handler receives the socket's bound session, so no message carries a roomCode. */
const handlers = {
    hello(socket, data) {
        const resumed = data.playerId ? rooms.findPlayer(String(data.playerId)) : null;

        if (resumed) {
            socket.session = resumed;
            sendWelcome(socket, resumed.player, true);
            rooms.attachSocket(resumed.player, resumed.room, socket);
        } else {
            sendWelcome(socket, null, false);
        }
    },

    createRoom(socket, data) {
        requireNoSession(socket);
        const room = rooms.createRoom(data.config);
        const player = rooms.addPlayer(room, data.name);
        socket.session = { room, player };
        sendWelcome(socket, player, false);
        rooms.attachSocket(player, room, socket);
    },

    joinRoom(socket, data) {
        requireNoSession(socket);
        const room = rooms.getRoom(data.code);
        const player = rooms.addPlayer(room, data.name);
        socket.session = { room, player };
        sendWelcome(socket, player, false);
        rooms.attachSocket(player, room, socket);
    },

    setName(socket, data) {
        const { room, player } = requireSession(socket);
        rooms.setName(player, room, data.name);
    },

    startDraft(socket) {
        const { room, player } = requireSession(socket);
        rooms.startDraft(player, room);
    },

    pick(socket, data) {
        const { room, player } = requireSession(socket);
        rooms.pick(player, room, String(data.pokemonId || ''));
    },

    leaveRoom(socket) {
        const { room, player } = requireSession(socket);
        socket.session = null;
        rooms.leaveRoom(player, room);
        send(socket, { type: 'left' });
    },
};

function requireSession(socket) {
    if (!socket.session) {
        throw new rooms.DraftError('no_session', 'You are not in a draft room.');
    }
    return socket.session;
}

function requireNoSession(socket) {
    if (socket.session) {
        throw new rooms.DraftError('already_in_room', 'Leave your current room first.');
    }
}

// ------------------------------------------------------------- connections

wss.on('connection', (socket) => {
    socket.session = null;
    socket.isAlive = true;
    socket.on('pong', () => {
        socket.isAlive = true;
    });

    socket.on('message', (raw) => {
        let data;
        try {
            data = JSON.parse(raw.toString());
        } catch {
            sendError(socket, 'bad_json', 'That message could not be read.');
            return;
        }

        const handler = data && typeof data.type === 'string' ? handlers[data.type] : null;
        if (!handler) {
            sendError(socket, 'unknown_type', `Unsupported message type: ${data && data.type}`);
            return;
        }

        try {
            handler(socket, data);
        } catch (error) {
            if (error instanceof rooms.DraftError) {
                sendError(socket, error.code, error.message);
            } else {
                console.error(`Handler "${data.type}" failed:`, error);
                sendError(socket, 'internal', 'Something went wrong on the server.');
            }
        }
    });

    socket.on('close', () => {
        const session = socket.session;
        socket.session = null;
        if (session && session.player.socket === socket) {
            rooms.detachSocket(session.player, session.room);
        }
    });

    socket.on('error', (error) => console.error('Socket error:', error.message));
});

// Drops half-open connections so a killed tab does not hold a lobby seat forever.
const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
        if (socket.isAlive === false) {
            socket.terminate();
            continue;
        }
        socket.isAlive = false;
        socket.ping();
    }
}, HEARTBEAT_MS);
heartbeat.unref();

server.listen(PORT, () => {
    console.log(`Pokemon Draft running at http://localhost:${PORT}`);
});

function shutdown(signal) {
    console.log(`\n${signal} received, shutting down.`);
    clearInterval(heartbeat);
    for (const socket of wss.clients) socket.close(1001, 'Server shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
