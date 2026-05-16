const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ===== CONSTANTS =====
const ROWS = 6, COLS = 7;
// Each player places in their FIRST 2 rows:
// Blue (idx 0): rows 4,5 (bottom 2)
// Red  (idx 1): rows 0,1 (top 2)
const SETUP_ROWS = { blue: [4,5], red: [0,1] };
const TOTAL_PIECES = 14;
const IMMOVABLE = ['flag','trap']; // cannot move

// ===== ROOMS =====
// Rooms persist in memory; reconnecting players rejoin by socketId→playerName mapping
const rooms = {};
// Map: socketId -> { code, playerIdx }  for reconnect
const socketToRoom = {};

function generateCode() {
  return Math.random().toString(36).substring(2,7).toUpperCase();
}

function makeBoard() {
  return Array(ROWS).fill(null).map(() => Array(COLS).fill(null));
}

function createRoom(socketId) {
  let code;
  do { code = generateCode(); } while (rooms[code]);
  rooms[code] = {
    code,
    players: [socketId, null],   // [0]=blue, [1]=red
    phase: 'waiting',            // waiting|setup|play|tie_break|over
    board: makeBoard(),
    setupDone: [false, false],
    turn: 0,                     // index of player whose turn it is
    tieBreak: null,              // { from,to,attacker,defender,choices:[null,null] }
    revealed: {},                // "r,c" -> true
    scores: [0, 0],             // [blue score, red score]  persists across rematches
    skipVote: [false, false],   // for skip-turn logic
  };
  socketToRoom[socketId] = { code, idx: 0 };
  return code;
}

function teamOf(idx) { return idx === 0 ? 'blue' : 'red'; }

// ===== VALIDATION =====
function validateMove(board, fr, fc, tr, tc, team) {
  if (tr < 0 || tr >= ROWS || tc < 0 || tc >= COLS) return 'Out of bounds';
  const dr = Math.abs(tr-fr), dc = Math.abs(tc-fc);
  if (dr + dc !== 1) return 'Must move exactly 1 step (no diagonal)';
  const src = board[fr][fc];
  if (!src) return 'No piece at source';
  if (src.team !== team) return 'Not your piece';
  if (IMMOVABLE.includes(src.type)) return src.type + ' cannot move';
  const dst = board[tr][tc];
  if (dst && dst.team === team) return 'Cannot move onto own piece';
  return null;
}

// ===== HAS LEGAL MOVES =====
function hasLegalMoves(board, team) {
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) {
    const p = board[r][c];
    if (!p || p.team !== team || IMMOVABLE.includes(p.type)) continue;
    for (const [dr,dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nr=r+dr, nc=c+dc;
      if (nr<0||nr>=ROWS||nc<0||nc>=COLS) continue;
      const dst = board[nr][nc];
      if (!dst || dst.team !== team) return true;
    }
  }
  return false;
}

// ===== ADVANCE TURN (with skip if no moves) =====
function advanceTurn(room, code) {
  const next = 1 - room.turn;
  if (!hasLegalMoves(room.board, teamOf(next))) {
    // Skip next player's turn – they have no moves
    io.to(code).emit('turn_skipped', { skippedIdx: next });
    // Keep same turn
  } else {
    room.turn = next;
  }
}

// ===== RPS =====
function rpsResult(a,b) {
  if (a===b) return 'tie';
  if ((a==='rock'&&b==='scissors')||(a==='scissors'&&b==='paper')||(a==='paper'&&b==='rock')) return 'win';
  return 'lose';
}

// ===== WIN CHECK =====
// Only flag capture wins. Returns winner idx or -1.
function checkWin(room) {
  let blueFlag=false, redFlag=false;
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) {
    const p=room.board[r][c]; if(!p) continue;
    if(p.team==='blue'&&p.type==='flag') blueFlag=true;
    if(p.team==='red' &&p.type==='flag') redFlag=true;
  }
  if (!blueFlag) return 1; // red wins
  if (!redFlag)  return 0; // blue wins
  return -1;
}

// ===== SEND BOARD STATE =====
function sendBoardToPlayer(room, idx) {
  const socketId = room.players[idx];
  if (!socketId) return;
  const myTeam = teamOf(idx);
  const masked = room.board.map((row,r) =>
    row.map((cell,c) => {
      if (!cell) return null;
      if (cell.team === myTeam) return cell;
      if (room.revealed[`${r},${c}`]) return cell; // permanently revealed
      return { type:'unknown', team:cell.team };
    })
  );
  io.to(socketId).emit('board_state', { board: masked, myTeam });
}

function sendBoardState(room) {
  [0,1].forEach(idx => sendBoardToPlayer(room, idx));
}

// ===== FULL STATE SYNC (for reconnect) =====
function sendFullState(room, idx) {
  const socketId = room.players[idx];
  if (!socketId) return;
  sendBoardToPlayer(room, idx);
  io.to(socketId).emit('full_state_sync', {
    phase: room.phase,
    turn: room.turn,
    playerIndex: idx,
    myTeam: teamOf(idx),
    scores: room.scores,
    setupDone: room.setupDone[idx],
    tieBreak: room.tieBreak ? {
      attacker: room.tieBreak.attacker,
      defender: room.tieBreak.defender,
      myChoiceMade: room.tieBreak.choices[idx] !== null,
    } : null,
  });
}

// ===== RESOLVE BATTLE =====
function resolveBattle(room, code, attackerIdx, from, to, attacker, defender, result, aChoice, dChoice) {
  if (result === 'win') {
    room.board[to.r][to.c] = attacker;
    room.board[from.r][from.c] = null;
    room.revealed[`${to.r},${to.c}`] = true;
    delete room.revealed[`${from.r},${from.c}`];
  } else if (result === 'lose') {
    room.board[from.r][from.c] = null;
    room.revealed[`${to.r},${to.c}`] = true; // defender revealed as winner
  } else {
    // tie resolved – both eliminated
    room.board[from.r][from.c] = null;
    room.board[to.r][to.c] = null;
    delete room.revealed[`${from.r},${from.c}`];
    delete room.revealed[`${to.r},${to.c}`];
  }

  const event = { type:'battle', from, to, attacker:{...attacker}, defender:{...defender}, result, aChoice:aChoice||null, dChoice:dChoice||null };

  advanceTurn(room, code);
  sendBoardState(room);
  io.to(code).emit('move_result', { event, turn: room.turn });

  // Only flag capture counts as win – handled before calling this
  // No win for piece elimination
}

// ===== SOCKET EVENTS =====
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // --- Create room ---
  socket.on('create_room', () => {
    const code = createRoom(socket.id);
    socket.join(code);
    socket.emit('room_created', { code, playerIndex: 0 });
  });

  // --- Join room ---
  socket.on('join_room', ({ code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error','Room not found');
    if (room.players[1] !== null) return socket.emit('error','Room is full');
    room.players[1] = socket.id;
    socketToRoom[socket.id] = { code, idx: 1 };
    socket.join(code);
    room.phase = 'setup';
    room.players.forEach((sid, idx) => {
      io.to(sid).emit('game_start', { code, playerIndex: idx });
    });
  });

  // --- Reconnect ---
  socket.on('reconnect_attempt', ({ code, playerIndex }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error','Room not found or expired');
    if (playerIndex < 0 || playerIndex > 1) return socket.emit('error','Invalid player index');

    // Re-register socket
    room.players[playerIndex] = socket.id;
    socketToRoom[socket.id] = { code, idx: playerIndex };
    socket.join(code);

    // Notify other player
    const otherIdx = 1 - playerIndex;
    if (room.players[otherIdx]) {
      io.to(room.players[otherIdx]).emit('opponent_reconnected');
    }

    // Send full state to reconnecting player
    sendFullState(room, playerIndex);
    console.log(`Player ${playerIndex} reconnected to room ${code}`);
  });

  // --- Setup done ---
  socket.on('setup_done', ({ code, placement }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'setup') return;
    const info = socketToRoom[socket.id];
    if (!info || info.code !== code) return;
    const idx = info.idx;
    const myTeam = teamOf(idx);
    const allowed = SETUP_ROWS[myTeam];

    // Clear this player's side first
    for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) {
      if (room.board[r][c]?.team === myTeam) room.board[r][c] = null;
    }

    // Validate & place
    const counts = {rock:0,paper:0,scissors:0,flag:0,trap:0};
    const positions = new Set();
    for (const {r,c,type} of placement) {
      if (!allowed.includes(r)||c<0||c>=COLS) return socket.emit('error','Invalid row for placement');
      if (!counts.hasOwnProperty(type)) return socket.emit('error','Invalid piece type');
      const key=`${r},${c}`;
      if (positions.has(key)) return socket.emit('error','Duplicate cell');
      positions.add(key);
      counts[type]++;
      room.board[r][c] = { type, team: myTeam };
    }
    if (placement.length !== TOTAL_PIECES) return socket.emit('error','Must place exactly 14 pieces');
    if (counts.rock>4||counts.paper>4||counts.scissors>4||counts.flag!==1||counts.trap!==1)
      return socket.emit('error','Invalid piece counts');

    room.setupDone[idx] = true;
    socket.emit('setup_confirmed');

    if (room.setupDone[0] && room.setupDone[1]) {
      room.phase = 'play';
      room.turn = 0;
      sendBoardState(room);
      io.to(room.code).emit('phase_play', { turn: 0 });
    } else {
      socket.emit('waiting_for_opponent');
    }
  });

  // --- Make move ---
  socket.on('make_move', ({ code, from, to }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'play') return;
    const info = socketToRoom[socket.id];
    if (!info || info.idx !== room.turn) return socket.emit('error','Not your turn');
    const idx = info.idx;
    const myTeam = teamOf(idx);

    const err = validateMove(room.board, from.r, from.c, to.r, to.c, myTeam);
    if (err) return socket.emit('error', err);

    const attacker = room.board[from.r][from.c];
    const defender = room.board[to.r][to.c];

    if (!defender) {
      // Simple move
      room.board[to.r][to.c] = attacker;
      room.board[from.r][from.c] = null;
      // If attacker was revealed, move the reveal
      if (room.revealed[`${from.r},${from.c}`]) {
        room.revealed[`${to.r},${to.c}`] = true;
        delete room.revealed[`${from.r},${from.c}`];
      }
      const event = { type:'move', from, to, piece:{ type:attacker.type, team:myTeam } };
      advanceTurn(room, code);
      sendBoardState(room);
      io.to(code).emit('move_result', { event, turn: room.turn });

    } else if (defender.team !== myTeam) {
      // BATTLE
      if (defender.type === 'flag') {
        // WIN – capture flag
        room.board[to.r][to.c] = attacker;
        room.board[from.r][from.c] = null;
        room.revealed[`${to.r},${to.c}`] = true;
        room.phase = 'over';
        room.scores[idx]++;
        const event = { type:'capture_flag', from, to, attacker, defender };
        sendBoardState(room);
        io.to(code).emit('move_result', { event, turn: room.turn });
        io.to(code).emit('game_over', { winner: idx, reason:'flag', scores: room.scores });

      } else if (defender.type === 'trap') {
        // Attacker dies, trap stays revealed
        room.board[from.r][from.c] = null;
        room.revealed[`${to.r},${to.c}`] = true; // trap permanently revealed
        const event = { type:'trap', from, to, attacker, defender };
        advanceTurn(room, code);
        sendBoardState(room);
        io.to(code).emit('move_result', { event, turn: room.turn });

      } else {
        // Normal RPS
        const result = rpsResult(attacker.type, defender.type);
        if (result === 'tie') {
          room.phase = 'tie_break';
          room.tieBreak = { from, to, attacker, defender, attackerIdx: idx, choices:[null,null] };
          // Reveal both during tiebreak
          room.revealed[`${from.r},${from.c}`] = true;
          room.revealed[`${to.r},${to.c}`] = true;
          sendBoardState(room);
          io.to(code).emit('tie_break_start', {
            attacker:{type:attacker.type,team:attacker.team},
            defender:{type:defender.type,team:defender.team},
            attackerIdx: idx
          });
        } else {
          resolveBattle(room, code, idx, from, to, attacker, defender, result);
        }
      }
    }
  });

  // --- Tie break choice ---
  socket.on('tie_break_choice', ({ code, choice }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'tie_break' || !room.tieBreak) return;
    const info = socketToRoom[socket.id];
    if (!info || info.code !== code) return;
    const idx = info.idx;
    if (!['rock','paper','scissors'].includes(choice)) return;
    if (room.tieBreak.choices[idx] !== null) return; // already chose

    room.tieBreak.choices[idx] = choice;
    socket.emit('tie_break_waiting');

    const [c0, c1] = room.tieBreak.choices;
    if (c0 !== null && c1 !== null) {
      // Both chose – resolve
      const attackerIdx = room.tieBreak.attackerIdx;
      const defenderIdx = 1 - attackerIdx;
      const aChoice = room.tieBreak.choices[attackerIdx];
      const dChoice = room.tieBreak.choices[defenderIdx];
      const tbResult = rpsResult(aChoice, dChoice);

      if (tbResult === 'tie') {
        room.tieBreak.choices = [null, null];
        io.to(code).emit('tie_break_again', { aChoice, dChoice });
      } else {
        const { from, to, attacker, defender } = room.tieBreak;
        room.phase = 'play';
        room.tieBreak = null;
        resolveBattle(room, code, attackerIdx, from, to, attacker, defender, tbResult, aChoice, dChoice);
      }
    }
  });

  // --- Chat ---
  socket.on('chat', ({ code, msg }) => {
    const room = rooms[code];
    if (!room) return;
    const info = socketToRoom[socket.id];
    if (!info) return;
    io.to(code).emit('chat', { team: teamOf(info.idx), msg: msg.substring(0,100) });
  });

  // --- Rematch ---
  socket.on('rematch', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const info = socketToRoom[socket.id];
    if (!info || info.code !== code) return;
    const idx = info.idx;

    if (!room.rematch) room.rematch = [false, false];
    room.rematch[idx] = true;

    if (room.rematch[0] && room.rematch[1]) {
      // Reset game state only – scores persist
      room.board = makeBoard();
      room.setupDone = [false, false];
      room.phase = 'setup';
      room.turn = 0;
      room.tieBreak = null;
      room.revealed = {};
      room.rematch = [false, false];
      // Swap sides
      room.players.reverse();
      // Update socketToRoom mapping
      room.players.forEach((sid, i) => {
        if (sid) socketToRoom[sid] = { code, idx: i };
      });
      room.players.forEach((sid, i) => {
        if (sid) io.to(sid).emit('game_start', { code, playerIndex: i });
      });
    } else {
      socket.emit('waiting_rematch');
    }
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    const info = socketToRoom[socket.id];
    if (info) {
      const room = rooms[info.code];
      if (room) {
        // Don't delete room – keep state for reconnect
        // Notify other player
        const otherIdx = 1 - info.idx;
        if (room.players[otherIdx]) {
          io.to(room.players[otherIdx]).emit('opponent_disconnected');
        }
        // Mark slot as disconnected (keep room alive)
        room.players[info.idx] = null;
      }
      delete socketToRoom[socket.id];
    }
    console.log('Disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`RPS Server on port ${PORT}`));
