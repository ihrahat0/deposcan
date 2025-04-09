const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const socketIo = require('socket.io');
const cookieParser = require('cookie-parser');
const session = require('express-session');

// Initialize Firebase Admin
let admin;
try {
    admin = require('firebase-admin');
    const serviceAccount = require('./service-account.json');
    
    // Initialize Firebase Admin SDK
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    
    console.log('Firebase Admin SDK initialized for server');
} catch (error) {
    console.error('Failed to initialize Firebase Admin SDK:', error.message);
    console.warn('Some functionality may be limited');
}

// Initialize Express app
const app = express();
const port = process.env.PORT || 4000;
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(cookieParser());

// Session configuration
app.use(session({
    secret: 'deposcan-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Set to false for non-HTTPS development
        maxAge: 432000000, // 5 days
        httpOnly: true,
        sameSite: 'lax' // Changed from strict to lax for better compatibility
    }
}));

// Authentication middleware
const authRequired = async (req, res, next) => {
    try {
        // Skip auth for login page, static assets and authentication API routes
        if (req.path === '/login.html' || 
            req.path === '/js/auth.js' || 
            req.path === '/api/auth/session' ||
            req.path === '/api/auth/verify-token' ||
            req.path.match(/\.(css|js|ico|png|jpg|jpeg|svg|gif)$/)) {
            return next();
        }
        
        // Check if session token exists
        const sessionCookie = req.cookies.session || req.session.token;
        
        if (!sessionCookie) {
            console.log('No session cookie found, redirecting to login');
            // No session, check if requesting the API or a page
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ error: 'Unauthorized' });
            } else {
                // Redirect to login page
                return res.redirect('/login.html');
            }
        }
        
        // Verify the session
        try {
            if (!admin || !admin.auth) {
                throw new Error('Firebase Admin not initialized');
            }
            
            const decodedClaims = await admin.auth().verifySessionCookie(sessionCookie, true)
                .catch(error => {
                    console.error('Session cookie verification failed:', error.message);
                    throw new Error('Session verification failed');
                });
                
            // Store user data in request for later use
            req.user = decodedClaims;
            
            // Skip admin check for testing (temporary fix)
            // Remove or comment this in production when admin roles are properly set
            if (process.env.NODE_ENV !== 'production') {
                return next();
            }
            
            // Check if user has admin role
            if (!decodedClaims.admin && !decodedClaims.email_verified) {
                console.log('Non-admin user attempted to access: ', decodedClaims.email);
                
                // Clear the session
                res.clearCookie('session');
                
                if (req.path.startsWith('/api/')) {
                    return res.status(403).json({ 
                        error: 'Forbidden', 
                        message: 'Admin access required' 
                    });
                } else {
                    // Display access denied message
                    return res.send(`
                        <html>
                            <head>
                                <title>Access Denied</title>
                                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
                                <style>
                                    body {
                                        height: 100vh;
                                        display: flex;
                                        align-items: center;
                                        justify-content: center;
                                        background-color: #f8f9fa;
                                    }
                                    .card {
                                        max-width: 500px;
                                        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                                    }
                                </style>
                            </head>
                            <body>
                                <div class="card">
                                    <div class="card-header bg-danger text-white">
                                        <h4 class="mb-0">Access Denied</h4>
                                    </div>
                                    <div class="card-body">
                                        <p>You don't have admin privileges required to access this application.</p>
                                        <p>Please contact the administrator if you believe you should have access.</p>
                                        <a href="/login.html" class="btn btn-primary">Return to Login</a>
                                    </div>
                                </div>
                            </body>
                        </html>
                    `);
                }
            }
            
            next();
        } catch (error) {
            console.error('Session verification failed:', error);
            
            // Clear the invalid session
            res.clearCookie('session');
            req.session.destroy();
            
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ error: 'Unauthorized', message: 'Session expired' });
            } else {
                return res.redirect('/login.html');
            }
        }
    } catch (error) {
        console.error('Auth middleware error:', error);
        next(error);
    }
};

// Apply auth middleware to all routes
app.use(authRequired);

// Create API endpoint for verifying Firebase ID tokens
app.post('/api/auth/verify-token', async (req, res) => {
    try {
        const idToken = req.body.idToken;
        
        if (!idToken) {
            return res.status(400).json({ error: 'No ID token provided' });
        }
        
        if (!admin || !admin.auth) {
            return res.status(500).json({ error: 'Firebase Admin not initialized' });
        }
        
        // Verify the ID token
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        
        // Check if user has admin role
        if (!decodedToken.admin) {
            console.log('Non-admin login attempt:', decodedToken.email);
            return res.status(403).json({ 
                error: 'Forbidden', 
                message: 'Admin access required' 
            });
        }
        
        // Create a session cookie
        const expiresIn = 60 * 60 * 24 * 5 * 1000; // 5 days
        const sessionCookie = await admin.auth().createSessionCookie(idToken, { expiresIn });
        
        // Set cookie policy
        const options = {
            maxAge: expiresIn,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict'
        };
        
        // Save to both cookies and session
        res.cookie('session', sessionCookie, options);
        req.session.token = sessionCookie;
        req.session.user = {
            uid: decodedToken.uid,
            email: decodedToken.email,
            admin: decodedToken.admin // Include admin flag in session
        };
        req.session.save();
        
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('Token verification failed:', error);
        return res.status(401).json({ error: 'Unauthorized', message: error.message });
    }
});

// Check session status
app.get('/api/auth/session', (req, res) => {
    const user = req.session.user;
    
    if (user) {
        return res.json({ 
            authenticated: true, 
            user: {
                uid: user.uid,
                email: user.email
            }
        });
    } else {
        return res.json({ authenticated: false });
    }
});

// Logout endpoint
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.clearCookie('session');
    return res.json({ success: true });
});

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

// API endpoint for deposit history
app.get('/api/deposit-history', async (req, res) => {
    try {
        // Extract query parameters for filtering
        const emailFilter = req.query.email ? req.query.email.toLowerCase() : null;
        const walletFilter = req.query.wallet ? req.query.wallet.toLowerCase() : null;
        
        // Get reference to the processedDeposits collection
        const depositsRef = admin.firestore().collection('processedDeposits');
        
        // Start with a base query that orders by timestamp descending
        let query = depositsRef.orderBy('timestamp', 'desc');
        
        // Fetch data - increase limit to ensure we catch all deposits after filtering
        const snapshot = await query.limit(200).get(); 
        let deposits = [];
        
        // Process each deposit
        if (!snapshot.empty) {
            snapshot.forEach(doc => {
                const data = doc.data();
                
                // For each deposit, add both the doc ID and its data
                deposits.push({
                    id: doc.id,
                    ...data,
                    // Properly handle timestamps for sorting and display
                    timestamp: data.timestamp ? data.timestamp.toDate().toISOString() : null
                });
            });
            
            // Apply filters in memory if needed
            if (emailFilter || walletFilter) {
                deposits = deposits.filter(deposit => {
                    // Filter by user email (case insensitive)
                    if (emailFilter && deposit.userEmail) {
                        const email = deposit.userEmail.toLowerCase();
                        if (!email.includes(emailFilter)) {
                            return false;
                        }
                    }
                    
                    // Filter by wallet address (case insensitive)
                    if (walletFilter && deposit.walletAddress) {
                        const wallet = deposit.walletAddress.toLowerCase();
                        if (!wallet.includes(walletFilter)) {
                            return false;
                        }
                    }
                    
                    // If we get here, the deposit matches all provided filters
                    return true;
                });
            }
            
            // Ensure deposits are properly sorted by date (newest first)
            deposits.sort((a, b) => {
                const dateA = a.timestamp ? new Date(a.timestamp) : new Date(0);
                const dateB = b.timestamp ? new Date(b.timestamp) : new Date(0);
                return dateB - dateA;
            });
            
            // Return the filtered deposits (limited to first 100 for performance)
            res.json({
                success: true,
                deposits: deposits.slice(0, 100)
            });
        } else {
            res.json({
                success: true,
                deposits: []
            });
        }
    } catch (error) {
        console.error('Error fetching deposit history:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch deposit history'
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
                        message: `Scan failed with exit code ${code}. Check logs for details.`,
                        isError: true
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

// Route to get scan status and time until next scan
app.get('/api/scan-status', (req, res) => {
    try {
        // Read the scan status file
        const statusFile = 'scan-status.json';
        
        if (!fs.existsSync(statusFile)) {
            return res.json({
                success: false,
                error: 'No scan status available',
                nextScanIn: null,
                lastScan: null,
                scanInProgress: false
            });
        }
        
        const scanStatus = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        const now = Date.now();
        
        // Calculate time until next scan
        const nextScanIn = scanStatus.nextScanTime ? Math.max(0, scanStatus.nextScanTime - now) : null;
        
        return res.json({
            success: true,
            nextScanTime: scanStatus.nextScanTime,
            nextScanIn: nextScanIn,
            lastScanTime: scanStatus.lastScanTime,
            scanInProgress: scanStatus.scanInProgress,
            nextScanDate: scanStatus.nextScanTime ? new Date(scanStatus.nextScanTime).toISOString() : null,
            lastScanDate: scanStatus.lastScanTime ? new Date(scanStatus.lastScanTime).toISOString() : null
        });
    } catch (error) {
        console.error('Error reading scan status:', error);
        return res.status(500).json({
            success: false,
            error: 'Failed to read scan status',
            message: error.message
        });
    }
});

// Route to get a specific scan's logs and status
app.get('/api/scan/:scanId', (req, res) => {
    try {
        const scanId = req.params.scanId;
        const scanInfo = activeScans.get(scanId);
        
        if (!scanInfo) {
            return res.status(404).json({
                success: false,
                error: 'Scan not found'
            });
        }
        
        return res.json({
            success: true,
            status: scanInfo.status,
            progress: scanInfo.progress,
            message: scanInfo.message,
            startTime: scanInfo.startTime,
            chains: scanInfo.chains,
            logs: scanInfo.output,
            error: scanInfo.error
        });
    } catch (error) {
        console.error(`Error retrieving scan ${req.params.scanId}:`, error);
        return res.status(500).json({
            success: false,
            error: 'Failed to retrieve scan information',
            message: error.message
        });
    }
});

// Start the server
server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});