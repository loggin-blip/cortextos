module.exports = {
  apps: [{
    name: 'massivlust-gmail-service',
    script: 'src/index.js',
    cwd: '/Users/max/cortextos/builds/massivlust-gmail-service',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production',
      PORT: '7777',
      GMAIL_API_SECRET: '7745eae7b79665fa6ac1834441dd7f401823fd34f6ea9e3dddac53fa9c6e096d',
    },
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    max_restarts: 20,
    min_uptime: '30s',
  }],
};
