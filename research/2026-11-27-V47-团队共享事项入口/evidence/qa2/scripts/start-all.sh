#!/bin/zsh
S=/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/0d6e0c1f-ceda-4025-9dcf-13a576f15bc5/scratchpad/tools
cd $S
i=0
for x in a b c d; do
  n=$((5911+i)); b=$((8011+i))
  nohup node lawyer.mjs kimi-legal-b72 qa14-$x $n $b > qa14-$x.log 2>&1 &
  echo $! > qa14-$x.pid
  echo "started qa14-$x pid $(cat qa14-$x.pid) $(date +%T)"
  i=$((i+1))
  [ $x != d ] && sleep 25
done
