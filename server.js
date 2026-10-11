import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import archiver from 'archiver';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const PROJECTS = path.join(__dirname, 'projects');
const DATA = path.join(__dirname, 'data', 'projects.json');
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
await fs.mkdir(PROJECTS, { recursive: true });
await fs.mkdir(path.dirname(DATA), { recursive: true });
try { await fs.access(DATA); } catch { await fs.writeFile(DATA, '[]'); }

async function readProjects() { return JSON.parse(await fs.readFile(DATA, 'utf8')); }
async function writeProjects(items) { await fs.writeFile(DATA, JSON.stringify(items, null, 2)); }
function safePath(root, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\\')) throw new Error('Invalid file path');
  const parts = rel.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.startsWith('.env'))) throw new Error('Unsafe file path');
  const target = path.resolve(root, rel);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Unsafe file path');
  return target;
}
function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}
app.get('/api/health', (_req, res) => res.json({ ok: true, aiConfigured: Boolean(client), message: client ? 'API key configured' : 'Add OPENAI_API_KEY to .env' }));
app.get('/api/projects', async (_req, res) => {
  res.json((await readProjects()).map(({id,name,prompt,status,createdAt,error}) => ({id,name,prompt,status,createdAt,error})));
});
app.post('/api/projects', async (req, res) => {
  if (!client) return res.status(503).json({ error: 'AI is not configured. Add your API key to .env and restart the server.' });
  const prompt = String(req.body?.prompt || '').trim();
  if (prompt.length < 8) return res.status(400).json({ error: 'Describe the app in at least 8 characters.' });
  if (prompt.length > 12000) return res.status(400).json({ error: 'Description is too long (max 12000 characters).' });
  const id = crypto.randomUUID();
  const project = { id, name: 'Building project…', prompt, status: 'building', createdAt: new Date().toISOString() };
  const items = await readProjects(); items.unshift(project); await writeProjects(items);
  res.status(202).json({ id, status: 'building' });
  buildProject(project).catch(async err => {
    const all = await readProjects();
    const p = all.find(x => x.id === id);
    if (p) { p.status = 'error'; p.error = String(err.message || err).slice(0, 500); await writeProjects(all); }
  });
});
async function buildProject(project) {
  const model = process.env.OPENAI_MODEL || 'gpt-6-luna';
  const planResponse = await client.responses.create({
    model,
    input: [
      { role: 'system', content: 'You are a senior web app builder. Respond with valid JSON only: {"name":"short project name","files":[{"path":"index.html","content":"complete file content"}]}. Build a polished, responsive, self-contained browser app using HTML, CSS and vanilla JS in index.html unless separate files are truly needed. Every visible control must work. Do not include secrets, server code, external shell commands, or instructions to execute arbitrary code. Keep the app safe and accessible.' },
      { role: 'user', content: `Build this app: ${project.prompt}\nReturn complete project files as JSON. Include index.html. Limit to 12 files and make a usable prototype.` }
    ]
  });
  const result = parseJson(planResponse.output_text || '');
  if (!Array.isArray(result.files) || !result.files.some(f => f.path === 'index.html' && typeof f.content === 'string')) throw new Error('AI response did not include a valid index.html.');
  if (result.files.length > 12) throw new Error('AI returned too many files.');
  const root = path.join(PROJECTS, project.id);
  await fs.mkdir(root, { recursive: true });
  for (const f of result.files) {
    if (typeof f.content !== 'string' || f.content.length > 1_000_000) throw new Error('Invalid or oversized generated file.');
    const target = safePath(root, f.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, f.content, 'utf8');
  }
  const all = await readProjects();
  const p = all.find(x => x.id === project.id);
  if (p) { p.name = String(result.name || 'My App').slice(0, 100); p.status = 'ready'; p.files = result.files.map(f => f.path); await writeProjects(all); }
}
app.get('/api/projects/:id', async (req, res) => {
  const p = (await readProjects()).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  res.json(p);
});
app.get('/preview/:id', async (req, res) => {
  const root = path.join(PROJECTS, req.params.id);
  try {
    const realRoot = await fs.realpath(root);
    const file = path.join(realRoot, 'index.html');
    const realFile = await fs.realpath(file);
    if (!realFile.startsWith(realRoot + path.sep)) throw new Error('Invalid path');
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data:; connect-src 'none'; object-src 'none'; frame-ancestors 'self'");
    res.sendFile(realFile);
  } catch { res.status(404).send('Preview is not ready yet.'); }
});
app.get('/api/projects/:id/export.zip', async (req, res) => {
  const root = path.join(PROJECTS, req.params.id);
  try { await fs.access(path.join(root, 'index.html')); } catch { return res.status(404).json({ error: 'Project not ready' }); }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="app-${req.params.id}.zip"`);
  const archive = archiver('zip', { zlib: { level: 8 } });
  archive.on('error', err => { if (!res.headersSent) res.status(500).end(); });
  archive.pipe(res); archive.directory(root, false); await archive.finalize();
});
app.listen(PORT, '127.0.0.1', () => console.log(`App Factory AI running at http://127.0.0.1:${PORT}`));
