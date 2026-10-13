import './style.css';
import { api, session } from './api';
import { h, clear } from './dom';
import { showLobby } from './lobby';
import { startGame } from './game';

const app = document.getElementById('app')!;

function showLogin(error = '') {
  clear(app);
  const name = h('input', { placeholder: 'callsign', maxlength: 20, autocomplete: 'username' });
  const pass = h('input', { placeholder: 'password', type: 'password', autocomplete: 'current-password' });
  const err = h('div', { class: 'error' }, error);
  const go = async (register: boolean) => {
    try {
      const s = await (register ? api.register : api.login)(name.value, pass.value);
      session.set(s);
      route();
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  };
  app.append(
    h('div', { class: 'center' },
      h('div', { class: 'card login' },
        h('div', { class: 'logo' }, 'MALA TOKMACHKA', h('span', {}, 'ONLINE')),
        name, pass, err,
        h('div', { class: 'row' },
          h('button', { class: 'primary', onClick: () => go(false) }, 'Sign in'),
          h('button', { onClick: () => go(true) }, 'Register'),
        ),
      ),
    ),
  );
  pass.addEventListener('keydown', (e) => e.key === 'Enter' && go(false));
}

export function route() {
  const s = session.get();
  if (!s) return showLogin();
  showLobby(app, s, {
    onLogout: () => (session.set(null), showLogin()),
    onMatch: (matchId) => {
      clear(app);
      startGame(app, s, matchId, () => route());
    },
  });
}

route();
