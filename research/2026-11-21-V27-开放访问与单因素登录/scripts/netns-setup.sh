#!/usr/bin/env bash
# 在虚机里造几个“任意公网来源”：每个网络命名空间一条 veth，地址取文档保留段（RFC 5737 / RFC 3849），不做 NAT，
# 服务端看到的 remoteAddress 就是这些地址。用法：sudo bash netns-setup.sh up|down
set -euo pipefail
NS=(pub1 pub2 pub3)
V4=(203.0.113.77 198.51.100.23 192.0.2.150)
GW=(203.0.113.1 198.51.100.1 192.0.2.1)
V6=(2001:db8:77::77 2001:db8:23::23 2001:db8:150::150)
GW6=(2001:db8:77::1 2001:db8:23::1 2001:db8:150::1)
case "${1:-up}" in
  up)
    for i in 0 1 2; do
      n=${NS[$i]}
      ip netns del "$n" 2>/dev/null || true
      ip link del "veth-$n" 2>/dev/null || true
      ip netns add "$n"
      ip link add "veth-$n" type veth peer name eth0 netns "$n"
      ip addr add "${GW[$i]}/24" dev "veth-$n"
      ip -6 addr add "${GW6[$i]}/64" dev "veth-$n" nodad
      ip link set "veth-$n" up
      ip -n "$n" addr add "${V4[$i]}/24" dev eth0
      ip -n "$n" -6 addr add "${V6[$i]}/64" dev eth0 nodad
      ip -n "$n" link set eth0 up
      ip -n "$n" link set lo up
      ip -n "$n" route add default via "${GW[$i]}"
      ip -n "$n" -6 route add default via "${GW6[$i]}"
    done
    sysctl -qw net.ipv4.ip_forward=1
    ip netns list
    ;;
  down)
    for n in "${NS[@]}"; do ip netns del "$n" 2>/dev/null || true; ip link del "veth-$n" 2>/dev/null || true; done
    ;;
esac
