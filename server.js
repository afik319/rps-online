const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ========== ROOM MANAGEMENT ==========
const rooms = {}; // roomCode -> { players: [socketId, socketId], board, phase, turn, ... }

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function createRoom(hostId) {
  let code;
  do { code = generateCode(); } while (rooms[code]);
  rooms[code] = {
    code,
    players: [hostId], // [0]=host=blue, [1]=guest=red
    sockets: {},
    phase: 'waiting',   // waiting -> setup -> play -> over
    board: Array(8).fill(null).map(() => Array(8).fill(null)),
    ready: [false, false],
    turn: 0,            // index into players[]
    setupDone: [false, false],
  };
  rooms[code].sockets[hostId] = 0;
  return code;
}

function getRoom(socketId) {
  return Object.values(rooms).find(r => r.players.includes(socketId));
}

function getPlayerIndex(room, socketId) {
  return room.players.indexOf(socketId);
}

// ========== RPS LOGIC ==========
function rpsResult(a, b) {
  if (a === b) return 'tie';
  if ((a==='rock'&&b==='scissors')||(a==='scissors'&&b==='paper')||(a==='paper'&&b==='rock')) return 'win';
  return 'lose';
}

// ========== SOCKET EVENTS ==========
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Create room
  socket.on('create_room', () => {
    const code = createRoom(socket.id);
    socket.join(code);
    socket.emit('room_created', { code, playerIndex: 0 });
    console.log(`Room created: ${code}`);
  });

  // Join room
  socket.on('join_room', ({ code }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Room not found');
    if (room.players.length >= 2) return socket.emit('error', 'Room is full');
    
    room.players.push(socket.id);
    room.sockets[socket.id] = 1;
    socket.join(code);
    room.phase = 'setup';

    socket.emit('room_joined', { code, playerIndex: 1 });
    io.to(code).emit('game_start', { code });
    console.log(`Room joined: ${code}`);
  });

  // Player finished placing pieces
  socket.on('setup_done', ({ code, placement }) => {
    const room = rooms[code];
    if (!room) return;
    const idx = getPlayerIndex(room, socket.id);
    if (idx === -1) return;

    // Store placement on board
    // placement = array of {r, c, type} for their half
    // player 0 (blue) occupies rows 5,6,7; player 1 (red) occupies rows 0,1,2
    placement.forEach(({ r, c, type }) => {
      room.board[r][c] = { type, team: idx === 0 ? 'blue' : 'red' };
    });

    room.setupDone[idx] = true;
    socket.emit('setup_confirmed');

    if (room.setupDone[0] && room.setupDone[1]) {
      room.phase = 'play';
      room.turn = 0; // blue goes first
      // Send each player their view of the board
      sendBoardState(room);
      io.to(room.code).emit('phase_play', { turn: 0 });
    } else {
      // Tell the other player to wait
      socket.emit('waiting_for_opponent');
    }
  });

  // Player makes a move
  socket.on('make_move', ({ code, from, to, type }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'play') return;
    const idx = getPlayerIndex(room, socket.id);
    if (idx !== room.turn) return; // not your turn

    const board = room.board;
    const [fr, fc] = [from.r, from.c];
    const [tr, tc] = [to.r, to.c];
    const attacker = board[fr][fc];
    const defender = board[tr][tc];

    if (!attacker || attacker.team !== (idx===0?'blue':'red')) return;

    let event = null;

    if (!defender) {
      // Simple move
      board[tr][tc] = attacker;
      board[fr][fc] = null;
      event = { type: 'move', from, to, piece: attacker };
    } else if (defender.team !== attacker.team) {
      // Battle
      if (defender.type === 'flag') {
        board[tr][tc] = attacker;
        board[fr][fc] = null;
        event = { type: 'capture_flag', from, to, attacker, defender, winner: idx };
      } else if (defender.type === 'trap') {
        board[fr][fc] = null;
        event = { type: 'trap', from, to, attacker, defender };
      } else if (attacker.type === 'flag') {
        // flag shouldn't attack - ignore
        return;
      } else {
        const result = rpsResult(attacker.type, defender.type);
        if (result === 'win') {
          board[tr][tc] = attacker;
          board[fr][fc] = null;
        } else if (result === 'lose') {
          board[fr][fc] = null;
        } else {
          board[fr][fc] = null;
          board[tr][tc] = null;
        }
        event = { type: 'battle', from, to, attacker, defender, result };
      }
    } else return; // same team

    // Switch turn
    room.turn = 1 - room.turn;

    // Send board state and event to both players
    sendBoardState(room);
    io.to(code).emit('move_result', { event, turn: room.turn });

    // Check win
    if (event.type === 'capture_flag') {
      room.phase = 'over';
      io.to(code).emit('game_over', { winner: idx });
    } else {
      checkPiecesWin(room, code);
    }
  });

  // Chat message
  socket.on('chat', ({ code, msg }) => {
    const room = rooms[code];
    if (!room) return;
    const idx = getPlayerIndex(room, socket.id);
    const team = idx === 0 ? 'blue' : 'red';
    io.to(code).emit('chat', { team, msg: msg.substring(0, 100) });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const room = getRoom(socket.id);
    if (room) {
      io.to(room.code).emit('opponent_disconnected');
      delete rooms[room.code];
    }
    console.log('Disconnected:', socket.id);
  });

  // Rematch
  socket.on('rematch', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const idx = getPlayerIndex(room, socket.id);
    if (!room.rematch) room.rematch = [false, false];
    room.rematch[idx] = true;
    if (room.rematch[0] && room.rematch[1]) {
      // Reset game
      room.board = Array(8).fill(null).map(() => Array(8).fill(null));
      room.setupDone = [false, false];
      room.phase = 'setup';
      room.turn = 0;
      room.rematch = [false, false];
      // Swap sides
      room.players.reverse();
      io.to(code).emit('rematch_start', {
        p0: room.players[0],
        p1: room.players[1]
      });
    } else {
      socket.emit('waiting_rematch');
    }
  });
});

function sendBoardState(room) {
  room.players.forEach((socketId, idx) => {
    const myTeam = idx === 0 ? 'blue' : 'red';
    // Mask enemy pieces (send type as 'unknown')
    const maskedBoard = room.board.map(row =>
      row.map(cell => {
        if (!cell) return null;
        if (cell.team === myTeam) return cell; // show own pieces
        return { type: 'unknown', team: cell.team }; // hide enemy type
      })
    );
    io.to(socketId).emit('board_state', { board: maskedBoard, myTeam });
  });
}

function checkPiecesWin(room, code) {
  let blueFlag = false, redFlag = false, blueCount = 0, redCount = 0;
  for (let r=0;r<8;r++) for (let c=0;c<8;c++) {
    const p = room.board[r][c];
    if (!p) continue;
    if (p.team==='blue') { blueCount++; if(p.type==='flag') blueFlag=true; }
    if (p.team==='red')  { redCount++;  if(p.type==='flag') redFlag=true; }
  }
  if (!blueFlag) { room.phase='over'; io.to(code).emit('game_over', { winner: 1 }); }
  else if (!redFlag) { room.phase='over'; io.to(code).emit('game_over', { winner: 0 }); }
  else if (blueCount<=1) { room.phase='over'; io.to(code).emit('game_over', { winner: 1 }); }
  else if (redCount<=1) { room.phase='over'; io.to(code).emit('game_over', { winner: 0 }); }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`RPS Server running on port ${PORT}`));
