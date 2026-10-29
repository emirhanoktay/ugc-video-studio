// UGC Video Studio - Mini App (Local Dashboard)
// Express + fal.ai REST API proxy + job polling + JSON storage.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const FAL_KEY = process.env.FAL_KEY;
const FAL_ADMIN_KEY = process.env.FAL_ADMIN_KEY || '';

if (!FAL_KEY) {
  console.error('\n[ERROR] FAL_KEY not set. Copy .env.example to .env and paste your fal.ai API key.\n');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PERSONAS_DIR = path.join(DATA_DIR, 'personas');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const PERSONAS_FILE = path.join(DATA_DIR, 'personas.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(PERSONAS_DIR)) fs.mkdirSync(PERSONAS_DIR, { recursive: true });

function loadJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}
function upsertJob(job) {
  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.id === job.id);
  if (idx >= 0) jobs[idx] = { ...jobs[idx], ...job };
  else jobs.unshift(job);
  saveJobs(jobs);
}

// === Personas storage ===
function loadPersonas() {
  try { return JSON.parse(fs.readFileSync(PERSONAS_FILE, 'utf8')); }
  catch { return []; }
}
function savePersonas(personas) {
  fs.writeFileSync(PERSONAS_FILE, JSON.stringify(personas, null, 2));
}

// === Model selection (mirrors the SKILL.md decision tree) ===
const MODELS = {
  ekonomik:  { endpoint: 'fal-ai/veo3.1/lite/image-to-video', durations: ['4s','6s','8s'], pricePerSec: 0.05, family: 'veo' },
  standart:  { endpoint: 'fal-ai/veo3.1/fast/image-to-video', durations: ['4s','6s','8s'], pricePerSec: 0.15, family: 'veo' },
  premium:   { endpoint: 'fal-ai/veo3.1/image-to-video',      durations: ['4s','6s','8s'], pricePerSec: 0.40, family: 'veo' },
  uzun:      { endpoint: 'bytedance/seedance-2.0/fast/image-to-video', durations: ['4','5','6','7','8','9','10','11','12','13','14','15'], pricePerSec: 0.10, family: 'seedance' }
};
// text-to-video endpoints for users without an uploaded image
const MODELS_T2V = {
  ekonomik:  { endpoint: 'fal-ai/veo3.1/fast',  durations: ['4s','6s','8s'], pricePerSec: 0.15, family: 'veo' }, // lite t2v not exposed; fall back to fast
  standart:  { endpoint: 'fal-ai/veo3.1/fast',  durations: ['4s','6s','8s'], pricePerSec: 0.15, family: 'veo' },
  premium:   { endpoint: 'fal-ai/veo3.1',       durations: ['4s','6s','8s'], pricePerSec: 0.40, family: 'veo' },
  uzun:      { endpoint: 'bytedance/seedance-2.0/fast/text-to-video', durations: ['4','5','6','7','8','9','10','11','12','13','14','15'], pricePerSec: 0.10, family: 'seedance' }
};
const SUBTITLE_ENDPOINT = 'fal-ai/workflow-utilities/auto-subtitle';
const COMPOSE_ENDPOINT = 'fal-ai/nano-banana/edit';
const COMPOSE_COST = 0.04; // $0.04 per image

function pickModel(level, hasImage, duration) {
  // Force "uzun" if duration > 8
  const dur = parseInt(String(duration).replace('s',''), 10);
  if (dur > 8) level = 'uzun';
  const table = hasImage ? MODELS : MODELS_T2V;
  return { level, ...table[level] };
}
function estimateCost(level, duration, compose = false) {
  const dur = parseInt(String(duration).replace('s',''), 10);
  const m = pickModel(level, true, duration);
  const video = m.pricePerSec * dur;
  const subtitle = 0.03 * (dur / 60); // $0.03/min
  const composeCost = compose ? COMPOSE_COST : 0;
  return { video: +video.toFixed(2), subtitle: +subtitle.toFixed(3), compose: +composeCost.toFixed(2), total: +(video + subtitle + composeCost).toFixed(2) };
}

// === fal.ai API helpers ===
async function falSubmit(endpoint, body) {
  const res = await fetch(`https://queue.fal.run/${endpoint}`, {
    method: 'POST',
    headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fal submit ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}
async function falStatus(endpoint, requestId) {
  // Status URL uses the base endpoint (some endpoints like /fast/image-to-video collapse to the parent)
  const base = endpoint.split('/').slice(0, 2).join('/'); // e.g. "fal-ai/veo3.1" or "bytedance/seedance-2.0"
  const res = await fetch(`https://queue.fal.run/${base}/requests/${requestId}/status`, {
    headers: { 'Authorization': `Key ${FAL_KEY}` }
  });
  if (!res.ok) throw new Error(`fal status ${res.status}`);
  return res.json();
}
async function falResult(endpoint, requestId) {
  const base = endpoint.split('/').slice(0, 2).join('/');
  const res = await fetch(`https://queue.fal.run/${base}/requests/${requestId}`, {
    headers: { 'Authorization': `Key ${FAL_KEY}` }
  });
  return { ok: res.ok, status: res.status, body: res.ok ? await res.json() : await res.text() };
}
async function falUpload(filePath, mimeType, fileName) {
  // 1. initiate upload
  const initRes = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: fileName, content_type: mimeType })
  });
  if (!initRes.ok) throw new Error(`fal upload initiate ${initRes.status}`);
  const { upload_url, file_url } = await initRes.json();
  // 2. PUT the bytes
  const buffer = fs.readFileSync(filePath);
  const putRes = await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: buffer });
  if (!putRes.ok) throw new Error(`fal upload PUT ${putRes.status}`);
  return file_url;
}

// === Prompt builder (mirrors prompt-rehberi.md spirit) ===
const STYLE_PRESETS = {
  'samimi-itiraf': 'Vertical handheld selfie-style video. A relatable woman in her late 20s in a soft home setting, talking to camera with a warm sincere casual tone. Natural daylight, slight handheld shake. First 2 seconds: an honest attention-grabbing opener. Authentic, unpolished, trustworthy mood.',
  'heyecanli-kesif': 'Vertical handheld video, energetic and bright. A person excitedly opens packaging, quick close-ups, genuine surprise on their face. Dynamic but smooth camera, vibrant lighting. First 2 seconds: the box with an excited reaction.',
  'problem-cozum': 'Vertical video. Opens on a relatable everyday frustration shown in first 2 seconds with slightly annoyed expression. Then product appears and mood shifts to relief and satisfaction. Handheld, natural light, expressive face.',
  'sokak-roportaji': 'Vertical street-interview style on a busy sidewalk. Casual candid mood. A passerby answers naturally and positively, authentic reactions. Handheld documentary feel, natural outdoor light, blurred city background.',
  'luks-estetik': 'Vertical cinematic video, premium aesthetic. Slow elegant camera movement. Macro detail shots, soft directional lighting, refined color grading, shallow depth of field. Minimal sophisticated mood. Luxurious aspirational atmosphere with subtle ambient sound.',
  'komik-eglenceli': 'Vertical video, comedic and exaggerated. An over-the-top funny scenario, expressive acting, playful timing, bright energetic look. First 2 seconds: an unexpected humorous hook. Light, funny, shareable mood.',
  'uzman-tavsiyesi': 'Vertical video, credible and clean look. A knowledgeable trustworthy person in a professional-but-approachable setting, steady camera, soft professional lighting, confident posture. First 2 seconds: an authority-building opener.',
  'once-sonra': 'Vertical video showing a clear before-and-after transformation. First 2 seconds: the "before" state with a hook line. Then product is introduced, transitioning to the improved "after" state. Handheld, natural light, honest framing. Convincing results-driven mood.'
};

function buildPrompt({ product, benefit, style, dialog, image }) {
  const styleBlock = STYLE_PRESETS[style] || STYLE_PRESETS['samimi-itiraf'];
  const productLine = product ? `The video promotes ${product}.` : '';
  const benefitLine = benefit ? `Key message: ${benefit}.` : '';
  const refLine = image ? 'Animate based on the provided reference image.' : '';
  const dialogLine = dialog
    ? `She speaks softly in Turkish (native Turkish accent, warm natural tone):\n"${dialog}"`
    : 'She speaks softly in Turkish with a warm natural tone, delivering a single short authentic line about the product.';
  return [
    styleBlock,
    productLine,
    benefitLine,
    refLine,
    dialogLine,
    'Subtle natural ambient sound, no background music. Photorealistic. No on-screen text, no captions, no subtitles.'
  ].filter(Boolean).join('\n\n');
}

// === Express app ===
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

app.get('/api/health', (req, res) => res.json({ ok: true, key: FAL_KEY ? 'present' : 'missing' }));

// === Balance API ===
app.get('/api/balance', async (req, res) => {
  if (!FAL_ADMIN_KEY) {
    return res.json({ available: false, error: 'FAL_ADMIN_KEY not set in .env' });
  }
  try {
    const r = await fetch('https://api.fal.ai/v1/account/billing?expand=credits', {
      headers: { 'Authorization': `Key ${FAL_ADMIN_KEY}` }
    });
    if (!r.ok) {
      const text = await r.text();
      return res.json({ available: false, error: `fal billing API ${r.status}: ${text.slice(0, 200)}` });
    }
    const data = await r.json();
    const balance = data.credits?.current_balance ?? null;
    if (balance === null) {
      return res.json({ available: false, error: 'credits.current_balance not found in response' });
    }
    res.json({ available: true, balance: +balance });
  } catch (e) {
    res.json({ available: false, error: e.message });
  }
});

// === Personas API ===
app.get('/api/personas', (req, res) => res.json(loadPersonas()));

app.post('/api/personas', upload.single('photo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Fotoğraf gerekli' });
    if (!req.body.name?.trim()) return res.status(400).json({ error: 'İsim gerekli' });

    const id = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(req.file.originalname) || '.jpg';
    const photoFileName = `${id}${ext}`;
    const photoPath = path.join(PERSONAS_DIR, photoFileName);

    fs.renameSync(req.file.path, photoPath);

    const persona = { id, name: req.body.name.trim(), photoFileName, mimeType: req.file.mimetype, createdAt: new Date().toISOString() };
    const personas = loadPersonas();
    personas.unshift(persona);
    savePersonas(personas);
    res.json(persona);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/personas/:id', (req, res) => {
  const personas = loadPersonas();
  const persona = personas.find(p => p.id === req.params.id);
  if (persona) {
    const photoPath = path.join(PERSONAS_DIR, persona.photoFileName);
    if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
  }
  savePersonas(personas.filter(p => p.id !== req.params.id));
  res.json({ ok: true });
});

app.get('/api/personas/:id/photo', (req, res) => {
  const persona = loadPersonas().find(p => p.id === req.params.id);
  if (!persona) return res.status(404).json({ error: 'not found' });
  const photoPath = path.join(PERSONAS_DIR, persona.photoFileName);
  if (!fs.existsSync(photoPath)) return res.status(404).json({ error: 'photo not found' });
  res.sendFile(photoPath);
});

app.get('/api/cost', (req, res) => {
  const { level = 'standart', duration = '8s', compose = '' } = req.query;
  res.json(estimateCost(level, duration, compose === '1'));
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const url = await falUpload(req.file.path, req.file.mimetype, req.file.originalname);
    fs.unlinkSync(req.file.path);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === Compose persona + product image ===
app.post('/api/compose', upload.single('productImage'), async (req, res) => {
  try {
    const { personaId } = req.body;
    if (!personaId) return res.status(400).json({ error: 'Kişi seçimi gerekli' });
    if (!req.file) return res.status(400).json({ error: 'Ürün görseli gerekli' });

    const persona = loadPersonas().find(p => p.id === personaId);
    if (!persona) return res.status(400).json({ error: 'Kişi bulunamadı' });

    const photoPath = path.join(PERSONAS_DIR, persona.photoFileName);
    if (!fs.existsSync(photoPath)) return res.status(400).json({ error: 'Kişi fotoğrafı bulunamadı' });

    // Upload both images to fal CDN
    const [personaUrl, productUrl] = await Promise.all([
      falUpload(photoPath, persona.mimeType, persona.photoFileName),
      falUpload(req.file.path, req.file.mimetype, req.file.originalname)
    ]);

    // Clean up temp upload
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

    // Call nano-banana/edit to compose
    const composePayload = {
      prompt: 'A person naturally holding and presenting the product in their hands, looking at camera with a warm genuine smile. The person and product are in a well-lit environment. Vertical portrait composition, photorealistic, clean background. No text, no watermarks.',
      image_urls: [personaUrl, productUrl],
      aspect_ratio: '9:16',
      safety_tolerance: '5'
    };

    const submitRes = await falSubmit(COMPOSE_ENDPOINT, composePayload);

    // Poll for result
    let attempts = 0;
    while (attempts < 60) {
      attempts++;
      await new Promise(r => setTimeout(r, 3000));
      const status = await falStatus(COMPOSE_ENDPOINT, submitRes.request_id);
      if (status.status === 'COMPLETED') {
        const result = await falResult(COMPOSE_ENDPOINT, submitRes.request_id);
        if (result.ok && result.body?.images?.[0]?.url) {
          return res.json({ url: result.body.images[0].url, cost: COMPOSE_COST });
        }
        return res.status(500).json({ error: 'Görsel oluşturuldu ama URL alınamadı' });
      }
      if (status.status !== 'IN_PROGRESS' && status.status !== 'IN_QUEUE') {
        return res.status(500).json({ error: `Compose hatası: ${status.status}` });
      }
    }
    return res.status(500).json({ error: 'Compose zaman aşımı' });
  } catch (e) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/produce', async (req, res) => {
  try {
    const { product, benefit, style = 'samimi-itiraf', level = 'standart', duration = '8s', dialog = '', imageUrl = '', personaId = '', composedImageUrl = '' } = req.body;

    // Resolve image: composedImageUrl > persona photo > uploaded image
    let resolvedImageUrl = imageUrl;
    let personaName = null;
    if (composedImageUrl) {
      resolvedImageUrl = composedImageUrl;
      if (personaId) {
        const persona = loadPersonas().find(p => p.id === personaId);
        if (persona) personaName = persona.name;
      }
    } else if (personaId) {
      const persona = loadPersonas().find(p => p.id === personaId);
      if (!persona) return res.status(400).json({ error: 'Kişi bulunamadı' });
      const photoPath = path.join(PERSONAS_DIR, persona.photoFileName);
      if (!fs.existsSync(photoPath)) return res.status(400).json({ error: 'Kişi fotoğrafı bulunamadı' });
      resolvedImageUrl = await falUpload(photoPath, persona.mimeType, persona.photoFileName);
      personaName = persona.name;
    }

    const model = pickModel(level, !!resolvedImageUrl, duration);
    const isSeedance = model.family === 'seedance';
    const prompt = buildPrompt({ product, benefit, style, dialog, image: resolvedImageUrl });

    // Build endpoint + payload
    let endpoint, payload;
    if (resolvedImageUrl) {
      endpoint = model.endpoint; // already i2v
      if (isSeedance) {
        payload = { image_url: resolvedImageUrl, prompt, aspect_ratio: '9:16', duration: String(parseInt(duration,10)), resolution: '1080p', generate_audio: true };
      } else {
        payload = { image_url: resolvedImageUrl, prompt, aspect_ratio: '9:16', resolution: '1080p', duration: duration.endsWith('s') ? duration : duration + 's', generate_audio: true, negative_prompt: 'on-screen text, captions, subtitles, watermark', safety_tolerance: '4', auto_fix: true };
      }
    } else {
      endpoint = MODELS_T2V[isSeedance ? 'uzun' : level].endpoint;
      if (isSeedance) {
        payload = { prompt, aspect_ratio: '9:16', duration: String(parseInt(duration,10)), resolution: '720p', generate_audio: true };
      } else {
        payload = { prompt, aspect_ratio: '9:16', resolution: '1080p', duration: duration.endsWith('s') ? duration : duration + 's', generate_audio: true, negative_prompt: 'on-screen text, captions, subtitles', safety_tolerance: '4', auto_fix: true };
      }
    }

    const submitRes = await falSubmit(endpoint, payload);
    const jobId = crypto.randomBytes(8).toString('hex');
    const job = {
      id: jobId,
      createdAt: new Date().toISOString(),
      product, benefit, style, level, duration, dialog,
      imageUrl: resolvedImageUrl,
      personaId: personaId || null,
      personaName,
      endpoint,
      requestId: submitRes.request_id,
      status: 'queued',
      cost: estimateCost(level, duration),
      videoUrl: null,
      subtitledUrl: null,
      transcription: null,
      error: null
    };
    upsertJob(job);
    pollJob(jobId); // background
    res.json({ jobId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/jobs', (req, res) => res.json(loadJobs()));
app.get('/api/jobs/:id', (req, res) => {
  const job = loadJobs().find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});
app.delete('/api/jobs/:id', (req, res) => {
  saveJobs(loadJobs().filter(j => j.id !== req.params.id));
  res.json({ ok: true });
});

// === Polling worker ===
async function pollJob(jobId) {
  const jobs = loadJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job) return;

  try {
    const status = await falStatus(job.endpoint, job.requestId);
    if (status.status === 'IN_PROGRESS' || status.status === 'IN_QUEUE') {
      upsertJob({ id: jobId, status: 'generating' });
      setTimeout(() => pollJob(jobId), 8000);
      return;
    }
    if (status.status === 'COMPLETED') {
      const result = await falResult(job.endpoint, job.requestId);
      if (!result.ok) {
        if (result.status === 422) {
          upsertJob({ id: jobId, status: 'rejected', error: 'Prompt rejected by fal (content/format). No charge. Try simpler prompt.' });
        } else if (result.status === 500) {
          upsertJob({ id: jobId, status: 'mcp_error', error: 'fal produced the video but result fetch failed. Check fal.ai/dashboard/requests for the URL.' });
        } else {
          upsertJob({ id: jobId, status: 'error', error: `Result fetch ${result.status}: ${String(result.body).slice(0, 200)}` });
        }
        return;
      }
      const videoUrl = result.body?.video?.url;
      if (!videoUrl) {
        upsertJob({ id: jobId, status: 'error', error: 'No video URL in result' });
        return;
      }
      upsertJob({ id: jobId, status: 'subtitling', videoUrl });
      await applySubtitles(jobId, videoUrl);
      return;
    }
    // Anything else = treat as error
    upsertJob({ id: jobId, status: 'error', error: `Unexpected status: ${status.status}` });
  } catch (e) {
    upsertJob({ id: jobId, status: 'error', error: e.message });
  }
}

async function applySubtitles(jobId, videoUrl) {
  try {
    const submit = await falSubmit(SUBTITLE_ENDPOINT, {
      video_url: videoUrl,
      language: 'tr',
      font_name: 'Montserrat',
      font_size: 90,
      font_weight: 'bold',
      font_color: 'white',
      highlight_color: 'yellow',
      stroke_width: 3,
      stroke_color: 'black',
      position: 'bottom',
      words_per_subtitle: 2,
      enable_animation: true
    });
    await new Promise(r => setTimeout(r, 5000));
    let attempts = 0;
    while (attempts < 30) {
      attempts++;
      const status = await falStatus(SUBTITLE_ENDPOINT, submit.request_id);
      if (status.status === 'COMPLETED') {
        const r = await falResult(SUBTITLE_ENDPOINT, submit.request_id);
        if (r.ok && r.body?.video?.url) {
          upsertJob({ id: jobId, status: 'completed', subtitledUrl: r.body.video.url, transcription: r.body.transcription || null });
          return;
        }
        upsertJob({ id: jobId, status: 'partial', error: 'Video ready but subtitle step failed; video URL is the unsubtitled version.' });
        return;
      }
      if (status.status !== 'IN_PROGRESS' && status.status !== 'IN_QUEUE') {
        upsertJob({ id: jobId, status: 'partial', error: `Subtitle status ${status.status}; video URL is unsubtitled.` });
        return;
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    upsertJob({ id: jobId, status: 'partial', error: 'Subtitle timeout; video URL is unsubtitled.' });
  } catch (e) {
    upsertJob({ id: jobId, status: 'partial', error: `Subtitle error: ${e.message}` });
  }
}

// Resume any jobs left mid-flight on restart
function resumePending() {
  const jobs = loadJobs();
  for (const j of jobs) {
    if (j.status === 'queued' || j.status === 'generating' || j.status === 'subtitling') {
      setTimeout(() => pollJob(j.id), 1000);
    }
  }
}

app.listen(PORT, () => {
  console.log(`\nUGC Video Studio mini-app running at http://localhost:${PORT}\n`);
  resumePending();
});
