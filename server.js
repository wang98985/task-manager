const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const express = require('express');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const IS_VERCEL = Boolean(process.env.VERCEL);

const PRIORITIES = ['high', 'medium', 'low'];
const TASK_FIELDS = 'id,title,priority,completed,created_at';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------------- 数据存储 ---------------- */

function createSupabaseStore(url, key) {
  const { createClient } = require('@supabase/supabase-js');
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    label: 'Supabase',

    async list() {
      const { data, error } = await client
        .from('tasks')
        .select(TASK_FIELDS)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data ?? [];
    },

    async create(title, priority) {
      const { data, error } = await client
        .from('tasks')
        .insert({ title, priority })
        .select(TASK_FIELDS)
        .single();

      if (error) throw error;
      return data;
    },

    async update(id, completed) {
      const { data, error } = await client
        .from('tasks')
        .update({ completed })
        .eq('id', id)
        .select(TASK_FIELDS)
        .maybeSingle();

      if (error) throw error;
      return data;
    },

    async remove(id) {
      const { data, error } = await client
        .from('tasks')
        .delete()
        .eq('id', id)
        .select('id')
        .maybeSingle();

      if (error) throw error;
      return data;
    },
  };
}

function createLocalStore() {
  const file = path.join(__dirname, '.data', 'tasks.json');

  async function readAll() {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function saveAll(tasks) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(tasks, null, 2), 'utf8');
  }

  return {
    label: '本地文件（仅开发环境）',

    async list() {
      const tasks = await readAll();
      return tasks.sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at),
      );
    },

    async create(title, priority) {
      const tasks = await readAll();
      const task = {
        id: crypto.randomUUID(),
        title,
        priority,
        completed: false,
        created_at: new Date().toISOString(),
      };
      tasks.push(task);
      await saveAll(tasks);
      return task;
    },

    async update(id, completed) {
      const tasks = await readAll();
      const task = tasks.find((item) => item.id === id);
      if (!task) return null;
      task.completed = completed;
      await saveAll(tasks);
      return task;
    },

    async remove(id) {
      const tasks = await readAll();
      const index = tasks.findIndex((item) => item.id === id);
      if (index === -1) return null;
      const [removed] = tasks.splice(index, 1);
      await saveAll(tasks);
      return removed;
    },
  };
}

let store = null;

if (SUPABASE_URL && SUPABASE_KEY) {
  store = createSupabaseStore(SUPABASE_URL, SUPABASE_KEY);
} else if (!IS_VERCEL) {
  store = createLocalStore();
}

/* ---------------- Express 应用 ---------------- */

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '32kb' }));

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

app.use('/api', (req, res, next) => {
  if (!store) {
    return res.status(503).json({
      error:
        '数据库未配置：请在环境变量中设置 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY（或 SUPABASE_ANON_KEY），并在 Supabase 中执行 supabase/schema.sql。',
    });
  }
  next();
});

app.get(
  '/api/tasks',
  asyncHandler(async (req, res) => {
    const tasks = await store.list();
    res.json({ tasks });
  }),
);

app.post(
  '/api/tasks',
  asyncHandler(async (req, res) => {
    const title =
      typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const priority = req.body?.priority ?? 'medium';

    if (!title) throw httpError(400, '请输入任务内容');
    if (title.length > 200) throw httpError(400, '任务内容不能超过 200 个字符');
    if (!PRIORITIES.includes(priority)) {
      throw httpError(400, '优先级只能是 high、medium 或 low');
    }

    const task = await store.create(title, priority);
    res.status(201).json({ task });
  }),
);

app.patch(
  '/api/tasks/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!UUID_RE.test(id)) throw httpError(400, '任务 ID 不合法');
    if (typeof req.body?.completed !== 'boolean') {
      throw httpError(400, 'completed 必须是布尔值');
    }

    const task = await store.update(id, req.body.completed);
    if (!task) throw httpError(404, '任务不存在或已被删除');

    res.json({ task });
  }),
);

app.delete(
  '/api/tasks/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!UUID_RE.test(id)) throw httpError(400, '任务 ID 不合法');

    const removed = await store.remove(id);
    if (!removed) throw httpError(404, '任务不存在或已被删除');

    res.json({ ok: true });
  }),
);

app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  let status = Number.isInteger(err.status) ? err.status : 500;
  let message =
    status >= 500
      ? '服务器内部错误，请稍后重试'
      : err.expose
        ? err.message
        : '请求格式不正确';

  if (err.code === '42P01') {
    status = 500;
    message = '数据表 tasks 不存在，请先在 Supabase 中执行 supabase/schema.sql';
  }

  if (status >= 500) {
    console.error('[task-manager]', err);
  }

  res.status(status).json({ error: message });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[task-manager] 服务已启动：http://localhost:${PORT}`);
    console.log(`[task-manager] 数据存储：${store ? store.label : '未配置'}`);
    if (!store) {
      console.warn(
        '[task-manager] 未检测到 Supabase 环境变量，线上部署需要配置后才能读写数据。',
      );
    }
  });
}

module.exports = app;
