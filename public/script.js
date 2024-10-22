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
                showWaitingRoom(data);
                break;
            case 'joined':
                playerIndex = data.playerIndex;
                showWaitingRoom(data);
                break;
            case 'waitingRoom':
                showWaitingRoom(data);
                break;
            case 'gameState':
                updateGameState(data);
                break;
            case 'reveal':
                dramaticReveal(data.playerIndex, data.pokemon);
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

    ws.onopen = () => {
        console.log('WebSocket connection established');
    };

    ws.onclose = () => {
        console.log('WebSocket connection closed');
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
    const selectedPlayer = document.getElementById('playerSelect').value;
    ws.send(JSON.stringify({ type: 'join', roomCode: roomCode, selectedPlayer: parseInt(selectedPlayer) }));
}

function showWaitingRoom(data) {
    document.getElementById('setup').style.display = 'none';
    document.getElementById('waitingRoom').style.display = 'block';
    document.getElementById('displayRoomCode').textContent = data.roomCode;
    
    const playerList = document.getElementById('playerList');
    playerList.innerHTML = '';
    data.players.forEach((isPresent, index) => {
        const li = document.createElement('li');
        li.textContent = `Player ${index + 1}: ${isPresent ? 'Present' : 'Waiting...'}`;
        if (index === playerIndex) li.textContent += ' (You)';
        playerList.appendChild(li);
    });
}

function updateGameState(data) {
    document.getElementById('waitingRoom').style.display = 'none';
    document.getElementById('draftArea').style.display = 'block';
    
    document.getElementById('currentRound').textContent = data.currentRound;
    document.getElementById('currentPlayer').textContent = data.currentPlayer + 1;
    
    const isMyTurn = data.currentPlayer === playerIndex;
    
    if (data.currentRound === 1 && data.currentPlayer === 0 && !data.teams.some(team => team.length > 0)) {
        introduceAllPokemon(data.availablePokemon);
    } else {
        updateAvailablePokemon(data.availablePokemon, isMyTurn);
    }
    
    updateTeams(data.teams);
    updateTurnIndicator(isMyTurn);
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
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
            type: 'choose', 
            roomCode: currentRoomCode, 
            pokemon: pokemon 
        }));
    } else {
        console.error('WebSocket is not open. ReadyState:', ws.readyState);
    }
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
    const teamsContainer = document.createElement('div');
    teamsContainer.id = 'finalTeams';
    
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
        
        teamsContainer.appendChild(teamDiv);
    });
    
    draftArea.appendChild(teamsContainer);
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

function updateTurnIndicator(isMyTurn) {
    const turnIndicator = document.getElementById('turnIndicator');
    if (isMyTurn) {
        turnIndicator.textContent = "It's your turn!";
        turnIndicator.style.color = 'green';
    } else {
        turnIndicator.textContent = "Waiting for other player...";
        turnIndicator.style.color = 'red';
    }
}

function dramaticReveal(playerIndex, pokemon) {
    const revealOverlay = document.createElement('div');
    revealOverlay.className = 'reveal-overlay';
    revealOverlay.innerHTML = `
        <div class="reveal-content">
            <h2>Player ${playerIndex + 1} chooses...</h2>
            <div class="reveal-pokemon">
                <div class="pokemon-name">${pokemon.name}</div>
                <div class="pokemon-types">${pokemon.types.join(' / ')}</div>
                <div class="pokemon-bst">BST: ${calculateBST(pokemon.baseStats)}</div>
            </div>
        </div>
    `;
    document.body.appendChild(revealOverlay);
    
    // Add dramatic animation
    setTimeout(() => {
        revealOverlay.classList.add('reveal');
    }, 50);
    
    // Remove the overlay after 1.5 seconds (reduced from 3 seconds)
    setTimeout(() => {
        revealOverlay.classList.remove('reveal');
        setTimeout(() => {
            document.body.removeChild(revealOverlay);
        }, 250);
    }, 1500);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function introducePokemon(pokemon, index) {
    const revealOverlay = document.createElement('div');
    revealOverlay.className = 'reveal-overlay';
    revealOverlay.innerHTML = `
        <div class="reveal-content">
            <h2>Pokémon #${index + 1}</h2>
            <div class="reveal-pokemon">
                <div class="pokemon-name">${pokemon.name}</div>
                <div class="pokemon-types">${pokemon.types.join(' / ')}</div>
                <div class="pokemon-bst">BST: ${calculateBST(pokemon.baseStats)}</div>
            </div>
        </div>
    `;
    document.body.appendChild(revealOverlay);
    
    await sleep(50);
    revealOverlay.classList.add('reveal');
    
    await sleep(1500); // Increased from 1000ms to 1500ms
    revealOverlay.classList.remove('reveal');
    
    await sleep(250);
    document.body.removeChild(revealOverlay);
    addPokemonToPool(pokemon);
}

function addPokemonToPool(pokemon) {
    const availableDiv = document.getElementById('availablePokemon');
    const button = document.createElement('button');
    button.className = 'pokemon-button fade-in';
    button.disabled = true;
    button.innerHTML = `
        <div class="pokemon-name">${pokemon.name}</div>
        <div class="pokemon-types">${pokemon.types.join(' / ')}</div>
        <div class="pokemon-bst">BST: ${calculateBST(pokemon.baseStats)}</div>
    `;
    availableDiv.appendChild(button);
    
    // Trigger reflow to ensure the fade-in animation plays
    button.offsetHeight;
    button.classList.remove('fade-in');
}

async function introduceAllPokemon(pokemonList) {
    const availableDiv = document.getElementById('availablePokemon');
    availableDiv.innerHTML = '<h3>Available Pokémon</h3>';
    
    // Create a shuffled copy of the pokemonList
    const shuffledList = [...pokemonList].sort(() => Math.random() - 0.5);
    
    for (let i = 0; i < shuffledList.length; i++) {
        await introducePokemon(shuffledList[i], i);
        await sleep(400); // Increased from 300ms to 400ms
    }
    updateAvailablePokemon(pokemonList, playerIndex === 0);
}
