DepoScan Project Summary
Overview
DepoScan is a web application for monitoring cryptocurrency wallet balances and tracking deposits across multiple blockchains (Ethereum, BSC, and Solana). The system provides real-time balance scanning, deposit detection, and administrative controls.
Core Components
1. Authentication System
Admin-Only Access: Application is restricted to users with admin privileges
Firebase Authentication: Uses Firebase Auth for user management and verification
Session Management: JWT-based sessions with cookie storage (5-day expiration)
Custom Claims: Admin roles defined using Firebase custom claims
Admin User: Admin account (zain@rippleexchange.org) with special privileges
How it works:
When a user logs in, Firebase authenticates credentials, then our server verifies the token and checks for admin privileges. Session cookies store authentication state, and middleware protects all routes from unauthorized access.
2. Balance Scanning System
Enhanced Balance Scanner (enhanced-balance-scanner.js)
Multi-Chain Support: Scans Ethereum, BSC, and Solana wallets
Batch Processing: Handles large numbers of addresses efficiently
Token Detection: Identifies popular ERC20/BEP20 tokens and Solana SPL tokens
Balance Change Tracking: Detects and logs balance increases as deposits
Command-Line Interface: Supports one-time and periodic scanning modes
How it works:
The scanner connects to blockchain RPC endpoints, retrieves wallet addresses from Firebase, checks native and token balances, and updates the database. Balance increases (e.g., from 0 to 100 or 100 to 200) are automatically tracked as deposits.
Monitoring System (monitor.js)
Real-Time Monitoring: Watches blockchains for incoming transactions
Transaction Validation: Filters transactions based on monitored addresses
Deposit Detection: Records new deposits to Firebase with transaction details
How it works:
The monitor subscribes to new blocks, filters transactions to monitored addresses, validates deposits, and stores records in Firestore. It runs continuously to catch real-time transactions.
3. Backend API Server (server.js)
Express Server with Socket.IO
RESTful API Endpoints: For data retrieval and action triggering
WebSocket Support: Real-time updates for scan progress and logs
Session Management: Secure authentication with admin validation
Middleware: Route protection and Firebase integration
Key API Endpoints:
/api/deposit-history: Retrieves and filters deposit records
/api/latest-scan: Gets most recent balance data
/api/scan-balances: Initiates a new balance scan
/api/scan-status: Checks scan timing and progress
/api/auth/*: Authentication-related endpoints
How it works:
The server provides a REST API for frontend interactions while using WebSockets for real-time updates. It manages authentication, process spawning for scans, and database operations.
4. Frontend Interface
Dashboard (index.html)
Balance Display: Shows user wallets with balances across chains
Scan Controls: Initiate manual scans and view status
Real-Time Updates: Live scan progress and log streaming
Deposit History (deposits.html)
Filterable Table: Search deposits by email or wallet address
Deposit Details: Shows deposit amount, timestamp, and transaction info
Chain Indicators: Visual distinction between different blockchains
How it works:
Frontend pages communicate with the backend API and display data in user-friendly tables. Socket connections provide real-time updates without page refreshes.
5. Database Structure (Firebase Firestore)
Collections:
users: User accounts with wallet connections and email information
walletAddresses: Maps blockchain addresses to user IDs
processedDeposits: Records of all detected deposits
walletBalances: Snapshot of current wallet balances
How it works:
Firestore provides real-time data storage and retrieval. The system uses transactions to ensure data consistency, especially when recording deposits and updating balances.
6. Enhanced Features
Balance-Based Deposit Tracking
Change Detection: Any balance increase is recorded as a deposit
Threshold Control: Minimum threshold (0.000001) prevents noise from minor fluctuations
Prior Balance Recording: Stores both old and new balance values
How it works:
When a wallet's balance increases (from previous scan to current scan), the system detects the change and records it as a deposit, capturing both the amount of increase and the new balance.
Search Functionality
Email Search: Filter deposits by user email
Wallet Search: Filter by wallet address
Real-Time Filtering: Updates as you type
Clear Controls: Reset filters with one click
How it works:
Client-side filtering enhances server-side sorting for optimal performance. The search functionality applies case-insensitive pattern matching on both emails and wallet addresses.
Deployment and Management
Process Management (PM2)
Service Name: deposcan (main server) and deposcan-auto (automatic scanner)
Automatic Restart: Self-healing capability if processes crash
Log Management: Centralized logging for troubleshooting
Configuration
Environment Variables: Support for development vs. production settings
Blockchain RPC Endpoints: Configurable connection details
Scan Intervals: Customizable periodic scanning (10-minute default)
Security Features
HTTPS Support: Production environment with secure cookies
Admin Validation: Multiple checks to verify admin privileges
Cookie Security: HttpOnly flags prevent XSS attacks
Token Expiration: Time-limited authentication sessions
Implementation Notes
The balance increase detection requires at least two scans to establish baseline
Wallet addresses are normalized to ensure case-insensitive matching
All deposits are recorded with timestamps and blockchain details for auditing
Admin privileges are enforced at both client and server levels