// Firebase configuration - this should match your Firebase project settings
const firebaseConfig = {
    apiKey: "AIzaSyDOryM3Wo2FOar4Z8b1-VwH6d13bJTgvLY",
    authDomain: "infinitysolution-ddf7d.firebaseapp.com",
    projectId: "infinitysolution-ddf7d",
    storageBucket: "infinitysolution-ddf7d.appspot.com",
    messagingSenderId: "556237630311",
    appId: "1:556237630311:web:c78594281662f5b6d19dc2",
    measurementId: "G-K1DJ7TH9SL"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// DOM elements
const loginForm = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginButton = document.getElementById('loginButton');
const loginError = document.getElementById('loginError');

// Check if user is already logged in
auth.onAuthStateChanged(user => {
    if (user) {
        // User is signed in, send the token to server to verify
        // Don't redirect here, as it causes issues
        user.getIdToken().then(token => {
            console.log('User already authenticated in Firebase, verifying with server...');
            // Just verify the token, let the server handle redirects
            sendTokenToServer(user).catch(error => {
                console.error('Auto-verification error:', error);
            });
        });
    }
});

// After successful Firebase Authentication, send the token to our server
async function sendTokenToServer(user) {
    try {
        // Get the ID token
        const idToken = await user.getIdToken();
        console.log('Sending token to server for verification');
        
        // Send token to the server
        const response = await fetch('/api/auth/verify-token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ idToken })
        });
        
        // Check response
        if (response.status === 403) {
            // User doesn't have admin privileges
            console.error('Admin privileges required');
            throw new Error('admin_required');
        }
        
        if (!response.ok) {
            console.error('Server verification failed');
            throw new Error('Failed to verify token with server');
        }
        
        const data = await response.json();
        return data.success;
    } catch (error) {
        console.error('Error sending token to server:', error);
        if (error.message === 'admin_required') {
            throw new Error('admin_required');
        }
        return false;
    }
}

// Login form submission
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const email = emailInput.value.trim();
        const password = passwordInput.value.trim();
        
        // Disable button and show loading state
        loginButton.disabled = true;
        loginButton.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Logging in...';
        
        try {
            // Sign in with email and password
            const userCredential = await auth.signInWithEmailAndPassword(email, password);
            
            // Send token to server
            const success = await sendTokenToServer(userCredential.user);
            
            if (success) {
                // Successful login, redirect to dashboard
                window.location.href = '/';
            } else {
                throw new Error('Server verification failed');
            }
        } catch (error) {
            // Display error message
            loginError.textContent = getErrorMessage(error.code || error.message);
            loginError.style.display = 'block';
            
            // Reset button
            loginButton.disabled = false;
            loginButton.textContent = 'Login';
        }
    });
}

// Function to get a user-friendly error message
function getErrorMessage(errorCode) {
    switch (errorCode) {
        case 'auth/invalid-email':
            return 'Invalid email format.';
        case 'auth/user-disabled':
            return 'This account has been disabled.';
        case 'auth/user-not-found':
            return 'No account found with this email.';
        case 'auth/wrong-password':
            return 'Incorrect password.';
        case 'admin_required':
            return 'This account does not have admin privileges.';
        default:
            return 'An error occurred. Please try again.';
    }
}

// Logout function - can be called from other pages
function logout() {
    auth.signOut().then(() => {
        window.location.href = '/login.html';
    }).catch(error => {
        console.error('Error signing out:', error);
    });
}

// Function to check authentication status and redirect if not logged in
function checkAuth() {
    return new Promise((resolve, reject) => {
        // Verify with server directly instead of checking claims
        fetch('/api/auth/session')
            .then(response => response.json())
            .then(data => {
                if (data.authenticated) {
                    resolve(data.user);
                } else {
                    console.log('Not authenticated according to server session');
                    // Server will handle redirect
                    reject('User not authenticated');
                }
            })
            .catch(error => {
                console.error('Error checking auth status:', error);
                reject(error);
            });
    });
}

// Export auth functions for use in other scripts
window.authFunctions = {
    logout: logout,
    checkAuth: checkAuth,
    getCurrentUser: () => auth.currentUser
}; 