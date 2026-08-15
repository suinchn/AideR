const { main } = require('../server/index.js');
const { io } = require('socket.io-client');

main().then(({ app, base }) => {
  const sock = io(base, { transports: ['websocket'] });
  let started = false;
  sock.on('connect', () => {
    if (started) return;
    started = true;
    console.log('— 发送 AI 请求…');
    sock.emit('chat', { id: 'c1', text: '用 R 分析：创建向量 v=c(1,2,3,4,5)，然后计算它的均值，并给出医学统计解释' });
  });
  sock.on('ai', (ev) => {
    switch (ev.type) {
      case 'segments':
        console.log('— AI 回复分块: ' + (ev.segments || []).map(s =>
          s.kind + '(' + String(s.content).replace(/\n/g, ' ').slice(0, 36) + ')').join(' , '));
        break;
      case 'r_code_start':
        console.log('  ▶ ▶执行代码: ' + String(ev.code).replace(/\s+/g, ' ').slice(0, 70));
        break;
      case 'r_exec_result':
        console.log('    → 输出: ' + String(ev.output).replace(/\s+/g, ' ').slice(0, 70),
          ev.ok ? '[ok]' : '[ERR ' + ev.error + ']');
        break;
      case 'variables':
        if (ev.variables && ev.variables.length)
          console.log('    📊 变量: ' + ev.variables.map(v => v.name + '[' + v.class + ']').join(' '));
        break;
      case 'done': console.log('— ✅ AI 完成'); sock.close(); process.exit(0); break;
      case 'error': console.log('— ❌ AI 错误: ' + String(ev.message).slice(0, 150)); sock.close(); process.exit(1); break;
      case 'max_steps': console.log('— 达步数上限'); process.exit(0); break;
      default: break;
    }
  });
  setTimeout(() => { console.log('TIMEOUT'); sock.close(); process.exit(1); }, 170000);
});
