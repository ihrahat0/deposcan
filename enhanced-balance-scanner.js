const { Web3 } = require('web3');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, AccountLayout } = require('@solana/spl-token');

// Process command line arguments
const args = process.argv.slice(2);
const chainArg = args.find(arg => arg.startsWith('--chain='));
const oneTimeArg = args.find(arg => arg === '--one-time');

// Should this be a one-time scan (used by the web interface)
const isOneTimeScan = !!oneTimeArg;

const chainsToScan = chainArg ? 
    chainArg.replace('--chain=', '').toLowerCase().split(',') : 
    ['ethereum', 'bsc', 'solana'];

// Validate chain arguments
const validChains = ['ethereum', 'eth', 'bsc', 'binance', 'solana', 'sol', 'all'];
const requestedInvalidChains = chainsToScan.filter(chain => !validChains.includes(chain));

if (requestedInvalidChains.length > 0) {
    console.error(`Error: Invalid chain(s) specified: ${requestedInvalidChains.join(', ')}`);
    console.error(`Valid options are: ethereum/eth, bsc/binance, solana/sol, or all`);
    process.exit(1);
}

// Normalize chain names
const normalizedChains = chainsToScan.map(chain => {
    if (chain === 'eth') return 'ethereum';
    if (chain === 'binance') return 'bsc';
    if (chain === 'sol') return 'solana';
    if (chain === 'all') return ['ethereum', 'bsc', 'solana'];
    return chain;
}).flat();

// Remove duplicates
const uniqueChains = [...new Set(normalizedChains)];

// ERC20 ABI (minimal ABI for balance checking)
const ERC20_ABI = [
  {
    "constant": true,
    "inputs": [{"name": "_owner", "type": "address"}],
    "name": "balanceOf",
    "outputs": [{"name": "balance", "type": "uint256"}],
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [],
    "name": "decimals",
    "outputs": [{"name": "", "type": "uint8"}],
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [],
    "name": "symbol",
    "outputs": [{"name": "", "type": "string"}],
    "type": "function"
  }
];

// Popular tokens to check (contract addresses)
const POPULAR_TOKENS = {
  ethereum: [
    { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6 },
    { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6 },
    { address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', decimals: 18 },
    { address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC', decimals: 8 },
    { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18 }
  ],
  bsc: [
    { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18 },
    { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', decimals: 18 },
    { address: '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', symbol: 'DAI', decimals: 18 },
    { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18 },
    { address: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', symbol: 'BTCB', decimals: 18 }
  ],
  solana: [
    { mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
    { mintAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', decimals: 6 },
    { mintAddress: 'So11111111111111111111111111111111111111112', symbol: 'WSOL', decimals: 9 },
    { mintAddress: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', decimals: 9 },
    { mintAddress: '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', symbol: 'stSOL', decimals: 9 }
  ]
};

// Known Solana token metadata
const solanaTokenMetadata = {
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', decimals: 6 },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', decimals: 6 },
  'So11111111111111111111111111111111111111112': { symbol: 'WSOL', decimals: 9 },
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': { symbol: 'mSOL', decimals: 9 },
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': { symbol: 'stSOL', decimals: 9 }
};

// Firebase initialization
try {
    const serviceAccount = require('./service-account.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully');
} catch (error) {
    console.error('Failed to initialize Firebase Admin SDK:', error.message);
    process.exit(1);
}

const db = admin.firestore();

// Configuration 
const config = {
    // Ethereum Mainnet RPC
    ethereumRpcURL: process.env.ETH_RPC_URL || 'https://mainnet.infura.io/v3/b933365d933f41ba9c566a622a2d40e3',
    
    // BSC Mainnet RPC
    bscRpcURL: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/',
    
    // Solana Mainnet RPC
    solanaRpcURL: process.env.SOLANA_RPC_URL || 'https://crimson-sleek-replica.solana-mainnet.quiknode.pro/67a01501974b15a26bcc9567d0ffaf4d66649012',
    
    // Output file for balances
    outputFile: 'enhanced_wallet_balances.json',
    
    // Save results to Firebase
    saveToFirebase: true,
    
    // Firestore collection to store balance results
    balancesCollection: 'walletBalances',
    
    // Batch size for processing
    batchSize: 10,
    
    // Minimum balance (in native token) worth reporting
    minReportBalance: 0.0001,
    
    // Scan interval in milliseconds
    scanInterval: 10 * 60 * 1000 // 10 minutes in milliseconds
};

// Initialize Web3 instances
const ethereumWeb3 = new Web3(config.ethereumRpcURL);
const bscWeb3 = new Web3(config.bscRpcURL);
const solanaConnection = new Connection(config.solanaRpcURL);

// Helper for safely handling BigInt values and converting to number
function fromWei(web3Instance, value, decimals = 18) {
    try {
        if (decimals === 18) {
            const valueStr = typeof value === 'bigint' ? value.toString() : value;
            return web3Instance.utils.fromWei(valueStr, 'ether');
        } else {
            const valueStr = typeof value === 'bigint' ? value.toString() : value;
            return parseFloat(valueStr) / Math.pow(10, decimals);
        }
    } catch (error) {
        console.error('Error in fromWei conversion:', error);
        return '0';
    }
}

// Function to get wallet's native token balance (ETH/BNB)
async function getNativeBalance(address, web3Instance, chain) {
    try {
        const balanceWei = await web3Instance.eth.getBalance(address);
        const balance = parseFloat(fromWei(web3Instance, balanceWei));
        return balance;
    } catch (error) {
        console.error(`Error getting ${chain} balance for ${address}:`, error.message);
        return 0;
    }
}

// Function to get Solana native balance (SOL)
async function getSolanaBalance(address) {
    try {
        const publicKey = new PublicKey(address);
        const balance = await solanaConnection.getBalance(publicKey);
        return balance / LAMPORTS_PER_SOL;
    } catch (error) {
        console.error(`Error getting Solana balance for ${address}:`, error.message);
        return 0;
    }
}

// Function to get a token balance
async function getTokenBalance(address, tokenAddress, web3Instance, decimals) {
    try {
        const tokenContract = new web3Instance.eth.Contract(ERC20_ABI, tokenAddress);
        const balance = await tokenContract.methods.balanceOf(address).call();
        return parseFloat(fromWei(web3Instance, balance, decimals));
    } catch (error) {
        // Silently fail for token balance checks
        return 0;
    }
}

// Function to get Solana SPL token balances
async function getSolanaSPLTokenBalances(walletAddress) {
    const tokenBalances = {};
    try {
        const publicKey = new PublicKey(walletAddress);
        // Find all token accounts owned by this wallet
        const tokenAccounts = await solanaConnection.getParsedTokenAccountsByOwner(
            publicKey,
            { programId: TOKEN_PROGRAM_ID }
        );
        
        for (const { account } of tokenAccounts.value) {
            const parsedAccountInfo = account.data.parsed;
            const info = parsedAccountInfo.info;
            const mintAddress = info.mint;
            const amount = parseFloat(info.tokenAmount.amount) / Math.pow(10, info.tokenAmount.decimals);
            
            // Skip zero balances
            if (amount === 0) continue;
            
            // Use known token metadata or default to mint address
            const tokenInfo = solanaTokenMetadata[mintAddress] || 
                              { symbol: `${mintAddress.slice(0, 4)}...`, decimals: info.tokenAmount.decimals };
            
            tokenBalances[tokenInfo.symbol] = {
                balance: amount,
                tokenMint: mintAddress,
                decimals: tokenInfo.decimals
            };
        }
    } catch (error) {
        console.error(`Error getting Solana token balances for ${walletAddress}:`, error);
    }
    
    return tokenBalances;
}

// Function to validate if a string is a valid Solana address
function isValidSolanaAddress(address) {
    // Check if it's an Ethereum-style address (starts with 0x)
    if (address.startsWith('0x')) {
        return false;
    }
    
    // Basic check for Solana address format (base58 encoding)
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    if (!base58Regex.test(address)) {
        return false;
    }
    
    // Try to create a PublicKey object to validate further
    try {
        new PublicKey(address);
        return true;
    } catch (error) {
        return false;
    }
}

// Function to fetch all wallet addresses from Firebase
async function fetchAllWalletAddresses() {
    // Default return structure
    const result = {
        addresses: {
            ethereum: [],
            bsc: [],
            solana: []
        },
        userMap: {},
        emailMap: {}
    };
    
    if (!config.saveToFirebase) {
        console.log('Firebase integration is disabled. Returning empty address list.');
        return result;
    }
    
    try {
        console.log('Fetching wallet addresses from Firebase...');
        let walletCount = 0;
        
        // First look in walletAddresses collection (preferred)
        console.log('Checking walletAddresses collection...');
        const walletAddressesSnapshot = await db.collection('walletAddresses').get();
        
        if (!walletAddressesSnapshot.empty) {
            console.log(`Found ${walletAddressesSnapshot.size} wallet documents`);
            
            for (const doc of walletAddressesSnapshot.docs) {
                const userId = doc.id;
                const walletData = doc.data();
                
                // Try to get user email
                try {
                    const userDoc = await db.collection('users').doc(userId).get();
                    if (userDoc.exists) {
                        const userData = userDoc.data();
                        const email = userData.email || userData.emailAddress || userData.userEmail;
                        if (email) {
                            result.emailMap[userId] = email;
                            console.log(`Found email for user ${userId}: ${email}`);
                        } else {
                            result.emailMap[userId] = `No email found for ${userId}`;
                            console.log(`No email found for user ${userId}`);
                        }
                    }
                } catch (emailError) {
                    console.warn(`Error fetching email for user ${userId}: ${emailError.message}`);
                    result.emailMap[userId] = `No email found`;
                }
                
                // Process wallets structure if available
                if (walletData && walletData.wallets) {
                    // Ethereum/BSC wallet addresses
                    if (walletData.wallets.ethereum) {
                        const ethAddress = walletData.wallets.ethereum.toLowerCase();
                        result.addresses.ethereum.push(ethAddress);
                        result.userMap[ethAddress] = userId;
                        walletCount++;
                    }
                    
                    // BSC wallet addresses
                    if (walletData.wallets.bsc) {
                        const bscAddress = walletData.wallets.bsc.toLowerCase();
                        result.addresses.bsc.push(bscAddress);
                        result.userMap[bscAddress] = userId;
                        walletCount++;
                    }
                    
                    // Solana wallet addresses
                    if (walletData.wallets.solana) {
                        const solanaAddress = walletData.wallets.solana;
                        if (isValidSolanaAddress(solanaAddress)) {
                            result.addresses.solana.push(solanaAddress);
                            result.userMap[solanaAddress] = userId;
                            walletCount++;
                        } else {
                            console.warn(`Skipping invalid Solana address for user ${userId}: ${solanaAddress}`);
                        }
                    }
                }
            }
        } else {
            console.log('No documents found in walletAddresses collection');
        }
        
        // If no wallets found in walletAddresses collection, try users collection
        if (walletCount === 0) {
            console.log('No wallets found in walletAddresses collection, checking users collection...');
            const usersSnapshot = await db.collection('users').get();
            
            if (!usersSnapshot.empty) {
                console.log(`Found ${usersSnapshot.size} user documents`);
                
                for (const doc of usersSnapshot.docs) {
                    const userId = doc.id;
                    const userData = doc.data();
                    
                    // Save email info
                    const email = userData.email || userData.emailAddress || userData.userEmail;
                    if (email) {
                        result.emailMap[userId] = email;
                    } else {
                        result.emailMap[userId] = `No email found for ${userId}`;
                    }
                    
                    // Process wallets if available
                    if (userData.wallets) {
                        // Ethereum/BSC wallet addresses
                        if (userData.wallets.ethereum) {
                            const ethAddress = userData.wallets.ethereum.toLowerCase();
                            result.addresses.ethereum.push(ethAddress);
                            result.userMap[ethAddress] = userId;
                            walletCount++;
                        }
                        
                        // BSC wallet addresses
                        if (userData.wallets.bsc) {
                            const bscAddress = userData.wallets.bsc.toLowerCase();
                            result.addresses.bsc.push(bscAddress);
                            result.userMap[bscAddress] = userId;
                            walletCount++;
                        }
                        
                        // Solana wallet addresses
                        if (userData.wallets.solana) {
                            const solanaAddress = userData.wallets.solana;
                            if (isValidSolanaAddress(solanaAddress)) {
                                result.addresses.solana.push(solanaAddress);
                                result.userMap[solanaAddress] = userId;
                                walletCount++;
                            } else {
                                console.warn(`Skipping invalid Solana address for user ${userId}: ${solanaAddress}`);
                            }
                        }
                    }
                }
            } else {
                console.log('No documents found in users collection');
            }
        }
        
        // Deduplicate addresses
        result.addresses.ethereum = [...new Set(result.addresses.ethereum)];
        result.addresses.bsc = [...new Set(result.addresses.bsc)];
        result.addresses.solana = [...new Set(result.addresses.solana)];
        
        // Log results
        console.log(`Found ${result.addresses.ethereum.length} Ethereum addresses, ${result.addresses.bsc.length} BSC addresses, and ${result.addresses.solana.length} Solana addresses`);
        console.log(`Found email information for ${Object.keys(result.emailMap).length} users`);
        
        return result;
    } catch (error) {
        console.error('Error fetching wallet addresses:', error);
        return result;
    }
}

// Function to update user's balances in Firestore and track deposits
async function updateUserBalances(userId, balances, chain, userEmail) {
    if (!admin || !admin.firestore || !userId) {
        console.log(`Firebase Admin SDK not initialized or missing userId. Balances not updated for ${chain}.`);
        return;
    }
    
    try {
        // Get a reference to the user's document
        const userDocRef = admin.firestore().collection('users').doc(userId);
        
        // Get the current user data
        const userDoc = await userDocRef.get();
        
        if (userDoc.exists) {
            const userData = userDoc.data();
            const currentBalances = userData.balances || {};
            
            // Track if any balance changed for logging
            let balanceUpdated = false;
            const updatedBalances = {};
            
            // Define a threshold for detecting real balance changes
            // This prevents updates due to minor precision differences
            const threshold = 0.000001;
            
            // Process each token balance
            for (const [token, newBalance] of Object.entries(balances)) {
                // Skip zero balances
                if (parseFloat(newBalance) <= threshold) {
                    continue;
                }
                
                // Standardize token symbol to uppercase
                const tokenSymbol = token.toUpperCase();
                
                // Find the existing balance with case-insensitive key matching
                let existingKey = null;
                let currentBalance = 0;
                
                // Look for existing key in any case variant
                for (const key in currentBalances) {
                    if (key.toUpperCase() === tokenSymbol) {
                        existingKey = key;
                        currentBalance = parseFloat(currentBalances[key]) || 0;
                        break;
                    }
                }
                
                // Determine the key to use for the update
                const balanceKey = existingKey || tokenSymbol;
                
                // Calculate balance difference
                const balanceDiff = parseFloat(newBalance) - currentBalance;
                
                // Update only if the balance has meaningfully changed
                if (Math.abs(balanceDiff) > threshold) {
                    updatedBalances[`balances.${balanceKey}`] = parseFloat(newBalance);
                    balanceUpdated = true;
                    
                    console.log(`[${userId}] ${balanceKey} balance: ${currentBalance} → ${newBalance} (${balanceDiff > 0 ? '+' : ''}${balanceDiff.toFixed(8)})`);
                    
                    // If balance increased or this is a first-time balance, track it as a deposit
                    if (balanceDiff > threshold) {
                        // Always track when balance increases
                        await trackBalanceIncreaseAsDeposit(
                            userId, 
                            chain, 
                            balanceKey, 
                            currentBalance, 
                            newBalance, 
                            balanceDiff,
                            userEmail
                        );
                    }
                }
            }
            
            // Only update Firestore if at least one balance changed
            if (balanceUpdated && Object.keys(updatedBalances).length > 0) {
                await userDocRef.update(updatedBalances);
                console.log(`Updated balances for user ${userId} on ${chain}`);
            } else {
                console.log(`No balance changes detected for user ${userId} on ${chain}`);
            }
        } else {
            console.log(`User document ${userId} not found, cannot update balances`);
        }
    } catch (error) {
        console.error(`Error updating user's balances:`, error);
    }
}

// Function to track balance increases as deposits
async function trackBalanceIncreaseAsDeposit(userId, chain, token, previousBalance, newBalance, amount, userEmail) {
    try {
        console.log(`\n===== BALANCE INCREASE DETECTED =====`);
        console.log(`User: ${userId} (${userEmail || 'No email'})`);
        console.log(`Chain: ${chain}`);
        console.log(`Token: ${token}`);
        console.log(`Previous Balance: ${previousBalance}`);
        console.log(`New Balance: ${newBalance}`);
        console.log(`Increase Amount: ${amount.toFixed(8)}`);
        console.log(`======================================\n`);
        
        // Get the wallet address for this user and chain
        let walletAddress = 'N/A';
        try {
            const userDoc = await admin.firestore().collection('walletAddresses').doc(userId).get();
            if (userDoc.exists) {
                const walletData = userDoc.data();
                if (walletData && walletData.wallets) {
                    if (chain === 'Ethereum') {
                        walletAddress = walletData.wallets.ethereum || 'N/A';
                    } else if (chain === 'BSC') {
                        walletAddress = walletData.wallets.bsc || 'N/A';
                    } else if (chain === 'Solana') {
                        walletAddress = walletData.wallets.solana || 'N/A';
                    }
                }
            }
        } catch (walletError) {
            console.warn(`Could not retrieve wallet address: ${walletError.message}`);
        }
        
        // Create a new entry in the processedDeposits collection
        const depositData = {
            userId,
            userEmail: userEmail || null,
            chain,
            walletAddress: walletAddress,
            amount: amount,
            previousBalance: previousBalance,
            newBalance: newBalance,
            token: token,
            txHash: null, // No transaction hash since this is detected via balance change
            detectedBy: 'balance-scanner',
            processed: true,
            detectedAt: admin.firestore.FieldValue.serverTimestamp(),
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            type: 'balance-increase'
        };
        
        const depositRef = await admin.firestore().collection('processedDeposits').add(depositData);
        
        console.log(`Deposit recorded successfully with ID: ${depositRef.id}`);
        return depositRef.id;
    } catch (error) {
        console.error('Error logging deposit from balance increase:', error);
        return null;
    }
}

// Function to process a batch of wallets
async function processBatch(addresses, chain, web3Instance, userMap, emailMap, startIndex, batchSize) {
    const results = {};
    const endIndex = Math.min(startIndex + batchSize, addresses.length);
    
    console.log(`Processing ${chain} addresses ${startIndex + 1} to ${endIndex} (of ${addresses.length})`);
    
    for (let i = startIndex; i < endIndex; i++) {
        const address = addresses[i];
        const userId = userMap[address] || 'Unknown';
        
        // Get user email with better error handling
        let userEmail = 'No email found';
        if (userId !== 'Unknown') {
            if (emailMap && emailMap[userId]) {
                userEmail = emailMap[userId];
            } else {
                // Try to fetch email directly if not in map
                try {
                    const userDoc = await db.collection('users').doc(userId).get();
                    if (userDoc.exists) {
                        const userData = userDoc.data();
                        userEmail = userData.email || userData.emailAddress || userData.userEmail || 'No email found';
                        // Update email map for future use
                        if (emailMap) emailMap[userId] = userEmail;
                    }
                } catch (emailError) {
                    console.warn(`Could not fetch email for user ${userId}: ${emailError.message}`);
                }
            }
        }
        
        console.log(`Processing ${chain} address: ${address} for user ${userId} (${userEmail})`);
        
        // Get native token balance
        let nativeBalance = 0;
        let tokenBalances = {};
        
        if (chain === 'Solana') {
            nativeBalance = await getSolanaBalance(address);
            
            // Update user's SOL balance in users collection
            if (nativeBalance > 0) {
                await updateUserBalances(userId, { SOL: nativeBalance }, chain, userEmail);
            }
            
            // Check SPL token balances if there's a SOL balance
            if (nativeBalance >= config.minReportBalance) {
                tokenBalances = await getSolanaSPLTokenBalances(address);
                
                // Update user's token balances in users collection
                for (const [symbol, tokenData] of Object.entries(tokenBalances)) {
                    await updateUserBalances(userId, { [symbol]: tokenData.balance }, chain, userEmail);
                }
            }
        } else if (chain === 'Ethereum') {
            nativeBalance = await getNativeBalance(address, web3Instance, chain);
            
            // Update user's ETH balance in users collection
            if (nativeBalance > 0) {
                await updateUserBalances(userId, { ETH: nativeBalance }, chain, userEmail);
            }
            
            // Skip detailed checks if balance is below minimum reporting threshold
            if (nativeBalance >= config.minReportBalance) {
                // Check token balances
                const tokens = POPULAR_TOKENS[chain.toLowerCase()];
                
                for (const token of tokens) {
                    const balance = await getTokenBalance(address, token.address, web3Instance, token.decimals);
                    if (balance > 0) {
                        tokenBalances[token.symbol] = {
                            balance,
                            tokenAddress: token.address,
                            decimals: token.decimals
                        };
                        
                        // Update user's token balance in users collection
                        await updateUserBalances(userId, { [token.symbol]: balance }, chain, userEmail);
                    }
                }
            }
        } else if (chain === 'BSC') {
            nativeBalance = await getNativeBalance(address, web3Instance, chain);
            
            // Update user's BNB balance in users collection
            if (nativeBalance > 0) {
                await updateUserBalances(userId, { BNB: nativeBalance }, chain, userEmail);
            }
            
            // Skip detailed checks if balance is below minimum reporting threshold
            if (nativeBalance >= config.minReportBalance) {
                // Check token balances
                const tokens = POPULAR_TOKENS[chain.toLowerCase()];
                
                for (const token of tokens) {
                    const balance = await getTokenBalance(address, token.address, web3Instance, token.decimals);
                    if (balance > 0) {
                        tokenBalances[token.symbol] = {
                            balance,
                            tokenAddress: token.address,
                            decimals: token.decimals
                        };
                        
                        // Update user's token balance in users collection
                        await updateUserBalances(userId, { [token.symbol]: balance }, chain, userEmail);
                    }
                }
            }
        }
        
        results[address] = {
            userId,
            userEmail,
            nativeBalance,
            tokens: tokenBalances,
            totalValueUSD: 0 // We'll add this later if price API is integrated
        };
    }
    
    return results;
}

// Function to save balances to Firebase
async function saveBalancesToFirebase(ethereumBalances, bscBalances, solanaBalances) {
    if (!config.saveToFirebase) {
        console.log('Firebase integration is disabled. Not saving to Firebase.');
        return false;
    }
    
    try {
        console.log('Saving balance results to Firebase...');
        
        // Save to walletBalances collection in a single document
        const timestamp = new Date();
        const formattedDate = timestamp.toISOString().split('T')[0]; // YYYY-MM-DD format
        
        // Format balances with proper user email info
        const formattedEthereumBalances = {};
        for (const [address, data] of Object.entries(ethereumBalances)) {
            formattedEthereumBalances[address] = {
                ...data,
                lastUpdated: timestamp
            };
        }
        
        const formattedBscBalances = {};
        for (const [address, data] of Object.entries(bscBalances)) {
            formattedBscBalances[address] = {
                ...data,
                lastUpdated: timestamp
            };
        }
        
        const formattedSolanaBalances = {};
        for (const [address, data] of Object.entries(solanaBalances)) {
            formattedSolanaBalances[address] = {
                ...data,
                lastUpdated: timestamp
            };
        }
        
        // Try to get the current data first to preserve chain data that wasn't scanned
        let existingData = {};
        try {
            const latestDoc = await db.collection('walletBalances').doc('latest').get();
            if (latestDoc.exists) {
                existingData = latestDoc.data() || {};
                console.log('Retrieved existing balance data to preserve unscanned chains');
            }
        } catch (readError) {
            console.warn('Could not read existing balance data:', readError.message);
        }
        
        // Create document structure that preserves existing data for chains not scanned
        const balanceData = {
            scanTimestamp: timestamp,
            scanTime: timestamp.toISOString(),
            chainsScanned: uniqueChains,
            // Preserve existing data for chains not in uniqueChains
            ethereumBalances: uniqueChains.includes('ethereum') 
                ? formattedEthereumBalances 
                : (existingData.ethereumBalances || {}),
            bscBalances: uniqueChains.includes('bsc') 
                ? formattedBscBalances 
                : (existingData.bscBalances || {}),
            solanaBalances: uniqueChains.includes('solana') 
                ? formattedSolanaBalances 
                : (existingData.solanaBalances || {}),
            summary: {
                ethereumAddressCount: uniqueChains.includes('ethereum') 
                    ? Object.keys(formattedEthereumBalances).length 
                    : (existingData.summary?.ethereumAddressCount || 0),
                bscAddressCount: uniqueChains.includes('bsc') 
                    ? Object.keys(formattedBscBalances).length 
                    : (existingData.summary?.bscAddressCount || 0),
                solanaAddressCount: uniqueChains.includes('solana') 
                    ? Object.keys(formattedSolanaBalances).length 
                    : (existingData.summary?.solanaAddressCount || 0),
                nonZeroEthereumCount: uniqueChains.includes('ethereum') 
                    ? Object.values(formattedEthereumBalances).filter(data => data.nativeBalance > 0).length 
                    : (existingData.summary?.nonZeroEthereumCount || 0),
                nonZeroBscCount: uniqueChains.includes('bsc') 
                    ? Object.values(formattedBscBalances).filter(data => data.nativeBalance > 0).length 
                    : (existingData.summary?.nonZeroBscCount || 0),
                nonZeroSolanaCount: uniqueChains.includes('solana') 
                    ? Object.values(formattedSolanaBalances).filter(data => data.nativeBalance > 0).length 
                    : (existingData.summary?.nonZeroSolanaCount || 0)
            }
        };
        
        // Save to a fixed document in walletBalances collection
        await db.collection('walletBalances').doc('latest').set(balanceData);
        
        // Also save to a dated document for historical records
        await db.collection('walletBalances').doc(`scan_${formattedDate}_${Date.now()}`).set(balanceData);
        
        console.log('Balance data saved to Firebase successfully');
        return true;
    } catch (error) {
        console.error('Error saving balances to Firebase:', error);
        return false;
    }
}

// Main function to scan balances
async function scanWalletBalances() {
    console.log('=======================================================');
    console.log('ENHANCED WALLET BALANCE SCANNER');
    console.log('=======================================================');
    console.log(`Chains to scan: ${uniqueChains.join(', ')}`);
    console.log('=======================================================');
    
    try {
        // Fetch wallet addresses from Firebase
        const { addresses, userMap, emailMap } = await fetchAllWalletAddresses();
        
        let noAddressesToScan = true;
        uniqueChains.forEach(chain => {
            if (addresses[chain] && addresses[chain].length > 0) {
                noAddressesToScan = false;
            }
        });
        
        if (noAddressesToScan) {
            console.log('No wallet addresses found to scan for the specified chains');
            return;
        }
        
        // Summary counts for requested chains only
        const chainCounts = uniqueChains.map(chain => 
            `${addresses[chain] ? addresses[chain].length : 0} ${chain.charAt(0).toUpperCase() + chain.slice(1)} addresses`
        ).join(', ');
        console.log(`Found ${chainCounts}`);
        
        // Process Ethereum addresses in batches
        const ethereumBalances = {};
        if (uniqueChains.includes('ethereum') && addresses.ethereum.length > 0) {
            console.log('=======================================================');
            console.log('Scanning Ethereum balances...');
            
            for (let i = 0; i < addresses.ethereum.length; i += config.batchSize) {
                const batchResults = await processBatch(
                    addresses.ethereum,
                    'Ethereum',
                    ethereumWeb3,
                    userMap,
                    emailMap,
                    i,
                    config.batchSize
                );
                Object.assign(ethereumBalances, batchResults);
            }
        }
        
        // Process BSC addresses in batches
        const bscBalances = {};
        if (uniqueChains.includes('bsc') && addresses.bsc.length > 0) {
            console.log('=======================================================');
            console.log('Scanning BSC balances...');
            
            for (let i = 0; i < addresses.bsc.length; i += config.batchSize) {
                const batchResults = await processBatch(
                    addresses.bsc,
                    'BSC',
                    bscWeb3,
                    userMap,
                    emailMap,
                    i,
                    config.batchSize
                );
                Object.assign(bscBalances, batchResults);
            }
        }
        
        // Process Solana addresses in batches
        const solanaBalances = {};
        if (uniqueChains.includes('solana') && addresses.solana.length > 0) {
            console.log('=======================================================');
            console.log('Scanning Solana balances...');
            
            for (let i = 0; i < addresses.solana.length; i += config.batchSize) {
                const batchResults = await processBatch(
                    addresses.solana,
                    'Solana',
                    null, // No web3 instance needed for Solana
                    userMap,
                    emailMap,
                    i,
                    config.batchSize
                );
                Object.assign(solanaBalances, batchResults);
            }
        }
        
        // Try to read existing data from file
        let existingReport = {};
        try {
            if (fs.existsSync(config.outputFile)) {
                const existingData = fs.readFileSync(config.outputFile, 'utf8');
                existingReport = JSON.parse(existingData);
                console.log(`Read existing data from ${config.outputFile} to preserve unscanned chain data`);
            }
        } catch (readError) {
            console.warn(`Could not read existing data from ${config.outputFile}:`, readError.message);
        }
        
        // Prepare report, preserving data for chains that weren't scanned
        const report = {
            scanTime: new Date().toISOString(),
            chainsScanned: uniqueChains,
            ethereumBalances: uniqueChains.includes('ethereum') 
                ? ethereumBalances 
                : (existingReport.ethereumBalances || {}),
            bscBalances: uniqueChains.includes('bsc') 
                ? bscBalances 
                : (existingReport.bscBalances || {}),
            solanaBalances: uniqueChains.includes('solana') 
                ? solanaBalances 
                : (existingReport.solanaBalances || {}),
            summary: {
                ethereumAddressCount: uniqueChains.includes('ethereum') 
                    ? (addresses.ethereum ? addresses.ethereum.length : 0)
                    : (existingReport.summary?.ethereumAddressCount || 0),
                bscAddressCount: uniqueChains.includes('bsc') 
                    ? (addresses.bsc ? addresses.bsc.length : 0)
                    : (existingReport.summary?.bscAddressCount || 0),
                solanaAddressCount: uniqueChains.includes('solana') 
                    ? (addresses.solana ? addresses.solana.length : 0)
                    : (existingReport.summary?.solanaAddressCount || 0),
                nonZeroEthereumCount: uniqueChains.includes('ethereum') 
                    ? Object.values(ethereumBalances).filter(data => data.nativeBalance > 0).length
                    : (existingReport.summary?.nonZeroEthereumCount || 0),
                nonZeroBscCount: uniqueChains.includes('bsc') 
                    ? Object.values(bscBalances).filter(data => data.nativeBalance > 0).length
                    : (existingReport.summary?.nonZeroBscCount || 0),
                nonZeroSolanaCount: uniqueChains.includes('solana') 
                    ? Object.values(solanaBalances).filter(data => data.nativeBalance > 0).length
                    : (existingReport.summary?.nonZeroSolanaCount || 0)
            }
        };
        
        // Save to file
        fs.writeFileSync(config.outputFile, JSON.stringify(report, null, 2));
        console.log(`Saved scan results to ${config.outputFile}`);
        
        // Save to Firebase
        if (config.saveToFirebase) {
            await saveBalancesToFirebase(
                uniqueChains.includes('ethereum') ? ethereumBalances : {},
                uniqueChains.includes('bsc') ? bscBalances : {},
                uniqueChains.includes('solana') ? solanaBalances : {}
            );
        }
        
        // Display summary
        console.log('=======================================================');
        console.log('BALANCE SCAN COMPLETE');
        console.log('=======================================================');
        
        if (uniqueChains.includes('ethereum')) {
            const nonZeroEthCount = Object.values(ethereumBalances).filter(data => data.nativeBalance > 0).length;
            console.log(`Found ${nonZeroEthCount} of ${addresses.ethereum.length} Ethereum addresses with non-zero ETH balance`);
        }
        
        if (uniqueChains.includes('bsc')) {
            const nonZeroBscCount = Object.values(bscBalances).filter(data => data.nativeBalance > 0).length;
            console.log(`Found ${nonZeroBscCount} of ${addresses.bsc.length} BSC addresses with non-zero BNB balance`);
        }
        
        if (uniqueChains.includes('solana')) {
            const nonZeroSolCount = Object.values(solanaBalances).filter(data => data.nativeBalance > 0).length;
            console.log(`Found ${nonZeroSolCount} of ${addresses.solana.length} Solana addresses with non-zero SOL balance`);
        }
        
        console.log('=======================================================');
        console.log('NON-ZERO BALANCES:');
        console.log('=======================================================');
        
        // Display Ethereum non-zero balances with token details
        let ethWithTokens = 0;
        if (uniqueChains.includes('ethereum') && Object.keys(ethereumBalances).length > 0) {
            console.log('ETHEREUM:');
            
            const nonZeroEthAddresses = Object.entries(ethereumBalances)
                .filter(([_, data]) => data.nativeBalance > 0);
                
            if (nonZeroEthAddresses.length > 0) {
                for (const [address, data] of nonZeroEthAddresses) {
                    console.log(`- User: ${data.userId}`);
                    console.log(`  Address: ${address}`);
                    console.log(`  ETH Balance: ${data.nativeBalance.toFixed(6)}`);
                    
                    // Display token balances
                    const tokenBalances = data.tokens;
                    if (Object.keys(tokenBalances).length > 0) {
                        console.log(`  Tokens:`);
                        for (const [symbol, tokenData] of Object.entries(tokenBalances)) {
                            console.log(`    ${symbol}: ${tokenData.balance.toFixed(6)}`);
                        }
                        ethWithTokens++;
                    }
                    console.log('');
                }
            } else {
                console.log('  No addresses with non-zero ETH balance found');
            }
        }
        
        // Display BSC non-zero balances with token details
        let bscWithTokens = 0;
        if (uniqueChains.includes('bsc') && Object.keys(bscBalances).length > 0) {
            console.log('\nBSC:');
            
            const nonZeroBscAddresses = Object.entries(bscBalances)
                .filter(([_, data]) => data.nativeBalance > 0);
                
            if (nonZeroBscAddresses.length > 0) {
                for (const [address, data] of nonZeroBscAddresses) {
                    console.log(`- User: ${data.userId}`);
                    console.log(`  Address: ${address}`);
                    console.log(`  BNB Balance: ${data.nativeBalance.toFixed(6)}`);
                    
                    // Display token balances
                    const tokenBalances = data.tokens;
                    if (Object.keys(tokenBalances).length > 0) {
                        console.log(`  Tokens:`);
                        for (const [symbol, tokenData] of Object.entries(tokenBalances)) {
                            console.log(`    ${symbol}: ${tokenData.balance.toFixed(6)}`);
                        }
                        bscWithTokens++;
                    }
                    console.log('');
                }
            } else {
                console.log('  No addresses with non-zero BNB balance found');
            }
        }
        
        // Display Solana non-zero balances with token details
        let solWithTokens = 0;
        if (uniqueChains.includes('solana') && Object.keys(solanaBalances).length > 0) {
            console.log('\nSOLANA:');
            
            const nonZeroSolAddresses = Object.entries(solanaBalances)
                .filter(([_, data]) => data.nativeBalance > 0);
                
            if (nonZeroSolAddresses.length > 0) {
                for (const [address, data] of nonZeroSolAddresses) {
                    console.log(`- User: ${data.userId}`);
                    console.log(`  Address: ${address}`);
                    console.log(`  SOL Balance: ${data.nativeBalance.toFixed(6)}`);
                    
                    // Display token balances
                    const tokenBalances = data.tokens;
                    if (Object.keys(tokenBalances).length > 0) {
                        console.log(`  Tokens:`);
                        for (const [symbol, tokenData] of Object.entries(tokenBalances)) {
                            console.log(`    ${symbol}: ${tokenData.balance.toFixed(6)}`);
                        }
                        solWithTokens++;
                    }
                    console.log('');
                }
            } else {
                console.log('  No addresses with non-zero SOL balance found');
            }
        }
        
        console.log('=======================================================');
        if (uniqueChains.includes('ethereum')) {
            console.log(`${ethWithTokens} Ethereum addresses have token balances`);
        }
        if (uniqueChains.includes('bsc')) {
            console.log(`${bscWithTokens} BSC addresses have token balances`);
        }
        if (uniqueChains.includes('solana')) {
            console.log(`${solWithTokens} Solana addresses have token balances`);
        }
        console.log('=======================================================');
        console.log(`Full report saved to ${config.outputFile}`);
        
    } catch (error) {
        console.error('Error scanning wallet balances:', error);
        throw error; // Rethrow to handle in one-time mode
    }
}

// Function to start the periodic scanning
function startPeriodicScanning() {
    if (isOneTimeScan) {
        console.log('Running in one-time scan mode');
        scanWalletBalances()
            .then(() => {
                console.log('One-time scan completed');
                process.exit(0);
            })
            .catch(err => {
                console.error('Error during one-time scan:', err);
                process.exit(1);
            });
        return;
    }
    
    console.log(`Starting periodic balance scanning every ${config.scanInterval / 60000} minutes`);
    
    // Run the first scan immediately
    scanWalletBalances();
    
    // Then set up interval for subsequent scans
    setInterval(scanWalletBalances, config.scanInterval);
    
    // Handle process termination
    process.on('SIGINT', () => {
        console.log('\nBalance scanning service terminated');
        process.exit(0);
    });
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
        console.error('Uncaught exception:', error);
        // Continue running despite errors
    });
    
    // Handle unhandled promise rejections
    process.on('unhandledRejection', (error) => {
        console.error('Unhandled promise rejection:', error);
        // Continue running despite errors
    });
}

// Run the scanner as a service instead of a one-time operation
startPeriodicScanning();

// Comment out the direct call to scanWalletBalances that exits after completion
// scanWalletBalances(); 