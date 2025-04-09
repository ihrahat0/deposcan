// Automatic Balance Scanner
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
    scanInterval: 10 * 60 * 1000, // 10 minutes in milliseconds
    statusFile: 'scan-status.json',
    chains: ['ethereum', 'bsc', 'solana'] // Chains to scan
};

// Initialize scan status
let scanStatus = {
    lastScanTime: null,
    nextScanTime: null,
    scanInProgress: false
};

// Load existing status if available
function loadStatus() {
    try {
        if (fs.existsSync(CONFIG.statusFile)) {
            const data = fs.readFileSync(CONFIG.statusFile, 'utf8');
            const parsedData = JSON.parse(data);
            
            // Ensure data has expected properties
            scanStatus = {
                lastScanTime: parsedData.lastScanTime || null,
                nextScanTime: parsedData.nextScanTime || Date.now() + CONFIG.scanInterval,
                scanInProgress: false // Always reset to false on startup
            };
            
            console.log('Loaded existing scan status');
        } else {
            // Initialize with default values
            scanStatus = {
                lastScanTime: null,
                nextScanTime: Date.now() + CONFIG.scanInterval,
                scanInProgress: false
            };
            saveStatus();
            console.log('Initialized new scan status');
        }
    } catch (error) {
        console.error('Error loading scan status:', error);
        // Set default values on error
        scanStatus = {
            lastScanTime: null,
            nextScanTime: Date.now() + CONFIG.scanInterval,
            scanInProgress: false
        };
        saveStatus();
    }
}

// Save status to file
function saveStatus() {
    try {
        fs.writeFileSync(CONFIG.statusFile, JSON.stringify(scanStatus, null, 2));
    } catch (error) {
        console.error('Error saving scan status:', error);
    }
}

// Run the balance scanner
function runScan() {
    if (scanStatus.scanInProgress) {
        console.log('Scan already in progress, skipping');
        return;
    }
    
    scanStatus.scanInProgress = true;
    saveStatus();
    
    console.log('Starting automatic balance scan...');
    
    // Build command to scan all chains
    const command = `node enhanced-balance-scanner.js --chain=${CONFIG.chains.join(',')} --one-time`;
    
    exec(command, (error, stdout, stderr) => {
        scanStatus.scanInProgress = false;
        scanStatus.lastScanTime = Date.now();
        scanStatus.nextScanTime = Date.now() + CONFIG.scanInterval;
        saveStatus();
        
        if (error) {
            console.error(`Error during scan: ${error.message}`);
            return;
        }
        
        if (stderr) {
            console.error(`Scan stderr: ${stderr}`);
        }
        
        console.log('Automatic scan completed successfully');
        console.log('Next scan scheduled for:', new Date(scanStatus.nextScanTime).toLocaleString());
    });
}

// Check if it's time to run the scan
function checkAndRunScan() {
    const now = Date.now();
    if (!scanStatus.scanInProgress && (!scanStatus.nextScanTime || now >= scanStatus.nextScanTime)) {
        runScan();
    }
}

// Start the auto-scan process
function startAutoScan() {
    // Load current status
    loadStatus();
    
    // Check if an immediate scan is needed
    if (!scanStatus.lastScanTime || (Date.now() - scanStatus.lastScanTime > CONFIG.scanInterval)) {
        console.log('No recent scan found, running initial scan');
        runScan();
    } else {
        console.log('Recent scan found, scheduling next scan for:', new Date(scanStatus.nextScanTime).toLocaleString());
    }
    
    // Set up interval to check for scheduled scans
    setInterval(checkAndRunScan, 60000); // Check every minute
    
    // Save status every minute to update countdown for the frontend
    setInterval(() => {
        // Only update the file if a scan is not in progress
        if (!scanStatus.scanInProgress) {
            saveStatus();
        }
    }, 60000);
}

// Start the process
console.log('Starting automatic balance scanner...');
startAutoScan();

// Listen for shutdown signals
process.on('SIGINT', () => {
    console.log('Auto-scanner shutting down');
    saveStatus();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Auto-scanner shutting down');
    saveStatus();
    process.exit(0);
}); 