#!/bin/zsh
set -e
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  print '请先安装 Node.js 22 或更新版本。'
  read '?按回车关闭…'
  exit 1
fi
if curl --silent --fail http://127.0.0.1:4317/api/status >/dev/null; then
  open http://127.0.0.1:4317
  exit 0
fi
if [[ ! -d node_modules ]]; then npm ci; fi
npm run build
print '雾港正在启动。游玩时请保持此窗口打开；按 Ctrl+C 停止服务。'
(
  for attempt in {1..40}; do
    if curl --silent --fail http://127.0.0.1:4317/api/status >/dev/null; then
      open http://127.0.0.1:4317
      exit 0
    fi
    sleep 0.5
  done
) &
npm start
