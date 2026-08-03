// 전자문서 페이지(MAIN 월드, document_start)에 상주하며 페이지 스스로가 내는
// 네트워크 요청 URL을 기록한다 — 웹한글 뷰어·첨부 미리보기가 실제로 쓰는 데이터 경로를
// 알아내기 위한 것. 첨부 다운로드 링크는 DRM 래핑·페이지 응답을 주지만, 미리보기 경로는
// 뷰어에 DRM-free 원본을 스트리밍하므로 이 URL 패턴을 학습하면 첨부 내용을 깨끗하게 받을 수 있다.
//
// 기록만 하고 아무것도 바꾸지 않는다 (원 함수 그대로 통과). 같은 출처 URL만, 정적 리소스 제외,
// 최대 150건 링 버퍼. background가 요약 실행 시 __edocNetLog를 수집해 서비스워커 콘솔에 남긴다.
(() => {
  if (globalThis.__edocNetLog) return;
  const log = globalThis.__edocNetLog = [];
  let seq = 0;
  const push = (kind, url, method) => {
    try {
      if (!url) return;
      const u = new URL(url, location.href);
      // 크로스오리진도 기록한다 — 웹한글 뷰어는 문서 데이터를 변환 게이트웨이
      // (실측: hconvg1.cseoul.go.kr)에서 받으므로 같은 출처만 남기면 핵심이 다 걸러진다
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
      if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(u.pathname)) return;
      const id = ++seq;
      log.push({ __id: id, t: Date.now(), kind, method: (method || 'GET').toUpperCase(), url: u.href.slice(0, 500) });
      if (log.length > 150) log.shift();
      return id;
    } catch { return 0; /* 무효 URL */ }
  };

  // POST 바디도 남긴다 — 웹한글 뷰어는 문서를 다운로드하지 않고 변환 서버에 열 문서의
  // 주소를 POST(실측: hconvg1/openurl)한다. 첨부 미리보기의 바디에 첨부 실제 경로가 들어 있다.
  const bodyOf = (b) => {
    try {
      if (typeof b === 'string') return b.slice(0, 700);
      if (b instanceof URLSearchParams) return b.toString().slice(0, 700);
      if (b instanceof FormData) return [...b].map(([k, v]) => `${k}=${typeof v === 'string' ? v : '(blob)'}`).join('&').slice(0, 700);
      return b ? `(${b.constructor?.name || typeof b})` : '';
    } catch { return ''; }
  };
  const attachBody = (b) => {
    const s = bodyOf(b);
    if (s && log.length) log[log.length - 1].body = s;
  };

  const origFetch = globalThis.fetch;
  if (typeof origFetch === 'function') {
    globalThis.fetch = function (input, init) {
      try {
        push('fetch', typeof input === 'string' ? input : input?.url, init?.method);
        attachBody(init?.body);
      } catch { /* 기록 실패 무시 */ }
      return origFetch.apply(this, arguments);
    };
  }

  const origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__edocIdx = push('xhr', url, method); } catch { /* 기록 실패 무시 */ }
    return origXhrOpen.apply(this, arguments);
  };
  const origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (data) {
    try {
      const e = log.find((x) => x.__id === this.__edocIdx);
      const s = bodyOf(data);
      if (e && s) e.body = s;
    } catch { /* 기록 실패 무시 */ }
    return origXhrSend.apply(this, arguments);
  };

  const origWinOpen = window.open;
  window.open = function (url) {
    try { push('window.open', url); } catch { /* 기록 실패 무시 */ }
    // 미리보기 억제 중에는 창을 열지 않는다. 다만 폼 target용 빈 창 요청(about:blank·이름만)은
    // 막으면 폼 전송이 엉키므로, 실제 주소가 있는 경우만 막는다.
    if (globalThis.__edocSuppressPreview === true && url && !/^about:/i.test(String(url))) return null;
    return origWinOpen.apply(this, arguments);
  };

  // 뷰어가 변환 서버와 웹소켓으로 통신하는 경우 대비
  try {
    const OrigWS = globalThis.WebSocket;
    globalThis.WebSocket = new Proxy(OrigWS, {
      construct(target, args) {
        try { push('ws', args[0]); } catch { /* 기록 실패 무시 */ }
        return new target(...args);
      },
    });
  } catch { /* WebSocket 없음 */ }

  // 폼 전송은 필드까지 남긴다 — 첨부 미리보기가 폼 POST로 뷰어 창을 띄우는 구조라
  // (실측: form POST /html/docsView.jsp), 이 필드를 알면 창을 띄우지 않고 같은 요청을 재현할 수 있다.
  const formBody = (form) => {
    try {
      return [...new FormData(form)]
        .map(([k, v]) => `${encodeURIComponent(k)}=${typeof v === 'string' ? encodeURIComponent(v) : '(file)'}`)
        .join('&').slice(0, 1500);
    } catch { return ''; }
  };
  const recordSubmit = (form) => {
    try {
      const id = push('form:' + (form.method || 'get'), form.action, form.method);
      const b = formBody(form);
      const e = log.find((x) => x.__id === id);
      if (e && b) e.body = b;
    } catch { /* 기록 실패 무시 */ }
  };
  // 확장이 첨부 미리보기를 조작하는 동안에만 켜지는 억제 플래그.
  // 필드는 기록하되 전송은 취소한다 — 확장이 같은 요청을 대신 보내므로 미리보기 창이 필요 없다.
  // (사용자가 직접 누른 미리보기는 플래그가 꺼져 있어 정상 동작한다)
  const suppress = (form) => {
    if (globalThis.__edocSuppressPreview !== true) return false;
    try { return /docsview|preview|atch/i.test(form.action || ''); } catch { return false; }
  };

  const origSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    recordSubmit(this);
    if (suppress(this)) return undefined;
    return origSubmit.apply(this, arguments);
  };
  // 버튼 클릭으로 전송되는 폼(스크립트 submit()을 거치지 않는 경우)도 잡는다
  try {
    document.addEventListener('submit', (e) => {
      if (!(e.target instanceof HTMLFormElement)) return;
      recordSubmit(e.target);
      if (suppress(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
  } catch { /* document 미준비 */ }

  // 미리보기가 iframe 교체 방식일 때 — src 변화·신규 iframe도 기록
  try {
    new MutationObserver((muts) => {
      for (const m of muts) {
        const nodes = m.type === 'attributes' ? [m.target] : [...m.addedNodes];
        for (const n of nodes) {
          if (!n || n.nodeType !== 1) continue;
          if (n.tagName === 'IFRAME' && n.src) push('iframe', n.src);
          else if (n.querySelectorAll) for (const f of n.querySelectorAll('iframe[src]')) push('iframe', f.src);
        }
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  } catch { /* documentElement 미준비 등 */ }
})();
