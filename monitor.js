const { Web3 } = require('web3');
const fs = require('fs');
const { Connection, PublicKey } = require('@solana/web3.js');
let admin;
let db;

// Try to load Firebase Admin, but continue even if it fails
try {
    admin = require('firebase-admin');
    const serviceAccount = require('./service-account.json');

    // Initialize Firebase Admin
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });

    // Get Firestore database
    db = admin.firestore();
    console.log('Firebase Admin SDK initialized successfully');
} catch (error) {
    console.warn('Failed to initialize Firebase Admin SDK:', error.message);
    console.warn('Will run in standalone mode with predefined wallet addresses');
}

// Configuration
const config = {
    // HTTP URL for minimal API calls (can be overridden by environment variables)
    httpRpcURL: process.env.ETH_RPC_URL || 'https://mainnet.infura.io/v3/b933365d933f41ba9c566a622a2d40e3',
    
    // Alternative RPC URLs (comma-separated) for fallback
    fallbackRpcUrls: (process.env.FALLBACK_RPC_URLS || '').split(',').filter(url => url),
    
    // Solana RPC URL
    solanaRpcURL: process.env.SOLANA_RPC_URL || 'https://crimson-sleek-replica.solana-mainnet.quiknode.pro/67a01501974b15a26bcc9567d0ffaf4d66649012',
    
    // Wallet addresses to monitor (will be populated from Firebase or defaults)
    walletAddresses: [],
    
    // Save transaction history to file
    saveToFile: true,
    historyFile: 'deposit_history.json',
    
    // Minimum ETH value to log (set to small non-zero value to ignore dust)
    minValueETH: 0.000001, // Ignore transactions less than 0.000001 ETH
    minValueSOL: 0.000001, // Ignore transactions less than 0.000001 SOL
    
    // Polling interval in milliseconds
    pollingInterval: 15000, // 15 seconds
    
    // Maximum retries for connection
    maxRetries: 5,
    
    // Delay between retries (in milliseconds)
    retryDelay: 5000, // 5 seconds

    // How often to refresh wallet addresses from Firebase (in milliseconds)
    walletRefreshInterval: 300000, // 5 minutes
    
    // Whether Firebase integration is enabled
    firebaseEnabled: !!admin && !!db
};

// Initialize Web3
let web3;
let isConnected = false;
let retryCount = 0;
let currentRpcUrlIndex = 0;
const allRpcUrls = [config.httpRpcURL, ...config.fallbackRpcUrls];

// Initialize Solana connection
let solanaConnection = new Connection(config.solanaRpcURL);
let solanaConnected = false;
let solanaRetryCount = 0;

// Store transaction history
let transactionHistory = [];
let latestBlockNumber = 0;
let latestSolanaSlot = 0;
let monitoringInterval = null;
let walletRefreshInterval = null;
let monitoredAddresses = {
    ethereum: [],
    solana: []
};

// Map to track which addresses belong to which users
const addressToUserMap = {};

// Process command line arguments
const args = process.argv.slice(2);
const chainArg = args.find(arg => arg.startsWith('--chain='));
const chainsToMonitor = chainArg ? 
    chainArg.replace('--chain=', '').toLowerCase().split(',') : 
    ['ethereum', 'solana'];

// Validate chain arguments
const validChains = ['ethereum', 'eth', 'solana', 'sol', 'all'];
const requestedInvalidChains = chainsToMonitor.filter(chain => !validChains.includes(chain));

if (requestedInvalidChains.length > 0) {
    console.error(`Error: Invalid chain(s) specified: ${requestedInvalidChains.join(', ')}`);
    console.error(`Valid options are: ethereum/eth, solana/sol, or all`);
    process.exit(1);
}

// Normalize chain names
const normalizedChains = chainsToMonitor.map(chain => {
    if (chain === 'eth') return 'ethereum';
    if (chain === 'sol') return 'solana';
    if (chain === 'all') return ['ethereum', 'solana'];
    return chain;
}).flat();

// Remove duplicates
const uniqueChains = [...new Set(normalizedChains)];

// Helper functions to safely handle BigInt values
function safeBigInt(value) {
    return typeof value === 'bigint' ? Number(value) : value;
}

function fromWei(value) {
    const valueStr = typeof value === 'bigint' ? value.toString() : value;
    return web3.utils.fromWei(valueStr, 'ether');
}

// Save transaction history to file
function saveTransactionHistory() {
    if (config.saveToFile) {
        try {
            const serializableHistory = transactionHistory.map(tx => {
                const txCopy = { ...tx };
                for (const key in txCopy) {
                    if (typeof txCopy[key] === 'bigint') {
                        txCopy[key] = txCopy[key].toString();
                    }
                }
                return txCopy;
            });
            fs.writeFileSync(config.historyFile, JSON.stringify(serializableHistory, null, 2));
        } catch (error) {
            console.error(`Error saving transaction history: ${error.message}`);
        }
    }
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

// Function to fetch wallet addresses from Firebase
async function fetchWalletAddresses() {
    if (!config.firebaseEnabled) {
        console.log('Firebase integration is disabled. No addresses will be monitored.');
        monitoredAddresses.ethereum = [];
        monitoredAddresses.solana = [];
        return;
    }
    
    try {
        console.log('Fetching wallet addresses from Firebase...');
        
        // Initialize collections to check
        const newAddresses = {
            ethereum: [],
            solana: []
        };
        const newAddressMap = {};
        let foundAddresses = false;
        
        // FIRST APPROACH: Check walletAddresses collection directly
        console.log('Checking walletAddresses collection...');
        const walletAddressesRef = db.collection('walletAddresses');
        console.log(`Querying collection: ${walletAddressesRef.path}`);
        
        try {
            const walletSnapshot = await walletAddressesRef.get();
            console.log(`walletAddresses query returned: ${walletSnapshot.size} documents`);
            
            if (!walletSnapshot.empty) {
                console.log(`Found ${walletSnapshot.size} entries in walletAddresses collection`);
                
                walletSnapshot.forEach(doc => {
                    console.log(`Processing walletAddress document: ${doc.id}`);
                    const walletData = doc.data();
                    
                    // Check for the wallets structure we discovered in our test
                    if (walletData && walletData.wallets) {
                        const userId = doc.id;
                        console.log(`Found wallets field for user ${userId}`);
                        
                        // Extract Ethereum address (and BSC since they're often the same)
                        if (walletData.wallets.ethereum) {
                            const ethAddress = walletData.wallets.ethereum.toLowerCase();
                            console.log(`Found Ethereum wallet for user ${userId}: ${ethAddress}`);
                            newAddresses.ethereum.push(ethAddress);
                            newAddressMap[ethAddress] = { userId, chain: 'Ethereum' };
                            foundAddresses = true;
                        }
                        
                        // Extract BSC address
                        if (walletData.wallets.bsc) {
                            const bscAddress = walletData.wallets.bsc.toLowerCase();
                            console.log(`Found BSC wallet for user ${userId}: ${bscAddress}`);
                            newAddresses.ethereum.push(bscAddress); // Also monitor BSC addresses on Ethereum
                            newAddressMap[bscAddress] = { userId, chain: 'BSC' };
                            foundAddresses = true;
                        }
                        
                        // Extract Solana address with validation
                        if (walletData.wallets.solana) {
                            const solanaAddress = walletData.wallets.solana;
                            if (isValidSolanaAddress(solanaAddress)) {
                                console.log(`Found Solana wallet for user ${userId}: ${solanaAddress}`);
                                newAddresses.solana.push(solanaAddress);
                                newAddressMap[solanaAddress] = { userId, chain: 'Solana' };
                                foundAddresses = true;
                            } else {
                                console.warn(`Invalid Solana address for user ${userId}: ${solanaAddress} - Skipping this address`);
                            }
                        }
                    } else {
                        console.log(`Document ${doc.id} doesn't have expected wallets structure`);
                    }
                });
            } else {
                console.log('walletAddresses collection is empty or does not exist');
            }
        } catch (error) {
            console.error(`Error querying walletAddresses collection: ${error.message}`);
        }
        
        // SECOND APPROACH: Check users collection for wallet structure if needed
        if (!foundAddresses) {
            console.log('No addresses found in walletAddresses collection, checking users collection...');
            
            const usersRef = db.collection('users');
            console.log(`Querying collection: ${usersRef.path}`);
            
            try {
                const usersSnapshot = await usersRef.get();
                console.log(`Found ${usersSnapshot.size} users in Firebase`);
                
                if (!usersSnapshot.empty) {
                    usersSnapshot.forEach(doc => {
                        const userData = doc.data();
                        const userId = doc.id;
                        
                        console.log(`Processing user ${userId}`);
                        
                        // Check for wallets field
                        if (userData.wallets) {
                            console.log(`User ${userId} has wallets field`);
                            
                            // Extract BSC wallet address
                            if (userData.wallets.bsc) {
                                const bscAddress = userData.wallets.bsc.toLowerCase();
                                console.log(`Found BSC wallet for user ${userId}: ${bscAddress}`);
                                newAddresses.ethereum.push(bscAddress);
                                newAddressMap[bscAddress] = { userId, chain: 'BSC' };
                                foundAddresses = true;
                            }
                            
                            // Extract Ethereum wallet address
                            if (userData.wallets.ethereum) {
                                const ethAddress = userData.wallets.ethereum.toLowerCase();
                                console.log(`Found Ethereum wallet for user ${userId}: ${ethAddress}`);
                                newAddresses.ethereum.push(ethAddress);
                                newAddressMap[ethAddress] = { userId, chain: 'Ethereum' };
                                foundAddresses = true;
                            }
                            
                            // Extract Solana address with validation
                            if (userData.wallets.solana) {
                                const solanaAddress = userData.wallets.solana;
                                if (isValidSolanaAddress(solanaAddress)) {
                                    console.log(`Found Solana wallet for user ${userId}: ${solanaAddress}`);
                                    newAddresses.solana.push(solanaAddress);
                                    newAddressMap[solanaAddress] = { userId, chain: 'Solana' };
                                    foundAddresses = true;
                                } else {
                                    console.warn(`Invalid Solana address for user ${userId}: ${solanaAddress} - Skipping this address`);
                                }
                            }
                        }
                    });
                }
            } catch (error) {
                console.error(`Error querying users collection: ${error.message}`);
            }
        }
        
        // Log results and update monitoring list
        if (foundAddresses) {
            // Update the monitored addresses
            config.walletAddresses = [...new Set([...newAddresses.ethereum, ...newAddresses.solana])]; // All unique addresses
            
            // Update the address map
            Object.assign(addressToUserMap, newAddressMap);
            
            console.log(`Found ${newAddresses.ethereum.length} Ethereum/BSC addresses and ${newAddresses.solana.length} Solana addresses to monitor`);
            
            // Convert addresses to lowercase for case-insensitive comparison
            monitoredAddresses.ethereum = newAddresses.ethereum.map(addr => addr.toLowerCase());
            monitoredAddresses.solana = newAddresses.solana;
            
            console.log(`Monitoring ${monitoredAddresses.ethereum.length} Ethereum/BSC addresses and ${monitoredAddresses.solana.length} Solana addresses`);
        } else {
            console.log('No wallet addresses found in any collection');
            
            // No addresses found, clear the addresses list
            config.walletAddresses = [];
            monitoredAddresses.ethereum = [];
            monitoredAddresses.solana = [];
            console.log('No addresses will be monitored until wallet addresses are added to Firebase');
        }
        
    } catch (error) {
        console.error('Error fetching wallet addresses from Firebase:', error);
        
        // Clear addresses on failure to prevent monitoring hardcoded addresses
        config.walletAddresses = [];
        monitoredAddresses.ethereum = [];
        monitoredAddresses.solana = [];
        console.log('No addresses will be monitored due to Firebase error');
    }
}

// Function to update user's balances in Firestore
async function updateUserBalance(userId, chain, amount, symbol) {
    if (!config.firebaseEnabled || !userId || userId === 'Unknown') {
        console.log('Firebase integration is disabled or unknown user. Balance not updated.');
        return;
    }
    
    try {
        // Get a reference to the user's document in the users collection
        const userDocRef = db.collection('users').doc(userId);
        
        // Get the current user data
        const userDoc = await userDocRef.get();
        
        // Determine which symbol to update based on chain
        let tokenSymbol = symbol;
        if (!tokenSymbol) {
            // Default to native tokens if symbol not specified
            if (chain === 'Ethereum') tokenSymbol = 'ETH';
            else if (chain === 'BSC') tokenSymbol = 'BNB';
            else if (chain === 'Solana') tokenSymbol = 'SOL';
            else tokenSymbol = 'UNKNOWN';
        }
        
        tokenSymbol = tokenSymbol.toUpperCase();
        
        if (userDoc.exists) {
            // Document exists, get current balance and add the new amount
            const userData = userDoc.data();
            const balances = userData.balances || {};
            
            // Check for existing key with any case variant
            let existingKey = null;
            let currentBalance = 0;
            
            // Look for the token in any case variant
            for (const key in balances) {
                if (key.toUpperCase() === tokenSymbol) {
                    existingKey = key;
                    currentBalance = balances[key] || 0;
                    break;
                }
            }
            
            // If no existing key was found, use the tokenSymbol as is
            const updateKey = existingKey || tokenSymbol;
            
            // Calculate new balance by adding the deposit amount
            const newBalance = parseFloat(currentBalance) + parseFloat(amount);
            
            // Prepare update data that only changes this specific token balance
            const updateData = {};
            updateData[`balances.${updateKey}`] = newBalance;
            
            // Update only this specific balance field
            await userDocRef.update(updateData);
            console.log(`Updated ${userId}'s ${updateKey} balance: ${currentBalance} + ${amount} = ${newBalance}`);
        } else {
            console.log(`User document ${userId} not found, cannot update balances`);
        }
    } catch (error) {
        console.error(`Error updating user's balances:`, error);
    }
}

// Function to save deposit to Firebase
async function saveDepositToFirebase(deposit) {
    if (!config.firebaseEnabled) {
        console.log('Firebase integration is disabled. Deposit not saved to Firebase.');
        return;
    }
    
    try {
        const { to, from, valueETH, valueSOL, hash, blockNumber, userId, chain, timestamp } = deposit;
        
        // Create a new entry in the processedDeposits collection
        await db.collection('processedDeposits').add({
            userId,
            chain,
            walletAddress: to,
            fromAddress: from,
            amount: valueETH || valueSOL,
            txHash: hash,
            blockNumber,
            processed: false,
            detectedAt: admin.firestore.FieldValue.serverTimestamp(),
            transactionTime: timestamp ? new Date(timestamp) : null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Also update the user's balances in the users collection
        if (valueETH) {
            await updateUserBalance(userId, chain, valueETH, 'eth');
        } else if (valueSOL) {
            await updateUserBalance(userId, chain, valueSOL, 'sol');
        }
        
        console.log(`Deposit saved to Firebase for user ${userId} on ${chain}`);
    } catch (error) {
        console.error('Error saving deposit to Firebase:', error);
    }
}

// Get the next RPC URL in rotation
function getNextRpcUrl() {
    currentRpcUrlIndex = (currentRpcUrlIndex + 1) % allRpcUrls.length;
    return allRpcUrls[currentRpcUrlIndex];
}

// Function to initialize Web3 connection
async function initializeWeb3() {
    const currentUrl = allRpcUrls[currentRpcUrlIndex];
    console.log(`Attempting to connect to ${currentUrl}`);
    
    try {
        web3 = new Web3(currentUrl);
        
        // Test connection
        await web3.eth.getBlockNumber();
        isConnected = true;
        retryCount = 0;
        console.log(`Successfully connected to Ethereum network using ${currentUrl}`);
        return true;
    } catch (error) {
        console.error(`Failed to connect to Ethereum network using ${currentUrl}: ${error.message}`);
        isConnected = false;
        return false;
    }
}

// Function to initialize Solana connection
async function initializeSolana() {
    console.log(`Attempting to connect to Solana RPC: ${config.solanaRpcURL}`);
    
    try {
        solanaConnection = new Connection(config.solanaRpcURL);
        
        // Test connection
        await solanaConnection.getSlot();
        solanaConnected = true;
        solanaRetryCount = 0;
        console.log('Successfully connected to Solana network');
        return true;
    } catch (error) {
        console.error(`Failed to connect to Solana network: ${error.message}`);
        solanaConnected = false;
        return false;
    }
}

// Function to monitor blocks for deposits
async function monitorBlocks() {
    // Check if there are any addresses to monitor
    if ((uniqueChains.includes('ethereum') && monitoredAddresses.ethereum.length === 0) && 
        (uniqueChains.includes('solana') && monitoredAddresses.solana.length === 0)) {
        console.log('No addresses to monitor. Waiting for address refresh...');
        scheduleNextCheck();
        return;
    }
    
    // Process Ethereum blocks
    if (uniqueChains.includes('ethereum') && monitoredAddresses.ethereum.length > 0) {
        await monitorEthereumBlocks();
    }
    
    // Process Solana transactions
    if (uniqueChains.includes('solana') && monitoredAddresses.solana.length > 0) {
        await monitorSolanaTransactions();
    }
    
    scheduleNextCheck();
}

// Function to monitor Ethereum blocks
async function monitorEthereumBlocks() {
    if (!isConnected) {
        console.log('Not connected to Ethereum. Attempting to reconnect...');
        
        if (retryCount >= config.maxRetries) {
            console.error('Maximum retry attempts reached for current Ethereum endpoint.');
            // Try the next RPC URL in rotation
            const nextUrl = getNextRpcUrl();
            console.log(`Switching to next RPC URL: ${nextUrl}`);
            retryCount = 0;
        }
        
        retryCount++;
        const connected = await initializeWeb3();
        if (!connected) {
            console.log(`Retry attempt ${retryCount}/${config.maxRetries}. Waiting ${config.retryDelay/1000} seconds...`);
            return;
        }
    }
    
    try {
        const currentBlockNumber = safeBigInt(await web3.eth.getBlockNumber());
        
        if (latestBlockNumber === 0) {
            latestBlockNumber = currentBlockNumber;
            console.log(`Starting Ethereum monitoring from block ${currentBlockNumber}`);
            return;
        }

        // Process new blocks
        for (let blockNum = latestBlockNumber + 1; blockNum <= currentBlockNumber; blockNum++) {
            try {
                const block = await web3.eth.getBlock(blockNum, true);
                
                if (block && block.transactions) {
                    // Filter transactions for monitored addresses
                    const relevantTxs = block.transactions.filter(tx => 
                        tx.to && monitoredAddresses.ethereum.includes(tx.to.toLowerCase())
                    );

                    // Process relevant transactions
                    for (const tx of relevantTxs) {
                        const valueETH = parseFloat(fromWei(tx.value));
                        
                        if (valueETH >= config.minValueETH) {
                            const lowerToAddress = tx.to.toLowerCase();
                            const userInfo = addressToUserMap[lowerToAddress] || { userId: 'Unknown', chain: 'Unknown' };
                            
                            const txRecord = {
                                hash: tx.hash,
                                from: tx.from,
                                to: tx.to,
                                valueETH: valueETH,
                                blockNumber: safeBigInt(blockNum),
                                timestamp: block.timestamp ? new Date(safeBigInt(block.timestamp) * 1000).toISOString() : new Date().toISOString(),
                                userId: userInfo.userId,
                                chain: userInfo.chain
                            };
                            
                            // Add to history if not already present
                            if (!transactionHistory.some(t => t.hash === tx.hash)) {
                                transactionHistory.push(txRecord);
                                saveTransactionHistory();
                                
                                // Also save to Firebase
                                await saveDepositToFirebase(txRecord);
                                
                                // Display deposit information
                                console.log('\n===== NEW DEPOSIT DETECTED =====');
                                console.log(`Time: ${txRecord.timestamp}`);
                                console.log(`Block: ${blockNum}`);
                                console.log(`User: ${userInfo.userId}`);
                                console.log(`Chain: ${userInfo.chain}`);
                                console.log(`Amount: ${valueETH.toFixed(6)} ETH`);
                                console.log(`To: ${tx.to}`);
                                console.log(`From: ${tx.from}`);
                                console.log(`Transaction: ${tx.hash}`);
                                console.log('================================\n');
                            }
                        }
                    }
                }
            } catch (blockError) {
                console.error(`Error processing Ethereum block ${blockNum}: ${blockError.message}`);
                continue; // Continue with next block even if one fails
            }
        }
        
        latestBlockNumber = currentBlockNumber;
        retryCount = 0; // Reset retry count on successful execution
        
    } catch (error) {
        console.error(`Error monitoring Ethereum blocks: ${error.message}`);
        isConnected = false;
    }
}

// Function to monitor Solana transactions
async function monitorSolanaTransactions() {
    if (!solanaConnected) {
        console.log('Not connected to Solana. Attempting to reconnect...');
        
        if (solanaRetryCount >= config.maxRetries) {
            console.error('Maximum retry attempts reached for Solana endpoint.');
            solanaRetryCount = 0;
        }
        
        solanaRetryCount++;
        const connected = await initializeSolana();
        if (!connected) {
            console.log(`Solana retry attempt ${solanaRetryCount}/${config.maxRetries}. Waiting for next check...`);
            return;
        }
    }
    
    try {
        const currentSlot = await solanaConnection.getSlot();
        
        if (latestSolanaSlot === 0) {
            latestSolanaSlot = currentSlot;
            console.log(`Starting Solana monitoring from slot ${currentSlot}`);
            return;
        }
        
        // Fetch signatures for all monitored addresses
        for (const address of monitoredAddresses.solana) {
            try {
                const pubKey = new PublicKey(address);
                const signatures = await solanaConnection.getSignaturesForAddress(pubKey, {
                    limit: 10, // Limit to recent transactions
                    before: latestSolanaSlot > 0 ? latestSolanaSlot.toString() : undefined
                });
                
                // Process each signature/transaction
                for (const sigInfo of signatures) {
                    try {
                        // Skip if we've already processed this transaction
                        if (transactionHistory.some(tx => tx.hash === sigInfo.signature)) {
                            continue;
                        }
                        
                        // Get transaction details
                        const tx = await solanaConnection.getTransaction(sigInfo.signature, {
                            commitment: 'confirmed',
                            maxSupportedTransactionVersion: 0
                        });
                        
                        if (!tx || !tx.meta) continue;
                        
                        // Check for SOL transfers to the monitored address
                        const postBalances = tx.meta.postBalances || [];
                        const preBalances = tx.meta.preBalances || [];
                        const accountKeys = tx.transaction.message.accountKeys || [];
                        
                        // Find the account index for our monitored address
                        const accountIndex = accountKeys.findIndex(key => key.toString() === address);
                        
                        if (accountIndex >= 0 && accountIndex < postBalances.length && accountIndex < preBalances.length) {
                            const preBalance = preBalances[accountIndex];
                            const postBalance = postBalances[accountIndex];
                            const valueSOL = (postBalance - preBalance) / 1000000000; // Convert from lamports to SOL
                            
                            // Only record if it's a deposit (value increased) and above minimum
                            if (valueSOL > config.minValueSOL) {
                                const userInfo = addressToUserMap[address] || { userId: 'Unknown', chain: 'Solana' };
                                
                                // Determine "from" address (usually the fee payer)
                                const fromIndex = tx.transaction.message.accountKeys.findIndex(key => 
                                    tx.meta.postBalances[key] < tx.meta.preBalances[key]
                                );
                                const fromAddress = fromIndex >= 0 ? 
                                    tx.transaction.message.accountKeys[fromIndex].toString() : 'Unknown';
                                
                                const txRecord = {
                                    hash: sigInfo.signature,
                                    from: fromAddress,
                                    to: address,
                                    valueSOL: valueSOL,
                                    blockNumber: sigInfo.slot,
                                    timestamp: new Date(sigInfo.blockTime * 1000).toISOString(),
                                    userId: userInfo.userId,
                                    chain: 'Solana'
                                };
                                
                                transactionHistory.push(txRecord);
                                saveTransactionHistory();
                                
                                // Save to Firebase
                                await saveDepositToFirebase(txRecord);
                                
                                // Display deposit information
                                console.log('\n===== NEW SOLANA DEPOSIT DETECTED =====');
                                console.log(`Time: ${txRecord.timestamp}`);
                                console.log(`Slot: ${sigInfo.slot}`);
                                console.log(`User: ${userInfo.userId}`);
                                console.log(`Chain: Solana`);
                                console.log(`Amount: ${valueSOL.toFixed(6)} SOL`);
                                console.log(`To: ${address}`);
                                console.log(`From: ${fromAddress}`);
                                console.log(`Transaction: ${sigInfo.signature}`);
                                console.log('=========================================\n');
                            }
                        }
                    } catch (txError) {
                        console.error(`Error processing Solana transaction ${sigInfo.signature}: ${txError.message}`);
                        continue;
                    }
                }
            } catch (addrError) {
                console.error(`Error checking Solana address ${address}: ${addrError.message}`);
                continue;
            }
        }
        
        latestSolanaSlot = currentSlot;
        solanaRetryCount = 0;
        
    } catch (error) {
        console.error(`Error monitoring Solana transactions: ${error.message}`);
        solanaConnected = false;
    }
}

// Function to schedule next check
function scheduleNextCheck() {
    if (monitoringInterval) {
        clearTimeout(monitoringInterval);
    }
    monitoringInterval = setTimeout(monitorBlocks, config.pollingInterval);
}

// Function to schedule wallet refresh
function scheduleWalletRefresh() {
    if (!config.firebaseEnabled) {
        return; // Skip wallet refresh if Firebase is disabled
    }
    
    if (walletRefreshInterval) {
        clearInterval(walletRefreshInterval);
    }
    
    // Initial fetch
    fetchWalletAddresses().then(() => {
        // Then set up interval
        walletRefreshInterval = setInterval(fetchWalletAddresses, config.walletRefreshInterval);
    });
}

// Load existing transaction history if available
if (config.saveToFile && fs.existsSync(config.historyFile)) {
    try {
        transactionHistory = JSON.parse(fs.readFileSync(config.historyFile, 'utf8'));
        console.log(`Loaded ${transactionHistory.length} historical transactions`);
    } catch (error) {
        console.error(`Error loading transaction history: ${error.message}`);
    }
}

// Display startup information
console.log('=======================================================');
console.log('DEPOSIT MONITOR v3.0 (Multi-chain)');
console.log('=======================================================');
console.log(`Monitoring chains: ${uniqueChains.join(', ')}`);
if (config.firebaseEnabled) {
    console.log('Firebase integration enabled');
    console.log('Initializing and fetching wallet addresses from Firebase...');
} else {
    console.log('Running in standalone mode with default wallet addresses');
}
console.log('=======================================================');

// Start the monitoring process
async function startMonitoring() {
    try {
        // First fetch wallet addresses
        await fetchWalletAddresses();
        
        // Set up periodic wallet refresh if Firebase is enabled
        if (config.firebaseEnabled) {
            scheduleWalletRefresh();
        }
        
        // Initialize connections for selected chains
        if (uniqueChains.includes('ethereum')) {
            await initializeWeb3();
        }
        
        if (uniqueChains.includes('solana')) {
            await initializeSolana();
        }
        
        // Start blockchain monitoring
        monitorBlocks();
        
        console.log('Waiting for deposits... (Press Ctrl+C to exit)');
        console.log('=======================================================');
    } catch (error) {
        console.error('Failed to start monitoring:', error);
        process.exit(1);
    }
}

// Start monitoring
startMonitoring();

// Handle process termination
process.on('SIGINT', () => {
    console.log('\nDeposit monitoring terminated');
    if (monitoringInterval) {
        clearTimeout(monitoringInterval);
    }
    if (walletRefreshInterval) {
        clearInterval(walletRefreshInterval);
    }
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    isConnected = false;
    solanaConnected = false;
    if (!monitoringInterval) {
        scheduleNextCheck();
    }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
    isConnected = false;
    solanaConnected = false;
    if (!monitoringInterval) {
        scheduleNextCheck();
    }
});
