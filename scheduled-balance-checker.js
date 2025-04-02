// Scheduling script for running enhanced balance scanner at regular intervals
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Process command line arguments
const args = process.argv.slice(2);
const chainArg = args.find(arg => arg.startsWith('--chain='));
const chainOption = chainArg ? `--chain=${chainArg.replace('--chain=', '')}` : '';

// Configuration
const config = {
    // How often to run the balance check (in minutes)
    checkIntervalMinutes: 60,
    
    // Enhanced balance scanner script
    scannerScript: 'enhanced-balance-scanner.js',
    
    // Specify times to run (24-hour format)
    // Set to empty array to only use interval
    scheduledTimes: ['00:00', '06:00', '12:00', '18:00'],
    
    // Output directory for logs
    logDir: './logs',
    
    // Keep logs for X days
    keepLogsForDays: 7
};

// Create log directory if it doesn't exist
if (!fs.existsSync(config.logDir)) {
    fs.mkdirSync(config.logDir, { recursive: true });
    console.log(`Created log directory: ${config.logDir}`);
}

// Function to clean up old log files
function cleanupOldLogs() {
    try {
        const now = new Date();
        const files = fs.readdirSync(config.logDir);
        
        files.forEach(file => {
            // Skip non-log files
            if (!file.endsWith('.log')) return;
            
            const filePath = path.join(config.logDir, file);
            const fileStat = fs.statSync(filePath);
            const fileDate = new Date(fileStat.mtime);
            const diffDays = Math.floor((now - fileDate) / (1000 * 60 * 60 * 24));
            
            if (diffDays > config.keepLogsForDays) {
                fs.unlinkSync(filePath);
                console.log(`Deleted old log file: ${file}`);
            }
        });
    } catch (error) {
        console.error('Error cleaning up old logs:', error);
    }
}

// Function to run the balance scanner
function runBalanceScanner() {
    // Create log file name with timestamp
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const logFile = path.join(config.logDir, `balance-scan-${timestamp}.log`);
    
    // Create log file stream
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    
    console.log(`Starting balance scan at ${new Date().toLocaleString()}`);
    console.log(`Logging to: ${logFile}`);
    
    // Write header to log file
    logStream.write(`===== BALANCE SCAN STARTED AT ${new Date().toLocaleString()} =====\n\n`);
    
    // Prepare arguments for scanner
    const args = [config.scannerScript];
    if (chainOption) {
        args.push(chainOption);
    }
    
    // Spawn balance scanner process
    const scanner = spawn('node', args);
    
    // Handle process output
    scanner.stdout.on('data', (data) => {
        const output = data.toString();
        logStream.write(output);
        console.log(output.trim());
    });
    
    scanner.stderr.on('data', (data) => {
        const output = data.toString();
        logStream.write(`ERROR: ${output}`);
        console.error(`ERROR: ${output.trim()}`);
    });
    
    // Handle process completion
    scanner.on('close', (code) => {
        logStream.write(`\n===== BALANCE SCAN COMPLETED WITH CODE ${code} AT ${new Date().toLocaleString()} =====\n`);
        logStream.end();
        
        console.log(`Balance scan completed with code ${code}`);
        
        // Clean up old logs after each run
        cleanupOldLogs();
    });
}

// Function to check if current time matches any scheduled time
function isScheduledTime() {
    if (config.scheduledTimes.length === 0) return false;
    
    const now = new Date();
    const currentHour = now.getHours().toString().padStart(2, '0');
    const currentMinute = now.getMinutes().toString().padStart(2, '0');
    const currentTime = `${currentHour}:${currentMinute}`;
    
    return config.scheduledTimes.some(time => {
        // Check if current time is within 1 minute of scheduled time
        const [scheduledHour, scheduledMinute] = time.split(':');
        const scheduled = new Date();
        scheduled.setHours(parseInt(scheduledHour, 10));
        scheduled.setMinutes(parseInt(scheduledMinute, 10));
        
        const diff = Math.abs(now - scheduled);
        return diff < 60000; // Within 1 minute
    });
}

// Main scheduler loop
function scheduler() {
    const now = new Date();
    console.log(`Scheduler check at: ${now.toLocaleString()}`);
    
    // Track last run time
    if (!scheduler.lastRun) {
        scheduler.lastRun = new Date(0);
    }
    
    // Check if it's time to run based on interval
    const minutesSinceLastRun = Math.floor((now - scheduler.lastRun) / (1000 * 60));
    const shouldRunByInterval = minutesSinceLastRun >= config.checkIntervalMinutes;
    
    // Check if it's a scheduled time
    const shouldRunBySchedule = isScheduledTime();
    
    // Run if either condition is met
    if (shouldRunByInterval || shouldRunBySchedule) {
        runBalanceScanner();
        scheduler.lastRun = now;
    } else {
        // If approaching a scheduled time, don't run by interval
        const nextScheduledRunInMinutes = config.scheduledTimes.reduce((closest, time) => {
            const [hour, minute] = time.split(':').map(num => parseInt(num, 10));
            const scheduledTime = new Date(now);
            scheduledTime.setHours(hour, minute, 0, 0);
            
            // If scheduled time is in the past, add a day
            if (scheduledTime < now) {
                scheduledTime.setDate(scheduledTime.getDate() + 1);
            }
            
            const minutesUntilRun = Math.floor((scheduledTime - now) / (1000 * 60));
            return minutesUntilRun < closest ? minutesUntilRun : closest;
        }, Infinity);
        
        if (nextScheduledRunInMinutes < 10) {
            console.log(`Waiting for scheduled run in ${nextScheduledRunInMinutes} minutes`);
        } else {
            console.log(`Next run by interval in ${config.checkIntervalMinutes - minutesSinceLastRun} minutes`);
        }
    }
}

// Run the scheduler immediately on startup
console.log(`Starting balance scanner scheduler`);
console.log(`Interval: ${config.checkIntervalMinutes} minutes`);
console.log(`Scheduled times: ${config.scheduledTimes.length > 0 ? config.scheduledTimes.join(', ') : 'None'}`);
if (chainOption) {
    console.log(`Chain filter: ${chainOption}`);
}
console.log(`==============================================`);

// First run
scheduler();

// Then check every minute
setInterval(scheduler, 60000);

// Process handling for graceful shutdown
process.on('SIGINT', () => {
    console.log('Scheduler shutting down');
    process.exit(0);
}); 