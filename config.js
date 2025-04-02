import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore, enableMultiTabIndexedDbPersistence } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

// Firebase configuration as provided
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
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Configure auth settings
auth.useDeviceLanguage(); // Use the device's language for emails

// Initialize Firestore with proper multi-tab persistence
const db = getFirestore(app);

// Enable multi-tab persistence
// Only enable in production or when explicitly needed to avoid development issues
if (process.env.NODE_ENV === 'production') {
  enableMultiTabIndexedDbPersistence(db)
    .catch((err) => {
      console.warn('Firebase persistence could not be enabled:', err.message);
    });
}

// Initialize Firebase Storage
const storage = getStorage(app);

// Google Authentication Provider
const googleProvider = new GoogleAuthProvider();
// Set the client ID for Google Sign-In
googleProvider.setCustomParameters({
  client_id: '642484459055-r7dpg09r8ne0o92qcsdk07r8i8n63rqn.apps.googleusercontent.com',
  prompt: 'select_account'
});

export { auth, db, googleProvider, storage };

export default app; 