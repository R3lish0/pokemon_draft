let ws;
let playerIndex;
let currentRoomCode;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('createRoomBtn').addEventListener('click', createRoom);
    document.getElementById('joinRoomBtn').addEventListener('click', joinRoom);
});

function connectWebSocket() {
    ws = new WebSocket('ws://' + window.location.host);
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Received message:', data); // Debug log
        switch(data.type) {
            case 'roomCreated':
                showWaitingRoom(data.roomCode);
                playerIndex = 0; // Creator is always the first player
                break;
            case 'joined':
                showWaitingRoom(data.roomCode);
                playerIndex = data.playerIndex;
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
    connectWebSocket();
    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'create', numPlayers: numPlayers }));
    };
}

function joinRoom() {
    const roomCode = document.getElementById('roomCode').value.toUpperCase();
    connectWebSocket();
    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', roomCode: roomCode }));
    };
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
    
    const isMyTurn = data.currentPlayer === playerIndex;
    console.log(`Current player: ${data.currentPlayer}, My index: ${playerIndex}, Is my turn: ${isMyTurn}`); // Debug log
    
    updateAvailablePokemon(data.availablePokemon, isMyTurn);
    updateTeams(data.teams);
    
    const turnIndicator = document.getElementById('turnIndicator');
    if (isMyTurn) {
        turnIndicator.textContent = "It's your turn!";
        turnIndicator.style.color = 'green';
    } else {
        turnIndicator.textContent = `Waiting for Player ${data.currentPlayer + 1} to choose...`;
        turnIndicator.style.color = 'red';
    }
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
        button.disabled = !isMyTurn;
        availableDiv.appendChild(button);
    });
}

function updateTeams(teams) {
    const teamsDiv = document.getElementById('teams');
    teamsDiv.innerHTML = '<h3>Teams</h3>';
    teams.forEach((team, index) => {
        const teamDiv = document.createElement('div');
        teamDiv.className = 'team';
        teamDiv.innerHTML = `<h4>Player ${index + 1}${index === playerIndex ? ' (You)' : ''}</h4>`;
        team.forEach(pokemon => {
            teamDiv.appendChild(createPokemonDiv(pokemon));
        });
        teamsDiv.appendChild(teamDiv);
    });
}

function choosePokemon(pokemon) {
    console.log('Choosing pokemon:', pokemon); // Debug log
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
    
    teams.forEach((team, index) => {
        const teamDiv = document.createElement('div');
        teamDiv.className = 'team-result';
        teamDiv.innerHTML = `<h3>Player ${index + 1}${index === playerIndex ? ' (You)' : ''}</h3>`;
        
        const teamList = document.createElement('ul');
        team.forEach(pokemon => {
            const listItem = document.createElement('li');
            listItem.textContent = pokemon.name;
            teamList.appendChild(listItem);
        });
        teamDiv.appendChild(teamList);
        
        if (index === playerIndex) {
            const copyButton = document.createElement('button');
            copyButton.textContent = 'Copy Team';
            copyButton.addEventListener('click', () => copyTeamToClipboard(team));
            teamDiv.appendChild(copyButton);
        }
        
        draftArea.appendChild(teamDiv);
    });
}

function copyTeamToClipboard(team) {
    const showdownFormat = team.map(pokemon => pokemon.name).join('\n\n');
    navigator.clipboard.writeText(showdownFormat).then(() => {
        alert('Team copied to clipboard!');
    }, (err) => {
        console.error('Could not copy text: ', err);
        alert('Failed to copy team. Please try again.');
    });
}
