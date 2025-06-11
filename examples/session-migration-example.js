const FormData = require('form-data');
const fs = require('fs');
const axios = require('axios');

/**
 * Example: Session Migration using the WhatsApp API
 * 
 * This example demonstrates how to migrate existing session credentials
 * to your WhatsApp API without requiring re-authentication.
 */

class SessionMigrationExample {
    constructor(apiBaseUrl, authToken) {
        this.apiBaseUrl = apiBaseUrl;
        this.authToken = authToken;
        this.axios = axios.create({
            baseURL: apiBaseUrl
        });
    }

    /**
     * Migrate session with credential files
     * @param {string} senderId - Phone number (without country code +)
     * @param {string[]} credFilePaths - Array of paths to credential files
     * @param {object} options - Migration options
     * @returns {Promise<object>} Migration result
     */
    async migrateSession(senderId, credFilePaths, options = {}) {
        try {
            const {
                restartSession = true,
                overwriteExisting = false
            } = options;

            console.log(`🔄 Starting session migration for ${senderId}...`);
            
            // Create form data with files
            const formData = new FormData();
            formData.append('authToken', this.authToken);
            formData.append('senderId', senderId);
            formData.append('restartSession', restartSession.toString());
            formData.append('overwriteExisting', overwriteExisting.toString());

            // Add credential files
            for (const filePath of credFilePaths) {
                if (!fs.existsSync(filePath)) {
                    throw new Error(`Credential file not found: ${filePath}`);
                }
                
                const fileStream = fs.createReadStream(filePath);
                const fileName = filePath.split('/').pop();
                formData.append('credFiles', fileStream, fileName);
                console.log(`📎 Added credential file: ${fileName}`);
            }

            // Make the migration request
            const response = await this.axios.post('/api/migrateSession', formData, {
                headers: {
                    ...formData.getHeaders()
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            console.log('✅ Session migration completed successfully!');
            console.log(`📁 Files processed: ${response.data.data.filesProcessed}`);
            console.log(`💾 Files stored: ${response.data.data.filesStored}`);
            console.log(`❌ Files with errors: ${response.data.data.filesWithErrors}`);
            console.log(`🔄 Session restarted: ${response.data.data.sessionRestarted}`);

            if (response.data.data.errors.length > 0) {
                console.log('⚠️ Errors encountered:');
                response.data.data.errors.forEach(error => {
                    console.log(`  - ${error.fileName}: ${error.error}`);
                });
            }

            return response.data;

        } catch (error) {
            console.error('❌ Session migration failed:', error.response?.data?.message || error.message);
            throw error;
        }
    }

    /**
     * Check migration status
     * @param {string} senderId - Phone number to check
     * @returns {Promise<object>} Migration status
     */
    async getMigrationStatus(senderId) {
        try {
            console.log(`📊 Checking migration status for ${senderId}...`);
            
            const response = await this.axios.get(`/api/migrationStatus/${senderId}`, {
                params: {
                    authToken: this.authToken
                }
            });

            const status = response.data.data;
            
            console.log('📋 Migration Status:');
            console.log(`  📁 Session directory exists: ${status.sessionDirExists}`);
            console.log(`  🔐 Auth directory exists: ${status.authDirExists}`);
            console.log(`  📄 Credential files: ${status.credentialFiles.length}`);
            console.log(`  💾 Session in database: ${status.sessionInDatabase}`);
            console.log(`  🟢 Session active: ${status.sessionActive}`);

            if (status.credentialFiles.length > 0) {
                console.log('📄 Credential files found:');
                status.credentialFiles.forEach(file => {
                    console.log(`  - ${file.fileName} (${file.size} bytes) - Modified: ${file.modified}`);
                });
            }

            if (status.sessionActive && status.activeSessionInfo) {
                console.log('🔗 Active session info:');
                console.log(`  - Connected: ${status.activeSessionInfo.connected}`);
                console.log(`  - Has QR Code: ${status.activeSessionInfo.hasQRCode}`);
                console.log(`  - Has Auth Data: ${status.activeSessionInfo.hasAuthData}`);
            }

            return response.data;

        } catch (error) {
            console.error('❌ Failed to get migration status:', error.response?.data?.message || error.message);
            throw error;
        }
    }

    /**
     * Complete migration workflow
     * @param {string} senderId - Phone number
     * @param {string} oldSessionPath - Path to old session directory
     * @returns {Promise<void>}
     */
    async completeMigrationWorkflow(senderId, oldSessionPath) {
        try {
            console.log(`🚀 Starting complete migration workflow for ${senderId}`);
            
            // 1. Check if old session directory exists
            const authPath = `${oldSessionPath}/auth`;
            if (!fs.existsSync(authPath)) {
                throw new Error(`Old session auth directory not found: ${authPath}`);
            }

            // 2. Get all credential files from old session
            const authFiles = fs.readdirSync(authPath);
            const credFilePaths = authFiles.map(file => `${authPath}/${file}`);
            
            console.log(`📄 Found ${authFiles.length} credential files in old session`);

            // 3. Check current migration status
            await this.getMigrationStatus(senderId);

            // 4. Perform migration
            const migrationResult = await this.migrateSession(senderId, credFilePaths, {
                restartSession: true,
                overwriteExisting: true
            });

            // 5. Wait a bit for session to initialize
            console.log('⏱️ Waiting for session to initialize...');
            await new Promise(resolve => setTimeout(resolve, 3000));

            // 6. Check final status
            console.log('\n🔍 Final migration status:');
            await this.getMigrationStatus(senderId);

            console.log('\n🎉 Migration workflow completed successfully!');
            console.log(`📱 Session ${senderId} should now be ready to use without re-authentication.`);

        } catch (error) {
            console.error('❌ Migration workflow failed:', error.message);
            throw error;
        }
    }
}

// Example usage
async function main() {
    // Configuration
    const API_BASE_URL = 'http://localhost:3000';
    const AUTH_TOKEN = 'your-auth-token-here';
    const SENDER_ID = '1234567890'; // Phone number without country code
    const OLD_SESSION_PATH = './old-sessions/1234567890'; // Path to old session

    // Create migration client
    const migrationClient = new SessionMigrationExample(API_BASE_URL, AUTH_TOKEN);

    try {
        // Example 1: Check migration status
        console.log('=== Example 1: Check Migration Status ===');
        await migrationClient.getMigrationStatus(SENDER_ID);

        console.log('\n=== Example 2: Migrate Specific Files ===');
        // Example 2: Migrate specific credential files
        const credFiles = [
            './old-sessions/1234567890/auth/creds.json',
            './old-sessions/1234567890/auth/pre-key-1.json',
            './old-sessions/1234567890/auth/session-123456.json'
        ];
        
        // await migrationClient.migrateSession(SENDER_ID, credFiles);

        console.log('\n=== Example 3: Complete Migration Workflow ===');
        // Example 3: Complete migration workflow
        // await migrationClient.completeMigrationWorkflow(SENDER_ID, OLD_SESSION_PATH);

    } catch (error) {
        console.error('Example failed:', error.message);
    }
}

// Run example if called directly
if (require.main === module) {
    main().catch(console.error);
}

module.exports = SessionMigrationExample; 