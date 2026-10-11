#!/bin/bash
# Finder starts with a minimal PATH; support the standard Node and Homebrew paths.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
workdesk_dir="$(cd -- "$(dirname -- "$0")" && pwd)" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo '需要 Node.js 22 或更新版本。请从 https://nodejs.org 安装 LTS 版本，再重新打开 start.command。'
  workdesk_status=1
else
  node "$workdesk_dir/mac-launcher.mjs" start
  workdesk_status=$?
fi
if [ "$workdesk_status" -ne 0 ] && [ -t 0 ]; then
  read -r -p '按回车关闭此窗口…' workdesk_reply
fi
exit "$workdesk_status"
