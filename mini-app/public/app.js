// UGC Video Studio mini-app frontend

const els = {
  health: document.getElementById('health'),
  product: document.getElementById('product'),
  benefit: document.getElementById('benefit'),
  style: document.getElementById('style'),
  duration: document.getElementById('duration'),
  level: document.getElementById('level'),
  image: document.getElementById('image'),
  imageStatus: document.getElementById('imageStatus'),
  dialog: document.getElementById('dialog'),
  costTotal: document.getElementById('costTotal'),
  costBreakdown: document.getElementById('costBreakdown'),
  produceBtn: document.getElementById('produceBtn'),
  produceMsg: document.getElementById('produceMsg'),
  jobs: document.getElementById('jobs'),
  personaName: document.getElementById('personaName'),
  personaPhoto: document.getElementById('personaPhoto'),
  personaSaveBtn: document.getElementById('personaSaveBtn'),
  personaMsg: document.getElementById('personaMsg'),
  personaList: document.getElementById('personaList'),
  personaSelector: document.getElementById('personaSelector'),
  composePreview: document.getElementById('composePreview'),
  composeImage: document.getElementById('composeImage'),
  composeApproveBtn: document.getElementById('composeApproveBtn'),
  composeRetryBtn: document.getElementById('composeRetryBtn'),
  composeMsg: document.getElementById('composeMsg'),
  personaPillBtn: document.getElementById('personaPillBtn'),
  personaPillText: document.getElementById('personaPillText'),
  personaDropdown: document.getElementById('personaDropdown'),
  activity: document.getElementById('activity'),
  activityCount: document.getElementById('activityCount'),
  balancePill: document.getElementById('balancePill'),
  balanceAmount: document.getElementById('balanceAmount')
};

let uploadedImageUrl = null;
let selectedPersonaId = '';
let composedImageUrl = null;
let composeApproved = false;
let currentBalance = null; // null = unknown, number = balance in dollars
let lastEstimatedCost = 0;

// === Tabs ===
document.querySelectorAll('.tab-header .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    const card = tab.closest('.card');
    card.querySelectorAll('.tab-header .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    card.querySelectorAll('.tab-pane').forEach(p => { p.classList.remove('active'); p.style.display = 'none'; });
    const pane = document.getElementById('tab-' + target);
    if (pane) { pane.classList.add('active'); pane.style.display = 'block'; }
  });
});

// === Persona pill dropdown ===
els.personaPillBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const shown = els.personaDropdown.style.display !== 'none';
  els.personaDropdown.style.display = shown ? 'none' : 'block';
});
document.addEventListener('click', (e) => {
  if (!els.personaDropdown.contains(e.target) && !els.personaPillBtn.contains(e.target)) {
    els.personaDropdown.style.display = 'none';
  }
});

function updatePersonaPill() {
  if (selectedPersonaId === '') {
    els.personaPillText.textContent = 'AI oluştursun';
  } else {
    const card = els.personaList.querySelector('[data-id="' + selectedPersonaId + '"]');
    if (card) {
      const nameEl = card.querySelector('.persona-name');
      els.personaPillText.textContent = nameEl ? nameEl.textContent : 'Kişi';
    }
  }
}

// === Message helpers ===
function showProduceMsg(text, type) {
  els.produceMsg.textContent = text;
  els.produceMsg.className = 'msg produce-msg' + (type ? ' ' + type : '');
}

function showProduceError(text) {
  els.produceMsg.textContent = text;
  els.produceMsg.className = 'msg produce-msg error';
}

// === Balance ===
async function refreshBalance() {
  try {
    const r = await fetch('/api/balance');
    const j = await r.json();
    if (j.available && typeof j.balance === 'number') {
      currentBalance = j.balance;
      els.balanceAmount.textContent = '$' + j.balance.toFixed(2);
      els.balancePill.style.display = 'inline-flex';
      // Color by level
      els.balancePill.classList.remove('low', 'empty');
      if (j.balance <= 0) els.balancePill.classList.add('empty');
      else if (j.balance < 5) els.balancePill.classList.add('low');
      checkBalanceSufficiency();
    } else {
      currentBalance = null;
      els.balancePill.style.display = 'none';
    }
  } catch {
    currentBalance = null;
    els.balancePill.style.display = 'none';
  }
}

function checkBalanceSufficiency() {
  if (currentBalance === null) return; // Unknown balance — don't block
  if (currentBalance < lastEstimatedCost) {
    els.produceBtn.disabled = true;
    showProduceError('Yetersiz bakiye ($' + currentBalance.toFixed(2) + '). Tahmini maliyet: $' + lastEstimatedCost.toFixed(2));
  } else if (els.produceMsg.textContent.startsWith('Yetersiz bakiye')) {
    els.produceBtn.disabled = false;
    els.produceMsg.textContent = '';
    els.produceMsg.className = 'msg produce-msg';
  }
}

// === Health check ===
async function checkHealth() {
  try {
    const r = await fetch('/api/health');
    const j = await r.json();
    if (j.key === 'present') { els.health.textContent = 'fal.ai bağlı ✓'; els.health.className = 'health ok'; }
    else { els.health.textContent = 'API key eksik — .env\'i kontrol et'; els.health.className = 'health bad'; }
  } catch {
    els.health.textContent = 'sunucu yanıt vermiyor';
    els.health.className = 'health bad';
  }
}

// === Cost ===
function needsCompose() {
  return selectedPersonaId !== '' && els.image.files.length > 0;
}
async function updateCost() {
  const level = els.level.value;
  const duration = els.duration.value;
  const compose = needsCompose() ? '1' : '';
  const r = await fetch('/api/cost?level=' + level + '&duration=' + duration + '&compose=' + compose);
  const j = await r.json();
  const [int, dec] = j.total.toFixed(2).split('.');
  els.costTotal.innerHTML = '$ ' + int + '<span class="cost-dec">.' + dec + '</span>';
  const parts = ['video $' + j.video.toFixed(2), 'altyazı $' + j.subtitle.toFixed(3)];
  if (j.compose > 0) parts.push('görsel birleştirme $' + j.compose.toFixed(2));
  els.costBreakdown.textContent = parts.join(' + ');
  lastEstimatedCost = j.total;
  checkBalanceSufficiency();
}

['change', 'input'].forEach(ev => {
  els.level.addEventListener(ev, updateCost);
  els.duration.addEventListener(ev, updateCost);
});

// === Personas ===
els.personaPhoto.addEventListener('change', () => {
  const hasFile = els.personaPhoto.files.length > 0;
  els.personaPhoto.closest('.persona-photo-label').classList.toggle('has-file', hasFile);
});

els.personaSaveBtn.addEventListener('click', async () => {
  const name = els.personaName.value.trim();
  const photo = els.personaPhoto.files[0];
  els.personaMsg.textContent = '';
  els.personaMsg.className = 'msg';

  if (!name) { els.personaMsg.className = 'msg error'; els.personaMsg.textContent = 'İsim gerekli.'; return; }
  if (!photo) { els.personaMsg.className = 'msg error'; els.personaMsg.textContent = 'Fotoğraf gerekli.'; return; }

  const fd = new FormData();
  fd.append('name', name);
  fd.append('photo', photo);

  els.personaSaveBtn.disabled = true;
  els.personaSaveBtn.textContent = 'Kaydediliyor...';
  try {
    const r = await fetch('/api/personas', { method: 'POST', body: fd });
    const j = await r.json();
    if (j.id) {
      els.personaMsg.className = 'msg success';
      els.personaMsg.textContent = j.name + ' eklendi.';
      els.personaName.value = '';
      els.personaPhoto.value = '';
      els.personaPhoto.closest('.persona-photo-label').classList.remove('has-file');
      await refreshPersonas();
    } else {
      els.personaMsg.className = 'msg error';
      els.personaMsg.textContent = j.error || 'Hata';
    }
  } catch (e) {
    els.personaMsg.className = 'msg error';
    els.personaMsg.textContent = e.message;
  } finally {
    els.personaSaveBtn.disabled = false;
    els.personaSaveBtn.textContent = 'Kaydet';
  }
});

function renderPersonaList(personas) {
  if (!personas.length) {
    els.personaList.innerHTML = '<div class="empty">Henüz kişi eklenmedi.</div>';
    return;
  }
  els.personaList.innerHTML = personas.map(p =>
    '<div class="persona-card" data-id="' + p.id + '">' +
      '<img src="/api/personas/' + p.id + '/photo" alt="' + escapeHtml(p.name) + '" />' +
      '<span class="persona-name">' + escapeHtml(p.name) + '</span>' +
      '<button class="persona-delete" data-id="' + p.id + '" title="Sil">&times;</button>' +
    '</div>'
  ).join('');

  els.personaList.querySelectorAll('.persona-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('"' + btn.closest('.persona-card').querySelector('.persona-name').textContent + '" silinsin mi?')) return;
      await fetch('/api/personas/' + btn.dataset.id, { method: 'DELETE' });
      if (selectedPersonaId === btn.dataset.id) {
        selectedPersonaId = '';
      }
      await refreshPersonas();
    });
  });
}

function renderPersonaSelector(personas) {
  const aiOption =
    '<label class="persona-option' + (selectedPersonaId === '' ? ' selected' : '') + '" data-id="">' +
      '<input type="radio" name="persona" value="" ' + (selectedPersonaId === '' ? 'checked' : '') + ' />' +
      '<div class="persona-option-inner ai-option">' +
        '<span class="persona-option-icon">AI</span>' +
        '<span>AI oluştursun</span>' +
      '</div>' +
    '</label>';

  const personaOptions = personas.map(p =>
    '<label class="persona-option' + (selectedPersonaId === p.id ? ' selected' : '') + '" data-id="' + p.id + '">' +
      '<input type="radio" name="persona" value="' + p.id + '" ' + (selectedPersonaId === p.id ? 'checked' : '') + ' />' +
      '<div class="persona-option-inner">' +
        '<img src="/api/personas/' + p.id + '/photo" alt="' + escapeHtml(p.name) + '" />' +
        '<span>' + escapeHtml(p.name) + '</span>' +
      '</div>' +
    '</label>'
  ).join('');

  els.personaSelector.innerHTML = aiOption + personaOptions;

  els.personaSelector.querySelectorAll('.persona-option').forEach(opt => {
    opt.addEventListener('click', () => {
      selectedPersonaId = opt.dataset.id;
      els.personaSelector.querySelectorAll('.persona-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      opt.querySelector('input[type=radio]').checked = true;
      updatePersonaPill();
      updateImageFieldState();
      els.personaDropdown.style.display = 'none';
    });
  });

  updatePersonaPill();
}

function updateImageFieldState() {
  els.image.disabled = false;
  if (selectedPersonaId !== '' && els.image.files.length > 0) {
    els.imageStatus.textContent = 'Kişi + ürün görseli birleştirilecek.';
  } else if (selectedPersonaId !== '') {
    els.imageStatus.textContent = 'Kişi fotoğrafı ilk kare olarak kullanılacak. Ürün görseli de ekleyebilirsin.';
  } else {
    els.imageStatus.textContent = '';
  }
  resetCompose();
  updateCost();
}

async function refreshPersonas() {
  try {
    const r = await fetch('/api/personas');
    const personas = await r.json();
    renderPersonaList(personas);
    renderPersonaSelector(personas);
    updateImageFieldState();
  } catch {}
}

// === Image upload ===
els.image.addEventListener('change', async () => {
  resetCompose();
  const f = els.image.files[0];
  if (!f) { uploadedImageUrl = null; updateImageFieldState(); return; }

  if (selectedPersonaId !== '') {
    els.imageStatus.textContent = 'Kişi + ürün görseli birleştirilecek. "Üret" veya "Yeniden Üret" butonunu kullan.';
    uploadedImageUrl = null;
    updateCost();
    showComposeButton();
    return;
  }

  els.imageStatus.textContent = 'Yükleniyor...';
  const fd = new FormData();
  fd.append('file', f);
  try {
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    const j = await r.json();
    if (j.url) { uploadedImageUrl = j.url; els.imageStatus.textContent = 'Yüklendi ✓ (image-to-video kullanılacak)'; }
    else { els.imageStatus.textContent = 'Yükleme hatası: ' + (j.error || 'bilinmeyen'); }
  } catch (e) { els.imageStatus.textContent = 'Yükleme hatası: ' + e.message; }
  updateCost();
});

// === Compose (persona + product image) ===
function resetCompose() {
  composedImageUrl = null;
  composeApproved = false;
  els.composePreview.style.display = 'none';
  els.composeImage.src = '';
  els.composeMsg.textContent = '';
}

function showComposeButton() {
  if (selectedPersonaId !== '' && els.image.files.length > 0) {
    els.composePreview.style.display = 'block';
    els.composeImage.src = '';
    els.composeMsg.textContent = 'Görselleri birleştirmek için "Yeniden Üret" veya üretim öncesi otomatik birleştirilir.';
    composeApproved = false;
  }
}

async function runCompose() {
  if (!selectedPersonaId || !els.image.files[0]) return;
  els.composePreview.style.display = 'block';
  els.composeMsg.textContent = 'Birleştiriliyor...';
  els.composeMsg.className = 'msg';
  els.composeApproveBtn.disabled = true;
  els.composeRetryBtn.disabled = true;

  const fd = new FormData();
  fd.append('personaId', selectedPersonaId);
  fd.append('productImage', els.image.files[0]);

  try {
    const r = await fetch('/api/compose', { method: 'POST', body: fd });
    const j = await r.json();
    if (j.url) {
      composedImageUrl = j.url;
      composeApproved = false;
      els.composeImage.src = j.url;
      els.composeMsg.textContent = 'Görsel hazır. Beğenirsen "Onayla", yoksa "Yeniden Üret".';
      els.composeMsg.className = 'msg success';
    } else {
      els.composeMsg.textContent = j.error || 'Birleştirme hatası';
      els.composeMsg.className = 'msg error';
    }
  } catch (e) {
    els.composeMsg.textContent = e.message;
    els.composeMsg.className = 'msg error';
  } finally {
    els.composeApproveBtn.disabled = false;
    els.composeRetryBtn.disabled = false;
  }
}

els.composeApproveBtn.addEventListener('click', async () => {
  if (!composedImageUrl) return;
  composeApproved = true;
  els.composeMsg.textContent = 'Onaylandı ✓ Video üretimi başlatılıyor...';
  els.composeMsg.className = 'msg success';
  // Auto-trigger produce after compose approval
  await submitProduce();
});

els.composeRetryBtn.addEventListener('click', () => {
  composedImageUrl = null;
  composeApproved = false;
  runCompose();
});

// === Produce ===
let produceConfirmPending = false;
let produceConfirmTimer = null;

async function submitProduce() {
  const product = els.product.value.trim();
  if (!product) {
    showProduceError('Ürün/marka zorunlu. "Oluştur" sekmesinden doldur.');
    // Switch to create tab so user sees the field
    document.querySelector('[data-tab="create"]').click();
    els.product.focus();
    return;
  }

  els.produceBtn.disabled = true;
  els.produceBtn.textContent = 'Gönderiliyor...';
  showProduceMsg('Üretim gönderiliyor...', '');
  try {
    const body = {
      product,
      benefit: els.benefit.value.trim(),
      style: els.style.value,
      level: els.level.value,
      duration: els.duration.value,
      dialog: els.dialog.value.trim(),
      imageUrl: (selectedPersonaId && !composeApproved) ? '' : uploadedImageUrl,
      personaId: selectedPersonaId || '',
      composedImageUrl: composeApproved ? composedImageUrl : ''
    };
    const r = await fetch('/api/produce', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.jobId) {
      showProduceMsg('Üretim kuyruğa alındı (id: ' + j.jobId.slice(0,6) + ')', 'success');
      resetCompose();
      await refreshJobs();
    } else {
      showProduceError(j.error || 'Bilinmeyen hata');
    }
  } catch (e) {
    showProduceError(e.message);
  } finally {
    els.produceBtn.disabled = false;
    els.produceBtn.textContent = 'Video Oluştur';
    produceConfirmPending = false;
  }
}

els.produceBtn.addEventListener('click', async () => {
  // If compose is needed but not done yet
  if (needsCompose() && !composeApproved) {
    if (!composedImageUrl) {
      showProduceMsg('Görseller birleştiriliyor...', '');
      els.produceBtn.disabled = true;
      els.produceBtn.textContent = 'Birleştiriliyor...';
      await runCompose();
      els.produceBtn.disabled = false;
      els.produceBtn.textContent = 'Video Oluştur';
      if (!composedImageUrl) return;
    }
    showProduceMsg('Birleştirilen görseli onaylayın (sağ paneldeki "Onayla" butonu).', '');
    return;
  }

  // Two-step confirmation: first click → "Onayla: $X.XX", second click → submit
  if (!produceConfirmPending) {
    produceConfirmPending = true;
    els.produceBtn.textContent = 'Onayla: ' + els.costTotal.textContent.trim();
    els.produceBtn.classList.add('confirm-state');
    showProduceMsg('Üretimi başlatmak için tekrar tıkla.', '');
    // Auto-reset after 5 seconds if not confirmed
    clearTimeout(produceConfirmTimer);
    produceConfirmTimer = setTimeout(() => {
      produceConfirmPending = false;
      els.produceBtn.textContent = 'Video Oluştur';
      els.produceBtn.classList.remove('confirm-state');
      els.produceMsg.textContent = '';
    }, 5000);
    return;
  }

  // Second click — confirmed
  clearTimeout(produceConfirmTimer);
  produceConfirmPending = false;
  els.produceBtn.classList.remove('confirm-state');
  await submitProduce();
});

// === Jobs ===
const STATUS_LABELS = {
  queued: 'Kuyrukta',
  generating: 'Üretiliyor',
  subtitling: 'Altyazı ekleniyor',
  completed: 'Hazır',
  partial: 'Kısmi (altyazısız)',
  rejected: 'Reddedildi (para kesilmedi)',
  mcp_error: 'fal hazır, sunucu hatası',
  error: 'Hata'
};

const STATUS_ICONS = {
  queued: '⏳',
  generating: '🎬',
  subtitling: '✍️',
  completed: '✅',
  partial: '⚠️',
  rejected: '🚫',
  mcp_error: '⚠️',
  error: '❌'
};

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'az önce';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + ' dk önce';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + ' sa önce';
  const days = Math.floor(hours / 24);
  return days + ' gün önce';
}

function renderJobs(jobs) {
  if (!jobs.length) { els.jobs.innerHTML = '<div class="empty">Henüz üretim yok.</div>'; return; }
  els.jobs.innerHTML = jobs.map(j => {
    const videoUrl = j.subtitledUrl || j.videoUrl;
    const videoBlock = videoUrl
      ? '<div class="job-video"><video src="' + videoUrl + '" controls preload="metadata"></video></div>'
      : '<div class="job-video">' + (j.status === 'generating' ? '⏳ üretiliyor...' : j.status === 'subtitling' ? '✍️ altyazı...' : (STATUS_LABELS[j.status] || j.status)) + '</div>';
    const errorBlock = j.error ? '<div class="job-error">' + j.error + '</div>' : '';
    const downloadBtn = videoUrl ? '<a href="' + videoUrl + '" download="' + (j.product || 'video') + '-' + j.id.slice(0,6) + '.mp4">İndir</a>' : '';
    const openBtn = videoUrl ? '<a href="' + videoUrl + '" target="_blank">Aç</a>' : '';
    const personaTag = j.personaName ? '<span class="tag">' + escapeHtml(j.personaName) + '</span>' : '<span class="tag">AI</span>';
    return '<div class="job-card">' +
      videoBlock +
      '<div class="job-meta">' +
        '<div class="title">' + escapeHtml(j.product || 'Ürün') + '</div>' +
        '<span class="status ' + j.status + '">' + (STATUS_LABELS[j.status] || j.status) + '</span>' +
        '<div class="tags">' +
          personaTag +
          '<span class="tag">' + j.style + '</span>' +
          '<span class="tag">' + j.duration + (/^\d+$/.test(j.duration) ? 's' : '') + '</span>' +
          '<span class="tag">' + j.level + '</span>' +
          '<span class="tag">$' + (j.cost?.total || 0).toFixed(2) + '</span>' +
        '</div>' +
      '</div>' +
      errorBlock +
      '<div class="job-actions">' +
        openBtn + downloadBtn +
        '<button class="delete" data-id="' + j.id + '">Sil</button>' +
      '</div>' +
    '</div>';
  }).join('');
  els.jobs.querySelectorAll('button.delete').forEach(b => {
    b.addEventListener('click', async () => {
      if (!confirm('Bu üretimi listeden silmek istiyor musun?')) return;
      await fetch('/api/jobs/' + b.dataset.id, { method: 'DELETE' });
      refreshJobs();
    });
  });
}

function renderActivity(jobs) {
  els.activityCount.innerHTML = '<span>' + jobs.length + '</span><span class="activity-count-label">üretim</span>';

  if (!jobs.length) {
    els.activity.innerHTML = '<div class="empty">Henüz aktivite yok.</div>';
    return;
  }
  els.activity.innerHTML = jobs.map(j => {
    const icon = STATUS_ICONS[j.status] || '●';
    return '<div class="activity-card status-' + j.status + '">' +
      '<div class="activity-time">' + timeAgo(j.createdAt) + '</div>' +
      '<div class="activity-card-title">' + escapeHtml(j.product || 'Ürün') + '</div>' +
      '<div class="activity-card-status">' + icon + ' ' + (STATUS_LABELS[j.status] || j.status) + '</div>' +
      '<div class="activity-tags">' +
        '<span class="activity-tag">' + j.style + '</span>' +
        '<span class="activity-tag">' + j.duration + (/^\d+$/.test(j.duration) ? 's' : '') + '</span>' +
        '<span class="activity-tag">$' + (j.cost?.total || 0).toFixed(2) + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

let _prevJobStatuses = '';
async function refreshJobs() {
  try {
    const r = await fetch('/api/jobs');
    const jobs = await r.json();
    renderJobs(jobs);
    renderActivity(jobs);
    // Refresh balance when any job status changes (completion spends credits)
    const sig = jobs.map(j => j.id + ':' + j.status).join(',');
    if (sig !== _prevJobStatuses) {
      _prevJobStatuses = sig;
      refreshBalance();
    }
  } catch {}
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
}

// === Init ===
checkHealth();
refreshBalance();
updateCost();
refreshPersonas();
refreshJobs();
setInterval(refreshJobs, 5000);
