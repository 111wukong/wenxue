#!/bin/bash
cd "$(dirname "$0")" || exit 1
if [ ! -f .env ]; then
  echo "还没有 .env。先执行："
  echo "  cp .env.example .env"
  echo "然后把 DEEPSEEK_API_KEY 填进去。"
  exit 1
fi
open "http://127.0.0.1:$(grep -E "^PORT=" .env | cut -d= -f2 | tr -d "[:space:]" || echo 5188)" 2>/dev/null
node server.js
