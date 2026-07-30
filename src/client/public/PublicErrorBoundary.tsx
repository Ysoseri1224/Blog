import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../../shared/i18n';
import type { InterfaceLanguage } from '../../shared/types';

interface Props { children: ReactNode; }
interface State { failed: boolean; }

/** 阅读工作区的最后一道隔离层：未知渲染异常也必须留下可恢复界面。 */
export class PublicErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('public_app_render_failed', { message: error.message, componentStack: info.componentStack });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const lang: InterfaceLanguage = document.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'zh';
    return <main className="public-error-fallback" role="alert">
      <p>blog · ysoseri.us</p>
      <h1>{t(lang, 'publicWorkspaceLoadFailed')}</h1>
      <span>{t(lang, 'publicWorkspaceLoadHint')}</span>
      <div>
        <button className="primary-button" onClick={() => location.reload()}>{t(lang, 'reload')}</button>
        <a className="secondary-button" href="/">{t(lang, 'backToBlog')}</a>
      </div>
    </main>;
  }
}
