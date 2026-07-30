import { createRoot } from 'react-dom/client';
import './styles.css';
import type { AppBootstrap } from '../shared/types';
import { t } from '../shared/i18n';
import { CursorLayer } from './components/CursorLayer';

async function start(bootstrap: AppBootstrap): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing app root');
  if (bootstrap.kind === 'manage') {
    if (bootstrap.authenticated) {
      const { ManageApp } = await import('./manage/ManageApp');
      createRoot(root).render(<><CursorLayer/><ManageApp initial={bootstrap} /></>);
    } else {
      const { AuthApp } = await import('./manage/AuthApp');
      createRoot(root).render(<><CursorLayer/><AuthApp initial={bootstrap} /></>);
    }
  } else {
    const { PublicApp } = await import('./public/PublicApp');
    const { PublicErrorBoundary } = await import('./public/PublicErrorBoundary');
    createRoot(root).render(<><CursorLayer/><PublicErrorBoundary><PublicApp initial={bootstrap} /></PublicErrorBoundary></>);
  }
}

const bootstrap = window.__BLOG_BOOTSTRAP__;
if (bootstrap) {
  void start(bootstrap).catch(() => {
    document.getElementById('root')?.replaceChildren(Object.assign(document.createElement('p'), { className: 'bootstrap-error', textContent: t(bootstrap.lang, 'resourcesLoadFailed') }));
  });
} else {
  const lang = document.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'zh';
  document.getElementById('root')?.replaceChildren(Object.assign(document.createElement('p'), { textContent: t(lang, 'dataLoadFailed') }));
}
