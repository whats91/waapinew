module.exports = {
  apps: [{
    name: 'whatsapp-api',
    script: 'src/server.js',
    instances: 1, // Single instance recommended for WhatsApp sessions
    autorestart: true,
    watch: false, // Set to true for development
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    env_development: {
      NODE_ENV: 'development',
      PORT: 3000,
      watch: true
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    // Logging configuration
    log_file: './logs/pm2-combined.log',
    out_file: './logs/pm2-out.log',
    error_file: './logs/pm2-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    
    // Process management
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    
    // Advanced PM2 features
    ignore_watch: [
      'node_modules',
      'logs',
      'sessions',
      'data',
      '.git'
    ],
    
    // Restart strategies
    min_uptime: '10s',
    max_restarts: 10,
    
    // Cron restart (optional - restart daily at 3 AM)
    // cron_restart: '0 3 * * *',
    
    // Source map support
    source_map_support: true,
    
    // Instance variables
    instance_var: 'INSTANCE_ID'
  }]
}; 