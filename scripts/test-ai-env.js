const { main } = require('../server/index.js');
const { io } = require('socket.io-client');

main().then(({ app, base }) => {
  const sock = io(base, { transports: ['websocket'] });
  let phase = 0; // 0=manual vars, 1=ai analyze env, 2=ai inspect/read
  let chatDone = false;

  sock.on('connect', () => {
    setTimeout(() => { runPhase(); }, 500);
  });

  function runPhase() {
    if (phase === 0) {
      console.log('— [1] 手动执行代码建立变量…');
      sock.emit('execute', { id: 'e1', code: 'df <- data.frame(id=1:6, group=c("A","B","A","B","A","B"), bmi=c(22,27,25,31,23,29)); cat("手动输出: 数据共", nrow(df), "行\\n")' });
    } else if (phase === 1) {
      console.log('— [2] 问 AI：分析环境里的 df (验证 AI 读取环境变量)…');
      sock.emit('chat', { id: 'c1', text: '不用新建数据，直接分析当前 R 环境里已经存在的 df 这组数据的 BMI 情况' });
    } else if (phase === 2) {
      console.log('— [3] 问 AI：读取 df 完整内容 (验证 <r_inspect>)…');
      sock.emit('chat', { id: 'c2', text: '请读取 df 的完整内容和结构，并说明它有几列' });
    }
  }

  sock.on('exec_result', (r) => {
    phase = 1; console.log('   手动执行 ok:', r.ok, '| 输出:', JSON.stringify(r.output), '| 变量:', r.variables.map(v=>v.name).join(','));
    runPhase();
  });

  sock.on('variables', () => {});

  sock.on('ai', (ev) => {
    if (ev.id === 'c1' || ev.id === 'c2') traceAi(ev);
  });

  function traceAi(ev) {
    switch (ev.type) {
      case 'r_code_start':
        console.log('  ▶ ⬢ R 代码: ' + String(ev.code).replace(/\s+/g,' ').slice(0,60));
        break;
      case 'inspect_start':
        console.log('  ▶ 👁 读取变量: ' + String(ev.expr).slice(0,50));
        break;
      case 'inspect_result':
        console.log('    ← 读取内容: ' + String(ev.ok?ev.content:ev.error).replace(/\s+/g,' ').slice(0,80));
        break;
      case 'done':
        if (ev.id === 'c1' && !chatDone) { chatDone = true; phase = 2; console.log('— [1st] AI 完成，进入下一步\n'); runPhase(); }
        else if (ev.id === 'c2') { console.log('— ✅ 全部对话完成'); sock.close(); app.close().then(()=>process.exit(0)); }
        break;
      case 'error':
        console.log('— ❌ AI 错误: ' + String(ev.message).slice(0,120), '| id=', ev.id);
        break;
    }
  }

  setTimeout(() => { console.log('TIMEOUT'); sock.close(); process.exit(1); }, 200000);
});
