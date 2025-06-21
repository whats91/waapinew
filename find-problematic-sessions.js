#!/usr/bin/env node

/**
 * Find All Sessions with Problematic User IDs
 * 
 * This script finds sessions that might be causing webhook failures
 * due to numeric user_id values or other data type issues.
 */

const path = require('path');
const Database = require('./src/database/db');

async function findProblematicSessions() {
    console.log('🔍 Searching for sessions with problematic user_id values...');
    
    try {
        // Initialize database (connects automatically)
        const database = new Database();
        
        // Give database time to initialize
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Get all sessions
        const sessions = await new Promise((resolve, reject) => {
            database.db.all(
                'SELECT * FROM sessions ORDER BY created_at DESC',
                [],
                (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows);
                    }
                }
            );
        });
        
        console.log(`📊 Found ${sessions.length} total sessions`);
        console.log('');
        
        // Analyze each session
        const problematicSessions = [];
        const webhookEnabledSessions = [];
        
        sessions.forEach((session, index) => {
            const userIdType = typeof session.user_id;
            const isNumeric = !isNaN(session.user_id) && session.user_id !== null;
            const isProblematic = (userIdType === 'number') || (session.user_id === '2') || (session.user_id === 2);
            
            console.log(`[${index + 1}] Session: ${session.session_id}`);
            console.log(`    user_id: ${session.user_id} (${userIdType})`);
            console.log(`    webhook_status: ${session.webhook_status}`);
            console.log(`    webhook_url: ${session.webhook_url ? 'SET' : 'NULL'}`);
            console.log(`    status: ${session.status}`);
            console.log(`    created: ${session.created_at}`);
            
            if (isProblematic) {
                console.log(`    ⚠️  PROBLEMATIC: user_id could cause webhook errors`);
                problematicSessions.push(session);
            }
            
            if (session.webhook_status && session.webhook_url) {
                console.log(`    🔗 WEBHOOK ENABLED`);
                webhookEnabledSessions.push(session);
            }
            
            console.log('');
        });
        
        // Summary
        console.log('📋 SUMMARY:');
        console.log(`   Total sessions: ${sessions.length}`);
        console.log(`   Webhook-enabled: ${webhookEnabledSessions.length}`);
        console.log(`   Problematic user_id: ${problematicSessions.length}`);
        console.log('');
        
        if (problematicSessions.length > 0) {
            console.log('🚨 SESSIONS NEEDING FIXES:');
            problematicSessions.forEach(session => {
                console.log(`   ${session.session_id}: user_id = ${session.user_id} (${typeof session.user_id})`);
            });
            console.log('');
        }
        
        if (webhookEnabledSessions.length > 0) {
            console.log('🔗 WEBHOOK-ENABLED SESSIONS:');
            webhookEnabledSessions.forEach(session => {
                const userIdType = typeof session.user_id;
                const isPotentialProblem = (userIdType === 'number') || (session.user_id === '2') || (session.user_id === 2);
                console.log(`   ${session.session_id}: user_id = ${session.user_id} (${userIdType}) ${isPotentialProblem ? '⚠️' : '✅'}`);
            });
            console.log('');
        }
        
        // Check for the specific error pattern
        const suspiciousSessions = sessions.filter(s => 
            (s.user_id === 2 || s.user_id === '2') && s.webhook_status && s.webhook_url
        );
        
        if (suspiciousSessions.length > 0) {
            console.log('🎯 LIKELY CULPRITS (user_id = 2 with webhooks enabled):');
            suspiciousSessions.forEach(session => {
                console.log(`   ${session.session_id}: This session is likely causing the webhook errors!`);
            });
        } else {
            console.log('🤔 No obvious culprits found. The webhook error might be coming from:');
            console.log('   1. A session that was recently deleted');
            console.log('   2. A temporary session during QR code generation');
            console.log('   3. API test calls with incorrect parameters');
        }
        
        database.close();
        console.log('🎉 Analysis completed!');
        
    } catch (error) {
        console.error('❌ Error analyzing sessions:', error);
        process.exit(1);
    }
}

// Run the analysis
if (require.main === module) {
    findProblematicSessions();
} 