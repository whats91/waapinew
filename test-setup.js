#!/usr/bin/env node

/**
 * Test script to verify WhatsApp API setup and debug issues
 */

require('dotenv').config();

console.log('🧪 WhatsApp API Setup Test');
console.log('=========================\n');

// Test 1: Environment Variables
console.log('1. Environment Variables:');
console.log(`   PORT: ${process.env.PORT || 'not set (will use 3000)'}`);
console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'not set (will use development)'}`);
console.log(`   DB_PATH: ${process.env.DB_PATH || 'not set (will use ./data/whatsapp_sessions.db)'}`);
console.log(`   SESSION_STORAGE_PATH: ${process.env.SESSION_STORAGE_PATH || 'not set (will use ./sessions)'}`);
console.log(`   MAX_CONCURRENT_SESSIONS: ${process.env.MAX_CONCURRENT_SESSIONS || 'not set (will use 100)'}`);
console.log('');

// Test 2: Required Dependencies
console.log('2. Checking Dependencies:');
const dependencies = [
    '@whiskeysockets/baileys',
    'express',
    'sqlite3',
    'dotenv',
    'cors',
    'multer',
    'qrcode',
    'axios',
    'winston',
    'uuid',
    'mime-types'
];

dependencies.forEach(dep => {
    try {
        require.resolve(dep);
        console.log(`   ✅ ${dep}`);
    } catch (error) {
        console.log(`   ❌ ${dep} - NOT FOUND`);
    }
});
console.log('');

// Test 3: Directory Structure
console.log('3. Checking Directory Structure:');
const fs = require('fs');
const path = require('path');

const directories = [
    './src',
    './src/database',
    './src/services',
    './src/routes',
    './src/utils'
];

directories.forEach(dir => {
    if (fs.existsSync(dir)) {
        console.log(`   ✅ ${dir}`);
    } else {
        console.log(`   ❌ ${dir} - NOT FOUND`);
    }
});
console.log('');

// Test 4: Database Connection
console.log('4. Testing Database Connection:');
try {
    const Database = require('./src/database/db');
    const db = new Database('./test_db.db');
    console.log('   ✅ Database connection successful');
    
    // Cleanup test database
    setTimeout(() => {
        db.close();
        if (fs.existsSync('./test_db.db')) {
            fs.unlinkSync('./test_db.db');
        }
    }, 1000);
    
} catch (error) {
    console.log(`   ❌ Database connection failed: ${error.message}`);
}
console.log('');

// Test 5: Logger
console.log('5. Testing Logger:');
try {
    const logger = require('./src/utils/logger');
    logger.info('Test log message');
    console.log('   ✅ Logger working');
} catch (error) {
    console.log(`   ❌ Logger failed: ${error.message}`);
}
console.log('');

// Test 6: Session Manager
console.log('6. Testing Session Manager (basic initialization):');
try {
    // Set environment variables for test
    process.env.DB_PATH = './test_sessions.db';
    process.env.SESSION_STORAGE_PATH = './test_sessions';
    
    const SessionManager = require('./src/services/session-manager');
    const sessionManager = new SessionManager();
    console.log('   ✅ Session Manager created');
    
    // Cleanup
    setTimeout(() => {
        sessionManager.cleanup().then(() => {
            if (fs.existsSync('./test_sessions.db')) {
                fs.unlinkSync('./test_sessions.db');
            }
            if (fs.existsSync('./test_sessions')) {
                fs.rmSync('./test_sessions', { recursive: true, force: true });
            }
        }).catch(() => {});
    }, 2000);
    
} catch (error) {
    console.log(`   ❌ Session Manager failed: ${error.message}`);
}
console.log('');

// Test 7: Node.js Version
console.log('7. Node.js Version Check:');
const nodeVersion = process.version;
const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);

if (majorVersion >= 16) {
    console.log(`   ✅ Node.js ${nodeVersion} (supported)`);
} else {
    console.log(`   ⚠️  Node.js ${nodeVersion} (minimum v16 recommended)`);
}
console.log('');

console.log('🏁 Test Complete!');
console.log('');
console.log('📋 Next Steps:');
console.log('1. Copy config.env to .env: cp config.env .env');
console.log('2. Start the server: npm start or npm run dev');
console.log('3. Check health: curl http://localhost:3000/health');
console.log('4. View API docs: curl http://localhost:3000/');
console.log(''); 