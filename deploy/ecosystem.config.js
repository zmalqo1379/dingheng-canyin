// PM2 进程守护配置：服务崩了自动重启，服务器重启后自动拉起
// 使用：pm2 start deploy/ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'dingheng',
      script: './server.js',
      cwd: '/opt/dingheng',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '700M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: '/opt/dingheng/logs/err.log',
      out_file: '/opt/dingheng/logs/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss'
    }
  ]
};
