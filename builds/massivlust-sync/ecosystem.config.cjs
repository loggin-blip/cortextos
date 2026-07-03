module.exports = {
  apps: [{
    name: 'massivlust-sync',
    script: 'src/index.js',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production' },
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    max_restarts: 20,
    min_uptime: '30s',
  }],
};
