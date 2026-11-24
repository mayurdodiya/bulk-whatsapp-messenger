// pm2 config for running on a VPS without Docker:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'bulk-sender',
      script: 'src/server.js',
      env: { NODE_ENV: 'production', NO_OPEN: '1' },
      max_memory_restart: '1500M',
      kill_timeout: 10000,
      time: true,
    },
  ],
};
