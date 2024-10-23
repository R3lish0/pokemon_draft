console.log('Starting server...');

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store active rooms
const rooms = new Map();

// Load the Pokédex data
let pokedex;
try {
    const pokedexData = fs.readFileSync('pokedex.json', 'utf8');
    pokedex = JSON.parse(pokedexData);
} catch (error) {
    console.error('Error loading Pokédex data:', error);
    process.exit(1);
}

// Load Pokemon data
let pokemonData;
try {
    const rawData = fs.readFileSync(path.join('pokedex.json'), 'utf8');
    pokemonData = JSON.parse(rawData);
    console.log('Pokemon data loaded successfully');
} catch (error) {
    console.error('Error loading Pokemon data:', error);
    pokemonData = [];
}

wss.on('connection', (ws) => {
    console.log('New WebSocket connection');

    ws.on('message', (message) => {
        console.log('Received message:', message.toString());
        try {
            const data = JSON.parse(message);
            console.log('Parsed data:', data);
            
            switch(data.type) {
                case 'create':
                    createRoom(ws, data.numPlayers);
                    break;
                case 'join':
                    joinRoom(ws, data.roomCode);
                    break;
                case 'selectSlot':
                    selectSlot(ws, data.slotIndex, data.roomCode);
                    break;
                case 'startGame':
                    console.log('Received start game request');
                    startGame(ws, data.roomCode);
                    break;
                case 'choose':
                    choosePokemon(ws, data.roomCode, data.pokemon);
                    break;
                default:
                    console.warn('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    ws.on('close', () => {
        console.log('WebSocket connection closed');
        if (ws.roomCode) {
            const room = rooms.get(ws.roomCode);
            if (room) {
                const playerIndex = room.players.indexOf(ws);
                if (playerIndex !== -1) {
                    room.players[playerIndex] = null;
                    broadcastWaitingRoom(ws.roomCode);
                }
            }
        }
    });
});

function createRoom(ws, numPlayers) {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    console.log(`Creating room with code: ${roomCode} for ${numPlayers} players`);
    rooms.set(roomCode, {
        players: new Array(numPlayers).fill(null),
        numPlayers: numPlayers,
        availablePokemon: [],
        teams: [],
        currentPlayer: 0,
        currentRound: 1,
        gameStarted: false,
        isForward: true  // Add direction tracking
    });
    joinRoom(ws, roomCode);
}

function joinRoom(ws, roomCode) {
    console.log(`Player attempting to join room: ${roomCode}`);
    const room = rooms.get(roomCode);
    if (room && !room.gameStarted) {
        const emptySlot = room.players.findIndex(player => player === null);
        if (emptySlot !== -1) {
            room.players[emptySlot] = ws;
            ws.roomCode = roomCode;
            ws.playerIndex = emptySlot;
            console.log(`Player joined room ${roomCode} in slot ${emptySlot}`);
            broadcastWaitingRoom(roomCode);
        } else {
            console.log(`Room ${roomCode} is full`);
            ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
        }
    } else {
        console.log(`Invalid room code or game already started: ${roomCode}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid room code or game already started' }));
    }
}

function selectSlot(ws, slotIndex, roomCode) {
    console.log(`Player selecting slot ${slotIndex} in room ${roomCode}`);
    const room = rooms.get(roomCode);
    if (room && !room.gameStarted) {
        // ... (rest of the function remains the same)
    }
}

function startGame(ws, roomCode) {
    console.log(`Attempting to start game for room: ${roomCode}`);
    const room = rooms.get(roomCode);
    if (!room) {
        console.log(`Room ${roomCode} not found`);
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
    }

    if (room.gameStarted) {
        console.log(`Game already started in room ${roomCode}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Game already started' }));
        return;
    }

    const filledSlots = room.players.filter(player => player !== null).length;
    console.log(`Filled slots: ${filledSlots}, Total slots: ${room.numPlayers}`);

    if (filledSlots === room.numPlayers) {
        room.gameStarted = true;
        room.availablePokemon = generateRandomPool(room.numPlayers * 4);
        console.log(`Generated ${room.availablePokemon.length} Pokemon for the pool`);
        room.teams = Array(room.numPlayers).fill().map(() => []);
        room.currentPlayer = 0;
        room.currentRound = 1;
        console.log(`Game started in room ${roomCode}. Current player: ${room.currentPlayer}`);
        broadcastGameState(roomCode);
    } else {
        console.log(`Not all slots filled in room ${roomCode}. Filled: ${filledSlots}/${room.numPlayers}`);
        ws.send(JSON.stringify({ type: 'error', message: `Cannot start game. Only ${filledSlots}/${room.numPlayers} slots are filled.` }));
    }
}

function broadcastWaitingRoom(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) {
        console.error(`Room ${roomCode} not found when broadcasting waiting room`);
        return;
    }
    
    const waitingState = {
        type: 'waitingRoom',
        roomCode: roomCode,
        players: room.players.map(p => p !== null),
        numPlayers: room.numPlayers
    };
    
    room.players.forEach((player, index) => {
        if (player) {
            player.send(JSON.stringify({
                ...waitingState,
                yourIndex: index
            }));
        }
    });
}

function broadcastGameState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) {
        console.error(`Room ${roomCode} not found when broadcasting game state`);
        return;
    }
    
    console.log(`Broadcasting game state for room ${roomCode}`);
    room.players.forEach((player, index) => {
        if (player) {
            player.send(JSON.stringify({
                type: 'gameState',
                roomCode: roomCode,
                availablePokemon: room.availablePokemon,
                teams: room.teams,
                currentPlayer: room.currentPlayer,
                currentRound: room.currentRound,
                playerIndex: index
            }));
        }
    });
}

function generateRandomPool(size) {
    console.log('Generating random pool of size:', size);
    console.log('Pokemon data type:', typeof pokemonData);
    console.log('Pokemon data structure:', JSON.stringify(pokemonData).slice(0, 100) + '...');

    let pool;
    if (Array.isArray(pokemonData)) {
        pool = pokemonData;
    } else if (typeof pokemonData === 'object') {
        pool = Object.values(pokemonData);
    } else {
        console.error('Invalid Pokemon data structure');
        return [];
    }

    if (pool.length === 0) {
        console.error('No Pokemon data available');
        return [];
    }

    const shuffled = pool.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, size);
}

function choosePokemon(ws, roomCode, pokemon) {
    console.log(`Player in room ${roomCode} is choosing Pokemon:`, pokemon.name);
    const room = rooms.get(roomCode);
    if (!room || !room.gameStarted) {
        console.log(`Invalid room or game not started: ${roomCode}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid room or game not started' }));
        return;
    }

    const playerIndex = room.players.indexOf(ws);
    if (playerIndex !== room.currentPlayer) {
        console.log(`Not this player's turn. Current player: ${room.currentPlayer}, Attempting player: ${playerIndex}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Not your turn' }));
        return;
    }

    const pokemonIndex = room.availablePokemon.findIndex(p => p.name === pokemon.name);
    if (pokemonIndex === -1) {
        console.log(`Pokemon ${pokemon.name} not found in available pool`);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid Pokemon selection' }));
        return;
    }

    // Remove Pokemon and add to team
    const chosenPokemon = room.availablePokemon.splice(pokemonIndex, 1)[0];
    room.teams[playerIndex].push(chosenPokemon);

    // Broadcast reveal
    room.players.forEach(player => {
        if (player) {
            player.send(JSON.stringify({
                type: 'reveal',
                playerIndex: playerIndex,
                pokemon: chosenPokemon
            }));
        }
    });

    // Update next player based on direction
    if (room.isForward) {
        room.currentPlayer++;
        if (room.currentPlayer >= room.numPlayers) {
            room.currentPlayer = room.numPlayers - 1;
            room.isForward = false;
            room.currentRound++;
        }
    } else {
        room.currentPlayer--;
        if (room.currentPlayer < 0) {
            room.currentPlayer = 0;
            room.isForward = true;
            room.currentRound++;
        }
    }

    console.log(`Updated game state: Player ${room.currentPlayer}, Round ${room.currentRound}, Direction ${room.isForward ? 'forward' : 'backward'}`);

    // Check if game is over
    if (room.currentRound > 4) {
        console.log(`Game over in room ${roomCode}`);
        room.players.forEach(player => {
            if (player) {
                player.send(JSON.stringify({
                    type: 'gameOver',
                    teams: room.teams
                }));
            }
        });
        rooms.delete(roomCode);
    } else {
        broadcastGameState(roomCode);
    }
}

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
