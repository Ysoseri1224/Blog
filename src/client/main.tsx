import { createRoot } from 'react-dom/client';
import './styles.css';
import type { AppBootstrap } from '../shared/types';
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
    createRoot(root).render(<><CursorLayer/><PublicApp initial={bootstrap} /></>);
  }
}

const bootstrap = window.__BLOG_BOOTSTRAP__;
if (bootstrap) {
  void start(bootstrap);
} else {
  document.getElementById('root')?.replaceChildren(Object.assign(document.createElement('p'), { textContent: '页面数据没有正确载入。' }));
}
