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
    await overlay({ status: `요약 중… (${source.how}, ${text.length.toLocaleString()}자)` });
    const r = await summarize(text, config);
    const meta = `${source.how} · ${text.length.toLocaleString()}자 분석`;
    await overlay({
      result: r,
      meta,
      md: buildMarkdown(r, source.title, meta),
      fileName: `AI요약_${(r.doc_type || '문서').replace(/[\\/:*?"<>|\s]/g, '_')}_${new Date().toISOString().slice(0, 10)}.md`,
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
function buildMarkdown(r, title, meta) {
  const lines = [`# [${r.doc_type || '문서'}] ${r.one_line || ''}`];
  if (title) lines.push(`> ${title}`);
  if (r.deadline) lines.push(`\n**기한**: ${r.deadline}`);
  if (r.key_points?.length) lines.push('\n## 핵심 내용', ...r.key_points.map((k) => `- ${k}`));
  if (r.actions?.length) lines.push('\n## 조치 사항', ...r.actions.map((a) => `- [ ] ${a}`));
  if (r.cautions?.length) lines.push('\n## 주의', ...r.cautions.map((c) => `- ⚠ ${c}`));
  lines.push(`\n---\n_${meta} · ${new Date().toLocaleString('ko-KR')} · 전자문서 AI 요약_`);
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
  if (state.status) body = `<div class="status">${esc(state.status)}</div>`;
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
    body = `
      <div class="card main">
        <div><span class="pill type">${esc(r.doc_type || '문서')}</span>${actPill}</div>
        <div class="one">${esc(r.one_line)}</div>
        ${deadline}
      </div>
      <div class="card"><h2>핵심 내용</h2><ul>${list(r.key_points)}</ul></div>
      ${r.actions?.length ? `<div class="card act"><h2>조치 사항</h2><ul>${list(r.actions)}</ul></div>` : ''}
      ${r.cautions?.length ? `<div class="card warn"><h2>주의</h2><ul>${list(r.cautions)}</ul></div>` : ''}
      ${state.warn ? `<div class="notice">⚠ ${esc(state.warn)}</div>` : ''}
      <div class="meta">${esc(state.meta || '')}</div>`;
  }

  root.innerHTML = `
    <style>
      .panel {
        all: initial; display: block; box-sizing: border-box;
        width: 408px; max-height: 84vh; overflow-y: auto;
        background: #F4F5F6; color: #1E2124; border: 1px solid #CDD1D5; border-radius: 16px;
        box-shadow: 0 12px 40px rgba(0, 54, 117, .25);
        font-family: 'Pretendard GovKR', Pretendard, 'Malgun Gothic', system-ui, sans-serif;
        font-size: ${fontSize}px; line-height: 1.6;
        word-break: keep-all; overflow-wrap: break-word;
      }
      .panel::-webkit-scrollbar { width: 6px; }
      .panel::-webkit-scrollbar-thumb { background: #CDD1D5; border-radius: 3px; }
      .head {
        display: flex; align-items: center; gap: 2px; padding: 12px 12px 8px 16px;
        position: sticky; top: 0; background: #F4F5F6; z-index: 1;
        border-bottom: 1px solid #E6E8EA; cursor: grab; user-select: none; border-radius: 16px 16px 0 0;
      }
      .head:active { cursor: grabbing; }
      .head .t { font-weight: 800; font-size: 15px; color: #003675; flex: 1; }
      .tbtn {
        all: initial; cursor: pointer; font-family: inherit; font-size: 12px; font-weight: 600;
        color: #58616A; padding: 5px 7px; border-radius: 6px; line-height: 1; white-space: nowrap;
      }
      .tbtn:hover { background: #E6E8EA; color: #1E2124; }
      .bodywrap { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 14px; }
      .card { background: #fff; border: 1px solid #E6E8EA; border-radius: 12px; padding: 13px 15px; }
      .pill { display: inline-block; border-radius: 999px; padding: 3px 12px; font-weight: 700; font-size: .86em; }
      .pill.type { background: #246BEB; color: #fff; }
      .pill.need { background: #FDEFEF; color: #E71825; margin-left: 6px; }
      .pill.ref { background: #E6E8EA; color: #58616A; margin-left: 6px; }
      .one { font-weight: 700; font-size: 1.04em; margin-top: 9px; color: #1E2124; }
      .deadline { margin-top: 9px; background: #ECF2FE; color: #246BEB; border-radius: 8px; padding: 6px 10px; font-weight: 600; }
      .deadline.urgent { background: #FDEFEF; color: #E71825; }
      h2 { font-size: .88em; color: #246BEB; font-weight: 800; margin: 0 0 7px; }
      ul { margin: 0; padding: 0; list-style: none; }
      li { padding-left: 13px; position: relative; margin-bottom: 6px; color: #464C53; }
      li::before { content: ''; position: absolute; left: 0; top: .62em; width: 5px; height: 5px; border-radius: 50%; background: #246BEB; }
      li b { color: #1E2124; }
      .act h2 { color: #008A1E; } .act li::before { background: #008A1E; }
      .warn { background: #FDF7F7; border-color: #F5C4C8; }
      .warn h2 { color: #E71825; } .warn li::before { background: #E71825; }
      .notice { background: #FFF8E9; color: #9A6A00; border-radius: 10px; padding: 7px 11px; font-size: .9em; }
      .meta { color: #8A949E; font-size: .82em; padding: 0 4px; }
      .status { padding: 10px 16px 14px; color: #58616A; }
      .status.error { color: #E71825; word-break: break-all; }
    </style>
    <div class="panel">
      <div class="head" id="dragHandle">
        <span class="t">✨ AI 문서 요약</span>
        ${hasResult ? `
          <button class="tbtn" id="bCopy" title="요약 복사">📋 복사</button>
          <button class="tbtn" id="bExport" title="마크다운(.md)으로 저장">⬇ 저장</button>
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
        setTimeout(() => { const b = $('bCopy'); if (b) b.textContent = '📋 복사'; }, 1500);
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
