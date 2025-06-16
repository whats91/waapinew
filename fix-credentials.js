#!/usr/bin/env node

/**
 * Credential File Fix Utility
 * 
 * This script fixes credential files that are missing required fields
 * by comparing them with the working credential structure.
 * 
 * Usage: node fix-credentials.js [sessionId]
 *        node fix-credentials.js --all (to fix all sessions)
 */

const fs = require('fs');
const path = require('path');

// Configuration
const SESSIONS_DIR = process.env.SESSION_STORAGE_PATH || './sessions';

function log(message, data = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

function fixCredentialFile(sessionId) {
    try {
        const sessionDir = path.join(SESSIONS_DIR, sessionId);
        const authDir = path.join(sessionDir, 'auth');
        const credsPath = path.join(authDir, 'creds.json');
        
        if (!fs.existsSync(credsPath)) {
            log(`❌ No credentials file found for session: ${sessionId}`);
            return false;
        }

        const credsContent = fs.readFileSync(credsPath, 'utf8');
        let creds;
        
        try {
            creds = JSON.parse(credsContent);
        } catch (parseError) {
            log(`❌ Failed to parse credentials file for ${sessionId}:`, { error: parseError.message });
            return false;
        }

        let needsUpdate = false;
        const updates = [];

        // Check and fix missing fields based on working credential structure
        
        // 1. Check for myAppStateKeyId field
        if (!creds.myAppStateKeyId) {
            // Generate a new app state key ID in the format like "AAAAAOuj"
            const keyId = 'AAAAA' + Math.random().toString(36).substring(2, 7);
            creds.myAppStateKeyId = keyId;
            needsUpdate = true;
            updates.push('Added missing myAppStateKeyId');
        }

        // 2. Check for name field in me object
        if (creds.me && !creds.me.name && creds.me.id) {
            // Extract phone number from ID and use as name
            const phoneNumber = creds.me.id.split(':')[0];
            creds.me.name = phoneNumber;
            needsUpdate = true;
            updates.push('Added missing name field in me object');
        }

        // 3. Ensure accountSyncCounter exists
        if (typeof creds.accountSyncCounter === 'undefined') {
            creds.accountSyncCounter = 1;
            needsUpdate = true;
            updates.push('Added missing accountSyncCounter');
        }

        // 4. Ensure processedHistoryMessages exists
        if (!Array.isArray(creds.processedHistoryMessages)) {
            creds.processedHistoryMessages = [];
            needsUpdate = true;
            updates.push('Added missing processedHistoryMessages array');
        }

        // 5. Ensure accountSettings exists
        if (!creds.accountSettings) {
            creds.accountSettings = { unarchiveChats: false };
            needsUpdate = true;
            updates.push('Added missing accountSettings');
        }

        // 6. Ensure registered field exists
        if (typeof creds.registered === 'undefined') {
            creds.registered = false;
            needsUpdate = true;
            updates.push('Added missing registered field');
        }

        // 7. Verify critical authentication fields
        const criticalFields = ['noiseKey', 'pairingEphemeralKeyPair', 'signedIdentityKey', 'registrationId'];
        const missingCriticalFields = criticalFields.filter(field => !creds[field]);
        
        if (missingCriticalFields.length > 0) {
            log(`❌ Session ${sessionId} is missing critical fields and cannot be fixed automatically:`, {
                missingFields: missingCriticalFields
            });
            log(`   Recommendation: Delete this session and re-scan QR code`);
            return false;
        }

        if (needsUpdate) {
            // Create backup before updating
            const backupPath = credsPath + '.backup.' + Date.now();
            fs.copyFileSync(credsPath, backupPath);
            
            // Write updated credentials
            fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2));
            
            log(`✅ Fixed credential file for session: ${sessionId}`, {
                updates: updates,
                backupCreated: path.basename(backupPath)
            });
            
            return true;
        } else {
            log(`✅ Session ${sessionId} credential file is already correct`);
            return false;
        }

    } catch (error) {
        log(`❌ Error fixing credential file for ${sessionId}:`, { error: error.message });
        return false;
    }
}

function getAllSessions() {
    try {
        if (!fs.existsSync(SESSIONS_DIR)) {
            log(`❌ Sessions directory not found: ${SESSIONS_DIR}`);
            return [];
        }

        const sessionDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name)
            .filter(name => {
                // Check if it has an auth subdirectory
                const authDir = path.join(SESSIONS_DIR, name, 'auth');
                return fs.existsSync(authDir);
            });

        return sessionDirs;
    } catch (error) {
        log(`❌ Error reading sessions directory:`, { error: error.message });
        return [];
    }
}

function main() {
    const args = process.argv.slice(2);
    
    console.log('🔧 WhatsApp Credential File Fix Utility');
    console.log('========================================\n');
    
    if (args.length === 0) {
        console.log('Usage:');
        console.log('  node fix-credentials.js [sessionId]     - Fix specific session');
        console.log('  node fix-credentials.js --all           - Fix all sessions');
        console.log('  node fix-credentials.js --list          - List all sessions\n');
        return;
    }

    const command = args[0];

    if (command === '--list') {
        const sessions = getAllSessions();
        console.log(`Found ${sessions.length} session(s):`);
        sessions.forEach(session => {
            console.log(`  📱 ${session}`);
        });
        console.log('');
        return;
    }

    if (command === '--all') {
        const sessions = getAllSessions();
        console.log(`🔍 Found ${sessions.length} session(s) to check\n`);
        
        let fixedCount = 0;
        let checkedCount = 0;
        
        for (const sessionId of sessions) {
            checkedCount++;
            const fixed = fixCredentialFile(sessionId);
            if (fixed) {
                fixedCount++;
            }
        }
        
        console.log(`\n📊 Summary:`);
        console.log(`   Sessions checked: ${checkedCount}`);
        console.log(`   Sessions fixed: ${fixedCount}`);
        console.log(`   Sessions already correct: ${checkedCount - fixedCount}`);
        
        if (fixedCount > 0) {
            console.log(`\n✅ Fixed ${fixedCount} credential file(s)!`);
            console.log(`   Restart your application to apply changes.`);
        } else {
            console.log(`\n✅ All credential files are already correct!`);
        }
        
        return;
    }

    // Fix specific session
    const sessionId = command;
    console.log(`🔍 Checking session: ${sessionId}\n`);
    
    const fixed = fixCredentialFile(sessionId);
    
    if (fixed) {
        console.log(`\n✅ Successfully fixed credential file for session: ${sessionId}`);
        console.log(`   Restart your application to apply changes.`);
    } else {
        console.log(`\nℹ️  No changes needed for session: ${sessionId}`);
    }
}

// Handle errors gracefully
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Run the script
main(); 