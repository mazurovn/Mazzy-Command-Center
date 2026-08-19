# Mazzy Command Center

[English](README.md) · [Русский](README.ru.md) · [Deutsch](README.de.md) · [中文](README.zh.md) · [日本語](README.ja.md) · **한국어**

**[Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 코딩 에이전트를 위한, 부모가 증명하는 로컬 작업 지휘 센터.**

_작성자: **Mazurov N.N.** — https://github.com/mazurovn · 독점, 소스 공개(서면 허가
없이 수정·재배포 불가 — [LICENSE](LICENSE) 참조)._

Mazzy Command Center는 프로젝트 로컬 Pi 확장으로, Pi 세션을 지속적이고 감사 가능한
에이전트 작업 지휘 센터로 바꿉니다: 작업 추적기, 오케스트레이션 의사결정 화면, 리뷰/
증거 원장, 그리고 인증된 로컬 웹 대시보드 —— 모두 단일 내장 SQLite 제어 평면 위에서
동작합니다.

> **상태: 인증된 로컬 파일럿.** 단일 머신, 단일 신뢰 사용자, 프로젝트 로컬 지속성,
> 프로세스 수준의 부모/자식 경계. 아직 다중 사용자, 다중 테넌트, 원격 제품이
> **아닙니다**. [보안 및 제한](#보안-및-제한)을 참조하세요.

---

## 무엇을 하는가

Mazzy는 두 번째 실행 런타임이 아니라 **제어 평면**입니다. 작업을 기록하고 통제하며,
실제 자식 실행은 `pi-subagents`에 위임합니다. 부모 Pi 세션이 제어 평면의 유일한
기록자이며, 자식 에이전트는 상태를 직접 변경하지 않고 부모가 관찰된 결과를 증명합니다.

- **지속적 작업 추적기** —— 에픽 / 기능 / 작업 / 버그를 버전 관리된 수명 주기
  (`DRAFT → BACKLOG → READY → CLAIMED → RUNNING → REVIEW → DONE`, 그리고
  `BLOCKED / FAILED / CANCELLED`)로 관리합니다. 모든 갱신은 낙관적 동시성 검사를 거칩니다.
- **부모가 증명하는 오케스트레이션** —— 부모는 작업이 실행 중이라고 주장하기 전에
  *관찰된* 자식 실행을 작업에 바인딩합니다. `DONE`은 댓글이 아니라 독립적인 PASS 증거를
  요구합니다.
- **인증된 로컬 대시보드** —— `localhost`의 자체 완결형 웹 UI로, 능력 토큰, SSE 기반
  실시간 업데이트, 칸반 보드, 작업 토론 서랍을 제공합니다.
- **SDD/ADR 그래프** —— 사양 조항(ADR/INV/FR), 코드 구성 요소, 백로그 항목을 하나의
  필터 가능한 연결 그래프로 잇는 브라우저 내 시각화.
- **안전한 스캐폴딩** —— `mazzy-init`은 기본 드라이런, 보호된 `--force`, `--rollback`과
  함께 이식 가능한 프로젝트 템플릿을 작성합니다.

---

## 아키텍처 개요

```
사람 ── Pi 명령 / 인증된 localhost 브라우저 ──┐
                                              v
Pi 부모 + 확장 API ── Mazzy Command Center ── SQLite 제어 평면
                    │       │        │
                    │       ├─ 토론 / 증거 / 보고서
                    │       └─ 증명된 제어 브리지
                    v
              pi-subagents(유일한 자식 런타임)
```

**핵심 원칙(불변식):**

- **단일 실행 런타임** —— 자식은 `pi-subagents`가 실행합니다. Mazzy는 자식 작업을
  생성, 스케줄링, 재시도, 종료하지 않습니다. *의사결정* 권한을 가질 뿐 *실행* 권한은
  갖지 않습니다.
- **부모만 기록** —— 제어 평면 변경에는 대화형 부모가 필요하며, 상속된 자식 프로세스는
  거부됩니다.
- **호스트 경로는 API를 넘지 않음** —— 불투명 id, 열거형, 상대 참조만 localhost를
  떠납니다.
- **댓글은 결코 증거가 아님** —— 권위 있는 PASS/FAIL 채널은 리뷰어/검증자 증거입니다.
- **모든 `git` 호출은 강화됨** —— 저장소 구성/훅과 상속된 환경이 실행에 영향을 줄 수
  없습니다.

---

## 도구와 명령

**부모 전용 도구**(LLM에 보이는 표면):

| 도구 | 목적 |
|---|---|
| `mazzy_task` | 지속 작업 생성 / 목록 / 조회 / 갱신(버전 관리, `DONE`은 PASS 증거 필요). |
| `mazzy_route` | 위임을 위한 읽기 전용 정책 사전 점검(생성하지 않음). |
| `mazzy_assignment` | 부모가 증명하는 실행 바인딩, 완료 가져오기, 리뷰어 증거. |
| `mazzy_discussion` | 지속적 작업 토론 읽기/응답. |
| `mazzy_control` | 대시보드 GO / PAUSE / STOP 요청의 claim/complete/fail. |

**슬래시 명령:** `/mazzy`(상태 + 대시보드 URL), `/mazzy-url`(토큰 포함 접근 URL),
`/mazzy-server`(start/stop/status), `/mazzy-menu`(`Ctrl+Alt+M`), `/mazzy-init`,
`/mazzy-doctor`, `/mazzy-registry`, `/mazzy-clean`.

---

## 설치

**요구 사항**

| 구성 요소 | 버전 |
|---|---|
| Node.js | `>= 22.19.0` |
| `@earendil-works/pi-coding-agent` | `0.84.2` |
| `@earendil-works/pi-ai` | `0.84.2` |
| `@earendil-works/pi-tui` | `0.84.2` |

**npm에서 설치:**

```bash
pi install npm:@mazurovn/mazzy-command-center
# 그런 다음 Pi를 재시작하여 확장을 인식하게 합니다.
```

**GitHub에서 설치:**

```bash
pi install git:github.com/mazurovn/Mazzy-Command-Center
```

**검증:**

```bash
npm run typecheck
npm test
```

Pi 세션에서 `/mazzy`를 실행해 상태와 대시보드 URL을 보거나, `/mazzy-url`로 인증된
접근 URL을 표시하세요(토큰은 로그에 기록되지 않습니다).

---

## 보안 및 제한

이것은 **인증된 로컬 파일럿**이며, 프로덕션 보안 보장으로 해석해서는 안 됩니다.

- 단일 머신, 단일 신뢰 사용자, 부모/자식 프로세스 경계.
- 다중 사용자 인가가 **아니며**, 테넌트 격리가 **아니며**, 원격 신원이 **아니며**,
  분산 기록자 리스가 **아닙니다**.
- 대시보드 동작, 전송된 제어 요청, 부모 확인은 실행이나 검증의 증거가 **아닙니다**.

보안 문제는 공개 이슈가 아니라 비공개 채널로 신고해 주세요.

---

## 라이선스

**[PolyForm Noncommercial License 1.0.0](LICENSE) 기반 소스 공개.**
Copyright (c) 2026 Mazurov N.N.

- ✅ 모든 **비상업적** 목적(개인 사용, 연구·과학, 교육)의 사용·연구·수정·공유는
  **무료**입니다.
- ⛔ **상업적 사용 불가.** 기업 및 상업 제품/서비스는 별도의 상업 라이선스가
  필요합니다. 상업용 **Mazzy Command Center Enterprise** 에디션을 제공합니다.
- ⛔ 모든 작성자/저작권/라이선스 고지를 유지해야 하며, 서면 허가 없이 소프트웨어
  이름 변경, 저작자 표시 제거, 동일 명칭(“Mazzy Command Center” / “Mazzy”)으로의
  수정본 제시가 불가합니다.

상업 라이선스 또는 위 조건을 벗어난 사용 문의: https://github.com/mazurovn
