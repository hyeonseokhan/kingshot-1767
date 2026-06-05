/**
 * 전역 인증 다이얼로그 클라이언트 로직.
 *
 * 트리거: document 의 'app-open-auth' 커스텀 이벤트.
 * EF: kvk-survey (action: lookup / login / register) — survey.ts 와 동일 백엔드 + AUTH_KEY 호환.
 *
 * 상태 흐름:
 *   id-input → (lookup) → pin-input
 *     - 등록됨(registered:true)  → login   → AUTH_KEY 저장 + 닫기
 *     - 미등록(registered:false) → register (training/construction/general 0/0/0)
 *                                → AUTH_KEY 저장 + 닫기
 *
 * 신규 등록 시 0/0/0 로 초기화: 인증 인프라는 KvK 설문 데이터와 독립 — 사용자가 추후
 * KvK 페이지에서 실제 값으로 update 가능 (action: update).
 *
 * 단, 서버측 게이트로 TC 레벨 26 미만은 register 단계에서 거부됨 (kvk-survey EF 정책).
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/shared/supabase';

const AUTH_KEY = 'pnx-sk-auth-v1';
const FN_URL = SUPABASE_URL + '/functions/v1/kvk-survey';

interface PlayerInfo {
  kingshot_id: string;
  nickname: string;
  avatar_url: string | null;
  city_level: number | null;
}
interface MyRecord {
  kingshot_id: string;
  nickname: string;
  avatar_url: string | null;
  training: number;
  construction: number;
  general: number;
  evidence_uploaded_at: string | null;
  is_admin: boolean;
}

interface LookupResp {
  ok: boolean;
  error?: string;
  player?: PlayerInfo;
  registered?: boolean;
}
interface LoginResp {
  ok: boolean;
  error?: string;
  token?: string;
  expires_at?: string;
  record?: MyRecord;
}
// register 응답도 동일 형식 (token + expires_at + record)
type RegisterResp = LoginResp;

async function callFn<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()) as T;
}

function mapError(code: string | undefined): string {
  // 사용자 친화 메시지 — kvk-survey EF 의 핵심 에러 코드 커버.
  const map: Record<string, string> = {
    not_found: '존재하지 않는 킹샷 ID 예요. ID를 다시 확인해주세요.',
    invalid_id: '올바른 킹샷 ID 가 아닙니다.',
    invalid_pin: 'PIN 형식이 올바르지 않습니다.',
    wrong_pin: 'PIN 이 일치하지 않습니다.',
    already_registered: '이미 등록된 ID 입니다. 기존 PIN 으로 로그인해 주세요.',
    insufficient_city_level: 'TC 레벨 26 이상부터 신규 등록이 가능합니다.',
    rate_limited: '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.',
  };
  return map[code ?? ''] ?? '일시적인 문제가 발생했어요. 잠시 후 다시 시도해주세요.';
}

function init(): void {
  const dlg = document.getElementById('app-auth-dialog') as HTMLDialogElement | null;
  if (!dlg) return;

  const idInput = document.getElementById('app-auth-id-input') as HTMLInputElement;
  const idSearchBtn = document.getElementById('app-auth-id-search') as HTMLButtonElement;
  const idStatus = document.getElementById('app-auth-id-status') as HTMLElement;
  const pinInput = document.getElementById('app-auth-pin-input') as HTMLInputElement;
  const pinBoxes = document
    .querySelector('.app-auth-pin-boxes')
    ?.querySelectorAll<HTMLElement>('.app-auth-pin-box') ?? null;
  const pinStatus = document.getElementById('app-auth-pin-status') as HTMLElement;
  const backBtn = document.getElementById('app-auth-back') as HTMLButtonElement;
  const closeBtn = document.getElementById('app-auth-close') as HTMLButtonElement;
  const stepId = document.getElementById('app-auth-step-id') as HTMLElement;
  const stepPin = document.getElementById('app-auth-step-pin') as HTMLElement;
  const modeBanner = document.getElementById('app-auth-mode-banner') as HTMLElement;
  const pinHelp = document.getElementById('app-auth-pin-help') as HTMLElement;
  const playerName = document.getElementById('app-auth-player-name') as HTMLElement;
  const playerId = document.getElementById('app-auth-player-id') as HTMLElement;
  const photo = document.getElementById('app-auth-photo') as HTMLImageElement;
  const photoEmpty = document.getElementById('app-auth-photo-empty') as HTMLElement;

  let currentPlayer: PlayerInfo | null = null;
  let currentMode: 'login' | 'register' = 'login';

  function showStep(step: 'id' | 'pin'): void {
    stepId.hidden = step !== 'id';
    stepPin.hidden = step !== 'pin';
  }

  function setMode(mode: 'login' | 'register'): void {
    currentMode = mode;
    modeBanner.hidden = mode !== 'register';
    pinHelp.textContent =
      mode === 'register'
        ? '사용하실 PIN 4자리를 입력해 주세요. (이 PIN 으로 다음부터 로그인합니다)'
        : '등록한 PIN 4자리를 입력해 주세요.';
  }

  function setStatus(el: HTMLElement, msg: string, tone: '' | 'err' | 'ok' = ''): void {
    el.textContent = msg;
    el.className = 'app-auth-status' + (tone ? ' is-' + tone : '');
  }

  function syncPinBoxes(): void {
    if (!pinBoxes) return;
    const len = pinInput.value.length;
    pinBoxes.forEach((box, i) => {
      box.classList.toggle('is-filled', i < len);
      box.classList.toggle('is-active', i === len && document.activeElement === pinInput);
      box.textContent = i < len ? '•' : '';
    });
  }

  function reset(): void {
    idInput.value = '';
    pinInput.value = '';
    setStatus(idStatus, '');
    setStatus(pinStatus, '');
    currentPlayer = null;
    setMode('login');
    syncPinBoxes();
    showStep('id');
  }

  function close(): void {
    if (dlg!.open) dlg!.close();
    reset();
  }

  function fillPlayerCard(player: PlayerInfo): void {
    playerName.textContent = player.nickname;
    playerId.textContent =
      player.city_level !== null && player.city_level !== undefined
        ? `#${player.kingshot_id} · TC ${player.city_level}`
        : `#${player.kingshot_id}`;
    if (player.avatar_url) {
      photo.src = player.avatar_url;
      photo.hidden = false;
      photoEmpty.style.display = 'none';
    } else {
      photo.hidden = true;
      photoEmpty.style.display = '';
      photoEmpty.textContent = (player.nickname || '?').charAt(0);
    }
  }

  async function onSearchId(): Promise<void> {
    const id = idInput.value.trim();
    if (!/^\d{4,15}$/.test(id)) {
      setStatus(idStatus, '4~15자리 숫자로 입력해 주세요.', 'err');
      return;
    }
    idSearchBtn.disabled = true;
    setStatus(idStatus, '');
    try {
      const json = await callFn<LookupResp>({ action: 'lookup', kingshot_id: id });
      if (!json.ok || !json.player) {
        setStatus(idStatus, mapError(json.error), 'err');
        return;
      }
      currentPlayer = json.player;
      // 등록 여부에 따라 모드 결정 — 동일 step-pin 안에서 helper/banner 만 swap.
      setMode(json.registered ? 'login' : 'register');
      fillPlayerCard(json.player);
      showStep('pin');
      setTimeout(() => pinInput.focus(), 50);
    } catch (err) {
      setStatus(idStatus, '네트워크 오류: ' + (err as Error).message, 'err');
    } finally {
      idSearchBtn.disabled = false;
    }
  }

  async function onConfirmPin(): Promise<void> {
    if (!currentPlayer) return;
    const pin = pinInput.value.trim();
    if (!/^\d{4}$/.test(pin)) {
      setStatus(pinStatus, 'PIN 4자리를 입력해 주세요.', 'err');
      return;
    }
    setStatus(pinStatus, '');
    try {
      // 신규 등록: register (training/construction/general = 0/0/0, 인증 인프라는 KvK 데이터와 독립).
      // 기존 사용자: login (PIN 검증 + 토큰 발급).
      // 두 응답 형식 동일 → AUTH_KEY 호환.
      const body =
        currentMode === 'register'
          ? {
              action: 'register',
              kingshot_id: currentPlayer.kingshot_id,
              pin,
              training: 0,
              construction: 0,
              general: 0,
            }
          : { action: 'login', kingshot_id: currentPlayer.kingshot_id, pin };
      const json = await callFn<LoginResp | RegisterResp>(body);
      if (!json.ok || !json.token || !json.expires_at || !json.record) {
        setStatus(pinStatus, mapError(json.error), 'err');
        return;
      }
      // AUTH_KEY 저장 — survey.ts 와 호환되는 형식.
      const state = {
        token: json.token,
        expires_at: json.expires_at,
        record: json.record,
      };
      try {
        localStorage.setItem(AUTH_KEY, JSON.stringify(state));
      } catch {
        /* private mode 등 — 무시 */
      }
      // 모든 인증 소비자(AuthButton + 각 페이지) sync.
      document.dispatchEvent(new CustomEvent('app-auth-changed'));
      close();
    } catch (err) {
      setStatus(pinStatus, '네트워크 오류: ' + (err as Error).message, 'err');
    }
  }

  // === 이벤트 와이어업 ===
  document.addEventListener('app-open-auth', () => {
    reset();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => idInput.focus(), 50);
  });

  idSearchBtn.addEventListener('click', onSearchId);
  idInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSearchId();
  });

  pinInput.addEventListener('input', () => {
    pinInput.value = pinInput.value.replace(/[^0-9]/g, '').slice(0, 4);
    syncPinBoxes();
    if (pinInput.value.length === 4) onConfirmPin();
  });
  pinInput.addEventListener('focus', syncPinBoxes);
  pinInput.addEventListener('blur', syncPinBoxes);
  pinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onConfirmPin();
  });

  backBtn?.addEventListener('click', () => {
    pinInput.value = '';
    syncPinBoxes();
    setStatus(pinStatus, '');
    setMode('login');
    showStep('id');
    setTimeout(() => idInput.focus(), 50);
  });

  closeBtn.addEventListener('click', close);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
