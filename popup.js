import { summarize } from './llm.js';
import { pickSource, sameOriginFrames, clampText, MAX_CHARS, MIN_CHARS } from './pick.js';
import { loadConfig } from './config.js';
import { buildMarkdown } from './md.js';

const $ = (id) => document.getElementById(id);

let lastMd = '';           // 복사용 마크다운
let running = null;        // 진행 중 요청 — 재실행 시 이전 스트림을 끊는다

document.addEventListener('DOMContentLoaded', run);
$('reBtn').addEventListener('click', run);
$('optBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('copyBtn').addEventListener('click', async () => {
  if (!lastMd) return;
  await navigator.clipboard.writeText(lastMd);
  $('copyBtn').textContent = '✓ 복사됨';
  setTimeout(() => ($('copyBtn').textContent = '📋 복사'), 1500);
});
$('pasteBtn').addEventListener('click', () => {
  const text = $('pasteText').value.trim();
  if (text.length < MIN_CHARS) return setStatus('본문이 너무 짧습니다.', true);
  doSummarize({ text, title: '', how: '붙여넣기' });
});

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  el.classList.toggle('hidden', !msg);
}

// 본문이 어디로 나가는지 상시 표시 — 설정 페이지의 정적 경고만으로는 실효성이 없다
function showProvider(provider) {
  const el = $('srcBadge');
  const external = provider === 'gemini';
  el.textContent = external ? 'Gemini · 외부 전송' : '로컬';
  el.title = external
    ? '문서 본문이 Google 서버(국외)로 전송됩니다'
    : '문서가 지정한 로컬·내부 서버 밖으로 나가지 않습니다';
  el.classList.toggle('ext', external);
  el.classList.remove('hidden');
}

async function run() {
  $('result').classList.add('hidden');
  $('pasteArea').style.display = 'none';

  const config = await loadConfig();
  showProvider(config.provider);
  if (config.provider === 'gemini' && !config.apiKey) {
    setStatus('Gemini API 키가 없습니다. ⚙ 설정에서 키를 입력하세요.', true);
    return;
  }

  setStatus('본문 추출 중…');
  const source = await extract();
  if (!source) {
    setStatus('');
    $('pasteArea').style.display = 'block';
    return;
  }
  doSummarize(source, config);
}

async function extract() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    let topOrigin = '';
    try { topOrigin = new URL(tab.url || '').origin; } catch { /* edge:// 등 */ }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['extractor.js'],
    });
    // 크로스오리진 프레임 본문은 제외 (background.js와 동일한 이유)
    const { frames } = sameOriginFrames(results.map((r) => r.result).filter(Boolean), topOrigin);
    return pickSource(frames);
  } catch (e) {
    console.warn('extract failed:', e);
    return null; // 접근 불가 페이지(edge:// 등) → 붙여넣기 폴백
  }
}

async function doSummarize(source, config) {
  config = config || (await loadConfig());
  showProvider(config.provider);
  running?.abort();
  const controller = new AbortController();
  running = controller;

  const { text, truncated, original } = clampText(source.text);
  setStatus(`요약 중… (${source.how}, ${text.length.toLocaleString()}자)`);
  try {
    // SSE 스트리밍 부분 결과를 즉시 렌더 (150ms 스로틀 + 내용 미변경 틱 스킵)
    let last = 0;
    let lastJson = '';
    const r = await summarize(text, config, {
      signal: controller.signal,
      onPartial: (p) => {
        const now = Date.now();
        if (now - last < 150) return;
        const j = JSON.stringify(p);
        if (j === lastJson) return;
        lastJson = j;
        last = now;
        render(p, source, true);
      },
    });
    if (controller.signal.aborted) return;
    render(r, source, false, { truncated, original });
    setStatus('');
  } catch (e) {
    if (e?.cancelled || controller.signal.aborted) return;
    setStatus('요약 실패: ' + e.message, true);
  } finally {
    if (running === controller) running = null;
  }
}

// "2026-08-04" → { text: '📅 2026. 8. 4.(화)까지 · D-5', urgent }
function fmtDeadline(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  const yoil = '일월화수목금토'[d.getDay()];
  const dday = diff > 0 ? `D-${diff}` : diff === 0 ? 'D-Day' : `기한 ${-diff}일 지남`;
  return { text: `📅 ${+m[1]}. ${+m[2]}. ${+m[3]}.(${yoil})까지 · ${dday}`, urgent: diff <= 3 };
}

function render(r, source, partial = false, info = {}) {
  $('docType').textContent = r.doc_type || '문서';
  $('actPill').textContent = r.action_required ? '조치 필요' : '참고';
  $('actPill').classList.toggle('need', !!r.action_required);
  $('oneLine').textContent = r.one_line || '';
  const dl = fmtDeadline(r.deadline);
  $('deadline').classList.toggle('hidden', !dl);
  if (dl) {
    $('deadline').textContent = dl.text;
    $('deadline').classList.toggle('urgent', dl.urgent);
  }
  fillList('keyPoints', r.key_points);
  fillList('actions', r.actions);
  fillList('cautions', r.cautions);
  $('actionsSec').classList.toggle('hidden', !r.actions?.length);
  $('cautionsSec').classList.toggle('hidden', !r.cautions?.length);

  const notes = [];
  if (!partial && source.how === '문서카드') {
    notes.push('공문 본문(HWP)을 읽지 못해 문서카드 정보만 요약했습니다. 뷰어에서 본문을 드래그 선택한 뒤 다시 실행하세요.');
  }
  // 조용한 절단 금지 — 뒷부분 기한이 빠진 채 "기한 없음"으로 보이는 걸 막는다
  if (!partial && info.truncated) {
    notes.push(`문서가 길어 앞 ${MAX_CHARS.toLocaleString()}자만 분석했습니다 (원문 ${info.original.toLocaleString()}자). 뒷부분의 기한·조치사항이 빠졌을 수 있습니다.`);
  }
  $('notice').classList.toggle('hidden', !notes.length);
  if (notes.length) $('notice').textContent = '⚠ ' + notes.join(' ');

  $('result').classList.remove('hidden');
  if (partial) return; // 복사용 마크다운은 최종 결과에서만
  lastMd = buildMarkdown(r);
}

function fillList(id, items) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bold = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const ul = $(id);
  ul.textContent = '';
  for (const item of items || []) {
    const li = document.createElement('li');
    // "라벨: 내용" → 라벨 볼드, **강조** → <b>
    const m = /^([^:：]{1,12})[:：]\s*(.+)$/s.exec(String(item ?? ''));
    li.innerHTML = m ? `<b>${esc(m[1])}</b> · ${bold(m[2])}` : bold(item);
    ul.appendChild(li);
  }
}
