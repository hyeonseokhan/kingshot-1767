/**
 * survey.kingshot.wooju-home.org/kvk-buff 페이지 클라이언트 로직.
 *
 * 흐름:
 *   1) boot → localStorage 의 토큰으로 get-state 호출 (token 옵션)
 *   2) 5초마다 polling (서버 state 와 sync, stale 충돌 회복)
 *   3) 본인 차례면 slot-card 클릭 → confirm → pick-slot RPC
 *   4) admin 이면 skip / swap 버튼 활성 (자동, is_admin 기반)
 *
 * 모든 변경은 Edge Function `kvk-buff` 통과. RPC 가 atomic 처리.
 * 마감 전 (UTC 5/16 01:00) 이면 잠금 placeholder.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/shared/supabase';
import { t, onLangChange } from '@/i18n';
import { SURVEY_DEADLINE_ISO } from '@/lib/kvk-survey/survey-deadline';

const FN_URL = SUPABASE_URL + '/functions/v1/kvk-buff';

// !!! TEST_MODE — 관리자 필드 테스트용 분기. 종료 후 제거 대상 !!!
//   활성화: survey-kvk.ts 의 [테스트] 버튼 클릭 → setBuffTestMode(true) + openBuffOverlay() (admin 전용)
//   영향:
//     - callFn body 에 test_mode: true 자동 동봉 → Edge Function 이 _test 테이블/RPC 사용.
//     - TOTAL_SLOTS 가 6 으로 축소 (admin 6명 전원 1슬롯씩 시나리오).
//   인증은 운영 그대로 (kvk_speedup_survey 의 본인 PIN 으로 로그인).
//   제거: `TEST_MODE` 키워드 grep → 본 분기 + survey-kvk.ts + Edge Function + 마이그레이션 ROLLBACK.
let testMode = false;
const TEST_TOTAL_SLOTS = 6;
const PROD_TOTAL_SLOTS = 48;

/** 외부(survey-kvk.ts) 가 [테스트] 버튼 클릭 시 호출 — 다이얼로그를 격리 모드로 진입.
 *  setupBuffDialog() 한 번 호출 후 매번 토글 가능. */
export function setBuffTestMode(v: boolean): void {
  testMode = v;
}

function totalSlots(): number {
  // testMode: admin 수에 맞춰 동적 (bootstrap_test 가 admin 모두 INSERT → participants.length).
  // 첫 fetch 응답 전엔 fallback 6 (잠금 placeholder 노출 시점이라 무관).
  if (testMode) return participants.length || TEST_TOTAL_SLOTS;
  return PROD_TOTAL_SLOTS;
}

const POLL_INTERVAL_MS = 2000;

/** localStorage key — 가속권 현황 조사 페이지의 토큰을 그대로 공유. */
const AUTH_KEY = 'pnx-sk-auth-v1';

interface BuffState {
  bootstrapped_at: string | null;
  current_turn_idx: number;
  turn_started_at: string | null;
  finalized_at: string | null; // admin "예약 마감" 호출 시각. NULL=진행 중.
  updated_at: string;
}

interface Participant {
  kingshot_id: string;
  turn_idx: number;
  score_rank: number;
  was_verified: boolean;
  slot_idx: number | null;
  picked_at: string | null;
  survey: {
    nickname: string;
    avatar_url: string | null;
    city_level: number;
  } | null;
}

interface Me {
  kingshot_id: string;
  nickname: string;
  is_admin: boolean;
  turn_idx?: number;
  slot_idx?: number | null;
}

interface StateResponse {
  ok: boolean;
  deadline: string;
  state: BuffState | null;
  participants: Participant[];
  me: Me | null;
  error?: string;
}

// ===== state =====
let buffState: BuffState | null = null;
let participants: Participant[] = [];
let me: Me | null = null;
let token: string | null = null;
let tzMode: 'UTC' | 'KST' = 'KST';
let pendingSlotIdx: number | null = null; // confirm 다이얼로그 대기 중 slot idx
// swap selection — DOM element 가 아닌 slot_idx 값으로 보존.
// (이전엔 swapSourceCard:HTMLElement 였는데 5초 polling 의 renderGrid 가 grid.innerHTML='' 로
//  통째 재생성하면서 detached element 되어 두 번째 클릭 시 swap 시작점을 잃는 회귀 발생.)
// 값 보존 + renderGrid 후 슬롯 카드에 .is-swap-source 재마킹 → polling 무관 selection 유지.
let swapSourceSlotIdx: number | null = null;
let pendingSwapTargetSlotIdx: number | null = null;
let pollingTimer: number | null = null;
let elapsedTimer: number | null = null;
let countdownTimer: number | null = null;

// ===== DOM =====
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

// ===== API =====
async function callFn<T = unknown>(body: Record<string, unknown>): Promise<T> {
  // token 매번 fresh 로 읽기 — module-scope token 변수가 init() 시점 stale 인 케이스 차단.
  // (사용자가 페이지 로드 후 로그인하면 module token 은 여전히 null → invalid_token 회귀.)
  const freshToken = loadToken();
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    // 호출자가 token 명시 전달하더라도 freshToken 으로 덮어씀.
    // !!! TEST_MODE — 모든 액션 body 에 test_mode 자동 동봉 (서버에서 _test 분기) !!!
    body: JSON.stringify({ ...body, token: freshToken, test_mode: testMode }),
  });
  return res.json();
}

function loadToken(): string | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return typeof obj?.token === 'string' ? obj.token : null;
  } catch {
    return null;
  }
}

// ===== 시간 포맷 =====
function formatSlotTime(idx: number, mode: 'UTC' | 'KST'): string {
  const utcH = Math.floor(idx / 2);
  const m = (idx % 2) * 30;
  const h = mode === 'KST' ? (utcH + 9) % 24 : utcH;
  return `${mode} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function tzToggleLabel(mode: 'UTC' | 'KST'): string {
  return mode === 'KST' ? 'KST → UTC' : 'UTC → KST';
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ===== 렌더링 =====
function renderAll(): void {
  applyAdminClass();
  renderLocked();
  // 운영/테스트 모두 선착순 → 진행률 카드만 노출. (renderCurrent 는 호출 안 함, sk-buff-current 는 CSS 영구 hidden.)
  renderProgress();
  renderGrid();
}

/** 선착순 — 점유 슬롯 수 / 전체 슬롯 수 진행률 표시.
 *  마감 시 카드 자체가 회색 톤 + 제목 "🔒 예약 마감" 으로 swap (점유 카운트는 그대로 유지). */
function renderProgress(): void {
  const total = totalSlots();
  const done = participants.filter((p) => p.slot_idx !== null).length;
  $('sk-buff-progress-done').textContent = String(done);
  $('sk-buff-progress-total').textContent = String(total);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  ($('sk-buff-progress-fill') as HTMLElement).style.width = pct + '%';
  // 마감 분기 — 카드 색 swap + 제목 텍스트 swap. (data-i18n 미사용 → JS 가 단일 책임.)
  const isFinalized = !!buffState?.finalized_at;
  $('sk-buff-progress').classList.toggle('is-finalized', isFinalized);
  $('sk-buff-progress-label').textContent = t(
    isFinalized ? 'survey.kvkBuff.progress.labelFinalized' : 'survey.kvkBuff.progress.label',
  );
}

/** localStorage 의 auth.record.is_admin 캐시 — 다이얼로그 오픈 직후 첫 polling 응답 도착 전
 *  스킵/swap 등 admin UI 가 깜빡이지 않도록 fallback 으로 사용. AUTH_KEY 는 survey-kvk.ts 와 일치. */
function readCachedIsAdmin(): boolean {
  try {
    const raw = localStorage.getItem('pnx-sk-auth-v1');
    if (!raw) return false;
    return JSON.parse(raw)?.record?.is_admin === true;
  } catch {
    return false;
  }
}

function applyAdminClass(): void {
  const page = $('sk-buff-page');
  const overlay = document.getElementById('sk-buff-overlay');
  // me (kvk-buff get-state 응답) 가 우선, 없으면 (다이얼로그 오픈 직후 race) 캐시 fallback.
  const isAdmin = me?.is_admin === true || (me === null && readCachedIsAdmin());
  page.classList.toggle('is-admin', isAdmin);
  // overlay 에도 .is-admin — 헤더 영역 (admin 도구 버튼) CSS 게이트용.
  overlay?.classList.toggle('is-admin', isAdmin);
  // 시작 여부 — bootstrapped_at 채워졌으면 시작됨. CSS 가드 + admin 도구 disabled 분기.
  const isStarted = !!buffState?.bootstrapped_at;
  const isFinalized = !!buffState?.finalized_at;
  page.classList.toggle('is-started', isStarted);
  page.classList.toggle('is-finalized', isFinalized);
  // TEST_MODE — page + overlay 양쪽에 토글. overlay 는 head 영역의 [TEST] 라벨/[재시작] 게이트용.
  page.classList.toggle('is-test', testMode);
  overlay?.classList.toggle('is-test', testMode);

  // admin 도구 [예약 시작]/[예약 마감] disabled 토글
  //   [시작]: 시작 전(!isStarted)만 활성. 시작 후 disabled (이중 클릭 차단).
  //   [마감]: 시작 후만 활성. 시작 전 또는 이미 마감 시 disabled.
  const startBtn = document.getElementById('sk-buff-start-btn') as HTMLButtonElement | null;
  const finalizeBtn = document.getElementById('sk-buff-finalize-btn') as HTMLButtonElement | null;
  if (startBtn) startBtn.disabled = isStarted;
  if (finalizeBtn) finalizeBtn.disabled = !isStarted || isFinalized;
}

function renderLocked(): void {
  const locked = $('sk-buff-locked');
  const grid = $('sk-buff-grid');
  const current = $('sk-buff-current');
  // 잠금 = bootstrap 안 된 상태만. (deadline 가드는 외부 [버프 예약] 버튼이 마감 전엔 hidden 으로 막아주므로
  //  여기까지 도달했다면 — 운영: 마감 통과 / 테스트: 즉시 진입 — 둘 다 deadline 무관.)
  const notBootstrapped = !buffState?.bootstrapped_at;
  locked.hidden = !notBootstrapped;
  grid.hidden = notBootstrapped;
  current.hidden = notBootstrapped;
  if (notBootstrapped) {
    $('sk-buff-locked-body').textContent = t('survey.kvkBuff.locked.bodyBootstrap');
  }
}

function renderCurrent(): void {
  const card = $('sk-buff-current');
  // 마감 분기 — admin 이 [예약 마감] 누른 후. "선택중" 영역 + 타이머 정지 + 별도 메시지.
  // .is-completed 도 같이 부여 → 기존 완료 시 시각 효과(스킵 버튼 숨김 등) 자동 적용.
  if (buffState?.finalized_at) {
    card.classList.add('is-completed');
    card.classList.add('is-finalized');
    card.classList.remove('is-expanded');
    return;
  }
  card.classList.remove('is-finalized');
  // 완료 판정 — current_turn_idx 가 max(turn_idx)+1 이상이면 모든 참가자 끝.
  // 5명 테스트 (turn_idx 0~4) 의 경우 5 도달 시 완료. 48명 운영의 경우 48 도달 시 완료.
  const maxTurn = participants.length > 0
    ? Math.max(...participants.map((p) => p.turn_idx))
    : -1;
  if (!buffState || buffState.current_turn_idx > maxTurn) {
    card.classList.add('is-completed');
    card.classList.remove('is-expanded');
    return;
  }
  card.classList.remove('is-completed');
  const cur = participants.find((p) => p.turn_idx === buffState!.current_turn_idx);
  if (!cur || !cur.survey) return;
  ($('sk-buff-current-photo-empty') as HTMLElement).textContent = cur.survey.nickname.charAt(0).toUpperCase();
  const photo = $<HTMLImageElement>('sk-buff-current-photo');
  if (cur.survey.avatar_url) {
    if (photo.src !== cur.survey.avatar_url) photo.src = cur.survey.avatar_url;
    photo.hidden = false;
  } else {
    photo.hidden = true;
    photo.removeAttribute('src');
  }
  $('sk-buff-current-name').textContent = cur.survey.nickname;
  $('sk-buff-current-id').textContent = `#${cur.kingshot_id} · TC ${cur.survey.city_level}`;

  // 다음 차례 큐 — current+1 부터 5명
  const queue = $('sk-buff-current-queue');
  queue.innerHTML = '';
  const next = participants
    .filter((p) => p.turn_idx > buffState!.current_turn_idx)
    .sort((a, b) => a.turn_idx - b.turn_idx)
    .slice(0, 5);
  if (next.length === 0) {
    const li = document.createElement('li');
    li.className = 'sk-buff-queue-empty';
    li.textContent = t('survey.kvkBuff.queueEmpty');
    queue.appendChild(li);
  } else {
    for (const p of next) {
      const li = document.createElement('li');
      li.textContent = p.survey?.nickname ?? p.kingshot_id;
      queue.appendChild(li);
    }
  }
}

function renderGrid(): void {
  // grid 박스 안에 헤더(tz/필터/복사) + list(슬롯들) 두 영역. 클라는 list 만 조작 (헤더 보존).
  const list = $('sk-buff-grid-list');
  if (!buffState) {
    list.innerHTML = '';
    return;
  }
  const slots = totalSlots();
  // 슬롯 카드 element 풀 — 첫 렌더 시만 생성, 이후 polling 갱신은 내용만 patch.
  // (이전엔 매 polling 마다 innerHTML='' 으로 통째 재생성 → <img> 도 새로 만들어져 깜박임 회귀.)
  if (list.children.length !== slots) {
    list.innerHTML = '';
    for (let i = 0; i < slots; i++) {
      const c = document.createElement('div');
      c.className = 'sk-buff-slot';
      c.dataset.slotIdx = String(i);
      list.appendChild(c);
    }
  }
  const occupied = new Map<number, Participant>();
  for (const p of participants) {
    if (p.slot_idx !== null) occupied.set(p.slot_idx, p);
  }
  // 운영/테스트 모두 선착순: 본인이 participants 에 있고 (turn_idx != undefined) + 미점유면 선택 가능.
  // turn_idx 가 undefined 면 top-48 미포함 → 서버도 not_participant 로 거부하지만 UI 차원에서도 차단.
  const canPick = !!me && me.turn_idx !== undefined && (me.slot_idx === null || me.slot_idx === undefined);
  for (let i = 0; i < slots; i++) {
    paintSlot(list.children[i] as HTMLElement, i, occupied.get(i), canPick);
  }
  // polling 으로 grid 재구성돼도 admin swap selection 유지 — slot_idx 로 마킹 복구.
  if (swapSourceSlotIdx !== null) {
    list.querySelector(`.sk-buff-slot[data-slot-idx="${swapSourceSlotIdx}"]`)
      ?.classList.add('is-swap-source');
  }
}

/** 슬롯 카드 한 개 patch — holder/selectable 상태 변경 시만 innerHTML 재구성.
 *  변경 없으면 시간 텍스트만 갱신 (tzMode 토글 케이스). 아바타 img 깜박임 차단의 핵심.
 *  canPick: 운영 = 본인 차례 / 테스트 (선착순) = 본인 미점유. */
function paintSlot(card: HTMLElement, slotIdx: number, holder: Participant | undefined, canPick: boolean): void {
  const time = formatSlotTime(slotIdx, tzMode);
  const newHolderId = holder?.kingshot_id ?? '';
  const newSelectable = !holder && canPick;
  // 첫 paint 마커 — 빈 카드 (holder=undefined + isMyTurn=false) 케이스에서도 강제 첫 그리기.
  // 마커 없이 oldHolderId='' === newHolderId='' 비교 시 "데이터 동일" 로 잘못 판단 → 카드 비어있는 회귀.
  const isFirstPaint = !card.hasAttribute('data-painted');

  if (!isFirstPaint) {
    const oldHolderId = card.dataset.holderId ?? '';
    const oldSelectable = card.classList.contains('is-selectable');
    if (newHolderId === oldHolderId && newSelectable === oldSelectable) {
      // 데이터 동일 — 시간 텍스트만 갱신 (tz 토글 시).
      const timeEl = card.querySelector('.sk-buff-slot-time');
      if (timeEl && timeEl.textContent !== time) timeEl.textContent = time;
      return;
    }
  }

  card.dataset.painted = '1';
  card.dataset.holderId = newHolderId;
  card.classList.toggle('is-selectable', newSelectable);
  // .is-occupied — 점유 슬롯 의미 명확히. CSS 가 admin 의 클릭 가능 / "남은 자리" 필터 hide 결정.
  // (이전엔 :not(.is-selectable) 으로 점유를 표현했으나 .is-selectable 의 의미가 "자기 차례 + 빈 슬롯" 으로
  //  좁혀지면서 빈 슬롯도 :not(.is-selectable) 에 포함되는 회귀.)
  card.classList.toggle('is-occupied', !!holder);

  if (holder) {
    const letter = escapeHtml(holder.survey?.nickname.charAt(0).toUpperCase() ?? '?');
    const avatar = holder.survey?.avatar_url ?? '';
    const photoHtml = avatar
      ? `<span class="sk-buff-slot-photo-letter">${letter}</span><img class="sk-buff-slot-photo-img" src="${escapeHtml(avatar)}" alt="" loading="lazy" />`
      : `<span class="sk-buff-slot-photo-letter">${letter}</span>`;
    card.innerHTML = `
      <span class="sk-buff-slot-time">${time}</span>
      <div class="sk-buff-slot-holder">
        <div class="sk-buff-slot-photo">${photoHtml}</div>
        <div class="sk-buff-slot-meta">
          <div class="sk-buff-slot-name">${escapeHtml(holder.survey?.nickname ?? holder.kingshot_id)}</div>
          <div class="sk-buff-slot-id">#${holder.kingshot_id}</div>
        </div>
      </div>
    `;
  } else {
    card.innerHTML = `
      <span class="sk-buff-slot-time">${time}</span>
      <span class="sk-buff-slot-id">${t('survey.kvkBuff.slotEmpty')}</span>
    `;
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ===== 카운트다운 (turn_started_at 기준 경과) =====
function tickElapsed(): void {
  if (!buffState?.turn_started_at || (buffState.current_turn_idx >= totalSlots())) {
    $('sk-buff-current-elapsed').textContent = '';
    return;
  }
  const ms = Date.now() - new Date(buffState.turn_started_at).getTime();
  $('sk-buff-current-elapsed').textContent = formatElapsed(ms);
}

// ===== polling =====
async function pollState(): Promise<void> {
  try {
    const res = await callFn<StateResponse>({ action: 'get-state', token });
    if (!res.ok) return;
    buffState = res.state;
    participants = res.participants ?? [];
    me = res.me;
    renderAll();
  } catch (e) {
    console.error('poll failed', e);
  }
}

// ===== 슬롯 클릭 (pick / admin swap) =====
function onGridClick(e: Event): void {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.sk-buff-slot');
  if (!card) return;
  const slotIdx = Number(card.dataset.slotIdx);
  if (Number.isNaN(slotIdx)) return;

  // 마감 가드 — RPC 도 'finalized' 로 reject 하지만, UI 차원에서 confirm 다이얼로그 자체가
  // 안 뜨도록 차단 (swap 흐름의 첫 번째 클릭 후 마감된 경우 두 번째 클릭에서 dialog 가 떴던 회귀 막음).
  if (buffState?.finalized_at) {
    clearSwapSelection();
    return;
  }

  // (a) 빈 슬롯 — paintSlot 가 자기 차례 + 빈 슬롯 일 때만 .is-selectable 부여.
  // 자기 차례 아니면 .is-selectable 미적용 → CSS pointer-events:none 으로 클릭 자체 차단.
  if (card.classList.contains('is-selectable')) {
    pendingSlotIdx = slotIdx;
    $('sk-buff-confirm-time').textContent = formatSlotTime(slotIdx, tzMode);
    const dlg = $<HTMLDialogElement>('sk-buff-confirm-dialog');
    if (!dlg.open) dlg.showModal();
    return;
  }

  // (b) 점유 슬롯 — admin 모드일 때만 swap. 빈 슬롯 (paintSlot 의 .is-occupied X) 은 무시.
  // (CSS 도 .sk-buff-page.is-admin .sk-buff-slot.is-occupied 로 좁혀 클릭 자체 차단하지만
  //  defensive 가드 — paintSlot 호출 직전 stale DOM 상태에서도 swap dialog 잘못 뜨지 않게.)
  if (!me?.is_admin) return;
  if (!card.classList.contains('is-occupied')) return;
  if (swapSourceSlotIdx === null) {
    swapSourceSlotIdx = slotIdx;
    card.classList.add('is-swap-source');
    return;
  }
  if (swapSourceSlotIdx === slotIdx) {
    // 같은 슬롯 다시 클릭 → 선택 해제
    card.classList.remove('is-swap-source');
    swapSourceSlotIdx = null;
    return;
  }
  // 두 번째 점유 슬롯 → swap confirm
  const sourceCard = document.querySelector<HTMLElement>(
    `.sk-buff-slot[data-slot-idx="${swapSourceSlotIdx}"]`,
  );
  const a = sourceCard?.querySelector<HTMLElement>('.sk-buff-slot-name')?.textContent ?? '';
  const b = card.querySelector<HTMLElement>('.sk-buff-slot-name')?.textContent ?? '';
  pendingSwapTargetSlotIdx = slotIdx;
  $('sk-buff-swap-body').textContent = t('survey.kvkBuff.confirm.swapBody', { a, b });
  $<HTMLDialogElement>('sk-buff-swap-dialog').showModal();
}

function clearSwapSelection(): void {
  // 모든 카드의 is-swap-source 제거 (현재 source 카드 또는 polling 으로 재생성된 것 모두 cover).
  document.querySelectorAll('.sk-buff-slot.is-swap-source')
    .forEach((el) => el.classList.remove('is-swap-source'));
  swapSourceSlotIdx = null;
  pendingSwapTargetSlotIdx = null;
}

/**
 * 서버 응답의 error 코드를 i18n 키로 찾아 친화적 메시지로 alert.
 *
 *   - 알려진 코드(turn_changed, slot_taken, …) → 해당 i18n 메시지
 *   - 미정의 키 (Edge Function 의 unexpected_error 포함, 또는 신규 코드가 사전에 미반영) →
 *     `survey.kvkBuff.error.unexpected_error` 로 fallback. raw 코드/JSON 절대 노출 안 함.
 *
 * t() 가 키 못 찾으면 key 자체 (문자열) 를 반환하는 동작을 활용해 fallback 분기.
 */
function alertError(errorCode: string | undefined): void {
  const code = errorCode ?? 'unexpected_error';
  const key = 'survey.kvkBuff.error.' + code;
  const translated = t(key);
  if (translated === key) {
    // i18n 사전에 키 없음 → unexpected_error 메시지 노출. console 에는 원본 코드 기록.
    console.warn('[kvk-buff] unmapped error code:', code);
    alert(t('survey.kvkBuff.error.unexpected_error'));
    return;
  }
  alert(translated);
}

// ===== confirm: pick slot =====
async function onPickConfirm(): Promise<void> {
  if (pendingSlotIdx === null || !buffState) return;
  const dlg = $<HTMLDialogElement>('sk-buff-confirm-dialog');
  const okBtn = $<HTMLButtonElement>('sk-buff-confirm-ok');
  // double-submit 방어 — 이미 in-flight 인데 다시 클릭 시 무시.
  // (선착순 시나리오에서 빠른 연타로 두 번째 픽이 'already_picked' 받는 race 차단.)
  if (okBtn.disabled) return;
  okBtn.disabled = true;
  try {
    const res = await callFn<{ ok: boolean; error?: string }>({
      action: 'pick-slot',
      token,
      slot_idx: pendingSlotIdx,
      expected_turn_idx: buffState.current_turn_idx,
    });
    pendingSlotIdx = null;
    dlg.close();
    if (!res.ok) {
      alertError(res.error);
    }
    await pollState();
  } finally {
    okBtn.disabled = false;
  }
}

// ===== admin: replace current (변경) =====
//   기존 [스킵] 자동 swap 패턴 (turn_idx ↔ turn_idx+1) 대체.
//   admin 이 사용자 목록에서 직접 선택 → 두 사람 turn_idx swap → target 즉시 차례.
//   이전 차례 사용자는 target 의 원래 자리로 밀려남 (옵션 A 동작).

let pendingReplaceTargetId: string | null = null;

/** 변경 다이얼로그 — 사용자 목록 (turn_idx 순) + radio 선택. 완료자/현재차례 본인 disabled. */
function openReplaceDialog(): void {
  if (!buffState || !me?.is_admin) return;
  pendingReplaceTargetId = null;
  const list = $('sk-buff-replace-list');
  list.innerHTML = '';

  const sorted = [...participants].sort((a, b) => a.turn_idx - b.turn_idx);
  for (const p of sorted) {
    const isCurrent = p.turn_idx === buffState.current_turn_idx;
    const isPicked = p.slot_idx !== null;
    const disabled = isCurrent || isPicked;
    const li = document.createElement('li');
    li.className = 'sk-buff-replace-item' + (disabled ? ' is-disabled' : '');
    li.dataset.kingshotId = p.kingshot_id;
    if (disabled) li.setAttribute('aria-disabled', 'true');
    else li.setAttribute('role', 'radio');

    const orderLabel = String(p.turn_idx + 1).padStart(2, '0');
    const name = escapeHtml(p.survey?.nickname ?? p.kingshot_id);
    let statusLabel = '';
    if (isCurrent) statusLabel = t('survey.kvkBuff.replaceStatus.current');
    else if (isPicked) statusLabel = t('survey.kvkBuff.replaceStatus.picked', { time: formatSlotTime(p.slot_idx!, tzMode) });

    li.innerHTML = `
      <span class="sk-buff-replace-radio" aria-hidden="true"></span>
      <span class="sk-buff-replace-order">${orderLabel}</span>
      <span class="sk-buff-replace-name">${name}</span>
      <span class="sk-buff-replace-status">${escapeHtml(statusLabel)}</span>
    `;
    list.appendChild(li);
  }

  ($('sk-buff-replace-ok') as HTMLButtonElement).disabled = true;
  $<HTMLDialogElement>('sk-buff-replace-dialog').showModal();
}

function onReplaceListClick(e: Event): void {
  const li = (e.target as HTMLElement).closest<HTMLElement>('.sk-buff-replace-item');
  if (!li || li.classList.contains('is-disabled')) return;
  const id = li.dataset.kingshotId;
  if (!id) return;
  // radio 단일 선택 — 다른 항목 선택 해제
  document.querySelectorAll('#sk-buff-replace-list .sk-buff-replace-item.is-selected')
    .forEach((el) => el.classList.remove('is-selected'));
  li.classList.add('is-selected');
  pendingReplaceTargetId = id;
  ($('sk-buff-replace-ok') as HTMLButtonElement).disabled = false;
}

async function onReplaceConfirm(): Promise<void> {
  if (!buffState || !pendingReplaceTargetId) return;
  const dlg = $<HTMLDialogElement>('sk-buff-replace-dialog');
  const res = await callFn<{ ok: boolean; error?: string }>({
    action: 'admin-replace-current',
    token,
    target_kingshot_id: pendingReplaceTargetId,
    expected_turn_idx: buffState.current_turn_idx,
  });
  pendingReplaceTargetId = null;
  dlg.close();
  if (!res.ok) alertError(res.error);
  await pollState();
}

/** admin: 예약 시작 — confirm 후 bootstrap RPC 호출 (인증 우선 + 점수 순 48명 INSERT).
 *  me 가 polling 응답 전에 null 일 수 있어 캐시 fallback (applyAdminClass 와 같은 패턴). */
async function onStartClick(): Promise<void> {
  if (!isAdminLikely()) return;
  if (!confirm(t('survey.kvkBuff.confirm.start'))) return;
  const res = await callFn<{ ok: boolean; error?: string }>({ action: 'admin-start', token });
  if (!res.ok) {
    alertError(res.error);
    return;
  }
  await pollState();
}

/** admin 사전 게이트 — me (polling 응답) 우선, 없으면 localStorage 캐시 fallback.
 *  서버는 자체 검증 (authenticate + is_admin) — 클라는 UX 차원에서만 차단. */
function isAdminLikely(): boolean {
  return me?.is_admin === true || (me === null && readCachedIsAdmin());
}

/** admin: 예약 마감 — confirm 후 state.finalized_at 세팅. 시스템 confirm() 사용 (페이지 일관). */
async function onFinalizeClick(): Promise<void> {
  if (!isAdminLikely()) return;
  if (!confirm(t('survey.kvkBuff.confirm.finalize'))) return;
  const res = await callFn<{ ok: boolean; error?: string }>({ action: 'finalize', token });
  if (!res.ok) {
    alertError(res.error);
    return;
  }
  await pollState();
}

/** !!! TEST_MODE — _test 참가자 + state reset. confirm 후 실행. */
async function onResetTestClick(): Promise<void> {
  if (!testMode) return;
  if (!confirm(t('survey.kvkBuff.test.resetConfirm'))) return;
  // token 동봉 누락 시 Edge Function 의 authenticate(token) 가 invalid_token 으로 reject →
  // 사용자에겐 "가속권 현황 조사에서 먼저 로그인" 안내가 잘못 노출됨. 다른 admin 액션과 동일하게 token 전달.
  const res = await callFn<{ ok: boolean; error?: string }>({ action: 'admin-reset-test', token });
  if (!res.ok) {
    alertError(res.error);
    return;
  }
  await pollState();
}

// ===== admin: swap =====
async function onSwapConfirm(): Promise<void> {
  if (swapSourceSlotIdx === null || pendingSwapTargetSlotIdx === null) return;
  const dlg = $<HTMLDialogElement>('sk-buff-swap-dialog');
  const slotA = swapSourceSlotIdx;
  const res = await callFn<{ ok: boolean; error?: string }>({
    action: 'admin-swap',
    token,
    slot_a_idx: slotA,
    slot_b_idx: pendingSwapTargetSlotIdx,
  });
  clearSwapSelection();
  dlg.close();
  if (!res.ok) alertError(res.error);
  await pollState();
}

// ===== 복사 =====
function onCopyClick(): void {
  const items: { time: string; name: string }[] = [];
  const occupied = new Map<number, Participant>();
  for (const p of participants) {
    if (p.slot_idx !== null) occupied.set(p.slot_idx, p);
  }
  const slots = totalSlots();
  for (let i = 0; i < slots; i++) {
    const holder = occupied.get(i);
    items.push({ time: formatSlotTime(i, tzMode), name: holder?.survey?.nickname ?? '❌' });
  }
  const URL_LINE = 'https://survey.kingshot.wooju-home.org/kvk-buff/';
  const text = items.map((it) => `${it.time} - ${it.name}`).join('\n') + `\n\n${URL_LINE}`;
  navigator.clipboard?.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    document.body.removeChild(ta);
  });
  const btn = $('sk-buff-copy-toggle');
  const original = btn.textContent;
  btn.textContent = t('survey.kvkBuff.copied');
  setTimeout(() => { btn.textContent = original; }, 1500);
}

// ===== init =====
function init(): void {
  token = loadToken();

  // 안내문 다이얼로그
  const noticeDlg = $<HTMLDialogElement>('sk-buff-notice-dialog');
  $('sk-buff-notice-trigger').addEventListener('click', () => {
    if (!noticeDlg.open) noticeDlg.showModal();
  });
  $('sk-buff-notice-close').addEventListener('click', () => noticeDlg.close());
  noticeDlg.addEventListener('click', (e) => { if (e.target === noticeDlg) noticeDlg.close(); });

  // 현재 사용자 카드 — 클릭 시 다음 차례 큐 펼침
  $('sk-buff-current').addEventListener('click', (e) => {
    // [변경] 버튼 클릭은 별도 처리
    if ((e.target as HTMLElement).closest('#sk-buff-replace-btn')) return;
    const card = $('sk-buff-current');
    if (card.classList.contains('is-completed')) return;
    card.classList.toggle('is-expanded');
  });

  // tz 토글
  $('sk-buff-tz-toggle').addEventListener('click', () => {
    tzMode = tzMode === 'UTC' ? 'KST' : 'UTC';
    $('sk-buff-tz-toggle').textContent = tzToggleLabel(tzMode);
    renderGrid();
  });

  // 남은 자리 필터
  const filterToggle = $('sk-buff-filter-toggle');
  filterToggle.addEventListener('click', () => {
    const grid = $('sk-buff-grid');
    if (!grid.style.minHeight) grid.style.minHeight = grid.offsetHeight + 'px';
    const filtered = grid.classList.toggle('is-filtered');
    filterToggle.textContent = filtered
      ? t('survey.kvkBuff.filterAll')
      : t('survey.kvkBuff.filterAvailable');
  });

  // 복사하기
  $('sk-buff-copy-toggle').addEventListener('click', onCopyClick);

  // 슬롯 그리드 click
  $('sk-buff-grid').addEventListener('click', onGridClick);

  // pick confirm
  $('sk-buff-confirm-cancel').addEventListener('click', () => {
    pendingSlotIdx = null;
    $<HTMLDialogElement>('sk-buff-confirm-dialog').close();
  });
  $('sk-buff-confirm-ok').addEventListener('click', onPickConfirm);

  // [변경] — admin 이 다음 차례 사용자 명시 지정 (기존 [스킵] 자동 swap 대체)
  $('sk-buff-replace-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openReplaceDialog();
  });
  $('sk-buff-replace-close').addEventListener('click', () => $<HTMLDialogElement>('sk-buff-replace-dialog').close());
  $('sk-buff-replace-cancel').addEventListener('click', () => $<HTMLDialogElement>('sk-buff-replace-dialog').close());
  $('sk-buff-replace-ok').addEventListener('click', onReplaceConfirm);
  $('sk-buff-replace-list').addEventListener('click', onReplaceListClick);
  // backdrop 클릭 close
  $('sk-buff-replace-dialog').addEventListener('click', (e) => {
    const dlg = e.currentTarget as HTMLDialogElement;
    if (e.target === dlg) dlg.close();
  });
  // close 시 선택 reset
  $('sk-buff-replace-dialog').addEventListener('close', () => {
    pendingReplaceTargetId = null;
  });

  // swap
  $('sk-buff-swap-cancel').addEventListener('click', () => {
    clearSwapSelection();
    $<HTMLDialogElement>('sk-buff-swap-dialog').close();
  });
  $('sk-buff-swap-ok').addEventListener('click', onSwapConfirm);

  // !!! TEST_MODE — admin 전용 [재시작] 버튼: _test 참가자 + state 일괄 reset.
  // 운영 호출 시 서버가 'test_mode_only' 로 거부 → 안전.
  document.getElementById('sk-buff-test-reset')?.addEventListener('click', onResetTestClick);

  // admin 도구 — buff overlay 헤더의 [예약 시작] / [예약 마감].
  // disabled 토글은 applyAdminClass (state.bootstrapped_at / finalized_at 따라).
  $('sk-buff-start-btn').addEventListener('click', onStartClick);
  $('sk-buff-finalize-btn').addEventListener('click', onFinalizeClick);

  // 마감 전이면 잠금 화면 + 마감 시각까지 카운트다운만 띄움 (state 무관 우선 표시)
  renderLocked();

  // 언어 변경 시 dynamic 텍스트 재렌더
  onLangChange(() => {
    $('sk-buff-tz-toggle').textContent = tzToggleLabel(tzMode);
    const filterToggleEl = $('sk-buff-filter-toggle');
    const filtered = $('sk-buff-grid').classList.contains('is-filtered');
    filterToggleEl.textContent = filtered
      ? t('survey.kvkBuff.filterAll')
      : t('survey.kvkBuff.filterAvailable');
    renderAll();
  });
}

/** 다이얼로그 오픈 시 호출 — 첫 fetch + 5초 polling + 1초 tick 시작. */
export function startBuffPolling(): void {
  if (pollingTimer !== null) return; // 이미 polling 중
  // 첫 polling 응답 도착 (~수백ms) 전에 캐시 기반으로 .is-admin / .is-test 즉시 sync.
  // race 회귀 차단 — admin 이 다이얼로그 오픈 직후 잠깐 일반 사용자 UI 로 보이는 깜빡임 제거.
  applyAdminClass();
  void pollState();
  pollingTimer = window.setInterval(pollState, POLL_INTERVAL_MS);
  elapsedTimer = window.setInterval(tickElapsed, 1000);
}

/** 다이얼로그 close 시 호출 — polling/tick 중지 (네트워크/CPU 절약). */
export function stopBuffPolling(): void {
  if (pollingTimer !== null) {
    window.clearInterval(pollingTimer);
    pollingTimer = null;
  }
  if (elapsedTimer !== null) {
    window.clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

/** 가속권 페이지가 호출 — DOM 준비된 후 한 번만. 이벤트 핸들러 등록만 (polling X). */
export function setupBuffDialog(): void {
  init();
}

// 페이지 떠날 때 timer 정리 (HMR / SPA-ish 회복)
window.addEventListener('beforeunload', () => {
  if (pollingTimer !== null) window.clearInterval(pollingTimer);
  if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
  if (countdownTimer !== null) window.clearInterval(countdownTimer);
});
