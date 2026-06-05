const express = require('express');
const { Pool } = require('pg');
const { execSync, exec, spawn } = require('child_process');
const multer = require('multer');
const fs = require('fs');
const https = require('https');

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
  password: process.env.REGISTRY_PG_PASS || '8b8bf97ab5cbf0e76ab77506ac9525c6',
  options: '-c search_path=gromovenko'
});

// Project DBs (клиентские данные) — через socat к RU
const projectPools = {
  life: new Pool({ host: '80.249.150.234', port: 15433, database: 'postgres', user: 'postgres', password: '87e4ac14f47230d6ea1c325c2312b831', connectionTimeoutMillis: 4000 }),
  letov: new Pool({ host: '80.249.150.234', port: 15434, database: 'postgres', user: 'postgres', password: 'e6e66d2323f8c303c1e5473db77852e1', connectionTimeoutMillis: 4000 })
};

// ============ HELPERS ============
function claudeRun(prompt, cwd = '/root/gromovenko', timeout = 300000, maxTurns = null, onProgress = null) {
  return new Promise((resolve, reject) => {
    const args = [
      '--print', '--output-format', 'text',
      '--permission-mode', 'acceptEdits',
      '--model', 'claude-sonnet-4-6',
    ];
    if (maxTurns) args.push('--max-turns', String(maxTurns));

    const child = spawn('claude', args, {
      cwd,
      env: { ...process.env, HOME: '/root' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();

    let stdout = '', stderr = '', settled = false;
    child.stdout.on('data', d => { stdout += d; if (onProgress) onProgress(stdout); });
    child.stderr.on('data', d => stderr += d);

    function settle(fn) { if (!settled) { settled = true; fn(); } }

    const killTree = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch(e) {} };

    const timer = setTimeout(() => {
      killTree();
      settle(() => {
        const partial = stdout.trim().replace(/```json|```/g, '').trim();
        if (partial.length > 100) resolve(partial + '\n\n⚠ прерван по таймауту');
        else reject(new Error(`Claude timeout ${Math.round(timeout/1000)}s. stderr: ${stderr.slice(0,200)}`));
      });
    }, timeout);

    child.on('close', code => {
      clearTimeout(timer);
      settle(() => {
        if (code !== 0) return reject(new Error(`Claude exit ${code}: ${stderr.slice(0,300)}\n${stdout.slice(0,300)}`));
        resolve(stdout.trim().replace(/```json|```/g, '').trim());
      });
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
    const result = await claudeRun(prompt, '/root/gromovenko', 1500000, 5);
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

  claudeRun(prompt, '/root/gromovenko', 1500000, 30, p => { jobs[id].partial = p.slice(-6000); })
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
    const result = await claudeRun(prompt, cwd, 1500000, 200);

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
    const result = await claudeRun(prompt, cwd, 1500000, 200, part => { jobs[id].partial = part.slice(-6000); });

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

    // Write journal entries per commit (client won't write its own)
    const lines = (changelog || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length) {
      for (const line of lines) {
        const m = line.match(/^([a-f0-9]{7,})\s+(.+)/);
        const ver = m?.[1] ?? currentHash;
        const task = m?.[2] ?? line;
        await registry.query(
          'INSERT INTO gromovenko.deployments (project, version, task, approach, target_server) VALUES ($1,$2,$3,$4,$5)',
          [project, ver, task, '[prod-deploy]', target]
        );
      }
    } else {
      await registry.query(
        'INSERT INTO gromovenko.deployments (project, version, task, approach, target_server) VALUES ($1,$2,$3,$4,$5)',
        [project, currentHash || 'deploy', 'нет новых коммитов', '[prod-deploy]', target]
      );
    }

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
app.get('/upload/:project', async (req, res) => {
  try {
    const p = await getProject(req.params.project);
    const cwd = p?.upload_path || p?.frontend_path;
    if (!cwd || !fs.existsSync(cwd)) return res.json({ files: [] });
    const SKIP = new Set(['node_modules', '.next', '.git', 'dist', '.cache', 'out', '.turbo']);
    const items = fs.readdirSync(cwd)
      .filter(f => !SKIP.has(f))
      .map(f => {
        try {
          const stat = fs.statSync(`${cwd}/${f}`);
          return { name: f, isDir: stat.isDirectory(), size: stat.isFile() ? stat.size : null };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1);
    res.json({ files: items });
  } catch(e) { res.json({ files: [], error: e.message }); }
});

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const p = await getProject(req.params.project);
    const dir = p?.upload_path || p?.frontend_path || '/tmp';
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });
app.post('/upload/:project', upload.array('files', 50), async (req, res) => {
  try {
    const p = await getProject(req.params.project);
    const uploadDir = p?.upload_path || p?.frontend_path;
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

// ============ PROMPT READ/WRITE ============
app.get('/prompt/:project', async (req, res) => {
  const pool = projectPools[req.params.project];
  if (!pool) return res.json({ content: null });
  try {
    const r = await pool.query(
      "SELECT content FROM system_prompts WHERE id='deepseek_user_chat' LIMIT 1"
    );
    const content = r.rows[0]?.content ?? null;
    res.json({ content: content?.startsWith('-- initial') ? null : content });
  } catch { res.json({ content: null }); }
});

app.patch('/prompt/:project', async (req, res) => {
  const pool = projectPools[req.params.project];
  if (!pool) return res.status(404).json({ error: 'unknown project' });
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  try {
    await pool.query(
      `INSERT INTO system_prompts (id, content, updated_at, updated_by)
       VALUES ('deepseek_user_chat', $1, now(), 'gromdash')
       ON CONFLICT (id) DO UPDATE SET content=$1, updated_at=now(), updated_by='gromdash'`,
      [content]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/deepseek/:project', async (req, res) => {
  const { system, message } = req.body;
  const project = req.params.project;
  const apiKey = DEEPSEEK_KEYS[project] || DEEPSEEK_KEYS.life;
  try {
    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: system || 'Ты технический ассистент.' },
        { role: 'user', content: message }
      ],
      max_tokens: 2000
    });
    const result = await new Promise((resolve, reject) => {
      const dreq = https.request({
        hostname: 'api.deepseek.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey }
      }, r => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => resolve(JSON.parse(data)));
      });
      dreq.on('error', reject);
      dreq.write(body);
      dreq.end();
    });
    const text = result.choices?.[0]?.message?.content || 'нет ответа';
    res.json({ content: [{ type: 'text', text }] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ============ TEST RUN ============
const TEST_PORTS = { life: 3091, letov: 3092, soundrussian: 3093 };

app.post('/test-run', async (req, res) => {
  const { project } = req.body;
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
  try {
    execSync(`pm2 stop test-${project} && pm2 delete test-${project} 2>/dev/null || true`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ============ WIREGUARD ADD PEER ============
app.post('/wg-add', async (req, res) => {
  const { name, ip } = req.body;
  if (!name || !ip) return res.status(400).json({ error: 'name and ip required' });
  try {
    const script = [
      'set -e',
      'PRIVKEY=$(wg genkey)',
      'PUBKEY=$(echo $PRIVKEY | wg pubkey)',
      `printf '[Peer]\\n# ${name}\\nPublicKey = %s\\nAllowedIPs = ${ip}/32\\n\\n' "$PUBKEY" >> /etc/wireguard/wg1.conf`,
      `wg set wg1 peer "$PUBKEY" allowed-ips ${ip}/32`,
      'echo "PRIVKEY=$PRIVKEY"',
      'echo "PUBKEY=$PUBKEY"'
    ].join('\n');
    const out = execSync('ssh -i /root/.ssh/ru_key -o StrictHostKeyChecking=no root@80.249.150.234 bash', {
      input: script, timeout: 15000
    }).toString();
    const privKey = (out.match(/PRIVKEY=(.+)/) || [])[1]?.trim() || '';
    const pubKey  = (out.match(/PUBKEY=(.+)/)  || [])[1]?.trim() || '';
    if (!privKey) throw new Error('keygen failed: ' + out);
    // сохраняем приватный ключ
    const storePath = '/root/gromovenko/wg-peers-store.json';
    let store = {};
    try { store = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch(e) {}
    store[name] = { ip, privkey: privKey, pubkey: pubKey };
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
    const serverPub = 'avYjwYOlcdj5YR7W7bO5rbpB5BIlRnwwm0L3Mfcfrgs=';
    const config = `[Interface]\nPrivateKey = ${privKey}\nAddress = ${ip}/32\nDNS = 8.8.8.8, 8.8.4.4\n\n[Peer]\nPublicKey = ${serverPub}\nEndpoint = 80.249.150.234:51821\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25`;
    res.json({ ok: true, config, pubkey: pubKey });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ============ WIREGUARD PEERS ============
app.get('/wg-peers', async (req, res) => {
  try {
    const out = execSync('ssh -i /root/.ssh/ru_key -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@80.249.150.234 "cat /etc/wireguard/wg1.conf"', {timeout:8000}).toString();
    let store = {};
    try { store = JSON.parse(fs.readFileSync('/root/gromovenko/wg-peers-store.json', 'utf8')); } catch(e) {}
    const peers = [];
    const blocks = out.split('[Peer]').filter(b=>b.trim());
    const ipNames = {'10.20.0.2':'grom','10.20.0.3':'vika','10.20.0.4':'sasha','10.20.0.5':'mama','10.20.0.6':'eva','10.20.0.7':'aksay','10.20.0.8':'mac_vika'};
    for(const block of blocks){
      const pubkey = (block.match(/PublicKey = (.+)/) || [])[1] || '';
      const ip = (block.match(/AllowedIPs = (.+?)\//) || [])[1] || '';
      if(!pubkey || !ip) continue;
      const nameMatch = block.match(/# (.+)/);
      const name = nameMatch ? nameMatch[1].trim() : (ipNames[ip.trim()] || 'unknown');
      const privkey = store[name]?.privkey || '';
      peers.push({name, pubkey: pubkey.trim(), ip: ip.trim(), privkey});
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

app.get('/claude-usage', (req, res) => {
  // Plan limits — Claude Max $100/mo, Sonnet 4.6 output tokens (≈5x $20 plan)
  const WIN_LIMIT  = 2_000_000;  // 5h window
  const WEEK_LIMIT = 9_000_000;  // 7d window
  try {
    const windowMs = 5 * 60 * 60 * 1000;
    const now = Date.now();
    const winCutoff  = now - windowMs;
    const weekCutoff = now - 7 * 24 * 60 * 60 * 1000;

    // files touched in last 7 days (superset of last 5h)
    let weekFiles = [];
    try {
      weekFiles = execSync('find /root/.claude/projects -name "*.jsonl" -mtime -7 2>/dev/null', {timeout:5000})
        .toString().trim().split('\n').filter(Boolean);
    } catch(e){}

    let windowStart = null;
    let totalIn=0, totalOut=0, totalCacheRead=0, totalCacheCreate=0, msgCount=0;
    let weekOut=0;
    // Track by latest ENTRY timestamp, not file mtime (mtime updated by ANY write, can be stale task)
    let aiTitle=null, lastPrompt=null;
    let latestEntryTs=0, latestFileLines=null;

    for (const file of weekFiles) {
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        let fileMaxTs = 0;
        for (const line of lines) {
          try {
            const d = JSON.parse(line);
            const ts = new Date(d.timestamp).getTime();
            if (!ts || ts < weekCutoff) continue;
            if (ts > fileMaxTs) fileMaxTs = ts;
            const msg = d.message;
            if (msg && typeof msg === 'object' && msg.usage) {
              const u = msg.usage;
              weekOut += u.output_tokens || 0;
              if (ts >= winCutoff) {
                if (windowStart === null || ts < windowStart) windowStart = ts;
                totalIn  += u.input_tokens || 0;
                totalOut += u.output_tokens || 0;
                totalCacheRead   += u.cache_read_input_tokens || 0;
                totalCacheCreate += u.cache_creation_input_tokens || 0;
                msgCount++;
              }
            }
          } catch(e){}
        }
        if (fileMaxTs > latestEntryTs) {
          latestEntryTs = fileMaxTs;
          latestFileLines = lines;
        }
      } catch(e){}
    }

    // Extract title/prompt from the file with the most recent activity
    if (latestFileLines) {
      for (let i = latestFileLines.length - 1; i >= 0 && (!aiTitle || !lastPrompt); i--) {
        try {
          const d = JSON.parse(latestFileLines[i]);
          if (!aiTitle    && d.type === 'ai-title')    aiTitle    = d.aiTitle;
          if (!lastPrompt && d.type === 'last-prompt') lastPrompt = d.lastPrompt;
        } catch(e){}
      }
    }

    let sessions = [];
    try {
      const sdir = '/root/.claude/sessions/';
      for (const sf of fs.readdirSync(sdir)) {
        try { sessions.push(JSON.parse(fs.readFileSync(sdir + sf, 'utf8'))); } catch(e){}
      }
    } catch(e){}

    const nextReset  = windowStart ? windowStart + windowMs : null;
    const costUsd    = totalIn*3/1e6 + totalOut*15/1e6 + totalCacheRead*0.30/1e6 + totalCacheCreate*3.75/1e6;
    const windowPct  = Math.min(Math.round(totalOut / WIN_LIMIT  * 100), 999);
    const weekPct    = Math.min(Math.round(weekOut  / WEEK_LIMIT * 100), 999);

    res.json({
      window_start: windowStart,
      next_reset: nextReset,
      tokens: {in:totalIn, out:totalOut, cache_read:totalCacheRead, cache_create:totalCacheCreate},
      cost_usd: parseFloat(costUsd.toFixed(2)),
      msg_count: msgCount,
      window_pct: windowPct,
      week_pct: weekPct,
      sessions,
      ai_title: aiTitle,
      last_prompt: lastPrompt
    });
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.listen(3010, () => console.log('Gromovenko Proxy v2 :3010'));

// Auto-update CLAUDE.md after any deploy
function updateClaudeMd() {
  try { require('child_process').execSync('bash /root/gromovenko/update_claude_md.sh', {timeout:30000}); } catch(e) {}
}
