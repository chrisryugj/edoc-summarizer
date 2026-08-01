// 요약 오케스트레이션: 컨텍스트 메뉴/플로팅 버튼 → 추출 → LLM → 오버레이 렌더링.
// 전자문서 팝업창(툴바 없음)에서도 동작해야 하므로 UI는 페이지 위 Shadow DOM 오버레이.
import { summarize, review } from './llm.js';
import { pickSource, sameOriginFrames, clampText, MAX_CHARS } from './pick.js';
import { loadConfig, hostPatterns } from './config.js';
import { buildMarkdown, buildReviewMarkdown, resultFileName } from './md.js';
import { renderOverlay } from './overlay.js';

const MENU_SUM = 'edoc-summarize';
const MENU_REV = 'edoc-review';
const WIDGET_SCRIPT_ID = 'edoc-widget';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
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
  syncWidgetScript();
});
chrome.runtime.onStartup.addListener(syncWidgetScript);
chrome.permissions.onAdded.addListener(syncWidgetScript);
chrome.permissions.onRemoved.addListener(syncWidgetScript);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.widgetHosts) syncWidgetScript();
});

// ✨ 플로팅 버튼은 사용자가 권한을 승인한 호스트에만 주입한다.
// 매니페스트에 전 사이트 content_scripts를 두면 인터넷뱅킹·웹메일을 포함한 모든 탭에
// 확장 코드가 상주하게 되고, <all_urls> 호스트 권한과 묶여 activeTab의 제스처 제한도 무의미해진다.
async function syncWidgetScript() {
  try {
    const { widgetHosts } = await loadConfig();
    // 호스트별로 따로 확인한다 — 한 곳의 권한만 회수돼도 나머지 승인 호스트까지 버튼이
    // 사라지지 않도록 (permissions.contains는 목록 전체 AND).
    const matches = [];
    for (const h of widgetHosts) {
      const pats = hostPatterns([h]);
      if (!pats.length) continue;
      if (await chrome.permissions.contains({ origins: pats }).catch(() => false)) matches.push(...pats);
    }
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [WIDGET_SCRIPT_ID] }).catch(() => []);
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [WIDGET_SCRIPT_ID] });
    if (!matches.length) return;
    await chrome.scripting.registerContentScripts([{
      id: WIDGET_SCRIPT_ID,
      matches,
      js: ['widget.js'],
      runAt: 'document_idle',
    }]);
  } catch (e) {
    console.warn('[edoc] 위젯 스크립트 등록 실패:', e.message);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === MENU_SUM) runSummarize(tab.id, 'summary');
  else if (info.menuItemId === MENU_REV) runSummarize(tab.id, 'review');
});

// 플로팅 위젯 버튼(widget.js)·오버레이의 요약/검토/새로고침 버튼에서 오는 요청.
// sender.id 확인: 다른 확장이 보낸 메시지로 이 확장의 키·권한을 대신 쓰지 못하게 한다.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (!sender.tab?.id) return;
  const force = msg?.force === true;
  if (msg?.type === 'edoc-summarize') runSummarize(sender.tab.id, 'summary', { force });
  else if (msg?.type === 'edoc-review') runSummarize(sender.tab.id, 'review', { force });
});

// 탭이 닫히면 해당 탭의 결과 캐시 정리 + 진행 중 요청 중단
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([`cache_${tabId}_summary`, `cache_${tabId}_review`]);
  inflight.get(tabId)?.controller.abort();
  inflight.delete(tabId);
});

// 탭별 진행 중 요청 — 새 요청이 오면 이전 스트림을 끊는다.
// 없으면 요약↔검토를 연달아 누를 때 두 스트림이 같은 오버레이를 번갈아 덮어쓰고,
// 나중에 끝난 쪽이 최종 화면과 캐시를 차지한다(사용자가 마지막에 누른 것과 다를 수 있음).
const inflight = new Map();

// 오버레이 렌더 세대 — 밀리초가 같아도 순서가 서도록 시퀀스를 하위 자리에 싣는다.
// (2^53 안에서 안전: 1.8e12 * 1000 ≈ 1.8e15)
let genSeq = 0;
const nextGen = () => Date.now() * 1000 + (genSeq++ % 1000);

// 캐시 무결성용 본문 지문 (FNV-1a) — 보안용이 아니라 "같은 문서인가" 판별용
function fingerprint(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + s.length;
}

async function runSummarize(tabId, mode = 'summary', { force = false } = {}) {
  inflight.get(tabId)?.controller.abort();
  const controller = new AbortController();
  inflight.set(tabId, { mode, controller });
  const aborted = () => controller.signal.aborted;

  let config = null;
  const overlay = (state) =>
    chrome.scripting.executeScript({
      target: { tabId },
      func: renderOverlay,
      // gen: 주입 완료 순서가 보장되지 않아 늦게 도착한 옛 부분결과가 최종을 덮는 것을 막는다.
      // 같은 밀리초에 두 번 그릴 때도 순서가 서지도록 시퀀스를 섞는다.
      args: [{ mode, provider: config?.provider, gen: nextGen(), ...state }],
    }).catch((e) => { console.warn('[edoc] 오버레이 주입 실패:', e.message); });

  // MV3 서비스워커는 30초 유휴 시 종료됨 — 로컬 LLM처럼 30초 넘는 요청 중에 워커가 죽으면
  // 연결이 끊긴다(실측: Ollama 요청이 정확히 30.0s에 500). 주기적 API 호출로 수명 연장.
  // llm.js가 fetch에 전체 제한시간을 걸어두므로 이 인터벌은 반드시 finally에서 회수된다.
  const keepalive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  try {
    config = await loadConfig();
    if (config.provider === 'gemini' && !config.apiKey) {
      await overlay({ error: 'Gemini API 키가 없습니다. 확장 관리 → 확장 옵션에서 키를 입력하세요.' });
      return;
    }

    await overlay({ status: '본문 추출 중…' });
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const tabUrl = tab?.url || '';
    let topOrigin = '';
    try { topOrigin = new URL(tabUrl).origin; } catch { /* edge:// 등 */ }

    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['extractor.js'],
    });
    if (aborted()) return;

    // 크로스오리진 프레임 제외 — 공격자 페이지가 임베드한 타 사이트의 인증된 문서를
    // 확장이 대신 읽어 LLM으로 보내고 그 결과를 공격자 페이지에 렌더하는 경로를 막는다.
    const all = results.map((r) => r.result).filter(Boolean);
    const { frames, dropped, droppedOrigins } = sameOriginFrames(all, topOrigin);
    const droppedNote = dropped
      ? `다른 출처의 프레임 ${dropped}개는 보안상 분석에서 제외했습니다`
        + (droppedOrigins.length ? ` (본문이 있던 출처: ${droppedOrigins.join(', ')})` : '') + '.'
      : '';
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
      if (aborted()) return;
      const hits = (pr || [])
        .map((r) => r.result)
        .filter((h) => h && (!topOrigin || h.origin === topOrigin));
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
      const why = droppedNote
        ? ` ${droppedNote}`
        : (probeDebug ? ` [API 후보: ${probeDebug}]` : '');
      await overlay({ error: '본문 추출 실패 — 본문 텍스트를 드래그 선택한 뒤 다시 시도하세요.' + why });
      return;
    }

    const { text, truncated, original } = clampText(source.text);

    // 캐시 검증은 추출 후에 한다. top URL만 비교하면 프레임·SPA 기반 그룹웨어에서
    // 문서를 바꿔도 URL이 그대로라 이전 문서의 요약이 정상 결과처럼 표시된다.
    const cacheKey = `cache_${tabId}_${mode}`;
    const hash = fingerprint(text);
    if (!force) {
      const { [cacheKey]: hit } = await chrome.storage.session.get(cacheKey);
      if (aborted()) return;
      if (hit?.hash === hash && hit.url === tabUrl) {
        await overlay(hit.state);
        return;
      }
    }

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
      overlay(mode === 'review' ? { review: p, partial: true } : { result: p, partial: true });
    };

    const warnings = [];
    if (source.how === '문서카드') {
      warnings.push('공문 본문(HWP)을 읽지 못해 문서카드 정보만 분석했습니다.'
        + ` [디버그: 프레임 ${frames.length}개, 하위 프레임 텍스트 길이 ${frames.filter((f) => !f.isTop).map((f) => f.bodyText?.length || 0).join('/') || '없음'}]`
        + (probeDebug ? ` [API 후보: ${probeDebug}]` : ' [API 후보 없음]'));
    }
    // 조용한 절단은 위험하다 — 뒷부분에 있던 제출기한이 빠진 채 "기한 없음"으로 완결돼 보인다
    if (truncated) {
      warnings.push(`문서가 길어 앞 ${MAX_CHARS.toLocaleString()}자만 분석했습니다 (원문 ${original.toLocaleString()}자). 뒷부분의 기한·조치사항이 빠졌을 수 있습니다.`);
    }
    if (droppedNote) warnings.push(droppedNote);
    const warn = warnings.join(' ');

    let finalState;
    if (mode === 'review') {
      const v = await review(text, config, { onPartial, signal: controller.signal });
      finalState = { review: v, md: buildReviewMarkdown(v), fileName: resultFileName('AI검토', source.title || v.status), warn };
    } else {
      const r = await summarize(text, config, { onPartial, signal: controller.signal });
      finalState = { result: r, md: buildMarkdown(r), fileName: resultFileName('AI요약', r.title || r.doc_type), warn };
    }
    if (aborted()) return;
    await overlay(finalState);
    await chrome.storage.session.set({ [cacheKey]: { url: tabUrl, hash, state: finalState } }).catch(() => {});
  } catch (e) {
    // 사용자가 다른 모드를 눌러 취소된 건 오류가 아니다
    if (e?.cancelled || aborted()) return;
    await overlay({ error: (mode === 'review' ? '검토 실패: ' : '요약 실패: ') + e.message });
  } finally {
    clearInterval(keepalive);
    if (inflight.get(tabId)?.controller === controller) inflight.delete(tabId);
  }
}

// ── MAIN 월드 주입: 한컴 웹한글 뷰어 JS API에서 본문 텍스트 추출 시도 ──
// 웹한글 기안기 공식 API: HwpCtrl.GetTextFile(format, option, callback).
// ⚠ MAIN 월드라 페이지가 정의한 객체를 호출하게 된다. 페이지가 HwpCtrl을 위조해 두면
//   이 함수가 그 코드를 대신 돌리는 셈이므로, 반복 횟수·누적 길이·시간에 상한을 둔다.
// 자기완결 함수 — 외부 참조 금지.
async function probeHwpText() {
  const MAX_TEXT = 30000;
  const MAX_SCAN = 5000;
  const TIME_BUDGET_MS = 3000;
  const result = {
    url: location.href,
    origin: (typeof self !== 'undefined' && self.origin) || location.origin || '',
    globals: [],
    text: '',
  };
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
            const clean = normalize(fmt === 'HTML' ? stripHtml(t) : t).slice(0, MAX_TEXT);
            if (clean.length > 50) { result.text = clean; return result; }
          }
        }
      }
      // GetTextFile이 빈 값을 주는 뷰어 버전 폴백: InitScan 후 GetText를 반복 호출해
      // 문단 단위 청크를 모은다 (배열 반환 시 첫 요소가 상태코드)
      if (typeof v.GetText === 'function') {
        let init = false;
        const chunks = [];
        let total = 0;
        const until = Date.now() + TIME_BUDGET_MS;
        try {
          if (typeof v.InitScan === 'function') { v.InitScan(); init = true; }
          for (let i = 0; i < MAX_SCAN; i++) {
            if (total > MAX_TEXT || Date.now() > until) break;
            const r = v.GetText();
            if (typeof r === 'string') {
              if (!r) break;
              chunks.push(r);
              total += r.length;
              continue;
            }
            if (Array.isArray(r)) {
              const t = r.filter((x) => typeof x === 'string').join('');
              if (t) { chunks.push(t); total += t.length; }
              const state = Number(r[0]);
              if (!t || state === 0 || state === 1 || state === 101 || state === 201) break;
              continue;
            }
            break;
          }
        } catch { /* 미지원 뷰어 */ } finally {
          if (init) { try { v.ReleaseScan(); } catch { /* ignore */ } }
        }
        const scanned = normalize(chunks.join('')).slice(0, MAX_TEXT);
        if (scanned.length > 50) { result.text = scanned; return result; }
      }
      for (const call of ['getText', 'getBodyText', 'getDocumentText']) {
        try {
          if (typeof v[call] === 'function') {
            const t = await settle(v[call]());
            if (typeof t === 'string' && t.trim().length > 50) { result.text = t.trim().slice(0, MAX_TEXT); return result; }
          }
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    result.globals.push('ERR:' + e.message);
  }
  return result;
}
