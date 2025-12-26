// ===== DEPENDENCIES =====
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
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs').promises;
const os = require('os');

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

// ===== CONFIG =====
const AUTHORIZED_DEVS = (process.env.DEV_ADDRESSES || '').split(',').map(a => a.trim()).filter(Boolean);
const RPC = 'https://mainnet-rpc.paxinet.io';
const LCD = 'https://mainnet-lcd.paxinet.io';
const SWAP_MODULE_ADDRESS = "paxi1mfru9azs5nua2wxcd4sq64g5nt7nn4n80r745t";
const CW20_DECIMALS = 6n;
const sessions = new Map();

// ===== HELPER FUNCTIONS =====
function toBaseUnit(amount, decimals = CW20_DECIMALS) {
  if (amount === undefined || amount === null) {
    throw new Error("Amount is required");
  }
  
  const [whole, fraction = ""] = amount.toString().split(".");
  const paddedFraction = fraction.padEnd(Number(decimals), "0").slice(0, Number(decimals));
  
  return BigInt(whole + paddedFraction).toString();
}

async function checkPoolExists(tokenContract) {
  try {
    const response = await fetch(`${LCD}/paxi/swap/pool/${tokenContract}`);
    const data = await response.json();
    
    if (response.ok && data.pool) {
      console.log("✅ Pool exists:", data.pool);
      return true;
    }
    return false;
  } catch (e) {
    console.log("❌ Pool check error:", e.message);
    return false;
  }
}

// ===== DATABASE =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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
        executed_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT NOW(),
        last_voter TEXT
      );
    `);
    
    await client.query(`
      ALTER TABLE wallet_state ADD COLUMN IF NOT EXISTS wallet_paxi_address TEXT;
      ALTER TABLE wallet_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE proposals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
      ALTER TABLE proposals ADD COLUMN IF NOT EXISTS last_voter TEXT;
      
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

// ===== CHECK PAXID CLI =====
async function checkPaxiCLI() {
  try {
    const { stdout } = await execPromise('which paxid');
    const paxidPath = stdout.trim();
    console.log('✅ Paxi CLI Found:', paxidPath);
    
    const { stdout: version } = await execPromise('paxid version');
    console.log('📦 Version:', version.trim());
    
    return true;
  } catch (e) {
    console.error('❌ Paxi CLI Not Found!');
    console.error('Make sure Dockerfile includes paxid installation');
    return false;
  }
}

checkPaxiCLI();

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
    SET votes = $1, 
        submitted_shares = $2, 
        updated_at = NOW(),
        last_voter = $4
    WHERE proposal_id = $3
  `, [JSON.stringify(votes), JSON.stringify(submittedShares), proposalId, voter]);
  
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
    const executionResult = await executeProposal(proposal);
    
    await pool.query(`
      UPDATE proposals 
      SET status = 'executed', 
          execution_result = $1, 
          submitted_shares = $2,
          executed_at = NOW()
      WHERE proposal_id = $3
    `, [
      JSON.stringify(executionResult),
      JSON.stringify({ status: "developer is approve this proposal" }),
      proposalId
    ]);
    
    io.emit('proposal-finalized', {
      proposalId,
      status: 'executed',
      txHash: executionResult.txHash
    });
    
  } catch (e) {
    console.error("Execution Error:", e);
    
    const lastVoter = proposal.last_voter;
    const currentVotes = proposal.votes || {};
    const currentShares = proposal.submitted_shares || {};
    
    if (lastVoter) {
      delete currentVotes[lastVoter];
      delete currentShares[lastVoter];
      console.log(`🔄 Rolling back vote from ${lastVoter}`);
    }
    
    await pool.query(`
      UPDATE proposals 
      SET status = 'pending',
          votes = $1,
          submitted_shares = $2,
          execution_result = $3,
          executed_at = NULL,
          updated_at = NOW()
      WHERE proposal_id = $4
    `, [
      JSON.stringify(currentVotes),
      JSON.stringify(currentShares),
      JSON.stringify({
        error: e.message,
        stack: e.stack,
        rollback_reason: "Execution failed, rolled back to pending"
      }),
      proposalId
    ]);
    
    io.emit('proposal-rollback', {
      proposalId,
      status: 'pending',
      error: e.message,
      rolledBackVoter: lastVoter,
      remainingVotes: Object.keys(currentVotes).length,
      requiredVotes: AUTHORIZED_DEVS.length
    });
  }
}

async function executeProposal(proposal) {
  const submittedShares = proposal.submitted_shares || {};
  const sharesList = AUTHORIZED_DEVS.map(addr => submittedShares[addr]).filter(Boolean);
  
  if (sharesList.length !== AUTHORIZED_DEVS.length) {
    throw new Error('Not all shares submitted');
  }
  
  const mnemonicHex = secrets.combine(sharesList);
  const mnemonic = Buffer.from(mnemonicHex, 'hex').toString();
  
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Critical: Reconstructed mnemonic is invalid. Verification failed.');
  }
  
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

// ===== ADD LIQUIDITY via CLI =====
async function executeAddLiquidity(mnemonic, data) {
  console.log("💧 Adding Liquidity via Paxi CLI...");
  console.log("Token:", data.tokenContract);
  console.log("PAXI Amount:", data.paxiAmount);
  console.log("Token Amount:", data.tokenAmount);
  
  const tmpDir = await fs.mkdtemp(`${os.tmpdir()}/paxi-`);
  const keyName = `multisig_${Date.now()}`;
  
  try {
    const poolExists = await checkPoolExists(data.tokenContract);
    
    if (!poolExists) {
      console.log("⚠️ Pool doesn't exist, will create automatically...");
    }
    
    // Import mnemonic
    console.log("📝 Importing wallet...");
    const importCmd = `echo "${mnemonic}" | paxid keys add ${keyName} --recover --keyring-backend test 2>&1`;
    await execPromise(importCmd, { timeout: 10000 });
    console.log("✅ Wallet imported");
    
    // Increase allowance
    console.log("📝 Increasing allowance...");
    const allowanceCmd = `paxid tx wasm execute ${data.tokenContract} \
      '{"increase_allowance": {
        "spender": "paxi1mfru9azs5nua2wxcd4sq64g5nt7nn4n80r745t",
        "amount": "${data.tokenAmount}"
      }}' \
      --from ${keyName} \
      --keyring-backend test \
      --chain-id paxi-mainnet-1 \
      --node ${RPC} \
      --gas auto \
      --gas-adjustment 1.5 \
      --fees 30000upaxi \
      --yes \
      --output json`;
    
    const { stdout: allowanceOut } = await execPromise(allowanceCmd, { timeout: 30000 });
    const allowanceResult = JSON.parse(allowanceOut);
    
    if (allowanceResult.code && allowanceResult.code !== 0) {
      throw new Error(`Allowance failed: ${allowanceResult.raw_log}`);
    }
    
    console.log("✅ Allowance TX:", allowanceResult.txhash);
    
    // Wait for confirmation
    await new Promise(resolve => setTimeout(resolve, 6000));
    
    // Provide liquidity
    console.log(`💧 ${poolExists ? 'Adding' : 'Creating pool &'} providing liquidity...`);
    const liquidityCmd = `paxid tx swap provide-liquidity \
      --prc20 "${data.tokenContract}" \
      --paxi-amount "${data.paxiAmount}" \
      --prc20-amount "${data.tokenAmount}" \
      --from ${keyName} \
      --keyring-backend test \
      --chain-id paxi-mainnet-1 \
      --node ${RPC} \
      --gas auto \
      --gas-adjustment 1.5 \
      --fees 30000upaxi \
      --yes \
      --output json`;
    
    const { stdout, stderr } = await execPromise(liquidityCmd, { timeout: 30000 });
    
    if (stderr && stderr.includes('error')) {
      throw new Error(`CLI stderr: ${stderr}`);
    }
    
    let result;
    try {
      result = JSON.parse(stdout);
    } catch (parseError) {
      const txHashMatch = stdout.match(/txhash:\s*([A-F0-9]+)/i);
      if (txHashMatch) {
        result = { txhash: txHashMatch[1], code: 0 };
      } else {
        throw new Error(`Cannot parse output: ${stdout}`);
      }
    }
    
    if (result.code && result.code !== 0) {
      throw new Error(`Transaction failed: ${result.raw_log || result.log}`);
    }
    
    console.log(`✅ ${poolExists ? 'Liquidity Added' : 'Pool Created & Liquidity Added'}! TX:`, result.txhash);
    
    // Cleanup
    console.log("🧹 Cleaning up...");
    await execPromise(`paxid keys delete ${keyName} --keyring-backend test --yes 2>&1`);
    await fs.rm(tmpDir, { recursive: true, force: true });
    
    return {
      success: true,
      txHash: result.txhash,
      allowanceTxHash: allowanceResult.txhash,
      height: result.height,
      poolCreated: !poolExists,
      method: "cli"
    };
    
  } catch (error) {
    console.error("❌ Add liquidity failed:", error);
    
    // Cleanup on error
    try {
      await execPromise(`paxid keys delete ${keyName} --keyring-backend test --yes 2>&1`);
    } catch {}
    
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
    
    throw new Error(`Add liquidity failed: ${error.message}`);
  }
}

// ===== WITHDRAW LIQUIDITY via CLI =====
async function executeRemoveLiquidity(mnemonic, data) {
  console.log("🔙 Withdrawing Liquidity via Paxi CLI...");
  console.log("Token:", data.tokenContract);
  console.log("LP Amount:", data.lpAmount);
  
  const tmpDir = await fs.mkdtemp(`${os.tmpdir()}/paxi-`);
  const keyName = `multisig_${Date.now()}`;
  
  try {
    const poolExists = await checkPoolExists(data.tokenContract);
    if (!poolExists) {
      throw new Error("Pool does not exist!");
    }
    
    // Import wallet
    console.log("📝 Importing wallet...");
    const importCmd = `echo "${mnemonic}" | paxid keys add ${keyName} --recover --keyring-backend test 2>&1`;
    await execPromise(importCmd, { timeout: 10000 });
    console.log("✅ Wallet imported");
    
    // Withdraw liquidity
    console.log("💧 Withdrawing liquidity...");
    const withdrawCmd = `paxid tx swap withdraw-liquidity \
      --prc20 "${data.tokenContract}" \
      --lp-amount "${data.lpAmount}" \
      --from ${keyName} \
      --keyring-backend test \
      --chain-id paxi-mainnet-1 \
      --node ${RPC} \
      --gas auto \
      --gas-adjustment 1.5 \
      --fees 30000upaxi \
      --yes \
      --output json`;
    
    const { stdout, stderr } = await execPromise(withdrawCmd, { timeout: 30000 });
    
    if (stderr && stderr.includes('error')) {
      throw new Error(`CLI stderr: ${stderr}`);
    }
    
    let result;
    try {
      result = JSON.parse(stdout);
    } catch (parseError) {
      const txHashMatch = stdout.match(/txhash:\s*([A-F0-9]+)/i);
      if (txHashMatch) {
        result = { txhash: txHashMatch[1], code: 0 };
      } else {
        throw new Error(`Cannot parse output: ${stdout}`);
      }
    }
    
    if (result.code && result.code !== 0) {
      throw new Error(`Transaction failed: ${result.raw_log || result.log}`);
    }
    
    console.log("✅ Liquidity Withdrawn! TX:", result.txhash);
    
    // Cleanup
    console.log("🧹 Cleaning up...");
    await execPromise(`paxid keys delete ${keyName} --keyring-backend test --yes 2>&1`);
    await fs.rm(tmpDir, { recursive: true, force: true });
    
    return {
      success: true,
      txHash: result.txhash,
      lpAmount: data.lpAmount,
      method: "cli"
    };
    
  } catch (error) {
    console.error("❌ Withdraw liquidity failed:", error);
    
    // Cleanup on error
    try {
      await execPromise(`paxid keys delete ${keyName} --keyring-backend test --yes 2>&1`);
    } catch {}
    
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
    
    throw new Error(`Withdraw liquidity failed: ${error.message}`);
  }
}

// ===== ADD LIQUIDITY via CLI =====
async function executeAddLiquidity(mnemonic, data) {
  console.log("💧 Adding Liquidity via Paxi CLI...");
  console.log("Token:", data.tokenContract);
  console.log("PAXI Amount:", data.paxiAmount);
  console.log("Token Amount:", data.tokenAmount);
  
  const tmpDir = await fs.mkdtemp(`${os.tmpdir()}/paxi-`);
  const keyName = `multisig_${Date.now()}`;
  
  try {
    const poolExists = await checkPoolExists(data.tokenContract);
    
    if (!poolExists) {
      console.log("⚠️ Pool doesn't exist, will create automatically...");
    }
    
    // Step 1: Import mnemonic
    console.log("📝 Step 1: Importing wallet...");
    const importCmd = `echo "${mnemonic}" | paxid keys add ${keyName} --recover --keyring-backend test 2>&1`;
    await execPromise(importCmd, { timeout: 10000 });
    console.log("✅ Wallet imported");
    
    // Step 2: Increase allowance via wasm execute
    console.log("📝 Step 2: Increasing allowance...");
    const allowanceCmd = `paxid tx wasm execute ${data.tokenContract} \
      '{"increase_allowance": {
        "spender": "paxi1mfru9azs5nua2wxcd4sq64g5nt7nn4n80r745t",
        "amount": "${data.tokenAmount}"
      }}' \
      --from ${keyName} \
      --keyring-backend test \
      --chain-id paxi-mainnet-1 \
      --node ${RPC} \
      --gas auto \
      --gas-adjustment 1.5 \
      --fees 30000upaxi \
      --yes \
      --output json`;
    
    const { stdout: allowanceOut } = await execPromise(allowanceCmd, { timeout: 30000 });
    const allowanceResult = JSON.parse(allowanceOut);
    
    if (allowanceResult.code && allowanceResult.code !== 0) {
      throw new Error(`Allowance failed: ${allowanceResult.raw_log}`);
    }
    
    console.log("✅ Allowance TX:", allowanceResult.txhash);
    
    // Wait for confirmation
    await new Promise(resolve => setTimeout(resolve, 6000));
    
    // Step 3: Provide liquidity via CLI
    console.log(`💧 Step 3: ${poolExists ? 'Adding' : 'Creating pool &'} providing liquidity...`);
    const liquidityCmd = `paxid tx swap provide-liquidity \
      --prc20 "${data.tokenContract}" \
      --paxi-amount "${data.paxiAmount}" \
      --prc20-amount "${data.tokenAmount}" \
      --from ${keyName} \
      --keyring-backend test \
      --chain-id paxi-mainnet-1 \
      --node ${RPC} \
      --gas auto \
      --gas-adjustment 1.5 \
      --fees 30000upaxi \
      --yes \
      --output json`;
    
    const { stdout, stderr } = await execPromise(liquidityCmd, { timeout: 30000 });
    
    if (stderr && stderr.includes('error')) {
      throw new Error(`CLI stderr: ${stderr}`);
    }
    
    let result;
    try {
      result = JSON.parse(stdout);
    } catch (parseError) {
      const txHashMatch = stdout.match(/txhash:\s*([A-F0-9]+)/i);
      if (txHashMatch) {
        result = { txhash: txHashMatch[1], code: 0 };
      } else {
        throw new Error(`Cannot parse output: ${stdout}`);
      }
    }
    
    if (result.code && result.code !== 0) {
      throw new Error(`Transaction failed: ${result.raw_log || result.log}`);
    }
    
    console.log(`✅ ${poolExists ? 'Liquidity Added' : 'Pool Created & Liquidity Added'}! TX:`, result.txhash);
    
    // Cleanup
    console.log("🧹 Cleaning up...");
    await execPromise(`paxid keys delete ${keyName} --keyring-backend test --yes 2>&1`);
    await fs.rm(tmpDir, { recursive: true, force: true });
    
    return {
      success: true,
      txHash: result.txhash,
      allowanceTxHash: allowanceResult.txhash,
      height: result.height,
      poolCreated: !poolExists,
      method: "cli"
    };
    
  } catch (error) {
    console.error("❌ Add liquidity failed:", error);
    
    // Cleanup on error
    try {
      await execPromise(`paxid keys delete ${keyName} --keyring-backend test --yes 2>&1`);
    } catch {}
    
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
    
    throw new Error(`Add liquidity failed: ${error.message}`);
  }
}

// ===== WITHDRAW LIQUIDITY via CLI =====
async function executeRemoveLiquidity(mnemonic, data) {
  console.log("🔙 Withdrawing Liquidity via Paxi CLI...");
  console.log("Token:", data.tokenContract);
  console.log("LP Amount:", data.lpAmount);
  
  const tmpDir = await fs.mkdtemp(`${os.tmpdir()}/paxi-`);
  const keyName = `multisig_${Date.now()}`;
  
  try {
    const poolExists = await checkPoolExists(data.tokenContract);
    if (!poolExists) {
      throw new Error("Pool does not exist!");
    }
    
    // Step 1: Import wallet
    console.log("📝 Step 1: Importing wallet...");
    const importCmd = `echo "${mnemonic}" | paxid keys add ${keyName} --recover --keyring-backend test 2>&1`;
    await execPromise(importCmd, { timeout: 10000 });
    console.log("✅ Wallet imported");
    
    // Step 2: Withdraw liquidity
    console.log("💧 Step 2: Withdrawing liquidity...");
    const withdrawCmd = `paxid tx swap withdraw-liquidity \
      --prc20 "${data.tokenContract}" \
      --lp-amount "${data.lpAmount}" \
      --from ${keyName} \
      --keyring-backend test \
      --chain-id paxi-mainnet-1 \
      --node ${RPC} \
      --gas auto \
      --gas-adjustment 1.5 \
      --fees 30000upaxi \
      --yes \
      --output json`;
    
    const { stdout, stderr } = await execPromise(withdrawCmd, { timeout: 30000 });
    
    if (stderr && stderr.includes('error')) {
      throw new Error(`CLI stderr: ${stderr}`);
    }
    
    let result;
    try {
      result = JSON.parse(stdout);
    } catch (parseError) {
      const txHashMatch = stdout.match(/txhash:\s*([A-F0-9]+)/i);
      if (txHashMatch) {
        result = { txhash: txHashMatch[1], code: 0 };
      } else {
        throw new Error(`Cannot parse output: ${stdout}`);
      }
    }
    
    if (result.code && result.code !== 0) {
      throw new Error(`Transaction failed: ${result.raw_log || result.log}`);
    }
    
    console.log("✅ Liquidity Withdrawn! TX:", result.txhash);
    
    // Cleanup
    console.log("🧹 Cleaning up...");
    await execPromise(`paxid keys delete ${keyName} --keyring-backend test --yes 2>&1`);
    await fs.rm(tmpDir, { recursive: true, force: true });
    
    return {
      success: true,
      txHash: result.txhash,
      lpAmount: data.lpAmount,
      method: "cli"
    };
    
  } catch (error) {
    console.error("❌ Withdraw liquidity failed:", error);
    
    // Cleanup on error
    try {
      await execPromise(`paxid keys delete ${keyName} --keyring-backend test --yes 2>&1`);
    } catch {}
    
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
    
    throw new Error(`Withdraw liquidity failed: ${error.message}`);
  }
}

async function executeUpdateMetadata(mnemonic, data) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "paxi" });
  const [account] = await wallet.getAccounts();
  
  const client = await SigningCosmWasmClient.connectWithSigner(RPC, wallet, {
    gasPrice: GasPrice.fromString("0.05upaxi")
  });
  
  const updateMarketingMsg = {
    update_marketing: {
      project: data.project || null,
      description: data.description || null,
      marketing: data.marketing_address || null
    }
  };
  
  console.log("Sending update_marketing msg:", JSON.stringify(updateMarketingMsg));
  const res1 = await client.execute(account.address, data.contractAddress, updateMarketingMsg, "auto");
  
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
  
  if (!state.wallet_paxi_address) {
    return res.json({ success: false, error: 'Wallet not generated yet' });
  }
  
  const walletAddress = state.wallet_paxi_address;
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const balanceRes = await fetch(`${LCD}/cosmos/bank/v1beta1/balances/${walletAddress}`, { signal: controller.signal });
    const balanceData = await balanceRes.json();
    
    const txRes = await fetch(`${LCD}/cosmos/tx/v1beta1/txs?events=transfer.recipient='${walletAddress}'&order_by=ORDER_BY_DESC&pagination.limit=10`, { signal: controller.signal });
    const txData = await txRes.json();
    
    clearTimeout(timeout);
    
    res.json({
      success: true,
      walletAddress,
      balances: balanceData.balances || [],
      transactions: txData.tx_responses || [],
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

app.post('/api/pool-info', async (req, res) => {
  const { sessionToken, tokenContract } = req.body;
  const session = sessions.get(sessionToken);
  if (!session) return res.status(401).json({ success: false, error: 'Unauthorized' });
  
  if (!tokenContract) {
    return res.status(400).json({ success: false, error: 'Token contract required' });
  }
  
  try {
    const response = await fetch(`${LCD}/paxi/swap/pool/${tokenContract}`);
    const data = await response.json();
    
    if (response.ok && data.pool) {
      res.json({
        success: true,
        pool: data.pool,
        exists: true
      });
    } else {
      res.json({
        success: false,
        exists: false,
        message: "Pool not found"
      });
    }
  } catch (e) {
    res.json({
      success: false,
      exists: false,
      error: e.message
    });
  }
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
      const currentShares = state.shares || {};
      currentShares[socket.devAddress] = share;
      
      await updateState({
        shares: currentShares,
        approvals: Array.from(new Set([...state.approvals, socket.devAddress]))
      });
      
      const totalCollected = Object.keys(currentShares).length;
      
      if (totalCollected >= AUTHORIZED_DEVS.length && !state.wallet_generated) {
        const orderedShares = AUTHORIZED_DEVS.map(addr => currentShares[addr]).filter(Boolean);
        
        if (orderedShares.length === AUTHORIZED_DEVS.length) {
          const mnemonicHex = secrets.combine(orderedShares);
          const mnemonic = Buffer.from(mnemonicHex, 'hex').toString();
          
          if (!bip39.validateMnemonic(mnemonic)) {
            throw new Error('Mnemonic rekonstruksi tidak valid. Pastikan semua share benar.');
          }
          
          const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "paxi" });
          const [account] = await wallet.getAccounts();
          
          await updateState({
            wallet_generated: true,
            wallet_paxi_address: account.address,
            updated_at: new Date()
          });
          
          socket.emit('import-success', { address: account.address });
        }
      }
      
      socket.emit('import-success');
      
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