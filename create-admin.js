const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

async function createAdminUser() {
  try {
    // Create the user with email and password
    const userRecord = await admin.auth().createUser({
      email: 'zain@rippleexchange.org',
      password: 'tttt5555R@$4',
      displayName: 'Ripple Admin'
    });
    
    console.log('Admin user created successfully:', userRecord.uid);
    
    // Set custom claims for admin role
    await admin.auth().setCustomUserClaims(userRecord.uid, {
      admin: true
    });
    
    console.log('Admin role assigned successfully');
    
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      console.log('Admin user already exists. Updating admin privileges...');
      
      try {
        // Find the user by email
        const userRecord = await admin.auth().getUserByEmail('zain@rippleexchange.org');
        
        // Set custom claims for admin role
        await admin.auth().setCustomUserClaims(userRecord.uid, {
          admin: true
        });
        
        console.log('Admin role assigned successfully to existing user');
      } catch (secondError) {
        console.error('Error updating existing user:', secondError);
      }
    } else {
      console.error('Error creating admin user:', error);
    }
  }
}

createAdminUser()
  .then(() => {
    console.log('Admin user setup completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('Admin user setup failed:', error);
    process.exit(1);
  }); 