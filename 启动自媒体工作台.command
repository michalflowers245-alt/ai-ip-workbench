#!/bin/zsh
set -o pipefail
set -u

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKBENCH_URL="http://127.0.0.1:${PORT:-5177}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if /usr/bin/curl --noproxy '*' --max-time 2 -fsS "$WORKBENCH_URL/api/workbench/capabilities" 2>/dev/null | grep -q '"trimAdapter":'; then
  /usr/bin/open "$WORKBENCH_URL"
  exit $?
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 后再启动工作台。"
  exit 1
fi

if [[ ! -d "$APP_DIR/node_modules/playwright" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "缺少 Playwright 依赖，也没有找到 npm。请安装 Node.js 完整版后再启动。"
    exit 1
  fi
  echo "首次启动，正在安装工作台依赖……"
  (cd "$APP_DIR" && npm install) || {
    echo "依赖安装失败，请检查网络后在项目目录运行 npm install。"
    exit 1
  }
fi

cd "$APP_DIR" || exit 1
exec node tools/launch-workbench.mjs
