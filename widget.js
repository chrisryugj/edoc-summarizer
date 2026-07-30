// 전자문서(cseoul.go.kr) 문서 화면에 플로팅 AI 요약 버튼을 띄우는 콘텐츠 스크립트.
// 클릭하면 background로 요약 요청. 드래그로 위치 이동 가능(위치는 저장되어 유지).
// 문서카드 화면이 아닌 페이지에는 표시하지 않음.
(() => {
  const HOST_ID = '__edoc_ai_widget_host';
  if (document.getElementById(HOST_ID)) return;

  let tries = 0;
  const tryMount = async () => {
    // 문서관리카드 화면인지 확인 (본문 영역 존재 여부)
    if (!document.querySelector('#DIV_ENF_DOC, #dvAppr')) {
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

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .orb {
          all: initial; position: relative; display: block;
          width: 54px; height: 54px; cursor: pointer;
          animation: float 5s ease-in-out infinite;
        }
        /* 회전하는 오로라 글로우 링 */
        .orb::before {
          content: ''; position: absolute; inset: -5px; border-radius: 22px;
          background: conic-gradient(from 0deg, #2E90FA, #22D3EE, #00C2A8, #5B8DEF, #2E90FA);
          filter: blur(11px); opacity: .65;
          animation: spin 4s linear infinite;
          transition: opacity .25s ease, filter .25s ease;
        }
        /* 숨쉬는 펄스 링 */
        .orb::after {
          content: ''; position: absolute; inset: 0; border-radius: 18px;
          box-shadow: 0 0 0 0 rgba(34, 211, 238, .45);
          animation: pulse 2.6s cubic-bezier(.4, 0, .2, 1) infinite;
        }
        .core {
          position: absolute; inset: 0; border-radius: 18px;
          background: linear-gradient(150deg, #0E3E8F 0%, #0A57D0 45%, #0891B2 100%);
          display: flex; align-items: center; justify-content: center;
          border: 1px solid rgba(255, 255, 255, .35);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, .3), 0 6px 18px rgba(10, 60, 140, .35);
          transition: transform .2s cubic-bezier(.34, 1.56, .64, 1);
        }
        .core svg { width: 26px; height: 26px; }
        .core .tw { transform-origin: center; animation: twinkle 2.2s ease-in-out infinite; }
        .core .tw2 { animation-delay: 1.1s; }
        .orb:hover::before { opacity: 1; filter: blur(14px); }
        .orb:hover .core { transform: scale(1.09); }
        .orb:active .core { transform: scale(.94); }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(34, 211, 238, .4); }
          70% { box-shadow: 0 0 0 12px rgba(34, 211, 238, 0); }
          100% { box-shadow: 0 0 0 0 rgba(34, 211, 238, 0); }
        }
        @keyframes twinkle { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.8); } }
        @media (prefers-reduced-motion: reduce) {
          .orb, .orb::before, .orb::after, .core .tw { animation: none; }
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
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (dragged) {
          const r = host.getBoundingClientRect();
          chrome.storage.local.set({ widgetPos: { left: r.left, top: r.top } });
        } else {
          chrome.runtime.sendMessage({ type: 'edoc-summarize' });
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  };
  tryMount();
})();
