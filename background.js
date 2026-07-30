// 요약 오케스트레이션: 컨텍스트 메뉴/플로팅 버튼 → 추출 → LLM → 오버레이 렌더링.
// 전자문서 팝업창(툴바 없음)에서도 동작해야 하므로 UI는 페이지 위 Shadow DOM 오버레이.
// 디자인: KRDS(대한민국 정부 디자인시스템) 컬러 토큰 기반.
import { summarize } from './llm.js';
import { pickSource, MAX_CHARS } from './pick.js';

const MENU_ID = 'edoc-summarize';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '📄 이 문서 AI 요약',
    contexts: ['page', 'selection', 'frame'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  runSummarize(tab.id);
});

// 플로팅 위젯 버튼(widget.js)·오버레이의 다시요약 버튼에서 오는 요청
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'edoc-summarize' && sender.tab?.id) runSummarize(sender.tab.id);
});

async function runSummarize(tabId) {
  const overlay = (state) =>
    chrome.scripting.executeScript({
      target: { tabId },
      func: renderOverlay,
      args: [state],
    });

  try {
    const config = await chrome.storage.sync.get(['provider', 'apiKey', 'model', 'baseUrl']);
    if (!config.apiKey && (config.provider || 'gemini') === 'gemini') {
      await overlay({ error: 'API 키가 없습니다. 확장 관리 → 확장 옵션에서 Gemini API 키를 입력하세요.' });
      return;
    }

    await overlay({ status: '본문 추출 중…' });
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['extractor.js'],
    });
    const frames = results.map((r) => r.result).filter(Boolean);
    let source = pickSource(frames);

    // DOM에서 공문 본문을 못 얻은 경우(캔버스 렌더링 웹한글): MAIN 월드에서 뷰어 JS API 프로브
    let probeDebug = '';
    if (!source || source.how === '문서카드') {
      await overlay({ status: '본문 추출 중… (뷰어 API 조회)' });
      const pr = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: probeHwpText,
      }).catch(() => []);
      const hits = (pr || []).map((r) => r.result).filter(Boolean);
      const hit = hits.find((h) => h.text);
      if (hit) {
        source = {
          text: (source ? source.text + '\n\n' : '') + '[공문 본문]\n' + hit.text,
          title: source?.title,
          how: source ? '카드+본문(API)' : '본문(API)',
        };
      } else {
        probeDebug = hits.filter((h) => h.globals.length)
          .map((h) => h.globals.join(', ')).join(' | ').slice(0, 500);
      }
    }
    if (!source) {
      await overlay({ error: '본문 추출 실패 — 본문 텍스트를 드래그 선택한 뒤 다시 시도하세요.' + (probeDebug ? ` [API 후보: ${probeDebug}]` : '') });
      return;
    }

    const text = source.text.slice(0, MAX_CHARS);
    await overlay({ status: '요약 중…' });
    const r = await summarize(text, config);
    await overlay({
      result: r,
      md: buildMarkdown(r),
      fileName: `AI요약_${(r.title || r.doc_type || '문서').slice(0, 40).replace(/[\\/:*?"<>|\s]/g, '_')}_${new Date().toISOString().slice(0, 10)}.md`,
      warn: source.how === '문서카드'
        ? '공문 본문(HWP)을 읽지 못해 문서카드 정보만 요약했습니다.'
          + ` [디버그: 프레임 ${frames.length}개, 하위 프레임 텍스트 길이 ${frames.filter((f) => !f.isTop).map((f) => f.bodyText?.length || 0).join('/') || '없음'}]`
          + (probeDebug ? ` [API 후보: ${probeDebug}]` : ' [API 후보 없음]')
        : '',
    });
  } catch (e) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: renderOverlay,
      args: [{ error: '요약 실패: ' + e.message }],
    }).catch(() => {});
  }
}

// 복사·내보내기용 마크다운 생성
function buildMarkdown(r) {
  const lines = [`# [${r.doc_type || '문서'}] ${r.title || r.one_line || ''}`];
  if (r.title && r.one_line) lines.push(`> ${r.one_line}`);
  const info = [];
  if (r.doc_no) info.push(`**문서번호**: ${r.doc_no}`);
  if (r.sent_date) info.push(`**시행일**: ${r.sent_date}`);
  if (r.sender) info.push(`**발신**: ${r.sender}`);
  if (r.receiver) info.push(`**수신**: ${r.receiver}`);
  if (info.length) lines.push('', info.join(' · '));
  if (r.deadline) lines.push(`\n**기한**: ${r.deadline}`);
  if (r.key_points?.length) lines.push('\n## 핵심 내용', ...r.key_points.map((k) => `- ${k}`));
  if (r.actions?.length) lines.push('\n## 조치 사항', ...r.actions.map((a) => `- [ ] ${a}`));
  if (r.cautions?.length) lines.push('\n## 주의', ...r.cautions.map((c) => `- ⚠ ${c}`));
  lines.push(`\n---\n_${new Date().toLocaleString('ko-KR')} · 전자문서 AI 요약_`);
  return lines.join('\n');
}

// ── MAIN 월드 주입: 한컴 웹한글 뷰어 JS API에서 본문 텍스트 추출 시도 ──
// 웹한글 기안기 공식 API: HwpCtrl.GetTextFile(format, option, callback).
// 자기완결 함수 — 외부 참조 금지.
async function probeHwpText() {
  const result = { url: location.href, globals: [], text: '' };
  const settle = async (v) => (v && typeof v.then === 'function' ? await v : v);
  try {
    const names = Object.getOwnPropertyNames(window).filter((k) => /hwp|edit|ctrl|docu|view/i.test(k));
    for (const name of names.slice(0, 80)) {
      let v;
      try { v = window[name]; } catch { continue; }
      if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
      // 텍스트 관련 메서드 목록 수집 (디버그·다음 라운드용)
      let fns = [];
      try {
        fns = [...new Set([
          ...Object.getOwnPropertyNames(v),
          ...Object.getOwnPropertyNames(Object.getPrototypeOf(v) || {}),
        ])].filter((f) => /text|content|body|save|get/i.test(f)).slice(0, 15);
      } catch { /* 접근 불가 객체 */ }
      if (fns.length) result.globals.push(`${name}{${fns.join(',')}}`);
      // 실제 호출은 한컴 컨트롤 객체로 한정 — 시스템 래퍼(HwpManager 등)를 건드리면
      // 내부 블록선택 로직이 실패하며 사용자에게 에러 모달이 뜬다 (실측: ERROR:HwpManager.selectBlock)
      if (!/^(hwpctrl|webhwpctrl)$/i.test(name)) continue;
      const stripHtml = (s) => s
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      for (const call of ['GetTextFile', 'getTextFile']) {
        if (typeof v[call] !== 'function') continue;
        for (const fmt of ['TEXT', 'UNICODE', 'HTML']) {
          const t = await new Promise((resolve) => {
            let done = false;
            const finish = (val) => { if (!done) { done = true; resolve(val); } };
            try {
              // 콜백 방식 우선, 동기 반환(구형 호환)도 수용
              const ret = v[call](fmt, '', (r) => finish(r));
              if (typeof ret === 'string' && ret.trim().length > 50) finish(ret);
            } catch { finish(null); }
            setTimeout(() => finish(null), 2500);
          });
          if (typeof t === 'string' && t.trim().length > 50) {
            const clean = (fmt === 'HTML' ? stripHtml(t) : t).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
            if (clean.length > 50) { result.text = clean; return result; }
          }
        }
      }
      for (const call of ['getText', 'GetText', 'getBodyText', 'getDocumentText']) {
        try {
          if (typeof v[call] === 'function') {
            const t = await settle(v[call]());
            if (typeof t === 'string' && t.trim().length > 50) { result.text = t.trim(); return result; }
          }
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    result.globals.push('ERR:' + e.message);
  }
  return result;
}

// ── 페이지 주입 오버레이 렌더러 (자기완결 함수 — 외부 참조 금지) ──
// KRDS 컬러: Primary #246BEB / Secondary #003675 / Point #E71825 / Gray 스케일.
// 헤더를 잡고 드래그 이동 가능. host가 렌더 간 유지되므로 위치·글자크기(dataset)도 유지된다.
function renderOverlay(state) {
  const HOST_ID = '__edoc_ai_summary_host';
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial; position:fixed; top:16px; right:16px; z-index:2147483647;';
    document.documentElement.appendChild(host);
    host.attachShadow({ mode: 'open' });
  }
  const root = host.shadowRoot;
  const fontSize = +(host.dataset.fs || 14);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // "라벨: 내용" → 라벨 볼드
  const item = (s) => {
    const m = /^([^:：]{1,12})[:：]\s*(.+)$/s.exec(String(s ?? ''));
    return m ? `<b>${esc(m[1])}</b> · ${esc(m[2])}` : esc(s);
  };
  const list = (items) => (items || []).map((i) => `<li>${item(i)}</li>`).join('');

  let body = '';
  const hasResult = !!state.result;
  if (state.status) body = `<div class="status"><span class="spin"></span>${esc(state.status)}</div>`;
  else if (state.error) body = `<div class="status error">${esc(state.error)}</div>`;
  else if (hasResult) {
    const r = state.result;
    // "2026-08-04" → 📅 2026. 8. 4.(화)까지 · D-5
    let deadline = '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.deadline || '');
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const diff = Math.round((d - today) / 86400000);
      const yoil = '일월화수목금토'[d.getDay()];
      const dday = diff > 0 ? `D-${diff}` : diff === 0 ? 'D-Day' : `기한 ${-diff}일 지남`;
      deadline = `<div class="deadline${diff <= 3 ? ' urgent' : ''}">📅 ${+m[1]}. ${+m[2]}. ${+m[3]}.(${yoil})까지 · <b>${dday}</b></div>`;
    }
    const actPill = r.action_required
      ? '<span class="pill need">조치 필요</span>'
      : '<span class="pill ref">참고</span>';
    const srcBits = [r.doc_no, r.sender && r.receiver ? `${r.sender} → ${r.receiver}` : r.sender || r.receiver, r.sent_date]
      .filter(Boolean).map(esc).join(' · ');
    body = `
      <div class="card main">
        <div><span class="pill type">${esc(r.doc_type || '문서')}</span>${actPill}</div>
        ${r.title
          ? `<div class="one">${esc(r.title)}</div><div class="sub">${esc(r.one_line)}</div>`
          : `<div class="one">${esc(r.one_line)}</div>`}
        ${srcBits ? `<div class="src">${srcBits}</div>` : ''}
        ${deadline}
      </div>
      <div class="card"><h2>핵심 내용</h2><ul>${list(r.key_points)}</ul></div>
      ${r.actions?.length ? `<div class="card act"><h2>조치 사항</h2><ul>${list(r.actions)}</ul></div>` : ''}
      ${r.cautions?.length ? `<div class="card warn"><h2>주의</h2><ul>${list(r.cautions)}</ul></div>` : ''}
      ${state.warn ? `<div class="notice">⚠ ${esc(state.warn)}</div>` : ''}`;
  }

  root.innerHTML = `
    <style>
      .panel {
        all: initial; display: block; box-sizing: border-box;
        --ink: #0B1B33; --ink2: #3D4E66; --ink3: #7C8AA0;
        --line: rgba(11, 27, 51, .07);
        --brand: #0A57D0; --teal: #00B8A9;
        --grad: linear-gradient(120deg, #0A57D0, #0891B2 55%, #00B8A9);
        --danger: #E5484D;
        width: 412px; max-height: 84vh; overflow-y: auto;
        background: rgba(248, 250, 253, .92);
        backdrop-filter: blur(16px) saturate(1.5); -webkit-backdrop-filter: blur(16px) saturate(1.5);
        color: var(--ink); border: 1px solid rgba(11, 27, 51, .09); border-radius: 18px;
        box-shadow: 0 1px 2px rgba(11, 27, 51, .06), 0 24px 64px -16px rgba(11, 27, 51, .38);
        font-family: 'Pretendard GovKR', Pretendard, 'Malgun Gothic', system-ui, sans-serif;
        font-size: ${fontSize}px; line-height: 1.62;
        word-break: keep-all; overflow-wrap: break-word;
        animation: enter .38s cubic-bezier(.21, 1.02, .55, 1);
      }
      @keyframes enter { from { opacity: 0; transform: translateY(12px) scale(.97); } }
      @media (prefers-reduced-motion: reduce) { .panel { animation: none; } }
      .panel::-webkit-scrollbar { width: 5px; }
      .panel::-webkit-scrollbar-thumb { background: rgba(11, 27, 51, .16); border-radius: 3px; }
      .head {
        display: flex; align-items: center; gap: 1px; padding: 13px 12px 11px 16px;
        position: sticky; top: 0; z-index: 1;
        background: rgba(248, 250, 253, .88); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        border-bottom: 1px solid var(--line); cursor: grab; user-select: none; border-radius: 18px 18px 0 0;
      }
      .head:active { cursor: grabbing; }
      .logo {
        width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; flex: none;
        background: var(--grad); box-shadow: 0 0 8px rgba(8, 145, 178, .55);
      }
      .head .t { font-weight: 800; font-size: 14px; letter-spacing: -.01em; color: var(--ink); flex: 1; }
      .tbtn {
        all: initial; cursor: pointer; font-family: inherit; font-size: 11.5px; font-weight: 650;
        color: var(--ink3); padding: 6px 8px; border-radius: 8px; line-height: 1; white-space: nowrap;
        transition: background .15s ease, color .15s ease;
      }
      .tbtn:hover { background: rgba(11, 27, 51, .06); color: var(--ink); }
      .tbtn:active { background: rgba(11, 27, 51, .1); }
      .bodywrap { display: flex; flex-direction: column; gap: 10px; padding: 13px 14px 15px; }
      .card {
        background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px;
        box-shadow: 0 1px 2px rgba(11, 27, 51, .04), 0 10px 28px -18px rgba(11, 27, 51, .18);
      }
      .card.main { position: relative; overflow: hidden; }
      .card.main::before {
        content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: var(--grad);
      }
      .pill { display: inline-block; border-radius: 999px; padding: 3.5px 12px; font-weight: 700; font-size: .84em; letter-spacing: .01em; }
      .pill.type { background: var(--grad); color: #fff; box-shadow: 0 2px 8px rgba(10, 87, 208, .3); }
      .pill.need { background: rgba(229, 72, 77, .1); color: var(--danger); margin-left: 6px; }
      .pill.ref { background: rgba(11, 27, 51, .06); color: var(--ink2); margin-left: 6px; }
      .one { font-weight: 750; font-size: 1.07em; letter-spacing: -.012em; margin-top: 10px; color: var(--ink); }
      .sub { margin-top: 5px; font-weight: 550; font-size: .97em; color: var(--ink2); }
      .src { margin-top: 7px; font-size: .84em; color: var(--ink3); }
      .deadline {
        margin-top: 10px; display: flex; align-items: center; gap: 6px;
        background: rgba(10, 87, 208, .07); color: var(--brand);
        border-radius: 10px; padding: 7px 11px; font-weight: 650; font-size: .95em;
      }
      .deadline.urgent { background: rgba(229, 72, 77, .09); color: var(--danger); position: relative; overflow: hidden; }
      .deadline.urgent::after {
        content: ''; position: absolute; inset: 0;
        background: linear-gradient(105deg, transparent 40%, rgba(255, 255, 255, .5) 50%, transparent 60%);
        animation: shimmer 2.8s ease-in-out infinite;
      }
      @keyframes shimmer { 0% { transform: translateX(-100%); } 55%, 100% { transform: translateX(100%); } }
      h2 {
        display: flex; align-items: center; gap: 7px; margin: 0 0 8px;
        font-size: .8em; font-weight: 750; letter-spacing: .05em; color: var(--ink3);
      }
      h2::before { content: ''; width: 3px; height: 11px; border-radius: 2px; background: var(--grad); }
      .act h2::before { background: linear-gradient(180deg, #12B76A, #00B8A9); }
      .warn h2::before { background: var(--danger); }
      .warn h2 { color: var(--danger); }
      ul { margin: 0; padding: 0; list-style: none; }
      li { padding-left: 14px; position: relative; margin-bottom: 7px; color: var(--ink2); }
      li:last-child { margin-bottom: 0; }
      li::before {
        content: ''; position: absolute; left: 0; top: .58em; width: 5px; height: 5px;
        border-radius: 50%; background: linear-gradient(135deg, #0A57D0, #0891B2);
      }
      li b { color: var(--ink); font-weight: 700; }
      .act li::before { background: #12B76A; }
      .warn { background: #FFFBFB; border-color: rgba(229, 72, 77, .18); }
      .warn li { color: #A63A3E; }
      .warn li::before { background: var(--danger); }
      .notice { background: rgba(245, 166, 35, .1); color: #8A5A00; border-radius: 10px; padding: 8px 12px; font-size: .88em; }
      .meta { color: var(--ink3); font-size: .8em; padding: 0 4px; opacity: .85; }
      .status { display: flex; align-items: center; gap: 9px; padding: 14px 18px 16px; color: var(--ink2); }
      .status.error { color: var(--danger); word-break: break-all; }
      .spin {
        width: 14px; height: 14px; flex: none; border-radius: 50%;
        background: conic-gradient(from 0deg, transparent 15%, #0A57D0, #00B8A9);
        -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px));
        mask: radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px));
        animation: rot .8s linear infinite;
      }
      @keyframes rot { to { transform: rotate(360deg); } }
    </style>
    <div class="panel">
      <div class="head" id="dragHandle">
        <span class="logo"></span>
        <span class="t">AI 문서 요약</span>
        ${hasResult ? `
          <button class="tbtn" id="bCopy" title="요약 복사">복사</button>
          <button class="tbtn" id="bExport" title="마크다운(.md)으로 저장">저장</button>
          <button class="tbtn" id="bMinus" title="글자 작게">가−</button>
          <button class="tbtn" id="bPlus" title="글자 크게">가＋</button>` : ''}
        <button class="tbtn" id="bRerun" title="다시 요약">↻</button>
        <button class="tbtn" id="bClose" title="닫기">✕</button>
      </div>
      ${state.status || state.error ? body : `<div class="bodywrap">${body}</div>`}
    </div>`;

  const $ = (id) => root.getElementById(id);
  $('bClose').addEventListener('click', () => host.remove());
  $('bRerun').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'edoc-summarize' }));
  if (hasResult) {
    $('bCopy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.md || '');
        $('bCopy').textContent = '✓ 복사됨';
        setTimeout(() => { const b = $('bCopy'); if (b) b.textContent = '복사'; }, 1500);
      } catch {
        $('bCopy').textContent = '복사 실패';
      }
    });
    $('bExport').addEventListener('click', () => {
      const blob = new Blob([state.md || ''], { type: 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = state.fileName || 'AI요약.md';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    const setFs = (delta) => {
      const next = Math.min(18, Math.max(12, (+host.dataset.fs || 14) + delta));
      host.dataset.fs = next;
      root.querySelector('.panel').style.fontSize = next + 'px';
    };
    $('bMinus').addEventListener('click', () => setFs(-1));
    $('bPlus').addEventListener('click', () => setFs(1));
  }

  // 헤더 드래그로 패널 이동 (버튼 클릭은 제외)
  const handle = $('dragHandle');
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.tbtn')) return;
    const rect = host.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    const move = (ev) => {
      host.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - offX)) + 'px';
      host.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offY)) + 'px';
      host.style.right = 'auto';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}
