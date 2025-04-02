const { Web3 } = require('web3');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

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
    
    // Output file for balances
    outputFile: 'wallet_balances.json',
    
    // Convert to USD
    showUSD: true
};

// Initialize Web3 instances
const ethereumWeb3 = new Web3(config.ethereumRpcURL);
const bscWeb3 = new Web3(config.bscRpcURL);

// Helper for safely handling BigInt values and converting to number
function fromWei(web3Instance, value) {
    const valueStr = typeof value === 'bigint' ? value.toString() : value;
    return web3Instance.utils.fromWei(valueStr, 'ether');
}

// Function to get wallet balance in ETH/BNB
async function getWalletBalance(address, web3Instance, chain) {
    try {
        const balanceWei = await web3Instance.eth.getBalance(address);
        const balanceEth = parseFloat(fromWei(web3Instance, balanceWei));
        return balanceEth;
    } catch (error) {
        console.error(`Error getting ${chain} balance for ${address}:`, error.message);
        return 0;
    }
}

// Function to fetch all wallet addresses from Firebase
async function fetchAllWalletAddresses() {
    const addresses = {
        ethereum: [],
        bsc: []
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

// Main function to scan balances
async function scanWalletBalances() {
    console.log('=======================================================');
    console.log('WALLET BALANCE SCANNER');
    console.log('=======================================================');
    
    try {
        // Fetch wallet addresses from Firebase
        const { addresses, userMap } = await fetchAllWalletAddresses();
        
        if (addresses.ethereum.length === 0 && addresses.bsc.length === 0) {
            console.log('No wallet addresses found to scan');
            return;
        }
        
        // Summary counts
        console.log(`Found ${addresses.ethereum.length} Ethereum addresses and ${addresses.bsc.length} BSC addresses`);
        
        // Scan Ethereum balances
        console.log('=======================================================');
        console.log('Scanning Ethereum balances...');
        const ethereumBalances = {};
        let ethTotal = 0;
        
        for (let i = 0; i < addresses.ethereum.length; i++) {
            const address = addresses.ethereum[i];
            const userId = userMap[address] || 'Unknown';
            const balance = await getWalletBalance(address, ethereumWeb3, 'Ethereum');
            ethereumBalances[address] = {
                userId,
                balance,
                valueUSD: 0 // We'll add this later if required
            };
            
            ethTotal += balance;
            
            // Log progress every 10 addresses
            if ((i + 1) % 10 === 0 || i === addresses.ethereum.length - 1) {
                console.log(`Processed ${i + 1}/${addresses.ethereum.length} Ethereum addresses`);
            }
        }
        
        // Scan BSC balances
        console.log('=======================================================');
        console.log('Scanning BSC balances...');
        const bscBalances = {};
        let bscTotal = 0;
        
        for (let i = 0; i < addresses.bsc.length; i++) {
            const address = addresses.bsc[i];
            const userId = userMap[address] || 'Unknown';
            const balance = await getWalletBalance(address, bscWeb3, 'BSC');
            bscBalances[address] = {
                userId,
                balance,
                valueUSD: 0 // We'll add this later if required
            };
            
            bscTotal += balance;
            
            // Log progress every 10 addresses
            if ((i + 1) % 10 === 0 || i === addresses.bsc.length - 1) {
                console.log(`Processed ${i + 1}/${addresses.bsc.length} BSC addresses`);
            }
        }
        
        // Calculate totals and create report
        const report = {
            scanTime: new Date().toISOString(),
            summary: {
                ethereumAddressCount: addresses.ethereum.length,
                bscAddressCount: addresses.bsc.length,
                totalEthereumBalance: ethTotal,
                totalBNBBalance: bscTotal
            },
            ethereumBalances,
            bscBalances
        };
        
        // Save report to file
        fs.writeFileSync(config.outputFile, JSON.stringify(report, null, 2));
        
        // Display summary
        console.log('=======================================================');
        console.log('BALANCE SCAN COMPLETE');
        console.log('=======================================================');
        console.log(`Total Ethereum addresses: ${addresses.ethereum.length}`);
        console.log(`Total BSC addresses: ${addresses.bsc.length}`);
        console.log(`Total ETH: ${ethTotal.toFixed(6)} ETH`);
        console.log(`Total BNB: ${bscTotal.toFixed(6)} BNB`);
        console.log('=======================================================');
        console.log(`Full report saved to ${config.outputFile}`);
        
        // Filter and display non-zero balances
        console.log('=======================================================');
        console.log('NON-ZERO BALANCES:');
        console.log('=======================================================');
        
        // Display Ethereum non-zero balances
        console.log('ETHEREUM:');
        let nonZeroEthCount = 0;
        for (const [address, data] of Object.entries(ethereumBalances)) {
            if (data.balance > 0) {
                console.log(`- User: ${data.userId}, Address: ${address}, Balance: ${data.balance.toFixed(6)} ETH`);
                nonZeroEthCount++;
            }
        }
        if (nonZeroEthCount === 0) {
            console.log('No non-zero Ethereum balances found');
        } else {
            console.log(`Found ${nonZeroEthCount} addresses with non-zero ETH balance`);
        }
        
        // Display BSC non-zero balances
        console.log('\nBSC:');
        let nonZeroBnbCount = 0;
        for (const [address, data] of Object.entries(bscBalances)) {
            if (data.balance > 0) {
                console.log(`- User: ${data.userId}, Address: ${address}, Balance: ${data.balance.toFixed(6)} BNB`);
                nonZeroBnbCount++;
            }
        }
        if (nonZeroBnbCount === 0) {
            console.log('No non-zero BSC balances found');
        } else {
            console.log(`Found ${nonZeroBnbCount} addresses with non-zero BNB balance`);
        }
        
    } catch (error) {
        console.error('Error scanning wallet balances:', error);
    } finally {
        // Clean up
        process.exit(0);
    }
}

// Run the scanner
scanWalletBalances(); 