let ws;
let playerIndex;
let currentRoomCode;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('createRoomBtn').addEventListener('click', createRoom);
    document.getElementById('joinRoomBtn').addEventListener('click', joinRoom);
    connectWebSocket();
});

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    ws = new WebSocket(`${protocol}//${host}`);
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Received message:', data); // Debug log
        switch(data.type) {
            case 'roomCreated':
                playerIndex = data.playerIndex;
                showWaitingRoom(data.roomCode);
                break;
            case 'joined':
                playerIndex = data.playerIndex;
                showWaitingRoom(data.roomCode);
                break;
            case 'gameState':
                updateGameState(data);
                break;
            case 'gameOver':
                endDraft(data.teams);
                break;
            case 'error':
                alert(data.message);
                break;
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket Error:', error);
    };
}

function createRoom() {
    const numPlayers = parseInt(document.getElementById('numPlayers').value);
    if (numPlayers < 1 || numPlayers > 8) {
        alert("Please enter a number between 1 and 8");
        return;
    }
    ws.send(JSON.stringify({ type: 'create', numPlayers: numPlayers }));
}

function joinRoom() {
    const roomCode = document.getElementById('roomCode').value.toUpperCase();
    ws.send(JSON.stringify({ type: 'join', roomCode: roomCode }));
}

function showWaitingRoom(roomCode) {
    currentRoomCode = roomCode;
    document.getElementById('setup').style.display = 'none';
    document.getElementById('waitingRoom').style.display = 'block';
    document.getElementById('displayRoomCode').textContent = roomCode;
}

function updateGameState(data) {
    document.getElementById('waitingRoom').style.display = 'none';
    document.getElementById('draftArea').style.display = 'block';
    
    document.getElementById('currentRound').textContent = data.currentRound;
    document.getElementById('currentPlayer').textContent = data.currentPlayer + 1;
    
    updateAvailablePokemon(data.availablePokemon, data.currentPlayer === playerIndex);
    updateTeams(data.teams);
    updateTurnIndicator(data.currentPlayer === playerIndex);
}

function updateAvailablePokemon(availablePokemon, isMyTurn) {
    const availableDiv = document.getElementById('availablePokemon');
    availableDiv.innerHTML = '<h3>Available Pokémon</h3>';
    availablePokemon.forEach((pokemon) => {
        const button = document.createElement('button');
        button.className = 'pokemon-button';
        button.innerHTML = `
            <div class="pokemon-name">${pokemon.name}</div>
            <div class="pokemon-types">${pokemon.types.join(' / ')}</div>
            <div class="pokemon-bst">BST: ${calculateBST(pokemon.baseStats)}</div>
        `;
        button.addEventListener('click', () => choosePokemon(pokemon));
        button.disabled = isMyTurn;
        availableDiv.appendChild(button);
    });
}

function updateTeams(teams) {
    const teamsDiv = document.getElementById('teams');
    teamsDiv.innerHTML = '<h3>Teams</h3>';
    teams.forEach((team, index) => {
        const teamDiv = document.createElement('div');
        teamDiv.className = 'team';
        teamDiv.innerHTML = `<h4>Player ${index + 1}</h4>`;
        team.forEach(pokemon => {
            teamDiv.appendChild(createPokemonDiv(pokemon));
        });
        teamsDiv.appendChild(teamDiv);
    });
}

function choosePokemon(pokemon) {
    ws.send(JSON.stringify({ 
        type: 'choose', 
        roomCode: currentRoomCode, 
        pokemon: pokemon 
    }));
}

function createPokemonDiv(pokemon) {
    const pokemonDiv = document.createElement('div');
    pokemonDiv.className = 'pokemon';
    pokemonDiv.innerHTML = `
        <div class="pokemon-name">${pokemon.name}</div>
        <div class="pokemon-types">${pokemon.types.join(' / ')}</div>
        <div class="pokemon-bst">BST: ${calculateBST(pokemon.baseStats)}</div>
    `;
    return pokemonDiv;
}

function calculateBST(baseStats) {
    return Object.values(baseStats).reduce((sum, stat) => sum + stat, 0);
}

function endDraft(teams) {
    const draftArea = document.getElementById('draftArea');
    draftArea.innerHTML = '<h2>Draft Complete!</h2>';
    updateTeams(teams);
}

function updateTurnIndicator(isMyTurn) {
    const turnIndicator = document.getElementById('turnIndicator');
    turnIndicator.textContent = isMyTurn ? 'Your turn!' : 'Not your turn';
}
