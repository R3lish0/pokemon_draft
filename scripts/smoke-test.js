'use strict';
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

// Boots its own server on a scratch port so the suite is self-contained.
const PORT = Number(process.env.DRAFT_TEST_PORT) || 3199;
const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'inherit'],
});
process.on('exit', () => server.kill());

const URL = `ws://localhost:${PORT}`;
let failures = 0;
function check(label, ok, extra) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
    if (!ok) failures++;
}

class Client {
    constructor(label) {
        this.label = label;
        this.state = null;
        this.events = [];
        this.errors = [];
        this.welcome = null;
        this.waiters = [];
    }
    connect(playerId) {
        return new Promise((resolve) => {
            this.ws = new WebSocket(URL);
            this.ws.on('open', () => this.send('hello', { playerId: playerId || null }));
            this.ws.on('message', (raw) => {
                const m = JSON.parse(raw);
                if (m.type === 'state') this.state = m;
                if (m.type === 'event') this.events.push(m);
                if (m.type === 'error') this.errors.push(m);
                if (m.type === 'welcome') { this.welcome = m; resolve(this); }
                this.waiters = this.waiters.filter((w) => !w(m));
            });
        });
    }
    send(type, payload) { this.ws.send(JSON.stringify({ type, ...payload })); }
    await(predicate, timeoutMs = 4000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${this.label}: timeout waiting`)), timeoutMs);
            const waiter = (m) => {
                if (!predicate(m)) return false;
                clearTimeout(timer); resolve(m); return true;
            };
            this.waiters.push(waiter);
        });
    }
    awaitState(predicate, timeoutMs) {
        if (this.state && predicate(this.state)) return Promise.resolve(this.state);
        return this.await((m) => m.type === 'state' && predicate(m), timeoutMs);
    }
    close() { this.ws.close(); }
}

(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500)); // let the server bind

    // ---- create + join -------------------------------------------------
    const host = await new Client('host').connect();
    check('welcome carries limits', !!host.welcome.limits, `dex=${host.welcome.dexSize}`);

    host.send('createRoom', { name: 'Ada', config: { numPlayers: 3, teamSize: 2, pickSeconds: 60 } });
    await host.awaitState((m) => m.room.phase === 'lobby');
    const code = host.state.room.code;
    check('room created', /^[A-Z0-9]{4}$/.test(code), code);
    check('host flagged', host.state.you.isHost === true);

    const p2 = await new Client('p2').connect();
    p2.send('joinRoom', { name: 'Grace', code });
    await p2.awaitState((m) => m.room.phase === 'lobby');
    const p3 = await new Client('p3').connect();
    p3.send('joinRoom', { name: 'Linus', code });
    await p3.awaitState((m) => m.room.players.length === 3);
    await host.awaitState((m) => m.room.players.length === 3);
    check('three seats filled', host.state.room.players.map((p) => p.name).join() === 'Ada,Grace,Linus');
    check('no teams field on the wire', host.state.room.teams === undefined);

    // ---- authorization -------------------------------------------------
    p2.send('startDraft', {});
    await p2.await((m) => m.type === 'error');
    check('non-host cannot start', p2.errors.at(-1).code === 'not_host', p2.errors.at(-1).message);

    const full = await new Client('overflow').connect();
    full.send('joinRoom', { name: 'Extra', code });
    await full.await((m) => m.type === 'error');
    check('full room rejects join', full.errors.at(-1).code === 'room_full');
    full.close();

    const bogus = await new Client('bogus').connect();
    bogus.send('joinRoom', { name: 'Nope', code: 'ZZZZ' });
    await bogus.await((m) => m.type === 'error');
    check('bad code rejected', bogus.errors.at(-1).code === 'no_such_room');
    bogus.close();

    // ---- start ---------------------------------------------------------
    host.send('startDraft', {});
    await host.awaitState((m) => m.room.phase === 'drafting');
    await p2.awaitState((m) => m.room.phase === 'drafting');
    await p3.awaitState((m) => m.room.phase === 'drafting');
    const room0 = host.state.room;
    check('default pool is exact-fit (no spares)', room0.config.extraPerPlayer === 0);
    check('pool size = total picks', room0.pool.length === 3 * 2, `${room0.pool.length}`);
    check('turn starts at slot 0', room0.turn.slot === 0);
    check('total picks = n*teamSize', room0.turn.totalPicks === 6, `${room0.turn.totalPicks}`);
    check('pool entries carry id+bst', !!room0.pool[0].id && room0.pool[0].bst > 0,
        `${room0.pool[0].id}/${room0.pool[0].bst}`);
    check('pool entries carry a resolved sprite path',
        room0.pool.every((m) => typeof m.sprite === 'string' && m.sprite.length > 0),
        room0.pool[0].sprite);
    check('pool entries carry types', room0.pool.every((m) => m.types.length >= 1));
    check('usage present or explicitly null',
        room0.pool.every((m) => m.usage === null || typeof m.usage === 'number'));
    check('all three saw the same pool', p3.state.room.pool.length === room0.pool.length);

    // ---- turn enforcement ----------------------------------------------
    p2.send('pick', { pokemonId: host.state.room.pool[0].id });
    await p2.await((m) => m.type === 'error');
    check('out-of-turn pick rejected', p2.errors.at(-1).code === 'not_your_turn', p2.errors.at(-1).message);

    const clients = [host, p2, p3];
    // ---- drive the snake ----------------------------------------------
    const seen = [];
    const optionsAtEachPick = [];
    while (host.state.room.phase === 'drafting') {
        const turn = host.state.room.turn;
        seen.push(turn.slot);
        optionsAtEachPick.push(host.state.room.pool.length);
        // Read the pool from `host`, whose snapshot we just awaited: the other
        // sockets may not have drained theirs yet this tick.
        const actor = clients[turn.slot];
        const target = host.state.room.pool[0];
        actor.send('pick', { pokemonId: target.id });
        await host.await((m) =>
            (m.type === 'state' && (m.room.phase === 'complete' || m.room.turn.pickNumber > turn.pickNumber)));
    }
    check('snake order 0,1,2,2,1,0', seen.join() === '0,1,2,2,1,0', seen.join());
    check('options shrink every pick, ending at 1',
        optionsAtEachPick.join() === '6,5,4,3,2,1', optionsAtEachPick.join());
    check('pool is exhausted at the end', host.state.room.pool.length === 0);
    check('draft completed', host.state.room.phase === 'complete');
    check('six picks recorded', host.state.room.picks.length === 6);
    check('no duplicate picks',
        new Set(host.state.room.picks.map((p) => p.pokemon.id)).size === 6);
    check('none auto-picked', host.state.room.picks.every((p) => !p.auto));
    const perSlot = [0, 1, 2].map((s) => host.state.room.picks.filter((p) => p.slot === s).length);
    check('two picks each', perSlot.join() === '2,2,2', perSlot.join());
    check('rounds labelled 1,1,1,2,2,2',
        host.state.room.picks.map((p) => p.round).join() === '1,1,1,2,2,2');
    await p2.awaitState((m) => m.room.phase === 'complete');
    await p3.awaitState((m) => m.room.phase === 'complete');
    check('everyone saw completion', p2.state.room.phase === 'complete' && p3.state.room.phase === 'complete');
    check('no errors during the draft', host.errors.length + p3.errors.length === 0,
        JSON.stringify([...host.errors, ...p3.errors]));
    check('pick events broadcast to all', p3.events.filter((e) => e.event === 'pick').length === 6,
        `${p3.events.filter((e) => e.event === 'pick').length}`);
    check('pick events carry sprite for the toast',
        p3.events.filter((e) => e.event === 'pick').every((e) => typeof e.pokemon.sprite === 'string'),
        p3.events.find((e) => e.event === 'pick').pokemon.sprite);
    check('completion event broadcast', p3.events.some((e) => e.event === 'draftComplete'));

    [host, p2, p3].forEach((c) => c.close());

    // ---- reconnect + auto-pick on timeout ------------------------------
    const a = await new Client('a').connect();
    a.send('createRoom', { name: 'Alice', config: { numPlayers: 2, teamSize: 1, extraPerPlayer: 3, pickSeconds: 2 } });
    await a.awaitState((m) => m.room.phase === 'lobby');
    const code2 = a.state.room.code;
    check('out-of-range config is clamped, not rejected', a.state.room.config.pickSeconds === 15,
        `pickSeconds=${a.state.room.config.pickSeconds}`);
    const b = await new Client('b').connect();
    b.send('joinRoom', { name: 'Bob', code: code2 });
    await b.awaitState((m) => m.room.players.length === 2);

    const bId = b.welcome.playerId;
    await a.awaitState((m) => m.room.players.length === 2);
    b.close();
    await a.awaitState((m) => m.room.players.length === 2 && m.room.players[1].connected === false);
    check('disconnect marks player away, seat retained', a.state.room.players.length === 2);

    const b2 = await new Client('b-again').connect(bId);
    await b2.awaitState((m) => m.room.code === code2);
    check('reconnect restores seat', b2.welcome.resumed === true && b2.state.you.slot === 1);

    a.send('startDraft', {});
    await a.awaitState((m) => m.room.phase === 'drafting');
    const poolBefore = a.state.room.pool.slice();
    const highest = poolBefore.reduce((x, y) => (y.bst > x.bst ? y : x));

    // Nobody picks: the clock (clamped to a 15s minimum) must pick for slot 0
    // and keep the room moving rather than deadlocking on the silent seat.
    await a.awaitState((m) => m.room.picks.length >= 1, 25000);
    const auto = a.state.room.picks[0];
    check('timeout auto-picks', auto.auto === true);
    check('auto-pick takes highest BST', auto.pokemon.id === highest.id,
        `${auto.pokemon.name} (${auto.pokemon.bst}) vs ${highest.name} (${highest.bst})`);

    await a.awaitState((m) => m.room.phase === 'complete', 25000);
    check('draft finishes without any human input', a.state.room.picks.length === 2);

    a.close(); b2.close();

    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
    console.error('\nSMOKE TEST CRASHED:', error.message);
    process.exit(1);
});
