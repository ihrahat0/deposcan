const { Web3 } = require('web3');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, AccountLayout } = require('@solana/spl-token');

// Process command line arguments
const args = process.argv.slice(2);
const chainArg = args.find(arg => arg.startsWith('--chain='));
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
    scanInterval: 5 * 60 * 1000 // 5 minutes in milliseconds
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
    const addresses = {
        ethereum: [],
        bsc: [],
        solana: []
    };
    const userMap = {};

    try {
        console.log('Fetching wallet addresses from Firebase...');
        const walletAddressesRef = db.collection('walletAddresses');
        const walletSnapshot = await walletAddressesRef.get();
        
        if (!walletSnapshot.empty) {
            console.log(`Found ${walletSnapshot.size} wallet documents in Firebase`);
            
            walletSnapshot.forEach(doc => {
                const userId = doc.id;
                const walletData = doc.data();
                
                if (walletData && walletData.wallets) {
                    // Extract Ethereum address
                    if (walletData.wallets.ethereum) {
                        const ethAddress = walletData.wallets.ethereum.toLowerCase();
                        addresses.ethereum.push(ethAddress);
                        userMap[ethAddress] = userId;
                    }
                    
                    // Extract BSC address
                    if (walletData.wallets.bsc) {
                        const bscAddress = walletData.wallets.bsc.toLowerCase();
                        addresses.bsc.push(bscAddress);
                        userMap[bscAddress] = userId;
                    }
                    
                    // Extract Solana address with validation
                    if (walletData.wallets.solana) {
                        const solanaAddress = walletData.wallets.solana;
                        if (isValidSolanaAddress(solanaAddress)) {
                            addresses.solana.push(solanaAddress);
                            userMap[solanaAddress] = userId;
                        } else {
                            console.warn(`Invalid Solana address for user ${userId}: ${solanaAddress} - Skipping this address`);
                        }
                    }
                }
            });
        } else {
            console.log('No wallet addresses found in Firebase');
        }
        
        return { addresses, userMap };
        
    } catch (error) {
        console.error('Error fetching wallet addresses from Firebase:', error);
        return { addresses, userMap };
    }
}

// Function to update user's balances in Firestore
async function updateUserBalances(userId, chain, symbol, balance) {
    if (!config.saveToFirebase || !userId || userId === 'Unknown') return;
    
    try {
        // Get a reference to the user's document in the users collection
        const userDocRef = db.collection('users').doc(userId);
        
        // Get the current user data
        const userDoc = await userDocRef.get();
        
        if (userDoc.exists) {
            const userData = userDoc.data();
            // Safely access current balances, creating the object if it doesn't exist
            const balances = userData.balances || {};
            
            // Normalize the symbol to check both upper and lowercase versions
            const tokenSymbol = symbol.toUpperCase();
            
            // Check if the balance field exists with either uppercase or lowercase
            let existingKey = null;
            let currentValue = 0;
            
            // Look for the token in any case variant
            for (const key in balances) {
                if (key.toUpperCase() === tokenSymbol) {
                    existingKey = key;
                    currentValue = balances[key] || 0;
                    break;
                }
            }
            
            // Only update if the balance has changed beyond a small rounding threshold
            // This prevents unnecessary updates due to small precision differences
            const threshold = 0.000001;
            if (Math.abs(currentValue - balance) > threshold) {
                // Update using the existing key if found, otherwise use the symbol as is
                const updateKey = existingKey || tokenSymbol;
                const updateData = {};
                updateData[`balances.${updateKey}`] = balance;
                
                await userDocRef.update(updateData);
                console.log(`Updated ${userId}'s ${updateKey} balance from ${currentValue} to ${balance}`);
            } else {
                console.log(`No change in ${userId}'s ${existingKey || tokenSymbol} balance (${balance})`);
            }
        } else {
            console.log(`User document ${userId} not found, cannot update balances`);
        }
    } catch (error) {
        console.error(`Error updating user's balances:`, error);
    }
}

// Function to process a batch of wallets
async function processBatch(addresses, chain, web3Instance, userMap, startIndex, batchSize) {
    const results = {};
    const endIndex = Math.min(startIndex + batchSize, addresses.length);
    
    console.log(`Processing ${chain} addresses ${startIndex + 1} to ${endIndex} (of ${addresses.length})`);
    
    for (let i = startIndex; i < endIndex; i++) {
        const address = addresses[i];
        const userId = userMap[address] || 'Unknown';
        
        // Get native token balance
        let nativeBalance = 0;
        let tokenBalances = {};
        
        if (chain === 'Solana') {
            nativeBalance = await getSolanaBalance(address);
            
            // Update user's SOL balance in users collection
            if (nativeBalance > 0) {
                await updateUserBalances(userId, chain, 'SOL', nativeBalance);
            }
            
            // Check SPL token balances if there's a SOL balance
            if (nativeBalance >= config.minReportBalance) {
                tokenBalances = await getSolanaSPLTokenBalances(address);
                
                // Update user's token balances in users collection
                for (const [symbol, tokenData] of Object.entries(tokenBalances)) {
                    await updateUserBalances(userId, chain, symbol, tokenData.balance);
                }
            }
        } else if (chain === 'Ethereum') {
            nativeBalance = await getNativeBalance(address, web3Instance, chain);
            
            // Update user's ETH balance in users collection
            if (nativeBalance > 0) {
                await updateUserBalances(userId, chain, 'ETH', nativeBalance);
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
                        await updateUserBalances(userId, chain, token.symbol, balance);
                    }
                }
            }
        } else if (chain === 'BSC') {
            nativeBalance = await getNativeBalance(address, web3Instance, chain);
            
            // Update user's BNB balance in users collection
            if (nativeBalance > 0) {
                await updateUserBalances(userId, chain, 'BNB', nativeBalance);
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
                        await updateUserBalances(userId, chain, token.symbol, balance);
                    }
                }
            }
        }
        
        results[address] = {
            userId,
            nativeBalance,
            tokens: tokenBalances,
            totalValueUSD: 0 // We'll add this later if price API is integrated
        };
    }
    
    return results;
}

// Save results to Firebase
async function saveBalancesToFirebase(ethereumBalances, bscBalances, solanaBalances) {
    if (!config.saveToFirebase) return;
    
    try {
        const scanTime = admin.firestore.Timestamp.now();
        const batch = db.batch();
        const collectionRef = db.collection(config.balancesCollection);
        
        // Create a single document with the scan results
        const docRef = collectionRef.doc(scanTime.toDate().toISOString().replace(/[:.]/g, '-'));
        
        batch.set(docRef, {
            scanTime: scanTime,
            ethereumBalances,
            bscBalances,
            solanaBalances,
            summary: {
                ethereumAddressCount: Object.keys(ethereumBalances).length,
                bscAddressCount: Object.keys(bscBalances).length,
                solanaAddressCount: Object.keys(solanaBalances).length,
                nonZeroEthereumCount: Object.values(ethereumBalances).filter(data => data.nativeBalance > 0).length,
                nonZeroBscCount: Object.values(bscBalances).filter(data => data.nativeBalance > 0).length,
                nonZeroSolanaCount: Object.values(solanaBalances).filter(data => data.nativeBalance > 0).length
            }
        });
        
        await batch.commit();
        console.log(`Balance scan results saved to Firebase collection '${config.balancesCollection}'`);
        
    } catch (error) {
        console.error('Error saving balances to Firebase:', error);
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
        const { addresses, userMap } = await fetchAllWalletAddresses();
        
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
                    i,
                    config.batchSize
                );
                Object.assign(solanaBalances, batchResults);
            }
        }
        
        // Save results to file
        const report = {
            scanTime: new Date().toISOString(),
            chainsScanned: uniqueChains,
            ethereumBalances: uniqueChains.includes('ethereum') ? ethereumBalances : {},
            bscBalances: uniqueChains.includes('bsc') ? bscBalances : {},
            solanaBalances: uniqueChains.includes('solana') ? solanaBalances : {},
            summary: {
                ethereumAddressCount: addresses.ethereum ? addresses.ethereum.length : 0,
                bscAddressCount: addresses.bsc ? addresses.bsc.length : 0,
                solanaAddressCount: addresses.solana ? addresses.solana.length : 0,
                nonZeroEthereumCount: uniqueChains.includes('ethereum') ? 
                    Object.values(ethereumBalances).filter(data => data.nativeBalance > 0).length : 0,
                nonZeroBscCount: uniqueChains.includes('bsc') ? 
                    Object.values(bscBalances).filter(data => data.nativeBalance > 0).length : 0,
                nonZeroSolanaCount: uniqueChains.includes('solana') ? 
                    Object.values(solanaBalances).filter(data => data.nativeBalance > 0).length : 0
            }
        };
        
        fs.writeFileSync(config.outputFile, JSON.stringify(report, null, 2));
        
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
    }
}

// Function to start the periodic scanning
function startPeriodicScanning() {
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