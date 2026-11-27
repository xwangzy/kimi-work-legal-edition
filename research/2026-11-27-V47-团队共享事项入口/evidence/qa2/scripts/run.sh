#!/bin/zsh
# run.sh <vite端口> <脚本名>
S=/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/0d6e0c1f-ceda-4025-9dcf-13a576f15bc5/scratchpad/tools
R="/Users/wangzeyu/Documents/Coding/Kimi Work Legal/.claude/worktrees/kimi-legal-b72/research/2026-11-27-V47-团队共享事项入口"
node $S/pw.mjs "$R/evidence/qa2" $S/qa14w/$2 http://127.0.0.1:$1/ ${VW:-1440} ${VH:-900}
