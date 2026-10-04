'use strict';

// ============================== 状态 ==============================
const state = {
  videos: [],
  currentVideo: null,   // { ...video, segments:[], publications:[] }
  editor: null,         // {mode:'create'|'edit', id, revision, orig:{...}}
  conflict: null,       // 保存冲突时暂存“我的原稿”
  playheadTimer: null
};

const $ = (id) => document.getElementById(id);
const el = {
  actorInput: $('actorInput'),
  uploadForm: $('uploadForm'),
  titleInput: $('titleInput'),
  fileInput: $('fileInput'),
  durationInput: $('durationInput'),
  durationHint: $('durationHint'),
  uploadProgress: $('uploadProgress'),
  videoList: $('videoList'),
  workspace: $('workspace'),
  emptyState: $('emptyState'),
  videoTitle: $('videoTitle'),
  videoMeta: $('videoMeta'),
  player: $('player'),
  overlay: $('subtitleOverlay'),
  timeline: $('timeline'),
  addAtPlayhead: $('addAtPlayhead'),
  editorCard: $('editorCard'),
  editorTitle: $('editorTitle'),
  startInput: $('startInput'),
  endInput: $('endInput'),
  startMs: $('startMs'),
  endMs: $('endMs'),
  textInput: $('textInput'),
  editorMeta: $('editorMeta'),
  editorWarning: $('editorWarning'),
  saveSegment: $('saveSegment'),
  cancelEdit: $('cancelEdit'),
  segTbody: $('segTbody'),
  publishStatus: $('publishStatus'),
  publishNote: $('publishNote'),
  publishBtn: $('publishBtn'),
  publicationList: $('publicationList'),
  downloadDraft: $('downloadDraft'),
  deleteVideoBtn: $('deleteVideoBtn'),
  conflictModal: $('conflictModal'),
  conflictMsg: $('conflictMsg'),
  conflictMine: $('conflictMine'),
  conflictCurrent: $('conflictCurrent'),
  conflictRetry: $('conflictRetry'),
  conflictDiscard: $('conflictDiscard'),
  toast: $('toast')
};

// ============================== 工具 ==============================
function toast(message, kind = '') {
  el.toast.textContent = message;
  el.toast.className = 'toast ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.add('hidden'), 4000);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function msToClock(ms) {
  ms = Math.max(0, Math.round(Number(ms) || 0));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(sec)}.${p(milli, 3)}`;
}

// 接受 "1234" / "1234ms" / "[HH:]MM:SS.mmm" / "MM:SS"
function parseTime(str) {
  if (typeof str !== 'string') return NaN;
  const t = str.trim().toLowerCase();
  if (/^-?\d+\s*(ms)?$/.test(t)) {
    const n = Number(t.replace(/ms$/, '').trim());
    return Number.isFinite(n) ? n : NaN;
  }
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  if (min >= 60 || sec >= 60) return NaN;
  return h * 3600000 + min * 60000 + sec * 1000 + frac;
}

function actor() {
  const v = el.actorInput.value.trim();
  if (!v) throw new Error('请先在右上角填写操作人');
  return v;
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `请求失败（${res.status}）`);
    err.status = res.status;
    err.code = data?.error?.code;
    err.details = data?.error?.details;
    throw err;
  }
  return data;
}

function editorIsDirty() {
  if (!state.editor) return false;
  const o = state.editor.orig;
  return parseTime(el.startInput.value) !== o.start_ms
    || parseTime(el.endInput.value) !== o.end_ms
    || el.textInput.value.trim() !== o.text;
}

// ============================== 视频列表 / 上传 ==============================
async function loadVideos(keepSelection) {
  state.videos = await api('GET', '/api/videos');
  renderVideoList();
  if (state.currentVideo) {
    const fresh = state.videos.find((v) => v.id === state.currentVideo.id);
    if (fresh) {
      state.currentVideo.stats = fresh.stats;
      renderVideoHead();
      renderPublishStatus();
    }
  }
}

function renderVideoList() {
  el.videoList.innerHTML = '';
  if (!state.videos.length) {
    el.videoList.innerHTML = '<li class="hint" style="cursor:default">还没有视频</li>';
    return;
  }
  for (const v of state.videos) {
    const li = document.createElement('li');
    if (state.currentVideo && v.id === state.currentVideo.id) li.classList.add('active');
    li.innerHTML = `
      <div class="v-title">${esc(v.title)}</div>
      <div class="v-sub">${msToClock(v.duration_ms)} · 片段 ${v.stats.segment_count} · 已审 ${v.stats.reviewed_count} · 版本 ${v.stats.published_count}</div>
    `;
    li.addEventListener('click', () => openVideo(v.id));
    el.videoList.appendChild(li);
  }
}

el.fileInput.addEventListener('change', () => {
  const file = el.fileInput.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const probe = document.createElement('video');
  probe.preload = 'metadata';
  probe.src = url;
  const done = (ms) => {
    if (ms && Number.isFinite(ms) && ms > 0) el.durationInput.value = String(Math.round(ms));
    URL.revokeObjectURL(url);
  };
  probe.addEventListener('loadedmetadata', () => done(probe.duration * 1000));
  probe.addEventListener('error', () => { el.durationHint.textContent = '浏览器无法探测时长，请手动填写毫秒数'; done(0); });
});

el.uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  let op;
  try { op = actor(); } catch (err) { return toast(err.message, 'error'); }

  const file = el.fileInput.files[0];
  if (!file) return toast('请选择视频文件', 'error');
  const durationMs = Number(el.durationInput.value.trim());
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    return toast('请填写正确的视频时长（正整数毫秒）', 'error');
  }

  const fd = new FormData();
  fd.append('video', file);
  fd.append('title', el.titleInput.value.trim());
  fd.append('duration_ms', String(durationMs));

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/videos');
  xhr.setRequestHeader('X-Actor', op); // 仅备注；片段操作时 actor 在 JSON 中发送
  el.uploadProgress.classList.remove('hidden');
  el.uploadProgress.textContent = '上传中 0%';

  xhr.upload.onprogress = (ev) => {
    if (ev.lengthComputable) {
      el.uploadProgress.textContent = `上传中 ${Math.round(ev.loaded / ev.total * 100)}%`;
    }
  };

  const result = await new Promise((resolve, reject) => {
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data?.error?.message || `上传失败（${xhr.status}）`), {
        status: xhr.status, code: data?.error?.code
      }));
    };
    xhr.onerror = () => reject(new Error('网络错误，上传中断'));
    xhr.send(fd);
  }).catch((err) => ({ __error: err }));

  if (result.__error) {
    el.uploadProgress.textContent = '';
    el.uploadProgress.classList.add('hidden');
    return toast(result.__error.message, 'error');
  }

  el.uploadProgress.textContent = '上传完成';
  toast('视频已上传', 'ok');
  el.uploadForm.reset();
  el.durationInput.value = '';
  setTimeout(() => el.uploadProgress.classList.add('hidden'), 2000);
  await loadVideos();
  openVideo(result.id);
});

// ============================== 打开视频 ==============================
async function openVideo(id) {
  const data = await api('GET', `/api/videos/${id}`);
  state.currentVideo = data;
  state.editor = null;
  el.emptyState.classList.add('hidden');
  el.workspace.classList.remove('hidden');

  el.player.src = `/api/videos/${id}/media`;
  el.downloadDraft.href = `/api/videos/${id}/srt?version=draft`;

  renderVideoHead();
  renderSegments();
  renderTimeline();
  renderPublishStatus();
  renderPublications();
  renderVideoList();
  resetEditor({ mode: 'create' });
}

function renderVideoHead() {
  const v = state.currentVideo;
  el.videoTitle.textContent = v.title;
  el.videoMeta.textContent =
    `${v.origin_name} · 时长 ${msToClock(v.duration_ms)}（${v.duration_ms} ms）· ` +
    `片段 ${v.stats.segment_count}，已审 ${v.stats.reviewed_count}，已发布 ${v.stats.published_count} 版`;
}

el.deleteVideoBtn.addEventListener('click', async () => {
  const v = state.currentVideo;
  if (!confirm(`确定删除视频「${v.title}」及其全部片段与发布版本？此操作不可恢复。`)) return;
  await api('DELETE', `/api/videos/${v.id}`);
  state.currentVideo = null;
  el.player.removeAttribute('src');
  el.player.load();
  el.workspace.classList.add('hidden');
  el.emptyState.classList.remove('hidden');
  toast('视频已删除', 'ok');
  loadVideos();
});

// ============================== 编辑器 ==============================
function resetEditor(modeOrSegment) {
  if (modeOrSegment?.mode === 'edit') {
    const s = modeOrSegment;
    state.editor = {
      mode: 'edit', id: s.id, revision: s.revision,
      orig: { start_ms: s.start_ms, end_ms: s.end_ms, text: s.text }
    };
    el.editorTitle.textContent = `编辑片段 #${s.id}`;
    el.startInput.value = msToClock(s.start_ms);
    el.endInput.value = msToClock(s.end_ms);
    el.textInput.value = s.text;
    el.editorMeta.textContent =
      `当前修订 #${s.revision} · 创建 ${s.created_by} · 最后修改 ${s.updated_by}`;
    el.editorWarning.classList.toggle('hidden', !s.reviewed);
    el.editorWarning.textContent = s.reviewed
      ? '该片段已通过审校：保存任何修改都会自动撤销审校状态，需要重新审校。'
      : '';
  } else {
    state.editor = {
      mode: 'create', id: null, revision: null,
      orig: { start_ms: NaN, end_ms: NaN, text: '' }
    };
    el.editorTitle.textContent = '新建片段';
    el.startInput.value = '';
    el.endInput.value = '';
    el.textInput.value = '';
    el.editorMeta.textContent = '';
    el.editorWarning.classList.add('hidden');
  }
  refreshMsHints();
}

function refreshMsHints() {
  const s = parseTime(el.startInput.value);
  const e = parseTime(el.endInput.value);
  el.startMs.textContent = Number.isFinite(s) ? `= ${s} ms` : '';
  el.endMs.textContent = Number.isFinite(e) ? `= ${e} ms` : '';
}
el.startInput.addEventListener('input', refreshMsHints);
el.endInput.addEventListener('input', refreshMsHints);

document.querySelectorAll('[data-grab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const ms = Math.round(el.player.currentTime * 1000);
    if (btn.dataset.grab === 'start') el.startInput.value = msToClock(ms);
    else el.endInput.value = msToClock(ms);
    refreshMsHints();
  });
});

el.addAtPlayhead.addEventListener('click', () => {
  const start = Math.round(el.player.currentTime * 1000);
  resetEditor({ mode: 'create' });
  el.startInput.value = msToClock(start);
  el.endInput.value = msToClock(Math.min(
    state.currentVideo.duration_ms,
    start + 2000
  ));
  refreshMsHints();
  el.textInput.focus();
});

el.cancelEdit.addEventListener('click', () => resetEditor({ mode: 'create' }));

function readEditorPayload() {
  const startMs = parseTime(el.startInput.value);
  const endMs = parseTime(el.endInput.value);
  const text = el.textInput.value.trim();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error('时间格式无法识别，请使用 HH:MM:SS.mmm 或毫秒整数');
  }
  if (!text) throw new Error('字幕文本不能为空');
  return { start_ms: startMs, end_ms: endMs, text };
}

el.saveSegment.addEventListener('click', async () => {
  await saveSegment(false);
});

async function saveSegment(isRetry) {
  let payload;
  try {
    payload = readEditorPayload();
    payload.actor = actor();
  } catch (err) {
    return toast(err.message, 'error');
  }

  const ed = state.editor;
  const mineSnapshot = { ...payload };

  try {
    let saved;
    if (ed.mode === 'create') {
      saved = await api('POST', `/api/videos/${state.currentVideo.id}/segments`, payload);
      toast(`片段 #${saved.id} 已创建（修订 #1）`, 'ok');
    } else {
      // 冲突重试时使用服务端最新修订号（由弹窗逻辑把 ed.revision 更新）
      payload.revision = ed.revision;
      saved = await api('PUT',
        `/api/videos/${state.currentVideo.id}/segments/${ed.id}`, payload);
      toast(saved.revision === ed.revision
        ? '内容没有变化'
        : `片段 #${saved.id} 已保存（修订 #${saved.revision}）`, 'ok');
    }
    el.conflictModal.classList.add('hidden');
    state.conflict = null;
    await refreshDetail({ keepEditor: true });
    if (ed.mode === 'edit') startEdit(saved.id);
    else resetEditor({ mode: 'create' });
  } catch (err) {
    await handleSaveError(err, mineSnapshot, isRetry);
  }
}

async function handleSaveError(err, mineSnapshot, isRetry) {
  if (err.status === 409 && err.code === 'revision_conflict') {
    // 过期修改：展示冲突双方，保留原稿，绝不覆盖
    const current = err.details.current;
    state.conflict = { mine: mineSnapshot, current };
    state.editor.revision = current.revision; // 重试基线更新为最新修订
    el.conflictMsg.textContent = err.message;
    el.conflictMine.textContent =
      `起点: ${mineSnapshot.start_ms} ms\n终点: ${mineSnapshot.end_ms} ms\n\n${mineSnapshot.text}`;
    el.conflictCurrent.textContent =
      `起点: ${current.start_ms} ms（${msToClock(current.start_ms)}）\n` +
      `终点: ${current.end_ms} ms（${msToClock(current.end_ms)}）\n` +
      `审校: ${current.reviewed ? '已审' : '未审'} · 修订 #${current.revision} · ${current.updated_by}\n\n${current.text}`;
    el.conflictModal.classList.remove('hidden');
    return;
  }
  // 422 等非法修改：服务端已说明原因，原稿保留在表单中
  toast(err.message, 'error');
  if (err.details?.errors) {
    el.editorWarning.classList.remove('hidden');
    el.editorWarning.textContent = err.details.errors.join('\n');
  } else if (err.details?.conflicts_with) {
    el.editorWarning.classList.remove('hidden');
    el.editorWarning.textContent = err.message;
  }
  await refreshDetail({ keepEditor: true });
}

el.conflictDiscard.addEventListener('click', () => {
  el.conflictModal.classList.add('hidden');
  state.conflict = null;
  refreshDetail({ keepEditor: false });
  resetEditor({ mode: 'create' });
  toast('已放弃本次修改，内容已刷新为服务端版本');
});

el.conflictRetry.addEventListener('click', () => {
  // 用“我的原稿”的时间与文本，基于最新修订再保存一次（仍可能因重叠等被 422 拒绝）
  const mine = state.conflict.mine;
  el.startInput.value = msToClock(mine.start_ms);
  el.endInput.value = msToClock(mine.end_ms);
  el.textInput.value = mine.text;
  refreshMsHints();
  saveSegment(true);
});

// ============================== 片段列表 ==============================
function renderSegments() {
  const segs = state.currentVideo.segments;
  el.segTbody.innerHTML = '';
  if (!segs.length) {
    el.segTbody.innerHTML = '<tr><td colspan="6" class="hint">还没有片段，点击上方“在播放位置新建片段”开始</td></tr>';
    return;
  }
  for (const s of segs) {
    const tr = document.createElement('tr');
    if (state.editor?.id === s.id) tr.classList.add('selected');
    tr.innerHTML = `
      <td>${s.id}</td>
      <td>
        ${msToClock(s.start_ms)}<br>
        <span class="hint">${s.start_ms} → ${s.end_ms} ms</span>
      </td>
      <td class="seg-text">${esc(s.text)}</td>
      <td><span class="badge ${s.reviewed ? 'done' : 'pending'}">${s.reviewed ? '已审' : '未审'}</span></td>
      <td>#${s.revision}<br><span class="hint">${esc(s.updated_by)}</span></td>
      <td class="row-actions"></td>
    `;
    const actions = tr.querySelector('.row-actions');

    const playBtn = mkBtn('跳转', 'small', () => {
      el.player.currentTime = s.start_ms / 1000;
      el.player.play();
    });
    const editBtn = mkBtn('编辑', 'small', () => startEdit(s.id));
    const reviewBtn = mkBtn(s.reviewed ? '取消审校' : '标记已审', 'small', async () => {
      await toggleReview(s, !s.reviewed);
    });
    const delBtn = mkBtn('删除', 'small danger', async () => {
      if (!confirm(`删除片段 #${s.id}（${msToClock(s.start_ms)}–${msToClock(s.end_ms)}）？`)) return;
      await deleteSegment(s);
    });
    actions.append(playBtn, editBtn, reviewBtn, delBtn);
    el.segTbody.appendChild(tr);
  }
}

function mkBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'btn ' + cls;
  b.textContent = label;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function startEdit(segId) {
  const s = state.currentVideo.segments.find((x) => x.id === segId);
  if (!s) return;
  resetEditor({ mode: 'edit', ...s });
  renderSegments();
  el.editorCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function toggleReview(s, reviewed) {
  try {
    await api('POST',
      `/api/videos/${state.currentVideo.id}/segments/${s.id}/review`,
      { actor: actor(), revision: s.revision, reviewed });
    toast(reviewed ? `片段 #${s.id} 已标记审校通过` : `片段 #${s.id} 已取消审校`, 'ok');
    await refreshDetail({ keepEditor: true });
  } catch (err) {
    await handleMutationError(err);
  }
}

async function deleteSegment(s) {
  try {
    await api('DELETE',
      `/api/videos/${state.currentVideo.id}/segments/${s.id}?revision=${s.revision}`);
    toast(`片段 #${s.id} 已删除`, 'ok');
    if (state.editor?.id === s.id) resetEditor({ mode: 'create' });
    await refreshDetail({ keepEditor: true });
  } catch (err) {
    await handleMutationError(err);
  }
}

async function handleMutationError(err) {
  if (err.status === 409 && err.code === 'revision_conflict') {
    toast(`冲突：${err.message}，界面已刷新为当前内容`, 'error');
  } else {
    toast(err.message, 'error');
  }
  await refreshDetail({ keepEditor: false });
  resetEditor({ mode: 'create' });
}

// ============================== 时间轴 ==============================
function renderTimeline() {
  const v = state.currentVideo;
  const dur = v.duration_ms;
  el.timeline.innerHTML = '';

  // 刻度：按总时长自动选择间隔
  const steps = 10;
  const rawStep = dur / steps;
  const niceSteps = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000];
  const step = niceSteps.find((x) => x >= rawStep) || 3600000;
  for (let t = 0; t <= dur; t += step) {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = `${(t / dur) * 100}%`;
    tick.innerHTML = `<span>${msToClock(t)}</span>`;
    el.timeline.appendChild(tick);
  }

  for (const s of v.segments) {
    const block = document.createElement('div');
    block.className = 'seg-block' + (s.reviewed ? ' reviewed' : '');
    if (state.editor?.id === s.id) block.classList.add('selected');
    block.style.left = `${(s.start_ms / dur) * 100}%`;
    block.style.width = `${Math.max(0.4, ((s.end_ms - s.start_ms) / dur) * 100)}%`;
    block.title = `#${s.id} ${msToClock(s.start_ms)}–${msToClock(s.end_ms)}\n${s.text}`;
    block.textContent = `#${s.id} ${s.text.replace(/\n/g, ' ')}`;
    block.addEventListener('click', (e) => {
      e.stopPropagation();
      el.player.currentTime = s.start_ms / 1000;
    });
    block.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startEdit(s.id);
    });
    el.timeline.appendChild(block);
  }

  const head = document.createElement('div');
  head.className = 'playhead';
  head.id = 'playhead';
  el.timeline.appendChild(head);
  updatePlayhead();
}

el.timeline.addEventListener('click', (e) => {
  // 片段块自行处理点击（含 stopPropagation）；其余位置按比例跳转
  if (e.target.closest('.seg-block') || e.target.closest('.playhead')) return;
  const rect = el.timeline.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  el.player.currentTime = (ratio * state.currentVideo.duration_ms) / 1000;
});

function updatePlayhead() {
  const head = document.getElementById('playhead');
  if (!head || !state.currentVideo) return;
  const ratio = (el.player.currentTime * 1000) / state.currentVideo.duration_ms;
  head.style.left = `${Math.min(100, ratio * 100)}%`;
  renderOverlay();
}
el.player.addEventListener('timeupdate', updatePlayhead);

function renderOverlay() {
  if (!state.currentVideo) return;
  const now = el.player.currentTime * 1000;
  const active = state.currentVideo.segments.find((s) => now >= s.start_ms && now < s.end_ms);
  el.overlay.textContent = active ? active.text : '';
}

// ============================== 发布 ==============================
function renderPublishStatus() {
  const v = state.currentVideo;
  const segs = v.segments;
  const problems = [];
  if (segs.length === 0) problems.push('至少需要一个字幕片段');
  const unreviewed = segs.filter((s) => !s.reviewed);
  if (unreviewed.length) problems.push(`${unreviewed.length} 个片段未审校：${unreviewed.map((s) => '#' + s.id).join('、')}`);
  for (const s of segs) {
    if (s.start_ms < 0 || s.end_ms <= s.start_ms || s.end_ms > v.duration_ms) {
      problems.push(`片段 #${s.id} 时间不合法`);
    }
  }
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].start_ms < segs[i - 1].end_ms && segs[i].id !== segs[i - 1].id) {
      problems.push(`片段 #${segs[i - 1].id} 与 #${segs[i].id} 重叠`);
    }
  }

  const ok = problems.length === 0;
  el.publishStatus.innerHTML =
    `共 <b>${segs.length}</b> 个片段，已审 <b>${segs.length - unreviewed.length}</b> 个。` +
    (ok
      ? ' <span style="color:var(--green)">✔ 满足发布条件</span>'
      : `<br><span style="color:var(--amber)">${problems.map(esc).join('<br>')}</span>`);
  el.publishBtn.disabled = !ok;
}

el.publishBtn.addEventListener('click', async () => {
  try {
    const pub = await api('POST',
      `/api/videos/${state.currentVideo.id}/publications`,
      { actor: actor(), note: el.publishNote.value.trim() });
    toast(`已发布不可变版本 v${pub.version}`, 'ok');
    el.publishNote.value = '';
    await refreshDetail({ keepEditor: true });
  } catch (err) {
    toast(err.message, 'error');
    await refreshDetail({ keepEditor: false });
  }
});

function renderPublications() {
  const list = state.currentVideo.publications || [];
  el.publicationList.innerHTML = '';
  if (!list.length) {
    el.publicationList.innerHTML = '<li class="hint">尚未发布任何版本</li>';
    return;
  }
  for (const p of list) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    left.innerHTML = `<b>v${p.version}</b> <span class="hint">${p.segment_count} 条 · ${esc(p.created_by)} · ${p.created_at}</span>` +
      (p.note ? `<br><span class="note">${esc(p.note)}</span>` : '');
    const right = document.createElement('div');
    const a = document.createElement('a');
    a.className = 'btn small';
    a.textContent = '⬇ 下载该版本 SRT';
    a.href = `/api/videos/${state.currentVideo.id}/srt?version=${p.version}`;
    a.download = '';
    right.appendChild(a);
    li.append(left, right);
    el.publicationList.appendChild(li);
  }
}

// ============================== 数据刷新（轮询他人修改） ==============================
async function refreshDetail({ keepEditor, selectId } = {}) {
  if (!state.currentVideo) return;
  const data = await api('GET', `/api/videos/${state.currentVideo.id}`);
  const dirty = editorIsDirty();
  state.currentVideo = data;
  renderVideoHead();
  renderSegments();
  renderTimeline();
  renderPublishStatus();
  renderPublications();
  renderVideoList();

  if (keepEditor && state.editor?.mode === 'edit') {
    const fresh = data.segments.find((s) => s.id === state.editor.id);
    if (!fresh) {
      resetEditor({ mode: 'create' });
    } else if (!dirty) {
      resetEditor({ mode: 'edit', ...fresh });
    } else {
      // 用户正在输入：只更新修订基线提示，不动表单
      state.editor.revision = fresh.revision;
    }
  }
  if (selectId && !state.editor) {
    renderSegments();
  }
}

setInterval(() => {
  // 正在输入时不打断；其余情况每 5 秒拉取一次他人的修改
  if (state.currentVideo && !editorIsDirty()) {
    refreshDetail({ keepEditor: true }).catch(() => {});
  }
  loadVideos().catch(() => {});
}, 5000);

// ============================== 初始化 ==============================
el.actorInput.value = localStorage.getItem('subtitle.actor') || '';
el.actorInput.addEventListener('change', () => {
  localStorage.setItem('subtitle.actor', el.actorInput.value.trim());
});

loadVideos().then(() => {
  if (!state.videos.length) el.emptyState.classList.remove('hidden');
}).catch((err) => toast('初始化失败：' + err.message, 'error'));
