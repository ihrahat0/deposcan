document.addEventListener('DOMContentLoaded', function() {
    // DOM Elements
    const refreshButton = document.getElementById('refreshButton');
    const scanNowButton = document.getElementById('scanNowButton');
    const startScanButton = document.getElementById('startScanButton');
    const scanStatusDiv = document.getElementById('scanStatus');
    const scanProgressBar = document.getElementById('scanProgress');
    const scanStatusMessage = document.getElementById('scanStatusMessage');
    const balanceTableBody = document.getElementById('balanceTableBody');
    
    // Stats elements
    const ethWalletCount = document.getElementById('ethWalletCount');
    const bscWalletCount = document.getElementById('bscWalletCount');
    const solWalletCount = document.getElementById('solWalletCount');
    const ethNonZeroCount = document.getElementById('ethNonZeroCount');
    const bscNonZeroCount = document.getElementById('bscNonZeroCount');
    const solNonZeroCount = document.getElementById('solNonZeroCount');
    
    // Modal
    const scanModal = new bootstrap.Modal(document.getElementById('scanModal'));
    
    // Chain filter radios
    const chainFilterRadios = document.querySelectorAll('input[name="chainFilter"]');
    
    // Socket.io connection
    const socket = io();
    
    // Current scan ID
    let currentScanId = null;
    
    // Global data store
    let balanceData = {
        ethereum: {},
        bsc: {},
        solana: {}
    };
    
    // Initialize: Load last scan data
    loadLatestScanData();
    
    // Set up socket.io event listeners
    socket.on('scan-log', function(data) {
        if (data.scanId === currentScanId) {
            appendScanLog(data.message, data.isError);
        }
    });
    
    socket.on('scan-progress', function(data) {
        if (data.scanId === currentScanId) {
            updateScanProgress(data.progress, data.message);
        }
    });
    
    socket.on('scan-complete', function(data) {
        if (data.scanId === currentScanId) {
            if (data.status === 'completed') {
                scanCompleted(data);
            } else {
                scanFailed(data.message);
            }
        }
    });
    
    // Event Listeners
    refreshButton.addEventListener('click', loadLatestScanData);
    
    scanNowButton.addEventListener('click', function() {
        // Reset the log display
        const logContainer = document.getElementById('scanLogContainer');
        if (logContainer) logContainer.innerHTML = '';
        
        scanModal.show();
    });
    
    startScanButton.addEventListener('click', function() {
        const selectedChains = getSelectedChains();
        if (selectedChains.length === 0) {
            alert('Please select at least one chain to scan');
            return;
        }
        
        // Hide form, show progress
        document.getElementById('scanForm').style.display = 'none';
        scanStatusDiv.classList.remove('d-none');
        startScanButton.disabled = true;
        
        // Start the scan
        startBalanceScan(selectedChains);
    });
    
    // Chain filter change event
    chainFilterRadios.forEach(radio => {
        radio.addEventListener('change', function() {
            filterTableByChain(this.value);
        });
    });
    
    /**
     * Get selected chains from checkboxes
     */
    function getSelectedChains() {
        const chains = [];
        if (document.getElementById('scanEthereum').checked) chains.push('ethereum');
        if (document.getElementById('scanBsc').checked) chains.push('bsc');
        if (document.getElementById('scanSolana').checked) chains.push('solana');
        return chains;
    }
    
    /**
     * Load the latest scan data from the server
     */
    function loadLatestScanData() {
        // Show loading state
        refreshButton.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Loading...';
        refreshButton.disabled = true;
        
        fetch('/api/latest-scan')
            .then(response => {
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                return response.json();
            })
            .then(data => {
                // Store the data
                balanceData = {
                    ethereum: data.ethereumBalances || {},
                    bsc: data.bscBalances || {},
                    solana: data.solanaBalances || {}
                };
                
                // Update counts
                updateWalletCounts(data.summary);
                
                // Update table
                updateBalanceTable();
                
                // Reset button
                refreshButton.innerHTML = 'Refresh Data';
                refreshButton.disabled = false;
            })
            .catch(error => {
                console.error('Error fetching scan data:', error);
                alert('Failed to load balance data. See console for details.');
                
                // Reset button
                refreshButton.innerHTML = 'Refresh Data';
                refreshButton.disabled = false;
            });
    }
    
    /**
     * Update wallet count stats
     */
    function updateWalletCounts(summary) {
        if (!summary) return;
        
        // Update total wallet counts
        ethWalletCount.textContent = summary.ethereumAddressCount || 0;
        bscWalletCount.textContent = summary.bscAddressCount || 0;
        solWalletCount.textContent = summary.solanaAddressCount || 0;
        
        // Update non-zero counts
        ethNonZeroCount.textContent = summary.nonZeroEthereumCount || 0;
        bscNonZeroCount.textContent = summary.nonZeroBscCount || 0;
        solNonZeroCount.textContent = summary.nonZeroSolanaCount || 0;
    }
    
    /**
     * Update the balance table with current data
     */
    function updateBalanceTable() {
        // Clear existing rows
        balanceTableBody.innerHTML = '';
        
        // Get the selected chain filter
        const selectedChain = document.querySelector('input[name="chainFilter"]:checked').value;
        
        // Get balances to display based on filter
        let balancesToShow = [];
        
        if (selectedChain === 'all' || selectedChain === 'ethereum') {
            for (const [address, data] of Object.entries(balanceData.ethereum)) {
                balancesToShow.push({
                    userId: data.userId,
                    userEmail: data.userEmail || 'No email',
                    chain: 'Ethereum',
                    address: address,
                    balance: data.nativeBalance,
                    lastScanned: data.lastScanned
                });
            }
        }
        
        if (selectedChain === 'all' || selectedChain === 'bsc') {
            for (const [address, data] of Object.entries(balanceData.bsc)) {
                balancesToShow.push({
                    userId: data.userId,
                    userEmail: data.userEmail || 'No email',
                    chain: 'BSC',
                    address: address,
                    balance: data.nativeBalance,
                    lastScanned: data.lastScanned
                });
            }
        }
        
        if (selectedChain === 'all' || selectedChain === 'solana') {
            for (const [address, data] of Object.entries(balanceData.solana)) {
                balancesToShow.push({
                    userId: data.userId,
                    userEmail: data.userEmail || 'No email',
                    chain: 'Solana',
                    address: address,
                    balance: data.nativeBalance,
                    lastScanned: data.lastScanned
                });
            }
        }
        
        // Sort by balance (highest first)
        balancesToShow.sort((a, b) => b.balance - a.balance);
        
        // Add rows to table
        balancesToShow.forEach(item => {
            // Skip zero balances
            if (item.balance <= 0) return;
            
            const row = document.createElement('tr');
            
            // Determine badge class based on chain
            let badgeClass = '';
            switch (item.chain) {
                case 'Ethereum':
                    badgeClass = 'badge-eth';
                    break;
                case 'BSC':
                    badgeClass = 'badge-bsc';
                    break;
                case 'Solana':
                    badgeClass = 'badge-sol';
                    break;
            }
            
            // Format the balance to 6 decimal places
            const formattedBalance = parseFloat(item.balance).toFixed(6);
            
            // Format the date
            const formattedDate = item.lastScanned ? formatDate(item.lastScanned) : 'N/A';
            
            // Check if the userEmail is "No email" or contains "No email found" or user ID
            let displayEmail = item.userEmail;
            if (displayEmail === 'No email' || displayEmail.includes('No email found') || displayEmail.startsWith('No email found for') || displayEmail === 'Unknown') {
                displayEmail = '<span class="text-danger">No email found</span>';
            }
            
            row.innerHTML = `
                <td>${displayEmail}</td>
                <td><span class="badge ${badgeClass}">${item.chain}</span></td>
                <td class="address-cell" title="${item.address}">${item.address}</td>
                <td>${formattedBalance}</td>
                <td>${formattedDate}</td>
            `;
            
            balanceTableBody.appendChild(row);
        });
        
        // If no data to show
        if (balancesToShow.length === 0 || balanceTableBody.children.length === 0) {
            const emptyRow = document.createElement('tr');
            emptyRow.innerHTML = `
                <td colspan="5" class="text-center">No balance data available for the selected chain.</td>
            `;
            balanceTableBody.appendChild(emptyRow);
        }
    }
    
    /**
     * Filter the table by chain
     */
    function filterTableByChain(chain) {
        updateBalanceTable();
    }
    
    /**
     * Format date for display
     */
    function formatDate(dateStr) {
        if (!dateStr) return 'N/A';
        return moment(dateStr).format('MMM DD, YYYY HH:mm');
    }
    
    /**
     * Add a log to the scan log container
     */
    function appendScanLog(message, isError = false) {
        // Create log container if it doesn't exist
        let logContainer = document.getElementById('scanLogContainer');
        if (!logContainer) {
            logContainer = document.createElement('div');
            logContainer.id = 'scanLogContainer';
            logContainer.className = 'scan-logs mt-3 border p-2 bg-light';
            logContainer.style.maxHeight = '200px';
            logContainer.style.overflowY = 'auto';
            logContainer.style.fontSize = '0.8rem';
            logContainer.style.fontFamily = 'monospace';
            scanStatusDiv.appendChild(logContainer);
        }
        
        // Create log entry
        const logEntry = document.createElement('div');
        logEntry.className = isError ? 'text-danger' : '';
        
        // Clean the message and wrap it
        let cleanedMessage = message.replace(/\n/g, '<br>');
        
        // Add timestamp
        const timestamp = new Date().toLocaleTimeString();
        logEntry.innerHTML = `<span class="text-muted">[${timestamp}]</span> ${cleanedMessage}`;
        
        // Add to container
        logContainer.appendChild(logEntry);
        
        // Auto-scroll to bottom
        logContainer.scrollTop = logContainer.scrollHeight;
    }
    
    /**
     * Start a balance scan for the selected chains
     */
    function startBalanceScan(chains) {
        // Update progress bar and message
        updateScanProgress(5, 'Initiating scan...');
        
        // Create comma-separated chain list
        const chainParam = chains.join(',');
        
        // Start the scan
        fetch(`/api/scan-balances?chains=${chainParam}`)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to start scan');
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    // Store the scan ID
                    currentScanId = data.scanId;
                    
                    // Join the Socket.io room for this scan
                    socket.emit('join-scan', currentScanId);
                    
                    // Start polling for scan status in case WebSockets aren't supported
                    pollScanStatus(data.scanId);
                    
                    // Log start
                    appendScanLog(`Scan started - ID: ${data.scanId}`);
                    appendScanLog(`Scanning chains: ${chainParam}`);
                } else {
                    throw new Error(data.message || 'Failed to start scan');
                }
            })
            .catch(error => {
                console.error('Error starting scan:', error);
                scanFailed(error.message);
            });
    }
    
    /**
     * Poll for scan status
     */
    function pollScanStatus(scanId) {
        let pollCount = 0;
        const maxPolls = 120; // Maximum number of polls (timeout after 10 minutes)
        
        const pollInterval = setInterval(() => {
            pollCount++;
            
            if (pollCount > maxPolls) {
                clearInterval(pollInterval);
                scanFailed('Scan timed out. It may still be running in the background.');
                return;
            }
            
            // Check scan status
            fetch(`/api/scan-status?id=${scanId}`)
                .then(response => response.json())
                .then(data => {
                    if (data.status === 'completed') {
                        clearInterval(pollInterval);
                        scanCompleted(data);
                    } else if (data.status === 'failed') {
                        clearInterval(pollInterval);
                        scanFailed(data.message || 'Scan failed');
                    } else {
                        // Update progress
                        updateScanProgress(
                            data.progress || (Math.min(80, pollCount * 2)),
                            data.message || 'Scan in progress...'
                        );
                        
                        // If we have recent logs and no existing logs displayed, show them
                        const logContainer = document.getElementById('scanLogContainer');
                        if (!logContainer && data.recentLogs && data.recentLogs.length > 0) {
                            data.recentLogs.forEach(log => {
                                appendScanLog(log);
                            });
                        }
                    }
                })
                .catch(error => {
                    console.error('Error checking scan status:', error);
                    // Don't clear interval, try again next time
                });
        }, 5000); // Check every 5 seconds
    }
    
    /**
     * Update scan progress UI
     */
    function updateScanProgress(percentage, message) {
        scanProgressBar.style.width = `${percentage}%`;
        scanStatusMessage.textContent = message;
    }
    
    /**
     * Handle scan completion
     */
    function scanCompleted(data) {
        updateScanProgress(100, 'Scan completed successfully!');
        appendScanLog('Scan completed successfully!');
        
        // Wait 2 seconds then close modal and reload data
        setTimeout(() => {
            scanModal.hide();
            resetScanModal();
            loadLatestScanData();
        }, 2000);
    }
    
    /**
     * Handle scan failure
     */
    function scanFailed(message) {
        updateScanProgress(100, `Scan failed: ${message}`);
        appendScanLog(`Scan failed: ${message}`, true);
        
        scanProgressBar.classList.remove('bg-primary');
        scanProgressBar.classList.add('bg-danger');
        
        // Enable the close button
        startScanButton.disabled = false;
        startScanButton.textContent = 'Close';
        startScanButton.classList.remove('btn-primary');
        startScanButton.classList.add('btn-secondary');
        
        startScanButton.addEventListener('click', function closeHandler() {
            scanModal.hide();
            resetScanModal();
            startScanButton.removeEventListener('click', closeHandler);
        }, { once: true });
    }
    
    /**
     * Reset scan modal to initial state
     */
    function resetScanModal() {
        document.getElementById('scanForm').style.display = 'block';
        scanStatusDiv.classList.add('d-none');
        scanProgressBar.style.width = '0%';
        scanStatusMessage.textContent = 'Preparing scan...';
        scanProgressBar.classList.remove('bg-danger');
        scanProgressBar.classList.add('bg-primary');
        startScanButton.disabled = false;
        startScanButton.textContent = 'Start Scan';
        startScanButton.classList.remove('btn-secondary');
        startScanButton.classList.add('btn-primary');
        
        // Remove log container
        const logContainer = document.getElementById('scanLogContainer');
        if (logContainer) {
            logContainer.remove();
        }
        
        // Reset current scan ID
        currentScanId = null;
    }
}); 