#!/usr/bin/env bash
# 从“任意公网来源”（网络命名空间）与虚机本机，探测控制台、登录入口与运营接口。
# 用法：sudo bash probe.sh <IP> [<人员邮箱> <密码文件>]
#   只打印状态码与错误码（不打印令牌与密码）。TLS 按演示 CA 校验（不 -k）。
set -uo pipefail
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY
IP=${1:?IP}
EMAIL=${2:-}
PWFILE=${3:-}
CA=/etc/kwl/public/demo-ca.crt
C=(curl -s -m 15 --noproxy '*' --cacert "$CA")
code() { python3 -c 'import json,sys
try:
  j=json.load(sys.stdin)
except Exception:
  print("-"); sys.exit()
e=j.get("error")
if isinstance(e,dict): print(e.get("code"))
elif isinstance(e,str): print(e)
elif "session_token" in j: print("session" + ("+restricted:"+str(j.get("session",{}).get("restricted")) if j.get("session",{}).get("restricted") else "") + (" mfa_required" if j.get("mfa_required") else ""))
elif j.get("mfa_required"): print("mfa_required")
else: print("ok")'; }
run() { # 来源标签 前缀命令...
  local tag=$1; shift
  local ex=("$@")
  local con meta login ops body
  con=$("${ex[@]}" "${C[@]}" -o /dev/null -w '%{http_code}' "https://$IP/")
  meta=$("${ex[@]}" "${C[@]}" -o /dev/null -w '%{http_code}' "https://$IP:8443/v1/meta")
  ops=$("${ex[@]}" "${C[@]}" -w ' %{http_code}' "https://$IP:8443/v1/ops/me")
  local src
  src=$("${ex[@]}" "${C[@]}" -o /dev/null -w '%{local_ip}' "https://$IP:8443/v1/meta")
  if [ -n "$EMAIL" ]; then
    body=$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":open(sys.argv[2]).read().strip(),"client":{"platform":"web"}}))' "$EMAIL" "$PWFILE")
    login=$("${ex[@]}" "${C[@]}" -H 'content-type: application/json' --data-binary @- "https://$IP:8443/v1/auth/login" <<<"$body" -w '\n%{http_code}')
    lcode=$(tail -n1 <<<"$login"); lerr=$(head -n -1 <<<"$login" | code)
  else lcode="-"; lerr="-"; fi
  printf '%-10s 来源 %-16s 控制台页 %s  /v1/meta %s  /v1/ops/me(未登录) %s(%s)  人员登录 %s(%s)\n' "$tag" "$src" "$con" "$meta" "${ops##* }" "$(sed 's/ [0-9]*$//' <<<"$ops" | code)" "$lcode" "$lerr"
}
for n in pub1 pub2 pub3; do run "$n" ip netns exec "$n"; done
run "本机" env
