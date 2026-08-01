// 전자문서 문서 화면에 플로팅 AI 요약 버튼을 띄우는 콘텐츠 스크립트.
// 클릭하면 background로 요약 요청. 드래그로 위치 이동 가능(위치는 저장되어 유지).
//
// 이 스크립트는 background.js가 사용자 승인 호스트에만 동적 등록한다(정적 content_scripts 없음).
// 클래식 스크립트로 주입되므로 import를 쓸 수 없어 호스트 매칭을 여기서 다시 확인한다.
(async () => {
  const HOST_ID = '__edoc_ai_widget_host';
  const stale = document.getElementById(HOST_ID);
  if (stale) {
    // __alive는 격리 월드 expando — 있으면 이번 월드에서 마운트한 살아있는 위젯이다.
    // 없으면 확장 리로드로 런타임이 끊긴 껍데기이므로 치우고 새로 띄운다.
    if (stale.__alive) return;
    stale.remove();
  }

  const DEFAULT_HOSTS = ['cseoul.go.kr'];
  // config.js normalizeHost와 같은 규칙 (콘텐츠 스크립트는 클래식이라 import 불가).
  // 한글 도메인을 punycode로 맞추고 포트를 떼어낸다 — location.hostname과 비교하려면 필요하다.
  const norm = (h) => {
    const raw = String(h || '').trim().replace(/^\*\./, '');
    if (!raw || /[/\s*]/.test(raw)) return '';
    try { return new URL(`https://${raw}`).hostname; } catch { return ''; }
  };
  // 부분 문자열 매칭은 cseoul.go.kr.attacker.com 같은 스푸핑 도메인에도 걸린다 — 경계를 고정한다.
  const matches = (h) => h && (location.hostname === h || location.hostname.endsWith('.' + h));

  const { widgetHosts } = await chrome.storage.sync.get('widgetHosts');
  const hosts = (Array.isArray(widgetHosts) && widgetHosts.length ? widgetHosts : DEFAULT_HOSTS)
    .map(norm).filter(Boolean);
  if (!hosts.some(matches)) return;
  // 기본 사이트는 문서카드 화면 셀렉터로 판별, 사용자가 추가한 그룹웨어는 셀렉터를 모르므로 항상 표시
  const isDefaultSite = DEFAULT_HOSTS.map(norm).some(matches);

  let tries = 0;
  const tryMount = async () => {
    // 문서관리카드 화면인지 확인 (본문 영역 존재 여부)
    if (isDefaultSite && !document.querySelector('#DIV_ENF_DOC, #dvAppr')) {
      if (++tries < 5) setTimeout(tryMount, 1500);
      return;
    }
    const { widgetPos } = await chrome.storage.local.get('widgetPos');

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial; position:fixed; z-index:2147483646; touch-action:none;';
    if (widgetPos?.left != null) {
      host.style.left = Math.min(widgetPos.left, window.innerWidth - 64) + 'px';
      host.style.top = Math.min(widgetPos.top, window.innerHeight - 64) + 'px';
    } else {
      host.style.top = '40%';
      host.style.right = '16px';
    }
    document.documentElement.appendChild(host);
    host.__alive = true;

    // closed — 페이지 스크립트가 shadowRoot로 버튼을 찾아 click()으로 요약을 반복 실행하지 못하게.
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .orb {
          all: initial; position: relative; display: block;
          width: 52px; height: 52px; cursor: pointer;
        }
        /* 은은한 오로라 글로우 — 평소엔 조용히, 호버 시 살아남 */
        .orb::before {
          content: ''; position: absolute; inset: -3px; border-radius: 20px;
          background: conic-gradient(from 0deg, #2E90FA, #22D3EE, #00C2A8, #5B8DEF, #2E90FA);
          filter: blur(9px); opacity: .28;
          animation: spin 10s linear infinite;
          transition: opacity .3s ease;
        }
        .core {
          position: absolute; inset: 0; border-radius: 17px;
          background: linear-gradient(150deg, #0E3E8F 0%, #0A57D0 45%, #0891B2 100%);
          display: flex; align-items: center; justify-content: center;
          border: 1px solid rgba(255, 255, 255, .3);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, .25), 0 4px 14px rgba(10, 60, 140, .3);
          transition: transform .2s cubic-bezier(.34, 1.56, .64, 1);
        }
        .core svg { width: 25px; height: 25px; }
        .orb:hover::before { opacity: .75; }
        .orb:hover .core { transform: scale(1.06); }
        .orb:active .core { transform: scale(.95); }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .orb::before { animation: none; }
        }
      </style>
      <button class="orb" title="AI 문서 요약 (드래그로 이동)">
        <span class="core">
          <svg viewBox="0 0 24 24" fill="none">
            <path class="tw" d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" fill="#fff"/>
            <path class="tw tw2" d="M18.5 14.5l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4z" fill="#A5F3FC"/>
          </svg>
        </span>
      </button>`;

    // 클릭 = 요약 실행, 드래그(5px 이상 이동) = 위치 이동
    const btn = root.querySelector('.orb');
    btn.addEventListener('pointerdown', (e) => {
      if (!e.isTrusted) return; // 페이지가 만든 합성 이벤트는 무시
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = host.getBoundingClientRect();
      let dragged = false;
      const move = (ev) => {
        if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        dragged = true;
        host.style.left = Math.max(0, Math.min(window.innerWidth - 58, rect.left + ev.clientX - startX)) + 'px';
        host.style.top = Math.max(0, Math.min(window.innerHeight - 58, rect.top + ev.clientY - startY)) + 'px';
        host.style.right = 'auto';
      };
      // 창 밖에서 놓거나 pointercancel이 나도 리스너가 남지 않도록 포인터를 캡처한다
      const up = (ev) => {
        btn.removeEventListener('pointermove', move);
        btn.removeEventListener('pointerup', up);
        btn.removeEventListener('pointercancel', up);
        try { btn.releasePointerCapture(e.pointerId); } catch { /* 이미 해제됨 */ }
        if (dragged) {
          const r = host.getBoundingClientRect();
          chrome.storage.local.set({ widgetPos: { left: r.left, top: r.top } });
        } else if (ev.type === 'pointerup') {
          try {
            chrome.runtime.sendMessage({ type: 'edoc-summarize' }, () => void chrome.runtime.lastError);
          } catch {
            // 확장 업데이트·리로드로 런타임 연결이 끊긴 상태
            btn.title = '확장이 업데이트되었습니다 — 페이지를 새로고침하세요';
          }
        }
      };
      try { btn.setPointerCapture(e.pointerId); } catch { /* 미지원 */ }
      btn.addEventListener('pointermove', move);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
    });
  };
  tryMount();
})();
