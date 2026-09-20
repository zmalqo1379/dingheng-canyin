#!/usr/bin/env bash
# ============================================================
# 鼎恒餐饮 —— 服务器一键部署脚本（Linux，无面板）
# 用法（root 身份执行）：
#   bash setup-server.sh <代码仓库地址> <域名>
# 例：
#   bash setup-server.sh https://github.com/xxx/dingheng-canyin.git www.xxx.com
# 若没有 git 仓库：先手动把整个项目目录上传到 /opt/dingheng，再执行
#   bash setup-server.sh local your-domain.com
# ============================================================
set -e

REPO="$1"
DOMAIN="${2:-_}"
APP_DIR=/opt/dingheng

if [ -z "$REPO" ]; then
  echo "用法: bash setup-server.sh <代码仓库地址|local> <域名>"
  exit 1
fi

echo ">>> [1/7] 识别系统并安装基础软件"
if [ -f /etc/os-release ]; then . /etc/os-release; OS=$ID; else OS=unknown; fi
echo "系统: $OS"

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl git nginx
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl git nginx
fi

echo ">>> [2/7] 安装 Node.js 18"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash - 2>/dev/null || \
    curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
  if command -v apt-get >/dev/null 2>&1; then apt-get install -y nodejs; else yum install -y nodejs; fi
fi
node -v; npm -v

echo ">>> [3/7] 安装进程守护 PM2"
npm install -g pm2

echo ">>> [4/7] 准备代码目录 $APP_DIR"
mkdir -p "$APP_DIR" "$APP_DIR/logs"
if [ "$REPO" = "local" ]; then
  echo "代码已手动上传，跳过拉取"
else
  if [ -d "$APP_DIR/.git" ]; then
    cd "$APP_DIR" && git pull
  else
    git clone "$REPO" "$APP_DIR"
  fi
fi
cd "$APP_DIR"

echo ">>> [5/7] 安装依赖"
npm install --omit=dev

echo ">>> [6/7] 检查环境变量文件 .env"
if [ ! -f "$APP_DIR/.env" ]; then
  echo "------------------------------------------------------------"
  echo "【需要你手动做一步】$APP_DIR/.env 不存在"
  echo "请按 deploy/生产环境.env模板.txt 的内容创建：$APP_DIR/.env"
  echo "填好 MongoDB 连接串、JWT_SECRET、开发者账号密码后再继续"
  echo "------------------------------------------------------------"
fi

echo ">>> [7/7] 配置 Nginx 并启动服务"
if [ "$DOMAIN" != "_" ]; then
  sed "s/your-domain.com/$DOMAIN/g" "$APP_DIR/deploy/nginx-dingheng.conf" > /etc/nginx/conf.d/dingheng.conf
  rm -f /etc/nginx/conf.d/default.conf 2>/dev/null || true
  nginx -t && systemctl enable nginx && systemctl restart nginx
fi

pm2 start "$APP_DIR/deploy/ecosystem.config.js"
pm2 save
pm2 startup | tail -n 1

echo "============================================================"
echo "部署完成。检查服务：pm2 status   /   查看日志：pm2 logs dingheng"
echo "本机自检：curl http://127.0.0.1:3000"
echo "============================================================"
