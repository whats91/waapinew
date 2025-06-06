const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'whatsapp-api' },
    transports: [
        // Write all logs to combined.log
        new winston.transports.File({ 
            filename: path.join(logsDir, 'error.log'), 
            level: 'error' 
        }),
        new winston.transports.File({ 
            filename: path.join(logsDir, 'combined.log') 
        }),
        // Separate log for sessions
        new winston.transports.File({ 
            filename: path.join(logsDir, 'sessions.log'),
            level: 'info'
        })
    ]
});

// If we're not in production, log to the console with a simple format
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        )
    }));
}

// Custom methods for different types of logging
logger.session = (sessionId, message, meta = {}) => {
    logger.info(message, { sessionId, ...meta, type: 'session' });
};

logger.webhook = (sessionId, message, meta = {}) => {
    logger.info(message, { sessionId, ...meta, type: 'webhook' });
};

logger.api = (endpoint, message, meta = {}) => {
    logger.info(message, { endpoint, ...meta, type: 'api' });
};

logger.baileys = (sessionId, message, meta = {}) => {
    logger.info(message, { sessionId, ...meta, type: 'baileys' });
};

module.exports = logger; 