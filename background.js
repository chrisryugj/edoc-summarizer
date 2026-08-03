// 요약 오케스트레이션: 컨텍스트 메뉴/플로팅 버튼 → 추출 → LLM → 오버레이 렌더링.
// 전자문서 팝업창(툴바 없음)에서도 동작해야 하므로 UI는 페이지 위 Shadow DOM 오버레이.
import { summarize, review } from './llm.js';
import { pickSource, sameOriginFrames, clampText, MAX_CHARS, MIN_CHARS } from './pick.js';
import { loadConfig, hostPatterns, normalizeHost } from './config.js';
import { buildMarkdown, buildReviewMarkdown, resultFileName } from './md.js';
import { renderOverlay } from './overlay.js';

const MENU_SUM = 'edoc-summarize';
const MENU_REV = 'edoc-review';
const WIDGET_SCRIPT_ID = 'edoc-widget';
const RECORDER_SCRIPT_ID = 'edoc-recorder';

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
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [WIDGET_SCRIPT_ID, RECORDER_SCRIPT_ID] }).catch(() => []);
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    if (!matches.length) return;
    await chrome.scripting.registerContentScripts([{
      id: WIDGET_SCRIPT_ID,
      matches,
      js: ['widget.js'],
      runAt: 'document_idle',
    }, {
      // 뷰어·미리보기의 실제 데이터 경로(URL 패턴)를 학습하기 위한 기록기 —
      // 첨부 직다운로드는 DRM 래핑/페이지 응답을 주지만 미리보기 경로는 원본을 준다 (실측 방침)
      id: RECORDER_SCRIPT_ID,
      matches,
      js: ['recorder.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
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
  else if (msg?.type === 'edoc-attach-choice') {
    // 오버레이의 "첨부까지 분석 / 본문만" 선택 — 대기 중인 실행에 전달
    attachChoice.get(sender.tab.id)?.(msg.include === true);
  }
});

// 탭별 첨부 포함 여부 응답 대기 (오버레이 버튼 → onMessage → 여기서 resolve)
const attachChoice = new Map();
function askAttachChoice(tabId) {
  return new Promise((resolve) => {
    const done = (v) => {
      if (attachChoice.get(tabId) === done) attachChoice.delete(tabId);
      resolve(v);
    };
    attachChoice.set(tabId, done);
    setTimeout(() => done(false), 120000); // 응답이 없으면 본문만
  });
}

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

// ── kordoc 헬퍼 (로컬 변환 서버, scripts/kordoc-helper.mjs) ──
// 떠 있으면 첨부 변환을 kordoc CLI에 위임(표→마크다운, pdf·구형 hwp까지)하고
// 검토 모드에 공문 표기법 lint를 얹는다. 없으면 내장 파서만으로 동작 (설정 불요, 자동 감지).
const KORDOC_URL = 'http://127.0.0.1:8531';
async function kordocHealth() {
  try {
    const res = await fetch(`${KORDOC_URL}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok && (await res.json()).ok === true;
  } catch { return false; }
}

// kordoc lint — 날짜·시간·금액·붙임 표기 등 행정업무운영 편람 규칙 기반의 결정적 검수.
// LLM 오탈자와 달리 룰 기반이라 허위 지적이 없다. 실패는 조용히 빈 배열 (부가 기능).
async function kordocLint(bodyText) {
  const res = await fetch(`${KORDOC_URL}/lint`, {
    method: 'POST',
    body: bodyText,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return [];
  const j = await res.json();
  return (j.findings || []).slice(0, 8).map((f) => ({
    before: String(f.match || '').trim(),
    after: String(f.suggest || '').replace(/^예\)\s*/, '예: ').trim(),
    reason: `표기법 · ${String(f.message || f.rule || '').trim()}`,
  })).filter((t) => t.before && t.after);
}

// 페이지가 불러온 외부 스크립트를 뒤져 첨부 미리보기 트리거 함수를 찾는다.
// 합성 우클릭으로 컨텍스트 메뉴가 뜨지 않는 시스템에서, 그 함수를 직접 호출하기 위한 발굴 단계.
// (읽기만 한다 — 여기서 호출하지 않는다)
async function findPreviewFn(tabId, origin) {
  const sr = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => [...document.querySelectorAll('script[src]')].map((s) => s.src),
  }).catch(() => []);
  const urls = [...new Set((sr || []).flatMap((r) => r.result || []))]
    .filter((u) => { try { return new URL(u).origin === origin; } catch { return false; } })
    .slice(0, 25);

  const hits = [];
  const bodies = [];
  for (const u of urls) {
    let src = '';
    try {
      const res = await fetch(u, { credentials: 'include', signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      src = await res.text();
    } catch { continue; }
    if (!/미리\s*보기|preview|openurl/i.test(src)) continue;
    const file = u.split('/').pop().slice(0, 40);
    // 함수 정의 (function f(...) / var f = function(...) / f: function(...))
    for (const m of src.matchAll(/(?:function\s+([\w$]+)|(?:var|let|const)\s+([\w$]+)\s*=\s*function|([\w$]+)\s*:\s*function)\s*\(([^)]{0,120})\)/g)) {
      const name = m[1] || m[2] || m[3];
      if (!name || !/prev|view|atch|attach|file/i.test(name)) continue;
      const body = src.slice(m.index, m.index + 700);
      if (!/미리\s*보기|preview|openurl|atchFile|WORK_TEMP/i.test(body)) continue;
      hits.push(`${name}(${m[4].trim().slice(0, 60)}) @${file}`);
    }
    // '미리보기' 문자열이 등장하는 줄의 함수 호출 흔적도 남긴다
    for (const m of src.matchAll(/.{0,80}미리\s*보기.{0,80}/g)) {
      hits.push(`«${m[0].replace(/\s+/g, ' ').trim()}» @${file}`);
    }
    // 첨부 목록·미리보기 관련 함수는 본문째로 남긴다 — URL 조립 방식을 알아야 재현할 수 있다
    for (const m of src.matchAll(/(?:function\s+(printFileArray|assignFileObj|setAttachFile|[\w$]*[Pp]review[\w$]*)|(?:var|let|const)\s+([\w$]*[Pp]review[\w$]*)\s*=\s*function)\s*\([^)]{0,120}\)/g)) {
      const name = m[1] || m[2];
      bodies.push(`── ${name} @${file} ──\n` + src.slice(m.index, m.index + 1200).replace(/\n{2,}/g, '\n'));
    }
    // 첨부 URL을 만드는 지점 (…?atchFileId= 같은 조립 코드)
    for (const m of src.matchAll(/.{0,100}(?:atchFile|fileSn|fileId|WORK_TEMP|openurl|previewFile|downloadFile)[^\n]{0,120}/gi)) {
      hits.push(`»${m[0].replace(/\s+/g, ' ').trim()}« @${file}`);
    }
  }
  if (bodies.length) console.log('[edoc] 첨부 관련 함수 본문:\n' + bodies.slice(0, 6).join('\n\n'));
  return [...new Set(hits)].slice(0, 40);
}

// 페이지가 들고 있는 첨부 메타데이터 배열을 찾는다.
// 실측: 외부 스크립트에 printFileArray(arr)·assignFileObj(arr, fileobj)가 있다 —
// 첨부 목록이 JS 객체 배열로 존재하며, 여기에 실제 파일명과 파일 ID(다운로드·미리보기 재료)가 있다.
// 자기완결 함수 — 외부 참조 금지.
function probeFileArrays() {
  const out = [];
  const FILEKEY = /file|atch|attach|doc|path|url|size|name|sn$|id$/i;
  const scan = (win, where) => {
    let keys = [];
    try { keys = Object.getOwnPropertyNames(win); } catch { return; }
    for (const k of keys.slice(0, 600)) {
      let v;
      try { v = win[k]; } catch { continue; }
      if (!Array.isArray(v) || !v.length || v.length > 50) continue;
      const first = v.find((x) => x && typeof x === 'object');
      if (!first) continue;
      let props = [];
      try { props = Object.keys(first); } catch { continue; }
      if (props.length < 2 || !props.some((p) => FILEKEY.test(p))) continue;
      const sample = {};
      for (const p of props.slice(0, 14)) {
        try {
          const val = first[p];
          sample[p] = typeof val === 'object' ? '(object)' : String(val).slice(0, 90);
        } catch { sample[p] = '(err)'; }
      }
      out.push({ where, name: k, len: v.length, sample });
    }
  };
  scan(window, 'top');
  for (const f of document.querySelectorAll('iframe')) {
    try { if (f.contentWindow) scan(f.contentWindow, f.src?.slice(-40) || 'iframe'); } catch { /* cross-origin */ }
  }
  return out.slice(0, 8);
}

// 첨부 미리보기 폼(실측: POST /html/docsView.jsp)을 같은 필드로 다시 호출해
// 응답 HTML에서 서버 스테이징 경로(/WORK_TEMP/…)만 뽑아낸다 — 미리보기 창을 띄우지 않는 길.
async function stagedPathFromForm(netlog) {
  const form = [...netlog].reverse().find((e) => e.kind?.startsWith('form') && e.body && /docsview|preview|atch/i.test(e.url));
  if (!form) return { path: '', note: '폼 기록 없음' };
  try {
    const res = await fetch(form.url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: form.body,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { path: '', note: `폼 재현 HTTP ${res.status}` };
    const html = await res.text();
    const m = html.match(/\/WORK_TEMP\/[^\s"'<>()\\]+?\.(?:hwpx?|pdf|docx?|xlsx?|pptx?|txt)/i);
    return m ? { path: m[0], note: '' } : { path: '', note: '응답에 경로 없음' };
  } catch (e) {
    return { path: '', note: '폼 재현 실패: ' + String(e.message || e).slice(0, 60) };
  }
}

// 미리보기 트리거 이후 새로 열린 탭(팝업) — 그 창의 뷰어가 첨부를 열므로 경로가 거기 있다
async function newTabsSince(before) {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  return tabs.filter((t) => !before.has(t.id));
}

// recorder.js가 MAIN 월드에 모아둔 페이지 네트워크 기록 수집
async function pageNetLog(tabId) {
  const nl = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: () => (globalThis.__edocNetLog || []).slice(-80),
  }).catch(() => []);
  return (nl || []).flatMap((r) => r.result || []);
}

// 뷰어가 연 본문 문서의 서버 스테이징 경로 — openurl POST 바디의 url 파라미터
// (예: url=%2FWORK_TEMP%2Fsto%2F…%2Fuuid.hwpx&format=&args=…)
function netlogMainPath(netlog) {
  for (const e of netlog) {
    if (!e.body || !/openurl/i.test(e.url)) continue;
    const m = /(?:^|&)url=([^&]+)/.exec(e.body);
    if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  }
  return '';
}

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

    // DOM에서 공문 본문을 충분히 못 얻은 경우(캔버스 렌더링 웹한글): MAIN 월드에서 뷰어 JS API 프로브.
    // '문서카드'만 조건으로 걸면 사이트 룰이 없는 화면(다른 열람 뷰)에서 '페이지 전체' 자투리
    // 몇백 자로 끝나 프로브가 아예 안 돈다 — 실측(입력 209자 빈 요약). 본문이 빈약하면 무조건 돈다.
    let probeDebug = '';
    if (!source || (source.how !== '선택 영역' && source.text.length < 1500)) {
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
          how: source ? `${source.how === '문서카드' ? '카드' : source.how}+본문(API)` : '본문(API)',
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

    // ── 첨부파일 분석: 전자문서 화면에서만 시도 ──
    // 임의 페이지의 파일 링크를 긁어 세션 쿠키로 다운로드하는 일이 없도록 게이트를 건다.
    // 게이트 = 문서카드 룰 매칭 또는 사용자가 승인한 전자문서 호스트(위젯 호스트) —
    // 룰이 없는 열람 화면(#DIV_ENF_DOC 부재)에서도 첨부는 잡혀야 한다 (실측).
    let tabHost = '';
    try { tabHost = new URL(tabUrl).hostname; } catch { /* edge:// 등 */ }
    const onDocSite = config.widgetHosts.some((h) => {
      const n = normalizeHost(h);
      return n && (tabHost === n || tabHost.endsWith('.' + n));
    });
    let attach = { items: [], debug: '' };
    let useKordoc = null; // null = 아직 미확인 (lint 단계에서 필요 시 재확인)
    let viewerNote = '';  // 뷰어 경로 시도 결과 — 패널 메타줄에 노출
    if (onDocSite || frames.some((f) => f.ruleText?.length >= MIN_CHARS)) {
      // ① 목록만 먼저 훑어 사용자에게 묻는다 — 첨부 분석은 미리보기 조작이라 시간이 걸린다.
      //    첨부가 없으면 묻지 않고 그대로 진행한다.
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => { globalThis.__edocScanOnly = true; },
      }).catch(() => {});
      const sc = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['attachments.js'],
      }).catch(() => []);
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => { globalThis.__edocScanOnly = false; },
      }).catch(() => {});
      if (aborted()) return;
      const names = [...new Set((sc || []).map((r) => r.result)
        .filter((v) => v && (!topOrigin || v.origin === topOrigin))
        .flatMap((v) => (v.items || []).map((i) => i.name)))];

      if (!names.length) {
        // 첨부 없음 — 바로 본문 요약으로
        attach.items = [];
      } else if (!(await (async () => { await overlay({ ask: names }); return askAttachChoice(tabId); })())) {
        if (aborted()) return;
        attach.items = [];
        attach.skipped = names.length;
      } else {
        if (aborted()) return;
        await runAttachments();
      }
    }

    // 첨부 본체 분석 — 사용자가 '첨부까지 분석'을 고른 경우에만 실행된다
    async function runAttachments() {
      await overlay({ status: '첨부파일 분석 중…' });
      useKordoc = await kordocHealth();
      if (useKordoc) {
        // attachments.js가 원본 바이트를 함께 돌려주도록 주입 전에 플래그를 세운다
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => { globalThis.__edocKordoc = true; },
        }).catch(() => {});
      }
      const ar = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['attachments.js'],
      }).catch((e) => { console.warn('[edoc] 첨부 분석 실패:', e.message); return []; });
      if (aborted()) return;
      const frs = (ar || []).map((r) => r.result).filter((h) => h && (!topOrigin || h.origin === topOrigin));
      // 프레임 간 같은 파일명 중복 제거 — 내용을 얻은 쪽 우선
      const byName = new Map();
      for (const fr of frs) {
        for (const it of fr.items || []) {
          const prev = byName.get(it.name);
          if (!prev || (it.status === 'ok' && prev.status !== 'ok')) byName.set(it.name, it);
        }
      }
      attach.items = [...byName.values()];
      attach.debug = frs.map((f) => f.debug).filter(Boolean).join(' | ').slice(0, 600);

      // 직다운로드가 실패한 첨부는 뷰어 경로로 재시도 — 서버 스테이징 원본(DRM 미적용)을
      // 뷰어에 열어 텍스트를 읽는다. 다운로드가 아예 막힌 환경에서 유일하게 통하는 길.
      // 뷰어 경로는 hwpx/hwp만 — 웹한글 뷰어는 한글 문서를 렌더하는 물건이라
      // xlsx·pdf를 열면 내용이 깨진 채로 나온다(실측). 나머지는 파일명만 반영한다.
      const viewerTargets = attach.items.filter((i) => i.status !== 'ok' && /\.hwpx?$/i.test(i.name));
      for (const i of attach.items) {
        if (i.status !== 'ok' && !/\.hwpx?$/i.test(i.name)) i.note = '내용 분석은 hwpx만 지원';
      }
      if (viewerTargets.length) {
        await overlay({ status: '첨부파일 분석 중… (뷰어 경로)' });
        const before = await pageNetLog(tabId);
        const mainPath = netlogMainPath(before);

        // ⓪ 디버거 없는 길: 첨부 경로가 이미 페이지에 박혀 있으면 조작 없이 바로 연다.
        const sp = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: probeStagedPaths,
          args: [viewerTargets.map((i) => i.name)],
        }).catch(() => []);
        const spRes = (sp || []).map((r) => r.result).filter(Boolean);
        const inPage = [...new Map(spRes.flatMap((x) => x.paths || [])
          .filter((x) => x.path !== mainPath && /\.hwpx?$/i.test(x.path))
          .map((x) => [x.path, x])).values()];

        // 경로가 통째로 없으면 토큰으로 조립한다 — 첨부 스테이징 파일은 본문과 같은 디렉터리에 있고
        // 파일명만 다르다(실측: 본문 27aec570-…-…hwpx / 첨부 D36DBD1E…32자리 hex.hwpx)
        if (!inPage.length && mainPath) {
          const dir = mainPath.slice(0, mainPath.lastIndexOf('/') + 1);
          const mainFile = mainPath.slice(dir.length).replace(/\.[^.]+$/, '');
          const toks = [...new Map(spRes.flatMap((x) => x.tokens || []).map((t) => [t.token, t])).values()]
            .filter((t) => t.token !== mainFile);
          if (toks.length) {
            console.log('[edoc] 첨부 토큰 후보:\n' + JSON.stringify(toks, null, 1));
            inPage.push(...toks.map((t) => ({ path: `${dir}${t.token}.hwpx`, filename: t.filename, guessed: true })));
          }
        }
        // 잘린 표시명 대신 URL의 filename을 진짜 이름으로 채택 (예: "31.字).hwpx" → 원래 파일명)
        for (const x of inPage) {
          if (!x.filename) continue;
          const t = viewerTargets.find((i) => x.filename.endsWith(i.name) || i.name.endsWith(x.filename));
          if (t) t.name = x.filename;
        }
        // 뷰어가 연 문서 경로 전부를 모은다. 첫 번째는 본문이고, 그 외에는 첨부다 —
        // 사용자가 미리보기를 한 번 열어둔 상태면 여기서 바로 잡힌다(트리거 없이도 동작).
        const openedPaths = (log) => [...new Set(log
          .filter((e) => e.body && /openurl/i.test(e.url))
          .map((e) => { const m = /(?:^|&)url=([^&]+)/.exec(e.body); try { return m ? decodeURIComponent(m[1]) : ''; } catch { return m?.[1] || ''; } })
          .filter((p) => p && p !== mainPath))];

        const pendingNames = viewerTargets.map((i) => i.name);
        const canDebug = config.autoPreview === true;
        let trig = {};
        let staged = [];

        if (inPage.length) {
          // 경로가 페이지에 있으니 조작이 전혀 필요 없다 — 디버거도 팝업도 없는 기본 경로
          staged = inPage.map((x) => x.path);
          trig = { direct: inPage.length };
          console.log('[edoc] 첨부 경로(페이지에서 직접 확보):\n' + JSON.stringify(inPage, null, 1));
        } else {
          await runPreviewTrigger();
        }

        // 페이지에 경로가 없을 때만 미리보기를 조작해 스테이징을 유발한다
        async function runPreviewTrigger() {
        // 첨부 요소·폼 구조 덤프 — 디버거 없이 미리보기 요청을 직접 만들기 위한 재료
        const mk = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: probeAttachMarkup,
          args: [pendingNames],
        }).catch(() => []);
        const markup = (mk || []).map((r) => r.result).filter((m) => m && (m.els?.length || m.forms?.length));
        if (markup.length) console.log('[edoc] 첨부 요소·폼 구조:\n' + JSON.stringify(markup, null, 1));
        // 미리보기가 새 창으로 열릴 때 그 창을 식별하려고 사전 목록을 찍어둔다
        const tabsBefore = new Set((await chrome.tabs.query({}).catch(() => [])).map((t) => t.id));
        // 디버거 조작은 '디버깅 중' 배너를 띄우므로 사용자가 옵션에서 켠 경우에만 쓴다
        // (debugger는 optional_permissions로 선언할 수 없어 매니페스트 필수 권한 + 설정값으로 제어)
        if (canDebug) {
          // 미리보기 폼 전송을 억제한 채로 트리거한다 — 필드만 기록하고 창은 뜨지 않게 하고,
          // 그 요청은 아래에서 확장이 직접 재현한다 (팝업 없는 경로)
          const setSuppress = (on) => chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: 'MAIN',
            func: (v) => { globalThis.__edocSuppressPreview = v; },
            args: [on],
          }).catch(() => {});
          await setSuppress(true);
          try {
            trig = await trustedPreview(tabId, pendingNames);
          } finally {
            await setSuppress(false);
          }
          trig.fired = trig.target ? [trig.target] : [];
        } else {
          const tg = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: fireContextMenu,
            args: [pendingNames],
          }).catch((e) => { console.warn('[edoc] 미리보기 트리거 실패:', e.message); return []; });
          const tgs = (tg || []).map((r) => r.result).filter(Boolean);
          trig = tgs.find((t) => t.fired?.length) || tgs[0] || {};
          trig.cands = [...new Set(tgs.flatMap((t) => t.cands || []))].slice(0, 10);
          await new Promise((r) => setTimeout(r, 700));
          const mn = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: clickPreviewItem,
          }).catch(() => []);
          trig.menu = (mn || []).map((r) => r.result).find((m) => m?.menu)?.menu || '';
        }

        // 메뉴가 안 뜨는 시스템 — 외부 스크립트에서 미리보기 함수를 찾아 단서를 남긴다
        if (!trig.menu && topOrigin) {
          const ext = await findPreviewFn(tabId, topOrigin).catch(() => []);
          if (ext.length) {
            trig.cands = [...new Set([...(trig.cands || []), ...ext])];
            console.log('[edoc] 미리보기 함수 후보(외부 스크립트):\n' + ext.join('\n'));
          }
          // 페이지가 들고 있는 첨부 메타 배열 — 실제 파일명·파일ID가 여기 있다
          const fa = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            world: 'MAIN',
            func: probeFileArrays,
          }).catch(() => []);
          const arrays = (fa || []).flatMap((r) => r.result || []);
          if (arrays.length) {
            console.log('[edoc] 첨부 메타 배열 후보:\n' + JSON.stringify(arrays, null, 1));
            trig.arrays = arrays.map((a) => `${a.name}[${a.len}]{${Object.keys(a.sample).slice(0, 6).join(',')}}`);
          }
        }

        // 첨부 경로가 잡힐 때까지 짧게 폴링 (이미 열려 있던 것 포함).
        // 간편 미리보기는 대개 새 창(팝업 탭)에서 열린다 — 그 탭의 기록도 함께 본다.
        // 팝업이 뜨자마자 폼 요청을 우리가 재현해 경로만 받아온다 — 뷰어 렌더를 기다릴 필요가 없다.
        // (첨부 미리보기는 폼 POST → docsView.jsp → 새 창 구조. 응답 HTML에 스테이징 경로가 들어 있다)
        staged = openedPaths(before);
        let popups = [];
        // 미리보기 폼이 기록되면(전송은 억제됨) 그 요청을 확장이 재현해 경로를 받는다 — 창이 뜨지 않는 길.
        // 억제가 통하지 않아 창이 떠버린 경우를 대비해 팝업 쪽도 함께 살피고, 잡히는 즉시 닫는다.
        for (let i = 0; i < 60 && !staged.length; i++) {
          await new Promise((r) => setTimeout(r, 150));
          if (aborted()) return;
          const log = await pageNetLog(tabId);
          staged = openedPaths(log);
          if (!staged.length) {
            const viaForm = await stagedPathFromForm(log);
            if (viaForm.path) staged = [viaForm.path];
            else if (viaForm.note !== '폼 기록 없음') trig.formNote = viaForm.note;
          }
          popups = await newTabsSince(tabsBefore);
          if (!staged.length && popups.length) {
            for (const t of popups) staged.push(...openedPaths(await pageNetLog(t.id)));
            staged = [...new Set(staged)];
          }
          if (staged.length && popups.length) {
            await chrome.tabs.remove(popups.map((t) => t.id)).catch(() => {});
            trig.popup = popups.length;
            popups = [];
            break;
          }
        }
        // 실패했더라도 우리가 띄운 창은 반드시 정리한다
        popups = await newTabsSince(tabsBefore);
        if (popups.length) {
          await chrome.tabs.remove(popups.map((t) => t.id)).catch(() => {});
          trig.popup = (trig.popup || 0) + popups.length;
        }
        } // ── runPreviewTrigger 끝 ──

        if (!staged.length) { viewerNote = `뷰어실패(경로 확보 실패${trig.formNote ? `:${trig.formNote}` : ''})`; }

        const vr = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: 'MAIN',
          func: probeAttachViaViewer,
          args: [mainPath, staged],
        }).catch((e) => { console.warn('[edoc] 뷰어 첨부 추출 실패:', e.message); return []; });
        if (aborted()) return;
        const results = (vr || []).map((r) => r.result).filter(Boolean);
        const hit = results.find((v) => v?.texts?.some((t) => t.chars > 50));
        console.log('[edoc] 뷰어 첨부 추출:', JSON.stringify({ trig, staged, results: results.map(({ texts, ...rest }) => ({ ...rest, texts: texts?.map((t) => ({ path: t.path, chars: t.chars })) })) }, null, 1));
        // 뷰어 API 목록 — 첨부(붙임) 열람 메서드가 있는지 확인하는 핵심 단서
        const api = results.find((v) => v.api?.length)?.api || [];
        if (api.length) console.log(`[edoc] 뷰어 API (${api.length}개):\n` + api.join(', '));

        if (hit) {
          const got = hit.texts.filter((t) => t.chars > 50);
          const pending = attach.items.filter((i) => i.status !== 'ok');
          got.forEach((t, n) => {
            const target = pending[n];
            const item = target || { name: `첨부 ${n + 1}` };
            item.status = 'ok';
            item.text = t.text;
            item.note = '뷰어 경로';
            delete item.b64;
            if (!target) attach.items.push(item);
          });
        }
        // 패널에서 바로 보이는 진단 — 콘솔을 열지 않아도 어디서 막혔는지 알 수 있게
        const best = results[0] || {};
        viewerNote = hit
          ? `뷰어OK${trig.direct ? '(직접)' : canDebug ? '(자동)' : ''}`
          : trig.direct
            ? `뷰어실패(경로 ${staged.length}건 확보했으나 읽기 실패${best.debug?.[0] ? `:${best.debug[0]}` : ''})`
            : `뷰어실패(${canDebug ? '자동' : '수동'} 트리거 ${trig.fired?.length || 0}건${trig.menu ? `/메뉴 "${trig.menu}"` : '/메뉴 없음'}`
            + `${trig.debug?.length ? `:${trig.debug[0]}` : ''}`
            + ` · 신규경로 ${staged.length}${trig.popup ? `/팝업 ${trig.popup}` : ''}${trig.formNote ? `/${trig.formNote}` : ''} · 경로 ${best.paths?.length || 0} · 열기 ${best.method || '없음'}`
            + ` · API ${api.length}개${api.filter((n) => /atch|attach|붙임|obj|object|link/i.test(n)).slice(0, 4).join(',') || ''}`
            + `${trig.arrays?.length ? ` · 배열 ${trig.arrays.slice(0, 2).join(' ')}` : ''})`;
      }

      // kordoc 변환 위임 — 내장 파서보다 품질이 좋고(표 구조 보존) pdf·구형 hwp도 처리.
      // 실패하면 내장 파서 결과(있다면)를 그대로 쓴다.
      if (useKordoc && attach.items.some((i) => i.b64)) {
        await overlay({ status: '첨부파일 변환 중… (kordoc)' });
        for (const it of attach.items) {
          if (!it.b64) continue;
          if (aborted()) return;
          try {
            const bin = Uint8Array.from(atob(it.b64), (c) => c.charCodeAt(0));
            const res = await fetch(`${KORDOC_URL}/extract?name=${encodeURIComponent(it.name)}`, {
              method: 'POST',
              body: bin,
              signal: AbortSignal.timeout(60000),
            });
            const j = await res.json().catch(() => null);
            if (res.ok && j?.text?.trim()) {
              it.status = 'ok';
              it.text = j.text.trim();
              it.note = 'kordoc 변환';
            }
          } catch (e) { console.warn('[edoc] kordoc 변환 실패:', it.name, e.message); }
          delete it.b64;
        }
      } else {
        attach.items.forEach((it) => { delete it.b64; });
      }
    }

    // 첨부 텍스트는 본문 상한과 별도 예산으로 이어붙인다 (본문이 길어도 첨부가 통째로 밀리지 않게).
    // ⚠ 로컬 소형 모델은 컨텍스트(Ollama 기본 4096토큰)가 작다. 입력이 넘치면 Ollama가 프롬프트
    // 앞부분부터 조용히 잘라 시스템 지시·본문이 날아가고, 제목만 있고 핵심 내용이 빈 요약이
    // 나온다(실측). 로컬은 첨부 예산을 작게 잡고, 셋업 스크립트가 OLLAMA_CONTEXT_LENGTH를 올린다.
    const ATTACH_MAX = config.provider === 'gemini' ? 12000 : 4000;
    const okAttach = attach.items.filter((i) => i.status === 'ok' && i.text);
    const badAttach = attach.items.filter((i) => i.status !== 'ok');
    // 파일별 균등 배분 — 첫 파일이 예산을 독식해 뒤 첨부가 통째로 빠지지 않게
    const share = okAttach.length ? Math.floor(ATTACH_MAX / okAttach.length) : 0;
    let attachText = '';
    for (const it of okAttach) {
      const t = it.text.slice(0, share);
      it.used = t.length;
      attachText += `\n\n[첨부파일: ${it.name}]\n${t}`;
    }
    // 내용을 못 읽은 첨부도 파일명은 문맥에 준다 (BACKEND.md 원칙: 실패 파일은 파일명만 반영)
    if (badAttach.length) {
      attachText += '\n\n[첨부파일 목록 — 내용 미추출]\n' + badAttach.map((i) => `- ${i.name}`).join('\n');
    }
    const llmInput = text + attachText;

    // 캐시 검증은 추출 후에 한다. top URL만 비교하면 프레임·SPA 기반 그룹웨어에서
    // 문서를 바꿔도 URL이 그대로라 이전 문서의 요약이 정상 결과처럼 표시된다.
    const cacheKey = `cache_${tabId}_${mode}`;
    const hash = fingerprint(llmInput);
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
    // 본문 섹션 없이 화면 자투리만 잡힌 경우 — 어떤 화면에서 왜 못 읽었는지 단서를 남긴다
    if (!text.includes('[공문 본문]') && (source.how === '문서카드' || text.length < 1500)) {
      warnings.push(`공문 본문(HWP)을 읽지 못해 ${source.how === '문서카드' ? '문서카드 정보' : '화면 텍스트'}만 분석했습니다.`
        + ` [디버그: 프레임 ${frames.length}개, 하위 프레임 텍스트 길이 ${frames.filter((f) => !f.isTop).map((f) => f.bodyText?.length || 0).join('/') || '없음'}]`
        + (probeDebug ? ` [API 후보: ${probeDebug}]` : ' [API 후보 없음]'));
    }
    // 조용한 절단은 위험하다 — 뒷부분에 있던 제출기한이 빠진 채 "기한 없음"으로 완결돼 보인다
    if (truncated) {
      warnings.push(`문서가 길어 앞 ${MAX_CHARS.toLocaleString()}자만 분석했습니다 (원문 ${original.toLocaleString()}자). 뒷부분의 기한·조치사항이 빠졌을 수 있습니다.`);
    }
    if (droppedNote) warnings.push(droppedNote);
    if (badAttach.length) {
      warnings.push(`첨부 ${badAttach.length}건은 내용을 읽지 못해 파일명만 반영했습니다`
        + ` (${badAttach.map((i) => i.name + (i.note ? `: ${i.note}` : '')).join(', ')}).`
        // 링크를 못 찾은 케이스는 실기기에서 셀렉터를 보정할 수 있게 발견 단서를 남긴다
        + (badAttach.some((i) => i.status === 'no-link') && attach.debug ? ` [디버그: ${attach.debug}]` : ''));
    }
    const warn = warnings.join(' ');
    const info = okAttach.length
      ? `📎 첨부 ${okAttach.length}건 내용 분석 포함: ${okAttach.map((i) => {
          const note = [i.note, i.used < i.text.length ? '앞부분만' : ''].filter(Boolean).join(', ');
          return i.name + (note ? ` (${note})` : '');
        }).join(', ')}`
      : '';

    // 진단 메타 — 무엇이 어떤 경로로 추출돼 들어갔는지 패널 하단에 상시 표시 (빈 요약 원인 추적용).
    // 전체 입력은 서비스워커 콘솔에만 남긴다 (확장 관리 → 서비스 워커 → Console).
    const meta = `추출: ${source.how} · 입력 ${llmInput.length.toLocaleString()}자`
      + (attach.skipped ? ` · 첨부 ${attach.skipped}건 제외(사용자 선택)` : '')
      + (attach.items.length ? ` · 첨부 ${okAttach.length}/${attach.items.length}건` : '')
      + (useKordoc ? ' · kordoc' : '')
      + (viewerNote ? ` · ${viewerNote}` : '');
    // console.log 레벨 — debug는 DevTools 기본 필터(Verbose 꺼짐)에서 안 보인다
    console.log('[edoc] 입력 전문:\n', llmInput);
    if (attach.items.length) {
      // JSON 문자열로 — 객체로 찍으면 콘솔에서 접혀 복사가 번거롭다
      console.log('[edoc] 첨부 상태:\n' + JSON.stringify(attach.items.map(({ text: t, ...rest }) => ({ ...rest, chars: t?.length || 0 })), null, 1));
    }
    // 레코더가 모은 페이지 네트워크 기록 — 사용자가 미리보기를 한 번 열었다면
    // 뷰어가 쓴 데이터 URL이 여기 잡힌다 (첨부 fetch 경로 보정의 핵심 단서)
    if (onDocSite) {
      const netlog = await pageNetLog(tabId);

      // 첨부 미리보기 트리거 후보 — 첨부 링크가 href="#"라 클릭 핸들러가 JS로 달려 있다.
      // 전역 함수 중 이름·본문이 미리보기/첨부와 관련된 것을 찾아 시그니처를 남긴다 (호출은 하지 않음).
      const fns = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: () => {
          const out = [];
          for (const k of Object.getOwnPropertyNames(window).slice(0, 400)) {
            if (!/prev|view|attach|file|down|doc/i.test(k)) continue;
            let v;
            try { v = window[k]; } catch { continue; }
            if (typeof v !== 'function') continue;
            let src = '';
            try { src = Function.prototype.toString.call(v); } catch { continue; }
            if (!/openurl|미리보기|preview|atch|attach|fileSn|atchFile/i.test(src)) continue;
            out.push(`${k}${/\(([^)]*)\)/.exec(src)?.[0] || '()'} … ${src.replace(/\s+/g, ' ').slice(0, 220)}`);
          }
          return out.slice(0, 12);
        },
      }).catch(() => []);
      const fnList = [...new Set((fns || []).flatMap((r) => r.result || []))];
      if (fnList.length) console.log('[edoc] 미리보기 트리거 후보 함수:\n' + fnList.join('\n'));
      if (netlog.length) {
        // 같은 URL 반복은 횟수로 접되, 바디가 있는 요청(뷰어의 문서 열기)은 개별로 남긴다
        const counts = new Map();
        const withBody = [];
        for (const e of netlog) {
          if (e.body) { withBody.push(`${e.method} ${e.url}\n   body: ${e.body}`); continue; }
          const k = `${e.kind} ${e.method} ${e.url}`;
          counts.set(k, (counts.get(k) || 0) + 1);
        }
        console.log('[edoc] 페이지 네트워크 기록 (뷰어·미리보기 추적):\n'
          + [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join('\n')
          + (withBody.length ? '\n── 본문 있는 요청 ──\n' + withBody.join('\n') : ''));
      }
    }

    let finalState;
    if (mode === 'review') {
      // kordoc 표기법 lint를 LLM 검토와 병렬로 — 대상은 공문 본문(카드 메타·첨부 제외)
      const lintP = (async () => {
        if (!(useKordoc ?? await kordocHealth())) return [];
        const bodyPart = /\[공문 본문\]\n?([\s\S]*)$/.exec(text)?.[1] || text;
        return kordocLint(bodyPart);
      })().catch(() => []);
      const v = await review(llmInput, config, { onPartial, signal: controller.signal });
      // 룰 기반 lint가 우선, LLM이 같은 문자열을 또 지적하면 중복 제거
      const lint = await lintP;
      if (lint.length) {
        const seen = new Set(lint.map((t) => t.before));
        v.typos = [...lint, ...(v.typos || []).filter((t) => !seen.has(t.before))];
      }
      finalState = { review: v, md: buildReviewMarkdown(v), fileName: resultFileName('AI검토', source.title || v.status), warn, info, meta };
    } else {
      const r = await summarize(llmInput, config, { onPartial, signal: controller.signal });
      finalState = { result: r, md: buildMarkdown(r), fileName: resultFileName('AI요약', r.title || r.doc_type), warn, info, meta };
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

// ── MAIN 월드 주입: 뷰어를 이용한 첨부 텍스트 추출 ──
// 전자문서 첨부는 브라우저로 내려받을 수 없다 — 직다운로드 링크는 DRM 래핑/안내 페이지를 준다.
// 반면 뷰어는 서버 임시경로(/WORK_TEMP/…)에 스테이징된 원본을 변환서버에 열게 시킨다
// (실측: POST hconvg1/openurl  url=/WORK_TEMP/sto/…/uuid.hwpx&args=lock:FALSE;…).
// 그 경로를 페이지에서 찾아 뷰어에 직접 열고 GetTextFile로 읽은 뒤, 원래 문서로 되돌린다.
// 자기완결 함수 — 외부 참조 금지.
// 첨부 미리보기를 프로그램으로 띄운다 — 첨부는 우클릭(간편 미리보기) 시점에야 서버에
// 스테이징되므로, 그 전에는 페이지에 /WORK_TEMP 경로가 존재하지 않는다.
// 클릭 대상은 파일명을 가진 요소와 '미리보기' 문구 메뉴로 한정한다 (삭제·다운로드는 제외).
// 자기완결 함수 — 외부 참조 금지.
// ── 트러스티드 입력으로 첨부 미리보기 열기 (chrome.debugger) ──
// 합성 이벤트로는 컨텍스트 메뉴가 뜨지 않는다(실측: 트리거는 되지만 메뉴 없음) — 페이지·뷰어가
// isTrusted를 보기 때문. CDP Input.dispatchMouseEvent는 브라우저가 만든 진짜 입력이라 통한다.
// 대가: 동작 중 "디버깅하고 있습니다" 알림 막대. 그래서 사용자가 옵션에서 켠 경우에만 쓴다.
async function trustedPreview(tabId, names) {
  const out = { used: true, target: '', menu: '', debug: [] };
  const target = { tabId };
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  const click = async ({ x, y }, button) => {
    const base = { x, y, button, buttons: button === 'right' ? 2 : 1, clickCount: 1, pointerType: 'mouse' };
    await send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 });
    await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  };
  const locate = async (func, args) => {
    const rs = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args }).catch(() => []);
    return (rs || []).map((r) => r.result).find((v) => v && v.ok) || null;
  };

  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    out.used = false;
    out.debug.push('디버거 연결 실패: ' + e.message);
    return out;
  }
  try {
    const at = await locate(locateByText, [names, true]);
    if (!at) { out.debug.push('첨부 요소 좌표 없음'); return out; }
    out.target = at.label;
    await click(at, 'right');
    await new Promise((r) => setTimeout(r, 900));

    const menu = await locate(locateByText, [['미리보기', '바로보기'], false]);
    if (!menu) { out.debug.push('메뉴 항목 좌표 없음'); return out; }
    out.menu = menu.label;
    await click(menu, 'left');
    await new Promise((r) => setTimeout(r, 1200));
  } catch (e) {
    out.debug.push('입력 주입 실패: ' + e.message);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
  return out;
}

// 텍스트로 요소를 찾아 최상위 뷰포트 기준 좌표를 돌려준다 (CDP 입력은 top 좌표계를 쓴다).
// exact=true면 파일명 포함, false면 메뉴 문구 매칭. 자기완결 함수 — 외부 참조 금지.
function locateByText(needles, isFile) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05;
  };
  const cands = [];
  for (const el of document.querySelectorAll('a, span, td, li, div, label, p, button')) {
    const t = (el.textContent || '').trim();
    if (!t) continue;
    const hit = isFile
      ? needles.some((n) => t.includes(n))
      : needles.some((n) => new RegExp(n.split('').join('\\s*')).test(t)) && t.length <= 20 && !/삭제|다운로드|저장|등록/.test(t);
    if (!hit || !visible(el)) continue;
    cands.push(el);
  }
  // 가장 안쪽(텍스트가 짧은) 요소가 대상 자체
  const el = cands.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
  if (!el) return { ok: false };
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch { /* 무시 */ }
  const r = el.getBoundingClientRect();
  let x = r.left + r.width / 2;
  let y = r.top + r.height / 2;
  // 상위 프레임 오프셋 누적 — CDP 좌표는 최상위 뷰포트 기준이다
  try {
    for (let w = window; w !== w.parent; w = w.parent) {
      const fe = w.frameElement;
      if (!fe) break; // cross-origin이면 여기서 중단 (좌표 보정 불가)
      const fr = fe.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
    }
  } catch { return { ok: false }; }
  return { ok: true, x: Math.round(x), y: Math.round(y), label: (el.textContent || '').trim().slice(0, 30) };
}

// 페이지에서 첨부의 서버 스테이징 경로와 원래 파일명을 찾는다.
// 실측: 미리보기 폼 값에 file_path=/WORK_TEMP/…hwpx & filename=… 가 들어 있고,
// DOM에는 URL 인코딩된 형태(%2FWORK_TEMP%2F…)로 박혀 있다 — 디코딩해서 함께 훑는다.
// 이 값이 잡히면 우클릭·메뉴 조작(디버거) 없이 바로 뷰어로 열 수 있다. 자기완결 함수.
function probeStagedPaths(names) {
  const out = [];
  const tokens = [];
  const docs = [document];
  for (const f of document.querySelectorAll('iframe, frame')) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch { /* cross-origin */ }
  }
  const RE = /(?:%2F|\/)WORK_TEMP(?:%2F|\/)[^\s"'<>()\\]+?\.(?:hwpx?|pdf|docx?|xlsx?|pptx?|txt)/ig;
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const seen = new Set();
  for (const d of docs) {
    let html = '';
    try { html = d.documentElement?.innerHTML || ''; } catch { continue; }
    for (const m of html.match(RE) || []) {
      const path = dec(m).replace(/\\u002F/gi, '/');
      if (seen.has(path)) continue;
      seen.add(path);
      // 같은 URL 안의 filename 파라미터가 원래 파일명 (DOM 표시명은 잘려 있는 경우가 있다)
      let filename = '';
      const tail = html.slice(html.indexOf(m), html.indexOf(m) + 800);
      const fm = /filename(?:=|%3D)([^&"'\s<>]+)/i.exec(tail);
      if (fm) filename = dec(dec(fm[1]));
      out.push({ path, filename });
    }
  }
  // 경로가 통째로 없으면 스테이징 파일명 토큰만 찾는다.
  // 실측: 첨부 스테이징 파일은 32자리 대문자 hex(D36DBD1E…), 디렉터리는 본문과 동일하므로
  // 파일명 주변에서 토큰을 찾아내면 호출부에서 전체 경로를 조립할 수 있다.
  const TOKEN = /\b[0-9A-F]{32}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
  for (const d of docs) {
    let html = '';
    try { html = d.documentElement?.innerHTML || ''; } catch { continue; }
    for (const name of names || []) {
      for (const key of [name, encodeURIComponent(name)]) {
        for (let idx = html.indexOf(key); idx >= 0; idx = html.indexOf(key, idx + 1)) {
          const around = html.slice(Math.max(0, idx - 1500), idx + 1500);
          for (const t of around.match(TOKEN) || []) tokens.push({ token: t, filename: name });
          if (tokens.length > 20) break;
        }
      }
    }
  }
  return { paths: out, tokens: [...new Map(tokens.map((t) => [t.token, t])).values()].slice(0, 8) };
}

// 첨부 요소의 마크업과 주변 폼을 덤프한다 — 파일 ID가 어디에 실려 있는지 알아내면
// 우클릭·메뉴 조작(디버거) 없이 미리보기 요청을 직접 만들 수 있다. 자기완결 함수.
function probeAttachMarkup(names) {
  const out = { els: [], forms: [] };
  const trim = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 400);
  for (const name of names.slice(0, 2)) {
    const els = [...document.querySelectorAll('a, span, td, li, div, label, p')]
      .filter((el) => (el.textContent || '').includes(name));
    const el = els.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    if (!el) continue;
    // 요소 자신 + 조상 3단계의 속성 (파일 ID는 data-*·id·name·rel 등에 실린다)
    const chain = [];
    for (let e = el, i = 0; e && i < 4; e = e.parentElement, i++) {
      const attrs = [...(e.attributes || [])].map((a) => `${a.name}="${trim(a.value).slice(0, 80)}"`).join(' ');
      chain.push(`<${e.tagName.toLowerCase()} ${attrs}>`);
    }
    out.els.push({ name, self: trim(el.outerHTML), chain });
  }
  // 미리보기 대상 폼 — 필드 이름과 현재 값
  for (const f of document.querySelectorAll('form')) {
    if (!/docsview|preview|atch|view/i.test(f.action || '')) continue;
    out.forms.push({
      action: f.action,
      method: f.method,
      fields: [...f.elements].slice(0, 25).map((n) => `${n.name || n.id}=${trim(n.value).slice(0, 60)}`),
    });
  }
  return out;
}

function fireContextMenu(names) {
  const out = { fired: [], cands: [], debug: [] };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  for (const name of names.slice(0, 2)) {
    const els = [...document.querySelectorAll('a, span, td, li, div, label, p')]
      .filter((el) => (el.textContent || '').includes(name) && visible(el));
    // 가장 안쪽(텍스트가 짧은) 요소 = 파일명 자체를 담은 노드
    const el = els.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
    if (!el) { out.debug.push(`요소 못 찾음: ${name}`); continue; }
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
    try {
      // 우클릭 + 좌클릭 둘 다 시도 — 시스템에 따라 클릭만으로 미리보기가 열리기도 한다
      el.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 2, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...at, button: 2 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...at, button: 2 }));
      el.dispatchEvent(new MouseEvent('contextmenu', { ...at, button: 2 }));
      out.fired.push(`${name}<${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(/\s+/)[0] : ''}>`);
    } catch (e) { out.debug.push(`이벤트 실패: ${e.message}`); }
  }
  // 미리보기 트리거 후보 — 인라인 스크립트에서 함수 정의를 찾아 이름을 보고한다(호출은 하지 않음)
  try {
    for (const s of [...document.querySelectorAll('script:not([src])')].slice(0, 60)) {
      const src = s.textContent || '';
      if (!/미리\s*보기|preview|openurl/i.test(src)) continue;
      for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]{0,80})\)/g)) {
        if (/prev|view|atch|attach|file/i.test(m[1])) out.cands.push(`${m[1]}(${m[2].trim()})`);
      }
    }
    out.cands = [...new Set(out.cands)].slice(0, 10);
  } catch { /* 스크립트 접근 실패 */ }
  return out;
}

// 컨텍스트 메뉴는 클릭한 요소와 다른 프레임(최상위 문서)에 그려질 수 있어 별도 호출로 전 프레임을 훑는다
function clickPreviewItem() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const items = [...document.querySelectorAll('a, li, div, span, td, button')].filter((n) => {
    const t = (n.textContent || '').trim();
    return t.length <= 20 && /미리\s*보기|바로\s*보기/.test(t) && !/삭제|다운로드|저장|등록/.test(t) && visible(n);
  });
  const item = items.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
  if (!item) return { menu: '' };
  const c = { bubbles: true, cancelable: true, clientX: 0, clientY: 0 };
  try {
    item.dispatchEvent(new PointerEvent('pointerdown', { ...c, pointerType: 'mouse' }));
    item.dispatchEvent(new MouseEvent('mousedown', c));
    item.dispatchEvent(new MouseEvent('mouseup', c));
    item.click();
  } catch (e) { return { menu: '', err: e.message }; }
  return { menu: (item.textContent || '').trim() };
}

async function probeAttachViaViewer(knownMain, explicitTargets) {
  const OPEN_ARGS = 'lock:FALSE;versionwarning:FALSE;code:acp;';
  const WAIT_MS = 12000;
  const out = { paths: [], picked: '', method: '', texts: [], debug: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ① 페이지(및 같은 출처 프레임)에서 스테이징 경로 수집 — 본문·첨부가 함께 심어져 있다
  const RE = /\/WORK_TEMP\/[^\s"'<>()]+?\.(?:hwpx?|pdf|docx?|xlsx?|pptx?|txt)/gi;
  const docs = [document];
  for (const f of document.querySelectorAll('iframe, frame')) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch { /* cross-origin */ }
  }
  const seen = new Set();
  for (const d of docs) {
    let html = '';
    try { html = d.documentElement?.innerHTML || ''; } catch { continue; }
    for (const m of html.match(RE) || []) {
      const p = m.replace(/\\u002F/gi, '/');
      if (!seen.has(p)) { seen.add(p); out.paths.push(p); }
    }
  }
  // 미리보기 트리거로 알아낸 경로가 있으면 그것을 우선 대상으로 삼는다 (페이지 HTML에는 없다)
  for (const p of explicitTargets || []) if (!seen.has(p)) { seen.add(p); out.paths.push(p); }

  // ② 뷰어 컨트롤 확보 — 호출은 HwpCtrl/WebHwpCtrl 이름으로만 (시스템 래퍼는 에러 모달을 띄운다).
  // ⚠ 경로 유무보다 먼저 본다 — 뷰어가 첨부 열람 API를 직접 제공하면 경로 없이도 길이 있다.
  const ctrls = [];
  const add = (c) => { if (c && (typeof c === 'object' || typeof c === 'function') && !ctrls.includes(c)) ctrls.push(c); };
  for (const k of Object.getOwnPropertyNames(window)) {
    if (/^(hwpctrl|webhwpctrl)$/i.test(k)) { try { add(window[k]); } catch { /* 접근 불가 */ } }
  }
  for (const f of document.querySelectorAll('iframe')) {
    try { add(f.contentWindow?.HwpCtrl); add(f.contentWindow?.WebHwpCtrl); } catch { /* cross-origin */ }
  }
  const ctrl = ctrls[0];
  if (!ctrl) { out.debug.push('HwpCtrl 없음'); return out; }

  // 뷰어가 제공하는 이름 목록만 남긴다.
  // ⚠ 값을 읽으면 안 된다 — 지원하지 않는 속성(실측: HwpDocuments)에 접근하는 순간
  // 뷰어가 "…Property는 지원할 수 없습니다" 경고창을 사용자 화면에 띄운다.
  try {
    out.api = [...new Set([
      ...Object.getOwnPropertyNames(ctrl),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(ctrl) || {}),
    ])].slice(0, 200);
  } catch { out.api = []; }

  // 열기 메서드도 이름 목록에 있는 것만 골라 확인한다 (없는 이름을 읽으면 위와 같은 경고창)
  const openFn = ['OpenURL', 'openURL', 'OpenUrl', 'Open', 'open', 'LoadURL', 'SetUrl', 'OpenDocument', 'SetDocument']
    .find((n) => out.api.includes(n) && (() => { try { return typeof ctrl[n] === 'function'; } catch { return false; } })());
  out.method = openFn || '';
  if (!out.paths.length) { out.debug.push('스테이징 경로 없음'); return out; }
  if (!openFn) { out.debug.push('열기 메서드 없음'); return out; }

  const getText = () => new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(typeof v === 'string' ? v : ''); } };
    try {
      const ret = ctrl.GetTextFile('TEXT', '', (r) => fin(r));
      if (typeof ret === 'string' && ret.trim()) fin(ret);
    } catch { fin(''); }
    setTimeout(() => fin(''), 3000);
  });

  const openAndRead = async (path, baseline) => {
    try { ctrl[openFn](path, '', OPEN_ARGS); } catch (e) { out.debug.push(`open 실패 ${e.message}`); return ''; }
    const until = Date.now() + WAIT_MS;
    while (Date.now() < until) {
      await sleep(700);
      const t = (await getText()).trim();
      // 이전 문서 텍스트가 그대로면 아직 로딩 중
      if (t.length > 50 && t !== baseline) return t;
    }
    return '';
  };

  // ③ 현재(본문) 텍스트를 기준선으로 잡고, 본문 외 경로를 차례로 연다
  const baseline = (await getText()).trim();
  const main = knownMain && out.paths.includes(knownMain) ? knownMain : out.paths[0];
  out.picked = main;
  const targets = (explicitTargets?.length ? explicitTargets : out.paths.filter((p) => p !== main)).slice(0, 3);
  if (!targets.length) { out.debug.push(`첨부 경로 없음 (총 ${out.paths.length}건)`); return out; }

  try {
    for (const p of targets) {
      const t = await openAndRead(p, baseline);
      out.texts.push({ path: p, text: t.slice(0, 12000), chars: t.length });
    }
  } finally {
    // 사용자가 보던 문서로 복원 — 실패하면 화면에 첨부가 남으므로 반드시 시도
    try { ctrl[openFn](main, '', OPEN_ARGS); } catch { out.debug.push('본문 복원 실패'); }
  }
  return out;
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
