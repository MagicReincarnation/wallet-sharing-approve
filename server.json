const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const crypto = require('crypto');
const bip39 = require('bip39');
const secrets = require('secrets.js-grempe');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS untuk Netlify
const io = socketIO(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ===== POSTGRESQL CONNECTION =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        approvals TEXT[] DEFAULT '{}',
        wallet_generated BOOLEAN DEFAULT FALSE,
        generation_timestamp BIGINT,
        shares JSONB DEFAULT '{}',
        claimed_by TEXT[] DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT single_row CHECK (id = 1)
      );
      
      INSERT INTO wallet_state (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    `);
    console.log('✅ Database initialized');
  } catch (e) {
    console.error('Database init error:', e);
  } finally {
    client.release();
  }
}

initDB();

// ===== WHITELIST DEV WALLETS =====
const AUTHORIZED_DEVS = (process.env.DEV_ADDRESSES || 
  'paxi1dev1,paxi1dev2,paxi1dev3,paxi1dev4,paxi1dev5'
).split(',');

// ===== DATABASE HELPERS =====
async function getState() {
  const result = await pool.query('SELECT * FROM wallet_state WHERE id = 1');
  return result.rows[0];
}

async function updateState(updates) {
  const fields = Object.keys(updates).map((key, idx) => 
    `${key} = $${idx + 1}`
  ).join(', ');
  const values = Object.values(updates);
  
  await pool.query(`
    UPDATE wallet_state 
    SET ${fields}, updated_at = NOW()
    WHERE id = 1
  `, values);
}

// In-memory session storage
const sessions = new Map();

// ===== VERIFY DEV WALLET =====
app.post('/api/verify-dev', (req, res) => {
  const { address } = req.body;
  
  if (!AUTHORIZED_DEVS.includes(address)) {
    return res.json({ 
      success: false, 
      error: 'Unauthorized: Wallet not in dev whitelist' 
    });
  }
  
  const sessionToken = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionToken, { address, timestamp: Date.now() });
  
  res.json({ 
    success: true, 
    sessionToken,
    devIndex: AUTHORIZED_DEVS.indexOf(address) + 1
  });
});

// ===== GET WALLET STATUS =====
app.post('/api/wallet-status', async (req, res) => {
  const { sessionToken } = req.body;
  const session = sessions.get(sessionToken);
  
  if (!session) {
    return res.json({ success: false, error: 'Invalid session' });
  }
  
  try {
    const state = await getState();
    const devAddress = session.address;
    
    res.json({
      success: true,
      walletGenerated: state.wallet_generated,
      hasShare: !!state.shares[devAddress],
      hasClaimed: state.claimed_by.includes(devAddress),
      canClaim: state.wallet_generated && !state.claimed_by.includes(devAddress)
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== SOCKET.IO REALTIME =====
io.on('connection', (socket) => {
  console.log('Dev connected:', socket.id);
  
  socket.on('authenticate', async (sessionToken) => {
    const session = sessions.get(sessionToken);
    if (!session) {
      socket.emit('auth-failed');
      return socket.disconnect();
    }
    
    socket.devAddress = session.address;
    socket.sessionToken = sessionToken;
    socket.emit('auth-success', { address: session.address });
    
    try {
      const state = await getState();
      socket.emit('update-state', {
        approvals: state.approvals || [],
        totalApprovals: (state.approvals || []).length,
        required: AUTHORIZED_DEVS.length,
        walletGenerated: state.wallet_generated,
        hasShare: !!(state.shares && state.shares[socket.devAddress]),
        hasClaimed: (state.claimed_by || []).includes(socket.devAddress)
      });
    } catch (e) {
      console.error('State load error:', e);
    }
  });
  
  socket.on('submit-approval', async () => {
    if (!socket.devAddress) return;
    
    try {
      const state = await getState();
      const approvals = state.approvals || [];
      
      if (!approvals.includes(socket.devAddress)) {
        approvals.push(socket.devAddress);
        await updateState({ approvals });
      }
      
      const newState = await getState();
      io.emit('update-state', {
        approvals: newState.approvals,
        totalApprovals: newState.approvals.length,
        required: AUTHORIZED_DEVS.length,
        walletGenerated: newState.wallet_generated
      });
      
      if (newState.approvals.length === AUTHORIZED_DEVS.length && !newState.wallet_generated) {
        await generateAndSplitWallet();
      }
    } catch (e) {
      console.error('Approval error:', e);
    }
  });
  
  socket.on('revoke-approval', async () => {
    if (!socket.devAddress) return;
    
    try {
      const state = await getState();
      
      if (state.wallet_generated) {
        socket.emit('error-message', 'Cannot revoke: Wallet already generated!');
        return;
      }
      
      const approvals = (state.approvals || []).filter(a => a !== socket.devAddress);
      await updateState({ approvals });
      
      const newState = await getState();
      io.emit('update-state', {
        approvals: newState.approvals,
        totalApprovals: newState.approvals.length,
        required: AUTHORIZED_DEVS.length,
        walletGenerated: newState.wallet_generated
      });
    } catch (e) {
      console.error('Revoke error:', e);
    }
  });
  
  socket.on('request-share', async () => {
    if (!socket.devAddress) return;
    
    try {
      const state = await getState();
      
      if (!state.wallet_generated || !state.shares) return;
      
      const share = state.shares[socket.devAddress];
      if (!share) return;
      
      if (!state.claimed_by.includes(socket.devAddress)) {
        const claimedBy = [...state.claimed_by, socket.devAddress];
        await updateState({ claimed_by: claimedBy });
      }
      
      socket.emit('receive-share', { 
        share,
        claimCount: state.claimed_by.length + 1,
        totalDevs: AUTHORIZED_DEVS.length
      });
      
      console.log(`✅ Share claimed by ${socket.devAddress.substring(0, 10)}...`);
    } catch (e) {
      console.error('Request share error:', e);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Dev disconnected:', socket.id);
  });
});

// ===== GENERATE WALLET & SPLIT =====
async function generateAndSplitWallet() {
  const generatedMnemonic = bip39.generateMnemonic(256);
  
  console.log('🔐 Wallet Generated!');
  console.log('Mnemonic:', generatedMnemonic);
  
  const mnemonicHex = Buffer.from(generatedMnemonic).toString('hex');
  const sharesList = secrets.share(mnemonicHex, 5, 5);
  
  const shares = {};
  AUTHORIZED_DEVS.forEach((devAddress, index) => {
    shares[devAddress] = sharesList[index];
  });
  
  await updateState({
    wallet_generated: true,
    generation_timestamp: Date.now(),
    shares
  });
  
  io.emit('wallet-created', {
    message: 'Wallet berhasil dibuat! Setiap dev bisa claim share-nya.',
    timestamp: Date.now()
  });
  
  console.log('✅ Shares distributed and SAVED to database');
}

// ===== RESET =====
app.post('/api/reset', async (req, res) => {
  const { adminKey } = req.body;
  
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.json({ success: false, error: 'Invalid admin key' });
  }
  
  try {
    await updateState({
      approvals: [],
      wallet_generated: false,
      generation_timestamp: null,
      shares: {},
      claimed_by: []
    });
    
    io.emit('system-reset');
    res.json({ success: true, message: 'System reset successfully' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== GET CLAIM STATUS =====
app.get('/api/claim-status', async (req, res) => {
  try {
    const state = await getState();
    res.json({
      walletGenerated: state.wallet_generated,
      totalClaimed: (state.claimed_by || []).length,
      totalDevs: AUTHORIZED_DEVS.length,
      claimedBy: (state.claimed_by || []).map(addr => addr.substring(0, 10) + '...'),
      notClaimedYet: AUTHORIZED_DEVS.filter(addr => !(state.claimed_by || []).includes(addr))
        .map(addr => addr.substring(0, 10) + '...')
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Multi-Dev Wallet Server running on port ${PORT}`);
  console.log(`📋 Authorized Devs: ${AUTHORIZED_DEVS.length}`);
  console.log(`💾 Database: PostgreSQL`);
  console.log(`🌐 CORS: ${process.env.FRONTEND_URL || 'All origins'}`);
});
