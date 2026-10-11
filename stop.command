#!/bin/bash
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
workdesk_dir="$(cd -- "$(dirname -- "$0")" && pwd)" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo '找不到 Node.js，请检查安装。通过 npm start 启动的服务可在原终端按 Ctrl + C 停止。'
  workdesk_status=1
else
  node "$workdesk_dir/mac-launcher.mjs" stop
  workdesk_status=$?
fi
if [ "$workdesk_status" -ne 0 ] && [ -t 0 ]; then
  read -r -p '按回车关闭此窗口…' workdesk_reply
fi
exit "$workdesk_status"
