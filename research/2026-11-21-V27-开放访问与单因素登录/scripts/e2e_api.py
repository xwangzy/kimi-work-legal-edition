#!/usr/bin/env python3
"""虚机内的真实接口演练（第 53 批）。只打印状态码与错误码；密码、设置码、令牌只存在 /root/kwl-e2e（0600），不打印。
用法（在网络命名空间里跑即以该地址为来源）：
  python3 e2e_api.py staff-setup            # 管理员复核后建 viewer / operator / issuer 三位人员并设密码
  python3 e2e_api.py security               # 安全回归：未登录、越权、复核、410、锁定、CORS
  python3 e2e_api.py ratelimit              # 本来源连发 25 次登录尝试，看第几次 429
  python3 e2e_api.py login <邮箱>           # 只登录一次
"""
import json, os, ssl, sys, urllib.request, urllib.error, secrets, string, time

for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
    os.environ.pop(k, None)
IP = os.environ.get("KWL_IP", "192.168.64.20")
CP = f"https://{IP}:8443"
CA = "/etc/kwl/public/demo-ca.crt"
DIR = "/root/kwl-e2e"
ADMIN = "admin@kwl-demo.example"
CTX = ssl.create_default_context(cafile=CA)
os.makedirs(DIR, mode=0o700, exist_ok=True)


def req(method, path, body=None, token=None, headers=None, base=CP):
    h = {"content-type": "application/json"} if body is not None else {}
    if token:
        h["authorization"] = f"Bearer {token}"
    h.update(headers or {})
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(base + path, data=data, method=method, headers=h)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=CTX))
    try:
        with opener.open(r, timeout=20) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {}), dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            j = json.loads(raw)
        except Exception:
            j = {}
        return e.code, j, dict(e.headers)


def err(j):
    e = j.get("error")
    return e.get("code") if isinstance(e, dict) else e


def pw_of(email):
    return open(f"{DIR}/{email}.pw").read().strip()


def save_pw(email, pw):
    p = f"{DIR}/{email}.pw"
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, pw.encode())
    os.close(fd)


def new_pw():
    return "Kwl" + secrets.token_hex(8) + "Aa9"


def login(email, pw=None):
    s, j, _ = req("POST", "/v1/auth/login", {"email": email, "password": pw if pw is not None else pw_of(email), "client": {"platform": "web"}})
    return s, j


def token(email, reauth=True):
    s, j = login(email)
    assert s == 200 and "session_token" in j, (email, s, err(j))
    t = j["session_token"]
    if reauth:
        s2, j2, _ = req("POST", "/v1/auth/reauth", {"password": pw_of(email)}, t)
        assert s2 == 200, (s2, err(j2))
    return t


def line(label, ok, detail=""):
    print(f"{'✓' if ok else '✗'} {label}{('：' + detail) if detail else ''}")
    return ok


def staff_setup():
    t = token(ADMIN)
    people = {"viewer@kwl-demo.example": ("只读演示", ["viewer"]), "operator@kwl-demo.example": ("客户运营演示", ["operator"]), "issuer@kwl-demo.example": ("开通专员演示", ["issuer"]), "lockme@kwl-demo.example": ("锁定演练", ["viewer"])}
    s, j, _ = req("GET", "/v1/ops/staff", token=t)
    have = {x["email"]: x for x in j.get("staff", [])}
    for email, (name, roles) in people.items():
        if email in have:
            s, j, _ = req("POST", f"/v1/ops/staff/{have[email]['aid']}/reset", {}, t)
        else:
            s, j, _ = req("POST", "/v1/ops/staff", {"email": email, "name": name, "roles": roles}, t)
        code = j.get("setup_code")
        pw = new_pw()
        s2, j2, _ = req("POST", "/v1/auth/password-reset/confirm", {"email": email, "code": code, "password": pw})
        if s2 == 200:
            save_pw(email, pw)
        line(f"人员 {email}（{','.join(roles)}）建档并设密码", s == 200 and s2 == 200, f"{s}/{s2}")


def security():
    ok = True
    # 1 未登录
    for p in ["/v1/ops/me", "/v1/ops/tenants", "/v1/ops/staff", "/v1/auth/me", "/v1/firm/members", "/v1/me/usage"]:
        s, j, _ = req("GET", p)
        ok &= line(f"未登录 GET {p}", s == 401, f"{s} {err(j)}")
    # 2 两步验证接口已取消
    for p in ["/v1/auth/mfa/verify", "/v1/auth/mfa/totp/setup"]:
        s, j, _ = req("POST", p, {"mfa_token": "kwm1.x", "code": "123456"})
        ok &= line(f"POST {p}", s == 410 and err(j) == "mfa_removed", f"{s} {err(j)}")
    # 3 账号密码登录：直接完整会话
    s, j = login(ADMIN)
    ok &= line("系统管理员账号密码登录", s == 200 and "session_token" in j and "mfa_required" not in j and "restricted" not in j.get("session", {}), f"{s} kind={j.get('kind')} restricted={'restricted' in j.get('session', {})} mfa_required={'mfa_required' in j}")
    ta = j.get("session_token")
    s, j = login(ADMIN, "Wrong2026password0")
    ok &= line("密码错", s == 401 and err(j) == "auth_invalid", f"{s} {err(j)}")
    # 4 危险操作先要密码复核
    s, j, _ = req("POST", "/v1/ops/staff", {"email": "tmp@kwl-demo.example", "name": "x", "roles": ["viewer"]}, ta)
    ok &= line("未复核做危险操作（建人员）", s == 401 and err(j) == "reauth_required", f"{s} {err(j)}")
    s, j, _ = req("POST", "/v1/auth/reauth", {"password": "Wrong2026password0"}, ta)
    ok &= line("复核密码错", s == 401 and err(j) == "reauth_invalid", f"{s} {err(j)}")
    s, j, _ = req("POST", "/v1/auth/reauth", {"password": pw_of(ADMIN)}, ta)
    ok &= line("复核（只要密码）", s == 200, f"{s}")
    # 5 越权
    tv = token("viewer@kwl-demo.example")
    s, j, _ = req("GET", "/v1/ops/staff", token=tv)
    ok &= line("只读人员看人员管理", s == 403 and err(j) == "perm_denied", f"{s} {err(j)}")
    s, j, _ = req("POST", "/v1/ops/staff", {"email": "evil@kwl-demo.example", "name": "x", "roles": ["sysadmin"]}, tv)
    ok &= line("只读人员（已复核）建系统管理员", s == 403, f"{s} {err(j)}")
    s, j, _ = req("POST", "/v1/ops/tenants", {"tid": "ten_evil", "name": "x", "edition": "team", "seats": 1}, tv)
    ok &= line("只读人员开通律所", s == 403 and err(j) == "perm_denied", f"{s} {err(j)}")
    ti = token("issuer@kwl-demo.example")
    s, j, _ = req("POST", "/v1/ops/tenants", {"tid": "ten_evil2", "name": "x", "edition": "team", "seats": 1}, ti)
    ok &= line("开通专员开通律所（职责分离）", s == 403, f"{s} {err(j)}")
    s, j, _ = req("GET", "/v1/ops/overview", token=tv)
    ok &= line("只读人员看总览", s == 200, f"{s}")
    # 6 律师账号不能用平台运营与本所管理
    law = os.environ.get("KWL_LAWYER")
    if law and os.path.exists(f"{DIR}/{law}.pw"):
        s, j, _ = req("POST", "/v1/auth/login", {"email": law, "password": pw_of(law), "client": {"platform": "web"}})
        tl = j.get("session_token")
        s1, j1, _ = req("GET", "/v1/ops/tenants", token=tl)
        ok &= line("律师账号调平台运营", s == 200 and s1 == 403 and err(j1) == "staff_required", f"{s1} {err(j1)}")
        s2, j2, _ = req("GET", "/v1/firm/members", token=tl)
        ok &= line("普通律师调本所管理", s2 == 403, f"{s2} {err(j2)}")
    # 7 平台人员不能登录桌面客户端
    s, j, _ = req("POST", "/v1/auth/login", {"email": ADMIN, "password": pw_of(ADMIN), "client": {"platform": "darwin", "version": "0.2.0"}})
    ok &= line("平台人员登录桌面客户端", s == 403 and err(j) == "staff_client_forbidden", f"{s} {err(j)}")
    # 8 CORS：只对列出的控制台来源回允许头
    s, j, h = req("GET", "/v1/meta", headers={"origin": "https://evil.example"})
    ok &= line("陌生来源跨源读", "Access-Control-Allow-Origin" not in h and "access-control-allow-origin" not in {k.lower() for k in h}, f"{s} ACAO={h.get('Access-Control-Allow-Origin') or h.get('access-control-allow-origin')}")
    s, j, h = req("GET", "/v1/meta", headers={"origin": f"https://{IP}"})
    ok &= line("控制台来源跨源读", (h.get("Access-Control-Allow-Origin") or h.get("access-control-allow-origin")) == f"https://{IP}", f"{s}")
    # 9 锁定：连错 10 次 → 423，锁定期间密码对也不发会话
    codes = [login("lockme@kwl-demo.example", f"Wrong2026pass{i}")[0] for i in range(10)]
    s, j = login("lockme@kwl-demo.example")
    ok &= line("连错 10 次后用对的密码", s == 423 and err(j) == "account_locked" and "session_token" not in j, f"前 10 次 {sorted(set(codes))}，第 11 次 {s} {err(j)} retry_after_s={(j.get('error') or {}).get('retry_after_s')}")
    print("RESULT", "PASS" if ok else "FAIL")


def provision(tid, name):
    to = token("operator@kwl-demo.example")
    s, j, _ = req("POST", "/v1/ops/tenants", {"tid": tid, "name": name, "edition": "team", "seats": 5}, to)
    line(f"客户运营开通律所 {tid}", s == 200 or err(j) == "tenant_exists", f"{s} {err(j) or ''}")
    ti = token("issuer@kwl-demo.example")
    s, j, _ = req("POST", f"/v1/ops/tenants/{tid}/activation-codes", {"slug": "boss", "name": "演示主任"}, ti)
    code = j.get("code")
    if code:
        p = f"{DIR}/{tid}.code"
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, code.encode())
        os.close(fd)
    line(f"开通专员发创始开通码", s == 200 and bool(code), f"{s} {err(j) or ''} 码长 {len(code or '')}，存 {DIR}/{tid}.code")


def ratelimit():
    out = []
    for i in range(25):
        s, j = login("nobody@kwl-demo.example", "x")
        out.append(s)
    first = out.index(429) + 1 if 429 in out else None
    print(f"来源连发 25 次：{''.join('4' if s == 401 else ('R' if s == 429 else '?') for s in out)}（4=401，R=429）；首个 429 在第 {first} 次")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "security"
    if cmd == "staff-setup":
        staff_setup()
    elif cmd == "security":
        security()
    elif cmd == "provision":
        provision(sys.argv[2], sys.argv[3])
    elif cmd == "ratelimit":
        ratelimit()
    elif cmd == "login":
        s, j = login(sys.argv[2])
        print(s, err(j) or ("session" if "session_token" in j else "?"))
