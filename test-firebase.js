// Simple test script to explore Firebase structure
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Get Firestore database
const db = admin.firestore();

async function exploreFirebase() {
  console.log('===== EXPLORING FIREBASE STRUCTURE =====');
  
  try {
    // 1. List all collections
    console.log('\n1. Listing all collections:');
    const collections = await db.listCollections();
    console.log(`Found ${collections.length} collections:`);
    for (const collection of collections) {
      console.log(`- ${collection.id}`);
    }
    
    // 2. Specifically check the walletAddresses collection
    console.log('\n2. Checking walletAddresses collection:');
    const walletAddressesRef = db.collection('walletAddresses');
    const walletDocs = await walletAddressesRef.limit(5).get();
    
    if (walletDocs.empty) {
      console.log('No documents found in walletAddresses collection');
    } else {
      console.log(`Found ${walletDocs.size} documents in walletAddresses collection`);
      
      // Show the first few documents
      walletDocs.forEach((doc, i) => {
        console.log(`\nDocument ${i+1}: ID = ${doc.id}`);
        const data = doc.data();
        console.log('Data structure:', JSON.stringify(data, null, 2));
        
        // Check for wallet addresses in any field
        Object.keys(data).forEach(key => {
          if (typeof data[key] === 'object' && data[key] !== null) {
            console.log(`Found object in field "${key}":`);
            Object.keys(data[key]).forEach(subKey => {
              console.log(`  - ${subKey}: ${data[key][subKey]}`);
            });
          } else {
            console.log(`Field "${key}": ${data[key]}`);
          }
        });
      });
    }
    
    // 3. Check users collection for wallets structure
    console.log('\n3. Checking users collection for wallet information:');
    const usersRef = db.collection('users');
    const userDocs = await usersRef.limit(5).get();
    
    if (userDocs.empty) {
      console.log('No documents found in users collection');
    } else {
      console.log(`Found ${userDocs.size} documents in users collection`);
      
      // Show the first few documents
      userDocs.forEach((doc, i) => {
        console.log(`\nUser ${i+1}: ID = ${doc.id}`);
        const data = doc.data();
        
        // Check for wallet-related fields
        if (data.wallets) {
          console.log('Found wallets field:');
          Object.keys(data.wallets).forEach(chain => {
            console.log(`  - ${chain}: ${data.wallets[chain]}`);
          });
        }
        
        if (data.privateKeys) {
          console.log('Found privateKeys field:');
          Object.keys(data.privateKeys).forEach(chain => {
            console.log(`  - ${chain}: ${data.privateKeys[chain]}`);
          });
        }
        
        // Look for any field that might contain wallet addresses
        Object.keys(data).forEach(key => {
          if (typeof data[key] === 'string' && 
              (data[key].startsWith('0x') || 
               key.toLowerCase().includes('wallet') || 
               key.toLowerCase().includes('address'))) {
            console.log(`Potential wallet address in field "${key}": ${data[key]}`);
          }
        });
      });
    }

  } catch (error) {
    console.error('Error exploring Firebase:', error);
  } finally {
    process.exit(0);
  }
}

exploreFirebase(); 