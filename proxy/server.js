const express = require('express');
const { Pool } = require('pg');
const { execSync, exec } = require('child_process');
const multer = require('multer');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ============ POOLS ============
// Реестр-дирижабль — локальный Supabase на EU
const registry = new Pool({
  host: 'supabase-db-eu', port: 5432, database: 'postgres', user: 'postgres',
  password: process.env.REGISTRY_PG_PASS || 'postgres',
  options: '-c search_path=gromovenko'
});

// Project DBs (клиентские данные) — через socat к RU
const projectPools = {
  life: new Pool({ host: '80.249.150.234', port: 15433, database: 'postgres', user: 'postgres', password: '87e4ac14f47230d6ea1c325c2312b831', connectionTimeoutMillis: 4000 }),
  letov: new Pool({ host: '80.249.150.234', port: 15434, database: 'postgres', user: 'postgres', password: 'e6e66d2323f8c303c1e5473db77852e1', connectionTimeoutMillis: 4000 })
};

// ============ HELPERS ============
function claudeRun(prompt, cwd = '/root/gromovenko', timeout = 300000) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const child = spawn(
      'claude',
      ['--print', '--output-format', 'text', '--permission-mode', 'acceptEdits', '--model', 'claude-sonnet-4-6'],
      { cwd, env: { ...process.env, HOME: '/root' }, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();

    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Claude timeout after ${timeout}ms. Output so far: ${stdout.substring(0, 300)}`));
    }, timeout);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGTERM') return; // handled by timer
      if (code !== 0) return reject(new Error(`Claude exit ${code}: ${stderr.slice(0,300)}\n${stdout.slice(0,300)}`));
      resolve(stdout.trim().replace(/```json|```/g, '').trim());
    });
  });
}

// ============ ASYNC JOB QUEUE ============
const jobs = {};
let jobSeq = 0;
function newJob() {
  const id = `j${Date.now()}_${++jobSeq}`;
  jobs[id] = { status: 'pending', created: Date.now() };
  return id;
}
// clean up jobs older than 2h
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const id of Object.keys(jobs)) {
    if (jobs[id].created < cutoff) delete jobs[id];
  }
}, 10 * 60 * 1000);

app.get('/jobs/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

async function getProject(name) {
  const r = await registry.query('SELECT * FROM gromovenko.projects WHERE name=$1', [name]);
  return r.rows[0];
}

// ============ PROJECTS REGISTRY ============
app.get('/projects', async (req, res) => {
  try {
    const r = await registry.query('SELECT * FROM gromovenko.projects ORDER BY id');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/projects', async (req, res) => {
  const { name, domain, dev_server, prod_server, frontend_repo, data_repo, port, color } = req.body;
  try {
    await registry.query(
      `INSERT INTO gromovenko.projects (name, domain, dev_server, prod_server, frontend_repo, data_repo, frontend_path, port, status, color)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'dev',$9) ON CONFLICT (name) DO NOTHING`,
      [name, domain, dev_server||'eu', prod_server||'ru', frontend_repo, data_repo, `/root/gromovenko/${frontend_repo}`, port, color||'#185FA5']
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ JOURNAL (deployments) ============
app.get('/journal/:project', async (req, res) => {
  try {
    const r = await registry.query('SELECT * FROM gromovenko.deployments WHERE project=$1 ORDER BY created_at DESC LIMIT 30', [req.params.project]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/journal/:project', async (req, res) => {
  const { version, task, approach, file_name, target_server } = req.body;
  try {
    await registry.query(
      'INSERT INTO gromovenko.deployments (project, version, task, approach, file_name, target_server) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.params.project, version, task, approach, file_name, target_server]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ DEV KNOWLEDGE (per project, dev side) ============
app.get('/knowledge/:project', async (req, res) => {
  try {
    const r = await registry.query('SELECT * FROM gromovenko.dev_knowledge WHERE project=$1 ORDER BY created_at DESC', [req.params.project]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/knowledge/:project', async (req, res) => {
  const { title, content, tags } = req.body;
  try {
    await registry.query('INSERT INTO gromovenko.dev_knowledge (project, title, content, tags) VALUES ($1,$2,$3,$4)', [req.params.project, title, content, tags]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/knowledge/:id', async (req, res) => {
  try { await registry.query('DELETE FROM gromovenko.dev_knowledge WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ DEV DIALOGS ============
app.get('/dialogs/:project', async (req, res) => {
  try {
    const r = await registry.query('SELECT * FROM gromovenko.dev_dialogs WHERE project=$1 ORDER BY created_at DESC LIMIT 100', [req.params.project]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ CLAUDE (analyze, with dev context) ============
app.post('/claude', async (req, res) => {
  try {
    const { system, message, messages, effort } = req.body;
    let prompt = system ? 'SYSTEM:\n' + system + '\n\n' : '';
    if (messages && messages.length) {
      prompt += messages.map(m => (m.role === 'user' ? 'USER: ' : 'ASSISTANT: ') + m.content).join('\n') + '\n';
    }
    prompt += 'USER: ' + message;
    // Add thinking hint for high effort
    if (effort === 'high') prompt = 'Think carefully and deeply before answering.\n\n' + prompt;
    if (effort === 'medium') prompt = 'Think step by step.\n\n' + prompt;
    const result = await claudeRun(prompt);
    res.json({ content: [{ type: 'text', text: result }] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/claude/async', (req, res) => {
  const { system, message, messages, effort } = req.body;
  let prompt = system ? 'SYSTEM:\n' + system + '\n\n' : '';
  if (messages && messages.length) {
    prompt += messages.map(m => (m.role === 'user' ? 'USER: ' : 'ASSISTANT: ') + m.content).join('\n') + '\n';
  }
  prompt += 'USER: ' + message;
  if (effort === 'high') prompt = 'Think carefully and deeply before answering.\n\n' + prompt;
  if (effort === 'medium') prompt = 'Think step by step.\n\n' + prompt;

  const id = newJob();
  res.json({ jobId: id });

  claudeRun(prompt)
    .then(result => { jobs[id] = { status: 'done', text: result, created: jobs[id].created }; })
    .catch(e => { jobs[id] = { status: 'error', error: e.message, created: jobs[id].created }; });
});

// ============ EXECUTE (single, fixed - no duplicate) ============
app.post('/execute', async (req, res) => {
  try {
    const { project, task, approach } = req.body;
    const p = await getProject(project);
    const cwd = p?.frontend_path || '/root/gromovenko';

    // Подтягиваем dev_knowledge как контекст
    let ctx = '';
    try {
      const k = await registry.query('SELECT title, content FROM gromovenko.dev_knowledge WHERE project=$1 ORDER BY created_at DESC LIMIT 5', [project]);
      if (k.rows.length) ctx = '\n\nКонтекст разработки:\n' + k.rows.map(r => `- ${r.title}: ${r.content}`).join('\n');
    } catch(e) {}

    const prompt = `Задача: ${task}${approach ? '\nПодход: ' + approach : ''}${ctx}`;
    const result = await claudeRun(prompt, cwd);

    // Сохраняем диалог разработки
    try {
      await registry.query('INSERT INTO gromovenko.dev_dialogs (project, role, content) VALUES ($1,$2,$3),($1,$4,$5)',
        [project, 'user', task, 'assistant', result.substring(0, 5000)]);
    } catch(e) {}

    // Git-изменения для журнала
    let changes = '';
    try { changes = execSync(`git -C "${cwd}" log --oneline -3 2>/dev/null`).toString().trim(); } catch(e) {}

    res.json({ ok: true, result, changes });
  } catch(e) { res.status(500).json({ error: e.message, stderr: e.stderr?.toString() }); }
});

app.post('/execute/async', async (req, res) => {
  const { project, task, approach } = req.body;
  const id = newJob();
  res.json({ jobId: id });

  try {
    const p = await getProject(project);
    const cwd = p?.frontend_path || '/root/gromovenko';

    let ctx = '';
    try {
      const k = await registry.query('SELECT title, content FROM gromovenko.dev_knowledge WHERE project=$1 ORDER BY created_at DESC LIMIT 5', [project]);
      if (k.rows.length) ctx = '\n\nКонтекст разработки:\n' + k.rows.map(r => `- ${r.title}: ${r.content}`).join('\n');
    } catch(e) {}

    const prompt = `Задача: ${task}${approach ? '\nПодход: ' + approach : ''}${ctx}`;
    const result = await claudeRun(prompt, cwd);

    try {
      await registry.query('INSERT INTO gromovenko.dev_dialogs (project, role, content) VALUES ($1,$2,$3),($1,$4,$5)',
        [project, 'user', task, 'assistant', result.substring(0, 5000)]);
    } catch(e) {}

    let changes = '';
    try { changes = execSync(`git -C "${cwd}" log --oneline -3 2>/dev/null`).toString().trim(); } catch(e) {}

    jobs[id] = { status: 'done', result, changes, created: jobs[id].created };
  } catch(e) {
    jobs[id] = { status: 'error', error: e.message, created: jobs[id].created };
  }
});

// ============ DEPLOY (dev -> prod, server-aware) ============
app.post('/deploy', async (req, res) => {
  try {
    const { project } = req.body;
    const p = await getProject(project);
    if (!p) return res.status(404).json({ error: 'unknown project' });

    const log = [];
    const repoPath = p.frontend_path;
    const target = p.prod_server;

    log.push(`→ git pull ${p.frontend_repo}...`);
    let prevHash = '';
    try { prevHash = execSync(`git -C ${repoPath} rev-parse HEAD 2>/dev/null`).toString().trim(); } catch(e) {}
    execSync(`git -C ${repoPath} pull`, { timeout: 30000 });
    let changelog = '';
    try {
      changelog = prevHash
        ? execSync(`git -C ${repoPath} log --oneline ${prevHash}..HEAD 2>/dev/null`).toString().trim()
        : execSync(`git -C ${repoPath} log --oneline -5 2>/dev/null`).toString().trim();
    } catch(e) {}
    let currentHash = '';
    try { currentHash = execSync(`git -C ${repoPath} rev-parse --short HEAD 2>/dev/null`).toString().trim(); } catch(e) {}
    log.push('✓ pulled' + (changelog ? `\nИзменения:\n${changelog}` : ' (нет новых коммитов)'));

    log.push('→ npm install + build...');
    execSync(`cd ${repoPath} && npm install --production=false && npm run build`, { timeout: 180000 });
    log.push('✓ built');

    if (target === 'ru') {
      log.push('→ rsync to RU server...');
      execSync(`rsync -az --delete ${repoPath}/ -e "ssh -i /root/.ssh/ru_key -o StrictHostKeyChecking=no" root@80.249.150.234:/opt/${project}/app/ --exclude=node_modules --exclude=.git`, { timeout: 120000 });
    execSync(`ssh -i /root/.ssh/ru_key -o StrictHostKeyChecking=no root@80.249.150.234 "cd /opt/${project}/app && npm install --omit=dev 2>/dev/null"`, { timeout: 60000 });
      execSync(`ssh -i /root/.ssh/ru_key -o StrictHostKeyChecking=no root@80.249.150.234 "cd /opt/${project}/app && pm2 restart ${project} || pm2 start npm --name ${project} -- start -- -p ${p.port}"`, { timeout: 60000 });
      log.push(`✓ deployed to RU :${p.port}`);
    } else {
      log.push('→ deploy on EU (local)...');
      execSync(`cd ${repoPath} && pm2 restart ${project} || pm2 start npm --name ${project} -- start -- -p ${p.port}`, { timeout: 60000 });
      log.push(`✓ deployed to EU :${p.port}`);
    }

    const journalTask = changelog || 'нет новых коммитов';
    await registry.query(
      'INSERT INTO gromovenko.deployments (project, version, task, target_server, status) VALUES ($1,$2,$3,$4,$5)',
      [project, 'deploy', journalTask, target, 'deployed']
    );

    updateClaudeMd();
    res.json({ ok: true, result: log.join('\n'), changelog, currentHash });
  } catch(e) { res.status(500).json({ error: e.message, stderr: e.stderr?.toString()?.substring(0,500) }); }
});

// ============ GIT INFO ============
app.get('/git-info', async (req, res) => {
  const info = {};
  try {
    const projects = await registry.query('SELECT name, frontend_path FROM gromovenko.projects');
    for (const p of projects.rows) {
      try {
        info[p.name] = {
          branch: execSync(`git -C ${p.frontend_path} rev-parse --abbrev-ref HEAD 2>/dev/null`).toString().trim(),
          commit: execSync(`git -C ${p.frontend_path} log --oneline -1 2>/dev/null`).toString().trim()
        };
      } catch(e) { info[p.name] = { branch: '—', commit: '—' }; }
    }
  } catch(e) {}
  res.json(info);
});

// ============ INFRA STATUS ============
app.get('/infra', async (req, res) => {
  const result = { repos: {}, dbs: {}, projects: [] };
  try {
    const projects = await registry.query('SELECT * FROM gromovenko.projects ORDER BY id');
    result.projects = projects.rows;
    for (const p of projects.rows) {
      for (const repo of [p.frontend_repo, p.data_repo].filter(Boolean)) {
        try {
          const rp = `/root/gromovenko/${repo}`;
          result.repos[repo] = {
            ok: fs.existsSync(rp),
            branch: execSync(`git -C ${rp} rev-parse --abbrev-ref HEAD 2>/dev/null`).toString().trim(),
            commit: execSync(`git -C ${rp} log --oneline -1 2>/dev/null`).toString().trim().substring(0,40)
          };
        } catch(e) { result.repos[repo] = { ok: false }; }
      }
    }
  } catch(e) {}

  for (const [name, pool] of Object.entries(projectPools)) {
    try {
      const tables = await pool.query("SELECT tablename, pg_size_pretty(pg_total_relation_size(quote_ident(tablename))) as size FROM pg_tables WHERE schemaname='public'");
      const counts = {};
      for (const row of tables.rows) {
        try { const c = await pool.query(`SELECT count(*) FROM ${row.tablename}`); counts[row.tablename] = { size: row.size, count: parseInt(c.rows[0].count) }; } catch(e) {}
      }
      result.dbs[name] = { ok: true, tables: counts };
    } catch(e) { result.dbs[name] = { ok: false, error: e.message }; }
  }
  res.json(result);
});

// ============ UPLOAD ============
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const p = await getProject(req.params.project);
    cb(null, p?.frontend_path || '/tmp');
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });
app.post('/upload/:project', upload.array('files', 50), async (req, res) => {
  try {
    const p = await getProject(req.params.project);
    const files = req.files.map(f => f.originalname);
    execSync(`cd ${p.frontend_path} && git add . && git commit -m "upload: ${files.join(', ')}" 2>/dev/null || true`);
    res.json({ ok: true, files });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ============ PROJECT SETTINGS ============
app.patch('/projects/:name', async (req, res) => {
  const allowed = ['description', 'system_prompt', 'ds_prompt', 'cfg_dskey', 'cfg_dbpass', 'cfg_jwt', 'cfg_notes'];
  const fields = [], values = [];
  for (const key of allowed) {
    if (key in req.body) {
      const v = req.body[key];
      fields.push(key);
      values.push((v === 'None' || v === undefined) ? null : v);
    }
  }
  if (!fields.length) return res.json({ ok: true });
  const setClause = fields.map((k, i) => `${k}=$${i + 1}`).join(', ');
  values.push(req.params.name);
  try {
    await registry.query(
      `UPDATE gromovenko.projects SET ${setClause} WHERE name=$${values.length}`,
      values
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ============ DEEPSEEK ============
const DEEPSEEK_KEYS = {
  life: 'sk-af190509a3fa49318527d30239a1fac0',
  letov: 'sk-1dd76518cdf044c0b3465993c39205ae'
};

app.post('/deepseek/:project', async (req, res) => {
  const { system, message } = req.body;
  const project = req.params.project;
  const apiKey = DEEPSEEK_KEYS[project] || DEEPSEEK_KEYS.life;
  try {
    const https = require('https');
    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: system || 'Ты технический ассистент.' },
        { role: 'user', content: message }
      ],
      max_tokens: 2000
    });
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.deepseek.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }
      }, r => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => resolve(JSON.parse(data)));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    const text = result.choices?.[0]?.message?.content || 'нет ответа';
    res.json({ content: [{ type: 'text', text }] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ============ TEST RUN ============
const TEST_PORTS = { life: 3091, letov: 3092, soundrussian: 3093 };

app.post('/test-run', async (req, res) => {
  const { project } = req.body;
  const { execSync } = require('child_process');
  const p = await getProject(project);
  if (!p) return res.status(404).json({ error: 'unknown project' });
  const testPort = TEST_PORTS[project] || 3090;
  try {
    execSync(`cd ${p.frontend_path} && pm2 stop test-${project} 2>/dev/null || true`);
    execSync(`cd ${p.frontend_path} && pm2 start npm --name test-${project} -- start -- -p ${testPort}`, { timeout: 30000 });
    let commit = '';
    try { commit = execSync(`git -C ${p.frontend_path} log --oneline -3 2>/dev/null`).toString().trim(); } catch(e) {}
    res.json({ ok: true, result: `✓ Тест запущен на EU :${testPort}\nURL: http://147.45.75.59:${testPort}`, commit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/test-stop', async (req, res) => {
  const { project } = req.body;
  const { execSync } = require('child_process');
  try {
    execSync(`pm2 stop test-${project} && pm2 delete test-${project} 2>/dev/null || true`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ============ WIREGUARD ADD PEER ============
app.post('/wg-add', async (req, res) => {
  const { name, ip } = req.body;
  if (!name || !ip) return res.status(400).json({ error: 'name and ip required' });
  const { execSync } = require('child_process');
  try {
    const script = `set -e; PRIVKEY=$(wg genkey); PUBKEY=$(echo $PRIVKEY | wg pubkey); printf '[Peer]\\n# ${name}\\nPublicKey = '$PUBKEY'\\nAllowedIPs = ${ip}/32\\n\\n' >> /etc/wireguard/wg1.conf; wg set wg1 peer $PUBKEY allowed-ips ${ip}/32; echo PRIVKEY=$PRIVKEY; echo PUBKEY=$PUBKEY`;
    const out = execSync(`ssh -i /root/.ssh/ru_key -o StrictHostKeyChecking=no root@80.249.150.234 '${script}'`, {timeout:15000}).toString();
    const privKey = (out.match(/PRIVKEY=(.+)/) || [])[1] || '';
    const serverPub = 'avYjwYOlcdj5YR7W7bO5rbpB5BIlRnwwm0L3Mfcfrgs=';
    const config = `[Interface]\nPrivateKey = ${privKey}\nAddress = ${ip}/24\nDNS = 8.8.8.8\n\n[Peer]\nPublicKey = ${serverPub}\nEndpoint = 80.249.150.234:51821\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25`;
    res.json({ ok: true, config });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ============ WIREGUARD PEERS ============
app.get('/wg-peers', async (req, res) => {
  const { execSync } = require('child_process');
  try {
    const out = execSync('ssh -i /root/.ssh/ru_key -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@80.249.150.234 "cat /etc/wireguard/wg1.conf"', {timeout:8000}).toString();
    const peers = [];
    const blocks = out.split('[Peer]').filter(b=>b.trim());
    const ipNames = {'10.20.0.2':'grom','10.20.0.3':'vika','10.20.0.4':'sasha','10.20.0.5':'mama','10.20.0.6':'eva','10.20.0.7':'aksay','10.20.0.8':'mac_vika'};
    for(const block of blocks){
      const pubkey = (block.match(/PublicKey = (.+)/) || [])[1] || '';
      const ip = (block.match(/AllowedIPs = (.+?)\//) || [])[1] || '';
      if(!pubkey || !ip) continue;
      const nameMatch = block.match(/# (.+)/);
      const name = nameMatch ? nameMatch[1].trim() : (ipNames[ip.trim()] || 'unknown');
      peers.push({name, pubkey: pubkey.trim(), ip: ip.trim()});
    }
    res.json(peers);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/wg-peers/:pubkey', async (req, res) => {
  const { execSync } = require('child_process');
  const pubkey = decodeURIComponent(req.params.pubkey);
  try {
    execSync(`ssh -i /root/.ssh/ru_key -o StrictHostKeyChecking=no root@80.249.150.234 "wg set wg1 peer '${pubkey}' remove"`, {timeout:10000});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(3010, () => console.log('Gromovenko Proxy v2 :3010'));

// Auto-update CLAUDE.md after any deploy
function updateClaudeMd() {
  try { require('child_process').execSync('bash /root/gromovenko/update_claude_md.sh', {timeout:30000}); } catch(e) {}
}
