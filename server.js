const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

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

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        
        switch(data.type) {
            case 'create':
                createRoom(ws, data.numPlayers);
                break;
            case 'join':
                joinRoom(ws, data.roomCode);
                break;
            case 'choose':
                choosePokemon(ws, data.roomCode, data.pokemon);
                break;
        }
    });

    ws.on('close', () => {
        // Handle disconnection
        for (let [roomCode, room] of rooms.entries()) {
            const index = room.players.indexOf(ws);
            if (index !== -1) {
                room.players.splice(index, 1);
                if (room.players.length === 0) {
                    rooms.delete(roomCode);
                } else {
                    broadcastGameState(roomCode);
                }
                break;
            }
        }
    });
});

function createRoom(ws, numPlayers) {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    rooms.set(roomCode, {
        players: [ws],
        numPlayers: numPlayers,
        availablePokemon: [],
        teams: [[]],
        currentPlayer: 0,
        currentRound: 1
    });
    ws.send(JSON.stringify({ type: 'roomCreated', roomCode: roomCode, playerIndex: 0 }));
}

function joinRoom(ws, roomCode) {
    const room = rooms.get(roomCode);
    if (room && room.players.length < room.numPlayers) {
        const playerIndex = room.players.length;
        room.players.push(ws);
        room.teams.push([]);
        ws.send(JSON.stringify({ type: 'joined', roomCode: roomCode, playerIndex: playerIndex }));
        if (room.players.length === room.numPlayers) {
            startGame(roomCode);
        }
    } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid room code or room is full' }));
    }
}

function startGame(roomCode) {
    const room = rooms.get(roomCode);
    room.availablePokemon = generateRandomPool(room.numPlayers * 4);
    broadcastGameState(roomCode);
}

function choosePokemon(ws, roomCode, pokemon) {
    const room = rooms.get(roomCode);
    const playerIndex = room.players.indexOf(ws);
    if (room && playerIndex === room.currentPlayer) {
        broadcastReveal(roomCode, playerIndex, pokemon);
        
        setTimeout(() => {
            room.teams[playerIndex].push(pokemon);
            room.availablePokemon = room.availablePokemon.filter(p => p.name !== pokemon.name);
            nextTurn(room);
            broadcastGameState(roomCode);
        }, 3000);
    } else {
        ws.send(JSON.stringify({ type: 'error', message: 'It\'s not your turn' }));
    }
}

function broadcastReveal(roomCode, playerIndex, pokemon) {
    const room = rooms.get(roomCode);
    const revealMessage = {
        type: 'reveal',
        playerIndex: playerIndex,
        pokemon: pokemon
    };
    room.players.forEach(player => {
        player.send(JSON.stringify(revealMessage));
    });
}

function nextTurn(room) {
    room.currentPlayer = (room.currentPlayer + 1) % room.numPlayers;
    if (room.currentPlayer === 0) {
        room.currentRound++;
    }
    if (room.currentRound > 4) {
        endGame(room);
    }
}

function broadcastGameState(roomCode) {
    const room = rooms.get(roomCode);
    room.players.forEach((player, index) => {
        const gameState = {
            type: 'gameState',
            availablePokemon: room.availablePokemon,
            teams: room.teams,
            currentPlayer: room.currentPlayer,
            currentRound: room.currentRound,
            playerIndex: index
        };
        player.send(JSON.stringify(gameState));
    });
}

function endGame(room) {
    const gameState = {
        type: 'gameOver',
        teams: room.teams
    };
    room.players.forEach(player => {
        player.send(JSON.stringify(gameState));
    });
}

function generateRandomPool(poolSize) {
    const pokemonList = Object.values(pokedex).filter(pokemon => 
        !pokemon.forme && !pokemon.isNonstandard && pokemon.tier !== 'Illegal'
    );
    
    const shuffled = pokemonList.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, poolSize).map(pokemon => ({
        name: pokemon.name,
        types: pokemon.types,
        baseStats: pokemon.baseStats
    }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
