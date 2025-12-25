const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const crypto = require('crypto');
const bip39 = require('bip39');
const secrets = require('secrets.js-grempe');
const { Pool } = require('pg');
const cors = require('cors');
const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { SigningCosmWasmClient } = require("@cosmjs/cosmwasm-stargate");
const { SigningStargateClient, GasPrice } = require("@cosmjs/stargate");
// import Any protobuf (wajib untuk kirim msg module)
const { Any } = require("cosmjs-types/google/protobuf/any");

const app = express();
const server = http.createServer(app);

const io = socketIO(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// ===== DECIMAL HELPERS (WAJIB TAMBAH) =====
const CW20_DECIMALS = 6n;

function toBaseUnit(amount, decimals = CW20_DECIMALS) {
  if (amount === undefined || amount === null) {
    throw new Error("Amount is required");
  }
  
  const [whole, fraction = ""] = amount.toString().split(".");
  const paddedFraction = fraction.padEnd(Number(decimals), "0").slice(0, Number(decimals));
  
  return BigInt(whole + paddedFraction).toString();
}

// ===== DATABASE =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    // 1. Jalankan Create Table (untuk database baru)
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
      
      CREATE TABLE IF NOT EXISTS proposals (
        id SERIAL PRIMARY KEY,
        proposal_id TEXT UNIQUE NOT NULL,
        proposer TEXT NOT NULL,
        action_type TEXT NOT NULL,
        action_data JSONB NOT NULL,
        status TEXT DEFAULT 'pending',
        votes JSONB DEFAULT '{}',
        submitted_shares JSONB DEFAULT '{}',
        execution_result JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        executed_at TIMESTAMP
      );
    `);
    
    // 2. Jalankan Migrasi Manual (untuk database yang sudah ada/lama)
    await client.query(`
      -- Memastikan wallet_state punya kolom yang diperlukan
      ALTER TABLE wallet_state ADD COLUMN IF NOT EXISTS wallet_paxi_address TEXT;
      ALTER TABLE wallet_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      
      -- Memastikan proposals punya kolom updated_at (INI YANG KURANG TADI)
      ALTER TABLE proposals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      
      INSERT INTO wallet_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    `);
    
    console.log('✅ Database Schema Ready & Updated');
  } catch (e) {
    console.error('❌ Database Init Error:', e);
  } finally {
    client.release();
  }
}

initDB();

// ===== CONFIG =====
const AUTHORIZED_DEVS = (process.env.DEV_ADDRESSES || '').split(',').map(a => a.trim()).filter(Boolean);
const RPC = 'https://mainnet-rpc.paxinet.io';
const LCD = 'https://mainnet-lcd.paxinet.io';
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

// ===== GOVERNANCE FUNCTIONS =====

async function createProposal(proposer, actionType, actionData) {
  const proposalId = crypto.randomBytes(16).toString('hex');
  
  await pool.query(`
    INSERT INTO proposals (proposal_id, proposer, action_type, action_data, votes, submitted_shares)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [proposalId, proposer, actionType, JSON.stringify(actionData), JSON.stringify({}), JSON.stringify({})]);
  
  return proposalId;
}

async function voteProposal(proposalId, voter, vote, share = null) {
  const result = await pool.query('SELECT * FROM proposals WHERE proposal_id = $1', [proposalId]);
  if (result.rows.length === 0) throw new Error('Proposal not found');
  
  const proposal = result.rows[0];
  if (proposal.status !== 'pending') throw new Error('Proposal already finalized');
  
  const votes = proposal.votes || {};
  const submittedShares = proposal.submitted_shares || {};
  
  votes[voter] = vote;
  if (share && vote === 'approve') {
    submittedShares[voter] = share;
  }
  
  await pool.query(`
    UPDATE proposals 
    SET votes = $1, submitted_shares = $2, updated_at = NOW()
    WHERE proposal_id = $3
  `, [JSON.stringify(votes), JSON.stringify(submittedShares), proposalId]);
  
  // Check if all voted
  const totalVotes = Object.keys(votes).length;
  if (totalVotes === AUTHORIZED_DEVS.length) {
    await finalizeProposal(proposalId);
  }
  
  return { votes, totalVotes, required: AUTHORIZED_DEVS.length };
}

async function finalizeProposal(proposalId) {
  const result = await pool.query('SELECT * FROM proposals WHERE proposal_id = $1', [proposalId]);
  const proposal = result.rows[0];
  
  const votes = proposal.votes || {};
  const allApproved = Object.values(votes).every(v => v === 'approve');
  
  if (!allApproved) {
    await pool.query(`
    UPDATE proposals 
    SET status = 'rejected', 
        executed_at = NOW(),
        submitted_shares = $2
    WHERE proposal_id = $1
  `, [proposalId, JSON.stringify({ status: "proposal rejected" })]);
    
    io.emit('proposal-finalized', { proposalId, status: 'rejected' });
    return;
  }
  
  
  try {
    // 1. Eksekusi ke Blockchain (Mmnemonic disusun ulang di dalam sini)
    const executionResult = await executeProposal(proposal);
    
    // 2. MODIFIKASI: Update database, hapus shares, dan ubah teksnya
    // Kita menggunakan JSONB untuk menyimpan string tersebut agar valid secara format kolom
    await pool.query(`
      UPDATE proposals 
      SET status = 'executed', 
          execution_result = $1, 
          submitted_shares = $2, -- Ini akan menghapus shares asli dan menggantinya dengan teks
          executed_at = NOW()
      WHERE proposal_id = $3
    `, [
      JSON.stringify(executionResult),
      JSON.stringify({ status: "developer is approve this proposal" }), // Teks pengganti
      proposalId
    ]);
    
    io.emit('proposal-finalized', {
      proposalId,
      status: 'executed',
      txHash: executionResult.txHash
    });
    
  } catch (e) {
    console.error("Execution Error:", e);
    await pool.query(`
      UPDATE proposals SET status = 'failed', execution_result = $1, executed_at = NOW() WHERE proposal_id = $2
    `, [JSON.stringify({ error: e.message, stack: e.stack }), proposalId]);
    
    io.emit('proposal-finalized', { proposalId, status: 'failed', error: e.message });
  }
}

async function executeProposal(proposal) {
  // Reconstruct mnemonic from shares
  const submittedShares = proposal.submitted_shares || {};
  // Susun ulang share berdasarkan urutan AUTHORIZED_DEVS agar sesuai dengan algoritma SSS
  const sharesList = AUTHORIZED_DEVS.map(addr => submittedShares[addr]).filter(Boolean);
  
  if (sharesList.length !== AUTHORIZED_DEVS.length) {
    throw new Error('Not all shares submitted');
  }
  
  const mnemonicHex = secrets.combine(sharesList);
  const mnemonic = Buffer.from(mnemonicHex, 'hex').toString();
  // Validasi tambahan sebelum digunakan
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Critical: Reconstructed mnemonic is invalid. Verification failed.');
  }
  // Execute action based on type
  const actionData = typeof proposal.action_data === 'string' ?
    JSON.parse(proposal.action_data) :
    proposal.action_data;
  
  let result;
  
  switch (proposal.action_type) {
    case 'send':
      result = await executeSend(mnemonic, actionData);
      break;
    case 'send_token':
      result = await executeSendToken(mnemonic, actionData);
      break;
    case 'deploy_token':
      result = await executeDeployToken(mnemonic, actionData);
      break;
    case 'mint_token':
      result = await executeMintToken(mnemonic, actionData);
      break;
    case 'burn_token':
      result = await executeBurnToken(mnemonic, actionData);
      break;
    case 'add_liquidity':
      result = await executeAddLiquidity(mnemonic, actionData);
      break;
    case 'remove_liquidity':
      result = await executeRemoveLiquidity(mnemonic, actionData);
      break;
    case 'update_metadata':
      result = await executeUpdateMetadata(mnemonic, actionData);
      break;
    case 'renounce_minter':
      result = await executeRenounceMinter(mnemonic, actionData);
      break;
    default:
      throw new Error('Unknown action type');
  }
  
  // IMPORTANT: Destroy mnemonic from memory
  // (JavaScript garbage collection will handle this, but explicit clear)
  return result;
}

// ===== EXECUTION FUNCTIONS =====

async function executeSend(mnemonic, data) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "paxi" });
  const [account] = await wallet.getAccounts();
  
  const client = await SigningStargateClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString("0.05upaxi")
  });
  
  const amount = { denom: data.denom || 'upaxi', amount: data.amount };
  const result = await client.sendTokens(account.address, data.recipient, [amount], "auto", data.memo || "");
  
  return { txHash: result.transactionHash, height: result.height };
}

async function executeSendToken(mnemonic, data) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "paxi" });
  const [account] = await wallet.getAccounts();
  const client = await SigningCosmWasmClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString("0.05upaxi")
  });
  
  const msg = {
    transfer: {
      recipient: data.recipient,
      amount: toBaseUnit(data.amount)
    }
  };
  
  const result = await client.execute(account.address, data.contractAddress, msg, "auto");
  
  return { txHash: result.transactionHash };
}

async function executeDeployToken(mnemonic, data) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "paxi" });
  const [account] = await wallet.getAccounts();
  
  const client = await SigningCosmWasmClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString("0.05upaxi")
  });
  
  const totalSupply = (BigInt(data.totalSupply) * BigInt(Math.pow(10, data.decimals || 6))).toString();
  
  const msg = {
    name: data.name,
    symbol: data.symbol,
    decimals: parseInt(data.decimals || 6),
    initial_balances: [{ address: account.address, amount: totalSupply }],
    mint: { minter: account.address },
    marketing: {
      project: data.name,
      description: data.description || "",
      marketing: account.address
    }
  };
  
  if (data.logoUrl) msg.marketing.logo = { url: data.logoUrl };
  
  const codeId = parseInt(process.env.CW20_CODE_ID || 1);
  const result = await client.instantiate(account.address, codeId, msg, data.name, "auto");
  
  return {
    contractAddress: result.contractAddress,
    txHash: result.transactionHash
  };
}

async function executeMintToken(mnemonic, data) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "paxi" });
  const [account] = await wallet.getAccounts();
  
  const client = await SigningCosmWasmClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString("0.05upaxi")
  });
  
  const msg = { mint: { recipient: data.recipient, amount: toBaseUnit(data.amount) } };
  const result = await client.execute(account.address, data.contractAddress, msg, "auto");
  
  return { txHash: result.transactionHash };
}

async function executeBurnToken(mnemonic, data) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "paxi" });
  const [account] = await wallet.getAccounts();
  
  const client = await SigningCosmWasmClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString("0.05upaxi")
  });
  
  const msg = { burn: { amount: toBaseUnit(data.amount) } };
  const result = await client.execute(account.address, data.contractAddress, msg, "auto");
  
  return { txHash: result.transactionHash };
}

// ===== FIX: ADD LIQUIDITY (CW20 SIDE) =====
// ===== EXECUTE ADD LIQUIDITY (Paxi Swap Module) =====
async function executeAddLiquidity(mnemonic, data) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: "paxi",
  });
  const [account] = await wallet.getAccounts();

  const client = await SigningStargateClient.connectWithSigner(
    RPC,
    wallet,
    { gasPrice: GasPrice.fromString("0.05upaxi") }
  );

  const msg = Any.fromPartial({
    typeUrl: "/paxi.swap.v1.MsgAddLiquidity",
    value: Buffer.from(JSON.stringify({
      creator: account.address,
      tokenContract: data.tokenContract,
      paxiAmount: data.paxiAmount,
      tokenAmount: data.tokenAmount,
      slippage: data.slippage || "0.01",
    })),
  });

  const res = await client.signAndBroadcast(
    account.address,
    [msg],
    "auto"
  );

  if (res.code !== 0) {
    throw new Error(res.rawLog);
  }

  return {
    txHash: res.transactionHash,
    height: res.height,
  };
}

async function executeRemoveLiquidity(mnemonic, data) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "paxi" });
  const [account] = await wallet.getAccounts();
  const client = await SigningCosmWasmClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString("0.05upaxi")
  });
  
  // 1. Get LP token address from pair
  const pairQuery = { pool: {} };
  const pairInfo = await client.queryContractSmart(data.pairAddress, pairQuery);
  const lpTokenAddr = pairInfo.lp_token_supply?.address || pairInfo.lp_token_address;
  
  // 2. Get current LP balance
  const balanceQuery = { balance: { address: account.address } };
  const balanceRes = await client.queryContractSmart(lpTokenAddr, balanceQuery);
  const lpBalance = balanceRes.balance;
  
  // 3. Calculate amount based on percentage
  const percent = data.percent || 100;
  const finalAmount = (BigInt(lpBalance) * BigInt(percent) / 100n).toString();
  
  // 4. Execute withdrawal
  const msgRemove = {
    send: {
      contract: data.pairAddress,
      amount: finalAmount,
      msg: btoa(JSON.stringify({ withdraw_liquidity: {} }))
    }
  };
  
  const result = await client.execute(account.address, lpTokenAddr, msgRemove, "auto");
  
  return {
    txHash: result.transactionHash,
    lpWithdrawn: finalAmount,
    percentage: percent
  };
}

async function executeUpdateMetadata(mnemonic, data) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "paxi" });
  const [account] = await wallet.getAccounts();
  
  const client = await SigningCosmWasmClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString("0.05upaxi")
  });
  
  // 1. Update Info Marketing Dasar
  // Catatan: Jika field bernilai null, biasanya kontrak tidak akan mengubah nilai lama.
  const updateMarketingMsg = {
    update_marketing: {
      project: data.project || null,
      description: data.description || null,
      marketing: data.marketing_address || null // Alamat admin marketing
    }
  };
  
  console.log("Sending update_marketing msg:", JSON.stringify(updateMarketingMsg));
  const res1 = await client.execute(account.address, data.contractAddress, updateMarketingMsg, "auto");
  
  // 2. Update Logo (Terpisah)
  // Standar CW20 menggunakan 'upload_logo' yang menerima objek { url: "..." } atau { embedded: { ... } }
  if (data.logoUrl) {
    const uploadLogoMsg = {
      upload_logo: {
        url: data.logoUrl
      }
    };
    console.log("Sending upload_logo msg:", JSON.stringify(uploadLogoMsg));
    await client.execute(account.address, data.contractAddress, uploadLogoMsg, "auto");
  }
  
  return {
    txHash: res1.transactionHash,
    status: "success",
    updatedFields: {
      project: data.project,
      logoUrl: data.logoUrl
    }
  };
}


async function executeRenounceMinter(mnemonic, data) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "paxi" });
  const [account] = await wallet.getAccounts();
  
  const client = await SigningCosmWasmClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString("0.05upaxi")
  });
  
  const msg = { update_minter: { new_minter: null } };
  const result = await client.execute(account.address, data.contractAddress, msg, "auto");
  
  return { txHash: result.transactionHash };
}

// ===== API ENDPOINTS =====

app.post('/api/verify-dev', (req, res) => {
  const { address } = req.body;
  if (!AUTHORIZED_DEVS.includes(address)) {
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }
  const sessionToken = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionToken, { address, timestamp: Date.now() });
  res.json({ success: true, sessionToken, devIndex: AUTHORIZED_DEVS.indexOf(address) + 1 });
});

app.post('/api/wallet-status', async (req, res) => {
  const { sessionToken } = req.body;
  const session = sessions.get(sessionToken);
  if (!session) return res.status(401).json({ success: false, error: 'Session Expired' });
  
  const state = await getState();
  res.json({
    success: true,
    walletGenerated: state.wallet_generated,
    paxiAddress: state.wallet_paxi_address,
    hasClaimed: (state.claimed_by || []).includes(session.address)
  });
});

app.post('/api/wallet-info', async (req, res) => {
  const { sessionToken } = req.body;
  const session = sessions.get(sessionToken);
  if (!session) return res.json({ success: false, error: 'Invalid session' });
  
  const state = await getState();
  
  // LOGIKA DIPERKETAT: Jika paxi_address ada, berarti wallet sudah aktif
  if (!state.wallet_paxi_address) {
    return res.json({ success: false, error: 'Wallet not generated yet' });
  }
  
  const walletAddress = state.wallet_paxi_address;
  
  try {
    // Memastikan fetch menggunakan timeout agar tidak gantung
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const balanceRes = await fetch(`${LCD}/cosmos/bank/v1beta1/balances/${walletAddress}`, { signal: controller.signal });
    const balanceData = await balanceRes.json();
    
    // Gunakan query transfer.recipient DAN transfer.sender untuk history lengkap
    const txRes = await fetch(`${LCD}/cosmos/tx/v1beta1/txs?events=transfer.recipient='${walletAddress}'&order_by=ORDER_BY_DESC&pagination.limit=10`, { signal: controller.signal });
    const txData = await txRes.json();
    
    clearTimeout(timeout);
    
    res.json({
      success: true,
      walletAddress,
      balances: balanceData.balances || [],
      transactions: txData.tx_responses || [], // Paxinet/Cosmos biasanya menggunakan tx_responses
      totalTxs: txData.pagination?.total || 0
    });
  } catch (e) {
    console.error("Blockchain Fetch Error:", e);
    res.json({
      success: true,
      walletAddress,
      balances: [],
      transactions: [],
      fetchError: "Gagal mengambil data dari RPC/LCD Paxinet"
    });
  }
});


app.post('/api/proposals', async (req, res) => {
  const { sessionToken } = req.body;
  const session = sessions.get(sessionToken);
  if (!session) return res.status(401).json({ success: false, error: 'Unauthorized' });
  
  const result = await pool.query(`
    SELECT proposal_id, proposer, action_type, action_data, status, votes, created_at, executed_at
    FROM proposals
    ORDER BY created_at DESC
    LIMIT 50
  `);
  
  res.json({ success: true, proposals: result.rows });
});

app.post('/api/proposal/:id', async (req, res) => {
  const { id } = req.params;
  const { sessionToken } = req.body;
  const session = sessions.get(sessionToken);
  if (!session) return res.status(401).json({ success: false, error: 'Unauthorized' });
  
  const result = await pool.query('SELECT * FROM proposals WHERE proposal_id = $1', [id]);
  if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Not found' });
  
  res.json({ success: true, proposal: result.rows[0] });
});

app.get('/health', (req, res) => res.json({ status: 'OK' }));

// ===== SOCKET.IO =====

io.on('connection', (socket) => {
  
  socket.on('import-share', async (data) => {
    if (!socket.devAddress) return socket.emit('import-failed', 'Not authenticated');
    
    try {
      const { share } = data;
      if (!share) return socket.emit('import-failed', 'Share is empty');
      
      let state = await getState();
      
      // Ambil shares yang sudah ada di database, atau buat objek baru jika kosong
      const currentShares = state.shares || {};
      
      // Simpan share dev ini ke database
      currentShares[socket.devAddress] = share;
      
      // Update database
      await updateState({
        shares: currentShares,
        // Jika dev mengimport, otomatis dia dianggap sudah menyetujui (approvals)
        approvals: Array.from(new Set([...state.approvals, socket.devAddress]))
      });
      
      // Cek apakah dengan import ini, semua share (5/5) sudah terkumpul
      const totalCollected = Object.keys(currentShares).length;
      
      // Ganti bagian di dalam socket.on('import-share')
      if (totalCollected >= AUTHORIZED_DEVS.length && !state.wallet_generated) {
        // JANGAN gunakan Object.values karena urutannya bisa berantakan
        // Susun ulang berdasarkan urutan AUTHORIZED_DEVS yang baku di ENV
        const orderedShares = AUTHORIZED_DEVS.map(addr => currentShares[addr]).filter(Boolean);
        
        if (orderedShares.length === AUTHORIZED_DEVS.length) {
          const mnemonicHex = secrets.combine(orderedShares);
          const mnemonic = Buffer.from(mnemonicHex, 'hex').toString();
          
          // Validasi apakah hasil combine adalah mnemonic yang sah
          if (!bip39.validateMnemonic(mnemonic)) {
            throw new Error('Mnemonic rekonstruksi tidak valid. Pastikan semua share benar.');
          }
          
          const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "paxi" });
          const [account] = await wallet.getAccounts();
          
          // UPDATE DATABASE DENGAN ALAMAT YANG BENAR
          await updateState({
            wallet_generated: true,
            wallet_paxi_address: account.address, // Penting agar API wallet-info tahu alamat mana yang diquery
            updated_at: new Date()
          });
          
          // Beritahu frontend untuk refresh data
          socket.emit('import-success', { address: account.address });
          
        }
      }
      
      
      socket.emit('import-success');
      
      // Update semua orang tentang status terbaru
      const updatedState = await getState();
      io.emit('update-state', {
        approvals: updatedState.approvals,
        totalApprovals: updatedState.approvals.length,
        required: AUTHORIZED_DEVS.length,
        walletGenerated: updatedState.wallet_generated,
        paxiAddress: updatedState.wallet_paxi_address
      });
      
    } catch (e) {
      console.error('Import Error:', e);
      socket.emit('import-failed', 'Invalid share format or error: ' + e.message);
    }
  });
  
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
    let state = await getState();
    if (state.wallet_generated) return socket.emit('error-message', 'Wallet already generated');
    
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
  });
  
  socket.on('request-share', async () => {
    if (!socket.devAddress) return;
    const state = await getState();
    if (!state.wallet_generated) return;
    
    const share = state.shares[socket.devAddress];
    if (!share) return socket.emit('error-message', 'Share not found');
    
    if (!state.claimed_by.includes(socket.devAddress)) {
      await updateState({ claimed_by: [...state.claimed_by, socket.devAddress] });
    }
    
    socket.emit('receive-share', {
      share,
      claimCount: state.claimed_by.length,
      totalDevs: AUTHORIZED_DEVS.length
    });
  });
  
  // GOVERNANCE EVENTS
  socket.on('create-proposal', async (data) => {
    if (!socket.devAddress) return socket.emit('error-message', 'Not authenticated');
    
    try {
      const proposalId = await createProposal(socket.devAddress, data.actionType, data.actionData);
      io.emit('new-proposal', { proposalId, proposer: socket.devAddress, actionType: data.actionType });
      socket.emit('proposal-created', { success: true, proposalId });
    } catch (e) {
      socket.emit('error-message', e.message);
    }
  });
  
  socket.on('vote-proposal', async (data) => {
    if (!socket.devAddress) return socket.emit('error-message', 'Not authenticated');
    
    try {
      const voteResult = await voteProposal(data.proposalId, socket.devAddress, data.vote, data.share);
      io.emit('proposal-voted', { proposalId: data.proposalId, voter: socket.devAddress, vote: data.vote, ...voteResult });
    } catch (e) {
      socket.emit('error-message', e.message);
    }
  });
});

async function generateMultisigWallet() {
  const state = await getState();
  if (state.wallet_generated) return;
  
  const mnemonic = bip39.generateMnemonic(256);
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "paxi" });
  const [account] = await wallet.getAccounts();
  const paxiAddress = account.address;
  
  const mnemonicHex = Buffer.from(mnemonic).toString('hex');
  const sharesList = secrets.share(mnemonicHex, AUTHORIZED_DEVS.length, AUTHORIZED_DEVS.length);
  
  const sharesMap = {};
  AUTHORIZED_DEVS.forEach((addr, i) => { sharesMap[addr] = sharesList[i]; });
  
  await updateState({
    wallet_generated: true,
    wallet_paxi_address: paxiAddress,
    shares: sharesMap,
    generation_timestamp: Date.now()
  });
  
  io.emit('wallet-created', { paxiAddress });
  console.log(`✅ Multisig Wallet: ${paxiAddress}`);
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Governance Server on port ${PORT}`);
  console.log(`👥 Authorized Devs: ${AUTHORIZED_DEVS.length}`);
});
