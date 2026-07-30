// 요약 오케스트레이션: 컨텍스트 메뉴/플로팅 버튼 → 추출 → LLM → 오버레이 렌더링.
// 전자문서 팝업창(툴바 없음)에서도 동작해야 하므로 UI는 페이지 위 Shadow DOM 오버레이.
// 디자인: KRDS(대한민국 정부 디자인시스템) 컬러 토큰 기반.
import { summarize, review } from './llm.js';
import { pickSource, MAX_CHARS } from './pick.js';

const MENU_SUM = 'edoc-summarize';
const MENU_REV = 'edoc-review';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_SUM,
    title: '📄 이 문서 AI 요약',
    contexts: ['page', 'selection', 'frame'],
  });
  chrome.contextMenus.create({
    id: MENU_REV,
    title: '🔍 이 문서 AI 검토 (결재 전)',
    contexts: ['page', 'selection', 'frame'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === MENU_SUM) runSummarize(tab.id, 'summary');
  else if (info.menuItemId === MENU_REV) runSummarize(tab.id, 'review');
});

// 플로팅 위젯 버튼(widget.js)·오버레이의 요약/검토/새로고침 버튼에서 오는 요청
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab?.id) return;
  const force = msg?.force === true;
  if (msg?.type === 'edoc-summarize') runSummarize(sender.tab.id, 'summary', { force });
  else if (msg?.type === 'edoc-review') runSummarize(sender.tab.id, 'review', { force });
});

// 탭이 닫히면 해당 탭의 결과 캐시 정리
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([`cache_${tabId}_summary`, `cache_${tabId}_review`]);
});

async function runSummarize(tabId, mode = 'summary', { force = false } = {}) {
  const overlay = (state) =>
    chrome.scripting.executeScript({
      target: { tabId },
      func: renderOverlay,
      args: [{ mode, ...state }],
    });

  // 모드 전환(요약↔검토) 시 매번 재스트리밍하지 않도록 탭·모드·URL별 결과 캐시.
  // storage.session: 서비스워커가 죽어도 유지, 브라우저 종료 시 소멸. ↻ 버튼이 force로 무효화.
  const cacheKey = `cache_${tabId}_${mode}`;
  const tabUrl = (await chrome.tabs.get(tabId).catch(() => null))?.url || '';
  if (!force) {
    const { [cacheKey]: hit } = await chrome.storage.session.get(cacheKey);
    if (hit && hit.url && hit.url === tabUrl) {
      await overlay(hit.state);
      return;
    }
  }

  // MV3 서비스워커는 30초 유휴 시 종료됨 — 로컬 LLM처럼 30초 넘는 요청 중에 워커가 죽으면
  // 연결이 끊긴다(실측: Ollama 요청이 정확히 30.0s에 500). 주기적 API 호출로 수명 연장.
  const keepalive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
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
    await overlay({ status: mode === 'review' ? '검토 중…' : '요약 중…' });

    // SSE 스트리밍: 부분 결과를 오버레이에 계속 그린다
    // (재주입 과부하 방지 180ms 스로틀 + 내용 미변경 틱 스킵 — 타이핑 연출은 renderOverlay가 담당)
    let lastPaint = 0;
    let lastJson = '';
    const onPartial = (p) => {
      const now = Date.now();
      if (now - lastPaint < 180) return;
      const j = JSON.stringify(p);
      if (j === lastJson) return;
      lastJson = j;
      lastPaint = now;
      overlay(mode === 'review' ? { review: p, partial: true } : { result: p, partial: true }).catch(() => {});
    };
    const warn = source.how === '문서카드'
      ? '공문 본문(HWP)을 읽지 못해 문서카드 정보만 분석했습니다.'
        + ` [디버그: 프레임 ${frames.length}개, 하위 프레임 텍스트 길이 ${frames.filter((f) => !f.isTop).map((f) => f.bodyText?.length || 0).join('/') || '없음'}]`
        + (probeDebug ? ` [API 후보: ${probeDebug}]` : ' [API 후보 없음]')
      : '';
    const fname = (prefix, t) =>
      `${prefix}_${(t || '문서').slice(0, 40).replace(/[\\/:*?"<>|\s]/g, '_')}_${new Date().toISOString().slice(0, 10)}.md`;

    let finalState;
    if (mode === 'review') {
      const v = await review(text, config, { onPartial });
      finalState = { review: v, md: buildReviewMarkdown(v), fileName: fname('AI검토', source.title || v.status), warn };
    } else {
      const r = await summarize(text, config, { onPartial });
      finalState = { result: r, md: buildMarkdown(r), fileName: fname('AI요약', r.title || r.doc_type), warn };
    }
    await overlay(finalState);
    await chrome.storage.session.set({ [cacheKey]: { url: tabUrl, state: finalState } }).catch(() => {});
  } catch (e) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: renderOverlay,
      args: [{ mode, error: (mode === 'review' ? '검토 실패: ' : '요약 실패: ') + e.message }],
    }).catch(() => {});
  } finally {
    clearInterval(keepalive);
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

// 검토 결과 복사·내보내기용 마크다운
function buildReviewMarkdown(v) {
  const lines = [`# [AI 검토] ${v.status}`];
  if (v.summary) lines.push('', v.summary);
  const sec = (title, items) => {
    if (items?.length) lines.push(`\n## ${title}`, ...items.map((i) => `- ${i.title ? `**${i.title}** — ` : ''}${i.content}`));
  };
  sec('잘 작성된 부분', v.strengths);
  sec('보완이 필요한 부분', v.improvements);
  sec('결재 전 확인사항', v.checks);
  lines.push(`\n---\n_${new Date().toLocaleString('ko-KR')} · 전자문서 AI 검토_`);
  return lines.join('\n');
}

// ── MAIN 월드 주입: 한컴 웹한글 뷰어 JS API에서 본문 텍스트 추출 시도 ──
// 웹한글 기안기 공식 API: HwpCtrl.GetTextFile(format, option, callback).
// 자기완결 함수 — 외부 참조 금지.
async function probeHwpText() {
  const result = { url: location.href, globals: [], text: '' };
  const settle = async (v) => (v && typeof v.then === 'function' ? await v : v);
  try {
    // ── ① 후보 수집: 현재 창 전역 + 같은 출처 iframe 내부의 HwpCtrl/WebHwpCtrl ──
    const ctrls = [];
    const pushCtrl = (c) => {
      if (c && (typeof c === 'object' || typeof c === 'function') && !ctrls.includes(c)) ctrls.push(c);
    };
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
      if (/^(hwpctrl|webhwpctrl)$/i.test(name)) pushCtrl(v);
    }
    // executeScript가 못 들어가는 about:blank 프레임 대비 — 부모에서 contentWindow로 직접 조회.
    // 셀렉터는 KYCI 실전 검증 목록(우선순위순) + 전체 iframe 폴백.
    for (const sel of ['#hwpctrl_frame', 'iframe.hwpEditor', 'iframe[app-data="Editor"]', 'iframe[src*="hwpctrl" i]', 'iframe']) {
      for (const f of document.querySelectorAll(sel)) {
        try {
          pushCtrl(f.contentWindow?.HwpCtrl);
          pushCtrl(f.contentWindow?.WebHwpCtrl);
        } catch { /* cross-origin */ }
      }
    }

    // ── ② 후보별 추출: GetTextFile(콜백/동기) → InitScan+GetText 청크 → 단발 getText류 ──
    const stripHtml = (s) => s
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const normalize = (s) => s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    for (const v of ctrls) {
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
            const clean = normalize(fmt === 'HTML' ? stripHtml(t) : t);
            if (clean.length > 50) { result.text = clean; return result; }
          }
        }
      }
      // GetTextFile이 빈 값을 주는 뷰어 버전 폴백: InitScan 후 GetText를 반복 호출해
      // 문단 단위 청크를 모은다 (KYCI 실전 방식 — 배열 반환 시 첫 요소가 상태코드)
      if (typeof v.GetText === 'function') {
        let init = false;
        const chunks = [];
        try {
          if (typeof v.InitScan === 'function') { v.InitScan(); init = true; }
          for (let i = 0; i < 100000; i++) {
            const r = v.GetText();
            if (typeof r === 'string') {
              if (!r) break;
              chunks.push(r);
              continue;
            }
            if (Array.isArray(r)) {
              const t = r.filter((x) => typeof x === 'string').join('');
              if (t) chunks.push(t);
              const state = Number(r[0]);
              if (!t || state === 0 || state === 1 || state === 101 || state === 201) break;
              continue;
            }
            break;
          }
        } catch { /* 미지원 뷰어 */ } finally {
          if (init) { try { v.ReleaseScan(); } catch { /* ignore */ } }
        }
        const scanned = normalize(chunks.join(''));
        if (scanned.length > 50) { result.text = scanned; return result; }
      }
      for (const call of ['getText', 'getBodyText', 'getDocumentText']) {
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
  const isFirstMount = !host; // 재렌더(스트리밍 갱신) 시 등장 애니메이션 재생 금지 — 깜빡임 원인
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
  // 이스케이프 후 **볼드** 마크다운만 <b>로 변환
  const bold = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

  // ── 스트리밍 타이핑 연출 ──
  // 이전 렌더의 텍스트를 host에 기억해 두고, 늘어난 꼬리만 <span class="tw">로 감싸 페이드인.
  // 처음 등장한 항목은 .new 슬라이드인, 마지막으로 자란 요소 끝에는 타이핑 커서를 붙인다.
  const prevTxt = host.__txt || {};
  const nextTxt = {};
  let caretKey = null;
  const reveal = (key, raw, render = bold) => {
    const s = String(raw ?? '');
    nextTxt[key] = s;
    const old = prevTxt[key];
    if (partial && s) {
      if (typeof old === 'string' && old && s.startsWith(old)) {
        if (s.length > old.length) {
          caretKey = key;
          return render(old) + `<span class="tw">${render(s.slice(old.length))}</span>`;
        }
      } else {
        caretKey = key;
        return `<span class="tw">${render(s)}</span>`;
      }
    }
    return render(s);
  };
  const isNew = (key) => (partial && !(key in prevTxt) ? ' new' : '');

  // key_points: "라벨: 내용" → 라벨 태그 + 내용 행
  const kvList = (items, pfx = 'k') => (items || []).map((i, n) => {
    const k = pfx + n;
    const m = /^([^:：]{1,12})[:：]\s*(.+)$/s.exec(String(i ?? ''));
    return m
      ? `<li class="kv${isNew(k)}" data-k="${k}"><span class="kl">${esc(m[1])}</span><span class="kt">${reveal(k, m[2])}</span></li>`
      : `<li class="${isNew(k).trim()}" data-k="${k}">${reveal(k, i)}</li>`;
  }).join('');
  const list = (items, pfx = 'l') => (items || []).map((i, n) =>
    `<li class="${isNew(pfx + n).trim()}" data-k="${pfx + n}">${reveal(pfx + n, i)}</li>`).join('');

  const mode = state.mode || 'summary';
  const partial = !!state.partial;
  let body = '';
  const hasResult = (!!state.result || !!state.review) && !partial;
  if (state.status) body = `<div class="status"><span class="spin"></span>${esc(state.status)}</div>`;
  else if (state.error) body = `<div class="status error">${esc(state.error)}</div>`;
  else if (state.review) {
    const v = state.review;
    const st = String(v.status || '');
    const grade = /재검토/.test(st) ? 'bad' : /확인/.test(st) ? 'chk' : /보완/.test(st) ? 'mid' : /가능/.test(st) ? 'ok' : 'mid';
    // 요약 모드의 kv(라벨 칩) 스타일로 톤 통일 — 섹션 색상별 칩
    const chipCls = (cls) => (cls === 'act' ? 'kl g' : cls === 'warn' ? 'kl r' : 'kl');
    const sec = (cls, title, items, pfx) => (items?.length
      ? `<div class="card ${cls}"><h2>${title}</h2><ul>${items.map((i, n) => {
          const k = pfx + n;
          return i.title
            ? `<li class="kv${isNew(k)}" data-k="${k}"><span class="${chipCls(cls)}">${esc(i.title)}</span><span class="kt">${reveal(k, i.content)}</span></li>`
            : `<li class="${isNew(k).trim()}" data-k="${k}">${reveal(k, i.content)}</li>`;
        }).join('')}</ul></div>`
      : '');
    nextTxt.st = st;
    body = `
      <div class="card main">
        <div><span class="pill grade ${grade}${isNew('st')}">${esc(st || '검토 중…')}</span></div>
        ${v.summary ? `<div class="sub${isNew('sum')}" data-k="sum">${reveal('sum', v.summary)}</div>` : ''}
      </div>
      ${sec('act', '잘 작성된 부분', v.strengths, 'st-')}
      ${sec('', '보완이 필요한 부분', v.improvements, 'im-')}
      ${sec('warn', '결재 전 확인사항', v.checks, 'ck-')}
      ${state.warn ? `<div class="notice">⚠ ${esc(state.warn)}</div>` : ''}`;
  }
  else if (state.result) {
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
      deadline = `<div class="deadline${diff <= 3 ? ' urgent' : ''}${isNew('dl')}" data-k="dl">📅 ${+m[1]}. ${+m[2]}. ${+m[3]}.(${yoil})까지 · <b>${dday}</b></div>`;
      nextTxt.dl = '1';
    }
    const actPill = r.action_required
      ? '<span class="pill need">조치 필요</span>'
      : '<span class="pill ref">참고</span>';
    const chip = (label, val) => (val ? `<span class="chip"><span class="cl">${esc(label)}</span>${esc(val)}</span>` : '');
    const chips = [
      chip('문서번호', r.doc_no),
      chip('발신', r.sender),
      chip('수신', r.receiver),
      chip('시행', r.sent_date),
    ].join('');
    body = `
      <div class="card main">
        <div><span class="pill type">${esc(r.doc_type || '문서')}</span>${actPill}</div>
        ${r.title ? `<div class="one ell" title="${esc(r.title)}" data-k="title">${reveal('title', r.title, esc)}</div>` : `<div class="one" data-k="one">${reveal('one', r.one_line, esc)}</div>`}
        ${chips ? `<div class="chips">${chips}</div>` : ''}
        ${r.title ? `<div class="sub" data-k="sub">${reveal('sub', r.one_line, esc)}</div>` : ''}
        ${deadline}
      </div>
      <div class="card"><h2>핵심 내용</h2><ul>${kvList(r.key_points, 'kp')}</ul></div>
      ${r.actions?.length ? `<div class="card act"><h2>조치 사항</h2><ul>${list(r.actions, 'ac')}</ul></div>` : ''}
      ${r.cautions?.length ? `<div class="card warn"><h2>주의</h2><ul>${list(r.cautions, 'ca')}</ul></div>` : ''}
      ${state.warn ? `<div class="notice">⚠ ${esc(state.warn)}</div>` : ''}`;
  }
  // 스트리밍 진행 표시 — 부분 결과 아래에 생성 중 인디케이터
  if (partial && (state.result || state.review)) {
    body += `<div class="gen"><span class="spin"></span>AI 생성 중…</div>`;
  }

  // 재렌더 시 스크롤 위치 유지 (스트리밍 중 반복 렌더 대비)
  const prevScroll = root.querySelector('.panel')?.scrollTop || 0;
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
        animation: ${isFirstMount ? 'enter .38s cubic-bezier(.21, 1.02, .55, 1)' : 'none'};
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
      .tbtn.on { background: rgba(10, 87, 208, .1); color: var(--brand); }
      .pill.grade.ok { background: rgba(18, 183, 106, .12); color: #0E9F6E; }
      .pill.grade.mid { background: rgba(245, 166, 35, .16); color: #B45309; }
      .pill.grade.chk { background: rgba(234, 88, 12, .13); color: #C2410C; }
      .pill.grade.bad { background: rgba(229, 72, 77, .12); color: #E5484D; }
      .gen { display: flex; align-items: center; gap: 8px; padding: 2px 4px; color: var(--ink3); font-size: .85em; }
      /* 스트리밍 타이핑 연출: 새 꼬리 페이드인 · 새 항목 슬라이드인 · 타이핑 커서 */
      .tw { animation: twin .35s ease both; }
      @keyframes twin { from { opacity: 0; } }
      .new { animation: itemin .3s cubic-bezier(.21, 1.02, .55, 1) both; }
      @keyframes itemin { from { opacity: 0; transform: translateY(5px); } }
      .caret {
        display: inline-block; width: 2px; height: 1em; margin-left: 3px; vertical-align: -.12em;
        background: var(--brand); animation: blink .9s steps(2) infinite;
      }
      @keyframes blink { 50% { opacity: 0; } }
      @media (prefers-reduced-motion: reduce) { .tw, .new, .caret { animation: none; } }
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
      .ell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sub { margin-top: 8px; font-weight: 550; font-size: .95em; color: var(--ink2); }
      .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
      .chip {
        display: inline-flex; align-items: center; gap: 6px;
        background: rgba(11, 27, 51, .05); border-radius: 7px; padding: 3.5px 9px;
        font-size: .8em; font-weight: 600; color: var(--ink2);
      }
      .chip .cl { color: var(--ink3); font-weight: 600; font-size: .92em; }
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
      li b { color: var(--ink); font-weight: 750; }
      li.kv { display: flex; align-items: flex-start; gap: 8px; padding-left: 0; }
      li.kv::before { display: none; }
      .kl {
        flex: none; background: rgba(10, 87, 208, .08); color: var(--brand);
        font-weight: 700; font-size: .78em; padding: 3px 9px; border-radius: 6px; margin-top: .12em;
      }
      .kl.g { background: rgba(18, 183, 106, .1); color: #0E9F6E; }
      .kl.r { background: rgba(229, 72, 77, .09); color: var(--danger); }
      .kt { min-width: 0; }
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
        <span class="t">${mode === 'review' ? 'AI 결재 검토' : 'AI 문서 요약'}</span>
        ${hasResult ? `
          <button class="tbtn" id="bCopy" title="결과 복사">복사</button>
          <button class="tbtn" id="bExport" title="마크다운(.md)으로 저장">저장</button>
          <button class="tbtn" id="bMinus" title="글자 작게">가−</button>
          <button class="tbtn" id="bPlus" title="글자 크게">가＋</button>` : ''}
        <button class="tbtn${mode === 'summary' ? ' on' : ''}" id="bSum" title="이 문서 AI 요약">요약</button>
        <button class="tbtn${mode === 'review' ? ' on' : ''}" id="bRev" title="결재 전 AI 검토">검토</button>
        <button class="tbtn" id="bRefresh" title="다시 실행 (캐시 무시하고 새로 분석)">↻</button>
        <button class="tbtn" id="bClose" title="닫기">✕</button>
      </div>
      ${state.status || state.error ? body : `<div class="bodywrap">${body}</div>`}
    </div>`;
  if (prevScroll) root.querySelector('.panel').scrollTop = prevScroll;

  // 타이핑 상태 저장 + 마지막으로 자란 요소 끝에 커서 부착
  host.__txt = nextTxt;
  if (partial && caretKey) {
    const typingEl = root.querySelector(`[data-k="${caretKey}"]`);
    if (typingEl) {
      const cur = document.createElement('span');
      cur.className = 'caret';
      (typingEl.querySelector('.kt') || typingEl).appendChild(cur);
    }
  }

  const $ = (id) => root.getElementById(id);
  $('bClose').addEventListener('click', () => host.remove());
  $('bSum').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'edoc-summarize' }));
  $('bRev').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'edoc-review' }));
  $('bRefresh').addEventListener('click', () =>
    chrome.runtime.sendMessage({ type: mode === 'review' ? 'edoc-review' : 'edoc-summarize', force: true }));
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
