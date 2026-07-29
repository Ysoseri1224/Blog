import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ManageBootstrap } from '../../shared/types';
import { t } from '../../shared/i18n';
import { api } from '../api';

export function AuthApp({ initial }: { initial: ManageBootstrap }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api<{ csrfToken: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '验证失败');
      setBusy(false);
    }
  };

  return <main className="auth-page"><section className="auth-card"><p>blog · ysoseri.us</p><h1>{t(initial.lang, 'login')}</h1><form onSubmit={(event) => void submit(event)}><label>{t(initial.lang, 'password')}<input ref={inputRef} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button" disabled={busy || !password}>{busy ? '正在验证…' : t(initial.lang, 'signIn')}</button></form></section></main>;
}
