// 전자문서(cseoul.go.kr) 문서 화면에 플로팅 ✨ 버튼을 띄우는 콘텐츠 스크립트.
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
      host.style.left = Math.min(widgetPos.left, window.innerWidth - 60) + 'px';
      host.style.top = Math.min(widgetPos.top, window.innerHeight - 60) + 'px';
    } else {
      host.style.top = '40%';
      host.style.right = '14px';
    }
    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        button {
          all: initial; cursor: pointer; width: 48px; height: 48px; border-radius: 16px;
          background: #246BEB; color: #fff;
          display: flex; align-items: center; justify-content: center;
          font-size: 21px; box-shadow: 0 4px 14px rgba(0, 54, 117, .35);
          transition: transform .15s ease, background .15s ease;
        }
        button:hover { transform: scale(1.07); background: #1D5BD6; }
        button:active { transform: scale(.96); }
      </style>
      <button title="AI 문서 요약 (드래그로 이동)">✨</button>`;

    // 클릭 = 요약 실행, 드래그(5px 이상 이동) = 위치 이동
    const btn = root.querySelector('button');
    btn.addEventListener('pointerdown', (e) => {
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = host.getBoundingClientRect();
      let dragged = false;
      const move = (ev) => {
        if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        dragged = true;
        host.style.left = Math.max(0, Math.min(window.innerWidth - 52, rect.left + ev.clientX - startX)) + 'px';
        host.style.top = Math.max(0, Math.min(window.innerHeight - 52, rect.top + ev.clientY - startY)) + 'px';
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
