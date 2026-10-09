// 超时测试用：永不输出的 worker（父进程页超时后应杀进程并报错）
process.stdin.resume();
setInterval(() => {}, 60_000);
