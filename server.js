const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const crypto = require('crypto');
const bip39 = require('bip39');
const secrets = require('secrets.js-grempe');
const { Pool } = require('pg');
const cors = require('cors');
const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");

const app = express();
const server = http.createServer(app);

// Konfigurasi CORS
const io = socketIO(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// ===== DATABASE CONNECTION =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database schema
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        approvals TEXT[] DEFAULT '{}',
        wallet_generated BOOLEAN DEFAULT FALSE,
        wallet_paxi_address TEXT,
        generation_timestamp BIGINT,
        shares JSONB DEFAULT '{}',
        claimed_by TEXT[] DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT single_row CHECK (id = 1)
      );
      INSERT INTO wallet_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    `);
    // Cek kolom jika migrasi diperlukan
    await client.query(`ALTER TABLE wallet_state ADD COLUMN IF NOT EXISTS wallet_paxi_address TEXT;`);
    console.log('✅ Database Schema Synced');
  } catch (e) {
    console.error('❌ Database Init Error:', e);
  } finally {
    client.release();
  }
}
initDB();

// ===== WHITELIST DEVS =====
const AUTHORIZED_DEVS = (process.env.DEV_ADDRESSES || '').split(',').map(a => a.trim()).filter(a => a !== '');

// In-memory sessions
const sessions = new Map();

// ===== HELPERS =====
async function getState() {
  const res = await pool.query('SELECT * FROM wallet_state WHERE id = 1');
  return res.rows[0];
}

async function updateState(updates) {
  const keys = Object.keys(updates);
  const values = Object.values(updates);
  const setQuery = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
  await pool.query(`UPDATE wallet_state SET ${setQuery}, updated_at = NOW() WHERE id = 1`, values);
}

// ===== API ENDPOINTS =====

app.post('/api/verify-dev', async (req, res) => {
  const { address } = req.body;
  if (!AUTHORIZED_DEVS.includes(address)) {
    return res.status(403).json({ success: false, error: 'Unauthorized Dev Address' });
  }
  const sessionToken = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionToken, { address, timestamp: Date.now() });
  res.json({ success: true, sessionToken, devIndex: AUTHORIZED_DEVS.indexOf(address) + 1 });
});

app.post('/api/wallet-status', async (req, res) => {
  const { sessionToken } = req.body;
  const session = sessions.get(sessionToken);
  if (!session) return res.status(401).json({ success: false, error: 'Session Expired' });

  try {
    const state = await getState();
    res.json({
      success: true,
      walletGenerated: state.wallet_generated,
      paxiAddress: state.wallet_paxi_address,
      hasClaimed: (state.claimed_by || []).includes(session.address)
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== SOCKET LOGIC =====

io.on('connection', (socket) => {
  socket.on('authenticate', async (token) => {
    const session = sessions.get(token);
    if (!session) return socket.emit('auth-failed');

    socket.devAddress = session.address;
    socket.emit('auth-success', { address: session.address });

    const state = await getState();
    socket.emit('update-state', {
      approvals: state.approvals,
      totalApprovals: state.approvals.length,
      required: AUTHORIZED_DEVS.length,
      walletGenerated: state.wallet_generated,
      paxiAddress: state.wallet_paxi_address
    });
  });

  socket.on('submit-approval', async () => {
    if (!socket.devAddress) return;
    try {
      let state = await getState();
      if (state.wallet_generated) return socket.emit('error-message', 'Wallet sudah dibuat');

      const approvals = new Set(state.approvals);
      approvals.add(socket.devAddress);
      
      const newApprovals = Array.from(approvals);
      await updateState({ approvals: newApprovals });

      io.emit('update-state', { 
        approvals: newApprovals, 
        totalApprovals: newApprovals.length, 
        required: AUTHORIZED_DEVS.length 
      });

      if (newApprovals.length >= AUTHORIZED_DEVS.length) {
        await generateMultisigWallet();
      }
    } catch (e) { console.error(e); }
  });

  socket.on('request-share', async () => {
    if (!socket.devAddress) return;
    const state = await getState();
    if (!state.wallet_generated) return;

    const share = state.shares[socket.devAddress];
    if (!share) return socket.emit('error-message', 'Share tidak ditemukan');

    if (!state.claimed_by.includes(socket.devAddress)) {
      await updateState({ claimed_by: [...state.claimed_by, socket.devAddress] });
    }

    socket.emit('receive-share', { 
      share, 
      claimCount: state.claimed_by.length, 
      totalDevs: AUTHORIZED_DEVS.length 
    });
  });
});

// ===== CORE GENERATOR =====

async function generateMultisigWallet() {
  try {
    const state = await getState();
    if (state.wallet_generated) return;

    // 1. Generate Mnemonic
    const mnemonic = bip39.generateMnemonic(256);
    
    // 2. Derive Paxi Address
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "paxi" });
    const [account] = await wallet.getAccounts();
    const paxiAddress = account.address;

    // 3. Shamir Secret Sharing
    const mnemonicHex = Buffer.from(mnemonic).toString('hex');
    const sharesList = secrets.share(mnemonicHex, AUTHORIZED_DEVS.length, AUTHORIZED_DEVS.length);
    
    const sharesMap = {};
    AUTHORIZED_DEVS.forEach((addr, i) => { sharesMap[addr] = sharesList[i]; });

    // 4. Save to DB
    await updateState({
      wallet_generated: true,
      wallet_paxi_address: paxiAddress,
      shares: sharesMap,
      generation_timestamp: Date.now()
    });

    io.emit('wallet-created', { paxiAddress });
    io.emit('update-state', { 
        walletGenerated: true, 
        paxiAddress: paxiAddress,
        approvals: AUTHORIZED_DEVS,
        totalApprovals: AUTHORIZED_DEVS.length,
        required: AUTHORIZED_DEVS.length
    });

    console.log(`✅ Multisig Wallet Created: ${paxiAddress}`);
  } catch (e) {
    console.error('❌ Generation Critical Error:', e);
  }
}

// ===== PORT =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Paxi Multi-Dev Server v2.0 running on port ${PORT}`);
});
