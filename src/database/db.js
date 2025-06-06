const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

class Database {
    constructor(dbPath = './data/whatsapp_sessions.db') {
        this.dbPath = dbPath;
        this.db = null;
        this.initializeDatabase();
    }

    initializeDatabase() {
        // Ensure data directory exists
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new sqlite3.Database(this.dbPath, (err) => {
            if (err) {
                console.error('Error opening database:', err.message);
                throw err;
            }
            console.log('Connected to SQLite database.');
        });

        this.createTables();
    }

    createTables() {
        const createSessionsTable = `
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                auth_token TEXT,
                status TEXT DEFAULT 'disconnected',
                auto_read BOOLEAN DEFAULT 0,
                webhook_status BOOLEAN DEFAULT 0,
                webhook_url TEXT,
                user_id TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `;

        const createEnvTable = `
            CREATE TABLE IF NOT EXISTS env (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE NOT NULL,
                value TEXT NOT NULL,
                description TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `;

        this.db.serialize(() => {
            this.db.run(createSessionsTable, (err) => {
                if (err) {
                    console.error('Error creating sessions table:', err.message);
                } else {
                    console.log('Sessions table created successfully');
                }
            });

            this.db.run(createEnvTable, (err) => {
                if (err) {
                    console.error('Error creating env table:', err.message);
                } else {
                    console.log('Env table created successfully');
                }
            });
        });
    }

    // Session operations
    async createSession(sessionData) {
        const { session_id, name, auth_token, user_id, webhook_url } = sessionData;
        
        return new Promise((resolve, reject) => {
            const stmt = this.db.prepare(`
                INSERT INTO sessions (session_id, name, auth_token, user_id, webhook_url)
                VALUES (?, ?, ?, ?, ?)
            `);
            
            stmt.run([session_id, name, auth_token, user_id, webhook_url], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
            
            stmt.finalize();
        });
    }

    async getSession(sessionId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM sessions WHERE session_id = ?',
                [sessionId],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row);
                    }
                }
            );
        });
    }

    async getSessionByAuthToken(authToken) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM sessions WHERE auth_token = ?',
                [authToken],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row);
                    }
                }
            );
        });
    }

    async updateSessionStatus(sessionId, status) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
                [status, sessionId],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes);
                    }
                }
            );
        });
    }

    async updateWebhookConfig(sessionId, webhookUrl, webhookStatus) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE sessions SET webhook_url = ?, webhook_status = ?, updated_at = CURRENT_TIMESTAMP WHERE session_id = ?',
                [webhookUrl, webhookStatus, sessionId],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes);
                    }
                }
            );
        });
    }

    async getAllSessions() {
        return new Promise((resolve, reject) => {
            this.db.all('SELECT * FROM sessions', [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async deleteSession(sessionId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM sessions WHERE session_id = ?',
                [sessionId],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes);
                    }
                }
            );
        });
    }

    // Environment operations
    async setEnvValue(key, value, description = null) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT OR REPLACE INTO env (key, value, description, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
                [key, value, description],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.lastID);
                    }
                }
            );
        });
    }

    async getEnvValue(key) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT value FROM env WHERE key = ?',
                [key],
                (err, row) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(row ? row.value : null);
                    }
                }
            );
        });
    }

    close() {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    console.error('Error closing database:', err.message);
                } else {
                    console.log('Database connection closed.');
                }
            });
        }
    }
}

module.exports = Database; 