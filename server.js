const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const socketIo = require('socket.io');

// Initialize Firebase Admin
let admin;
try {
    admin = require('firebase-admin');
    const serviceAccount = require('./service-account.json');
    
    // Initialize Firebase if it's not already initialized
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log('Firebase Admin SDK initialized successfully in server.js');
    }
} catch (error) {
    console.error('Failed to initialize Firebase Admin SDK in server.js:', error.message);
}

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files from the 'public' directory
app.use(express.static('public'));
app.use(express.json());

// Store active scans
const activeScans = new Map();

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('New client connected');
    
    socket.on('join-scan', (scanId) => {
        socket.join(`scan-${scanId}`);
        console.log(`Client joined scan room: scan-${scanId}`);
        
        // Send existing logs if available
        const scanInfo = activeScans.get(scanId);
        if (scanInfo && scanInfo.output.length > 0) {
            scanInfo.output.forEach(line => {
                socket.emit('scan-log', { scanId, message: line });
            });
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Route to get the latest balance scan data
app.get('/api/latest-scan', async (req, res) => {
    try {
        // Initialize the data structure
        let parsedData = {
            scanTime: new Date().toISOString(),
            chainsScanned: [],
            ethereumBalances: {},
            bscBalances: {},
            solanaBalances: {},
            summary: {
                ethereumAddressCount: 0,
                bscAddressCount: 0,
                solanaAddressCount: 0,
                nonZeroEthereumCount: 0,
                nonZeroBscCount: 0,
                nonZeroSolanaCount: 0
            }
        };
        
        // Path to the balances collection in Firestore
        const balancesPath = 'walletBalances/latest';
        
        // Try to read from Firestore first (most reliable source)
        if (admin && admin.firestore) {
            try {
                console.log('Reading latest balances from Firestore');
                const latestDoc = await admin.firestore().doc(balancesPath).get();
                if (latestDoc.exists) {
                    const firestoreData = latestDoc.data();
                    parsedData = firestoreData;
                    console.log('Successfully loaded balance data from Firestore');
                } else {
                    console.log('No balance data found in Firestore, falling back to file');
                }
            } catch (firestoreError) {
                console.error('Error reading from Firestore:', firestoreError);
                console.log('Falling back to reading from file');
            }
        }
        
        // If Firestore fails or is unavailable, try reading from the local file
        try {
            // Check if the file exists
            if (fs.existsSync('enhanced_wallet_balances.json')) {
                const fileData = JSON.parse(fs.readFileSync('enhanced_wallet_balances.json', 'utf8'));
                
                // Determine which data source is most recent
                const fileTime = new Date(fileData.scanTime);
                const currentDataTime = new Date(parsedData.scanTime);
                
                if (fileTime > currentDataTime) {
                    console.log('File data is more recent, using that');
                    
                    // Only update the chains that were scanned in this file
                    // This preserves data for chains not scanned in the current session
                    if (fileData.chainsScanned.includes('ethereum')) {
                        parsedData.ethereumBalances = fileData.ethereumBalances;
                    }
                    
                    if (fileData.chainsScanned.includes('bsc')) {
                        parsedData.bscBalances = fileData.bscBalances;
                    }
                    
                    if (fileData.chainsScanned.includes('solana')) {
                        parsedData.solanaBalances = fileData.solanaBalances;
                    }
                    
                    // Update scan time and summary
                    parsedData.scanTime = fileData.scanTime;
                    parsedData.chainsScanned = [...new Set([...parsedData.chainsScanned, ...fileData.chainsScanned])];
                    
                    // Recalculate summary
                    parsedData.summary = {
                        ethereumAddressCount: Object.keys(parsedData.ethereumBalances).length,
                        bscAddressCount: Object.keys(parsedData.bscBalances).length,
                        solanaAddressCount: Object.keys(parsedData.solanaBalances).length,
                        nonZeroEthereumCount: Object.values(parsedData.ethereumBalances).filter(data => data.nativeBalance > 0).length,
                        nonZeroBscCount: Object.values(parsedData.bscBalances).filter(data => data.nativeBalance > 0).length,
                        nonZeroSolanaCount: Object.values(parsedData.solanaBalances).filter(data => data.nativeBalance > 0).length
                    };
                } else {
                    console.log('Firestore data is more recent, using that');
                }
            }
        } catch (fileError) {
            console.error('Error reading balance data file:', fileError);
        }
        
        // Add lastScanned timestamp to each balance entry
        for (const chain of ['ethereumBalances', 'bscBalances', 'solanaBalances']) {
            if (parsedData[chain]) {
                for (const address in parsedData[chain]) {
                    parsedData[chain][address].lastScanned = parsedData[chain][address].lastScanned || parsedData.scanTime;
                }
            }
        }
        
        return res.json(parsedData);
    } catch (error) {
        console.error('Error reading balance data:', error);
        return res.status(500).json({ 
            error: 'Failed to read balance data',
            message: error.message
        });
    }
});

// Route to get deposit history
app.get('/api/deposit-history', async (req, res) => {
    try {
        // Check if Firebase Admin is initialized
        if (!admin || !admin.firestore) {
            console.error('Firebase Admin SDK not initialized for deposit history endpoint');
            return res.status(500).json({
                success: false,
                error: 'Firebase Admin SDK not initialized',
                message: 'Unable to access Firestore. Firebase Admin is not properly initialized.'
            });
        }
        
        // Query the processedDeposits collection
        const depositsRef = admin.firestore().collection('processedDeposits');
        const depositsSnapshot = await depositsRef.orderBy('timestamp', 'desc').limit(50).get();
        
        const deposits = [];
        
        depositsSnapshot.forEach(doc => {
            const depositData = doc.data();
            // Convert Firestore timestamp to ISO string if it exists
            if (depositData.timestamp) {
                depositData.timestamp = depositData.timestamp.toDate().toISOString();
            }
            
            // Make sure userEmail is included if available
            if (depositData.userEmail) {
                deposits.push({
                    id: doc.id,
                    ...depositData
                });
            } else {
                // Include userId if email not available
                deposits.push({
                    id: doc.id,
                    ...depositData,
                    userEmail: depositData.userId || 'No email found'
                });
            }
        });
        
        return res.json({
            success: true,
            deposits
        });
    } catch (error) {
        console.error('Error fetching deposit history:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to fetch deposit history',
            message: error.message
        });
    }
});

// Route to initiate a balance scan
app.get('/api/scan-balances', (req, res) => {
    try {
        // Get requested chains from query parameter
        const chains = req.query.chains || 'all';
        
        // Generate a unique ID for this scan
        const scanId = uuidv4();
        
        // Prepare to execute the enhanced-balance-scanner.js script
        const scanProcess = spawn('node', ['enhanced-balance-scanner.js', `--chain=${chains}`, '--one-time']);
        
        // Store scan info
        activeScans.set(scanId, {
            process: scanProcess,
            status: 'running',
            progress: 0,
            message: 'Scan started',
            startTime: new Date(),
            chains: chains,
            output: [],
            error: null
        });
        
        // Handle process output
        scanProcess.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`[Scan ${scanId}]: ${output}`);
            
            // Store output
            const scanInfo = activeScans.get(scanId);
            if (scanInfo) {
                scanInfo.output.push(output);
                
                // Emit log event to frontend via Socket.io
                io.to(`scan-${scanId}`).emit('scan-log', { scanId, message: output });
                
                // Update progress based on output (simple heuristic)
                if (output.includes('Scanning Ethereum balances')) {
                    scanInfo.progress = 20;
                    scanInfo.message = 'Scanning Ethereum balances...';
                } else if (output.includes('Scanning BSC balances')) {
                    scanInfo.progress = 40;
                    scanInfo.message = 'Scanning BSC balances...';
                } else if (output.includes('Scanning Solana balances')) {
                    scanInfo.progress = 60;
                    scanInfo.message = 'Scanning Solana balances...';
                } else if (output.includes('BALANCE SCAN COMPLETE')) {
                    scanInfo.progress = 90;
                    scanInfo.message = 'Finalizing scan results...';
                }
                
                // Emit progress update
                io.to(`scan-${scanId}`).emit('scan-progress', {
                    scanId,
                    progress: scanInfo.progress,
                    message: scanInfo.message
                });
                
                activeScans.set(scanId, scanInfo);
            }
        });
        
        // Handle process errors
        scanProcess.stderr.on('data', (data) => {
            const error = data.toString();
            console.error(`[Scan ${scanId} Error]: ${error}`);
            
            // Store error
            const scanInfo = activeScans.get(scanId);
            if (scanInfo) {
                scanInfo.error = error;
                scanInfo.output.push(`ERROR: ${error}`);
                
                // Emit error to frontend via Socket.io
                io.to(`scan-${scanId}`).emit('scan-log', { 
                    scanId, 
                    message: `ERROR: ${error}`,
                    isError: true
                });
                
                activeScans.set(scanId, scanInfo);
            }
        });
        
        // Handle process completion
        scanProcess.on('close', (code) => {
            console.log(`[Scan ${scanId}] Process exited with code ${code}`);
            
            const scanInfo = activeScans.get(scanId);
            if (scanInfo) {
                if (code === 0) {
                    scanInfo.status = 'completed';
                    scanInfo.progress = 100;
                    scanInfo.message = 'Scan completed successfully';
                    
                    // Emit completion message
                    io.to(`scan-${scanId}`).emit('scan-log', { 
                        scanId, 
                        message: 'Scan completed successfully!'
                    });
                } else {
                    scanInfo.status = 'failed';
                    scanInfo.message = `Scan failed with code ${code}`;
                    
                    // Emit failure message
                    io.to(`scan-${scanId}`).emit('scan-log', { 
                        scanId, 
                        message: `Scan failed with code ${code}`
                    });
                }
                
                activeScans.set(scanId, scanInfo);
            }
        });
        
        return res.json({
            success: true,
            scanId
        });
    } catch (error) {
        console.error('Error initiating balance scan:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to initiate balance scan',
            message: error.message
        });
    }
});

server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});