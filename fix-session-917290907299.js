#!/usr/bin/env node

/**
 * Fix Session 917290907299 User ID Issue
 * 
 * This script fixes the specific session that has user_id as number 2
 * which is causing webhook failures and auto-logout.
 */

const path = require('path');
const Database = require('./src/database/db');

async function fixSession917290907299() {
    console.log('🔧 Starting fix for session 917290907299...');
    
    try {
        // Initialize database (connects automatically)
        const database = new Database();
        
        const sessionId = '917290907299';
        
        // Get current session data
        const currentSession = await database.getSession(sessionId);
        if (!currentSession) {
            console.log('❌ Session 917290907299 not found in database');
            return;
        }
        
        console.log('📊 Current session data:', {
            session_id: currentSession.session_id,
            user_id: currentSession.user_id,
            user_id_type: typeof currentSession.user_id,
            webhook_url: currentSession.webhook_url,
            webhook_status: currentSession.webhook_status
        });
        
        // Fix user_id if it's a number
        if (typeof currentSession.user_id === 'number' || currentSession.user_id === 2) {
            console.log('🔄 Fixing user_id from number to string...');
            
            // Update user_id to be the session_id (standard practice)
            const newUserId = sessionId;
            
            const result = await new Promise((resolve, reject) => {
                database.db.run(
                    'UPDATE sessions SET user_id = ? WHERE session_id = ?',
                    [newUserId, sessionId],
                    function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(this);
                        }
                    }
                );
            });
            
            if (result.changes > 0) {
                console.log('✅ Successfully updated user_id');
                console.log('📊 New session data:', {
                    session_id: sessionId,
                    user_id: newUserId,
                    user_id_type: typeof newUserId
                });
            } else {
                console.log('⚠️ No changes made to database');
            }
        } else {
            console.log('✅ user_id is already in correct format:', {
                user_id: currentSession.user_id,
                type: typeof currentSession.user_id
            });
        }
        
        // Also check for webhook issues
        if (currentSession.webhook_status && currentSession.webhook_url) {
            console.log('🔗 Webhook is enabled, this should fix the webhook errors');
        }
        
        database.close();
        console.log('🎉 Fix completed successfully!');
        
    } catch (error) {
        console.error('❌ Error fixing session:', error);
        process.exit(1);
    }
}

// Run the fix
if (require.main === module) {
    fixSession917290907299();
} 