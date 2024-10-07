import requests
import random
import curses
import time

# Define color pairs for each type
TYPE_COLORS = {
    'Normal': 1,
    'Fire': 2,
    'Water': 3,
    'Electric': 4,
    'Grass': 5,
    'Ice': 6,
    'Fighting': 7,
    'Poison': 8,
    'Ground': 9,
    'Flying': 10,
    'Psychic': 11,
    'Bug': 12,
    'Rock': 13,
    'Ghost': 14,
    'Dragon': 15,
    'Dark': 16,
    'Steel': 17,
    'Fairy': 18
}

def init_colors():
    curses.start_color()
    curses.init_pair(1, curses.COLOR_WHITE, curses.COLOR_BLACK)  # Normal
    curses.init_pair(2, curses.COLOR_RED, curses.COLOR_BLACK)  # Fire
    curses.init_pair(3, curses.COLOR_BLUE, curses.COLOR_BLACK)  # Water
    curses.init_pair(4, curses.COLOR_YELLOW, curses.COLOR_BLACK)  # Electric
    curses.init_pair(5, curses.COLOR_GREEN, curses.COLOR_BLACK)  # Grass
    curses.init_pair(6, curses.COLOR_CYAN, curses.COLOR_BLACK)  # Ice
    curses.init_pair(7, curses.COLOR_RED, curses.COLOR_BLACK)  # Fighting
    curses.init_pair(8, curses.COLOR_MAGENTA, curses.COLOR_BLACK)  # Poison
    curses.init_pair(9, curses.COLOR_YELLOW, curses.COLOR_BLACK)  # Ground
    curses.init_pair(10, curses.COLOR_CYAN, curses.COLOR_BLACK)  # Flying
    curses.init_pair(11, curses.COLOR_MAGENTA, curses.COLOR_BLACK)  # Psychic
    curses.init_pair(12, curses.COLOR_GREEN, curses.COLOR_BLACK)  # Bug
    curses.init_pair(13, curses.COLOR_YELLOW, curses.COLOR_BLACK)  # Rock
    curses.init_pair(14, curses.COLOR_MAGENTA, curses.COLOR_BLACK)  # Ghost
    curses.init_pair(15, curses.COLOR_RED, curses.COLOR_BLACK)  # Dragon
    curses.init_pair(16, curses.COLOR_BLACK, curses.COLOR_WHITE)  # Dark
    curses.init_pair(17, curses.COLOR_WHITE, curses.COLOR_BLACK)  # Steel
    curses.init_pair(18, curses.COLOR_MAGENTA, curses.COLOR_BLACK)  # Fairy

def get_showdown_pokemon_list():
    url = "https://play.pokemonshowdown.com/data/pokedex.json"
    response = requests.get(url)
    data = response.json()
    return data

def get_standard_pokemon(pokedex):
    standard_pokemon = []
    for name, data in pokedex.items():
        if 1 <= data.get('num', 0) <= 1010 and not data.get('isNonstandard'):
            base_stats = data.get('baseStats', {})
            bst = sum(base_stats.values())
            types = data.get('types', [])
            standard_pokemon.append((name, bst, types))
    return sorted(standard_pokemon, key=lambda x: x[1], reverse=True)

def generate_random_pool(pokemon_list, pool_size):
    return sorted(random.sample(pokemon_list, min(pool_size, len(pokemon_list))), key=lambda x: x[1], reverse=True)

def center_text(stdscr, text, row, attr=curses.A_NORMAL):
    height, width = stdscr.getmaxyx()
    start_col = (width - len(text)) // 2
    stdscr.addstr(row, start_col, text, attr)

def vertical_center(stdscr, num_rows):
    height, _ = stdscr.getmaxyx()
    return (height - num_rows) // 2

def get_correct_type(type_name):
    return next((t for t in TYPE_COLORS.keys() if t.lower() == type_name.lower()), type_name)

def dramatic_reveal(stdscr, pokemon_pool):
    stdscr.clear()
    height, width = stdscr.getmaxyx()
    start_row = vertical_center(stdscr, 5)  # 5 rows of content

    center_text(stdscr, "Revealing Pokémon Pool", start_row, curses.A_BOLD)
    center_text(stdscr, "Press any key to reveal each Pokémon", start_row + 2)
    stdscr.refresh()
    stdscr.getch()

    random_pool = random.sample(pokemon_pool, len(pokemon_pool))
    for i, (pokemon, bst, types) in enumerate(random_pool, 1):
        stdscr.clear()
        center_text(stdscr, f"Pokémon {i} of {len(pokemon_pool)}", start_row, curses.A_BOLD)
        
        reveal_text = f"{pokemon.capitalize()} (BST: {bst})"
        for j in range(len(reveal_text)):
            center_text(stdscr, reveal_text[:j+1], start_row + 2)
            stdscr.refresh()
            time.sleep(0.05)
        
        correct_types = [get_correct_type(t) for t in types]
        type_text = "Type: " + "/".join(correct_types)
        center_text(stdscr, type_text, start_row + 4)
        
        # Color the type names
        type_col = (width - len(type_text)) // 2 + len("Type: ")
        for j, type_name in enumerate(correct_types):
            stdscr.addstr(start_row + 4, type_col, type_name, curses.color_pair(TYPE_COLORS[type_name]))
            type_col += len(type_name)
            if j < len(correct_types) - 1:
                stdscr.addstr(start_row + 4, type_col, "/")
                type_col += 1  # +1 for the "/" separator
        
        stdscr.refresh()
        stdscr.getch()

def display_current_teams(stdscr, teams, start_row):
    height, width = stdscr.getmaxyx()
    num_players = len(teams)
    margin = 4  # Increased horizontal margin
    player_width = (width - 2 * margin) // num_players

    center_text(stdscr, "Current Teams", start_row, curses.A_BOLD)
    start_row += 2  # Move down two rows after the title

    # Display player names
    for i, player in enumerate(teams.keys()):
        player_col = margin + i * player_width + (player_width - len(player)) // 2
        stdscr.addstr(start_row, player_col, player, curses.A_BOLD)
        stdscr.addstr(start_row + 1, margin + i * player_width, "-" * player_width)

    # Display Pokémon
    max_pokemon = max(len(team) for team in teams.values())
    for row in range(max_pokemon):
        for i, (player, pokemon_list) in enumerate(teams.items()):
            if row < len(pokemon_list):
                pokemon, bst, types = pokemon_list[row]
                pokemon_str = pokemon.capitalize()
                pokemon_col = margin + i * player_width + (player_width - len(pokemon_str)) // 2
                stdscr.addstr(start_row + row * 2 + 2, pokemon_col, pokemon_str)
                
                info_str = f"BST: {bst} - {'/'.join(types)}"
                info_col = margin + i * player_width + (player_width - len(info_str)) // 2
                stdscr.addstr(start_row + row * 2 + 3, info_col, info_str)
                
                # Color the type names
                type_col = info_col + len(f"BST: {bst} - ")
                for type_name in types:
                    stdscr.addstr(start_row + row * 2 + 3, type_col, type_name, curses.color_pair(TYPE_COLORS[type_name]))
                    type_col += len(type_name) + 1  # +1 for the "/" separator

def display_available_pokemon(stdscr, pokemon_list, start_index, teams, current_player):
    height, width = stdscr.getmaxyx()
    num_teams = len(teams)
    team_display_height = 6 + max(len(team) for team in teams.values()) * 2  # Title + Header + underline + (Pokémon + Info) * 2
    
    available_pokemon_height = height - team_display_height - 12  # Reserve space for header, footer, teams, and spacing
    pokemon_height = 1  # Now each Pokémon takes only one line
    rows_of_pokemon = available_pokemon_height // pokemon_height

    total_rows = rows_of_pokemon * pokemon_height + team_display_height + 10  # Pokémon list + team display + headers + spacing
    start_row = (height - total_rows) // 2

    # Display player prompt at the top
    center_text(stdscr, f"{current_player}, choose your Pokémon:", start_row, curses.A_BOLD)
    start_row += 2  # Add a blank line after the prompt

    # Display available Pokémon
    pokemon_start_row = start_row
    center_text(stdscr, "Available Pokémon", pokemon_start_row, curses.A_BOLD)
    center_text(stdscr, "-" * 20, pokemon_start_row + 1)
    
    # Calculate column widths
    index_width = 4
    name_width = 15
    name_bst_spacing = 5
    bst_width = 9
    type_width = 20
    total_width = index_width + name_width + name_bst_spacing + bst_width + type_width
    
    # Calculate left margin to center the list
    left_margin = (width - total_width) // 2

    for i in range(rows_of_pokemon):
        if start_index + i < len(pokemon_list):
            pokemon, bst, types = pokemon_list[start_index + i]
            correct_types = [get_correct_type(t) for t in types]
            row = pokemon_start_row + 3 + i
            
            # Format each part of the Pokémon info
            index_str = f"{start_index + i + 1:3}."
            pokemon_str = f"{pokemon.capitalize():<{name_width}}"
            bst_str = f"BST: {bst:<4} "
            type_str = "/".join(correct_types)
            
            # Add each part to the screen
            col = left_margin
            stdscr.addstr(row, col, index_str)
            col += index_width
            stdscr.addstr(row, col, pokemon_str)
            col += name_width + name_bst_spacing
            stdscr.addstr(row, col, bst_str)
            col += bst_width
            stdscr.addstr(row, col, "Type: ")
            
            # Color the type names
            for j, type_name in enumerate(correct_types):
                stdscr.addstr(row, col + 6 + (len("/") * j) + sum(len(t) for t in correct_types[:j]), 
                              type_name, curses.color_pair(TYPE_COLORS[type_name]))
                if j < len(correct_types) - 1:
                    stdscr.addstr(row, col + 6 + (len("/") * (j+1)) + sum(len(t) for t in correct_types[:j+1]), "/")

    # Display current teams below the available Pokémon
    team_start_row = pokemon_start_row + rows_of_pokemon + 4
    display_current_teams(stdscr, teams, team_start_row)

def get_user_choice(stdscr, player, available_pokemon, teams):
    height, width = stdscr.getmaxyx()
    start_index = 0
    while True:
        stdscr.clear()
        display_available_pokemon(stdscr, available_pokemon, start_index, teams, player)
        center_text(stdscr, "Enter the number of your chosen Pokémon (or 'n' for next page, 'p' for previous page): ", height-2)
        stdscr.refresh()
        curses.echo()
        choice = stdscr.getstr().decode('utf-8').lower()
        curses.noecho()
        
        if choice == 'n':
            start_index = min(start_index + 10, len(available_pokemon) - 10)
        elif choice == 'p':
            start_index = max(0, start_index - 10)
        else:
            try:
                choice = int(choice)
                if 1 <= choice <= len(available_pokemon):
                    return available_pokemon[choice - 1]
                else:
                    center_text(stdscr, "Invalid choice. Please try again.", height-1)
                    stdscr.refresh()
                    stdscr.getch()
            except ValueError:
                center_text(stdscr, "Please enter a valid number.", height-1)
                stdscr.refresh()
                stdscr.getch()

def draft_pokemon_teams(stdscr, num_players, pokemon_pool):
    teams = {f"Player {i+1}": [] for i in range(num_players)}
    available_pokemon = pokemon_pool.copy()
    
    for round in range(4):  # 4 rounds of drafting
        players = range(num_players) if round % 2 == 0 else range(num_players - 1, -1, -1)
        
        for player in players:
            if available_pokemon:
                stdscr.clear()
                center_text(stdscr, f"Round {round + 1}", 0)
                chosen_pokemon = get_user_choice(stdscr, f"Player {player + 1}", available_pokemon, teams)
                teams[f"Player {player+1}"].append(chosen_pokemon)
                available_pokemon.remove(chosen_pokemon)
    
    return teams

def display_final_teams(stdscr, teams):
    stdscr.clear()
    center_text(stdscr, "Final Teams:", 0)
    row = 2
    for player, team in teams.items():
        center_text(stdscr, f"{player}:", row)
        row += 1
        for i, (pokemon, bst, types) in enumerate(team, 1):
            correct_types = [get_correct_type(t) for t in types]
            pokemon_str = f"Pick {i}: {pokemon.capitalize():<20} BST: {bst:<4} Type: "
            center_text(stdscr, pokemon_str, row)
            type_col = (stdscr.getmaxyx()[1] - len(pokemon_str)) // 2 + len(pokemon_str)
            for j, type_name in enumerate(correct_types):
                stdscr.addstr(row, type_col, type_name, curses.color_pair(TYPE_COLORS[type_name]))
                type_col += len(type_name)
                if j < len(correct_types) - 1:
                    stdscr.addstr(row, type_col, "/")
                    type_col += 1  # +1 for the "/" separator
            row += 1
        row += 1
    center_text(stdscr, "Press any key to exit...", row)
    stdscr.refresh()
    stdscr.getch()

def display_ascii_art(stdscr):
    ascii_art = [
        "  ____       _                              ____             __ _   ",
        " |  _ \ ___ | | _____ _ __ ___   ___  _ __ |  _ \  _ __ __ _/ _| |_ ",
        " | |_) / _ \| |/ / _ \ '_ ` _ \ / _ \| '_ \| | | || '__/ _` | |_| __|",
        " |  __/ (_) |   <  __/ | | | | | (_) | | | | |_| || | | (_| |  _| |_ ",
        " |_|   \___/|_|\_\___|_| |_| |_|\___/|_| |_|____/ |_|  \__,_|_|  \__|",
        "                                                                     "
    ]
    height, width = stdscr.getmaxyx()
    start_row = (height - len(ascii_art)) // 2
    start_col = (width - len(ascii_art[0])) // 2
    
    for i, line in enumerate(ascii_art):
        stdscr.addstr(start_row + i, start_col, line)
    
    prompt = "Press any key to start..."
    prompt_row = start_row + len(ascii_art) + 2
    prompt_col = (width - len(prompt)) // 2
    stdscr.addstr(prompt_row, prompt_col, prompt, curses.A_BOLD)

def main(stdscr):
    curses.curs_set(0)  # Hide the cursor
    init_colors()
    stdscr.clear()
    
    display_ascii_art(stdscr)
    stdscr.refresh()
    stdscr.getch()
    
    stdscr.clear()
    center_text(stdscr, "Welcome to the Pokémon Draft Simulator (Gen 1-9, Standard Forms)!", 0)
    center_text(stdscr, "Fetching Pokémon Showdown data...", 2)
    stdscr.refresh()
    
    pokedex = get_showdown_pokemon_list()
    standard_pokemon = get_standard_pokemon(pokedex)
    
    curses.curs_set(1)  # Show the cursor for input
    center_text(stdscr, "Enter the number of players: ", 4)
    stdscr.refresh()
    curses.echo()
    num_players = int(stdscr.getstr())
    curses.noecho()
    curses.curs_set(0)  # Hide the cursor again

    pool_size = num_players * 4  # Ensure there are enough Pokémon for all players
    pokemon_pool = generate_random_pool(standard_pokemon, pool_size)

    dramatic_reveal(stdscr, pokemon_pool)

    teams = draft_pokemon_teams(stdscr, num_players, pokemon_pool)
    display_final_teams(stdscr, teams)

if __name__ == "__main__":
    curses.wrapper(main)