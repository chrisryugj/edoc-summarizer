import { summarize } from './llm.js';
import { pickSource, MAX_CHARS, MIN_CHARS } from './pick.js';

const $ = (id) => document.getElementById(id);

let lastMd = ''; // 복사용 마크다운

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

async function run() {
  $('result').classList.add('hidden');
  $('pasteArea').style.display = 'none';

  const config = await chrome.storage.sync.get(['provider', 'apiKey', 'model', 'baseUrl']);
  if (!config.apiKey && (config.provider || 'gemini') === 'gemini') {
    setStatus('API 키가 없습니다. ⚙ 설정에서 Gemini API 키를 입력하세요.', true);
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
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['extractor.js'],
    });
    return pickSource(results.map((r) => r.result).filter(Boolean));
  } catch (e) {
    console.warn('extract failed:', e);
    return null; // 접근 불가 페이지(edge:// 등) → 붙여넣기 폴백
  }
}

async function doSummarize(source, config) {
  config = config || (await chrome.storage.sync.get(['provider', 'apiKey', 'model', 'baseUrl']));
  const text = source.text.slice(0, MAX_CHARS);
  setStatus(`요약 중… (${source.how}, ${text.length.toLocaleString()}자)`);
  try {
    const r = await summarize(text, config);
    render(r, source, text.length);
    setStatus('');
  } catch (e) {
    setStatus('요약 실패: ' + e.message, true);
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

function render(r, source, chars) {
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
  const noCardBody = source.how === '문서카드';
  $('notice').classList.toggle('hidden', !noCardBody);
  if (noCardBody) $('notice').textContent = '⚠ 공문 본문(HWP)을 읽지 못해 문서카드 정보만 요약했습니다. 뷰어에서 본문을 드래그 선택한 뒤 다시 실행하세요.';
  $('meta').textContent = '';
  $('result').classList.remove('hidden');

  const md = [`# [${r.doc_type || '문서'}] ${r.title || r.one_line || ''}`];
  if (r.title && r.one_line) md.push(`> ${r.one_line}`);
  const info = [];
  if (r.doc_no) info.push(`**문서번호**: ${r.doc_no}`);
  if (r.sent_date) info.push(`**시행일**: ${r.sent_date}`);
  if (r.sender) info.push(`**발신**: ${r.sender}`);
  if (r.receiver) info.push(`**수신**: ${r.receiver}`);
  if (info.length) md.push('', info.join(' · '));
  if (r.deadline) md.push(`\n**기한**: ${r.deadline}`);
  if (r.key_points?.length) md.push('\n## 핵심 내용', ...r.key_points.map((k) => `- ${k}`));
  if (r.actions?.length) md.push('\n## 조치 사항', ...r.actions.map((a) => `- [ ] ${a}`));
  if (r.cautions?.length) md.push('\n## 주의', ...r.cautions.map((c) => `- ⚠ ${c}`));
  lastMd = md.join('\n');
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
