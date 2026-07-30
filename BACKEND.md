# 백엔드 아키텍처 (2단계 로드맵)

POC(현재)는 확장 → Gemini 직결 구조. 2단계에서 내부망 백엔드를 두고 **내부 LLM 전환 + 첨부파일 내용 분석**을 해결한다.

## 왜 백엔드가 필요한가

| 문제 | POC(현재) | 2단계(백엔드) |
|---|---|---|
| 문서 본문이 외부(Google)로 전송 | ⚠ 민감문서 사용 불가 | 내부망에서 종결 |
| API 키가 클라이언트에 평문 저장 | ⚠ 사용자별 키 발급 필요 | 키 불요 (서버 관리) |
| 첨부파일(hwp/hwpx/xlsx) 내용 분석 | ✖ 불가 (브라우저에서 hwp 파싱 불가, Gemini도 hwp 미지원) | kordoc으로 서버 추출 |
| 프롬프트 개선 배포 | 확장 재배포 필요 | 서버에서 일괄 반영 |

## 구성도

```
[Edge 확장]
  ├─ 본문 추출 (문서카드 DOM + 웹한글 GetTextFile API)   ← 지금과 동일
  ├─ 첨부 다운로드 (세션 쿠키로 확장이 직접 fetch)
  │     └─ multipart로 백엔드에 전달
  ▼
[내부 API 서버]  (FastAPI 권장, 내부망 전용)
  ├─ POST /summarize   { text, attachments[] }
  ├─ kordoc CLI: hwp/hwpx/xlsx/docx/pdf → 텍스트 추출
  ├─ 프롬프트 조립 (본문 + 첨부 텍스트 병합, 상한 관리)
  ▼
[내부 LLM]  (vLLM 등 OpenAI 호환 /v1/chat/completions)
```

## 설계 포인트

- **확장 쪽 변경 최소화**: `llm.js`의 provider를 `openai`로 바꾸고 baseUrl만 내부 API 서버로 지정하면 됨.
  첨부 전달만 신규 구현 (문서카드의 첨부 다운로드 링크를 확장이 쿠키 포함 fetch → FormData 전송).
- **첨부 추출은 kordoc**: hwp/hwpx/pdf/xlsx/docx 텍스트 추출 실적 있는 CLI를 서버에 설치.
  변환 실패 파일은 파일명만 요약에 반영하고 실패 사실을 표기.
- **인증**: 내부망 IP 제한 + (필요시) 부서 토큰. 사용자 개인 키 없음.
- **로깅 최소화**: 문서 본문은 저장하지 않는다. 요청 메타(시각·문서 글자수·모델·소요시간)만 기록.
- **모델 교체 자유**: OpenAI 호환 인터페이스만 지키면 vLLM/Ollama/상용 프록시 무엇이든 스왑 가능.

## 마이그레이션 순서

1. 내부 서버에 vLLM(또는 Ollama) + FastAPI 셋업, `/v1/chat/completions` 프록시 확인
2. 확장 옵션에서 provider=내부 LLM, baseUrl 지정 → 본문 요약부터 내부 전환
3. `/summarize` 엔드포인트 신설 + kordoc 설치 → 첨부 분석 추가
4. 확장에 첨부 fetch/전송 코드 추가, 요약 UI에 "첨부 N건 분석됨" 표기
