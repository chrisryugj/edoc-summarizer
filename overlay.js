// 페이지 주입 오버레이 렌더러.
//
// ⚠ renderOverlay는 chrome.scripting.executeScript({ func })로 직렬화되어 페이지에 주입된다.
//   모듈 스코프의 어떤 값도 참조하면 안 된다 (자기완결 함수).
//
// 섀도루트는 mode:'closed' — open이면 페이지 스크립트가 shadowRoot로 요약 전문을 읽고
// 내부 버튼을 click()으로 눌러 확장 기능을 임의 실행할 수 있다.
// 루트 참조는 격리 월드의 expando에 보관하므로 페이지에서 접근할 수 없다.
//
// KRDS 컬러: Primary #246BEB / Secondary #003675 / Point #E71825 / Gray 스케일.

export function renderOverlay(state) {
  const HOST_ID = '__edoc_ai_summary_host';
  let host = document.getElementById(HOST_ID);
  // 확장을 리로드·업데이트하면 격리 월드가 초기화되어 __root 참조를 잃는다.
  // 섀도루트가 closed라 DOM에서 되찾을 수 없고, 다시 attachShadow하면 NotSupportedError가 난다 —
  // 남은 껍데기를 버리고 새로 만든다 (안 그러면 새로고침 전까지 패널이 조용히 안 뜬다).
  if (host && !host.__root) {
    host.remove();
    host = null;
  }
  const isFirstMount = !host; // 재렌더(스트리밍 갱신) 시 등장 애니메이션 재생 금지 — 깜빡임 원인
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial; position:fixed; top:16px; right:16px; z-index:2147483647;';
    document.documentElement.appendChild(host);
    host.__root = host.attachShadow({ mode: 'closed' });
  }
  // executeScript는 주입 완료 순서를 보장하지 않는다. 세대 번호가 역행하면
  // 늦게 도착한 옛 부분결과가 최종 결과를 덮어써 "AI 생성 중…"이 고착된다.
  const gen = +state.gen || 0;
  if (gen < (host.__gen || 0)) return;
  host.__gen = gen;

  const root = host.__root;
  const fontSize = +(host.dataset.fs || 14);
  const mode = state.mode || 'summary';
  const partial = !!state.partial;
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

  let body = '';
  const hasResult = (!!state.result || !!state.review) && !partial;
  if (state.ask) {
    // 첨부 분석은 미리보기 조작이 필요해 시간이 걸린다 — 실행 전에 사용자가 고른다
    const rows = state.ask.map((a) => {
      const ok = /\.hwpx?$/i.test(a);
      return `<li class="kv"><span class="kl${ok ? '' : ' r'}">${ok ? 'hwpx' : '미지원'}</span><span class="kt">${esc(a)}</span></li>`;
    }).join('');
    body = `
      <div class="card">
        <h2>첨부파일 ${state.ask.length}건</h2>
        <ul>${rows}</ul>
        <div class="askrow">
          <button class="abtn primary" id="bWith">첨부까지 분석</button>
          <button class="abtn" id="bWithout">본문만 요약</button>
        </div>
        <div class="disclaim">첨부 분석은 뷰어 미리보기를 거쳐 몇 초 더 걸립니다. hwpx만 지원합니다.</div>
      </div>`;
  }
  else if (state.status) body = `<div class="status"><span class="spin"></span>${esc(state.status)}</div>`;
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
    // 오탈자: before → after (+이유 태그). 부분 파서가 완성된 객체만 주므로 타이핑 연출 없이 등장 애니메이션만.
    const typoLis = (v.typos || []).map((t, n) => {
      const k = 'ty-' + n;
      nextTxt[k] = '1';
      return `<li class="ty${isNew(k)}" data-k="${k}"><span class="tyb">${esc(t.before)}</span><span class="tya">${esc(t.after)}</span>${t.reason ? `<span class="tyr">${esc(t.reason)}</span>` : ''}</li>`;
    }).join('');
    const typoCard = typoLis
      ? `<div class="card"><h2>오탈자·표기 <span class="cnt">${(v.typos || []).length}</span></h2><ul>${typoLis}</ul></div>`
      : (!partial && Array.isArray(v.typos) ? '<div class="tynone">✓ 오탈자 없음</div>' : '');
    body = `
      <div class="card main">
        <div><span class="pill grade ${grade}${isNew('st')}">${esc(st || '검토 중…')}</span></div>
        ${v.summary ? `<div class="sub${isNew('sum')}" data-k="sum">${reveal('sum', v.summary)}</div>` : ''}
      </div>
      ${sec('act', '잘 작성된 부분', v.strengths, 'st-')}
      ${sec('', '보완이 필요한 부분', v.improvements, 'im-')}
      ${sec('warn', '결재 전 확인사항', v.checks, 'ck-')}
      ${typoCard}
      ${state.info ? `<div class="notice info">${esc(state.info)}</div>` : ''}
      ${state.warn ? `<div class="notice">⚠ ${esc(state.warn)}</div>` : ''}
      ${state.meta ? `<div class="srcmeta">${esc(state.meta)}</div>` : ''}
      <div class="disclaim">AI가 원문만 보고 작성한 참고 자료입니다. 결재 판단의 근거로 삼지 마세요 — 문서 본문에 검토 결과를 조작하려는 문구가 섞여 있을 수 있습니다.</div>`;
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
      ${state.info ? `<div class="notice info">${esc(state.info)}</div>` : ''}
      ${state.warn ? `<div class="notice">⚠ ${esc(state.warn)}</div>` : ''}
      ${state.meta ? `<div class="srcmeta">${esc(state.meta)}</div>` : ''}
      <div class="disclaim">AI 생성 요약입니다. 기한·금액·문서번호는 원문에서 다시 확인하세요.</div>`;
  }
  // 스트리밍 진행 표시 — 부분 결과 아래에 생성 중 인디케이터
  if (partial && (state.result || state.review)) {
    body += `<div class="gen"><span class="spin"></span>AI 생성 중…</div>`;
  }

  // 본문이 어디로 나갔는지 항상 보이게 — 설정 페이지의 정적 경고만으로는 실효성이 없다
  const isExternal = state.provider === 'gemini';
  const srcBadge = state.provider
    ? `<span class="src ${isExternal ? 'ext' : 'loc'}" title="${isExternal
        ? '문서 본문이 Google 서버(국외)로 전송되었습니다'
        : '문서가 지정한 로컬·내부 서버 밖으로 나가지 않았습니다'}">${isExternal ? 'Gemini · 외부 전송' : '로컬'}</span>`
    : '';

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
      /* 제목은 절대 줄바꿈하지 않는다 — 공간이 모자라면 말줄임 (버튼이 많아 좁은 화면·확대 시 3줄로 깨졌던 문제) */
      .head .t {
        font-weight: 800; font-size: 14px; letter-spacing: -.01em; color: var(--ink);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto;
      }
      .head .sp { flex: 1; }
      .src {
        flex: none; margin-left: 7px; padding: 2.5px 7px; border-radius: 6px;
        font-size: 10.5px; font-weight: 700; letter-spacing: .01em; white-space: nowrap;
      }
      .src.ext { background: rgba(229, 72, 77, .11); color: #C2410C; }
      .src.loc { background: rgba(18, 183, 106, .12); color: #0E9F6E; }
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
      .disclaim { color: var(--ink3); font-size: .76em; line-height: 1.5; padding: 0 4px; }
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
      .notice.info { background: rgba(10, 87, 208, .07); color: #1E4E9C; }
      /* 오탈자: 취소선 원문 → 초록 수정안 + 이유 태그 */
      li.ty { display: flex; flex-wrap: wrap; align-items: baseline; gap: 7px; padding-left: 0; }
      li.ty::before { display: none; }
      .tyb { color: var(--danger); text-decoration: line-through; text-decoration-thickness: 1px; }
      .tya { color: #0E9F6E; font-weight: 700; }
      .tya::before { content: '→ '; color: var(--ink3); font-weight: 400; }
      .tyr { color: var(--ink3); font-size: .78em; background: rgba(11, 27, 51, .05); padding: 1.5px 7px; border-radius: 5px; }
      .tynone { color: var(--ink3); font-size: .85em; padding: 0 4px; }
      .askrow { display: flex; gap: 8px; margin: 12px 0 8px; }
      .abtn {
        all: initial; flex: 1; text-align: center; cursor: pointer; font-family: inherit;
        font-size: .92em; font-weight: 700; padding: 9px 10px; border-radius: 10px;
        background: rgba(11, 27, 51, .06); color: var(--ink2);
      }
      .abtn.primary { background: var(--grad); color: #fff; box-shadow: 0 2px 10px rgba(10, 87, 208, .3); }
      .abtn:hover { filter: brightness(1.06); }
      .srcmeta { color: var(--ink3); font-size: .76em; padding: 0 4px; word-break: break-all; }
      .cnt { background: rgba(11, 27, 51, .07); color: var(--ink2); border-radius: 999px; padding: 1px 7px; font-size: .92em; }
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
        ${srcBadge}
        <span class="sp"></span>
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
  // 합성 클릭(page script의 .click())으로 확장 기능이 돌지 않게 실제 사용자 조작만 수용.
  // 섀도루트가 closed라 페이지가 버튼에 닿을 수 없지만, 이중으로 막는다.
  const onClick = (id, fn) => {
    const el = $(id);
    if (el) el.addEventListener('click', (e) => { if (e.isTrusted) fn(e); });
  };
  // 확장이 리로드·업데이트되면 페이지에 남은 패널의 런타임 연결이 끊긴다 —
  // 조용히 죽지 않고 무엇을 해야 하는지 알린다.
  const send = (msg) => {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch {
      const el = root.querySelector('.bodywrap') || root.querySelector('.panel');
      if (el) el.insertAdjacentHTML('afterbegin',
        '<div class="notice">확장이 업데이트되어 연결이 끊겼습니다. 페이지를 새로고침한 뒤 다시 시도하세요.</div>');
    }
  };

  onClick('bClose', () => host.remove());
  onClick('bWith', () => send({ type: 'edoc-attach-choice', include: true }));
  onClick('bWithout', () => send({ type: 'edoc-attach-choice', include: false }));
  onClick('bSum', () => send({ type: 'edoc-summarize' }));
  onClick('bRev', () => send({ type: 'edoc-review' }));
  onClick('bRefresh', () => send({ type: mode === 'review' ? 'edoc-review' : 'edoc-summarize', force: true }));
  if (hasResult) {
    onClick('bCopy', async () => {
      try {
        await navigator.clipboard.writeText(state.md || '');
        $('bCopy').textContent = '✓ 복사됨';
        setTimeout(() => { const b = $('bCopy'); if (b) b.textContent = '복사'; }, 1500);
      } catch {
        $('bCopy').textContent = '복사 실패';
      }
    });
    onClick('bExport', () => {
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
    onClick('bMinus', () => setFs(-1));
    onClick('bPlus', () => setFs(1));
  }

  // 헤더 드래그로 패널 이동 (버튼 클릭은 제외).
  // 포인터를 캡처해 창 밖에서 놓거나 pointercancel이 나도 리스너가 남지 않게 한다.
  const handle = $('dragHandle');
  handle.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || e.target.closest('.tbtn')) return;
    const rect = host.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    const move = (ev) => {
      host.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - offX)) + 'px';
      host.style.top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offY)) + 'px';
      host.style.right = 'auto';
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      try { handle.releasePointerCapture(e.pointerId); } catch { /* 이미 해제됨 */ }
    };
    try { handle.setPointerCapture(e.pointerId); } catch { /* 미지원 */ }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}
