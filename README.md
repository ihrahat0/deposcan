# ETH Deposit Monitor and Balance Scanner

## Overview
This project provides tools for monitoring blockchain wallets across multiple chains for:
1. **Real-time deposit detection** - Detect when users receive funds in their wallets
2. **Wallet balance scanning** - Check balances of native tokens and common tokens across all user wallets

Supported chains:
- Ethereum (ETH)
- Binance Smart Chain (BSC)
- Solana (SOL)

The system integrates with Firebase to fetch wallet addresses and store transaction/balance data.

## Setup

### Prerequisites
- Node.js 14+
- Firebase project with Firestore
- Service account key for Firebase (stored as `service-account.json`)

### Installation
```bash
npm install
```

## Running the Deposit Monitor

The deposit monitor tracks incoming transactions to user wallets in real-time:

```bash
# Monitor all supported chains
node monitor.js

# Monitor specific chains
node monitor.js --chain=ethereum
node monitor.js --chain=solana
node monitor.js --chain=ethereum,solana

# Shorthand versions also work
node monitor.js --chain=eth
node monitor.js --chain=sol
node monitor.js --chain=eth,sol

# Or use npm script
npm start
```

### Configuration
The deposit monitor can be configured through environment variables:
- `ETH_RPC_URL` - Ethereum RPC endpoint (defaults to Infura)
- `BSC_RPC_URL` - BSC RPC endpoint (defaults to Binance public RPC)
- `SOLANA_RPC_URL` - Solana RPC endpoint (defaults to Solana Mainnet)
- `FALLBACK_RPC_URLS` - Comma-separated list of fallback RPC URLs

## Enhanced Balance Scanner

The enhanced balance scanner checks all user wallet balances periodically:

```bash
# Scan all supported chains
node enhanced-balance-scanner.js

# Scan specific chains
node enhanced-balance-scanner.js --chain=ethereum
node enhanced-balance-scanner.js --chain=bsc
node enhanced-balance-scanner.js --chain=solana
node enhanced-balance-scanner.js --chain=ethereum,bsc,solana

# Shorthand versions also work
node enhanced-balance-scanner.js --chain=eth
node enhanced-balance-scanner.js --chain=sol

# Or use npm script
npm run scan
```

This will:
1. Fetch all wallet addresses from Firebase
2. Check ETH/BNB/SOL balances for each address (depending on chain selection)
3. Check balances of major tokens (USDT, USDC, DAI, etc.) on all selected chains
4. Check SPL token balances on Solana (if selected)
5. Save results to `enhanced_wallet_balances.json` and Firebase

## Scheduled Balance Checker

For automated balance checking, a scheduler script is provided:

```bash
# Schedule scans for all chains
node scheduled-balance-checker.js

# Schedule scans for specific chains
node scheduled-balance-checker.js --chain=ethereum
node scheduled-balance-checker.js --chain=ethereum,bsc

# Or use npm script
npm run schedule
```

The scheduler:
- Runs the balance scanner at configured intervals (default: every hour)
- Can be set to run at specific times of day
- Maintains logs in the `logs` directory
- Automatically cleans up old log files

### Configuration
Edit the configuration in `scheduled-balance-checker.js`:
```javascript
const config = {
    // How often to run the balance check (in minutes)
    checkIntervalMinutes: 60,
    
    // Specify times to run (24-hour format)
    scheduledTimes: ['00:00', '06:00', '12:00', '18:00'],
    
    // Output directory for logs
    logDir: './logs',
    
    // Keep logs for X days
    keepLogsForDays: 7
};
```

## Firebase Integration

The system requires a specific data structure in Firebase:

1. **walletAddresses** collection:
   - Each document represents a user wallet (document ID = user ID)
   - Contains a `wallets` object with `ethereum`, `bsc`, and `solana` addresses

2. **transactions** collection:
   - Stores deposit records from the monitor
   - Used for tracking transaction history

3. **walletBalances** collection:
   - Stores periodic balance scan results
   - Includes token balances and a summary of non-zero balances

## Services

### Deposit Monitoring Service
- Connects to Ethereum, BSC, and Solana networks
- Monitors for incoming transactions to user wallets
- Filters out zero-value transactions
- Records deposits to Firebase
- Handles network failures with automatic retries

### Balance Scanning Service
- Performs batch scans of all user wallet balances
- Checks for ETH, BNB, SOL, and popular token balances
- Detects SPL tokens on Solana
- Generates detailed reports with non-zero balances highlighted
- Stores historical balance data in Firebase

## Production Deployment

For production use, consider:
- Using a process manager like PM2 to ensure the scripts run continuously
- Setting up monitoring for the services
- Using more reliable RPC providers with higher rate limits 